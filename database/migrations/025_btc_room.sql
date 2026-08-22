-- Add BTC as a live room while retaining XMR as a historical target_pool.
-- Additive/idempotent migration: no rows or prior migrations are changed.

ALTER TABLE hashrate_orders
  DROP CONSTRAINT IF EXISTS hashrate_orders_target_pool_check;
ALTER TABLE hashrate_orders
  ADD CONSTRAINT hashrate_orders_target_pool_check
  CHECK (target_pool::text = ANY (ARRAY['ZCASH','KASPA','LTC_DOGE','XMR','BTC']::text[]));

ALTER TABLE rig_rentals
  DROP CONSTRAINT IF EXISTS rig_rentals_target_pool_check;
ALTER TABLE rig_rentals
  ADD CONSTRAINT rig_rentals_target_pool_check
  CHECK (target_pool::text = ANY (ARRAY['ZCASH','KASPA','LTC_DOGE','XMR','BTC']::text[]));

ALTER TABLE virtual_rigs
  DROP CONSTRAINT IF EXISTS virtual_rigs_target_pool_check;
ALTER TABLE virtual_rigs
  ADD CONSTRAINT virtual_rigs_target_pool_check
  CHECK (target_pool::text = ANY (ARRAY['ZCASH','KASPA','LTC_DOGE','XMR','BTC']::text[]));
