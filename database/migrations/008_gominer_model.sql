-- 008_gominer_model.sql
-- GoMiner-style model: buying a miner includes its hashpower forever (no
-- expiry). The miner keeps mining, and ongoing maintenance + electricity are
-- deducted from each payout (like GoMiner deducts its fee from mining
-- rewards). If a payout can't cover the maintenance, the miner goes dormant
-- until the owner grows it (upgrade) or tops up (deposit).
--
-- 1. pool_maintenance_rates — per-coin maintenance fee in USDC per GH/s per
--    day, seeded from the VERIFIED real daily rental costs (2026-08-19):
--      KAS $0.15/day, XMR $0.10/day, ZEC $1.15/day, LTC $3.28/day
--    normalized to the L2 25 GH/s reference (25 GH/s is "one miner").
--    Rates are tunable by the operator; the table is the source of truth.
-- 2. virtual_rigs.maintenance_status — ACTIVE | DORMANT (GoMiner "paused").
-- 3. maintenance_fee_ledger — every maintenance deduction, auditable.
-- 4. user_rewards_ledger.maintenance_fee_1 — the portion of each payout row
--    eaten by maintenance (in the same coin unit as calculated_reward_1).
-- 5. protocol_revenue_ledger.order_id — link revenue rows to the order so a
--    refund can reverse exactly the fee that was booked (was: orphaned).

-- 1. Maintenance rates (USDC per GH/s per day), seeded from verified costs.
CREATE TABLE IF NOT EXISTS pool_maintenance_rates (
  pool VARCHAR(50) PRIMARY KEY CHECK (pool IN ('ZCASH', 'KASPA', 'LTC_DOGE', 'XMR')),
  usdc_per_ghs_per_day NUMERIC(20, 10) NOT NULL,
  note TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO pool_maintenance_rates (pool, usdc_per_ghs_per_day, note) VALUES
  ('KASPA',   0.0060,  'verified $0.15/day rental cost / 25 GH/s'),
  ('XMR',     0.0040,  'verified $0.10/day electricity (self-mined) / 25 GH/s'),
  ('ZCASH',   0.0460,  'verified $1.15/day rental cost / 25 GH/s'),
  ('LTC_DOGE', 0.1312, 'verified $3.28/day rental cost / 25 GH/s')
ON CONFLICT (pool) DO NOTHING;

-- 2. Miner lifecycle state (GoMiner pause).
ALTER TABLE virtual_rigs
  ADD COLUMN IF NOT EXISTS maintenance_status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS dormant_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_virtual_rigs_maintenance
  ON virtual_rigs (maintenance_status);

-- 3. Maintenance fee ledger — every deduction, with the exact hashrate and
--    period it covered, so the operator can audit "what was charged for what".
CREATE TABLE IF NOT EXISTS maintenance_fee_ledger (
  entry_id        SERIAL PRIMARY KEY,
  payout_id       UUID REFERENCES real_pool_payouts(payout_id),
  user_id         UUID REFERENCES users(user_id) ON DELETE CASCADE,
  target_pool     VARCHAR(50) NOT NULL,
  hashrate_ghs    NUMERIC(16, 4) NOT NULL,
  days            NUMERIC(12, 6) NOT NULL,
  amount_usdc     NUMERIC(20, 8) NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 4. Per-payout maintenance deduction (same coin unit as the reward).
ALTER TABLE user_rewards_ledger
  ADD COLUMN IF NOT EXISTS maintenance_fee_1 NUMERIC(20, 8) NOT NULL DEFAULT 0;

-- 5. Revenue rows now point at the order that generated them, so a refund
--    can reverse exactly the fee (the old refund path orphaned the fee row).
ALTER TABLE protocol_revenue_ledger
  ADD COLUMN IF NOT EXISTS order_id UUID REFERENCES hashrate_orders(order_id);
