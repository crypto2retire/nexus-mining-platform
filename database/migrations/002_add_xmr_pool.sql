-- Migration 002: add Monero (XMR) as a self-mined pool.
-- XMR rigs are fed by real hardware the operator owns (no NiceHash order),
-- so upgrades for XMR are free (notional) and recorded as SELF_MINING.

ALTER TABLE virtual_rigs DROP CONSTRAINT IF EXISTS virtual_rigs_target_pool_check;
ALTER TABLE virtual_rigs ADD CONSTRAINT virtual_rigs_target_pool_check
    CHECK (target_pool IN ('ZCASH', 'KASPA', 'LTC_DOGE', 'XMR'));

ALTER TABLE hashrate_orders DROP CONSTRAINT IF EXISTS hashrate_orders_target_pool_check;
ALTER TABLE hashrate_orders ADD CONSTRAINT hashrate_orders_target_pool_check
    CHECK (target_pool IN ('ZCASH', 'KASPA', 'LTC_DOGE', 'XMR'));
