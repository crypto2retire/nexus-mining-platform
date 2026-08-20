/**
 * rentalScheduler.js — RENTAL-model expiry sweeper (rewritten 2026-08-20).
 *
 * The GoMiner re-rental loop (maintenance-fund math, DORMANT auto-pause,
 * mine-at-loss) is GONE — users now RENT hashrate for a fixed window (72h by
 * default, matched 1:1 to the real MRR rental they paid for). This sweeper's
 * only jobs:
 *
 *   1. Close out rig_rentals rows whose MRR rental is no longer active.
 *   2. Expire virtual rigs whose rental window has passed: set
 *      maintenance_status = 'EXPIRED' and log a 0-hashrate history row so
 *      time-weighted payouts stop counting them. Renewing (paying again)
 *      re-activates the rig via the normal upgrade flow.
 *
 * No funds are ever spent here — every rental is paid for at purchase time.
 */

const { pool } = require('../config/db');
const mrr = require('./mrrRenter');

const INTERVAL_MS = Number(process.env.RENTAL_SCHEDULER_INTERVAL_MS || 15 * 60 * 1000);

let timer = null;
let running = false;

function startRentalScheduler() {
  if (process.env.RENTAL_SCHEDULER_ENABLED !== '1') {
    console.log('rentalScheduler: disabled (set RENTAL_SCHEDULER_ENABLED=1 to run)');
    return;
  }
  if (timer) return;
  console.log(`rentalScheduler: expiry sweeper starting (every ${Math.round(INTERVAL_MS / 60000)} min)`);
  timer = setInterval(() => {
    schedulerTick().catch((err) => console.error('rentalScheduler tick error:', err));
  }, INTERVAL_MS);
  // First tick shortly after boot so no expired rig keeps earning shares.
  setTimeout(() => schedulerTick().catch((err) => console.error('rentalScheduler first tick error:', err)), 5000);
}

function stopRentalScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function schedulerTick() {
  if (running) return; // never overlap ticks
  running = true;
  try {
    await runSchedulerOnce();
  } catch (err) {
    console.error('rentalScheduler error:', err);
  } finally {
    running = false;
  }
}

async function runSchedulerOnce() {
  // 1. Which MRR rentals are still active right now? (Only used to close out
  //    audit rows — the expiry decision itself is purely time-based.)
  let activeRentals = new Map();
  try {
    const data = await mrr.makeMrrRequest('GET', '/rental');
    for (const r of data?.data?.rentals || []) {
      if (!r?.ended) activeRentals.set(String(r.id), r);
    }
  } catch (err) {
    console.error('rentalScheduler: MRR rental list unavailable:', err.message);
    // Continue — expiry is time-based and must still run even if MRR is down.
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 2. Close out rig_rentals rows whose MRR rental is no longer active.
    const openRows = await client.query(
      `SELECT id, mrr_rental_id, rig_id FROM rig_rentals WHERE status = 'ACTIVE'`
    );
    for (const row of openRows.rows) {
      if (row.mrr_rental_id && !activeRentals.has(String(row.mrr_rental_id))) {
        await client.query(
          `UPDATE rig_rentals SET status = 'ENDED', ended_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [row.id]
        );
        console.log(`rentalScheduler: rental ${row.mrr_rental_id} for rig ${row.rig_id} ended`);
      }
    }

    // 3. Expire rigs whose rental window has passed. Log a 0-hashrate history
    //    row so time-weighted payout math stops counting them immediately.
    const expired = await client.query(
      `SELECT rig_id, user_id, target_pool FROM virtual_rigs
        WHERE maintenance_status = 'ACTIVE'
          AND rental_expires_at IS NOT NULL
          AND rental_expires_at < CURRENT_TIMESTAMP`
    );
    for (const rig of expired.rows) {
      await client.query(
        `UPDATE virtual_rigs
            SET maintenance_status = 'EXPIRED', updated_at = CURRENT_TIMESTAMP
          WHERE rig_id = $1`,
        [rig.rig_id]
      );
      await client.query(
        'INSERT INTO rig_hashrate_history (user_id, target_pool, hashrate) VALUES ($1, $2, 0)',
        [rig.user_id, rig.target_pool]
      );
      console.log(`rentalScheduler: rig ${rig.rig_id}/${rig.target_pool} EXPIRED — rental window passed`);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('rentalScheduler transaction error:', err);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  startRentalScheduler,
  stopRentalScheduler,
  schedulerTick,
  runSchedulerOnce,
  INTERVAL_MS,
};
