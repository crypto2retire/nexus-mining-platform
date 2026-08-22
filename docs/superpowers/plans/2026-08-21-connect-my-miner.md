# Connect My Miner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an authenticated player select a live MRR rig, pay its quoted cost plus a 5% USDC connection fee, and direct that rental to the player's own KAS, ZEC, or BTC payout address while Nexus reports connection and payout evidence.

**Architecture:** Add a feature-flagged Connect API backed by a dedicated `connect_orders` state machine. Pure pricing, validation, and pool configuration live in `connectService.js`; authenticated controllers remain thin; `connectWorker.js` alone performs MRR rental, pool switching, and public-pool observation. The React `ConnectPanel` consumes only the new API and leaves rooms, Game, and operator views unchanged.

**Tech Stack:** Node.js/CommonJS, Express, PostgreSQL transactions, Axios, Jest, React 18, Vite, plain CSS.

**Spec:** `docs/codex-prompt-rev3-connect.md`

## Global Constraints

- Feature remains off unless `ENABLE_CONNECT=1`; disabled API requests return `503 { error: 'Connect is not enabled' }`.
- Supported targets are exactly `KASPA`, `ZCASH`, and `BTC`; `LTC_DOGE` is excluded.
- The pool pays the player's supplied payout address directly; Connect must not create Nexus mining rewards or capacity.
- Charge exactly the live rental quote plus `CONNECT_FEE_PCT`, default `5`; book only the fee as protocol revenue.
- Use the existing authenticated wallet at `req.auth.wallet`; do not modify authentication.
- Do not modify rooms, Game, deposits, withdrawals, the operator order pipeline, payout trigger, or backing monitor.
- Add no npm dependencies and no random business values. `crypto.randomUUID()` is allowed only for client request idempotency and existing sandbox identifiers.
- Do not apply a migration, place a live MRR order, restart, commit, or deploy during implementation.
- Required final gates: focused Connect tests, full Jest suite, Vite production build, and `git diff --check`.

## Required Decisions Before Implementation

These are confirmed conflicts between the specification and the current repository. Do not begin Task 1 until the operator approves the recommended resolutions.

1. **Revenue-ledger foreign key.** `protocol_revenue_ledger.order_id` currently references `hashrate_orders(order_id)`. A `connect_orders.id` cannot be inserted there.
   - **Recommended resolution:** migration 026 creates `connect_orders`, then adds nullable `connect_order_id UUID REFERENCES connect_orders(id)` and an index to `protocol_revenue_ledger`; Connect leaves `order_id` null and writes `connect_order_id`.
   - **Rejected unsafe resolution:** placing a Connect UUID in `order_id`; PostgreSQL will reject it.
2. **Crash-safe external ordering.** The proposed table has no attempt counter or processing lease. A process can crash after MRR accepts a rental but before Nexus saves its rental id; blind retry can buy a second rental.
   - **Recommended resolution:** add `rent_attempts INT NOT NULL DEFAULT 0`, `processing_lease_until TIMESTAMPTZ`, and `last_attempt_at TIMESTAMPTZ` to `connect_orders`. Claim with an atomic `UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED) ... RETURNING`, cap attempts, and send a deterministic request correlation value if MRR exposes a supported idempotency field. Because the verified `PUT /rental` contract has no idempotency key, an ambiguous network result must become `FAILED_REVIEW`, not automatic retry.
   - Add `FAILED_REVIEW` to the status check so an operator resolves ambiguous real-money outcomes without a second rental.
3. **MRR cancellation.** The current MRR client documents that no cancel/refund endpoint is available, and the verified facts provide none.
   - **Recommended resolution:** do not invent a cancel call. After a confirmed pool-switch failure, refund the player's USDC, keep the recorded `mrr_rental_id`, set `REFUNDED`, and log a high-severity operator message for manual MRR handling.
4. **Concurrent-order meaning.** Interpret “max concurrent 2” as two nonterminal Connect rentals globally and “per-user limit” as one nonterminal Connect order per user. Confirm this interpretation before implementation.

## Operator Approvals (2026-08-22)

