const axios = require('axios');
const { pool } = require('../config/db');
const { contributionsForPool, logRealHashChange, realHashHoursForPool } = require('./rigHistory');
const { fetchLiveRealHash } = require('./roomHash');

const PROTOCOL_FEE_PCT = 0.05;

function toSatPrecision(value) {
  return parseFloat(Number(value).toFixed(8));
}

/**
 * HYBRID session model (2026-08-20, Kevin's call):
 *
 *   - 72h purchases rent a brand-new real MRR rig; the buyer's credit (tier
 *     hashrate, e.g. 25 GH/s) is a slice of that rig. The rig's REMAINING
 *     real hashrate becomes room inventory (sellable spare).
 *   - Short sessions (1h-24h) are slices of the room's REAL running hashrate
 *     — no new marketplace rental. Oversell guard: credit may never exceed
 *     what the pool wallet reports.
 *   - Every payout splits by  (credit hash-hours) / (REAL rig hash-hours).
 *     Each holder gets exactly the coins their slice mined (95%, 5% fee).
 *     The platform keeps the residual — the operator baseline plus unsold
 *     capacity — booked as UNSOLD_CAPACITY in protocol_revenue_ledger.
 *   - NO maintenance deduction, NO DORMANT, NO mine-at-loss. A rig whose
 *     window passed contributes 0 (expiry sweeper).
 */

const POOL_COINGECKO = {
  ZCASH: 'zcash',
  KASPA: 'kaspa',
  LTC_DOGE: 'litecoin',
  XMR: 'monero',
  // Synthetic key: the DOGE side of the LTC_DOGE merged pool.
  LTC_DOGE_DOGE: 'dogecoin',
};

async function fetchCoinUsdPrice(targetPool) {
  const cgId = POOL_COINGECKO[targetPool];
  if (!cgId) throw new Error(`No price feed for ${targetPool}`);
  const res = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
    params: { ids: cgId, vs_currencies: 'usd' },
    timeout: 12000,
  });
  const price = res.data?.[cgId]?.usd;
  if (typeof price !== 'number' || !(price > 0)) {
    throw new Error(`Price oracle unavailable for ${targetPool}`);
  }
  return price;
}

/**
 * Book the platform's residual (unsold capacity + operator baseline) as
 * platform revenue. source_user_id stays NULL — the row is platform-level,
 * not attributable to a player. amount_usdc is 0 when no price is available
 * (the coins physically remain in the platform wallet; the USDC booking can
 * be backfilled later).
 */
async function bookUnsoldResidual(client, amountCoin, coinUsdPrice, transactionType) {
  if (!(amountCoin > 0)) return;
  const usdc = coinUsdPrice > 0 ? parseFloat((amountCoin * coinUsdPrice).toFixed(4)) : 0;
  await client.query(
    `INSERT INTO protocol_revenue_ledger (source_user_id, amount_usdc, transaction_type)
     VALUES (NULL, $1, $2)`,
    [usdc, transactionType]
  );
}

/**
 * Core distribution: split a real pool payout among users proportional to
 * their time-weighted hashrate credit over the payout period, divided by the
 * ROOM'S REAL hash-hours (hybrid model). The residual stays with the platform.
 */
