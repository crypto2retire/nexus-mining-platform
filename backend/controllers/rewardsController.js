const axios = require('axios');
const { pool } = require('../config/db');

/**
 * Shared helper: convert a user's UNCLAIMED rewards for ONE pool to USDC
 * balance at the given live price. Must be called inside an open transaction
 * with the user + wallet rows locked.
 * dogePrice: only used for LTC_DOGE rows with a merged DOGE portion
 * (calculated_reward_2).
 * @returns {Promise<number>} total USDC credited
 */
async function claimPoolRewardsInTx(client, userId, walletId, targetPool, price, dogePrice = 0) {
  const ledgerResult = await client.query(
    `SELECT l.ledger_id, l.calculated_reward_1, l.calculated_reward_2
       FROM user_rewards_ledger l
       JOIN real_pool_payouts p USING (payout_id)
      WHERE l.user_id = $1 AND l.status = 'UNCLAIMED' AND l.withdrawal_id IS NULL
        AND p.target_pool = $2
      FOR UPDATE OF l`,
    [userId, targetPool]
  );
  if (ledgerResult.rowCount === 0) return 0;

  let totalUsdc = 0;
  for (const row of ledgerResult.rows) {
    const usdc = round4(Number(row.calculated_reward_1) * price + Number(row.calculated_reward_2 || 0) * dogePrice);
    totalUsdc = round4(totalUsdc + usdc);
    await client.query(
      `UPDATE user_rewards_ledger
          SET status = 'CLAIMED', claimed_usdc = $2, claimed_at = CURRENT_TIMESTAMP
        WHERE ledger_id = $1`,
      [row.ledger_id, usdc]
    );
  }
  await client.query(
    'UPDATE user_wallets SET usdc_balance = usdc_balance + $1, updated_at = CURRENT_TIMESTAMP WHERE wallet_id = $2',
    [totalUsdc, walletId]
  );
  return totalUsdc;
}

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
  // Synthetic key: the DOGE side of the LTC_DOGE merged pool.
  LTC_DOGE_DOGE: 'dogecoin',
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

