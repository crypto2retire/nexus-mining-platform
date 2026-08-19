-- 004_add_rig_verification.sql
-- Records which marketplace rig each live order rented (audit trail for
-- verifying rented hashpower actually delivers). Populated on live placement.
ALTER TABLE hashrate_orders
  ADD COLUMN IF NOT EXISTS rig_name VARCHAR(200),
  ADD COLUMN IF NOT EXISTS rig_rpi VARCHAR(20),
  ADD COLUMN IF NOT EXISTS rig_hours INT;
