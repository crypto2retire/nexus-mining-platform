-- 015_payout_balance_history.sql — "how long until payout" + pool totals.
--
-- The payout trigger already stores the latest balance per pool in
-- payout_watch. To estimate TIME-TO-PAYOUT we need the observed accrual rate,
-- so every check appends a snapshot here (10-min cadence; ~144 rows/day/pool).
-- ETA = (pool minimum payout - current unpaid) / observed rate per day.
--
-- Units: COIN units (KAS, ZEC, XMR, LTC, DOGE), NOT atoms. 2Miners balances
-- are normalized /1e8 in the trigger; herominers /1e12; Blockcypher /1e8.

CREATE TABLE IF NOT EXISTS payout_balance_history (
  id BIGSERIAL PRIMARY KEY,
  pool VARCHAR(50) NOT NULL,
  balance NUMERIC(30, 12) NOT NULL,
  checked_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_balance_history_pool_time
  ON payout_balance_history (pool, checked_at);

-- Backfill a starting point from the current watch baselines so the ETA
-- doesn't wait for the first accrual window.
INSERT INTO payout_balance_history (pool, balance, checked_at)
  SELECT pool, last_balance, last_checked_at
    FROM payout_watch
   WHERE last_balance IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM payout_balance_history h WHERE h.pool = payout_watch.pool
     );
