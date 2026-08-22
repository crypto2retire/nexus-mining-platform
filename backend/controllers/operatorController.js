const crypto = require('crypto');
const { pool } = require('../config/db');
const { getLiveBtcPrice } = require('../services/priceOracle');
const {
  makeMrrRequest,
  rigIsAvailable,
  meetsAdvertisedMinimum,
} = require('../services/mrrRenter');
const {
  buildMarketView,
  configFor,
  getCoinMarketData,
  marketStatsFor,
  storageHashrateFor,
} = require('../services/operatorMarketService');

const VALID_ALGOS = new Set(['kheavyhash', 'scrypt', 'equihash', 'sha256']);

function operatorAllowed(req, res) {
  const configured = String(process.env.OPERATOR_WALLET || '').trim().toLowerCase();
  if (!configured) {
    res.status(403).json({ error: 'Operator access is not configured' });
    return false;
  }
  const authenticated = String(req.auth?.wallet || '').trim().toLowerCase();
  if (authenticated !== configured) {
    res.status(403).json({ error: 'Operator access required' });
    return false;
  }
  return true;
}

function profileIdFor(config) {
  return String(process.env[`MRR_POOL_PROFILE_${config.profileSuffix}`] || '').trim();
}

function recordsFrom(response) {
  return response?.data?.records || [];
}

async function getMarket(req, res) {
  if (!operatorAllowed(req, res)) return res;
  const algo = String(req.query?.algo || '').trim().toLowerCase();
  if (!VALID_ALGOS.has(algo)) {
    return res.status(400).json({ error: 'Invalid market algorithm' });
  }
  try {
    const [rigResponse, algorithmResponse, quote, coinMarket] = await Promise.all([
      makeMrrRequest('GET', '/rig', { type: algo, limit: '50' }),
      makeMrrRequest('GET', '/info/algos'),
      getLiveBtcPrice(),
      getCoinMarketData(algo),
    ]);
    const config = configFor(algo);
    const view = buildMarketView({
      records: recordsFrom(rigResponse),
      algo,
      btcUsd: quote.price,
      spots: coinMarket.spots,
      profileId: profileIdFor(config),
    });
    return res.json({
      algo,
      generated_at: new Date().toISOString(),
      price_trend: coinMarket.priceTrend,
      best_value: view.best_value,
      rigs: view.rigs,
      market_stats: marketStatsFor({
        algo,
        btcUsd: quote.price,
        algorithmRows: algorithmResponse?.data || [],
      }),
    });
  } catch (err) {
    console.error('Operator market error:', err.message);
    return res.status(502).json({ error: `Market data unavailable: ${err.message}` });
  }
}

