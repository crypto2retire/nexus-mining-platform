const { pool } = require('../config/db');

const PROTOCOL_FEE_PCT = 0.05;

async function handleRewardWebhook(req, res) {
  const secret = req.headers['x-api-secret'];
  if (secret !== process.env.INTERNAL_SECRET_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { target_pool, total_crypto_reward_1, total_network_hashrate } = req.body || {};
  if (!['ZCASH', 'KASPA', 'LTC_DOGE', 'XMR'].includes(target_pool)) {
    return res.status(400).json({ error: 'Invalid target_pool' });
  }
  if (typeof total_crypto_reward_1 !== 'number' || total_crypto_reward_1 <= 0) {
    return res.status(400).json({ error: 'total_crypto_reward_1 must be a positive number' });
  }
  if (typeof total_network_hashrate !== 'number' || total_network_hashrate <= 0) {
    return res.status(400).json({ error: 'total_network_hashrate must be a positive number' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const payoutResult = await client.query(
      'INSERT INTO real_pool_payouts (target_pool, total_crypto_reward_1, total_network_hashrate) VALUES ($1, $2, $3) RETURNING payout_id',
      [target_pool, total_crypto_reward_1, total_network_hashrate]
    );
    const payoutId = payoutResult.rows[0].payout_id;

    const rigsResult = await client.query(
      'SELECT user_id, virtual_hashrate FROM virtual_rigs WHERE target_pool = $1',
      [target_pool]
    );

    const totalVirtualHashrate = rigsResult.rows.reduce(
      (sum, r) => sum + Number(r.virtual_hashrate),
      0
    );

    for (const rig of rigsResult.rows) {
      const userHashrate = Number(rig.virtual_hashrate);
      if (userHashrate <= 0 || totalVirtualHashrate <= 0) continue;

      const ratio = userHashrate / totalVirtualHashrate;
      const grossReward = total_crypto_reward_1 * ratio;
      const fee = grossReward * PROTOCOL_FEE_PCT;
      const netReward = grossReward - fee;

      await client.query(
        'INSERT INTO user_rewards_ledger (user_id, payout_id, calculated_reward_1, protocol_fee_taken, status) VALUES ($1, $2, $3, $4, $5)',
        [rig.user_id, payoutId, netReward, fee, 'UNCLAIMED']
      );
      await client.query(
        'INSERT INTO protocol_revenue_ledger (source_user_id, amount_usdc, transaction_type) VALUES ($1, $2, $3)',
        [rig.user_id, fee, 'MINING_REWARD_FEE']
      );
    }

    await client.query('COMMIT');
    return res.json({ success: true, payout_id: payoutId, participants: rigsResult.rowCount });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Reward webhook error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
}

module.exports = { handleRewardWebhook };
