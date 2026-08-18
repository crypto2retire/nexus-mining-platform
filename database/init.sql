CREATE TABLE users (
    user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address VARCHAR(255) UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE user_wallets (
    wallet_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    usdc_balance NUMERIC(16, 4) NOT NULL DEFAULT 0.0000,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE virtual_rigs (
    rig_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    target_pool VARCHAR(50) NOT NULL CHECK (target_pool IN ('ZCASH', 'KASPA', 'LTC_DOGE', 'XMR')),
    virtual_hashrate NUMERIC(12, 4) NOT NULL DEFAULT 0.0000,
    level INT NOT NULL DEFAULT 1,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE real_pool_payouts (
    payout_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    target_pool VARCHAR(50) NOT NULL,
    total_crypto_reward_1 NUMERIC(20, 8) NOT NULL,
    total_network_hashrate NUMERIC(16, 4) NOT NULL,
    payout_timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE user_rewards_ledger (
    ledger_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    payout_id UUID REFERENCES real_pool_payouts(payout_id),
    calculated_reward_1 NUMERIC(20, 8) NOT NULL,
    protocol_fee_taken NUMERIC(20, 8) NOT NULL,
    status VARCHAR(50) DEFAULT 'UNCLAIMED',
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE deposit_history (
    deposit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    tx_hash VARCHAR(66) UNIQUE NOT NULL,
    amount_usdc NUMERIC(16, 4) NOT NULL,
    processed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE protocol_revenue_ledger (
    revenue_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_user_id UUID REFERENCES users(user_id),
    amount_usdc NUMERIC(16, 4) NOT NULL,
    transaction_type VARCHAR(100) NOT NULL
);

-- hashrate_orders: one row per upgrade attempt.
-- request_id is the client-supplied idempotency key (unique = no double orders).
CREATE TABLE hashrate_orders (
    order_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    target_pool VARCHAR(50) NOT NULL CHECK (target_pool IN ('ZCASH', 'KASPA', 'LTC_DOGE', 'XMR')),
    request_id VARCHAR(64) UNIQUE NOT NULL,
    nicehash_order_id VARCHAR(255),
    sandbox BOOLEAN NOT NULL DEFAULT FALSE,
    usdc_cost NUMERIC(16, 4) NOT NULL,
    protocol_fee_usdc NUMERIC(16, 4) NOT NULL,
    btc_spent NUMERIC(20, 8) NOT NULL,
    btc_spot_price NUMERIC(16, 4) NOT NULL,
    price_feed VARCHAR(100),
    price_is_usdc_pair BOOLEAN,
    algorithm VARCHAR(50) NOT NULL,
    status VARCHAR(50) DEFAULT 'PENDING',   -- PENDING | PLACED | SIMULATED | FAILED | REFUNDED
    failure_reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_rigs_pool ON virtual_rigs(target_pool);
CREATE INDEX idx_rewards_user ON user_rewards_ledger(user_id);
CREATE INDEX idx_hashrate_orders_user ON hashrate_orders(user_id);
CREATE UNIQUE INDEX idx_hashrate_orders_request_id ON hashrate_orders(request_id);