Approved before execution. Each claim was verified against the repo before
approval (order_id FK in `008_gominer_model.sql`, lease/attempt pattern in
`021_order_outbox.sql`, "no cancel/refund endpoint" note in
`mrrRenter.js:140`).

1. **Revenue-ledger FK — APPROVED.** Migration 026 adds nullable
   `protocol_revenue_ledger.connect_order_id UUID REFERENCES connect_orders(id)`
   + partial index; Connect writes `connect_order_id` and leaves `order_id`
   null.
2. **Crash-safe ordering — APPROVED.** `rent_attempts`,
   `processing_lease_until`, `last_attempt_at` on `connect_orders` +
   `FAILED_REVIEW` in the status check. An ambiguous `PUT /rental` outcome
   becomes `FAILED_REVIEW` — no blind retry, because the verified MRR contract
   has no idempotency key.
3. **No auto-cancel — APPROVED.** After a confirmed pool-switch failure: refund
   once, retain `mrr_rental_id`, mark `REFUNDED`, log a high-severity operator
   alert for manual MRR handling. No cancellation endpoint exists to call.
4. **Concurrency — APPROVED.** Two nonterminal Connect rentals globally, one
   nonterminal per user. Additionally approved: Task 2 exact-rig price ceiling
   (`maxCostBtc` = the quoted `rental_cost_btc`) — never rent above what the
   player authorized.

---

### Task 1: Add the Connect schema and disabled-by-default configuration

**Files:**
- Create: `database/migrations/026_connect_orders.sql`
- Modify: `.env.example`
- Test: `backend/tests/connectMigration.test.js`

**Interfaces:**
- Produces: `connect_orders` with the spec columns plus the approved reliability columns; `protocol_revenue_ledger.connect_order_id` if Decision 1 is approved.
- Produces: `ENABLE_CONNECT=0` and `CONNECT_FEE_PCT=5` example settings.

- [ ] **Step 1: Write a failing migration contract test**

Create `backend/tests/connectMigration.test.js` that reads the SQL file and asserts the exact table, allowed pools, allowed windows, request id uniqueness, required indexes, approved reliability columns/status, and additive revenue-ledger reference. The test must also assert that migrations 001–025 are not named by any `ALTER` statement.

```js
const fs = require('fs');
const path = require('path');

const sql = fs.readFileSync(
  path.join(__dirname, '../../database/migrations/026_connect_orders.sql'),
  'utf8'
);

test('migration 026 defines the additive Connect state machine', () => {
  expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS connect_orders/i);
  expect(sql).toMatch(/request_id VARCHAR\(64\) UNIQUE NOT NULL/i);
  expect(sql).toContain("target_pool IN ('KASPA','ZCASH','BTC')");
  expect(sql).toContain('length_hours IN (1,3,6,12,24,48,72)');
  expect(sql).toMatch(/processing_lease_until TIMESTAMPTZ/i);
  expect(sql).toMatch(/FAILED_REVIEW/);
  expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS connect_order_id UUID REFERENCES connect_orders\(id\)/i);
  expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_connect_orders_user/i);
  expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_connect_orders_status/i);
});
```

- [ ] **Step 2: Run the migration test and verify the missing file fails**

Run: `npm test -- --runInBand backend/tests/connectMigration.test.js`

Expected: FAIL because `026_connect_orders.sql` does not exist.

- [ ] **Step 3: Create migration 026**

Start with the table and two indexes in the specification. Apply only the operator-approved changes from the decision section. Every additive schema statement must use `IF NOT EXISTS`; do not alter migrations 001–025.

For Decision 1, append:

```sql
ALTER TABLE protocol_revenue_ledger
  ADD COLUMN IF NOT EXISTS connect_order_id UUID REFERENCES connect_orders(id);

CREATE INDEX IF NOT EXISTS idx_protocol_revenue_connect_order
  ON protocol_revenue_ledger(connect_order_id)
  WHERE connect_order_id IS NOT NULL;
```

For Decision 2, place these columns in `connect_orders` and include `FAILED_REVIEW` in its status constraint:

