const { pool } = require('../config/db');
const { getLiveBtcPrice } = require('../services/priceOracle');

/**
 * Marketplace provider selection. Default = NiceHash. Set
 * MARKETPLACE_PROVIDER=mrr to route real hashpower orders through
 * MiningRigRentals instead. Both providers expose the same interface:
 * placeHashpowerOrder / getOrderStatus / POOL_ALGORITHM_MAP, plus
 * PROVIDER_NAME and LIVE_ORDERS_ENV for the production safety rail.
 */
function getRenter() {
  return (process.env.MARKETPLACE_PROVIDER || 'nicehash').toLowerCase() === 'mrr'
    ? require('../services/mrrRenter')
    : require('../services/hashrateRenter');
}

const UPGRADE_TIERS = [
  { level: 1, cost: 0, hashrate: 10 },
  { level: 2, cost: 50, hashrate: 25 },
  { level: 3, cost: 120, hashrate: 60 },
  { level: 4, cost: 300, hashrate: 150 },
  { level: 5, cost: 750, hashrate: 400 },
];

const PROTOCOL_FEE_PCT = 0.05;

function toSatPrecision(value) {
  return parseFloat(value.toFixed(8));
}

const ORDER_SELECT = `
  SELECT h.order_id, h.status, h.nicehash_order_id, h.sandbox, h.usdc_cost,
         h.protocol_fee_usdc, h.btc_spent, h.btc_spot_price, h.price_feed,
         h.price_is_usdc_pair, h.failure_reason, h.request_id, h.marketplace,
         r.level, r.virtual_hashrate
  FROM hashrate_orders h
  LEFT JOIN virtual_rigs r ON r.user_id = h.user_id AND r.target_pool = h.target_pool
`;

function duplicateResponse(row) {
  return {
    success: true,
    duplicated: true,
    order_status: row.status,
    nicehash_order_id: row.nicehash_order_id || null,
    marketplace: row.marketplace || null,
    btc_spent: Number(row.btc_spent),
    btc_spot_price: Number(row.btc_spot_price),
    price_feed: row.price_feed,
    protocol_fee_usdc: Number(row.protocol_fee_usdc),
    sandbox: Boolean(row.sandbox),
    level: row.level ? Number(row.level) : null,
    hashrate: row.virtual_hashrate ? Number(row.virtual_hashrate) : null,
    request_id: row.request_id,
  };
}

/**
 * Self-mined pool upgrade (XMR): no marketplace order, no USDC charge.
 * Records a SELF_MINING order row (idempotent on request_id) and levels the rig.
 */
async function upgradeSelfMinedRig(req, res) {
  const walletAddress = (req.body.wallet || '').toLowerCase();
  const targetPool = req.body.target_pool;
  const requestId = String(req.body.request_id || '').trim();

  if (targetPool !== 'XMR') {
    return res.status(400).json({ error: 'Self-mined upgrades are only available for XMR' });
  }

  const existing = await pool.query(`${ORDER_SELECT} WHERE h.request_id = $1`, [requestId]);
  if (existing.rowCount > 0) {
    return res.json(duplicateResponse(existing.rows[0]));
  }

  const client = await pool.connect();
  let nextTier = null;
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

    const rigResult = await client.query(
      'SELECT rig_id, level, virtual_hashrate FROM virtual_rigs WHERE user_id = $1 AND target_pool = $2 FOR UPDATE',
      [userId, targetPool]
    );
    const rig = rigResult.rows[0];
    const currentLevel = rig ? rig.level : 1;

    nextTier = UPGRADE_TIERS.find((t) => t.level === currentLevel + 1);
    if (!nextTier) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Already at max level' });
    }

    const orderInsert = await client.query(
      `INSERT INTO hashrate_orders
         (user_id, target_pool, request_id, usdc_cost, protocol_fee_usdc, btc_spent,
          btc_spot_price, price_feed, price_is_usdc_pair, algorithm, status, marketplace)
       VALUES ($1, $2, $3, 0, 0, 0, 0, 'self-mined', false, 'RANDOMX', 'SELF_MINING', 'SELF-MINED')
       ON CONFLICT (request_id) DO NOTHING
       RETURNING order_id`,
      [userId, targetPool, requestId]
    );
    if (orderInsert.rowCount === 0) {
      await client.query('ROLLBACK');
      const winner = await pool.query(`${ORDER_SELECT} WHERE h.request_id = $1`, [requestId]);
      return res.json(duplicateResponse(winner.rows[0]));
    }

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
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Self-mined upgrade error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  } finally {
    client.release();
  }

  return res.json({
    success: true,
    duplicated: false,
    level: nextTier.level,
    hashrate: nextTier.hashrate,
    remaining_balance: null,
    btc_spent: 0,
    btc_spot_price: null,
    protocol_fee_usdc: 0,
    nicehash_order_id: null,
    order_status: 'SELF_MINING',
    sandbox: false,
    request_id: requestId,
    note: 'Self-mined pool — no marketplace order placed, no USDC charged.',
  });
}

