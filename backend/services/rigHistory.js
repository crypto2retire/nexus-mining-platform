const { pool } = require('../config/db');

/**
 * Time-weighted hashrate contribution accounting.
 *
 * Every rig level change is appended to rig_hashrate_history (hashrate became
 * X at changed_at). A user's contribution to a payout period is the integral
 * of their virtual hashrate over time: hashrate-hours =
 *   Σ over segments of (hashrate × overlap(segment, [start, end]))
 *
 * This is the "actual contribution per payout" — proportional to BOTH how
 * much hashrate they owned AND how long they owned it during the period.
 * A user who buys mid-period earns only their pro-rata share of the time
 * they actually held hashrate.
 */

/**
 * Pure math: compute hashrate-hours for one user's history over [start, end].
 * @param {Array<{changed_at: Date|string, hashrate: number|string}>} history
 *        sorted ascending by changed_at (all rows <= end).
 * @param {Date} start period start
 * @param {Date} end period end
 * @returns {number} hashrate-hours
 */
function computeContributions(history, start, end) {
  const s = start.getTime();
  const e = end.getTime();
  if (!(e > s) || !Array.isArray(history) || history.length === 0) return 0;
  let total = 0;
  for (let i = 0; i < history.length; i++) {
    const segStart = new Date(history[i].changed_at).getTime();
    // A change row is effective until the NEXT change (or the period end).
    const segEnd = i + 1 < history.length ? new Date(history[i + 1].changed_at).getTime() : e;
    const overlapStart = Math.max(segStart, s);
    const overlapEnd = Math.min(segEnd, e);
    if (overlapEnd > overlapStart) {
      total += Number(history[i].hashrate) * ((overlapEnd - overlapStart) / 3600000);
    }
  }
  return total;
}

/** Append a hashrate-change event (call inside the rig-change transaction). */
async function logRigChange(client, userId, targetPool, hashrate) {
  await client.query(
    'INSERT INTO rig_hashrate_history (user_id, target_pool, hashrate) VALUES ($1, $2, $3)',
    [userId, targetPool, hashrate]
  );
}

/**
 * Per-user contributions for a pool over [start, end], using history.
 * Users with a rig but no history (pre-logging) fall back to their current
 * hashrate × full period. Returns [{user_id, contribution}] with > 0 only.
 *
 * RENTAL model (2026-08-20): the expiry sweeper logs 0-hashrate rows when a
 * window passes, so an expired rental contributes 0 here automatically.
 */
async function contributionsForPool(client, targetPool, start, end) {
  const { rows } = await client.query(
    `SELECT user_id,
            SUM(virtual_hashrate *
                (EXTRACT(EPOCH FROM
                  (LEAST(expires_at, $3::timestamptz) - GREATEST(starts_at, $2::timestamptz)))
                 / 3600.0)) AS contribution
       FROM capacity_slices
      WHERE target_pool = $1
        AND starts_at < $3
        AND expires_at > $2
      GROUP BY user_id`,
    [targetPool, start, end]
  );
  return rows
    .map((row) => ({ user_id: row.user_id, contribution: Number(row.contribution) }))
    .filter((row) => row.contribution > 0);
}

/**
 * Append a real-hashrate measurement for a room (called by the backing
 * monitor on each refresh and by the distributor before splitting a payout).
 * One row per refresh is fine (60s TTL + per-payout) — the segment math
 * below treats each row as effective until the next one.
 */
async function logRealHashChange(client, targetPool, hashrate, unit = 'GH/s') {
  await client.query(
    'INSERT INTO real_rig_hashrate_history (target_pool, hashrate, unit) VALUES ($1, $2, $3)',
    [targetPool, hashrate, unit]
  );
}

/**
 * Real hash-hours for a pool over [start, end] — the DENOMINATOR for the
 * hybrid session payout. Returns the time-weighted sum of the pool wallet's
 * reported hashrate, or 0 when no measurement exists in/around the period.
 */
async function realHashHoursForPool(client, targetPool, start, end) {
  const { rows } = await client.query(
    `SELECT changed_at, hashrate
       FROM real_rig_hashrate_history
      WHERE target_pool = $1 AND changed_at <= $2
      ORDER BY changed_at`,
    [targetPool, end]
  );
  if (rows.length === 0) return 0;
  // The last row before the period also counts (its value persists into the
  // period until superseded) — include it by using max(rows) as the start of
  // the first segment when it predates `start`.
  const s = start.getTime();
  const e = end.getTime();
  let total = 0;
  for (let i = 0; i < rows.length; i++) {
    const segStart = Math.max(new Date(rows[i].changed_at).getTime(), s);
    const segEnd =
      i + 1 < rows.length ? Math.min(new Date(rows[i + 1].changed_at).getTime(), e) : e;
    if (segEnd > segStart) {
      total += Number(rows[i].hashrate) * ((segEnd - segStart) / 3600000);
    }
    if (i + 1 < rows.length && new Date(rows[i + 1].changed_at).getTime() > e) break;
  }
  return total;
}

module.exports = { computeContributions, logRigChange, contributionsForPool, logRealHashChange, realHashHoursForPool };
