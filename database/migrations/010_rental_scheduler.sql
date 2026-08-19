-- 010_rental_scheduler.sql
-- Rental scheduler ledger: every REAL MRR rental placed for a virtual rig.
--
-- The go-miner loop: a rig's collected maintenance (maintenance_fee_ledger)
-- funds its NEXT real rental. rig_rentals is the audit trail that ties
-- "maintenance collected" -> "real hashrate rented" -> "mined coins paid out",
-- and lets the scheduler know what currently backs each virtual rig.
--
-- funded_from:
--   'POOL' = paid from the rig's own collected maintenance (default)
--   'USDC' = user explicitly OK'd mining at a loss; paid from their USDC balance

CREATE TABLE IF NOT EXISTS rig_rentals (
  id             SERIAL PRIMARY KEY,
  user_id        UUID REFERENCES users(user_id) ON DELETE CASCADE,
  rig_id         UUID REFERENCES virtual_rigs(rig_id) ON DELETE CASCADE,
  target_pool    VARCHAR(50) NOT NULL CHECK (target_pool IN ('ZCASH', 'KASPA', 'LTC_DOGE')),
  mrr_rental_id  VARCHAR(40),
  rig_name       VARCHAR(200),
  rig_rpi        NUMERIC(8, 2),
  cost_btc       NUMERIC(20, 10) NOT NULL,
  cost_usd       NUMERIC(20, 4) NOT NULL,
  length_hours   NUMERIC(8, 2) NOT NULL,
  funded_from    VARCHAR(10) NOT NULL DEFAULT 'POOL' CHECK (funded_from IN ('POOL', 'USDC')),
  status         VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ENDED')),
  started_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at       TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_rig_rentals_rig_status ON rig_rentals (rig_id, status);
CREATE INDEX IF NOT EXISTS idx_rig_rentals_status ON rig_rentals (status);