async function upgradeRig(req, res) {
  const walletAddress = (req.body.wallet || '').toLowerCase();
  const targetPool = req.body.target_pool;
  const requestId = String(req.body.request_id || '').trim();

  if (!walletAddress || !/^0x[a-f0-9]{40}$/i.test(walletAddress)) {
    return res.status(400).json({ error: 'Valid wallet address is required' });
  }
  if (!requestId || requestId.length > 64) {
    return res.status(400).json({ error: 'request_id is required (1-64 chars) for idempotent upgrades' });
  }

  // XMR is a SELF-MINED pool (operator-owned hardware) — no NiceHash order,
  // no USDC charge. Handled by its own idempotent flow.
  if (targetPool === 'XMR') {
    return upgradeSelfMinedRig(req, res);
  }

  if (!['ZCASH', 'KASPA', 'LTC_DOGE'].includes(targetPool)) {
    return res.status(400).json({ error: 'Invalid target pool' });
  }

  const renter = getRenter();
  const { placeHashpowerOrder, getOrderStatus, POOL_ALGORITHM_MAP } = renter;
  const providerName = renter.PROVIDER_NAME || 'NICEHASH';
  const liveOrdersEnv = renter.LIVE_ORDERS_ENV || 'NICEHASH_LIVE_ORDERS';

  // SAFETY RAIL: never move user funds unless a REAL marketplace order can be placed.
  if (process.env.NODE_ENV === 'production' && process.env[liveOrdersEnv] !== '1') {
    return res.status(503).json({
      error:
        `Live ${providerName} orders are not enabled. Set ${liveOrdersEnv}=1 after configuring ` +
        (providerName === 'MRR'
          ? 'MRR_API_KEY/MRR_API_SECRET'
          : 'NICEHASH_API_KEY/NICEHASH_API_SECRET/NICEHASH_ORG_ID') +
        '. No funds were moved.',
    });
  }

  // Idempotency: an identical request_id returns the stored result instead of
  // double-charging. The unique index (checked again inside the tx) makes this race-safe.
  const existing = await pool.query(`${ORDER_SELECT} WHERE h.request_id = $1`, [requestId]);
  if (existing.rowCount > 0) {
    return res.json(duplicateResponse(existing.rows[0]));
  }

  // Fetch the live BTC/USDC price BEFORE opening the transaction — never hold
  // row locks during network I/O.
  let quote;
  try {
    quote = await getLiveBtcPrice();
  } catch (err) {
    return res.status(502).json({ error: `Price oracle unavailable: ${err.message}` });
  }
  const btcSpotPrice = quote.price;

  const client = await pool.connect();
  let orderRecordId = null;
  let walletId = null;
  let newBalance = null;
  let nextTier = null;
  let protocolFeeUsdc = null;
  let spendBtcAmount = null;

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
    const wallet = walletResult.rows[0];
    walletId = wallet.wallet_id;

    const rigResult = await client.query(
      'SELECT rig_id, level, virtual_hashrate FROM virtual_rigs WHERE user_id = $1 AND target_pool = $2 FOR UPDATE',
      [userId, targetPool]
    );
    const rig = rigResult.rows[0];
    const currentLevel = rig ? rig.level : 1;

    nextTier = UPGRADE_TIERS.find((t) => t.level === currentLevel + 1);
    if (!nextTier) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Already at max level' });
    }
    if (Number(wallet.usdc_balance) < nextTier.cost) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient USDC balance' });
    }

    protocolFeeUsdc = toSatPrecision(nextTier.cost * PROTOCOL_FEE_PCT);
    const netPurchaseUsdc = toSatPrecision(nextTier.cost - protocolFeeUsdc);
    spendBtcAmount = toSatPrecision(netPurchaseUsdc / btcSpotPrice);

    // Reserve the request_id with a PENDING order row. ON CONFLICT DO NOTHING
    // catches concurrent duplicate submissions; we then return the winner's row.
    const orderInsert = await client.query(
      `INSERT INTO hashrate_orders
         (user_id, target_pool, request_id, usdc_cost, protocol_fee_usdc, btc_spent,
          btc_spot_price, price_feed, price_is_usdc_pair, algorithm, status, marketplace)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'PENDING', $11)
       ON CONFLICT (request_id) DO NOTHING
       RETURNING order_id`,
      [
        userId,
        targetPool,
        requestId,
        nextTier.cost,
        protocolFeeUsdc,
        spendBtcAmount,
        toSatPrecision(btcSpotPrice),
        quote.feed,
        quote.isUsdcPair,
        POOL_ALGORITHM_MAP[targetPool],
        providerName,
      ]
    );
    if (orderInsert.rowCount === 0) {
      // Lost the race — a concurrent identical request already reserved this id.
      await client.query('ROLLBACK');
      const winner = await pool.query(`${ORDER_SELECT} WHERE h.request_id = $1`, [requestId]);
      return res.json(duplicateResponse(winner.rows[0]));
    }
    orderRecordId = orderInsert.rows[0].order_id;

    // Deduct the user's USDC balance.
    newBalance = toSatPrecision(Number(wallet.usdc_balance) - nextTier.cost);
    await client.query(
      'UPDATE user_wallets SET usdc_balance = $1, updated_at = CURRENT_TIMESTAMP WHERE wallet_id = $2',
      [newBalance, walletId]
    );

    // Revenue ledger books ONLY the 5% protocol fee. The other 95% is a
    // pass-through to the NiceHash marketplace, NOT platform revenue.
    await client.query(
      'INSERT INTO protocol_revenue_ledger (source_user_id, amount_usdc, transaction_type) VALUES ($1, $2, $3)',
      [userId, protocolFeeUsdc, 'RIG_UPGRADE']
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
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Upgrade error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  } finally {
    client.release();
  }

  // Place the order AFTER commit: a failed commit must never leave a live order
  // unrecorded, and a failed order must never corrupt the DB transaction.
  const orderResult = await placeHashpowerOrder(targetPool, spendBtcAmount);

  if (!orderResult.success) {
    // Compensate: refund the user and mark the order row FAILED/REFUNDED.
    const refundClient = await pool.connect();
    try {
      await refundClient.query('BEGIN');
      await refundClient.query(
        'UPDATE user_wallets SET usdc_balance = usdc_balance + $1, updated_at = CURRENT_TIMESTAMP WHERE wallet_id = $2',
        [nextTier.cost, walletId]
      );
      await refundClient.query(
        `UPDATE hashrate_orders SET status = 'REFUNDED', failure_reason = $1, updated_at = CURRENT_TIMESTAMP WHERE order_id = $2`,
        [orderResult.error, orderRecordId]
      );
      await refundClient.query('COMMIT');
      console.error(`Order failed for request ${requestId}; ${nextTier.cost} USDC refunded to ${walletAddress}`);
    } catch (refundErr) {
      await refundClient.query('ROLLBACK');
      console.error('❌ CRITICAL: refund failed after order error:', refundErr.message);
    } finally {
      refundClient.release();
    }
    return res.status(502).json({
      error: `Hashrate marketplace order failed: ${orderResult.error}. USDC refunded.`,
    });
  }

  const status = orderResult.mode === 'live' ? 'PLACED' : 'SIMULATED';
  await pool.query(
    `UPDATE hashrate_orders
       SET nicehash_order_id = $1, status = $2, sandbox = $3, updated_at = CURRENT_TIMESTAMP
     WHERE order_id = $4`,
    [orderResult.orderId || null, status, orderResult.mode !== 'live', orderRecordId]
  );

  let niceHashStatus = null;
  if (orderResult.orderId && orderResult.mode === 'live') {
    try {
      const st = await getOrderStatus(orderResult.orderId);
      niceHashStatus = st?.status || null;
    } catch (err) {
      console.warn('Could not refresh marketplace order status:', err.message);
    }
  }

  return res.json({
    success: true,
    duplicated: false,
    level: nextTier.level,
    hashrate: nextTier.hashrate,
    remaining_balance: newBalance,
    btc_spent: spendBtcAmount,
    btc_spot_price: toSatPrecision(btcSpotPrice),
    price_feed: quote.feed,
    protocol_fee_usdc: protocolFeeUsdc,
    nicehash_order_id: orderResult.orderId || null,
    marketplace: providerName,
    order_status: status,
    nicehash_status: niceHashStatus,
    sandbox: orderResult.mode !== 'live',
    request_id: requestId,
  });
}

module.exports = { upgradeRig, UPGRADE_TIERS, PROTOCOL_FEE_PCT };
