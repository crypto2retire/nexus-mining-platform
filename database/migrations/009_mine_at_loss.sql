-- 009_mine_at_loss.sql
-- GoMiner opt-in: a user may explicitly OK mining at a loss.
--
-- Default (mine_at_loss = FALSE): a payout that can't cover the miner's
-- maintenance → DORMANT (auto-pause protects the user — no money lost).
--
-- mine_at_loss = TRUE: the user has explicitly accepted the loss. The
-- maintenance shortfall is charged to the user's USDC balance (real money,
-- exactly what "OK the loss" means). If the USDC balance can't cover the
-- shortfall, the miner still goes DORMANT — the platform never fronts
-- ongoing mining costs, and the user can never go negative.

ALTER TABLE virtual_rigs
  ADD COLUMN IF NOT EXISTS mine_at_loss BOOLEAN NOT NULL DEFAULT FALSE;

-- Audit: where each maintenance deduction came from.
--   'PAYOUT' = deducted from the mined payout (normal case)
--   'USDC'   = user OK'd mining at a loss; shortfall charged to USDC balance
ALTER TABLE maintenance_fee_ledger
  ADD COLUMN IF NOT EXISTS source VARCHAR(10) NOT NULL DEFAULT 'PAYOUT';