/** GET /api/rewards — per-payout ledger for the authenticated wallet. */
async function getRewards(req, res) {
  const walletAddress = req.auth.wallet;
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
              l.claimed_usdc, l.claimed_at, l.withdrawal_id,
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
      withdrawal_id: r.withdrawal_id || null,
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
    const withdrawableByPool = {};
    let pendingUsdc = 0;
    let claimedUsdc = 0;
    for (const r of rewards) {
      if (r.status === 'UNCLAIMED') {
        if (r.withdrawal_id) {
          // Held by a PENDING withdrawal request — not claimable, not
          // withdrawable again.
        } else {
          pendingByPool[r.target_pool] = round4((pendingByPool[r.target_pool] || 0) + r.reward_coin);
          withdrawableByPool[r.target_pool] = round4((withdrawableByPool[r.target_pool] || 0) + r.reward_coin);
        }
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
      // What each pool still owes in mined tokens (withdrawable) vs held by
      // pending withdrawal requests.
      withdrawable_by_pool: withdrawableByPool,
    });
  } catch (err) {
    console.error('Get rewards error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/** POST /api/rewards/claim — convert UNCLAIMED rewards to USDC balance. */
async function claimRewards(req, res) {
  const walletAddress = req.auth.wallet;
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
      WHERE l.user_id = $1 AND l.status = 'UNCLAIMED' AND l.withdrawal_id IS NULL ${poolFilter}`,
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
      // The merged DOGE side needs its own price for the claim conversion.
      if (p === 'LTC_DOGE') prices['LTC_DOGE_DOGE'] = await fetchCoinUsdPrice('LTC_DOGE_DOGE');
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
      `SELECT l.ledger_id, l.calculated_reward_1, l.calculated_reward_2, p.target_pool
         FROM user_rewards_ledger l
         JOIN real_pool_payouts p USING (payout_id)
        WHERE l.user_id = $1 AND l.status = 'UNCLAIMED' AND l.withdrawal_id IS NULL ${ledgerFilter}
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
      const dogePrice = row.target_pool === 'LTC_DOGE' ? (prices['LTC_DOGE_DOGE'] || 0) : 0;
      if (row.target_pool === 'LTC_DOGE' && Number(row.calculated_reward_2 || 0) > 0 && !dogePrice) {
        await client.query('ROLLBACK');
        return res.status(502).json({ error: 'Price oracle unavailable for dogecoin' });
      }
      const usdc = round4(Number(row.calculated_reward_1) * price + Number(row.calculated_reward_2 || 0) * dogePrice);
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

/**
 * POST /api/rewards/withdraw — request cash-out of UNCLAIMED rewards in the
 * mined token the user earned (e.g. withdraw ZEC for ZEC rewards). Creates a
 * PENDING request and holds the matching ledger rows so they cannot be
 * claimed or withdrawn again. The operator sends the coin from the platform
 * wallet and marks the request PAID.
 */
const ADDRESS_RULES = {
  ZCASH: /^t1[a-zA-Z0-9]{33}$/,
  KASPA: /^kaspa:[a-z0-9]{60,64}$/i,
  LTC_DOGE: /^(ltc1[a-z0-9]{38}|[LM3][a-zA-Z0-9]{33})$/i,
  XMR: /^4[0-9AB][1-9A-HJ-NP-Za-km-z]{93}$/,
};

async function withdrawRewards(req, res) {
  const walletAddress = req.auth.wallet;
  const targetPool = req.body.target_pool;
  const amountCoin = Number(req.body.amount_coin);
  const toAddress = String(req.body.to_address || '').trim();

  if (!validWallet(walletAddress)) {
    return res.status(400).json({ error: 'Valid wallet address is required' });
  }
  if (!ADDRESS_RULES[targetPool]) {
    return res.status(400).json({ error: 'Invalid target_pool' });
  }
  if (!ADDRESS_RULES[targetPool].test(toAddress)) {
    return res.status(400).json({
      error: `Invalid ${targetPool} destination address (e.g. ${
        targetPool === 'ZCASH' ? 't1...' : targetPool === 'KASPA' ? 'kaspa:...' : targetPool === 'LTC_DOGE' ? 'ltc1...' : '4...'
      })`,
    });
  }
  if (!(amountCoin > 0)) {
    return res.status(400).json({ error: 'amount_coin must be positive' });
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

    // Available rewards for this pool = UNCLAIMED and not already held by a
    // withdrawal request. Lock them so a concurrent request can't over-hold.
    const available = await client.query(
      `SELECT l.ledger_id, l.calculated_reward_1
         FROM user_rewards_ledger l
         JOIN real_pool_payouts p USING (payout_id)
        WHERE l.user_id = $1 AND p.target_pool = $2
          AND l.status = 'UNCLAIMED' AND l.withdrawal_id IS NULL
        ORDER BY p.payout_timestamp
        FOR UPDATE OF l`,
      [userId, targetPool]
    );
    const totalAvailable = available.rows.reduce((s, r) => s + Number(r.calculated_reward_1), 0);
    if (totalAvailable < amountCoin) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Insufficient unclaimed ${targetPool} rewards (have ${totalAvailable.toFixed(8)}, need ${amountCoin.toFixed(8)})`,
      });
    }

    const reqResult = await client.query(
      `INSERT INTO withdrawal_requests (user_id, target_pool, amount_coin, to_address, status)
       VALUES ($1, $2, $3, $4, 'PENDING')
       RETURNING withdrawal_id`,
      [userId, targetPool, amountCoin, toAddress]
    );
    const withdrawalId = reqResult.rows[0].withdrawal_id;

    // Hold ledger rows FIFO until the requested amount is covered.
    let remaining = amountCoin;
    for (const row of available.rows) {
      if (remaining <= 0) break;
      const take = Math.min(Number(row.calculated_reward_1), remaining);
      remaining = Math.round((remaining - take) * 1e8) / 1e8;
      await client.query(
        `INSERT INTO withdrawal_allocations (withdrawal_id, ledger_id, amount_coin)
         VALUES ($1, $2, $3)`,
        [withdrawalId, row.ledger_id, take]
      );
      await client.query(
        'UPDATE user_rewards_ledger SET withdrawal_id = $1 WHERE ledger_id = $2',
        [withdrawalId, row.ledger_id]
      );
    }

    await client.query('COMMIT');
    return res.json({
      success: true,
      withdrawal_id: withdrawalId,
      target_pool: targetPool,
      amount_coin: amountCoin,
      to_address: toAddress,
      status: 'PENDING',
      message: `Withdrawal request received. The operator will send ${amountCoin} ${targetPool} to your address and mark it PAID.`,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Withdraw rewards error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
}

/** GET /api/rewards/withdrawals — operator view: all requests. */
async function listWithdrawals(_req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT w.withdrawal_id, w.user_id, u.wallet_address, w.target_pool,
              w.amount_coin, w.to_address, w.status, w.tx_hash, w.requested_at, w.processed_at
         FROM withdrawal_requests w
         LEFT JOIN users u USING (user_id)
        ORDER BY w.requested_at DESC
        LIMIT 200`
    );
    return res.json({ withdrawals: rows });
  } catch (err) {
    console.error('List withdrawals error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/** POST /api/rewards/withdrawals/:id/paid — operator marks a request paid. */
async function markWithdrawalPaid(req, res) {
  const id = req.params.id;
  const txHash = String(req.body.tx_hash || '').trim();
  if (!txHash) {
    return res.status(400).json({ error: 'tx_hash is required' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE withdrawal_requests
          SET status = 'PAID', tx_hash = $2, processed_at = CURRENT_TIMESTAMP
        WHERE withdrawal_id = $1 AND status = 'PENDING'
        RETURNING withdrawal_id`,
      [id, txHash]
    );
    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pending withdrawal not found' });
    }
    const allocations = await client.query(
      `SELECT a.ledger_id, a.amount_coin, l.calculated_reward_1
         FROM withdrawal_allocations a
         JOIN user_rewards_ledger l USING (ledger_id)
        WHERE a.withdrawal_id = $1
        FOR UPDATE OF l`,
      [id]
    );
    if (allocations.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Withdrawal allocations not found' });
    }
    for (const allocation of allocations.rows) {
      const allocated = Number(allocation.amount_coin);
      const fullReward = Number(allocation.calculated_reward_1);
      if (allocated >= fullReward) {
        await client.query(
          `UPDATE user_rewards_ledger
              SET status = 'PAID'
            WHERE ledger_id = $1`,
          [allocation.ledger_id]
        );
      } else {
        await client.query(
          `UPDATE user_rewards_ledger
              SET calculated_reward_1 = calculated_reward_1 - $2,
                  status = 'UNCLAIMED', withdrawal_id = NULL
            WHERE ledger_id = $1`,
          [allocation.ledger_id, allocated]
        );
      }
    }
    await client.query('COMMIT');
    return res.json({ success: true, withdrawal_id: id, status: 'PAID', tx_hash: txHash });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Mark withdrawal paid error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
}

/** POST /api/rewards/withdrawals/:id/reject — operator returns rewards to UNCLAIMED. */
async function rejectWithdrawal(req, res) {
  const id = req.params.id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE withdrawal_requests
          SET status = 'REJECTED', processed_at = CURRENT_TIMESTAMP
        WHERE withdrawal_id = $1 AND status = 'PENDING'
        RETURNING withdrawal_id`,
      [id]
    );
    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pending withdrawal not found' });
    }
    // Release only rows explicitly allocated to this request. Allocation rows
    // remain as the audit trail for the rejected request.
    await client.query(
      `UPDATE user_rewards_ledger
          SET status = 'UNCLAIMED', withdrawal_id = NULL
        WHERE withdrawal_id = $1
          AND ledger_id IN (
            SELECT ledger_id FROM withdrawal_allocations WHERE withdrawal_id = $1
          )`,
      [id]
    );
    await client.query('COMMIT');
    return res.json({ success: true, withdrawal_id: id, status: 'REJECTED' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Reject withdrawal error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
}

module.exports = {
  getRewards,
  claimRewards,
  withdrawRewards,
  listWithdrawals,
  markWithdrawalPaid,
  rejectWithdrawal,
  claimPoolRewardsInTx,
  fetchCoinUsdPrice,
  POOL_COINGECKO,
  ADDRESS_RULES,
};