```sql
rent_attempts INT NOT NULL DEFAULT 0,
processing_lease_until TIMESTAMPTZ,
last_attempt_at TIMESTAMPTZ,
```

- [ ] **Step 4: Add disabled configuration examples**

Append to `.env.example` near the MRR configuration:

```dotenv
# Direct-to-wallet Connect flow. Keep disabled until migration 026 is applied
# and the operator has completed a low-value live smoke test.
ENABLE_CONNECT=0
CONNECT_FEE_PCT=5
```

- [ ] **Step 5: Run the migration contract test**

Run: `npm test -- --runInBand backend/tests/connectMigration.test.js`

Expected: PASS.

### Task 2: Extend the MRR client with pool switching and price protection

**Files:**
- Modify: `backend/services/mrrRenter.js`
- Modify: `backend/tests/mrrRenter.test.js`

**Interfaces:**
- Produces: `switchRentalPool(rentalId, { host, port, user, pass }) -> Promise<object>`.
- Extends: `placeHashpowerOrder(targetPool, spendBtcAmount, exactRig)` where `exactRig` contains `{ rigId, lengthHours, profileId, maxCostBtc }`.

- [ ] **Step 1: Add failing request-contract tests**

Add a test proving `switchRentalPool` sends one HMAC-authenticated request with the verified contract:

```js
test('switchRentalPool uses the verified MRR v2 pool-switch contract', async () => {
  setEnv({ NODE_ENV: 'production', LIVE_ORDERS: '1' });
  axios.mockResolvedValue({ data: { success: true, data: { id: '5701967', success: true } } });

  await switchRentalPool('5701967', {
    host: 'de.kaspa.herominers.com', port: '1207', user: 'kaspa:test', pass: 'x',
  });

  expect(axios).toHaveBeenCalledWith(expect.objectContaining({
    method: 'PUT',
    url: expect.stringEndingWith('/rental/5701967/pool'),
    data: JSON.stringify({
      host: 'de.kaspa.herominers.com', port: '1207', user: 'kaspa:test', pass: 'x',
    }),
  }));
});
```

Add exact-rig tests proving the order is rejected before `PUT /rental` when the refreshed hourly price makes `length × hourly > maxCostBtc`, and proving the verified profile and window reach the request body unchanged.

- [ ] **Step 2: Run focused MRR tests and verify failure**

Run: `npm test -- --runInBand backend/tests/mrrRenter.test.js`

Expected: FAIL because `switchRentalPool` and exact-rig price protection do not exist.

- [ ] **Step 3: Implement the helper and price ceiling**

Use the existing request primitive; validate nonempty rental id and all four pool fields before making the request.

```js
async function switchRentalPool(rentalId, { host, port, user, pass }) {
  const id = String(rentalId || '').trim();
  if (!id || !host || !port || !user || !pass) {
    throw new Error('Complete rental and pool connection values are required');
  }
  return makeMrrRequest(
    'PUT',
    `/rental/${encodeURIComponent(id)}/pool`,
    null,
    { host: String(host), port: String(port), user: String(user), pass: String(pass) }
  );
}
```

In the exact-rig branch, calculate the refreshed cost with the existing `to8(length * hourly)` rule. Return `success:false` when it exceeds a finite positive `exactRig.maxCostBtc`; do not place a higher-cost order than the player authorized.

- [ ] **Step 4: Run focused MRR tests**

Run: `npm test -- --runInBand backend/tests/mrrRenter.test.js`

Expected: PASS with all existing sandbox/live safety tests still green.

### Task 3: Implement pure Connect configuration, market, quote, and validation logic

**Files:**
- Create: `backend/services/connectService.js`
- Create: `backend/tests/connectService.test.js`

**Interfaces:**
- Produces: `POOL_CONFIG`, `TARGET_TO_ALGO`, `validatePayoutAddress(targetPool, address)`, `marketFor(algo)`, `quote({ targetPool, rigId, lengthHours })`, and `advertisedWindows(rig)`.
- `quote` returns `{ target_pool, rig, windows, rental_cost_btc, rental_cost_usd, fee_pct, fee_usd, total_usd, btc_spot_price, price_feed, price_is_usdc_pair }`.

