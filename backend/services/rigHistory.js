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
 */
async function contributionsForPool(client, targetPool, start, end) {
  const { rows } = await client.query(
    `SELECT user_id, changed_at, hashrate
       FROM rig_hashrate_history
      WHERE target_pool = $1 AND changed_at <= $2
      ORDER BY user_id, changed_at`,
    [targetPool, end]
  );

  const byUser = new Map();
  for (const r of rows) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
    byUser.get(r.user_id).push(r);
  }

  const result = [];
  for (const [uid, hist] of byUser) {
    const contribution = computeContributions(hist, start, end);
    if (contribution > 0) result.push({ user_id: uid, contribution });
  }

  // Fallback: rig exists but no history rows (created before logging started).
  const rigs = await client.query(
    'SELECT user_id, virtual_hashrate FROM virtual_rigs WHERE target_pool = $1',
    [targetPool]
  );
  const hours = Math.max(0, (end.getTime() - start.getTime()) / 3600000);
  for (const rig of rigs.rows) {
    if (!byUser.has(rig.user_id)) {
      const contribution = Number(rig.virtual_hashrate) * hours;
      if (contribution > 0) result.push({ user_id: rig.user_id, contribution });
    }
  }
  return result;
}

module.exports = { computeContributions, logRigChange, contributionsForPool };
