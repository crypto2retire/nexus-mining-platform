const { pool } = require('../config/db');
const { isAdminWallet } = require('../middleware/adminAuth');
const { getBacking } = require('../services/backingMonitor');
const { tiersFor } = require('./upgradeController');
const { coinsOwnedFor, discountPctFor } = require('../services/multiCoinDiscount');

/**
 * The zero address is a burn address — real USDC sent there is unrecoverable.
 * The platform treasury must be a real wallet the operator controls. Until it
 * is, deposits are NOT exposed in the UI and NOT credited by the listener.
 */
function isSafeTreasury() {
  const t = (process.env.PLATFORM_TREASURY_WALLET || '').toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(t) && t !== '0x0000000000000000000000000000000000000000';
}

async function getDashboard(req, res) {
  try {
    const walletAddress = (req.query.wallet || '').toLowerCase();
    if (!walletAddress || !/^0x[a-f0-9]{40}$/i.test(walletAddress)) {
      return res.status(400).json({ error: 'Valid wallet address is required' });
    }

    const client = await pool.connect();
    try {
      const userResult = await client.query(
        'SELECT user_id FROM users WHERE LOWER(wallet_address) = $1',
        [walletAddress]
      );
      let userId = null;
      if (userResult.rowCount === 0) {
        const insertUser = await client.query(
          'INSERT INTO users (wallet_address) VALUES ($1) RETURNING user_id',
          [walletAddress]
        );
        userId = insertUser.rows[0].user_id;
        await client.query(
          'INSERT INTO user_wallets (user_id, usdc_balance) VALUES ($1, 0.0000)',
          [userId]
        );
      } else {
        userId = userResult.rows[0].user_id;
      }

      const wallet = await client.query(
        'SELECT usdc_balance FROM user_wallets WHERE user_id = $1',
        [userId]
      );
      const rigs = await client.query(
        'SELECT rig_id, target_pool, virtual_hashrate, level, maintenance_status, mine_at_loss FROM virtual_rigs WHERE user_id = $1',
        [userId]
      );
      const rates = await client.query('SELECT pool, usdc_per_ghs_per_day FROM pool_maintenance_rates');

      const pools = ['ZCASH', 'KASPA', 'LTC_DOGE'];
      const rigsByPool = {};
      const upgradeCostByPool = {};
      const maintenanceRateByPool = {};
      for (const row of rates.rows) {
        maintenanceRateByPool[row.pool] = Number(row.usdc_per_ghs_per_day);
      }
      for (const pool of pools) {
        const rig = rigs.rows.find(r => r.target_pool === pool);
        const level = rig ? Number(rig.level) : 1;
        // pg returns NUMERIC as strings — coerce so the frontend can call .toFixed()
        rigsByPool[pool] = rig
          ? {
              rig_id: rig.rig_id,
              target_pool: rig.target_pool,
              virtual_hashrate: Number(rig.virtual_hashrate),
              level,
              maintenance_status: rig.maintenance_status,
              mine_at_loss: rig.mine_at_loss === true,
            }
          : null;
        // Per-coin next upgrade price (entry points reflect real backing cost).
        const nextTier = tiersFor(pool).find((t) => t.level === level + 1);
        upgradeCostByPool[pool] = nextTier ? nextTier.cost : null;
      }

      const rewards = await client.query(
        `SELECT
          COALESCE(SUM(calculated_reward_1) FILTER (WHERE status = 'UNCLAIMED'), 0) AS pending_reward_1,
          COALESCE(SUM(calculated_reward_2) FILTER (WHERE status = 'UNCLAIMED'), 0) AS pending_reward_2,
          target_pool
         FROM user_rewards_ledger
         LEFT JOIN real_pool_payouts USING (payout_id)
         WHERE user_id = $1
         GROUP BY target_pool`,
        [userId]
      );

      const pendingByPool = {};
      const pendingDogeByPool = {};
      for (const row of rewards.rows) {
        pendingByPool[row.target_pool] = Number(row.pending_reward_1);
        if (Number(row.pending_reward_2) > 0) {
          pendingDogeByPool[row.target_pool] = Number(row.pending_reward_2);
        }
      }

      const coinsOwned = await coinsOwnedFor(client, userId);

      return res.json({
        user_id: userId,
        wallet_address: walletAddress,
        usdc_balance: Number(wallet.rows[0]?.usdc_balance || 0),
        rigs: rigsByPool,
        upgrade_cost: upgradeCostByPool,
        maintenance_rate: maintenanceRateByPool,
        pending_rewards: pendingByPool,
        pending_rewards_2: pendingDogeByPool,
        multi_coin: { coins_owned: coinsOwned, discount_pct: discountPctFor(coinsOwned) },
        is_admin: isAdminWallet(walletAddress),
        // Real backing per coin (cached 60s) — what ACTUALLY mines this room.
        backing: await getBacking(),
        // Never expose a missing/zero-address treasury — the zero address is a
        // burn address and players would lose real USDC sending to it.
        deposit_address: isSafeTreasury() ? process.env.PLATFORM_TREASURY_WALLET : null,
      });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Dashboard error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { getDashboard };
