const { pool } = require('../config/db');
const { getLiveBtcPrice } = require('../services/priceOracle');
const { logRigChange } = require('../services/rigHistory');
const { fetchLiveRealHash } = require('../services/roomHash');
const { fetchCoinUsdPrice, claimPoolRewardsInTx } = require('./rewardsController');
const { coinsOwnedFor, discountPctFor } = require('../services/multiCoinDiscount');

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
 * Per-coin rental pricing — entry points reflect the REAL cost of renting
 * that hashrate on the marketplace (rental $/day differs hugely per coin).
 * Virtual hashrate ladder is the same everywhere; only the price differs.
 *
 * MODEL (2026-08-20): RENTAL, not sale. A payment rents the tier's hashrate
 * for the real MRR rental window (default 72h) — the user's window is
 * `virtual_rigs.rental_expires_at`, matched 1:1 to the actual rented hours.
 * No maintenance fund, no DORMANT, no mine-at-loss: when the window ends the
 * rig stops contributing until renewed manually.
 *
 *   KASPA/XMR (cheap to back):  $5 / $10 / $25 / $50
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

async function upgradeRig(req, res) {
  const walletAddress = (req.body.wallet || '').toLowerCase();
  const targetPool = req.body.target_pool;
  const requestId = String(req.body.request_id || '').trim();
  // renew=true re-rents the CURRENT tier (extends the window by the rented
  // hours); unset/false rents the NEXT tier (upgrade to bigger hashrate).
  const renew = req.body.renew === true || req.body.renew === 'true';

  if (!walletAddress || !/^0x[a-f0-9]{40}$/i.test(walletAddress)) {
    return res.status(400).json({ error: 'Valid wallet address is required' });
  }
  if (!requestId || requestId.length > 64) {
    return res.status(400).json({ error: 'request_id is required (1-64 chars) for idempotent upgrades' });
  }

  if (!['ZCASH', 'KASPA', 'LTC_DOGE', 'XMR'].includes(targetPool)) {
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
  let discountPct = 0;
  let discountedCost = null;
  let hadRig = false;
  let prevLevel = null;
  let prevExpiresAt = null;

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

    // Multi-coin loyalty: more coins mined = cheaper everything.
    const coinsOwned = await coinsOwnedFor(client, userId);
    discountPct = discountPctFor(coinsOwned);

    const walletResult = await client.query(
      'SELECT wallet_id, usdc_balance FROM user_wallets WHERE user_id = $1 FOR UPDATE',
      [userId]
    );
    const wallet = walletResult.rows[0];
    walletId = wallet.wallet_id;

    const rigResult = await client.query(
      'SELECT rig_id, level, virtual_hashrate, rental_expires_at FROM virtual_rigs WHERE user_id = $1 AND target_pool = $2 FOR UPDATE',
      [userId, targetPool]
    );
    const rig = rigResult.rows[0];
    hadRig = !!rig;
    prevLevel = rig ? rig.level : null;
    prevExpiresAt = rig ? rig.rental_expires_at : null;
    const currentLevel = rig ? rig.level : 1;

    // RENTAL model (2026-08-20): renew = same tier again (extend window);
    // otherwise rent the next tier (bigger hashrate).
    nextTier = renew
      ? tiersFor(targetPool).find((t) => t.level === currentLevel)
      : tiersFor(targetPool).find((t) => t.level === currentLevel + 1);
    if (!nextTier) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: renew ? 'No active rental to renew — rent a miner first' : 'Already at max level' });
    }
    discountedCost = toSatPrecision(nextTier.cost * (1 - discountPct / 100));
    if (Number(wallet.usdc_balance) < discountedCost) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient USDC balance' });
    }

    protocolFeeUsdc = toSatPrecision(discountedCost * PROTOCOL_FEE_PCT);
    netPurchaseUsdc = toSatPrecision(discountedCost - protocolFeeUsdc);
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
        discountedCost,
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

    // Deduct the user's USDC balance (post-discount price).
    newBalance = toSatPrecision(Number(wallet.usdc_balance) - discountedCost);
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

    // RENTAL model: the rig window is extended NOW and refined to the ACTUAL
    // rented hours after the marketplace order returns (see below). The rig
    // stays ACTIVE while inside the window; the scheduler expires it after.
    if (rig) {
      await client.query(
        'UPDATE virtual_rigs SET level = $1, virtual_hashrate = $2, maintenance_status = $3, rental_expires_at = $5, updated_at = CURRENT_TIMESTAMP WHERE rig_id = $4',
        [nextTier.level, nextTier.hashrate, 'ACTIVE', rig.rig_id, new Date(Date.now() + 72 * 3600 * 1000)]
      );
    } else {
      await client.query(
        'INSERT INTO virtual_rigs (user_id, target_pool, virtual_hashrate, level, maintenance_status, rental_expires_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [userId, targetPool, nextTier.hashrate, nextTier.level, 'ACTIVE', new Date(Date.now() + 72 * 3600 * 1000)]
      );
    }
    await logRigChange(client, userId, targetPool, nextTier.hashrate);

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
    // Compensate: refund the user and revert the rig to its pre-rental state.
    // The rig must NOT keep a rental window the user didn't pay for (money
    // back + free hashrate = financial bug).
    const refundClient = await pool.connect();
    try {
      await refundClient.query('BEGIN');
      await refundClient.query(
        'UPDATE user_wallets SET usdc_balance = usdc_balance + $1, updated_at = CURRENT_TIMESTAMP WHERE wallet_id = $2',
        [discountedCost, walletId]
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
      // Revert the rig to its pre-rental state (or delete if it was just created).
      if (hadRig) {
        const revertTier = renew
          ? tiersFor(targetPool).find((t) => t.level === prevLevel)
          : tiersFor(targetPool).find((t) => t.level === nextTier.level - 1) || null;
        if (revertTier) {
          await refundClient.query(
            'UPDATE virtual_rigs SET level = $1, virtual_hashrate = $2, rental_expires_at = $3, updated_at = CURRENT_TIMESTAMP WHERE user_id = $4 AND target_pool = $5',
            [revertTier.level, revertTier.hashrate, prevExpiresAt, userId, targetPool]
          );
          await logRigChange(refundClient, userId, targetPool, revertTier.hashrate);
        }
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

  // RENTAL model: the user's window is the ACTUAL rented hours from the
  // marketplace order (1:1 match — no more permanent ownership). Default to
  // 72h when the provider didn't return a length. Renewing an ACTIVE rig
  // extends from its current expiry (no time is wasted); a fresh/upgrade rent
  // starts now.
  const rentalHours = orderResult.rigHours && Number(orderResult.rigHours) > 0
    ? Number(orderResult.rigHours)
    : 72;
  const baseMs = renew && prevExpiresAt && new Date(prevExpiresAt).getTime() > Date.now()
    ? new Date(prevExpiresAt).getTime()
    : Date.now();
  const expiresAt = new Date(baseMs + rentalHours * 3600 * 1000);
  await pool.query(
    `UPDATE virtual_rigs
        SET rental_expires_at = $1, maintenance_status = 'ACTIVE', updated_at = CURRENT_TIMESTAMP
      WHERE user_id = $2 AND target_pool = $3`,
    [expiresAt, userId, targetPool]
  );

  // Audit trail: record the real MRR rental so the Real Backing panel and the
  // expiry sweeper can see exactly what is backing this window.
  try {
    const rigIdRes = await pool.query(
      'SELECT rig_id FROM virtual_rigs WHERE user_id = $1 AND target_pool = $2',
      [userId, targetPool]
    );
    const rigId = rigIdRes.rows[0]?.rig_id;
    if (rigId && orderResult.orderId) {
      const actualCostBtc =
        Number(orderResult.actualCostBtc || 0) > 0 ? Number(orderResult.actualCostBtc) : spendBtcAmount;
      const actualCostUsd = toSatPrecision(actualCostBtc * btcSpotPrice);
      await pool.query(
        `INSERT INTO rig_rentals
          (user_id, rig_id, target_pool, mrr_rental_id, rig_name, rig_rpi,
           cost_btc, cost_usd, length_hours, funded_from, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'POOL', 'ACTIVE')`,
        [
          userId,
          rigId,
          targetPool,
          String(orderResult.orderId),
          orderResult.rigName || null,
          orderResult.rigRpi != null ? String(orderResult.rigRpi) : null,
          actualCostBtc,
          actualCostUsd,
          rentalHours,
        ]
      );
      console.log(
        `Rig ${rigId}/${targetPool} rented ${rentalHours}h via MRR rental ${orderResult.orderId} — expires ${expiresAt.toISOString()}`
      );
    }
  } catch (recordErr) {
    console.error('Could not record rig_rentals for order:', recordErr.message);
  }

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
    discount_pct: discountPct,
    discounted_cost: discountedCost,
    remaining_balance: newBalance,
    btc_spent: spendBtcAmount,
    btc_spot_price: toSatPrecision(btcSpotPrice),
    price_feed: quote.feed,
    protocol_fee_usdc: protocolFeeUsdc,
    nicehash_order_id: orderResult.orderId || null,
    marketplace: providerName,
    rig_name: orderResult.rigName || null,
    rig_rpi: orderResult.rigRpi != null ? String(orderResult.rigRpi) : null,
    rig_hours: rentalHours,
    rental_expires_at: expiresAt.toISOString(),
    renew: renew === true,
    order_status: status,
    nicehash_status: niceHashStatus,
    sandbox: orderResult.mode !== 'live',
    request_id: requestId,
    reinvested_usdc: req.reinvestedUsdc || 0,
  });
}

