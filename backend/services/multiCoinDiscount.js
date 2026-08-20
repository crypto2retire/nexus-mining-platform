/**
 * multiCoinDiscount.js — multi-coin loyalty mechanic.
 *
 * "The first step is buying the miner for each token they want to mine" —
 * the more distinct coins a user mines, the cheaper everything gets:
 *   2 coins -> 5% off, 3 coins -> 10% off, 4 coins -> 15% off
 *
 * Applied to BOTH sides of the go-miner loop:
 *   - entry/upgrade purchase price (upgradeController)
 *   - ongoing maintenance rate per GH/s/day (rewardDistributor) — the
 *     "lower ongoing costs" half of the incentive
 */

const DISCOUNT_LADDER = {
  2: 5,
  3: 10,
  4: 15,
};

/**
 * Number of distinct coins the user is CURRENTLY mining (ACTIVE rig rows).
 * RENTAL model (2026-08-20): a rig counts only while its rental window is
 * live (`rental_expires_at > now`) — expired rigs are 0 GH/s and must NOT
 * keep the loyalty discount (Kevin: "change this so it does not count
 * expired rows"). The expiry check is the source of truth; it also excludes
 * phantom rows (ACTIVE status with NULL expiry).
 */
async function coinsOwnedFor(queryable, userId) {
  const { rows } = await queryable.query(
    // All four purchasable marketplace rooms count (XMR re-added 2026-08-20
    // as a rental-backed room).
    `SELECT COUNT(*) AS c FROM virtual_rigs
      WHERE user_id = $1
        AND target_pool IN ('ZCASH', 'KASPA', 'LTC_DOGE', 'XMR')
        AND rental_expires_at > CURRENT_TIMESTAMP`,
    [userId]
  );
  const c = Number(rows[0]?.c);
  return Number.isFinite(c) ? c : 0;
}

/** Discount percent for a coin count (0 when below the first rung). */
function discountPctFor(coins) {
  return DISCOUNT_LADDER[coins] || 0;
}

module.exports = { coinsOwnedFor, discountPctFor, DISCOUNT_LADDER };
