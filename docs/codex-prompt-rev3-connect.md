# Codex Prompt: REV 3 — "Connect My Miner" (direct-to-wallet mining)

> Paste this block into Codex. Work in the local repo:
> /Users/cleartheclutter/dev/nexus-mining-platform. Do NOT commit. Do NOT
> deploy — the operator reviews and deploys after. Feature is OFF by default
> (ENABLE_CONNECT=0) — nothing changes for live users until the operator flips
> the flag.

---

## Product (Kevin's words, 2026-08-22)

> "Payouts need to go directly to the users wallet, nexus only provides
> information and for 5% fee an easy connection to a miner and mining pool.
> Saving people the hassle of finding the right miner and settings to enter
> and mine a pool successfully."

Build the **Connect My Miner** flow: a signed-in user picks a coin + a real
MRR rig + a window, enters their OWN payout address, pays (rental cost + 5%
connection fee in USDC), and Nexus rents the rig on MRR and points it at the
user's address. The pool pays THE USER directly — Nexus never holds mined
coins. Nexus shows verification (hashing? unpaid? paid out?) via public pool
stats. This is ADDITIVE — the existing game/rooms/operator pipeline stays
untouched.

## Verified facts (2026-08-22 — do not re-derive)

- **MRR order contract**: `PUT /rental` body `{rig, length, profile,
  currency}` → `{"success":true,"data":{"id":"5701967", ...}}` (length =
  hours; currency 'BTC'). Observed order fields: id, hashrate.advertised,
  price.paid (BTC), length, start, end.
- **MRR pool-switch contract (PROVEN live today)**: `PUT /rental/{id}/pool`
  body `{host, port, user, pass}` → `{"success":true,"data":{"id":"...",
  "success":true}}`. Rig hashes to the new pool within seconds (proof rental
  #5701967: HeroMiners showed hashrate 215.9 GH/s + unpaid accruing to the
  wallet <60s after the switch).
- **Rig listing**: `GET /rig?type=<algo>&limit=50` → rigs under
  `data.records` (NOT `rigs`). Each record: id, name, rpi, region,
  hashrate.advertised.{hash,type}, price.BTC.{hour,minhrs,maxhrs,
  min_rental_length}.
- **Pool profiles (already created, verified):** KASPA → 957805
  (de.kaspa.herominers.com:1207, user kaspa:…); ZCASH → 957592
  (zec.2miners.com:1010, user t1…); BTC → 957824
  (mine.ocean.xyz:3334, user bc1…). The Connect worker rents with these
  profiles, then IMMEDIATELY switches the pool user to the CUSTOMER's address.
- **Wallet-only pool config for the switch (user = customer address, pass
  'x'):**
  - KASPA: `de.kaspa.herominers.com` : `1207`, user = customer `kaspa:…`
  - ZCASH: `zec.2miners.com` : `1010`, user = customer `t1…`
  - BTC: `mine.ocean.xyz` : `3334`, user = customer `bc1…`
- **Public verification APIs (no auth):**
  - KAS: `https://kaspa.herominers.com/api/stats_address?address=<addr>` →
    `stats.hashrate_1h` (H/s), `stats.balance` (atomic, /1e8 = KAS)
  - ZEC: `https://zec.2miners.com/api/accounts/<addr>` →
    `data.currentHashrate` (Sol/s), `data.unpaid` (atoms, /1e8 = ZEC)
  - BTC: `https://api.blockcypher.com/v1/btc/main/addrs/<addr>` →
    `balance` (sat, /1e8 = BTC)
- **Payout floors (display only — the pool pays the user, Nexus does NOT
  distribute):** KASPA 1 KAS, ZCASH 0.1 ZEC, BTC 0.00065536 BTC.
- **Wallet validation (reuse verbatim from
  `controllers/rewardsController.js` ADDRESS_RULES):**
  ZCASH `/^t1[a-zA-Z0-9]{33}$/`, KASPA `/^kaspa:[a-z0-9]{60,64}$/i`,
  BTC `/^(bc1[ac-hj-np-z02-9]{11,71}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/i`.
