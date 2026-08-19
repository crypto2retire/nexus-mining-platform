-- 011_doge_merged.sql
-- Merged-mining DOGE capture for the LTC_DOGE pool.
--
-- F2Pool pays LTC and merged DOGE separately (wallet addresses bound in the
-- F2Pool account). DOGE arrivals get distributed pro-rata the same way as LTC
-- but tracked in a second reward column so units never mix:
--   user_rewards_ledger.calculated_reward_1 = LTC units (existing)
--   user_rewards_ledger.calculated_reward_2 = DOGE units (new)
--   real_pool_payouts.total_crypto_reward_1  = LTC (existing)
--   real_pool_payouts.total_crypto_reward_2  = DOGE (new)

ALTER TABLE user_rewards_ledger
  ADD COLUMN IF NOT EXISTS calculated_reward_2 NUMERIC(20, 8) NOT NULL DEFAULT 0;

ALTER TABLE real_pool_payouts
  ADD COLUMN IF NOT EXISTS total_crypto_reward_2 NUMERIC(20, 8) NOT NULL DEFAULT 0;