- [ ] **Step 1: Write failing validation and pool-configuration tests**

Cover valid and invalid KASPA, ZCASH, and BTC addresses using the exact regexes from `rewardsController.js`. Assert each pool's host, port, profile, payout floor, stats URL, balance parser, hashrate parser, and public link. Assert BTC `hashOf` returns `null`.

- [ ] **Step 2: Write failing quote tests with independent arithmetic**

Mock `makeMrrRequest`, `getLiveBtcPrice`, and `getCoinMarketData`. Use fixed test inputs and independently assert:

```js
expect(result.rental_cost_btc).toBe(0.000024);
expect(result.rental_cost_usd).toBe(2.4);
expect(result.fee_pct).toBe(5);
expect(result.fee_usd).toBe(0.12);
expect(result.total_usd).toBe(2.52);
```

Test that windows are drawn only from `[1, 3, 6, 12, 24, 48, 72]`, are at least `price.BTC.min_rental_length`, and do not exceed the lower of the rig's max hours and `MRR_MAX_RENTAL_HOURS`. Test unavailable, missing, under-minimum, and BTC-disabled rigs as `409`-class service errors.

- [ ] **Step 3: Write failing market tests**

For each of `kheavyhash`, `equihash`, and `sha256`, assert `marketFor` requests `/rig?type=<algo>&limit=50`, gets live BTC and coin prices, calls the existing profitability functions, excludes unsupported `scrypt`, and returns rows sorted by `profitability.net_day` descending.

- [ ] **Step 4: Run service tests and verify failure**

Run: `npm test -- --runInBand backend/tests/connectService.test.js`

Expected: FAIL because `connectService.js` does not exist.

- [ ] **Step 5: Implement Connect errors and pure helpers**

Define a typed service error so controllers can preserve safe 4xx/5xx behavior:

```js
class ConnectError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}
```

Reuse `buildMarketView`, `calculateProfitability`, `getCoinMarketData`, `marketStatsFor`, and `getLiveBtcPrice`; do not copy production anchors or fabricate market values. Fetch the selected rig again inside `quote`, require it to remain eligible and available, and normalize money with one shared decimal helper before returning and later persisting it.

- [ ] **Step 6: Run service tests**

Run: `npm test -- --runInBand backend/tests/connectService.test.js`

Expected: PASS for all three algorithms, quote arithmetic, window filtering, and address cases.

### Task 4: Add authenticated Connect controllers and atomic USDC charging

**Files:**
- Create: `backend/controllers/connectController.js`
- Modify: `backend/services/connectService.js`
- Modify: `backend/routes/api.js`
- Create: `backend/tests/connectController.test.js`

**Interfaces:**
- Produces routes: `GET /api/connect/market`, `POST /api/connect/quote`, `POST /api/connect/order`, `GET /api/connect/orders`.
- Produces service function: `createConnectOrder({ wallet, targetPool, payoutAddress, rigId, lengthHours, requestId }) -> order`.

- [ ] **Step 1: Write failing feature-flag and auth-boundary tests**

Assert every controller returns 503 before any database or external call when `ENABLE_CONNECT !== '1'`. Route-level assertions must prove all four routes include `requireAuth` and obtain the wallet from `req.auth.wallet`, never from request JSON.

- [ ] **Step 2: Write failing transaction and idempotency tests**

Mock `pool.connect()` in the existing controller-test style. Assert one transaction performs, in order:

1. `BEGIN`.
2. Lock the user by `LOWER(wallet_address)`.
3. Check for an existing `request_id` owned by that same user.
4. Obtain the live quote before opening the transaction, then revalidate its expiry/age immediately before debit.
5. Lock `user_wallets` with `FOR UPDATE`.
6. Reject insufficient balance without inserting an order or ledger row.
7. Insert `connect_orders` with the quoted BTC/USD values.
8. Deduct `total_usd` once.
9. Insert only `fee_usd` into `protocol_revenue_ledger` as `CONNECT_FEE`, linked through the approved `connect_order_id` column.
10. `COMMIT` and return 201.

