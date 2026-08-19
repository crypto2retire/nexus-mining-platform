-- 005_payouts.sql
-- Time-weighted payout accounting: append-only log of virtual hashrate
-- changes so every pool payout is split by ACTUAL hashrate-hours contributed
-- (hashrate x time held during the payout period), not a snapshot at payout.

CREATE TABLE IF NOT EXISTS rig_hashrate_history (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    target_pool VARCHAR(50) NOT NULL,
    hashrate NUMERIC(20, 8) NOT NULL,
    changed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_rig_hist_pool ON rig_hashrate_history(target_pool, changed_at);
CREATE INDEX IF NOT EXISTS idx_rig_hist_user ON rig_hashrate_history(user_id, target_pool, changed_at);

-- Seed history from existing rigs (pre-logging backfill; none exist today).
INSERT INTO rig_hashrate_history (user_id, target_pool, hashrate, changed_at)
SELECT user_id, target_pool, virtual_hashrate, updated_at FROM virtual_rigs;

ALTER TABLE real_pool_payouts
  ADD COLUMN IF NOT EXISTS period_start TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS period_end TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS total_contribution NUMERIC(20, 8) DEFAULT 0;

ALTER TABLE user_rewards_ledger
  ADD COLUMN IF NOT EXISTS weighted_contribution NUMERIC(20, 8) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_contribution NUMERIC(20, 8) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS share_pct NUMERIC(12, 8) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS claimed_usdc NUMERIC(16, 4) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMP WITH TIME ZONE;

-- Cash-out queue: user requests USDC withdrawal from their in-game balance;
-- the operator pays from the treasury and marks the request PAID.
CREATE TABLE IF NOT EXISTS withdrawal_requests (
    withdrawal_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    amount_usdc NUMERIC(16, 4) NOT NULL,
    to_address VARCHAR(255) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING', -- PENDING | PAID | REFUNDED
    tx_hash VARCHAR(120),
    requested_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP WITH TIME ZONE
);