async function distributePayout(targetPool, totalCryptoReward1, totalNetworkHashrate) {
  // Network I/O stays OUTSIDE the transaction (never hold row locks during it):
  // 1) live real hashrate to refresh the denominator ledger,
  // 2) coin price for residual booking (best-effort).
  let realHashNow = null;
  try {
    let activeRentals = [];
    if (targetPool === 'LTC_DOGE') {
      const r = await pool.query(
        "SELECT mrr_rental_id FROM rig_rentals WHERE target_pool = 'LTC_DOGE' AND status = 'ACTIVE'"
      );
      activeRentals = r.rows;
    }
    realHashNow = await fetchLiveRealHash(targetPool, activeRentals);
  } catch (err) {
    console.warn(`distribute: live real hash fetch failed for ${targetPool}: ${err.message}`);
  }
  let coinUsdPrice = 0;
  try {
    coinUsdPrice = await fetchCoinUsdPrice(targetPool);
  } catch (err) {
    console.warn(`distribute: price feed down for ${targetPool} — residual booked at 0 USDC: ${err.message}`);
  }

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

    // Record what the room was REALLY delivering at payout time (fair-slice
    // denominator ledger). A failed live fetch leaves the last known row.
    if (realHashNow != null) {
      try {
        await logRealHashChange(client, targetPool, realHashNow);
      } catch (logErr) {
        console.warn(`distribute: could not log real hash for ${targetPool}: ${logErr.message}`);
      }
    }

    const contribs = await contributionsForPool(client, targetPool, periodStart, periodEnd);
    const totalContribution = contribs.reduce((sum, c) => sum + c.contribution, 0);

    // DENOMINATOR: real hash-hours (hybrid). Fallback to virtual sum only
    // when no real measurement exists yet (fresh rollout) — log it loudly.
    const realHashHours = await realHashHoursForPool(client, targetPool, periodStart, periodEnd);
    const denominator = realHashHours > 0 ? realHashHours : totalContribution;
    if (realHashHours <= 0) {
      console.warn(
        `distribute: ${targetPool} has no real-hash measurements yet — falling back to virtual denominator (${totalContribution}). Install 014 + let the backing monitor run before relying on slices.`
      );
    }

    let totalNet = 0;
    for (const c of contribs) {
      if (denominator <= 0 || c.contribution <= 0) continue;
      const sharePct = c.contribution / denominator;
      const gross = Number(totalCryptoReward1) * sharePct;
      const fee = gross * PROTOCOL_FEE_PCT;
      const net = gross - fee;
      totalNet += net;

      await client.query(
        `INSERT INTO user_rewards_ledger
          (user_id, payout_id, calculated_reward_1, protocol_fee_taken, status,
           weighted_contribution, total_contribution, share_pct, maintenance_fee_1)
         VALUES ($1, $2, $3, $4, 'UNCLAIMED', $5, $6, $7, 0)`,
        [c.user_id, payoutId, net, fee, c.contribution, denominator, sharePct]
      );
      await client.query(
        'INSERT INTO protocol_revenue_ledger (source_user_id, amount_usdc, transaction_type) VALUES ($1, $2, $3)',
        [c.user_id, fee, 'MINING_REWARD_FEE']
      );
    }

    // Residual = what the room produced that no holder's credit covers —
    // the operator baseline + unsold capacity. It stays in the platform
    // wallet; booked here as platform revenue.
    const residualCoin = Number(totalCryptoReward1) - totalNet;
    if (residualCoin > 0) {
      await bookUnsoldResidual(client, residualCoin, coinUsdPrice, 'UNSOLD_CAPACITY');
    }

    await client.query(
      'UPDATE real_pool_payouts SET total_contribution = $1 WHERE payout_id = $2',
      [denominator, payoutId]
    );

    await client.query('COMMIT');
    return {
      payout_id: payoutId,
      participants: contribs.length,
      total_contribution: denominator,
      residual_coin: toSatPrecision(residualCoin),
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
 * Merged mining distribution (011): F2Pool pays the DOGE side of the LTC_DOGE
 * pool separately. Same hybrid math as distributePayout — pro-rata by the
 * same time-weighted contributions over REAL hash-hours, 95/5 split, tracked
 * in calculated_reward_2 (DOGE units) so it never mixes with the LTC amounts.
 * The residual is booked in USDC at the live DOGE price when available.
 */
async function distributeMergedReward(targetPool, totalCryptoReward2, totalNetworkHashrate) {
  let realHashNow = null;
  try {
    const r = await pool.query(
      "SELECT mrr_rental_id FROM rig_rentals WHERE target_pool = 'LTC_DOGE' AND status = 'ACTIVE'"
    );
    realHashNow = await fetchLiveRealHash('LTC_DOGE', r.rows);
  } catch (err) {
    console.warn(`distributeMerged: live real hash fetch failed: ${err.message}`);
  }
  let dogePrice = null;
  try {
    dogePrice = await fetchCoinUsdPrice('LTC_DOGE_DOGE');
  } catch (err) {
    console.warn(`LTC_DOGE: DOGE price feed down (${err.message}) — fee/residual not converted for this payout`);
  }

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
        (target_pool, total_crypto_reward_1, total_crypto_reward_2, total_network_hashrate, period_start, period_end)
       VALUES ($1, 0, $2, $3, $4, $5)
       RETURNING payout_id`,
      [targetPool, totalCryptoReward2, totalNetworkHashrate, periodStart, periodEnd]
    );
    const payoutId = payoutResult.rows[0].payout_id;

    if (realHashNow != null) {
      try {
        await logRealHashChange(client, 'LTC_DOGE', realHashNow);
      } catch (logErr) {
        console.warn(`distributeMerged: could not log real hash: ${logErr.message}`);
      }
    }

    const contribs = await contributionsForPool(client, targetPool, periodStart, periodEnd);
    const totalContribution = contribs.reduce((sum, c) => sum + c.contribution, 0);
    const realHashHours = await realHashHoursForPool(client, 'LTC_DOGE', periodStart, periodEnd);
    const denominator = realHashHours > 0 ? realHashHours : totalContribution;
    if (realHashHours <= 0) {
      console.warn(
        `distributeMerged: ${targetPool} has no real-hash measurements yet — falling back to virtual denominator (${totalContribution}).`
      );
    }

    let totalNet = 0;
    for (const c of contribs) {
      if (denominator <= 0 || c.contribution <= 0) continue;
      const sharePct = c.contribution / denominator;
      const gross = Number(totalCryptoReward2) * sharePct;
      const fee = gross * PROTOCOL_FEE_PCT;
      const net = gross - fee;
      totalNet += net;

      await client.query(
        `INSERT INTO user_rewards_ledger
          (user_id, payout_id, calculated_reward_1, calculated_reward_2, protocol_fee_taken, status,
           weighted_contribution, total_contribution, share_pct)
         VALUES ($1, $2, 0, $3, $4, 'UNCLAIMED', $5, $6, $7)`,
        [c.user_id, payoutId, net, fee, c.contribution, denominator, sharePct]
      );

      if (dogePrice && fee > 0) {
        await client.query(
          'INSERT INTO protocol_revenue_ledger (source_user_id, amount_usdc, transaction_type) VALUES ($1, $2, $3)',
          [c.user_id, parseFloat((fee * dogePrice).toFixed(4)), 'MINING_REWARD_FEE']
        );
      }
    }

    const residualCoin = Number(totalCryptoReward2) - totalNet;
    if (residualCoin > 0) {
      await bookUnsoldResidual(client, residualCoin, dogePrice || 0, 'UNSOLD_CAPACITY');
    }

    await client.query(
      'UPDATE real_pool_payouts SET total_contribution = $1 WHERE payout_id = $2',
      [denominator, payoutId]
    );

    await client.query('COMMIT');
    return {
      payout_id: payoutId,
      participants: contribs.length,
      total_contribution: denominator,
      residual_coin: toSatPrecision(residualCoin),
      period_start: periodStart.toISOString(),
      period_end: periodEnd.toISOString(),
    };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Merged reward distribution error:', err);
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

module.exports = { handleRewardWebhook, distributePayout, distributeMergedReward, PROTOCOL_FEE_PCT };