The duplicate test must call the service twice with the same request id and prove the second response returns the same user-owned order with no second debit. A collision owned by another user returns 409 and reveals no order details.

- [ ] **Step 3: Write failing input/error tests**

Cover missing/oversized request id, unsupported pool, invalid payout address, invalid window, unknown user, unavailable rig, price-feed failure, and database rollback. Controller error bodies contain one friendly `error` string and never raw Axios/database objects.

- [ ] **Step 4: Run controller tests and verify failure**

Run: `npm test -- --runInBand backend/tests/connectController.test.js`

Expected: FAIL because controllers, routes, and transaction service are absent.

- [ ] **Step 5: Implement the transaction service and thin controllers**

Keep HTTP parsing in `connectController.js`; perform the debit/order/fee mutation inside one PostgreSQL transaction in `connectService.js`. Use numeric values returned by `quote` and persist the exact snapshot. Never recompute the fee from formatted frontend strings.

Return list rows newest first with only player-facing fields:

```js
{
  id, target_pool, payout_address, rig_name, rig_hashrate_nice,
  length_hours, total_usd, status, failure_reason, mrr_rental_id,
  rental_ends_at, hashrate_confirmed_at, unpaid_last,
  unpaid_checked_at, paid_out_at, pool_stats_url, created_at
}
```

- [ ] **Step 6: Register routes behind `requireAuth`**

Add controller imports and these exact route bindings in `backend/routes/api.js`:

```js
router.get('/connect/market', requireAuth, getConnectMarket);
router.post('/connect/quote', requireAuth, getConnectQuote);
router.post('/connect/order', requireAuth, createConnectOrder);
router.get('/connect/orders', requireAuth, listConnectOrders);
```

- [ ] **Step 7: Run controller and service tests**

Run: `npm test -- --runInBand backend/tests/connectController.test.js backend/tests/connectService.test.js`

Expected: PASS with no debit or ledger write on rejected and duplicate requests.

### Task 5: Implement the dedicated Connect worker state machine

**Files:**
- Create: `backend/services/connectWorker.js`
- Modify: `backend/server.js`
- Create: `backend/tests/connectWorker.test.js`

**Interfaces:**
- Produces: `startConnectWorker()`, `runConnectWorkerOnce()`, `runConnectSweeperOnce()`, `claimNextPendingOrder()`, and testable transition helpers.
- Consumes: `placeHashpowerOrder`, `switchRentalPool`, `getOrderStatus`, `POOL_CONFIG`, and PostgreSQL `pool`.

- [ ] **Step 1: Write failing disabled/start-once tests**

Assert `startConnectWorker()` logs `connectWorker: disabled` and creates no timer unless `ENABLE_CONNECT=1`. When enabled, assert one 15-second processing interval and one 5-minute sweeper interval are created, and repeated starts do not duplicate timers.

- [ ] **Step 2: Write failing atomic-claim and concurrency tests**

Assert the claim SQL uses `FOR UPDATE SKIP LOCKED`, atomically changes one `PENDING_RENT` row to `RENTING`, increments `rent_attempts`, and sets a lease. Assert no claim occurs when two global nonterminal rentals already exist or the same user already has one nonterminal order.

- [ ] **Step 3: Write failing happy-path state tests**

With MRR and pool HTTP calls mocked, prove:

```text
PENDING_RENT -> RENTING -> POOL_POINTED -> ACTIVE -> COMPLETED
```

Assert exact rig id, quoted `rental_cost_btc` as `maxCostBtc`, length, and profile are passed to `placeHashpowerOrder`; `mrr_rental_id` and `rental_ends_at` are persisted before the pool switch; the switch uses the player's payout address and password `x`; positive KAS/ZEC pool hash sets `hashrate_confirmed_at`; positive BTC MRR average hash confirms BTC; and the final snapshot precedes `COMPLETED`.

- [ ] **Step 4: Write failing refund and ambiguous-result tests**

Assert a confirmed rental rejection restores `total_usd` exactly once and sets `REFUNDED`. Assert a confirmed pool-switch failure retries once, refunds once, retains `mrr_rental_id`, and emits the manual-action log without calling a nonexistent cancellation endpoint. Assert a timeout/connection reset after sending `PUT /rental` becomes `FAILED_REVIEW` with no automatic retry or refund until an operator determines whether MRR charged the account.

