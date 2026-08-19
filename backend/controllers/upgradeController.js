const { pool } = require('../config/db');
const { getLiveBtcPrice } = require('../services/priceOracle');
const { logRigChange, resumeDormantRigs } = require('../services/rigHistory');
const { fetchCoinUsdPrice, claimPoolRewardsInTx } = require('./rewardsController');

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

/**
 * Per-coin upgrade pricing — entry points reflect the REAL cost of backing
 * that hashrate on the marketplace (rental $/day differs hugely per coin).
 * Virtual hashrate ladder is the same everywhere; only the price differs.
 *
 *   KASPA/XMR (cheap to back):   $5 / $10 / $25 / $50
 *   ZCASH (mid):                 $20 / $40 / $100 / $200
 *   LTC_DOGE (expensive rigs):   $50 / $120 / $300 / $750
 */
const POOL_TIERS = {
  KASPA: [
    { level: 1, cost: 0, hashrate: 10 },
    { level: 2, cost: 5, hashrate: 25 },
    { level: 3, cost: 10, hashrate: 60 },
    { level: 4, cost: 25, hashrate: 150 },
    { level: 5, cost: 50, hashrate: 400 },
  ],
  XMR: [
    { level: 1, cost: 0, hashrate: 10 },
    { level: 2, cost: 5, hashrate: 25 },
    { level: 3, cost: 10, hashrate: 60 },
    { level: 4, cost: 25, hashrate: 150 },
    { level: 5, cost: 50, hashrate: 400 },
  ],
  ZCASH: [
    { level: 1, cost: 0, hashrate: 10 },
    { level: 2, cost: 20, hashrate: 25 },
    { level: 3, cost: 40, hashrate: 60 },
    { level: 4, cost: 100, hashrate: 150 },
    { level: 5, cost: 200, hashrate: 400 },
  ],
  LTC_DOGE: [
    { level: 1, cost: 0, hashrate: 10 },
    { level: 2, cost: 50, hashrate: 25 },
    { level: 3, cost: 120, hashrate: 60 },
    { level: 4, cost: 300, hashrate: 150 },
    { level: 5, cost: 750, hashrate: 400 },
  ],
};

/** Tiers for a pool; falls back to the (now legacy) flat ladder for unknown pools. */
function tiersFor(pool) {
  return POOL_TIERS[pool] || POOL_TIERS.LTC_DOGE;
}

const PROTOCOL_FEE_PCT = 0.05;

function toSatPrecision(value) {
  return parseFloat(value.toFixed(8));
}

