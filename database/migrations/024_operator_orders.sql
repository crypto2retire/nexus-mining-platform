ALTER TABLE hashrate_orders
  ADD COLUMN IF NOT EXISTS requested_rig_id VARCHAR(50),
  ADD COLUMN IF NOT EXISTS pool_profile_id VARCHAR(20),
  ADD COLUMN IF NOT EXISTS requested_length_hours INT;

CREATE INDEX IF NOT EXISTS idx_hashrate_orders_requested_rig
  ON hashrate_orders (requested_rig_id);
