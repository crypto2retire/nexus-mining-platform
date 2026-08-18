# Nexus Virtual Cloud Mining Engine

A Virtual Multi-Coin Cloud Mining App & Yield Dashboard built with **React (Vite)**, **Express.js**, and **PostgreSQL**, wired to the **NiceHash Hashrate Marketplace API** for real hash power purchases.

## Marketplace providers

Upgrade orders are placed through one provider at a time, chosen by `MARKETPLACE_PROVIDER`:

- `nicehash` (default) — NiceHash API v2 (HMAC-SHA256). Requires `NICEHASH_API_KEY`/`NICEHASH_API_SECRET`/`NICEHASH_ORG_ID`/`NICEHASH_POOL_ID` + `NICEHASH_LIVE_ORDERS=1` in production; free testnet via `NICEHASH_ENV=test`. Marketplace minimum ≈ 0.001 BTC (~$64) for ZHASH/KHEAVYHASH/SCRYPT.
- `mrr` — MiningRigRentals API v2 (HMAC-SHA1). Requires `MRR_API_KEY`/`MRR_API_SECRET` + `MRR_LIVE_ORDERS=1` in production (no testnet). Create one pool profile per algorithm in the MRR account and set `MRR_POOL_PROFILE_ZHASH`/`MRR_POOL_PROFILE_KHEAVYHASH`/`MRR_POOL_PROFILE_SCRYPT`. Minimum rentals are far lower (zhash ≈ $3.40, scrypt ≈ $8–10, kheavyhash ≈ $54 — verified 2026-08-18).

Both providers share one safety model: in development orders are SIMULATED; in
production, funds are never moved unless the provider is explicitly enabled.

## The Upgrade Loop (fully automated)

```
User clicks "Upgrade Rig" (React UI)
        │  sends wallet + target_pool + request_id (idempotency key)
        ▼
POST /api/rigs/upgrade
        │
        ├─ 1. priceOracle fetches live BTC/USDC spot
        │     (true USDC pairs first: Coinbase BTC-USDC, Kraken XBT/USDC;
        │      USD proxies as fallbacks; 30s TTL cache; feed recorded in audit row)
        │
        ├─ 2. Server converts: upgrade fee (USDC) − 5% protocol fee → BTC amount
        │
        ├─ 3. DB transaction (row-locked): deduct USDC, book 5% fee as revenue,
        │     insert hashrate_orders row (status PENDING, request_id UNIQUE)
        │     ── COMMIT ──
        │
        ├─ 4. placeHashpowerOrder(): real-time order on NiceHash
        │     (POST /main/api/v2/hashpower/order/ — HMAC-SHA256 signed,
        │      limits validated live from /mining/algorithms + /public/buy/info)
        │
        ├─ 5a. Success → status PLACED (live) or SIMULATED (sandbox), order id stored
        │
        └─ 5b. Failure → user AUTO-REFUNDED, row marked REFUNDED with reason
```

Order placement happens **after** the DB commit: a failed commit can never leave a
live order unrecorded, and a failed order can never corrupt the transaction (the
user is compensated instead).

## Safety rails (real money protection)

Live orders move real BTC, so **all** of these must hold before a real order is placed:

1. `NODE_ENV=production`
2. `NICEHASH_API_KEY`, `NICEHASH_API_SECRET`, `NICEHASH_ORG_ID` set
3. `NICEHASH_LIVE_ORDERS=1` (explicit opt-in)
4. `NICEHASH_POOL_ID` set (pool registered under your NiceHash org)
5. Spend ≥ marketplace minimum order amount (0.001 BTC for all current algorithms)

If any is missing, the API refuses (`503` at the controller / `success:false` at the
client) — **never** a silent simulation that charges users. In development
(`NODE_ENV != production`) orders are simulated and labeled `SIMULATED` / `sandbox:true`.

**Live minimums (verified 2026-08-18):** all three algorithms require a 0.001 BTC
minimum order (~$64 at current prices). With the 5% fee, only upgrades whose net
conversion clears 0.001 BTC can place real orders — today that means **tiers 3+**
($120+). Below-minimum upgrades are rejected in production with a clear error and
the user is auto-refunded. Recheck via the API rather than assuming:

```bash
curl "https://api2.nicehash.com/main/api/v2/mining/algorithms"
```

## Idempotency

Every upgrade must send a `request_id` (the UI generates `crypto.randomUUID()` per
click). A repeated `request_id` returns the stored order (`duplicated: true`) with
**no second charge** — double-clicks and network retries can never double-order.

## Quick Start

1. Copy `.env.example` to `.env` and fill in real values.
2. Run `database/init.sql` against PostgreSQL. **Existing databases:** run
   `database/migrations/001_idempotent_orders.sql` first.
3. Install dependencies: `npm run install:all`
4. Start dev: `npm run dev`
5. Tests: `npm test` (21 tests: oracle fallback/cache, HMAC signature, sandbox/live
   gating, controller happy path, refund, idempotency, production guard)

## Environment Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `BASE_RPC_URL` | Base mainnet RPC endpoint (deposit listener) |
| `PLATFORM_TREASURY_WALLET` | USDC receiving treasury wallet |
| `INTERNAL_SECRET_API_KEY` | Secret for reward webhook |
| `NICEHASH_API_KEY` / `NICEHASH_API_SECRET` / `NICEHASH_ORG_ID` | NiceHash API credentials (order permission) |
| `NICEHASH_POOL_ID` | Pool registered under your NiceHash org (required for live orders) |
| `NICEHASH_LIVE_ORDERS` | `1` to enable real order placement (with all other guards) |
| `NICEHASH_MARKET` | Marketplace region: `EU` (default) or `USA` |
| `NICEHASH_ORDER_PRICE` / `NICEHASH_ORDER_LIMIT` | Optional overrides; defaults from live marketplace limits |
| `PRICE_CACHE_TTL_MS` | BTC/USDC oracle cache TTL (default 30000) |
| `PORT` | Backend port (default 3000) |

## API Endpoints

- `GET /api/dashboard?wallet=0x...` — user dashboard
- `POST /api/rigs/upgrade` — upgrade rig; body `{ wallet, target_pool, request_id }`
- `POST /api/rewards/webhook` — external payout webhook (X-API-Secret protected)
- `GET /api/miner/status` — live local miner stats (proxies XMRIG_API_URL, default local XMRig :8080)

## NiceHash setup (one-time, before going live)

1. Register your organization (KYB verification) at nicehash.com.
2. Settings → API Keys → create a key with **Order** permission. Copy key/secret/org-id.
3. Register the mining pool you will mine to (Hashrate Marketplace → Your Pools).
   Copy the `poolId` into `NICEHASH_POOL_ID`.
4. Keep `NICEHASH_LIVE_ORDERS=0` while testing, then flip to `1`.

Alternative: **Business Orders** (`POST /main/api/v2/hashpower/business/order`,
`subType: BUSINESS_FIXED_SPEED`) give priority delivery and fixed-speed windows for
verified organizations — see the NiceHash Business Orders guide.

## Financial accounting notes

- `protocol_revenue_ledger` records **only the 5% protocol fee** per upgrade. The
  other 95% is pass-through to the NiceHash marketplace, not platform revenue.
- Every order row records: request_id, USDC cost, fee, BTC spent, spot price,
  price feed (and whether it was a true USDC pair), NiceHash order id, status.
- Status flow: `PENDING → PLACED | SIMULATED | REFUNDED` (REFUNDED rows carry the
  failure reason and a compensating balance credit).

## Hosting warning

**Railway's Acceptable Use Policy prohibits cryptocurrency mining and reselling
compute** — a cloud-mining front end is a permanent-ban risk there. Deploy this on
a host that permits it (e.g., a plain VPS/droplet) or use Railway only for the
non-mining app surfaces after confirming policy.

## Deployment

Built for Node 18+. `npm run build` (frontend) + `npm start` (backend). Push to
GitHub and connect to your host; set env vars; run `database/init.sql`.
