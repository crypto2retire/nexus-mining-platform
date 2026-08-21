-- Deterministic daily-streak and single-level referral rewards.
-- Safe to run repeatedly. No chance-based game state is stored here.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS game_streaks (
  user_id UUID PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  current_streak INT NOT NULL DEFAULT 0,
  best_streak INT NOT NULL DEFAULT 0,
  last_claim_at TIMESTAMPTZ,
  total_claims INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  CHECK (current_streak >= 0),
  CHECK (best_streak >= 0),
  CHECK (total_claims >= 0)
);

CREATE TABLE IF NOT EXISTS game_rewards_ledger (
  ledger_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  amount_usdc NUMERIC(16,4) NOT NULL CHECK (amount_usdc > 0),
  reason VARCHAR(50) NOT NULL CHECK (reason IN ('STREAK', 'REFERRAL_SIGNUP', 'REFERRAL_BONUS')),
  reference_id UUID,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS referrals (
  referral_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_wallet VARCHAR(255) NOT NULL,
  referee_wallet VARCHAR(255) NOT NULL UNIQUE,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PAID')),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_game_rewards_user
  ON game_rewards_ledger(user_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_game_rewards_reason_reference
  ON game_rewards_ledger(reason, reference_id)
  WHERE reference_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_referrals_referrer_wallet
  ON referrals(LOWER(referrer_wallet));

-- Migrations run as the postgres superuser, but the app connects as the
-- `nexus` role. Align ownership with the rest of the schema (all tables are
-- owned by nexus) so the game routes do not hit permission denied.
ALTER TABLE IF EXISTS game_streaks OWNER TO nexus;
ALTER TABLE IF EXISTS game_rewards_ledger OWNER TO nexus;
ALTER TABLE IF EXISTS referrals OWNER TO nexus;
