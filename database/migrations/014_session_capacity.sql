-- 014_session_capacity.sql — Nexus HYBRID session model (2026-08-20, Kevin's call).
--
-- Model: short sessions (1h-24h) are slices of the room's REAL running
-- hashrate (operator-funded rigs) — no new marketplace rental per purchase.
-- 72h purchases still fund a brand-new MRR rig (buyer's payment covers it).
--
-- Fair-slice payout requires a REAL hashrate denominator: every payout splits
-- the pool by (session/credit hash-hours) / (real rig hash-hours), and the
-- platform keeps the residual (unsold capacity + operator baseline). To do
-- that we must record what the room ACTUALLY delivered over the payout
-- period — a snapshot of the pool wallet's reported hashrate, logged on each
-- backing refresh and before each distribution.

CREATE TABLE IF NOT EXISTS real_rig_hashrate_history (
  id BIGSERIAL PRIMARY KEY,
  target_pool VARCHAR(16) NOT NULL,
  changed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  hashrate DOUBLE PRECISION NOT NULL,
  unit VARCHAR(8) NOT NULL DEFAULT 'GH/s'
);

CREATE INDEX IF NOT EXISTS idx_real_hash_history_pool_time
  ON real_rig_hashrate_history (target_pool, changed_at);

-- Room capacity ledger semantics (documented here for the ops skill):
--   real   = latest real_rig_hashrate_history row (pool wallet reported)
--   credit = SUM(virtual_rigs.virtual_hashrate) WHERE rental_expires_at > now()
--   spare  = real - credit   (short sessions may be sold only up to spare)
-- The operator's own rig (admin baseline) is part of credit, so it is
-- automatically protected from overselling.
