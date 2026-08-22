-- Direct-to-wallet Connect orders. Additive and idempotent.
CREATE TABLE IF NOT EXISTS connect_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  request_id VARCHAR(64) UNIQUE NOT NULL,
  target_pool VARCHAR(50) NOT NULL
    CHECK (target_pool IN ('KASPA', 'ZCASH', 'BTC')),
  payout_address VARCHAR(255) NOT NULL,
  rig_id VARCHAR(64) NOT NULL,
  rig_name VARCHAR(255) NOT NULL,
  rig_hashrate_nice VARCHAR(64) NOT NULL,
  length_hours INT NOT NULL
    CHECK (length_hours IN (1, 3, 6, 12, 24, 48, 72)),
  rental_cost_btc NUMERIC(20, 10) NOT NULL,
  btc_spot_price NUMERIC(20, 10) NOT NULL,
  rental_cost_usd NUMERIC(20, 4) NOT NULL,
  fee_pct NUMERIC(5, 2) NOT NULL DEFAULT 5.00,
  fee_usd NUMERIC(20, 4) NOT NULL,
  total_usd NUMERIC(20, 4) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'PENDING_RENT'
    CHECK (status IN (
      'PENDING_RENT', 'RENTING', 'POOL_POINTED', 'ACTIVE', 'COMPLETED',
      'FAILED', 'FAILED_REVIEW', 'REFUNDED'
    )),
  failure_reason TEXT,
  mrr_rental_id VARCHAR(64),
  rental_ends_at TIMESTAMPTZ,
  hashrate_confirmed_at TIMESTAMPTZ,
  unpaid_last NUMERIC(20, 10),
  unpaid_checked_at TIMESTAMPTZ,
  paid_out_at TIMESTAMPTZ,
  pool_stats_url TEXT,
  rent_attempts INT NOT NULL DEFAULT 0,
  processing_lease_until TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_connect_orders_user
  ON connect_orders(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_connect_orders_status
  ON connect_orders(status);

ALTER TABLE protocol_revenue_ledger
  ADD COLUMN IF NOT EXISTS connect_order_id UUID REFERENCES connect_orders(id);

CREATE INDEX IF NOT EXISTS idx_protocol_revenue_connect_order
  ON protocol_revenue_ledger(connect_order_id)
  WHERE connect_order_id IS NOT NULL;
