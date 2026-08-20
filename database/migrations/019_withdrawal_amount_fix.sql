-- 019_withdrawal_amount_fix.sql
-- Coin withdrawals no longer require the legacy USDC amount, and each held
-- reward row records the exact coin amount allocated to a withdrawal.

ALTER TABLE IF EXISTS withdrawal_requests
  ALTER COLUMN amount_usdc DROP NOT NULL,
  ALTER COLUMN amount_coin SET NOT NULL;

CREATE TABLE IF NOT EXISTS withdrawal_allocations (
  allocation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  withdrawal_id UUID NOT NULL REFERENCES withdrawal_requests(withdrawal_id) ON DELETE CASCADE,
  ledger_id UUID NOT NULL REFERENCES user_rewards_ledger(ledger_id) ON DELETE CASCADE,
  amount_coin NUMERIC(20, 8) NOT NULL,
  UNIQUE (withdrawal_id, ledger_id)
);

ALTER TABLE IF EXISTS protocol_revenue_ledger
  ADD COLUMN IF NOT EXISTS amount_coin NUMERIC(20, 8),
  ADD COLUMN IF NOT EXISTS coin_symbol VARCHAR(20),
  ADD COLUMN IF NOT EXISTS price_snapshot_usd NUMERIC(20, 8);