const ORDER_SELECT = `
  SELECT h.order_id, h.status, h.nicehash_order_id, h.sandbox, h.usdc_cost,
         h.protocol_fee_usdc, h.btc_spent, h.btc_spot_price, h.price_feed,
         h.price_is_usdc_pair, h.failure_reason, h.request_id, h.marketplace,
         h.rig_name, h.rig_rpi, h.rig_hours,
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
    rig_name: row.rig_name || null,
    rig_rpi: row.rig_rpi || null,
    rig_hours: row.rig_hours ? Number(row.rig_hours) : null,
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

    nextTier = tiersFor(targetPool).find((t) => t.level === currentLevel + 1);
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
        'UPDATE virtual_rigs SET level = $1, virtual_hashrate = $2, maintenance_status = $3, updated_at = CURRENT_TIMESTAMP WHERE rig_id = $4',
        [nextTier.level, nextTier.hashrate, 'ACTIVE', rig.rig_id]
      );
    } else {
      await client.query(
        'INSERT INTO virtual_rigs (user_id, target_pool, virtual_hashrate, level, maintenance_status) VALUES ($1, $2, $3, $4, $5)',
        [userId, targetPool, nextTier.hashrate, nextTier.level, 'ACTIVE']
      );
    }
    await logRigChange(client, userId, targetPool, nextTier.hashrate);
    await resumeDormantRigs(client, userId);

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
  let userId = null;
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
    userId = userResult.rows[0].user_id;

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

    nextTier = tiersFor(targetPool).find((t) => t.level === currentLevel + 1);
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
    // pass-through to the marketplace, NOT platform revenue. The row is
    // linked to this order so a refund can reverse exactly the fee.
    await client.query(
      `INSERT INTO protocol_revenue_ledger (source_user_id, amount_usdc, transaction_type, order_id)
       VALUES ($1, $2, $3, $4)`,
      [userId, protocolFeeUsdc, 'RIG_UPGRADE', orderRecordId]
    );

    if (rig) {
      await client.query(
        'UPDATE virtual_rigs SET level = $1, virtual_hashrate = $2, maintenance_status = $3, updated_at = CURRENT_TIMESTAMP WHERE rig_id = $4',
        [nextTier.level, nextTier.hashrate, 'ACTIVE', rig.rig_id]
      );
    } else {
      await client.query(
        'INSERT INTO virtual_rigs (user_id, target_pool, virtual_hashrate, level, maintenance_status) VALUES ($1, $2, $3, $4, $5)',
        [userId, targetPool, nextTier.hashrate, nextTier.level, 'ACTIVE']
      );
    }
    await logRigChange(client, userId, targetPool, nextTier.hashrate);
    // Buying hashpower is the GoMiner "grow" action — it wakes any dormant
    // miners the user owns in OTHER pools too (spend-to-grow loop).
    await resumeDormantRigs(client, userId);

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
    // Compensate: refund the user, revert the rig level, and mark the order
    // row FAILED/REFUNDED. The rig must NOT keep the upgrade the user didn't
    // pay for (money back + free rig = financial bug).
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
      // Reverse the fee booked for this order — it was linked by order_id so
      // we can remove exactly the right row (previously the fee row survived
      // a refund as phantom revenue).
      await refundClient.query(
        'DELETE FROM protocol_revenue_ledger WHERE order_id = $1',
        [orderRecordId]
      );
      // Revert the rig to its pre-upgrade level (or delete if it was just created).
      const prevTier = tiersFor(targetPool).find((t) => t.level === nextTier.level - 1) || null;
      if (prevTier) {
        await refundClient.query(
          'UPDATE virtual_rigs SET level = $1, virtual_hashrate = $2, updated_at = CURRENT_TIMESTAMP WHERE user_id = $3 AND target_pool = $4',
          [prevTier.level, prevTier.hashrate, userId, targetPool]
        );
        await logRigChange(refundClient, userId, targetPool, prevTier.hashrate);
      } else {
        await refundClient.query(
          'DELETE FROM virtual_rigs WHERE user_id = $1 AND target_pool = $2',
          [userId, targetPool]
        );
        await logRigChange(refundClient, userId, targetPool, 0);
      }
      await refundClient.query('COMMIT');
      console.error(`Order failed for request ${requestId}; ${nextTier.cost} USDC refunded and rig reverted for ${walletAddress}`);
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
       SET nicehash_order_id = $1, status = $2, sandbox = $3,
           rig_name = $4, rig_rpi = $5, rig_hours = $6,
           updated_at = CURRENT_TIMESTAMP
     WHERE order_id = $7`,
    [
      orderResult.orderId || null,
      status,
      orderResult.mode !== 'live',
      orderResult.rigName || null,
      orderResult.rigRpi != null ? String(orderResult.rigRpi) : null,
      orderResult.rigHours || null,
      orderRecordId,
    ]
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
    rig_name: orderResult.rigName || null,
    rig_rpi: orderResult.rigRpi != null ? String(orderResult.rigRpi) : null,
    rig_hours: orderResult.rigHours || null,
    order_status: status,
    nicehash_status: niceHashStatus,
    sandbox: orderResult.mode !== 'live',
    request_id: requestId,
    reinvested_usdc: req.reinvestedUsdc || 0,
  });
}

/**
 * GoMiner reinvest: use the user's MINED TOKENS (unclaimed rewards in this
 * pool) to pay for the next rig upgrade — no USDC deposit needed. The mined
 * tokens are claimed to the user's USDC balance at the live coin price, then
 * the standard upgrade flow runs (5% fee, real marketplace order, refund +
 * rig revert on failure). If the upgrade order fails, the user keeps the
 * claimed balance — nothing is lost, and the request_id stays idempotent.
 */
