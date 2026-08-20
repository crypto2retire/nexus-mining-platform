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
    const [capacity, accrual, distributed, fees, ledger, users, deposits] = await Promise.all([
      // 1. Total virtual mining capacity per coin (ACTIVE credits only —
      // expired 0-GH/s rigs must not count; Kevin 2026-08-20).
      pool.query(
        `SELECT target_pool,
                COALESCE(SUM(virtual_hashrate), 0) AS total_hashrate,
                COUNT(*) AS rig_count
           FROM virtual_rigs
          WHERE rental_expires_at > CURRENT_TIMESTAMP
            AND virtual_hashrate > 0
          GROUP BY target_pool
          ORDER BY target_pool`
      ),
      // 2. Real rewards earned per coin — the pool's actual production
      //    (room_accrual.earned_total = unpaid at pool + settled pool
      //    payments). NOT the game's distribution rows: real_pool_payouts
      //    only holds ACCRUAL rows of what was handed to users, so summing
      //    it showed 0.049 KAS while the pool wallet actually held 1.69 KAS.
      pool.query(
        `SELECT pool AS target_pool,
                COALESCE(SUM(earned_total), 0) AS total_crypto
           FROM room_accrual
          GROUP BY pool
          ORDER BY pool`
      ),
      // 2b. What the platform actually DISTRIBUTED (the 5% treasury cut is
      //     taken from distributed amounts, not from total production).
      pool.query(
        `SELECT target_pool,
                COALESCE(SUM(total_crypto_reward_1), 0) AS distributed_crypto
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
      // 4. User rewards ledger totals per coin (by status) — pool comes from
      //    the payout row the ledger entry belongs to.
      pool.query(
        `SELECT p.target_pool,
                COALESCE(SUM(l.calculated_reward_1), 0) AS total_earned_crypto,
                COALESCE(SUM(l.calculated_reward_1) FILTER (WHERE l.status = 'UNCLAIMED'), 0) AS unclaimed_crypto,
                COALESCE(SUM(l.calculated_reward_1) FILTER (WHERE l.status = 'CLAIMED'), 0) AS claimed_crypto,
                COALESCE(SUM(l.calculated_reward_1) FILTER (WHERE l.status = 'PAID'), 0) AS paid_crypto
           FROM user_rewards_ledger l
           LEFT JOIN real_pool_payouts p USING (payout_id)
          GROUP BY p.target_pool
          ORDER BY p.target_pool`
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
    const distributedByPool = {};
    for (const r of distributed.rows) {
      distributedByPool[r.target_pool] = Number(r.distributed_crypto);
    }
    for (const r of accrual.rows) {
      // Keep the same response shape the frontend expects.
      //   total_crypto          = REAL production (pool wallet truth)
      //   treasury_share_crypto = 5% of what was DISTRIBUTED to users (the
      //                           platform's actual 5% cut, not 5% of the
      //                           still-unpaid balance sitting at the pool)
      const distributedAmt = distributedByPool[r.target_pool] ?? 0;
      payoutsByPool[r.target_pool] = {
        payout_count: null,
        total_crypto: Number(r.total_crypto),
        users_share_crypto: Number(r.total_crypto) * 0.95,
        treasury_share_crypto: distributedAmt * 0.05,
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
