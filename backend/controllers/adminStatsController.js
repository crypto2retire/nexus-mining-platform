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
const { getBacking } = require('../services/backingMonitor');

async function getAdminStats(_req, res) {
  try {
    const [capacity, distributed, revenue, revenueCoins, ledger, users, deposits, backing] = await Promise.all([
      // 1. Total virtual mining capacity per coin (ACTIVE credits only —
      // expired 0-GH/s rigs must not count; Kevin 2026-08-20).
      pool.query(
        `SELECT target_pool,
                COALESCE(SUM(virtual_hashrate), 0) AS total_hashrate,
                COUNT(DISTINCT user_id) AS rig_count
           FROM capacity_slices
          WHERE starts_at <= CURRENT_TIMESTAMP AND expires_at > CURRENT_TIMESTAMP
            AND virtual_hashrate > 0
          GROUP BY target_pool
          ORDER BY target_pool`
      ),
      // 2. What the platform actually DISTRIBUTED (the 5% treasury cut is
      //     taken from distributed amounts, not from total production).
      pool.query(
        `SELECT target_pool,
                COALESCE(SUM(total_crypto_reward_1), 0) AS distributed_crypto
           FROM real_pool_payouts
          GROUP BY target_pool
          ORDER BY target_pool`
      ),
      // 3. Treasury revenue converted to USDC at each row's recorded price.
      pool.query(
        `SELECT COALESCE(SUM(amount_usdc), 0) AS total_revenue_usdc,
                COUNT(*) AS revenue_entry_count
           FROM protocol_revenue_ledger`
      ),
      // Native coin totals stay separately auditable and are never summed
      // across symbols as though they shared a unit.
      pool.query(
        `SELECT coin_symbol, COALESCE(SUM(amount_coin), 0) AS total_coin
           FROM protocol_revenue_ledger
          WHERE coin_symbol IS NOT NULL AND amount_coin IS NOT NULL
          GROUP BY coin_symbol
          ORDER BY coin_symbol`
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
      // 6. LIVE production per coin (same source as Real Backing) — pool
      //    wallet's current unpaid + settled pool payments, computed at read
      //    time (60s cache). NOT the 6h-old room_accrual snapshot.
      getBacking(),
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
    // Mined = LIVE production from Real Backing (computed at read time from
    // the pool wallet + settled payments). Kevin 2026-08-20: reports must
    // use current data, never 6h-old snapshots.
    for (const poolName of ['ZCASH', 'KASPA', 'LTC_DOGE', 'BTC']) {
      const mined = backing?.[poolName]?.mined_total;
      if (mined == null) continue;
      const distributedAmt = distributedByPool[poolName] ?? 0;
      payoutsByPool[poolName] = {
        payout_count: null,
        total_crypto: Number(mined),
        users_share_crypto: Number(mined) * 0.95,
        treasury_share_crypto: distributedAmt * 0.05,
        fetched_at: backing?.[poolName]?.fetched_at || backing?.generated_at || null,
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

    const coinAmountsBySymbol = {};
    for (const r of revenueCoins.rows) {
      coinAmountsBySymbol[r.coin_symbol] = Number(r.total_coin);
    }

    return res.json({
      generated_at: new Date().toISOString(),
      capacity_by_pool: capacityByPool,
      payouts_by_pool: payoutsByPool,
      ledger_by_pool: ledgerByPool,
      treasury: {
        protocol_revenue_usdc: Number(revenue.rows[0]?.total_revenue_usdc || 0),
        revenue_entry_count: Number(revenue.rows[0]?.revenue_entry_count || 0),
        coin_amounts_by_symbol: coinAmountsBySymbol,
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
