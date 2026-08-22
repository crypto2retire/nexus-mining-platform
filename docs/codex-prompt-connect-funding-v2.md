# Codex Prompt: Connect Funding v2 — BTC direct to MRR + separate 5% fee

> Paste this block into Codex. Work in the local repo:
> /Users/cleartheclutter/dev/nexus-mining-platform. Do NOT commit, do NOT
> deploy. Implement backend + frontend + fee contract, run the full test
> suite + production build, and report.

---

## Purpose (Kevin 2026-08-22 — non-negotiable)

**THE ONLY PROCESS:** user chooses a coin → reviews pools (returns, size,
cost, length) → we facilitate the correct miner + correctly set up the pool
→ **user pays the miner directly** → pool pays the user directly → **our 5%
fee is ADDED ON TOP and SEPARATE from the amount sent to the miner.**

This change converts Connect funding from the current "user USDC balance at
Nexus → worker spends operator MRR BTC" model to:

1. **User sends BTC directly from their wallet to the MRR account's BTC
   deposit address** (the exact amount for the rental). We never touch it.
2. **The 5% fee is a separate payment** — USDC on Base via a minimal
   non-custodial fee contract (forward to treasury, event, no admin).
3. When the deposit is confirmed (MRR balance/transactions) AND the fee is
   paid (on-chain), the existing worker rents the rig from the MRR account
   balance and points it at the user's chosen pool + payout wallet.
4. Pool pays the user directly (unchanged).

