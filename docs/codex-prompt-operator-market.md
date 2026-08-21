# Codex Prompt: Operator Market Dashboard + Direct MRR Ordering

> Paste the block below into Codex. Work in the local repo:
> `/Users/cleartheclutter/dev/nexus-mining-platform`. Do NOT commit. Do NOT
> deploy — the operator reviews and deploys after.

---

## Task

Build an operator-only "Mining Market" view for the Nexus dashboard:

1. **Market explorer** — for each room algorithm (kheavyhash=KAS, scrypt=LTC,
   equihash=ZEC, randomx=XMR), show the live MiningRigRentals (MRR) options:
   rig name, hashrate size, **cost in USD** (BTC price × live BTC/USD from
   `backend/services/priceOracle.js`), available time frames (min rental
   hours, max, extensions), reliability (rpi), region, availability.
2. **Best-value recommendation** — deterministic analysis (NO randomness, NO
   fabricated numbers): rank available rigs by **USD per GH/s-day** among
   online, available, not-rented, verified rigs (rpi >= 90 preferred; skip
   rpi === 'new' unless nothing else qualifies), and surface the top pick
   with its reasoning (cost per GH/s-day, min rental cost, reliability).
3. **Direct order** — operator rents a chosen rig and the cost comes straight
   out of the MRR account's BTC balance (NO USDC charge). Prices displayed in
   USD only.

## Verified MRR API facts (all probed live 2026-08-21, auth pattern in
`backend/mrr-watchdog.js`: HMAC-SHA1 over KEY+nonce+path, headers
x-api-nonce/x-api-key/x-api-sign; base https://www.miningrigrentals.com/api/v2)

- **GET /rig?type=<algo>&limit=50** — market listings. Response
  `data.records[]` shape (verified):
  `{ id, name, owner, type, region, rpi, online,
     status: { status: 'available'|'rented', hours, rented, online },
     hashrate: { advertised: { hash, type, nice },
                 last_5min: {hash,nice,type}, last_15min, last_30min },
     price: { type: 'th'|'gh'|..., BTC: { currency:'BTC', price, hour,
              minhrs, maxhrs, min_rental_length, enabled }, LTC:{...}, ... },
     extensions: true|false, ndevices }`
  - `price.BTC.hour` = BTC per hour; `minhrs` = cost of the minimum rental;
    `maxhrs` = cost of the max rental; `min_rental_length` = minimum hours.
  - algo values: `kheavyhash`, `scrypt`, `equihash`, `randomx`.
- **GET /info/algos** — aggregate stats per algo (available rigs/hash,
  prices lowest/last_10/last_20/last_30) for the market header.
- **POST /rig/{id}** — NOT the order contract. **The REAL, tested MRR order
  contract is `PUT /rental` with body
  `{ rig: <rigId>, length: <hours>, profile: <profileId>, currency: 'BTC' }`**
  (verified in `backend/services/mrrRenter.js` `placeHashpowerOrder` line
  ~346 — the file header comment saying `POST /rig/{id}` is STALE; trust the
  code). The body already accepts a specific `rig` id — the existing flow just
  fills it from `findAffordableRig(budget)` instead of a user choice.
  Response: `data.rental.id` = order id, `data.rental.price.paid` = actual BTC
  cost (both already parsed by `placeHashpowerOrder`).
- Pool profile env vars (already set): `MRR_POOL_PROFILE_EQUIHASH`,
  `MRR_POOL_PROFILE_KHEAVYHASH`, `MRR_POOL_PROFILE_SCRYPT`,
  `MRR_POOL_PROFILE_RANDOMX` — pass the matching profileid per algorithm.

## Backend changes

### New file `backend/controllers/operatorController.js`
Routes (all behind `requireAuth` from `../middleware/auth`):