- **USDC charging pattern (reuse from `controllers/upgradeController.js`
  buySession):** `SELECT wallet_id, usdc_balance FROM user_wallets WHERE
  user_id = $1 FOR UPDATE` → insufficient → 400 'Insufficient USDC balance'
  → deduct via `UPDATE user_wallets SET usdc_balance = $1 …` →
  `INSERT INTO protocol_revenue_ledger (source_user_id, amount_usdc,
  transaction_type, order_id)` books ONLY the 5% fee (95% is reimbursement).
  Idempotency: `request_id` VARCHAR(64) UNIQUE (1-64 chars).
- **Reusable modules:** `services/mrrRenter.js` (placeHashpowerOrder,
  getOrderStatus, makeMrrRequest, POOL_ALGORITHM_MAP, advertisedGhs,
  rigIsAvailable), `services/priceOracle.js` + `operatorMarketService.js`
  (fetchMarketSpots / buildMarketView / calculateProfitability /
  marketStatsFor / storageHashrateFor — already handle kheavyhash/equihash/
  sha256), `middleware/adminAuth.js` requireAdminKey, `config/db.js`.

## Migration `database/migrations/026_connect_orders.sql`

```sql
CREATE TABLE IF NOT EXISTS connect_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  request_id VARCHAR(64) UNIQUE NOT NULL,
  target_pool VARCHAR(50) NOT NULL CHECK (target_pool IN ('KASPA','ZCASH','BTC')),
  payout_address VARCHAR(255) NOT NULL,
  rig_id VARCHAR(64) NOT NULL,
  rig_name VARCHAR(255) NOT NULL,
  rig_hashrate_nice VARCHAR(64) NOT NULL,
  length_hours INT NOT NULL CHECK (length_hours IN (1,3,6,12,24,48,72)),
  rental_cost_btc NUMERIC(20,10) NOT NULL,
  btc_spot_price NUMERIC(20,10) NOT NULL,
  rental_cost_usd NUMERIC(20,4) NOT NULL,
  fee_pct NUMERIC(5,2) NOT NULL DEFAULT 5.00,
  fee_usd NUMERIC(20,4) NOT NULL,
  total_usd NUMERIC(20,4) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'PENDING_RENT'
    CHECK (status IN ('PENDING_RENT','RENTING','POOL_POINTED','ACTIVE','COMPLETED','FAILED','REFUNDED')),
  failure_reason TEXT,
  mrr_rental_id VARCHAR(64),
  rental_ends_at TIMESTAMPTZ,
  hashrate_confirmed_at TIMESTAMPTZ,
  unpaid_last NUMERIC(20,10),
  unpaid_checked_at TIMESTAMPTZ,
  paid_out_at TIMESTAMPTZ,
  pool_stats_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_connect_orders_user ON connect_orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_connect_orders_status ON connect_orders(status);
```
(Length values are the MRR windows we advertise — quote only offers windows ≥
the rig's min_rental_length, rounded to the nearest advertised option.)

## Part A — backend

1. **`services/mrrRenter.js`**: add exported helper
   `switchRentalPool(rentalId, { host, port, user, pass })` →
   `makeMrrRequest('PUT', '/rental/' + rentalId + '/pool', null, {host, port,
   user, pass})`. (This is the PROVEN call; there is no existing helper.)
2. **`services/connectService.js`** (new):
   - `POOL_CONFIG = { KASPA: {host:'de.kaspa.herominers.com', port:'1207',
     profile:'957805', floor:1, statsUrl:(a)=>`https://kaspa.herominers.com/api/stats_address?address=${a}`,
     balanceOf:(d)=>Number(d?.stats?.balance||0)/1e8, hashOf:(d)=>Number(d?.stats?.hashrate_1h||0),
     link:(a)=>`https://kaspa.herominers.com/#/wallet/${a}`}, ZCASH: {...profile
     '957592', zec.2miners.com:1010, floor 0.1, statsUrl zec.2miners.com/api/accounts,
     balanceOf unpaid/1e8, hashOf currentHashrate, link
     https://zec.2miners.com/accounts/<addr>}, BTC: {host:'mine.ocean.xyz',
     port:'3334', profile:'957824', floor:0.00065536, statsUrl Blockcypher,
     balanceOf balance/1e8, hashOf null (BTC hashrate confirmed via MRR
     getOrderStatus instead), link https://ocean.xyz/address/<addr>} }`
   - `marketFor(algo)` → wrap operatorMarketService.buildMarketView /
     calculateProfitability with a live BTC-USD spot from priceOracle (same
     pattern as operatorController.getMarket) — returns rows with
     net/day + break-even + min hours, sorted by net/day. algo must be
     kheavyhash|equihash|sha256.
   - `quote({targetPool, rigId, lengthHours})` → live MRR rig price:
     rentalCostBtc = price.BTC.hour × hours; usd = × btcSpot; fee =
     total × feePct/100; returns {rig, windows, rental_cost_usd, fee_usd,
     total_usd, btc_spot_price}.
   - `validatePayoutAddress(targetPool, addr)` → the ADDRESS_RULES regexes.
3. **`services/connectWorker.js`** (new — dedicated worker, poll every 15s,
   do NOT touch orderOutboxWorker):
   - Claim rows `status='PENDING_RENT'` (FOR UPDATE SKIP LOCKED, per-user
     limit, max concurrent 2 — MRR account is one BTC balance).
   - **Rent**: `placeHashpowerOrder` with EXACT rig id, length, profile id,
     currency BTC. On success save mrr_rental_id + rental_ends_at →
     status RENTING. On failure → status FAILED + failure_reason + AUTO
     REFUND (refund user_wallets.usdc_balance total_usd, insert a
     `protocol_revenue_ledger` REFUND row? no — refunds do NOT hit the
     revenue ledger; just restore the balance, set status REFUNDED).
   - **Point**: `switchRentalPool(mrr_rental_id, {host, port, user:
     payout_address, pass:'x'})`. Retry once on failure; if still failing →
     cancel the MRR rental if possible (best-effort), refund, status
     REFUNDED. On success → status POOL_POINTED.
   - **Verify**: poll the pool stats API for payout_address (KAS/ZEC); if
     hashOf > 0 → hashrate_confirmed_at + status ACTIVE. BTC: hashrate
     confirmed via mrrRenter.getOrderStatus(mrr_rental_id) average hashrate
     > 0. Store pool_stats_url.
   - **Sweeper** (every 5 min): ACTIVE rows with rental_ends_at < now →
     final unpaid snapshot → status COMPLETED (payout continues directly to
     the user; the order is done).
   - **Paid-out detection** (display): for ACTIVE rows, refresh unpaid_last;
     if unpaid_last ≥ floor then later drops → paid_out_at = now (the pool
     paid the user). BTC: balance increase → paid_out_at.
   - Start in `server.js` like the other workers (see rentalScheduler), but
     only when ENABLE_CONNECT=1; log "connectWorker: enabled/disabled".
4. **`controllers/connectController.js`** (new) + routes in `routes/api.js`
   under `/api/connect/*` with requireAuth:
   - `GET /api/connect/market?algo=` → marketFor(algo); 503 with
     {error:'Connect is not enabled'} unless ENABLE_CONNECT=1.
   - `POST /api/connect/quote` {target_pool, rig_id, length_hours} → quote.
   - `POST /api/connect/order` {target_pool, payout_address, rig_id,
     length_hours, request_id} → validate address + quote + USDC debit
     (exact buySession pattern) + insert connect_orders row + ledger fee row
     (transaction_type 'CONNECT_FEE', order_id = the connect order id) →
     201 {order}.
   - `GET /api/connect/orders` → user's orders (status, rig, window, unpaid,
     paid_out, pool_stats_url) newest first.
