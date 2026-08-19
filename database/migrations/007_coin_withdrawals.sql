-- 007_coin_withdrawals.sql
-- Withdrawals are paid in the MINED TOKEN the user earned (not USDC).
-- withdrawal_requests gains the coin + amount; ledger rows being withdrawn
-- are linked to the request so they can't be double-claimed/double-withdrawn.
ALTER TABLE withdrawal_requests
  ADD COLUMN IF NOT EXISTS target_pool VARCHAR(20),
  ADD COLUMN IF NOT EXISTS amount_coin NUMERIC(20, 8);

ALTER TABLE user_rewards_ledger
  ADD COLUMN IF NOT EXISTS withdrawal_id UUID REFERENCES withdrawal_requests(withdrawal_id);

CREATE INDEX IF NOT EXISTS idx_ledger_withdrawal ON user_rewards_ledger(withdrawal_id)
  WHERE withdrawal_id IS NOT NULL;
