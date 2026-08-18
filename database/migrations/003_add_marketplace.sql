-- 003_add_marketplace.sql
-- Records which hashrate marketplace placed each order (audit trail).
-- 'NICEHASH' (default) | 'MRR' | 'SELF-MINED'
ALTER TABLE hashrate_orders ADD COLUMN IF NOT EXISTS marketplace VARCHAR(20) NOT NULL DEFAULT 'NICEHASH';