- [ ] **Step 5: Write failing observation tests**

For KAS/ZEC, persist parsed unpaid balance and hashrate from the exact pool payloads. Mark `paid_out_at` only when a previously recorded amount at or above the floor later drops. For BTC, take an initial Blockcypher balance baseline and mark `paid_out_at` only on a later increase; do not describe this as proof that a specific mining payout caused the increase.

- [ ] **Step 6: Run worker tests and verify failure**

Run: `npm test -- --runInBand backend/tests/connectWorker.test.js`

Expected: FAIL because `connectWorker.js` does not exist.

- [ ] **Step 7: Implement transitions as compare-and-set updates**

Every state write must include the expected prior status, for example:

```sql
UPDATE connect_orders
   SET status = 'POOL_POINTED', updated_at = CURRENT_TIMESTAMP
 WHERE id = $1 AND status = 'RENTING'
```

External HTTP calls occur outside open database transactions. Refunds use a transaction that locks the order and wallet, checks the order is not already terminal, restores the stored `total_usd`, and then marks `REFUNDED`.

- [ ] **Step 8: Start the worker behind the feature flag**

Import and call `startConnectWorker()` from the existing `app.listen` callback. The worker function itself owns the `ENABLE_CONNECT` check and logs enabled/disabled state.

- [ ] **Step 9: Run worker and MRR tests**

Run: `npm test -- --runInBand backend/tests/connectWorker.test.js backend/tests/mrrRenter.test.js`

Expected: PASS for state transitions, concurrency, refunds, ambiguous outcomes, and request contracts.

### Task 6: Build the authenticated Connect player interface

**Files:**
- Create: `frontend/src/components/ConnectPanel.jsx`
- Modify: `frontend/src/App.jsx`
- Modify: `frontend/src/index.css`

**Interfaces:**
- Consumes the four authenticated `/api/connect/*` routes.
- Preserves the existing `WalletAuth`, Game, MarketPanel, mining-room, and payout-history contracts.

- [ ] **Step 1: Add the signed-in navigation state in `App.jsx`**

Introduce a local view state with `dashboard` and `connect`. Render a small signed-in navigation control and mount `<ConnectPanel auth={auth} />` only when Connect is selected. Do not change session restoration or duplicate `/api/auth/me`.

- [ ] **Step 2: Implement API/error utilities and disabled state**

In `ConnectPanel.jsx`, build Bearer headers from `auth.token`. Parse JSON once; render `body.error` for safe backend errors. A 503 renders `Connect is coming soon` and stops polling until the user changes tabs or manually retries.

- [ ] **Step 3: Implement live market tabs and refresh behavior**

Use tabs exactly for KAS/KASPA→`kheavyhash`, ZEC/ZCASH→`equihash`, and BTC→`sha256`. Follow the existing MarketPanel `useCallback` + `useRef` in-flight guard pattern: initial load, silent 60-second refresh, manual refresh, cleanup on unmount, and immediate refresh after order failure.

- [ ] **Step 4: Implement the rig table and decision arithmetic**

Render Rig, Hashrate, USD/hr, Net/day, Mine vs Buy, Break-even, Min hours, RPI, Region, and Select. Values must come directly from the backend response. For single-coin targets show `Mine $X · Buy $Y · Z×`; color based on the numeric `mine_vs_buy` ratio, not formatted text.

- [ ] **Step 5: Implement selection, window, address, and quote controls**

Use only `quote.windows` for the picker. Validate addresses client-side with the same three regexes, while treating backend validation as authoritative. After every rig/window change, request a fresh quote and show:

```text
Rental $X.XX + 5% connection fee $Y.YY = $Z.ZZ
```

Also show the backend arithmetic mine-vs-buy sentence without substituting example numbers.

- [ ] **Step 6: Implement idempotent order submission**

