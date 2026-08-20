-- 013_rental_model.sql — Nexus switches from BUY (GoMiner perpetual) to RENT.
--
-- Model change (2026-08-20, Kevin's call: "change it to rent a miner in the
-- game... I am starting to question the 'selling' something I rent"):
--
--   BEFORE: user BUYS a miner = permanent ownership; buy-in funds a maintenance
--           POOL that the scheduler re-rents from; DORMANT when the fund runs
--           dry; mine-at-loss opt-in.
--   AFTER:  user RENTS hashrate for a fixed window (72h, matches the real MRR
--           rental 1:1). Pay once -> mine for the window -> it expires.
--           Renew manually = rent again. NO maintenance fund, NO DORMANT,
--           NO mine-at-loss. The platform never promises anything it doesn't
--           actually rent.
--
-- The single source of truth for "is this rig mining right now" becomes
-- virtual_rigs.rental_expires_at (NULL = never rented / expired long ago).
-- maintenance_status is kept for display: 'ACTIVE' while inside the window,
-- 'EXPIRED' after it.

ALTER TABLE virtual_rigs
  ADD COLUMN IF NOT EXISTS rental_expires_at TIMESTAMP WITH TIME ZONE;

CREATE INDEX IF NOT EXISTS idx_rigs_rental_expiry
  ON virtual_rigs (rental_expires_at);

-- Backfill existing rigs to the rental model:
--   - The admin's KAS rig is ACTIVE with real MRR rental #5698667 running
--     until 2026-08-22 20:18 UTC -> its rental window is that end time.
--   - The leftover XMR demo rig is DORMANT with no backing -> already expired
--     (NULL expires_at; status EXPIRED).
UPDATE virtual_rigs
  SET rental_expires_at = '2026-08-22 20:18:00+00'
  WHERE target_pool = 'KASPA'
    AND maintenance_status = 'ACTIVE';

UPDATE virtual_rigs
  SET maintenance_status = 'EXPIRED'
  WHERE maintenance_status = 'DORMANT'
    AND rental_expires_at IS NULL;

-- Reset the leftover demo-era rigs (Kevin: "xmr should be reset under my
-- account — it still shows mining activity with nothing active"). A rig with
-- NO real backing must show ZERO hashrate and never contribute to payouts:
-- zero the virtual hashrate and log a 0-hashrate history row so the
-- time-weighted math stops counting it.
UPDATE virtual_rigs
  SET virtual_hashrate = 0, level = 1, updated_at = CURRENT_TIMESTAMP
  WHERE maintenance_status = 'EXPIRED'
    AND rental_expires_at IS NULL;

INSERT INTO rig_hashrate_history (user_id, target_pool, hashrate)
  SELECT user_id, target_pool, 0
    FROM virtual_rigs
   WHERE maintenance_status = 'EXPIRED'
     AND rental_expires_at IS NULL;

-- XMR (RandomX) is a rentable room since 2026-08-20 but the rig_rentals
-- CHECK constraint still excluded it — recording an XMR rental audit row
-- would have been silently rejected. Relax it to all four rooms.
ALTER TABLE rig_rentals
  DROP CONSTRAINT IF EXISTS rig_rentals_target_pool_check;
ALTER TABLE rig_rentals
  ADD CONSTRAINT rig_rentals_target_pool_check
  CHECK (target_pool::text = ANY (ARRAY['ZCASH'::character varying, 'KASPA'::character varying, 'LTC_DOGE'::character varying, 'XMR'::character varying]::text[]));
