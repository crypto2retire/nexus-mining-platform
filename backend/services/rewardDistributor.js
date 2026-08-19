const { pool } = require('../config/db');
const { contributionsForPool } = require('./rigHistory');

const PROTOCOL_FEE_PCT = 0.05;

/**
 * Core distribution: split a real pool payout among users proportional to
 * their time-weighted hashrate contribution during the payout period.
 * Shared by the reward webhook (external trigger) and the payout trigger
 * (automatic pool-wallet watcher).
 *
 * @returns {Promise<{payout_id, participants, total_contribution, period_start, period_end}>}
 */
async function distributePayout(targetPool, totalCryptoReward1, totalNetworkHashrate) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const periodEnd = new Date();
    const last = await client.query(
      'SELECT payout_timestamp FROM real_pool_payouts WHERE target_pool = $1 ORDER BY payout_timestamp DESC LIMIT 1',
      [targetPool]
    );
    let periodStart;
    if (last.rowCount > 0) {
      periodStart = new Date(last.rows[0].payout_timestamp);
    } else {
      const first = await client.query(
        'SELECT MIN(changed_at) AS c FROM rig_hashrate_history WHERE target_pool = $1',
        [targetPool]
      );
      periodStart = first.rows[0]?.c
        ? new Date(first.rows[0].c)
        : new Date(periodEnd.getTime() - 24 * 3600 * 1000);
    }

    const payoutResult = await client.query(
      `INSERT INTO real_pool_payouts
         (target_pool, total_crypto_reward_1, total_network_hashrate, period_start, period_end)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING payout_id`,
      [targetPool, totalCryptoReward1, totalNetworkHashrate, periodStart, periodEnd]
    );
    const payoutId = payoutResult.rows[0].payout_id;

    const contribs = await contributionsForPool(client, targetPool, periodStart, periodEnd);
    const totalContribution = contribs.reduce((sum, c) => sum + c.contribution, 0);

    for (const c of contribs) {
      if (totalContribution <= 0 || c.contribution <= 0) continue;
      const sharePct = c.contribution / totalContribution;
      const gross = Number(totalCryptoReward1) * sharePct;
      const fee = gross * PROTOCOL_FEE_PCT;
      const net = gross - fee;

      await client.query(
        `INSERT INTO user_rewards_ledger
           (user_id, payout_id, calculated_reward_1, protocol_fee_taken, status,
            weighted_contribution, total_contribution, share_pct)
         VALUES ($1, $2, $3, $4, 'UNCLAIMED', $5, $6, $7)`,
        [c.user_id, payoutId, net, fee, c.contribution, totalContribution, sharePct]
      );
      await client.query(
        'INSERT INTO protocol_revenue_ledger (source_user_id, amount_usdc, transaction_type) VALUES ($1, $2, $3)',
        [c.user_id, fee, 'MINING_REWARD_FEE']
      );
    }

    await client.query(
      'UPDATE real_pool_payouts SET total_contribution = $1 WHERE payout_id = $2',
      [totalContribution, payoutId]
    );

    await client.query('COMMIT');
    return {
      payout_id: payoutId,
      participants: contribs.length,
      total_contribution: totalContribution,
      period_start: periodStart.toISOString(),
      period_end: periodEnd.toISOString(),
    };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Reward distribution error:', err);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Reward webhook — external trigger (pool payout notification). Validates the
 * request, then delegates to distributePayout.
 */
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

  try {
    const result = await distributePayout(target_pool, total_crypto_reward_1, total_network_hashrate);
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error('Reward webhook error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { handleRewardWebhook, distributePayout, PROTOCOL_FEE_PCT };
