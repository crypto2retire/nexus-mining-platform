const axios = require('axios');
const { pool } = require('../config/db');

/**
 * Rewards / payout controller.
 *
 * - GET  /api/rewards            — per-payout ledger with contribution & share
 * - POST /api/rewards/claim      — UNCLAIMED rewards → USDC balance (live price,
 *                                  5% fee already taken at distribution time)
 * - POST /api/rewards/withdraw   — request cash-out of USDC balance to a wallet
 *                                  (creates a PENDING request; the operator pays
 *                                  from the platform treasury and marks PAID)
 */

const POOL_COINGECKO = {
  ZCASH: 'zcash',
  KASPA: 'kaspa',
  LTC_DOGE: 'litecoin',
  XMR: 'monero',
};

function round4(n) {
  return Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;
}

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

function validWallet(wallet) {
  return typeof wallet === 'string' && /^0x[a-f0-9]{40}$/i.test(wallet);
}

/** GET /api/rewards?wallet=... — per-payout ledger for the connected wallet. */
async function getRewards(req, res) {
  const walletAddress = (req.query.wallet || '').toLowerCase();
  if (!validWallet(walletAddress)) {
    return res.status(400).json({ error: 'Valid wallet address is required' });
  }
  try {
    const user = await pool.query('SELECT user_id FROM users WHERE LOWER(wallet_address) = $1', [walletAddress]);
    if (user.rowCount === 0) {
      return res.json({ rewards: [], totals: { pending_usdc: 0, claimed_usdc: 0, pending_by_pool: {} } });
    }
    const userId = user.rows[0].user_id;

    const { rows } = await pool.query(
      `SELECT l.ledger_id, l.calculated_reward_1, l.protocol_fee_taken, l.status,
              l.weighted_contribution, l.total_contribution, l.share_pct,
              l.claimed_usdc, l.claimed_at,
              p.target_pool, p.total_crypto_reward_1, p.period_start, p.period_end,
              p.payout_timestamp
         FROM user_rewards_ledger l
         JOIN real_pool_payouts p USING (payout_id)
        WHERE l.user_id = $1
        ORDER BY p.payout_timestamp DESC`,
      [userId]
    );

    const rewards = rows.map((r) => ({
      ledger_id: r.ledger_id,
      target_pool: r.target_pool,
      reward_coin: Number(r.calculated_reward_1),
      fee_coin: Number(r.protocol_fee_taken),
      status: r.status,
      weighted_contribution: Number(r.weighted_contribution),
      total_contribution: Number(r.total_contribution),
      share_pct: Number(r.share_pct),
      claimed_usdc: Number(r.claimed_usdc),
      claimed_at: r.claimed_at,
      payout: {
        total_coin: Number(r.total_crypto_reward_1),
        period_start: r.period_start,
        period_end: r.period_end,
        at: r.payout_timestamp,
      },
    }));

    const pendingByPool = {};
    let pendingUsdc = 0;
    let claimedUsdc = 0;
    for (const r of rewards) {
      if (r.status === 'UNCLAIMED') {
        pendingByPool[r.target_pool] = round4((pendingByPool[r.target_pool] || 0) + r.reward_coin);
      } else if (r.status === 'CLAIMED') {
        claimedUsdc = round4(claimedUsdc + r.claimed_usdc);
      }
    }

    return res.json({
      rewards,
      totals: {
        pending_by_pool: pendingByPool,
        claimed_usdc: claimedUsdc,
      },
    });
  } catch (err) {
    console.error('Get rewards error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/** POST /api/rewards/claim — convert UNCLAIMED rewards to USDC balance. */
async function claimRewards(req, res) {
  const walletAddress = (req.body.wallet || '').toLowerCase();
  if (!validWallet(walletAddress)) {
    return res.status(400).json({ error: 'Valid wallet address is required' });
  }
  let targetPool = req.body.target_pool || null;
  if (targetPool && !POOL_COINGECKO[targetPool]) {
    return res.status(400).json({ error: 'Invalid target_pool' });
  }

  // 1. Find the user (no locks yet).
  const userResult = await pool.query(
    'SELECT user_id FROM users WHERE LOWER(wallet_address) = $1',
    [walletAddress]
  );
  if (userResult.rowCount === 0) {
    return res.status(404).json({ error: 'User not found' });
  }
  const userId = userResult.rows[0].user_id;

  // 2. Which pools actually have UNCLAIMED rows? Fetch prices ONLY for those
  //    (never block a claim because an unrelated pool's price is down).
  const poolParams = targetPool ? [userId, targetPool] : [userId];
  const poolFilter = targetPool ? 'AND p.target_pool = $2' : '';
  const pendingPoolsResult = await pool.query(
    `SELECT DISTINCT p.target_pool
       FROM user_rewards_ledger l
       JOIN real_pool_payouts p USING (payout_id)
      WHERE l.user_id = $1 AND l.status = 'UNCLAIMED' ${poolFilter}`,
    poolParams
  );
  const pendingPools = pendingPoolsResult.rows.map((r) => r.target_pool);
  if (pendingPools.length === 0) {
    return res.json({ success: true, claimed_usdc: 0, message: 'Nothing to claim' });
  }

  const prices = {};
  try {
    for (const p of pendingPools) {
      prices[p] = await fetchCoinUsdPrice(p);
    }
  } catch (err) {
    return res.status(502).json({ error: `Price oracle unavailable: ${err.message}` });
  }

  // 3. Claim transaction (re-checks + locks so a concurrent claim can't double-spend).
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const lockedUser = await client.query(
      'SELECT user_id FROM users WHERE LOWER(wallet_address) = $1 FOR UPDATE',
      [walletAddress]
    );
    if (lockedUser.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found' });
    }

    const walletResult = await client.query(
      'SELECT wallet_id FROM user_wallets WHERE user_id = $1 FOR UPDATE',
      [userId]
    );
    if (walletResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Wallet not found' });
    }
    const walletId = walletResult.rows[0].wallet_id;

    const params = targetPool ? [userId, targetPool] : [userId];
    const ledgerFilter = targetPool ? 'AND p.target_pool = $2' : '';
    const ledgerResult = await client.query(
      `SELECT l.ledger_id, l.calculated_reward_1, p.target_pool
         FROM user_rewards_ledger l
         JOIN real_pool_payouts p USING (payout_id)
        WHERE l.user_id = $1 AND l.status = 'UNCLAIMED' ${ledgerFilter}
        FOR UPDATE OF l`,
      params
    );
    if (ledgerResult.rowCount === 0) {
      await client.query('COMMIT');
      return res.json({ success: true, claimed_usdc: 0, message: 'Nothing to claim' });
    }

    let totalUsdc = 0;
    const claims = [];
    for (const row of ledgerResult.rows) {
      const price = prices[row.target_pool];
      if (!price) {
        await client.query('ROLLBACK');
        return res.status(502).json({ error: `Price oracle unavailable for ${row.target_pool}` });
      }
      const usdc = round4(Number(row.calculated_reward_1) * price);
      totalUsdc = round4(totalUsdc + usdc);
      claims.push({ ledger_id: row.ledger_id, usdc, pool: row.target_pool });
    }

    for (const c of claims) {
      await client.query(
        `UPDATE user_rewards_ledger
            SET status = 'CLAIMED', claimed_usdc = $2, claimed_at = CURRENT_TIMESTAMP
          WHERE ledger_id = $1`,
        [c.ledger_id, c.usdc]
      );
    }
    await client.query(
      'UPDATE user_wallets SET usdc_balance = usdc_balance + $1, updated_at = CURRENT_TIMESTAMP WHERE wallet_id = $2',
      [totalUsdc, walletId]
    );

    await client.query('COMMIT');
    return res.json({
      success: true,
      claimed_usdc: totalUsdc,
      rows: claims.length,
      pools: [...new Set(claims.map((c) => c.pool))],
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Claim rewards error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
}

/** POST /api/rewards/withdraw — request cash-out of USDC balance. */
async function withdrawRewards(req, res) {
  const walletAddress = (req.body.wallet || '').toLowerCase();
  const amount = Number(req.body.amount_usdc);
  const toAddress = (req.body.to_address || '').toLowerCase();

  if (!validWallet(walletAddress)) {
    return res.status(400).json({ error: 'Valid wallet address is required' });
  }
  if (!validWallet(toAddress)) {
    return res.status(400).json({ error: 'Valid destination address is required (0x + 40 characters)' });
  }
  if (!(amount > 0)) {
    return res.status(400).json({ error: 'amount_usdc must be positive' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

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
    if (walletResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Wallet not found' });
    }
    const walletId = walletResult.rows[0].wallet_id;
    const balance = Number(walletResult.rows[0].usdc_balance);
    if (balance < amount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Insufficient USDC balance (have ${balance.toFixed(4)}, need ${amount.toFixed(4)})` });
    }

    await client.query(
      'UPDATE user_wallets SET usdc_balance = usdc_balance - $1, updated_at = CURRENT_TIMESTAMP WHERE wallet_id = $2',
      [amount, walletId]
    );
    const reqResult = await client.query(
      `INSERT INTO withdrawal_requests (user_id, amount_usdc, to_address, status)
       VALUES ($1, $2, $3, 'PENDING')
       RETURNING withdrawal_id`,
      [userId, amount, toAddress]
    );

    await client.query('COMMIT');
    return res.json({
      success: true,
      withdrawal_id: reqResult.rows[0].withdrawal_id,
      amount_usdc: amount,
      status: 'PENDING',
      message: 'Withdrawal request received. The platform operator will process it from the treasury.',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Withdraw rewards error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
}

module.exports = { getRewards, claimRewards, withdrawRewards, fetchCoinUsdPrice, POOL_COINGECKO };
