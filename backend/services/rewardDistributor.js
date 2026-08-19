const axios = require('axios');
const { pool } = require('../config/db');
const { contributionsForPool } = require('./rigHistory');
const { coinsOwnedFor, discountPctFor } = require('./multiCoinDiscount');

const PROTOCOL_FEE_PCT = 0.05;

function toSatPrecision(value) {
  return parseFloat(Number(value).toFixed(8));
}

/**
 * GoMiner-style maintenance: buying a miner includes its hashrate forever,
 * but each payout first pays the miner's own running cost (maintenance +
 * electricity) — deducted per GH/s per day from the pool's maintenance rate
 * table. If a payout can't cover the miner's maintenance, the miner goes
 * DORMANT (GoMiner "paused"): it stops contributing hashrate until the owner
 * grows it (upgrade) or tops up (deposit).
 */

const POOL_COINGECKO = {
  ZCASH: 'zcash',
  KASPA: 'kaspa',
  LTC_DOGE: 'litecoin',
  XMR: 'monero',
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

/** USDC per GH/s per day from the operator-tunable rates table (0 = unset). */
async function maintenanceRateUsdcPerGhsDay(queryable, targetPool) {
  const { rows } = await queryable.query(
    'SELECT usdc_per_ghs_per_day FROM pool_maintenance_rates WHERE pool = $1',
    [targetPool]
  );
  return rows.length > 0 ? Number(rows[0].usdc_per_ghs_per_day) : 0;
}

/** Whether the owner explicitly OK'd mining at a loss (009_mine_at_loss). */
async function mineAtLossEnabled(queryable, userId, targetPool) {
  const { rows } = await queryable.query(
    'SELECT mine_at_loss FROM virtual_rigs WHERE user_id = $1 AND target_pool = $2',
    [userId, targetPool]
  );
  return rows.length > 0 && rows[0].mine_at_loss === true;
}

/** GoMiner auto-pause: miner stops contributing until grown or topped up. */
async function goDormant(client, userId, targetPool, net, maintenanceUsdc) {
  await client.query(
    `UPDATE virtual_rigs
        SET maintenance_status = 'DORMANT', dormant_at = CURRENT_TIMESTAMP
      WHERE user_id = $1 AND target_pool = $2`,
    [userId, targetPool]
  );
  // Zero the contribution going forward so a dormant miner stops
  // earning shares (and stops being charged) until resumed.
  await client.query(
    'INSERT INTO rig_hashrate_history (user_id, target_pool, hashrate) VALUES ($1, $2, 0)',
    [userId, targetPool]
  );
  console.log(`⏸ Miner ${userId}/${targetPool} went DORMANT — payout ${net.toFixed(8)} couldn't cover maintenance ${maintenanceUsdc.toFixed(8)} USDC`);
}

/**
 * Core distribution: split a real pool payout among users proportional to
 * their time-weighted hashrate contribution during the payout period, AFTER
 * deducting each miner's own maintenance (rate × hashrate × days).
 *
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

    // Maintenance is priced in USDC but rewards are in coin — convert the fee
    // at the live coin price. If the price feed is down we still distribute
    // the payout (real coins must never sit) but skip the maintenance
    // deduction for this period and log the gap for the operator.
    const rateUsdc = await maintenanceRateUsdcPerGhsDay(client, targetPool);
    let coinPrice = null;
    if (rateUsdc > 0) {
      try {
        coinPrice = await fetchCoinUsdPrice(targetPool);
      } catch (err) {
        console.warn(`${targetPool}: price feed down (${err.message}) — maintenance SKIPPED for payout ${payoutId}; fee still booked`);
      }
    }
    const periodHours = Math.max((periodEnd.getTime() - periodStart.getTime()) / 3600000, 0);
    const periodDays = periodHours / 24;

    for (const c of contribs) {
      if (totalContribution <= 0 || c.contribution <= 0) continue;
      const sharePct = c.contribution / totalContribution;
      const gross = Number(totalCryptoReward1) * sharePct;
      const fee = gross * PROTOCOL_FEE_PCT;

      // Average hashrate over the period = hashrate-hours / hours held.
      const avgGhs = periodHours > 0 ? c.contribution / periodHours : 0;
      // Multi-coin loyalty: the more coins a user mines, the lower their
      // ongoing running cost (2/3/4 coins -> 5/10/15% off maintenance).
      const coinsOwned = await coinsOwnedFor(client, c.user_id);
      const maintDiscount = discountPctFor(coinsOwned);
      const maintenanceUsdc = avgGhs * rateUsdc * periodDays * (1 - maintDiscount / 100);
      const maintenanceCoin =
        coinPrice && maintenanceUsdc > 0 ? maintenanceUsdc / coinPrice : 0;

      // A miner that can't cover its own running cost nets zero and goes
      // DORMANT (stops contributing until upgraded or topped up).
      const remainingAfterFee = gross - fee;
      const deductMaintenance = Math.min(maintenanceCoin, Math.max(remainingAfterFee, 0));
      const net = remainingAfterFee - deductMaintenance;
      const shortfall = maintenanceCoin > remainingAfterFee + 1e-12;

      await client.query(
        `INSERT INTO user_rewards_ledger
          (user_id, payout_id, calculated_reward_1, protocol_fee_taken, status,
           weighted_contribution, total_contribution, share_pct, maintenance_fee_1)
         VALUES ($1, $2, $3, $4, 'UNCLAIMED', $5, $6, $7, $8)`,
        [c.user_id, payoutId, net, fee, c.contribution, totalContribution, sharePct, deductMaintenance]
      );
      await client.query(
        'INSERT INTO protocol_revenue_ledger (source_user_id, amount_usdc, transaction_type) VALUES ($1, $2, $3)',
        [c.user_id, fee, 'MINING_REWARD_FEE']
      );

      // Audit trail: exactly what was charged and for what hashrate/period.
      if (deductMaintenance > 0) {
        const maintenanceUsdcActual = deductMaintenance * coinPrice;
        await client.query(
          `INSERT INTO maintenance_fee_ledger
            (payout_id, user_id, target_pool, hashrate_ghs, days, amount_usdc)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [payoutId, c.user_id, targetPool, avgGhs, periodDays, maintenanceUsdcActual]
        );
      }

      // GoMiner pause: payout couldn't cover the miner's running cost.
      if (shortfall && avgGhs > 0) {
        const shortfallCoin = maintenanceCoin - deductMaintenance;
        const shortfallUsdc = shortfallCoin * (coinPrice || 0);

        // Opt-in (009): the owner explicitly OK'd mining at a loss. The
        // shortfall is charged to their USDC balance — the platform never
        // fronts ongoing mining costs. If the balance can't cover it, the
        // miner still goes DORMANT: users can never be driven negative.
        const okLoss = await mineAtLossEnabled(client, c.user_id, targetPool);
        if (okLoss && coinPrice && shortfallUsdc > 0) {
          const walletResult = await client.query(
            'SELECT wallet_id, usdc_balance FROM user_wallets WHERE user_id = $1 FOR UPDATE',
            [c.user_id]
          );
          const wallet = walletResult.rows[0];
          if (wallet && Number(wallet.usdc_balance) >= shortfallUsdc) {
            await client.query(
              'UPDATE user_wallets SET usdc_balance = $1, updated_at = CURRENT_TIMESTAMP WHERE wallet_id = $2',
              [toSatPrecision(Number(wallet.usdc_balance) - shortfallUsdc), wallet.wallet_id]
            );
            // Audit trail: the USDC-funded portion of this maintenance charge.
            await client.query(
              `INSERT INTO maintenance_fee_ledger
                (payout_id, user_id, target_pool, hashrate_ghs, days, amount_usdc, source)
               VALUES ($1, $2, $3, $4, $5, $6, 'USDC')`,
              [payoutId, c.user_id, targetPool, avgGhs, periodDays, shortfallUsdc]
            );
            console.log(`⚠️ Miner ${c.user_id}/${targetPool} OK'd loss — ${shortfallUsdc.toFixed(4)} USDC shortfall charged to balance`);
            continue;
          }
        }

        await goDormant(client, c.user_id, targetPool, net, maintenanceUsdc);
      }
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
