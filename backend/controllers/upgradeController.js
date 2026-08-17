const { pool } = require('../config/db');

const UPGRADE_TIERS = [
  { level: 1, cost: 0, hashrate: 10 },
  { level: 2, cost: 50, hashrate: 25 },
  { level: 3, cost: 120, hashrate: 60 },
  { level: 4, cost: 300, hashrate: 150 },
  { level: 5, cost: 750, hashrate: 400 },
];

async function upgradeRig(req, res) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const walletAddress = (req.body.wallet || '').toLowerCase();
    const targetPool = req.body.target_pool;

    if (!walletAddress || !/^0x[a-f0-9]{40}$/i.test(walletAddress)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Valid wallet address is required' });
    }
    if (!['ZCASH', 'KASPA', 'LTC_DOGE'].includes(targetPool)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid target pool' });
    }

    const userResult = await client.query(
      'SELECT user_id FROM users WHERE LOWER(wallet_address) = $1 FOR UPDATE',
      [walletAddress]
    );
    if (userResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found' });
    }
    const userId = userResult.rows[0].user_id;

    const walletResult = await client.query(
      'SELECT wallet_id, usdc_balance FROM user_wallets WHERE user_id = $1 FOR UPDATE',
      [userId]
    );
    const wallet = walletResult.rows[0];

    const rigResult = await client.query(
      'SELECT rig_id, level, virtual_hashrate FROM virtual_rigs WHERE user_id = $1 AND target_pool = $2 FOR UPDATE',
      [userId, targetPool]
    );

    let rig = rigResult.rows[0];
    const currentLevel = rig ? rig.level : 1;
    const nextTier = UPGRADE_TIERS.find(t => t.level === currentLevel + 1);

    if (!nextTier) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Already at max level' });
    }

    if (Number(wallet.usdc_balance) < nextTier.cost) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient USDC balance' });
    }

    const newBalance = Number(wallet.usdc_balance) - nextTier.cost;
    await client.query(
      'UPDATE user_wallets SET usdc_balance = $1, updated_at = CURRENT_TIMESTAMP WHERE wallet_id = $2',
      [newBalance, wallet.wallet_id]
    );

    await client.query(
      'INSERT INTO protocol_revenue_ledger (source_user_id, amount_usdc, transaction_type) VALUES ($1, $2, $3)',
      [userId, nextTier.cost, 'RIG_UPGRADE']
    );

    if (rig) {
      await client.query(
        'UPDATE virtual_rigs SET level = $1, virtual_hashrate = $2, updated_at = CURRENT_TIMESTAMP WHERE rig_id = $3',
        [nextTier.level, nextTier.hashrate, rig.rig_id]
      );
    } else {
      await client.query(
        'INSERT INTO virtual_rigs (user_id, target_pool, virtual_hashrate, level) VALUES ($1, $2, $3, $4)',
        [userId, targetPool, nextTier.hashrate, nextTier.level]
      );
    }

    await client.query('COMMIT');
    return res.json({ success: true, level: nextTier.level, hashrate: nextTier.hashrate, remaining_balance: newBalance });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Upgrade error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
}

module.exports = { upgradeRig, UPGRADE_TIERS };
