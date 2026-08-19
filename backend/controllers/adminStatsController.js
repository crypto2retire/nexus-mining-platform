/**
 * Operator dashboard stats (ADMIN ONLY).
 *
 * Aggregates the platform-wide picture the operator needs:
 *   - total mining capacity per coin (sum of active virtual hashrate)
 *   - total rewards earned (real pool payouts per coin)
 *   - treasury profit (5% protocol fees + treasury share of payouts)
 *   - rewards earned by users (ledger totals per coin, by status)
 */
const { pool } = require('../config/db');

async function getAdminStats(_req, res) {
  try {
    const [capacity, payouts, fees, ledger, users, deposits] = await Promise.all([
      // 1. Total virtual mining capacity per coin (active rigs only).
      pool.query(
        `SELECT target_pool,
                COALESCE(SUM(virtual_hashrate), 0) AS total_hashrate,
                COUNT(*) AS rig_count
           FROM virtual_rigs
          GROUP BY target_pool
          ORDER BY target_pool`
      ),
      // 2. Real rewards earned per coin (actual pool payouts received).
      pool.query(
        `SELECT target_pool,
                COUNT(*) AS payout_count,
                COALESCE(SUM(total_crypto_reward_1), 0) AS total_crypto,
                COALESCE(SUM(total_crypto_reward_1) * 0.95, 0) AS users_share_crypto,
                COALESCE(SUM(total_crypto_reward_1) * 0.05, 0) AS treasury_share_crypto
           FROM real_pool_payouts
          GROUP BY target_pool
          ORDER BY target_pool`
      ),
      // 3. Treasury profit from protocol fees (USDC) — the 5% fee on upgrades.
      pool.query(
        `SELECT COALESCE(SUM(amount_usdc), 0) AS total_fees_usdc,
                COUNT(*) AS fee_count
           FROM protocol_revenue_ledger`
      ),
      // 4. User rewards ledger totals per coin (by status).
      pool.query(
        `SELECT l.target_pool,
                COALESCE(SUM(l.calculated_reward_1), 0) AS total_earned_crypto,
                COALESCE(SUM(l.calculated_reward_1) FILTER (WHERE l.status = 'UNCLAIMED'), 0) AS unclaimed_crypto,
                COALESCE(SUM(l.calculated_reward_1) FILTER (WHERE l.status = 'CLAIMED'), 0) AS claimed_crypto,
                COALESCE(SUM(l.calculated_reward_1) FILTER (WHERE l.status = 'PAID'), 0) AS paid_crypto
           FROM user_rewards_ledger l
          GROUP BY l.target_pool
          ORDER BY l.target_pool`
      ),
      // 5. User base: how many wallets, total deposited.
      pool.query(
        `SELECT COUNT(*) AS user_count FROM users`
      ),
      pool.query(
        `SELECT COALESCE(SUM(amount_usdc), 0) AS total_deposits_usdc,
                COUNT(*) AS deposit_count
           FROM deposit_history`
      ),
    ]);

    const capacityByPool = {};
    for (const r of capacity.rows) {
      capacityByPool[r.target_pool] = {
        total_hashrate: Number(r.total_hashrate),
        rig_count: Number(r.rig_count),
      };
    }

    const payoutsByPool = {};
    for (const r of payouts.rows) {
      payoutsByPool[r.target_pool] = {
        payout_count: Number(r.payout_count),
        total_crypto: Number(r.total_crypto),
        users_share_crypto: Number(r.users_share_crypto),
        treasury_share_crypto: Number(r.treasury_share_crypto),
      };
    }

    const ledgerByPool = {};
    for (const r of ledger.rows) {
      ledgerByPool[r.target_pool] = {
        total_earned_crypto: Number(r.total_earned_crypto),
        unclaimed_crypto: Number(r.unclaimed_crypto),
        claimed_crypto: Number(r.claimed_crypto),
        paid_crypto: Number(r.paid_crypto),
      };
    }

    return res.json({
      generated_at: new Date().toISOString(),
      capacity_by_pool: capacityByPool,
      payouts_by_pool: payoutsByPool,
      ledger_by_pool: ledgerByPool,
      treasury: {
        protocol_fees_usdc: Number(fees.rows[0]?.total_fees_usdc || 0),
        fee_count: Number(fees.rows[0]?.fee_count || 0),
        // 5% of every pool payout also flows to the treasury (see payouts_by_pool).
      },
      users: {
        count: Number(users.rows[0]?.user_count || 0),
      },
      deposits: {
        total_usdc: Number(deposits.rows[0]?.total_deposits_usdc || 0),
        count: Number(deposits.rows[0]?.deposit_count || 0),
      },
    });
  } catch (err) {
    console.error('Admin stats error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { getAdminStats };