/**
 * Reinvest: use the user's MINED TOKENS (unclaimed rewards in this pool) to
 * pay for another rental window — an UPGRADE to the next tier, or a RENEW of
 * the current tier (body flag `renew: true`). No USDC deposit needed. The
 * mined tokens are claimed to the user's USDC balance at the live coin price,
 * then the standard rent flow runs (5% fee, real marketplace order, refund +
 * rig revert on failure). If the order fails, the user keeps the claimed
 * balance — nothing is lost, and the request_id stays idempotent.
 */
async function reinvestRig(req, res) {
  const walletAddress = (req.body.wallet || '').toLowerCase();
  const targetPool = req.body.target_pool;
  const requestId = String(req.body.request_id || '').trim();
  const renew = req.body.renew === true || req.body.renew === 'true';

  if (!walletAddress || !/^0x[a-f0-9]{40}$/i.test(walletAddress)) {
    return res.status(400).json({ error: 'Valid wallet address is required' });
  }
  if (!requestId || requestId.length > 64) {
    return res.status(400).json({ error: 'request_id is required (1-64 chars) for idempotent upgrades' });
  }

  if (!['ZCASH', 'KASPA', 'LTC_DOGE', 'XMR'].includes(targetPool)) {
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
    // RENTAL model: reinvest can upgrade to the next tier OR renew the current
    // tier (body flag), both paid from mined tokens. upgradeRig re-resolves
    // the exact tier — this check just ensures a purchasable tier exists.
    const targetTier = renew
      ? tiersFor(targetPool).find((t) => t.level === currentLevel)
      : tiersFor(targetPool).find((t) => t.level === currentLevel + 1);
    if (!targetTier || targetTier.cost <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: renew ? 'No active rental to renew — rent a miner first' : 'Already at max level' });
    }

    // Value of the user's mined tokens for THIS pool at the live coin price.
    let coinPrice;
    let dogePrice = 0;
    try {
      coinPrice = await fetchCoinUsdPrice(targetPool);
      // Merged DOGE (calculated_reward_2) converts at its own price.
      if (targetPool === 'LTC_DOGE') dogePrice = await fetchCoinUsdPrice('LTC_DOGE_DOGE');
    } catch (err) {
      await client.query('ROLLBACK');
      return res.status(502).json({ error: `Price oracle unavailable: ${err.message}` });
    }

    claimedUsdc = await claimPoolRewardsInTx(client, userId, walletId, targetPool, coinPrice, dogePrice);
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
 * HYBRID session model (2026-08-20): SHORT sessions (1h-24h) are slices of
 * the room's REAL running hashrate — NO new marketplace rental. The platform
 * (operator) already pays for the rigs; session revenue is pure platform
 * margin, marked up more for shorter sessions to cover order overhead.
 *
 *   - 72h purchases (upgradeRig) still fund a brand-new MRR rig.
 *   - Short sessions may only be sold up to the room's SPARE capacity:
 *         spare = live real hashrate - sum(active virtual credits)
 *     The operator's own baseline (admin rig) is part of the credits, so it
 *     is automatically protected from overselling.
 *   - Oversell guard runs inside the purchase transaction (locks the pool's
 *     virtual_rig rows so concurrent sessions serialize).
 *
 * Pricing: price = ghs x hours x baseRate(pool) x markup(hours) x discount.
 * baseRate derives from tier 2 (the $5/25 GH/s/72h anchor): the same rate
 * the 72h rental uses, so 72h at markup 1.0 == today's tier price.
 */