- **GET /api/operator/market?algo=kheavyhash|scrypt|equihash|randomx**
  - Gate: `req.auth.wallet` must equal `process.env.OPERATOR_WALLET` (lowercase
    compare). No OPERATOR_WALLET set → 403 with a clear message.
  - Fetch `GET /rig?type=<algo>&limit=50` from MRR via the request helper in
    `backend/services/mrrRenter.js` (reuse `makeMrrRequest`).
  - Enrich: `usd_per_hour = price.BTC.hour × btcUsd` (use the priceOracle
    helper already used elsewhere, e.g. `getBtcUsdcPrice()` — check
    `backend/services/priceOracle.js` for the exported name and reuse it; it
    has a TTL cache — do NOT hit it per rig, fetch once per request).
  - Per rig return: `{ rig_id, name, owner, region, rpi, available (status
    available && !rented && online), hashrate_nice (advertised.nice),
    hashrate_ghs (advertised converted to GH/s), usd_per_hour,
    usd_min_rental (price.BTC.minhrs × btcUsd), min_hours
    (price.BTC.min_rental_length), extensions, pool_profile_id (env for the
    algo) }`.
  - Apply the hashrate floor filters already defined in
    `backend/services/mrrRenter.js` (HASH_TYPE_TO_BASE / min advertised
    hashrate per algo — reuse that logic, do not re-invent).
  - **Best-value pick**: among `available === true` rigs, prefer rpi >= 90
    (skip `rpi === 'new'` if any qualified rigs exist); rank by
    `usd_per_ghs_day = (usd_per_hour × 24) / hashrate_ghs`; return
    `{ rig_id, name, usd_per_ghs_day, usd_per_day, hashrate_ghs, rpi,
       min_hours, usd_min_rental, reason }` where reason is a plain-English
    sentence built from the numbers (e.g. "Cheapest delivered cost:
    $0.0041/GH·day at 215 GH/s ≈ $0.88/day, rpi 99.2, 3h minimum").
    Also return the market header stats (available rigs, total available
    hash, lowest/last_10 USD per GH·day) from /info/algos.
  - **P/L scenario engine (Kevin 2026-08-21: "does the dashboard include p/l
    for all scenarios when setting up a new miner?" — YES, it must)**. For
    EVERY rig, compute a deterministic P/L block from the platform's OWN
    observed production anchors (ground truth — NOT WhatToMine, which is
    license-restricted and must never be wired in):
    - Anchor table (env-overridable, verified fleet rates 2026-08-21, the
      platform's real delivery per algo — this bakes in the ZEC equihash
      ~57% delivery gap automatically):
      `KASPA: 200 GH/s → 1.3832 KAS/day; ZCASH: 30.55 kSol/s → 0.002060
      ZEC/day; XMR: 14.25 kH/s → 0.000479 XMR/day; LTC_DOGE: 7 GH/s →
      0.007304 LTC/day + 28.69 DOGE/day (merged)`.
    - Per-rig: `revenue_day = (hashrate_ghs / anchor_ghs) × anchor_production
      × live_spot` (LTC_DOGE = LTC revenue + DOGE revenue). Live spot from
      CoinGecko simple price with a short TTL cache (the priceOracle is
      BTC/USDC only — fetch coin spots in this controller; cache 60s).
    - `net_day = revenue_day − usd_per_day (cost)`.
    - **Scenarios** (all with shown arithmetic in the payload):
      `net_current`, `net_plus10`, `net_minus10`, `net_plus25`,
      `net_minus25` (spot multipliers), `break_even_price` (= spot ×
      cost_day / revenue_day), and per-length rows for
      `[min_hours, 24, 48, 72]`: `{length_hours, total_cost,
      expected_value, net}`.
    - **Trend**: fetch 24h + 7d % change per coin (CoinGecko
      `/coins/markets?price_change_percentage=24h,7d`, same cache) and attach
      `price_trend {price, chg_24h, chg_7d}` to the response — Kevin's
      mandatory report columns.
    - Primary sort for the table = `net_day` (delivery-adjusted P/L) at
      current price, with `usd_per_ghs_day` shown as the secondary
      cost-transparency metric. Best-value reason sentence must cite the P/L
      numbers, e.g. "≈ +$0.31/day net at current ZEC price (break-even
      $610 — 17% below spot)".
  - Response shape: `{ algo, generated_at, price_trend, best_value, rigs:
    [...top 25 sorted by net_day... each with cost + P/L scenario block +
    per-length rows], market_stats }`.

- **POST /api/operator/order** body `{ rig_id, algo, length_hours }`
  - Gate: same OPERATOR_WALLET check.
  - `length_hours` must be >= rig `min_rental_length` and <=
    `MRR_MAX_RENTAL_HOURS` (default 72, env).
  - **MIGRATION 024 IS APPROVED (operator-orders fields only — Kevin
    2026-08-21, after Codex flagged the schema conflict).** New file
    `database/migrations/024_operator_orders.sql` (idempotent, additive,
    NULL-able — zero impact on existing rows/flow):
    ```sql
    ALTER TABLE hashrate_orders
      ADD COLUMN IF NOT EXISTS requested_rig_id VARCHAR(50),
      ADD COLUMN IF NOT EXISTS pool_profile_id VARCHAR(20),
      ADD COLUMN IF NOT EXISTS requested_length_hours INT;
    CREATE INDEX IF NOT EXISTS idx_hashrate_orders_requested_rig
      ON hashrate_orders (requested_rig_id);
    ```
    Rationale (all verified against the live schema 2026-08-21): migration 021
    stores `requested_rig_level`/`requested_rig_hashrate` (budget/ladder) but
    NOT the exact MRR rig id or pool profile; the outbox worker calls
    `placeHashpowerOrder` which picks the rig by budget via `findAffordableRig`
    — the operator's exact selection cannot survive without these columns. Do
    NOT overload existing columns (`rig_name`/`rig_rpi` are audit after the
    fact; `nicehash_order_id` is marketplace-specific).
  - Insert the `hashrate_orders` row (status PENDING, marketplace 'MRR',
    algorithm = the algo's uppercase room name (KASPA/ZCASH/LTC_DOGE/XMR),
    **`requested_rig_id = rig_id`, `pool_profile_id` = the env profile for the
    algo, `requested_length_hours = length_hours`**, operator wallet as the
    user, `btc_spent = 0` — the actual cost is recorded post-placement from
    MRR `price.paid` into `rig_rentals.cost_btc` as today). Do NOT debit
    USDC, do NOT charge a protocol fee, do NOT create the rig or capacity
    slice inline — the outbox worker handles placement + activation on
    success (reuse that path; the worker must not require a USDC balance).
  - **Worker exact-rig path**: extend `placeHashpowerOrder(targetPool,
    spendBtcAmount)` with an optional override
    `{ rigId, lengthHours, profileId }`. When `rigId` is provided: SKIP
    `findAffordableRig` (do a light availability check via
    `GET /rig?type=<algo>` filtered to that id — must be available/online/not
    rented, else FAILED → refund path), and call the SAME tested
    `PUT /rental {rig: rigId, length: lengthHours, profile: profileId,
    currency: 'BTC'}`. When no override: existing budget flow unchanged.
    The worker reads the override from the order row
    (`requested_rig_id`/`requested_length_hours`/`pool_profile_id`).
  - Return `202 { status: 'PENDING', order_id }` (same shape the existing
    upgrade endpoint returns) so the frontend can poll.

- **GET /api/operator/orders** (optional, same gate): recent operator
  hashrate_orders with status, for the panel's "my orders" list.

Reuse as much of `backend/services/mrrRenter.js` and the outbox worker as
possible. Do NOT modify `upgradeController.js`, `rewardsController.js`,
deposits, the game, or the player USDC flow.

## Frontend changes

### New file `frontend/src/components/MarketPanel.jsx`
- Rendered in `App.jsx` ONLY when `auth.wallet` (lowercased) equals
  `OPERATOR_WALLET` (pass via `import.meta.env.VITE_OPERATOR_WALLET` with the
  value from the backend env; hide when absent). Place it above the room
  cards, below the GamePanel.
- Algo tabs (KAS / LTC / ZEC / XMR). On select, fetch
  `/api/operator/market?algo=...` with the Bearer token.
- Header: market stats (available rigs, available hash, lowest USD/GH·day)
  plus the coin price + trend row (`price_trend`: price, 24h, 7d with
  up/down arrows — green when positive, red when negative).
- Best-value callout: "⭐ Best value: {rig name} — {reason}" where the reason
  cites the P/L numbers (net/day at current price + break-even price).
- Table columns: rig name, hashrate, USD/hour, USD/day cost, **net $/day
  (delivery-adjusted P/L at current price, green/red)**, break-even price,
  min hours, extensions, RPI, region, and a **"Rent"** button per available
  rig.
- Expandable per-rig "P/L scenarios" row: shows the arithmetic
  (`revenue = {ghs} × {anchor} = {coin}/day × ${price} = ${rev}/day −
  ${cost}/day = ${net}/day`), the ±10%/±25% scenario nets, and the
  per-length table (min_hours / 24h / 48h / 72h: total cost, expected value,
  net).
- All prices in USD. No USDC anywhere in this panel.
- Rent flow: click → prompt/confirm length (default = rig min hours, max 72)
  → POST `/api/operator/order` → show "Order placed (pending)" with the order
  id; disabled while pending; poll `/api/operator/orders` or refresh on
  interval to show PLACED/FAILED.
- All prices in USD (cents, e.g. `$0.88/day`). No USDC anywhere in this panel.
- Follow the existing component style (see MiningRoomCard.jsx / GamePanel.jsx,
  CSS in index.css with BEM-ish classes, dark theme vars).

## Constraints

- **One migration only: 024_operator_orders.sql (approved — spec above).**
  Do NOT touch migrations 001–023 or any other table. Do NOT overload
  existing hashrate_orders columns. No new npm dependencies. No randomness.
  No fabricated numbers — every figure comes from the live MRR API, the price
  oracle, and the observed-production anchors.
- Do NOT touch: player USDC purchase flow (upgradeRig/buySession), rewards,
  deposits, withdrawals, the game (023), auth, migrations 001–023.
- Keep the full test suite green (currently 161 tests) + `npm run build` +
  `git diff --check`. Add tests for the operator gate (403 without
  OPERATOR_WALLET / wrong wallet), the market ranking logic (pure function:
  filters + usd_per_ghs_day sort + best-value pick), **the P/L scenario math
  (pure function: anchor scaling → revenue_day, net_day, ±10/±25 scenarios,
  break-even price = spot × cost/revenue, per-length totals — assert exact
  numbers for a KAS 200 GH/s rig: 1.3832 KAS/day × spot, and a ZEC z9-class
  rig at the 57%-delivery anchor)**, and the order insert + worker exact-rig
  path (PENDING row with requested_rig_id/pool_profile_id/requested_length_hours,
  no USDC debit, `placeHashpowerOrder` override places `PUT /rental` with the
  EXACT rig id when requested_rig_id is set and falls back to the budget flow
  when NULL — both mocked).
- Do NOT commit, do NOT deploy, do NOT restart anything.

## Operator note (paste-ready for Kevin)

After review + deploy, set `OPERATOR_WALLET=0x181a33d257e4d660144c0ac5ac0754fe00f0e28d`
(and optionally `VITE_OPERATOR_WALLET` for the frontend build) in the droplet
.env, rebuild the frontend, restart nexus.service. The Market panel then
appears only on the operator's wallet login. Operator rents are charged
directly to the MRR BTC balance (no USDC), with USD display.