**Why:** Option A (API access to the user's own MRR account) was rejected —
it gives us access to their account and funds (draining risk). With this
design we have **no access to user funds or wallets at any time** (Kevin:
"with the 2nd option we have no access to the users funds or wallets at any
time"). The fee contract MUST be non-custodial: no admin key that can move
funds (Coin Center control test — see docs/connect-process-spec.md).

## Verified facts (probed live 2026-08-22 — do not "improve")

- MRR account API (already wired via `makeMrrRequest`):
  - `GET /account` → `data.deposit.BTC.address` =
    `bc1qspu59c6ucq5773cyxe089v93ftm9whx8s9cux2` (stable per-account BTC
    deposit address — fetch at runtime, never hardcode)
  - `GET /account/balance` → `{BTC: {confirmed: "0.00121192", unconfirmed:
    "0.00000000"}}` (real-time; deposit detection)
  - `GET /account/transactions` → `{transactions: [{id, type: 'Deposit' |
    'Payment' | 'Rental Fee' | 'Credit/Refund', currency, amount (+/-),
    when, txid?, rental?, rig?, status}]}` — Deposits carry a **txid**;
    Credit/Refund rows are MRR's own refund precedent
- MRR rental funding is BTC-only from the account balance. No per-rental
  third-party payment, no cancel/refund endpoint (existing known facts).
- BTC is the on-ramp coin: Venmo + CashApp sell it in-app (Kevin) — the
  funding screen must assume a newcomer who just bought BTC on Venmo and
  sent it from Phantom/Rabby/Trust.
- Current Connect: `connectService.quote()` already returns
  `rental_cost_btc`, `rental_cost_usd`, `fee_pct`, `fee_usd`, `total_usd`
  (total = rental + fee, displayed "Rental $X + 5% fee $Y = $Z"). The
  connect_orders state machine (migration 026): PENDING_RENT → RENTING →
  POOL_POINTED → ACTIVE → COMPLETED / FAILED / FAILED_REVIEW / REFUNDED.
  Worker: SKIP LOCKED claim, 2-global/1-per-user concurrency, maxCostBtc
  ceiling, refund-once.
- `user_wallets.usdc_balance` funding is being REPLACED for Connect orders
  (the game's USDC balance/rooms are untouched — only Connect changes).

## Architecture

### 1. Fee contract (new `contracts/ConnectFee.sol`) — non-custodial

Minimal forwarder on **Base**, USDC:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
interface IERC20 {
  function transferFrom(address from, address to, uint256 amount) external returns (bool);
}
contract ConnectFee {
  address public immutable treasury;
  address public immutable usdc;
  event FeePaid(address indexed payer, uint256 amount, uint256 orderId);
  constructor(address treasury_, address usdc_) { treasury = treasury_; usdc = usdc_; }
  /// Forward msg.sender's USDC fee to the treasury. OrderId is emitted for
  /// off-chain reconciliation; the contract itself holds nothing.
  function payFee(uint256 amount, uint256 orderId) external {
    require(IERC20(usdc).transferFrom(msg.sender, treasury, amount), "transfer failed");
    emit FeePaid(msg.sender, amount, orderId);
  }
}
```

- **NO admin functions. NO withdraw. NO upgrade (or timelock-only).**
  treasury + usdc immutable. The contract never holds a balance beyond the
  call — nothing to steal, no custody (the FinCEN/Coin Center reasoning in
  docs/connect-process-spec.md).
- Include a hardhat-free compile path: `contracts/` + a `scripts/deploy-connect-fee.js`
  using solc + ethers (ethers already a dependency) OR Foundry if available;
  do NOT add heavy new dependencies to the app itself. Deployment happens
  later (needs Kevin's treasury address) — the prompt only ships source +
  deploy script + ABI export to `frontend/src/contracts/ConnectFee.json`.
- Frontend: `payFee(amount, orderId)` button flow (wallet sign → USDC
  approve → payFee) after the quote.

### 2. Backend — funding state machine (migration 027)

`connect_orders` additions (all nullable):
- `funding_state VARCHAR(20) NOT NULL DEFAULT 'NONE'` — NONE | PENDING |
  CONFIRMED | FAILED (funding-specific; keeps the main status for the rental)
- `expected_deposit_btc NUMERIC(20,10)`
- `deposit_txid VARCHAR(80)`, `deposit_confirmed_at TIMESTAMPTZ`
- `fee_usdc_amount NUMERIC(16,4)`, `fee_tx_hash VARCHAR(80)`,
  `fee_paid_at TIMESTAMPTZ`, `fee_order_id BIGINT`
- `funding_deadline TIMESTAMPTZ` (quote + 24h)
- Index on (funding_state, funding_deadline).

New status transition: PENDING_RENT (pre-funded placeholder) →
**PENDING_FUNDING** → RENTING → POOL_POINTED → ACTIVE → … (existing
terminals unchanged). `createConnectOrder` now:
- Quote as today (rental_cost_btc fixed in BTC — MRR prices in BTC/hour, so
  **no re-quote needed**; fee_usd is 5% of USD value AT QUOTE TIME, fixed).
- Insert order with `funding_state='PENDING'`, `expected_deposit_btc`,
  `funding_deadline = now + 24h`, status `PENDING_FUNDING`.
- Do NOT check `user_wallets.usdc_balance` anymore.

New service `backend/services/mrrFunding.js`:
- `getDepositAddress()` — fetch `GET /account` → `data.deposit.BTC.address`,
  cache 60s (fail → fall back to env `MRR_DEPOSIT_ADDRESS_BTC`).
- `checkFunding(orderId)` — poll `GET /account/balance` +
  `GET /account/transactions`; match a `Deposit` row whose txid is new and
  whose amount ≈ `expected_deposit_btc` (tolerance ±1% or ±0.00001 BTC,
  whichever is larger; overpayment surplus stays in the account and is the
  operator's — flag in UI copy). On match: set deposit_txid +
  deposit_confirmed_at, funding_state='CONFIRMED', status stays
  PENDING_FUNDING until the FEE is paid.
- `expireFunding()` — sweep PENDING_FUNDING orders past funding_deadline →
  funding_state='FAILED', status='FAILED', failure_reason='Funding
  deadline expired — no funds were touched'.
- Fee verification: poll the fee contract's `FeePaid` logs via the existing
  eth_getLogs pattern (depositListener) OR accept the user-submitted
  fee_tx_hash and verify it on-chain (transaction receipt + event). Use
  contract-event polling keyed by `fee_order_id` (the connect_orders id) —
  idempotent.

`connectWorker` changes:
- `claimNextPendingOrder` now claims orders in **PENDING_FUNDING** where
  `funding_state='CONFIRMED' AND fee_paid_at IS NOT NULL` (skip PENDING_RENT
  entirely; no more USDC-balance check).
- Everything downstream (rent + pool point + FAILED_REVIEW + refund-once)
  unchanged. The refund-once path now refunds via **operator BTC
  withdrawal** (see below) instead of USDC balance credit.

Refund path (funds the user already sent):
- If the rental cannot be placed after CONFIRMED funding (rig gone,
  FAILED_REVIEW): the operator withdraws the deposited BTC from the MRR
  account back to the user's payout/BTC address. Add
  `refund_btc_address VARCHAR(255)` + `refund_txid VARCHAR(80)` to
  connect_orders (migration 027) and a `refunds` audit row (reuse the
  withdrawal_requests pattern or a small `connect_refunds` table). Manual
  operator action via MRR web UI (like the existing withdrawal queue) —
  do NOT automate MRR withdrawals in this prompt.
- Fee refund (if the fee was already forwarded): manual operator USDC
  return, audited (same queue pattern). Note in the UI: "fees are only
  charged when the rental is placed" — see Constraints: the fee contract
  forwards immediately, so display the fee as payable AFTER the rental is
  confirmed ACTIVE (gate the payFee button on order status ACTIVE) to avoid
  refunds in the common case.

### 3. Frontend — ConnectPanel funding screen

After the quote, show a **funding step** (before "place order"):

- **Step 1 — Send BTC to the miner (direct):** the MRR deposit address
  (copy button), the exact `rental_cost_btc` amount, and copy:
  "Send exactly X BTC to this address — it goes straight to
  MiningRigRentals to fund your rental. We never hold your BTC. Buy BTC in
  the Venmo or CashApp app, then send it from Phantom, Rabby, or Trust
  Wallet." Show the address QR-free (copy button is enough).
- **Step 2 — Pay the 5% connection fee (separate):** `fee_usd` USDC on
  Base, "Connect wallet → Approve USDC → Pay fee" (contract payFee).
  Button is gated until the rental is ACTIVE (see Constraints) OR enabled
  immediately with clear refund terms — pick ACTIVE-gated.
- **Status timeline** polling: Waiting for BTC (funding_state PENDING →
  CONFIRMED) → Fee paid → Renting → Pool connected → Mining. Show
  deposit_txid + fee tx hash once seen.
- Replace any "fund your Nexus USDC balance" copy in the Connect flow only.

### 4. Quote/API changes

- `GET /api/connect/market`, `POST /api/connect/quote`: add
  `mrr_deposit_address`, `funding_deadline_hours: 24` to the response.
- `POST /api/connect/order`: as above (no USDC balance check).
- `GET /api/connect/orders`: include funding_state, deposit_txid,
  fee_paid_at, funding_deadline.

## Tests (Jest, no mocks of the real MRR)

- mrrFunding: deposit matching (exact, tolerance, overpayment, wrong
  txid), balance parse (confirmed vs unconfirmed), expireFunding sweep,
  idempotency (same deposit never double-matches).
- connectService: quote includes deposit address + deadline; createConnectOrder
  no longer reads user_wallets balance; order lands in PENDING_FUNDING with
  expected_deposit_btc.
- connectWorker: claims only CONFIRMED+paid orders; existing rent/pool path
  tests stay green.
- Fee contract: if the toolchain allows, a small compile+deploy+payFee test
  (hardhat or solc+ethers); otherwise state the compile result in the
  report.
- Full existing suite must stay green (currently 232 tests / 25 suites).

## Constraints

- Do NOT touch: game rooms, deposits (USDC game deposits stay), rewards,
  withdrawal queue (USDC), payout trigger, backing monitor, database rows
  for existing users, or the fee % (CONNECT_FEE_PCT stays 5).
- Do NOT change `user_wallets` semantics for the game.
- No new npm dependencies in the app. Contract compile via solc/Foundry
  only (devDependency ok if already present).
- Do NOT commit, do NOT deploy, do NOT restart. Report: files changed,
  migration SQL, fee contract bytecode/ABI, test output, and any
  assumption you had to make.