const SESSION_HOURS = { 1: 5, 3: 4, 6: 3, 12: 2, 24: 1.5 };

function baseRateFor(pool) {
  const tier = tiersFor(pool).find((t) => t.level === 2);
  if (!tier || tier.cost <= 0 || tier.hashrate <= 0) return 0;
  return tier.cost / (tier.hashrate * 72); // USDC per GH/s per hour
}

function sessionPrice(pool, ghs, hours, discountPct = 0) {
  const markup = SESSION_HOURS[hours];
  if (markup === undefined || !(ghs > 0) || !(hours > 0)) return null;
  const base = baseRateFor(pool);
  if (base <= 0) return null;
  return toSatPrecision(ghs * hours * base * markup * (1 - discountPct / 100));
}

/**
 * Buy a short hashrate session drawn from the room's spare capacity.
 * Idempotent via request_id (same unique index as rentals).
 */
async function buySession(req, res) {
  const walletAddress = (req.body.wallet || '').toLowerCase();
  const targetPool = req.body.target_pool;
  const requestId = String(req.body.request_id || '').trim();
  const hours = Number(req.body.hours);
  const ghs = Number(req.body.ghs);

  if (!walletAddress || !/^0x[a-f0-9]{40}$/i.test(walletAddress)) {
    return res.status(400).json({ error: 'Valid wallet address is required' });
  }
  if (!requestId || requestId.length > 64) {
    return res.status(400).json({ error: 'request_id is required (1-64 chars) for idempotent sessions' });
  }
  if (!['ZCASH', 'KASPA', 'LTC_DOGE', 'XMR'].includes(targetPool)) {
    return res.status(400).json({ error: 'Invalid target pool' });
  }
  if (!(hours in SESSION_HOURS)) {
    return res.status(400).json({ error: `hours must be one of ${Object.keys(SESSION_HOURS).join(', ')} (72h rentals go through the rent flow)` });
  }
  if (!Number.isFinite(ghs) || ghs < 1 || ghs > 1000) {
    return res.status(400).json({ error: 'ghs must be between 1 and 1000' });
  }

  // Idempotency: identical request_id returns the stored result.
  const existing = await pool.query(`${ORDER_SELECT} WHERE h.request_id = $1`, [requestId]);
  if (existing.rowCount > 0) {
    return res.json(duplicateResponse(existing.rows[0]));
  }

  // Live real hashrate BEFORE the transaction (no network I/O under locks).
  // We never sell capacity we cannot MEASURE — a failed fetch blocks the sale.
  let realHash;
  try {
    let activeRentals = [];
    if (targetPool === 'LTC_DOGE') {
      const r = await pool.query(
        "SELECT mrr_rental_id FROM rig_rentals WHERE target_pool = 'LTC_DOGE' AND status = 'ACTIVE'"
      );
      activeRentals = r.rows;
    }
    realHash = await fetchLiveRealHash(targetPool, activeRentals);
  } catch (err) {
    return res.status(502).json({ error: `Could not verify room capacity: ${err.message}` });
  }
  if (realHash == null) {
    return res.status(503).json({
      error:
        'Room capacity cannot be measured right now (pool API unreachable). No session was sold — try again in a moment.',
    });
  }

  const client = await pool.connect();
  let walletId = null;
  let userId = null;
  let newBalance = null;
  let price = null;
  let discountPct = 0;
  let orderRecordId = null;
  let expiresAt = null;
  let newHashrate = null;
  let hadActiveRig = false;
  let prevExpiry = null;
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

    const coinsOwned = await coinsOwnedFor(client, userId);
    discountPct = discountPctFor(coinsOwned);
    price = sessionPrice(targetPool, ghs, hours, discountPct);
    if (price === null) {
      await client.query('ROLLBACK');
      return res.status(500).json({ error: 'Session pricing unavailable for this pool' });
    }

    const walletResult = await client.query(
      'SELECT wallet_id, usdc_balance FROM user_wallets WHERE user_id = $1 FOR UPDATE',
      [userId]
    );
    if (walletResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Wallet not found' });
    }
    walletId = walletResult.rows[0].wallet_id;
    if (Number(walletResult.rows[0].usdc_balance) < price) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Insufficient USDC balance (need $${price.toFixed(2)})` });
    }

    // CAPACITY GUARD: lock every virtual_rig row in the room so concurrent
    // session purchases serialize, then compute active credits.
    const rigRows = await client.query(
      'SELECT rig_id, user_id, virtual_hashrate, rental_expires_at FROM virtual_rigs WHERE target_pool = $1 FOR UPDATE',
      [targetPool]
    );
    const now = new Date();
    let credits = 0;
    let myRow = null;
    for (const r of rigRows.rows) {
      const exp = r.rental_expires_at ? new Date(r.rental_expires_at).getTime() : 0;
      if (exp > now.getTime()) credits += Number(r.virtual_hashrate);
      if (r.user_id === userId) myRow = r;
    }
    const spare = realHash - credits;
    if (ghs > spare + 1e-9) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `Room ${targetPool} has only ${spare < 0 ? 0 : spare.toFixed(1)} GH/s of spare capacity right now — this session needs ${ghs} GH/s. Try fewer GH/s or a 72h rental (which adds a brand-new rig).`,
        spare_ghs: spare < 0 ? 0 : spare,
        requested_ghs: ghs,
      });
    }

    // Audit row: the full session price is platform revenue (no marketplace
    // pass-through — the rig is already running). marketplace = 'SESSION'.
    const orderInsert = await client.query(
      `INSERT INTO hashrate_orders
        (user_id, target_pool, request_id, usdc_cost, protocol_fee_usdc, btc_spent,
         btc_spot_price, price_feed, price_is_usdc_pair, algorithm, status, marketplace,
         rig_name, rig_hours)
      VALUES ($1, $2, $3, $4, 0, 0, 0, 'SESSION', true, $5, 'PLACED', 'SESSION', $6, $7)
      ON CONFLICT (request_id) DO NOTHING
      RETURNING order_id`,
      [userId, targetPool, requestId, price, POOL_ALGORITHM_MAP[targetPool], `${ghs} GH/s`, hours]
    );
    if (orderInsert.rowCount === 0) {
      await client.query('ROLLBACK');
      const winner = await pool.query(`${ORDER_SELECT} WHERE h.request_id = $1`, [requestId]);
      return res.json(duplicateResponse(winner.rows[0]));
    }
    orderRecordId = orderInsert.rows[0].order_id;

    newBalance = toSatPrecision(Number(walletResult.rows[0].usdc_balance) - price);
    await client.query(
      'UPDATE user_wallets SET usdc_balance = $1, updated_at = CURRENT_TIMESTAMP WHERE wallet_id = $2',
      [newBalance, walletId]
    );

    // FULL price booked as platform revenue — sessions sell capacity the
    // platform already pays for (no cost to fund, no pass-through).
    await client.query(
      `INSERT INTO protocol_revenue_ledger (source_user_id, amount_usdc, transaction_type, order_id)
       VALUES ($1, $2, $3, $4)`,
      [userId, price, 'SESSION_SALE', orderRecordId]
    );

    // Session window: stack onto any existing rig (extend expiry, add hashrate)
    // so a user can layer sessions. Expired rows reset to a fresh window.
    expiresAt = new Date(now.getTime() + hours * 3600 * 1000);
    if (myRow) {
      const baseExp = myRow.rental_expires_at ? new Date(myRow.rental_expires_at).getTime() : 0;
      const keepExp = baseExp > now.getTime() ? new Date(baseExp) : now;
      expiresAt = new Date(Math.max(keepExp.getTime(), expiresAt.getTime()));
      newHashrate = toSatPrecision(Number(myRow.virtual_hashrate) + ghs);
      hadActiveRig = keepExp > now.getTime();
      await client.query(
        `UPDATE virtual_rigs
            SET virtual_hashrate = $1, maintenance_status = 'ACTIVE', rental_expires_at = $2, updated_at = CURRENT_TIMESTAMP
          WHERE rig_id = $3`,
        [newHashrate, expiresAt, myRow.rig_id]
      );
    } else {
      newHashrate = toSatPrecision(ghs);
      await client.query(
        `INSERT INTO virtual_rigs (user_id, target_pool, virtual_hashrate, level, maintenance_status, rental_expires_at)
         VALUES ($1, $2, $3, 1, 'ACTIVE', $4)`,
        [userId, targetPool, newHashrate, expiresAt]
      );
    }
    await logRigChange(client, userId, targetPool, newHashrate);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Session purchase error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  } finally {
    client.release();
  }

  return res.json({
    success: true,
    session: true,
    target_pool: targetPool,
    ghs,
    hours,
    price,
    discount_pct: discountPct,
    markup: SESSION_HOURS[hours],
    rental_expires_at: expiresAt.toISOString(),
    remaining_balance: newBalance,
    room_spare_ghs: toSatPrecision(realHash - credits),
    order_id: orderRecordId,
    request_id: requestId,
  });
}

module.exports = { upgradeRig, reinvestRig, buySession, sessionPrice, SESSION_HOURS, POOL_TIERS, tiersFor, PROTOCOL_FEE_PCT };