5. **`.env.example`**: `ENABLE_CONNECT=0`, `CONNECT_FEE_PCT=5`.

## Part B — frontend

6. **`App.jsx`**: add a "Connect" nav entry (visible to signed-in users) →
   renders `ConnectPanel`. No changes to existing rooms/game/operator views.
7. **`components/ConnectPanel.jsx`** (new):
   - Coin tabs KAS / ZEC / BTC → `GET /api/connect/market?algo=…` (kheavyhash
     / equihash / sha256). If 503 → show "Connect is coming soon" and stop.
   - Table (reuse MarketPanel CSS classes where sensible): Rig, Hashrate,
     USD/hr, **Net/day**, Break-even, Min hours, RPI, Region + a "Select"
     button per row.
   - Selected rig → window picker (options = advertised windows ≥ rig min:
     1/3/6/12/24/48/72) → `POST /api/connect/quote` → show arithmetic line:
     "Rental $X.XX + 5% connection fee $Y.YY = $Z.ZZ".
   - Payout address input with per-coin placeholder (kaspa:… / t1… / bc1…)
     and client-side regex from ADDRESS_RULES.
   - **Connect button** → `POST /api/connect/order` (request_id = a fresh
     `crypto.randomUUID()` kept for idempotent retry) → success screen with
     pool_stats_url link "Watch your payout at the pool".
   - **My connections** list (GET /api/connect/orders): per order —
     status chip, rig name, window end, unpaid progress to floor
     (e.g. "0.41 / 1.00 KAS · pays at 1 KAS"), paid_out badge, pool link.
   - Backend 400 errors (insufficient balance, invalid address) rendered
     inline; idempotent retry on network failure (same request_id).
