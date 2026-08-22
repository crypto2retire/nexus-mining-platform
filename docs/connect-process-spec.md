# THE ONLY PROCESS — Connect spec (Kevin 2026-08-22)

> "The only process this should be using: the user chooses a coin, the user
> reviews pool returns, size, cost, length. If they decide to rent we
> facilitate the correct miner and correctly set up pool. User pays the
> miner directly and receives rewards from the pool. We get a 5% fee that
> is added and separate from the amount sent to the miner."

This is the ONLY product process. The game/rooms/operator-market flows are
not part of it and must not be presented as the product.

## The six steps (non-negotiable)

1. **User chooses a coin.**
2. **User reviews pools by returns, size, cost, length** — the pool-choice
   UX must exist (sortable by those four).
3. **If they rent: we facilitate the correct miner + correctly set up the
   pool** — wallet-only pool; the user's payout address is the worker.
4. **User pays the miner directly** — the full rental amount goes to the
   miner (MRR / rig host). Nexus never takes a cut out of it.
5. **Pool pays the user directly.**
6. **Our 5% fee is ADDED ON TOP and SEPARATE** from the miner payment —
   never deducted from it.

## Audit vs current implementation (2026-08-22)

| Step | Status | Evidence |
|---|---|---|
| 1. Choose coin | ✅ | Connect tab: KAS/ZEC/BTC |
| 2. Review pools (returns/size/cost/length) | ❌ | One wallet-only pool per coin hard-coded (`POOL_CONFIG`: HeroMiners/2Miners/Ocean) — no pool-choice UX |
| 3. Facilitate rig + correct pool | ✅ | connectWorker places the MRR rental + `PUT /rental/{id}/pool` |
| 4. **User pays miner directly** | ❌ | Funding = user's Nexus **USDC** balance (`user_wallets.usdc_balance >= total_usd`, connectService.createConnectOrder); worker spends the **operator's MRR BTC balance**; refunds credit user USDC. That is user→Nexus→MRR |
| 5. Pool pays user directly | ✅ | Pool → user payout address (REV 3 proven live) |
| 6. **5% fee added and separate** | ⚠️ | Displayed as added on top ("Rental $X + 5% fee $Y = $Z") but collected from the same USDC balance as the rental — not a separate payment |

## The MRR constraint — why step 4 needs a decision

MRR rentals are funded from an **account BTC balance**. There is no
per-rental third-party payment or invoice link. "User pays the miner
directly" therefore means one of:

- **Option A — user-owned MRR accounts:** the user provides their own MRR
  API key/secret (or funds their own MRR account); we place the rental FROM
  their account pointed at their chosen pool + their payout wallet. True
  direct payment. Cost: MRR account verification, API-key custody (encrypt
  at rest), MRR TOS check, more onboarding friction.
- **Option B — fee separation within current architecture:** the user's
  rental payment (BTC) is earmarked for the rental; the worker pays MRR the
  FULL rental amount from the operator balance; the 5% fee is a SEPARATE
  payment (separate USDC line or separate BTC address) that never touches
  the miner payment. Money flow: rental amount 100% → miner; fee → Nexus as
  its own line item. Not literally "user→miner" on-chain, but the accounting
  is fully separated.

## Decision: Option B — CONFIRMED (Kevin 2026-08-22)

**Chosen:** Option B — user sends the amount needed to pay the miner; a
smart contract forwards it to fund the MRR rental. **Rejected:** Option A —
API access to a user's MRR account gives us access to their account and
funds (draining risk); with Option B we have **no access to user funds or
wallets at any time**.

### Why B is legally stronger (analysis Kevin reviewed, 2026-08-22)
- **FinCEN four-factor test (2019 guidance)** — money-transmitter factors
  all land favorable for B: the user owns the value; it is stored
  user-wallet → contract → MRR (we never hold it); the user initiates; the
  contract executes the transfer (no total independent control by us).
  Unhosted-wallet reasoning applies: the owner interacts with the payment
  system directly.
- **Software provider vs service:** "accepting value and transmitting it"
  = money transmitter; "merely supplying tools" = software provider. B is a
  tool the user drives.
- **The control test (Coin Center / Tornado Cash):** if we can move funds
  locked by the contract → money transmitter. If nobody can (logic-only,
  no admin withdraw) → software provider. **Design requirement: the funding
  contract MUST be non-custodial — no admin key that can move funds; only
  the intended forward/settle/refund logic.**
- **SEC "vaults" caveat:** even if not a money transmitter, the SEC may
  examine a contract+facilitation model. Bring the contract design to
  Monday's counsel.

### ⚠️ Technical reality (verified against MRR, 2026-08-22)
MRR funding is **BTC-only, via the account's Bitcoin deposit address**. An
EVM smart contract **cannot send BTC** — so "the contract forwards it to
MRR" is not directly executable on-chain. The contract CAN hold and forward
**USDC (Base)**; getting USDC to MRR requires a conversion step. Realistic
architectures (pick in order of preference):

1. **BTC direct + contract for fee/escrow (recommended):** user sends BTC
   straight from their wallet to the MRR funding address (we show the exact
   address + amount; we never touch it). The smart contract (Base, USDC)
   handles the **5% fee as a separate payment** + optional escrow/refund
   guarantee for the rental. Closest to "user pays miner directly, fee
   added and separate," zero custody.
2. **USDC escrow contract + keeper conversion:** user deposits USDC (rental
   + fee) into the contract; a keeper converts the rental portion to BTC
   and forwards to MRR. Contract holds funds programmatically (non-
   custodial by design), but the keeper is a human moment — weakens the
   "we never touch funds" story and the FinCEN factors.
3. **User-guided rental (no automation):** we tell the user exactly which
   rig + pool config to rent on MRR's own web UI with THEIR account; they
   pay from their own MRR balance. True direct payment, zero access, but
   the rental is not automated by our worker.

**Recommendation: architecture 1** — user BTC → MRR directly (no contract
needed for the rental itself), smart contract only for the separate 5% fee
(+ optional escrow). Confirm with Kevin before building the contract.

### Next steps
- [ ] Kevin confirms architecture 1 vs 2 vs 3
- [ ] Counsel reviews the non-custodial contract design (Monday)
- [ ] Contract spec: no admin withdraw; forward/settle/refund only;
      upgradeability via timelock at most
- [ ] Pool-choice UX (returns/size/cost/length) still to be built
- [ ] Connect funding path migration (out of scope until architecture set)


