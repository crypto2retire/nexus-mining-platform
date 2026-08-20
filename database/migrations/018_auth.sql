-- 018_auth.sql — one-time wallet-signature challenges.
-- Safe to run repeatedly.

CREATE TABLE IF NOT EXISTS auth_nonces (
  nonce_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address VARCHAR(255) NOT NULL,
  nonce VARCHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_auth_nonces_wallet
  ON auth_nonces(wallet_address);

CREATE INDEX IF NOT EXISTS idx_auth_nonces_expires
  ON auth_nonces(expires_at);