async function reinvestRig(req, res) {
  const walletAddress = (req.body.wallet || '').toLowerCase();
  const targetPool = req.body.target_pool;
  const requestId = String(req.body.request_id || '').trim();

  if (!walletAddress || !/^0x[a-f0-9]{40}$/i.test(walletAddress)) {
    return res.status(400).json({ error: 'Valid wallet address is required' });
  }
  if (!requestId || requestId.length > 64) {
    return res.status(400).json({ error: 'request_id is required (1-64 chars) for idempotent upgrades' });
  }

  // XMR upgrades are SELF-MINED and free — nothing to reinvest.
  if (targetPool === 'XMR') {
    return upgradeRig(req, res);
  }
  if (!['ZCASH', 'KASPA', 'LTC_DOGE'].includes(targetPool)) {
    return res.status(400).json({ error: 'Invalid target pool' });
  }

  // Idempotency FIRST: a retry of a completed reinvest must return the stored
  // order result, never claim rewards again.
  const existing = await pool.query(`${ORDER_SELECT} WHERE h.request_id = $1`, [requestId]);
  if (existing.rowCount > 0) {
    return res.json(duplicateResponse(existing.rows[0]));
  }

  // What does the next tier cost, and what are the mined tokens worth?
  const client = await pool.connect();
  let userId = null;
  let walletId = null;
  let claimedUsdc = 0;
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
    userId = userResult.rows[0].user_id;

    const walletResult = await client.query(
      'SELECT wallet_id FROM user_wallets WHERE user_id = $1 FOR UPDATE',
      [userId]
    );
    if (walletResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Wallet not found' });
    }
    walletId = walletResult.rows[0].wallet_id;

    const rigResult = await client.query(
      'SELECT level FROM virtual_rigs WHERE user_id = $1 AND target_pool = $2 FOR UPDATE',
      [userId, targetPool]
    );
    const currentLevel = rigResult.rowCount > 0 ? Number(rigResult.rows[0].level) : 1;
    const nextTier = tiersFor(targetPool).find((t) => t.level === currentLevel + 1);
    if (!nextTier) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Already at max level' });
    }

    // Value of the user's mined tokens for THIS pool at the live coin price.
    let coinPrice;
    try {
      coinPrice = await fetchCoinUsdPrice(targetPool);
    } catch (err) {
      await client.query('ROLLBACK');
      return res.status(502).json({ error: `Price oracle unavailable: ${err.message}` });
    }

    claimedUsdc = await claimPoolRewardsInTx(client, userId, walletId, targetPool, coinPrice);
    await client.query('COMMIT');

    if (claimedUsdc <= 0) {
      return res.status(400).json({
        error: `No mined ${targetPool} tokens to reinvest yet — yield accumulates after real pool payouts.`,
      });
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Reinvest claim error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  } finally {
    client.release();
  }

  // Tell the upgrade flow how much mined-token value funded it (display only).
  req.reinvestedUsdc = claimedUsdc;
  return upgradeRig(req, res);
}

/**
 * GoMiner opt-in (009): the owner explicitly OKs mining at a loss. When a
 * payout can't cover maintenance, the shortfall is charged to the user's
 * USDC balance instead of pausing the miner. If the balance can't cover it,
 * the miner still pauses (auto-protection — the user can never go negative).
 */
async function setMineAtLoss(req, res) {
  const walletAddress = (req.body.wallet || '').toLowerCase();
  const targetPool = req.body.target_pool;
  const enabled = req.body.enabled === true || req.body.enabled === 'true';

  if (!walletAddress || !/^0x[a-f0-9]{40}$/i.test(walletAddress)) {
    return res.status(400).json({ error: 'Valid wallet address is required' });
  }
  if (!['ZCASH', 'KASPA', 'LTC_DOGE', 'XMR'].includes(targetPool)) {
    return res.status(400).json({ error: 'Invalid target pool' });
  }

  try {
    const result = await pool.query(
      `UPDATE virtual_rigs
          SET mine_at_loss = $1, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = (SELECT user_id FROM users WHERE LOWER(wallet_address) = $2)
          AND target_pool = $3
        RETURNING rig_id, mine_at_loss`,
      [enabled, walletAddress, targetPool]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'No miner for this pool — buy one first' });
    }
    return res.json({ success: true, rig_id: result.rows[0].rig_id, mine_at_loss: result.rows[0].mine_at_loss });
  } catch (err) {
    console.error('setMineAtLoss error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { upgradeRig, reinvestRig, setMineAtLoss, POOL_TIERS, tiersFor, PROTOCOL_FEE_PCT };
