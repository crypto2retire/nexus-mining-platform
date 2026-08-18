const { pool } = require('../config/db');

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
        'SELECT rig_id, target_pool, virtual_hashrate, level FROM virtual_rigs WHERE user_id = $1',
        [userId]
      );

      const pools = ['ZCASH', 'KASPA', 'LTC_DOGE', 'XMR'];
      const rigsByPool = {};
      for (const pool of pools) {
        const rig = rigs.rows.find(r => r.target_pool === pool);
        // pg returns NUMERIC as strings — coerce so the frontend can call .toFixed()
        rigsByPool[pool] = rig
          ? {
              rig_id: rig.rig_id,
              target_pool: rig.target_pool,
              virtual_hashrate: Number(rig.virtual_hashrate),
              level: Number(rig.level),
            }
          : null;
      }

      const rewards = await client.query(
        `SELECT
          COALESCE(SUM(calculated_reward_1) FILTER (WHERE status = 'UNCLAIMED'), 0) AS pending_reward_1,
          target_pool
         FROM user_rewards_ledger
         LEFT JOIN real_pool_payouts USING (payout_id)
         WHERE user_id = $1
         GROUP BY target_pool`,
        [userId]
      );

      const pendingByPool = {};
      for (const row of rewards.rows) {
        pendingByPool[row.target_pool] = Number(row.pending_reward_1);
      }

      return res.json({
        user_id: userId,
        wallet_address: walletAddress,
        usdc_balance: Number(wallet.rows[0]?.usdc_balance || 0),
        rigs: rigsByPool,
        pending_rewards: pendingByPool,
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