Generate one `crypto.randomUUID()` when the user begins a submission and retain it through network retries. Clear it only after a definitive success or a definitive 4xx validation/insufficient-balance response. On success, display the pool URL returned for that order and refresh My connections.

- [ ] **Step 7: Implement My connections**

Poll `/api/connect/orders` while the panel is visible. Render the persisted status, rig, end time, unpaid amount/floor, payout badge, failure reason, and pool link. Label BTC balance changes conservatively as “balance increased” rather than guaranteed pool payout attribution.

- [ ] **Step 8: Add accessible plain CSS**

Add `.connect-*` styles using existing color variables, focus states, responsive table overflow, status chips, quote emphasis, and inline alerts. Use semantic buttons/tabs/labels and ensure the panel remains usable at narrow widths.

- [ ] **Step 9: Run the Vite build**

Run: `npm run build`

Expected: Vite exits 0 with no missing imports or JSX errors.

### Task 7: Integrated verification and operator handoff

**Files:**
- Verify all files changed in Tasks 1–6.
- Do not change source merely to hide a failed verification result.

**Interfaces:**
- Produces a review report; performs no migration, live order, restart, commit, or deployment.

- [ ] **Step 1: Run focused Connect tests**

Run:

```bash
npm test -- --runInBand \
  backend/tests/connectMigration.test.js \
  backend/tests/connectService.test.js \
  backend/tests/connectController.test.js \
  backend/tests/connectWorker.test.js \
  backend/tests/mrrRenter.test.js
```

Expected: all focused suites pass with zero failures.

- [ ] **Step 2: Run the complete backend suite**

Run: `npm test -- --runInBand`

Expected: all suites pass; report the observed count instead of assuming the historical 181-test count.

- [ ] **Step 3: Run the production frontend build**

Run: `npm run build`

Expected: Vite exits 0.

- [ ] **Step 4: Check whitespace and scope**

Run:

```bash
git diff --check
git status --short
git diff --name-only
```

Expected: no whitespace errors; only the authorized migration, Connect backend/frontend files, `.env.example`, `server.js`, `routes/api.js`, `mrrRenter.js`, and their tests appear.

- [ ] **Step 5: Perform local feature-flag checks without live MRR calls**

With `ENABLE_CONNECT=0`, verify each new route returns 503 after authentication. With test mocks and `ENABLE_CONNECT=1`, verify market, quote, order idempotency, list, worker transitions, and refund behavior. Do not set `MRR_LIVE_ORDERS=1` locally.

- [ ] **Step 6: Prepare the operator-only deployment checklist**

After code review, the operator—not the implementation agent—must:

1. Back up and validate migration 026 inside a rollback transaction against the real schema.
2. Apply migration 026 once approved.
3. Set `ENABLE_CONNECT=1` and `CONNECT_FEE_PCT=5` in the droplet environment.
4. Confirm the three verified MRR profiles still exist and point to the stated base pools.
5. Rebuild the frontend and restart through the normal deployment process.
6. Use a dedicated test wallet and the smallest MRR-valid KAS order, not a fabricated `$0.10` amount if the selected rig's real minimum is higher.
7. Observe separately: USDC debit, one fee-ledger row, one MRR rental id, successful pool switch, customer-address hashrate, and direct pool balance movement.
8. Keep `ENABLE_CONNECT=0` or disable it immediately if any one of those proofs is absent.

## Self-Review Results

- **Spec coverage:** Migration, MRR switch, market/quote logic, atomic charge, idempotency, worker states, public verification, routes, React UI, refresh behavior, configuration, focused tests, full tests, build, and operator handoff are each assigned to a task.
- **Intentional deviations requiring approval:** the plan adds ledger referential integrity and crash/lease fields, introduces `FAILED_REVIEW`, and does not invent an MRR cancellation call. These are listed as pre-implementation decisions.
- **Type consistency:** `targetPool` uses `KASPA|ZCASH|BTC`; market `algo` uses `kheavyhash|equihash|sha256`; exact-rig fields use `rigId|lengthHours|profileId|maxCostBtc` end to end.
- **Placeholder scan:** no deferred implementation placeholders are present; unresolved product decisions are explicit blocking approvals with recommended resolutions.