async function createOrder(req, res) {
  if (!operatorAllowed(req, res)) return res;
  const algo = String(req.body?.algo || '').trim().toLowerCase();
  const rigId = String(req.body?.rig_id || '').trim();
  const lengthHours = Number(req.body?.length_hours);
  if (!VALID_ALGOS.has(algo)) return res.status(400).json({ error: 'Invalid market algorithm' });
  if (!rigId || rigId.length > 50) return res.status(400).json({ error: 'Valid rig_id is required' });
  if (!Number.isInteger(lengthHours) || lengthHours <= 0) {
    return res.status(400).json({ error: 'length_hours must be a positive whole number' });
  }
  const config = configFor(algo);
  const profileId = profileIdFor(config);
  if (!profileId) {
    return res.status(503).json({ error: `MRR_POOL_PROFILE_${config.profileSuffix} is not configured` });
  }

  let rig;
  let quote;
  try {
    const [rigResponse, priceQuote] = await Promise.all([
      makeMrrRequest('GET', '/rig', { type: algo, rented: 'false', limit: '50' }),
      getLiveBtcPrice(),
    ]);
    rig = recordsFrom(rigResponse).find((candidate) => String(candidate?.id) === rigId);
    quote = priceQuote;
  } catch (err) {
    return res.status(502).json({ error: `Unable to verify the MRR rig: ${err.message}` });
  }
  if (!rig || !rigIsAvailable(rig) || !meetsAdvertisedMinimum(rig, algo)) {
    return res.status(409).json({ error: 'The selected rig is no longer available or eligible' });
  }
  const minHours = Number(rig?.price?.BTC?.min_rental_length || rig?.minhours || 0);
  const configuredMax = Number(process.env.MRR_MAX_RENTAL_HOURS || 72);
  const maxConfigured = Number.isFinite(configuredMax) && configuredMax > 0 ? configuredMax : 72;
  const maxHours = Math.min(Number(rig?.maxhours || maxConfigured), maxConfigured);
  if (lengthHours < minHours || lengthHours > maxHours) {
    return res.status(400).json({
      error: `length_hours must be between ${minHours} and ${maxHours} for this rig`,
    });
  }
  if (!Number(rig?.price?.BTC?.hour) || rig?.price?.BTC?.enabled === false) {
    return res.status(409).json({ error: 'The selected rig no longer accepts BTC rentals' });
  }
  const requestedHashrate = storageHashrateFor(algo, rig);
  if (!requestedHashrate) return res.status(409).json({ error: 'The selected rig has invalid hashrate data' });

  const wallet = String(req.auth.wallet).toLowerCase();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userResult = await client.query(
      'SELECT user_id FROM users WHERE LOWER(wallet_address) = $1 FOR UPDATE',
      [wallet]
    );
    if (userResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Operator user not found' });
    }
    const userId = userResult.rows[0].user_id;
    const pending = await client.query(
      `SELECT order_id FROM hashrate_orders
        WHERE user_id = $1 AND target_pool = $2
          AND marketplace = 'MRR' AND outbox_state IN ('PENDING', 'PROCESSING')
        FOR UPDATE`,
      [userId, config.targetPool]
    );
    if (pending.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'An operator rental order for this pool is already pending' });
    }
    const rigResult = await client.query(
      `SELECT level, virtual_hashrate, rental_expires_at FROM virtual_rigs
        WHERE user_id = $1 AND target_pool = $2 FOR UPDATE`,
      [userId, config.targetPool]
    );
    const existingRig = rigResult.rows[0] || null;
    const rentalSlice = await client.query(
      `SELECT starts_at, expires_at FROM capacity_slices
        WHERE user_id = $1 AND target_pool = $2 AND source = 'RENTAL' FOR UPDATE`,
      [userId, config.targetPool]
    );
    const slice = rentalSlice.rows[0] || null;
    const requestId = `operator-${crypto.randomUUID()}`;
    const inserted = await client.query(
      `INSERT INTO hashrate_orders
        (user_id, target_pool, request_id, usdc_cost, protocol_fee_usdc, btc_spent,
         btc_spot_price, price_feed, price_is_usdc_pair, algorithm, status, marketplace,
         outbox_state, prior_rig_level, prior_rig_hashrate, prior_rental_expires_at,
         prior_rental_starts_at, created_rig, renewal, requested_rig_level,
         requested_rig_hashrate, requested_rig_id, pool_profile_id, requested_length_hours)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'PENDING', 'MRR',
               'PENDING', $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
       RETURNING order_id`,
      [
        userId,
        config.targetPool,
        requestId,
        0,
        0,
        0,
        quote.price,
        quote.feed,
        quote.isUsdcPair,
        config.targetPool,
        existingRig?.level || null,
        existingRig?.virtual_hashrate || null,
        slice?.expires_at || existingRig?.rental_expires_at || null,
        slice?.starts_at || null,
        !existingRig,
        Boolean(existingRig),
        existingRig?.level || 1,
        requestedHashrate,
        rigId,
        profileId,
        lengthHours,
      ]
    );
    await client.query('COMMIT');
    return res.status(202).json({ status: 'PENDING', order_id: inserted.rows[0].order_id });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Operator order error:', err.message);
    return res.status(500).json({ error: err.message || 'Unable to queue operator order' });
  } finally {
    client.release();
  }
}

async function listOrders(req, res) {
  if (!operatorAllowed(req, res)) return res;
  try {
    const { rows } = await pool.query(
      `SELECT h.order_id, h.target_pool, h.status, h.outbox_state,
              h.requested_rig_id, h.requested_length_hours, h.pool_profile_id,
              h.nicehash_order_id AS mrr_rental_id, h.failure_reason,
              h.rig_name, h.rig_rpi, h.rig_hours, h.created_at, h.updated_at
         FROM hashrate_orders h
         JOIN users u ON u.user_id = h.user_id
        WHERE LOWER(u.wallet_address) = $1
          AND h.marketplace = 'MRR' AND h.requested_rig_id IS NOT NULL
        ORDER BY h.created_at DESC LIMIT 25`,
      [String(req.auth.wallet).toLowerCase()]
    );
    return res.json({ orders: rows });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unable to load operator orders' });
  }
}

// Per-miner dashboard for the rigs the operator holds (Kevin 2026-08-22):
// each rig shows hashrate, estimated payout, time left, current P/L, overall
// P/L on that miner, and the coin's overall P/L — grouped by coin.
async function getOperatorMiners(req, res) {
  if (!operatorAllowed(req, res)) return res;
  try {
    const { rows } = await pool.query(
      'SELECT user_id FROM users WHERE LOWER(wallet_address) = $1',
      [String(req.auth.wallet).toLowerCase()]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Operator user not found' });
    const { buildOperatorMiners } = require('../services/minerDashboardService');
    return res.json(await buildOperatorMiners(rows[0].user_id));
  } catch (err) {
    console.error('Operator miners error:', err.message);
    return res.status(500).json({ error: err.message || 'Unable to load miner dashboard' });
  }
}

module.exports = { getMarket, createOrder, listOrders, getOperatorMiners, operatorAllowed };
