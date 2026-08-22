# Codex Prompt: Player Dashboard — Past Payouts Section

> Paste the block below into Codex. Work in the local repo:
> `/Users/cleartheclutter/dev/nexus-mining-platform`. Do NOT commit. Do NOT
> deploy — the operator reviews and deploys after.

---

## Task

Add a **"Past payouts"** section to the player dashboard so every logged-in
user sees their payout history. The dashboard already shows: the Daily Game
panel, the room cards (active miners, current hash rate, pool threshold,
"≈ days to payout" ETA, pending yield). This task adds the missing piece:
a per-user history of payouts received.

## Backend changes

### `backend/controllers/dashboardController.js`
The existing GET /api/dashboard endpoint (public read-only, `?wallet=`)
already returns per-room data. ADD a `payout_history` array to its response:

- Source of truth: `user_rewards_ledger` (per-user payout rows written by
  `backend/services/rewardDistributor.js` — user_id, payout_id,
  calculated_reward_1, calculated_reward_2, protocol_fee_taken, status
  (UNCLAIMED/CLAIMED), created_at if the column exists — check the migration
  files 001-005 for the exact columns; use what is actually there).
- Query: last 20 rows for the wallet's user_id, joined to
  `real_pool_payouts` (via payout_id) for the room/pool name
  (`target_pool`), coin symbol, and paid_at. Order by most recent.
- ALSO include the user's game rewards: `game_rewards_ledger`
  (reason STREAK / REFERRAL_BONUS, amount_usdc, created_at) — these are
  USDC-denominated; include them in the same list with `kind: 'game'` vs
  `kind: 'mining'`.
- Return shape per row:
  `{ kind: 'mining'|'game', date (ISO), pool (e.g. 'KASPA') or null for
    game, amount (string, coin units for mining / USDC for game), symbol
    (e.g. 'KAS', 'USDC'), status }`.
- Resolve the wallet→user_id the same way the existing endpoint does
  (LOWER(wallet_address) lookup). Unknown wallet → empty array (do not 404
  the whole dashboard).

### `backend/tests/`
Add tests for the payout_history query: mock `pool.query` per the existing
test style (see dashboard tests if present, else backingMonitor.test.js
style): empty history, mining rows joined to pools, game rows included,
correct ordering/limit.

## Frontend changes

### `frontend/src/App.jsx` + new component `frontend/src/components/PayoutHistory.jsx`
- New section below the room cards, above the footer: "Past payouts".
- Render a compact table/list from `data.payout_history`: date, room/game,
  amount (with symbol), status. Empty state: "No payouts yet — your mining
  rewards and game rewards will appear here."
- Style consistent with existing components (index.css vars, muted text for
  dates, small table). Keep it light — no charts, no pagination beyond the
  server-side 20-row limit.

## Constraints

- No migrations (user_rewards_ledger and game_rewards_ledger already exist).
  No new dependencies. No randomness. No fabricated numbers — show exactly
  what the ledger says.
- Do NOT touch: purchases, deposits, withdrawals, the game logic, the
  operator flow, auth, migrations 001–023.
- Keep the full test suite green (currently 173 tests — 19 suites) + `npm run build` +
  `git diff --check`.
- Do NOT commit, do NOT deploy.
