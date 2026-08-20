-- 016_room_accrual.sql — daily accrual payouts (Kevin 2026-08-20).
--
-- Business problem: a 72h rental waits ~27 days for the pool's 50 KAS
-- minimum to settle (2Miners allowedMinPayout = 5e9 atoms = 50 KAS is a hard
-- floor — verified via the accounts API). Nobody plays that.
--
-- Fix: the game distributes the room's ACTUAL accrued production every
-- accrual interval (default 6h), independent of pool settlement. Users see
-- yield grow daily and can claim/withdraw immediately (USDC path); the
-- platform float is structurally bounded by the unsettled unpaid balance
-- (95% of it at most), and the pool's eventual payout reimburses the
-- treasury. Pool-payment events stop crediting users (the accrual runs
-- already did) and only record the settlement basis.
--
-- room_accrual.earned_total = the room's CUMULATIVE real production:
--     earned_total = current pool unpaid + SUM(pool-payment rows)
--   (unpaid resets when the pool pays, so summing both keeps E continuous).
-- Each run distributes delta = earned_total_now - earned_total_last.
-- real_pool_payouts gains a source column: 'POOL_PAYMENT' rows are the
-- settlement basis (count toward E); 'ACCRUAL' rows are in-game
-- distributions (do NOT count toward E — they ARE the deltas).

CREATE TABLE IF NOT EXISTS room_accrual (
  pool VARCHAR(50) PRIMARY KEY,
  earned_total NUMERIC(30, 12) NOT NULL DEFAULT 0,
  last_distributed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE real_pool_payouts
  ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'POOL_PAYMENT';

CREATE INDEX IF NOT EXISTS idx_pool_payouts_source
  ON real_pool_payouts (target_pool, source);

-- Seed from current state: unpaid (payout_watch.last_balance) + every pool
-- payment ever received (real_pool_payouts where source='POOL_PAYMENT').
INSERT INTO room_accrual (pool, earned_total, last_distributed_at)
SELECT
  w.pool,
  COALESCE((SELECT SUM(rp.total_crypto_reward_1)
              FROM real_pool_payouts rp
             WHERE rp.target_pool = w.pool
               AND rp.source = 'POOL_PAYMENT'), 0)
    + COALESCE(w.last_balance, 0),
  COALESCE(w.last_checked_at, CURRENT_TIMESTAMP)
FROM payout_watch w
ON CONFLICT (pool) DO NOTHING;
