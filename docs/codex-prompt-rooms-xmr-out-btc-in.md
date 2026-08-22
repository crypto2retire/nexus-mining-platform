# Codex Prompt: Remove XMR room + Add BTC (SHA-256) room

> Paste the block below into Codex. Work in the local repo:
> `/Users/cleartheclutter/dev/nexus-mining-platform`. Do NOT commit. Do NOT
> deploy — the operator reviews and deploys after.

---

## Task (one domain: room swap)

**Part A — REMOVE the XMR (Monero/RandomX) room.** Kevin's call (2026-08-22):
XMR is the AML-riskiest surface; the room comes out. The user's separate
XMRig Mac miner and the XMR platform wallet are NOT part of this — leave the
`XMR_WALLET_ADDRESS` env and any local-miner code untouched.

**Part B — ADD a BTC (SHA-256) room** as the marquee "whale" room. All pool
and market facts below were verified live 2026-08-22.

## Verified facts (do not re-derive)

- **MRR algo name**: `sha256` (verified in `/info/algos`; 170 rigs available,
  2.02 EH/s total, market low **0.00066000 BTC/PH·day**, last_10
  0.00109251 BTC/PH·day). Example rigs: `S9 (DC08)` 500 TH/s rpi 98.07
  us-east 0.0000145625 BTC/hr min 12h; `🍏-11a` 140 TH/s rpi 88.67
  0.00000385 BTC/hr min 24h; `Telman2` 1.49 PH/s 0.000043458 BTC/hr.
- **BTC network**: 858.8 EH/s (btc.2miners.com/api/stats), blocktime 585s,
  reward 3.125 BTC → **~450 BTC/day emission** → 1 TH/s ≈ 5.24e-7 BTC/day ≈
  **$0.0409/TH·day at $77,994**. Market-low rental ≈ $0.0517/TH·day → the
  room is net-negative like every room (marquee, honestly priced).
- **Pool: Ocean (ocean.xyz)** — wallet-only by design ("No KYC, only payout
  address"), payouts auto-send above **0.00065536 BTC** (verified on their
  homepage), pays the Bitcoin address directly, no account. Stratum
  `ocean.xyz:3333`, username = the platform BTC address, pass `x`. Platform
  BTC wallet (provided by Kevin 2026-08-22):
  `bc1qfclp7n4nqf980fq77rq6euha8ft8q92cysqlgg` (valid bech32 P2WPKH —
  checksum-verified).
  **2Miners BTC is OUT** (min payout 0.05 BTC ≈ $3,900 — the old 50-KAS
  never-pays trap).
- **Watch design**: BTC uses the **LTC/DOGE pattern** — Blockcypher on-chain
  balance-delta (`https://api.blockcypher.com/v1/btc/main/addrs/<addr>`,
  balanceOf /1e8), settlement-gated (NOT in the 6h accrual pools), room card
  says "Paid to wallet", no ETA (honest). Display threshold 0.00065536 BTC.
- **Migration 025 IS REQUIRED**: live CHECK constraints reject 'BTC' in
  three tables (verified via pg_constraint on the droplet):
  `hashrate_orders.target_pool`, `rig_rentals.target_pool`,
  `virtual_rigs.target_pool` — each `= ANY (ARRAY[...4 values...])`. Keep XMR
  in the lists (historical rows; the removal is code-level).
- **Tier ladder** (TH/s units — BTC's natural unit; round numbers, whale-scale,
  cost-based with ≥5x headroom over the market-low rental):
  `L2 $100 → 50 TH/s, L3 $250 → 120 TH/s, L4 $500 → 300 TH/s, L5 $1000 → 700
  TH/s` (rental cost at market low ≈ $7.75 / $18.6 / $46.5 / $108.5 per 72h).

## Migration `database/migrations/025_btc_room.sql` (approved)

```sql
ALTER TABLE hashrate_orders DROP CONSTRAINT IF EXISTS hashrate_orders_target_pool_check;
ALTER TABLE hashrate_orders
  ADD CONSTRAINT hashrate_orders_target_pool_check
  CHECK (target_pool::text = ANY (ARRAY['ZCASH','KASPA','LTC_DOGE','XMR','BTC']::text[]));
-- same pattern for rig_rentals_target_pool_check and virtual_rigs_target_pool_check
```
(Use the ACTUAL live constraint names — query `pg_constraint` if the names
differ; `DROP CONSTRAINT IF EXISTS` + recreate with the 5-value ARRAY.)

## Part A — remove XMR (every reference; grep the whole backend + frontend)

- `payoutTrigger.js`: delete `WATCHES.XMR`, `PAYOUT_MIN.XMR`, the herominers
  XMR comment block; fix the header comment (XMR gone).
- `roomHash.js`: delete `WALLET_ENV.XMR`, `ACCOUNT_URL.XMR`, the XMR branch in
  `fetchLiveRealHash` (keep the KASPA branch; keep the ZEC fallback).
- `mrrRenter.js`: delete `POOL_ALGORITHM_MAP.XMR`, `MIN_ADVERTISED.randomx`,
  `HASH_TYPE_TO_BASE.randomx` (Part B adds sha256 entries).
- `upgradeController.js`: delete `POOL_TIERS.XMR`, XMR from `POOL_UNITS`,
  `coinsOwnedFor`, and any XMR tier helpers.
- `backingMonitor.js`: remove XMR from `POOLS` and `REAL_UNITS`.
- `rewardDistributor.js`: remove `POOL_COIN_SYMBOL.XMR` and XMR from the
  accrual pool set (BTC is settlement-gated like LTC_DOGE — same set).
