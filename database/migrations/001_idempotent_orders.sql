-- Migration 001: idempotency + audit columns for hashrate_orders.
-- Safe to run on existing databases (IF NOT EXISTS). For fresh installs, init.sql
-- already contains these columns.

ALTER TABLE hashrate_orders ADD COLUMN IF NOT EXISTS request_id VARCHAR(64);
ALTER TABLE hashrate_orders ADD COLUMN IF NOT EXISTS price_feed VARCHAR(100);
ALTER TABLE hashrate_orders ADD COLUMN IF NOT EXISTS price_is_usdc_pair BOOLEAN;
ALTER TABLE hashrate_orders ADD COLUMN IF NOT EXISTS failure_reason TEXT;
ALTER TABLE hashrate_orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX IF NOT EXISTS idx_hashrate_orders_request_id ON hashrate_orders(request_id);