8. **`index.css`**: `.connect-*` styles (tabs, quote line, status chips).

## Tests (add to backend/tests)

- `connectService.test.js`: fee math (total × 5%), windows filtering (rig min
  respected), address validation per coin (valid/invalid cases incl. the
  platform wallets), marketFor returns sorted rows for all 3 algos with
  net/day.
- `connectController.test.js`: ENABLE_CONNECT=0 → 503 on all routes; order
  happy path (debit + ledger fee + row inserted, request_id idempotent —
  second identical call returns the same order, no double debit);
  insufficient balance → 400; invalid address → 400.
- `connectWorker.test.js`: PENDING_RENT → rent → pool switch (mock
  mrrRenter.placeHashpowerOrder + switchRentalPool) → POOL_POINTED → hash
  confirm → ACTIVE; rent failure → REFUNDED + balance restored; switch
  failure → retry once → REFUNDED.
- `mrrRenter.test.js`: add switchRentalPool test (PUT /rental/{id}/pool body
  {host, port, user, pass}).
- Migration: nothing to validate beyond the SQL being idempotent (IF NOT
  EXISTS) — the operator validates on live Postgres.

## Constraints

- Do NOT touch: auth, deposits, withdrawals, the game (023), the operator
  order pipeline, the rooms (ZCASH/KASPA/LTC_DOGE/BTC room logic), payout
  trigger, backing monitor. LTC_DOGE is NOT a connect coin (F2Pool is
  account-based — wallet-only pools only).
- No new npm dependencies. No randomness. No fabricated numbers — use live
  MRR/CoinGecko data only.
- Full suite green (currently 181 tests — 20 suites) + `npm run build` +
  `git diff --check`.
- Do NOT commit, do NOT deploy, do NOT apply the migration, do NOT restart
  anything. Report: files changed, test count, any assumption you had to
  make.

## Operator deploy notes (for reference — the operator does this AFTER review)

ENABLE_CONNECT=1 + CONNECT_FEE_PCT=5 in droplet .env; apply 026 (validated
first on live Postgres in a rollback tx); rebuild frontend; restart. First
live smoke: operator places a $0.10 KAS connect order to a test wallet,
worker rents + switches, pool shows hashrate at the test wallet.