- `accrualDistributor.js`, `rentalScheduler.js`, `hashrateRenter.js`,
  `multiCoinDiscount.js`, `dashboardController.js`, `rewardsController.js`,
  `adminStatsController.js`, `operatorMarketService.js` (delete
  `ALGO_CONFIG.randomx`): remove every XMR/randomx reference (grep
  `\bXMR\b|randomx|RandomX` and delete).
- Frontend: `App.jsx` POOLS (remove XMR entry), `GetStarted.jsx` if it lists
  rooms, any XMR-specific copy.
- Tests: update `payoutTrigger.test.js` (XMR watch tests → remove),
  `backingMonitor.test.js`, `upgradeController.test.js`, `gominer.test.js`,
  `operatorMarket.test.js` (remove randomx), and any others referencing XMR.
- Do NOT touch: `XMR_WALLET_ADDRESS` env handling, the Mac XMRig monitoring
  path (minerMonitor/LiveMinerPanel are separate), migrations 001-024 except
  the 025 spec above.

## Part B — add BTC room

- `mrrRenter.js`: `POOL_ALGORITHM_MAP.BTC = 'SHA256'`;
  `MIN_ADVERTISED.sha256 = 100` (TH/s floor — filters junk listings);
  `HASH_TYPE_TO_BASE.sha256 = { h: 1e-12, kh: 1e-9, mh: 1e-6, gh: 1e-3,
  th: 1, ph: 1e3 }`.
- `payoutTrigger.js`: `WATCHES.BTC` = balance-delta, walletEnv
  `MRR_PLATFORM_WALLET_BTC`, accountUrl Blockcypher btc/main, balanceOf /1e8,
  minPayout 0.00065536 (display), gamePool 'BTC'; `PAYOUT_MIN.BTC =
  Number(process.env.BTC_MIN_PAYOUT || 0.00065536)`; header comment update.
- `roomHash.js`: `WALLET_ENV.BTC`, `ACCOUNT_URL.BTC = null` (on-chain watch —
  real hash comes from MRR rental averages like LTC: the LTC branch in
  `fetchLiveRealHash` handles `pool === 'LTC_DOGE'` by MRR rental averages —
  add BTC to that same branch).
- `upgradeController.js`: `POOL_TIERS.BTC` (ladder above, TH/s),
  `POOL_UNITS.BTC = 'TH/s'`, BTC in `coinsOwnedFor`.
- `backingMonitor.js`: add BTC to `POOLS` + `REAL_UNITS` (TH/s) + the
  pool_unpaid_unit map ({... BTC: 'BTC'}).
- `rewardDistributor.js`: `POOL_COIN_SYMBOL.BTC = 'btc'` (CoinGecko id),
  BTC NOT in accrual pools (settlement-gated like LTC_DOGE).
- `dashboardController.js`: BTC room entry (units TH/s, coin 'BTC').
- `operatorMarketService.js`: `ALGO_CONFIG.sha256 = { targetPool: 'BTC',
  profileSuffix: 'SHA256', primaryCoin: 'BTC', coins: { BTC: { id:
  'bitcoin', production: 0.000262 } }, anchorGhs: 5e5 }` (500 TH/s anchor →
  verified 2.62e-4 BTC/day) + add 'sha256' to VALID_ALGOS in
  operatorController.js + the MarketPanel ALGOS tab ("BTC").
- Frontend: `App.jsx` POOLS add `{ key: 'BTC', title: 'Bitcoin (BTC) Mine' }`
  and the room card handles TH/s units from POOL_UNITS.
- `.env.example`: `MRR_POOL_PROFILE_SHA256=`, `MRR_PLATFORM_WALLET_BTC=`,
  `BTC_MIN_PAYOUT=0.00065536`.
- Tests: unit conversion (TH/s), tier ladder, BTC watch config (balance-delta,
  Blockcypher URL, /1e8), backing POOLS, operator market sha256 anchor math
  (500 TH/s → 0.000262 BTC/day × spot), XMR removal (no XMR references left
  in services/controllers — add a grep-based test if practical).

## Constraints

- **One migration: 025_btc_room.sql** (approved — spec above). Do NOT touch
  migrations 001–024. No new npm dependencies. No randomness. No fabricated
  numbers — every price/cost is live or from the verified facts above.
- Do NOT touch: auth, deposits, withdrawals, the game (023), the operator
  order pipeline, LTC_DOGE/ZCASH/KASPA room behavior.
- Keep the full test suite green (currently 173 tests — 19 suites) + `npm run
  build` + `git diff --check`.
- Do NOT commit, do NOT deploy, do NOT apply the migration, do NOT create the
  MRR profile (operator does that), do NOT restart anything. Report the
  remaining XMR references if any are found outside the allowed set.

## Operator step (address ALREADY provided — Kevin supplied it 2026-08-22)

Platform BTC wallet = **`bc1qfclp7n4nqf980fq77rq6euha8ft8q92cysqlgg`**
(Trust Wallet BTC, valid bech32 P2WPKH). It becomes `MRR_PLATFORM_WALLET_BTC`,
the Ocean pool username (payout destination), and the Blockcypher watch
target. After review, the operator: applies migration 025, sets the env vars
(`MRR_PLATFORM_WALLET_BTC=bc1qfclp7n4nqf980fq77rq6euha8ft8q92cysqlgg`),
creates the MRR SHA-256 pool profile via API (`PUT /account/profile` + `PUT
/account/profile/{id}` with `ocean.xyz:3333`, user =
`bc1qfclp7n4nqf980fq77rq6euha8ft8q92cysqlgg`, pass x), sets
`MRR_POOL_PROFILE_SHA256=<id>`, deletes `payout_watch` rows for XMR, rebuilds
the frontend, restarts.
