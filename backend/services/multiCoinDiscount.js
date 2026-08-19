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

/** Number of distinct coins the user owns a miner for (rig rows). */
async function coinsOwnedFor(queryable, userId) {
  const { rows } = await queryable.query(
    // Only purchasable marketplace rooms count — the XMR self-mined demo pool
    // was removed 2026-08-19, so XMR rigs are excluded from the loyalty count.
    `SELECT COUNT(*) AS c FROM virtual_rigs
      WHERE user_id = $1 AND target_pool IN ('ZCASH', 'KASPA', 'LTC_DOGE')`,
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
