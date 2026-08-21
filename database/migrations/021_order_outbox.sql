ALTER TABLE hashrate_orders
  ADD COLUMN IF NOT EXISTS outbox_state VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS processing_lease_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS prior_rig_level INT,
  ADD COLUMN IF NOT EXISTS prior_rig_hashrate NUMERIC(20,8),
  ADD COLUMN IF NOT EXISTS prior_rental_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS prior_rental_starts_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_rig BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS renewal BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS requested_rig_level INT,
  ADD COLUMN IF NOT EXISTS requested_rig_hashrate NUMERIC(20,8);

CREATE INDEX IF NOT EXISTS idx_hashrate_orders_outbox
  ON hashrate_orders (outbox_state, processing_lease_until);

-- SELF_MINING rows (admin baseline, $0, no marketplace) are never placed by
-- the outbox worker — reconcile them so a zero-cost order cannot be claimed
-- and sent to the marketplace after deploy.
UPDATE hashrate_orders
   SET outbox_state = CASE
     WHEN status IN ('PLACED', 'SIMULATED', 'SELF_MINING') THEN 'RECONCILED'
     WHEN status IN ('FAILED', 'REFUNDED') THEN 'FAILED'
     ELSE 'PENDING'
   END
WHERE outbox_state = 'PENDING'
  AND status <> 'PENDING';
