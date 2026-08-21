CREATE TABLE IF NOT EXISTS capacity_slices (
  slice_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  target_pool VARCHAR(50) NOT NULL,
  virtual_hashrate NUMERIC(20,8) NOT NULL,
  source VARCHAR(20) NOT NULL CHECK (source IN ('RENTAL', 'SESSION')),
  starts_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_capacity_slices_user_pool
  ON capacity_slices (user_id, target_pool);
CREATE INDEX IF NOT EXISTS idx_capacity_slices_pool_expiry
  ON capacity_slices (target_pool, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_capacity_slices_one_rental
  ON capacity_slices (user_id, target_pool) WHERE source = 'RENTAL';

INSERT INTO capacity_slices
  (user_id, target_pool, virtual_hashrate, source, starts_at, expires_at)
SELECT r.user_id, r.target_pool, r.virtual_hashrate, 'RENTAL',
       COALESCE(r.created_at, CURRENT_TIMESTAMP), r.rental_expires_at
  FROM virtual_rigs r
 WHERE r.rental_expires_at IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM capacity_slices s
      WHERE s.user_id = r.user_id
        AND s.target_pool = r.target_pool
        AND s.source = 'RENTAL'
   );
