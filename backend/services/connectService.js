const { pool } = require('../config/db');
const { getLiveBtcPrice } = require('./priceOracle');
const {
  makeMrrRequest,
  meetsAdvertisedMinimum,
  rigIsAvailable,
} = require('./mrrRenter');
const {
  buildMarketView,
  configFor,
  getCoinMarketData,
  marketStatsFor,
} = require('./operatorMarketService');

const ADVERTISED_WINDOWS = [1, 3, 6, 12, 24, 48, 72];
const TARGET_TO_ALGO = {
  KASPA: 'kheavyhash',
  ZCASH: 'equihash',
  BTC: 'sha256',
};

const ADDRESS_RULES = {
  ZCASH: /^t1[a-zA-Z0-9]{33}$/,
  KASPA: /^kaspa:[a-z0-9]{60,64}$/i,
  BTC: /^(bc1[ac-hj-np-z02-9]{11,71}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/i,
};

const POOL_CONFIG = {
  KASPA: {
    symbol: 'KAS',
    host: 'de.kaspa.herominers.com',
    port: '1207',
    profile: '957805',
    floor: 1,
    statsUrl: (address) => `https://kaspa.herominers.com/api/stats_address?address=${encodeURIComponent(address)}`,
    balanceOf: (data) => Number(data?.stats?.balance || 0) / 1e8,
    hashOf: (data) => Number(data?.stats?.hashrate_1h || 0),
    link: (address) => `https://kaspa.herominers.com/#/wallet/${address}`,
  },
  ZCASH: {
    symbol: 'ZEC',
    host: 'zec.2miners.com',
    port: '1010',
    profile: '957592',
    floor: 0.1,
    statsUrl: (address) => `https://zec.2miners.com/api/accounts/${encodeURIComponent(address)}`,
    balanceOf: (data) => Number(data?.data?.unpaid ?? data?.unpaid ?? 0) / 1e8,
    hashOf: (data) => Number(data?.data?.currentHashrate ?? data?.currentHashrate ?? 0),
    link: (address) => `https://zec.2miners.com/accounts/${address}`,
  },
  BTC: {
    symbol: 'BTC',
    host: 'mine.ocean.xyz',
    port: '3334',
    profile: '957824',
    floor: 0.00065536,
    statsUrl: (address) => `https://api.blockcypher.com/v1/btc/main/addrs/${encodeURIComponent(address)}`,
    balanceOf: (data) => Number(data?.balance || 0) / 1e8,
    hashOf: () => null,
    link: (address) => `https://ocean.xyz/address/${address}`,
  },
};

class ConnectError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'ConnectError';
    this.statusCode = statusCode;
  }
}

function round4(value) {
  return Math.round((Number(value) + Number.EPSILON) * 10000) / 10000;
}

function round10(value) {
  return Number(Number(value).toFixed(10));
}

function recordsFrom(response) {
  return response?.data?.records || [];
}

function normalizedAlgo(algo) {
  const value = String(algo || '').trim().toLowerCase();
  if (!Object.values(TARGET_TO_ALGO).includes(value)) {
    throw new ConnectError(400, 'Invalid Connect market algorithm');
  }
  return value;
}

function normalizedTarget(targetPool) {
  const value = String(targetPool || '').trim().toUpperCase();
  if (!POOL_CONFIG[value]) throw new ConnectError(400, 'Invalid target_pool');
  return value;
}

function validatePayoutAddress(targetPool, address) {
  const target = String(targetPool || '').trim().toUpperCase();
  return Boolean(ADDRESS_RULES[target]?.test(String(address || '').trim()));
}

function normalizedWallet(wallet) {
  const value = String(wallet || '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(value)) {
    throw new ConnectError(400, 'Valid authenticated wallet is required');
  }
  return value;
}

function publicOrder(row) {
  if (!row) return row;
  const { owner_wallet: _ownerWallet, ...order } = row;
  return order;
}

function advertisedWindows(rig) {
  const minimum = Number(rig?.price?.BTC?.min_rental_length || rig?.minhours || 0);
  const configured = Number(process.env.MRR_MAX_RENTAL_HOURS || 72);
  const configuredMax = Number.isFinite(configured) && configured > 0 ? configured : 72;
  const rigMax = Number(rig?.maxhours || configuredMax);
  const maximum = Math.min(
    Number.isFinite(rigMax) && rigMax > 0 ? rigMax : configuredMax,
    configuredMax
  );
  return ADVERTISED_WINDOWS.filter((hours) => hours >= minimum && hours <= maximum);
}

async function marketFor(algo) {
  const normalized = normalizedAlgo(algo);
  const [rigResponse, algorithmResponse, btcQuote, coinMarket] = await Promise.all([
    makeMrrRequest('GET', '/rig', { type: normalized, limit: '50' }),
    makeMrrRequest('GET', '/info/algos'),
    getLiveBtcPrice(),
    getCoinMarketData(normalized),
  ]);
  const targetPool = configFor(normalized)?.targetPool;
  const view = buildMarketView({
    records: recordsFrom(rigResponse),
    algo: normalized,
    btcUsd: btcQuote.price,
    spots: coinMarket.spots,
    profileId: POOL_CONFIG[targetPool]?.profile,
  });
  return {
    algo: normalized,
    generated_at: new Date().toISOString(),
    price_trend: coinMarket.priceTrend,
    best_value: view.best_value,
    rigs: view.rigs,
    market_stats: marketStatsFor({
      algo: normalized,
      btcUsd: btcQuote.price,
      algorithmRows: algorithmResponse?.data || [],
    }),
  };
}

async function quote({ targetPool, rigId, lengthHours }) {
  const target = normalizedTarget(targetPool);
  const algo = TARGET_TO_ALGO[target];
  const selectedRigId = String(rigId || '').trim();
  const hours = Number(lengthHours);
  if (!selectedRigId || selectedRigId.length > 64) {
    throw new ConnectError(400, 'Valid rig_id is required');
  }
  if (!Number.isInteger(hours)) {
    throw new ConnectError(400, 'length_hours must be an advertised whole-hour window');
  }

  const [rigResponse, btcQuote, coinMarket] = await Promise.all([
    makeMrrRequest('GET', '/rig', { type: algo, rented: 'false', limit: '50' }),
    getLiveBtcPrice(),
    getCoinMarketData(algo),
  ]);
  const source = recordsFrom(rigResponse).find(
    (candidate) => String(candidate?.id) === selectedRigId
  );
  if (!source || !rigIsAvailable(source) || !meetsAdvertisedMinimum(source, algo)) {
    throw new ConnectError(409, 'The selected rig is no longer available or eligible');
  }
  const hourly = Number(source?.price?.BTC?.hour || 0);
  if (!(hourly > 0) || source?.price?.BTC?.enabled === false) {
    throw new ConnectError(409, 'The selected rig no longer accepts BTC rentals');
  }
  const windows = advertisedWindows(source);
  if (!windows.includes(hours)) {
    throw new ConnectError(400, 'The selected rental window is not available for this rig');
  }

  const view = buildMarketView({
    records: [source],
    algo,
    btcUsd: btcQuote.price,
    spots: coinMarket.spots,
    profileId: POOL_CONFIG[target].profile,
  });
  const rig = view.rigs[0];
  if (!rig) throw new ConnectError(409, 'The selected rig has invalid market data');

  const feePctValue = Number(process.env.CONNECT_FEE_PCT || 5);
  const feePct = Number.isFinite(feePctValue) && feePctValue >= 0 ? feePctValue : 5;
  const rentalCostBtc = round10(hourly * hours);
  const rentalCostUsd = round4(rentalCostBtc * Number(btcQuote.price));
  const feeUsd = round4(rentalCostUsd * feePct / 100);
  return {
    target_pool: target,
    rig,
    windows,
    rental_cost_btc: rentalCostBtc,
    rental_cost_usd: rentalCostUsd,
    fee_pct: feePct,
    fee_usd: feeUsd,
    total_usd: round4(rentalCostUsd + feeUsd),
    btc_spot_price: Number(btcQuote.price),
    price_feed: btcQuote.feed,
    price_is_usdc_pair: Boolean(btcQuote.isUsdcPair),
  };
}

async function findRequest(requestId) {
  const result = await pool.query(
    `SELECT c.*, LOWER(u.wallet_address) AS owner_wallet
       FROM connect_orders c
       JOIN users u ON u.user_id = c.user_id
      WHERE c.request_id = $1`,
    [requestId]
  );
  return result.rows[0] || null;
}

async function createConnectOrder({
  wallet,
  targetPool,
  payoutAddress,
  rigId,
  lengthHours,
  requestId,
}) {
  const ownerWallet = normalizedWallet(wallet);
  const target = normalizedTarget(targetPool);
  const address = String(payoutAddress || '').trim();
  const idempotencyKey = String(requestId || '').trim();
  if (!idempotencyKey || idempotencyKey.length > 64) {
    throw new ConnectError(400, 'request_id must be 1-64 characters');
  }
  if (!validatePayoutAddress(target, address)) {
    throw new ConnectError(400, `Invalid ${target} payout address`);
  }

  const existing = await findRequest(idempotencyKey);
  if (existing) {
    if (existing.owner_wallet !== ownerWallet) {
      throw new ConnectError(409, 'request_id is already in use');
    }
    return publicOrder(existing);
  }

  const quoted = await quote({ targetPool: target, rigId, lengthHours });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userResult = await client.query(
      'SELECT user_id FROM users WHERE LOWER(wallet_address) = $1 FOR UPDATE',
      [ownerWallet]
    );
    if (userResult.rowCount === 0) throw new ConnectError(404, 'User not found');
    const userId = userResult.rows[0].user_id;

    const lockedDuplicate = await client.query(
      'SELECT * FROM connect_orders WHERE request_id = $1 FOR UPDATE',
      [idempotencyKey]
    );
    if (lockedDuplicate.rowCount > 0) {
      if (lockedDuplicate.rows[0].user_id !== userId) {
        throw new ConnectError(409, 'request_id is already in use');
      }
      await client.query('COMMIT');
      return publicOrder(lockedDuplicate.rows[0]);
    }

    const nonterminal = await client.query(
      `SELECT id FROM connect_orders
        WHERE user_id = $1
          AND status IN ('PENDING_RENT', 'RENTING', 'POOL_POINTED', 'ACTIVE', 'FAILED_REVIEW')
        FOR UPDATE`,
      [userId]
    );
    if (nonterminal.rowCount > 0) {
      throw new ConnectError(409, 'You already have a Connect order in progress');
    }

    const walletResult = await client.query(
      'SELECT wallet_id, usdc_balance FROM user_wallets WHERE user_id = $1 FOR UPDATE',
      [userId]
    );
    if (walletResult.rowCount === 0) throw new ConnectError(404, 'User wallet not found');
    if (Number(walletResult.rows[0].usdc_balance) < quoted.total_usd) {
      throw new ConnectError(400, 'Insufficient USDC balance');
    }

    const rigHashrateNice = String(
      quoted.rig.hashrate_nice || `${quoted.rig.hashrate_ghs} GH/s`
    );
    const inserted = await client.query(
      `INSERT INTO connect_orders
        (user_id, request_id, target_pool, payout_address, rig_id, rig_name,
         rig_hashrate_nice, length_hours, rental_cost_btc, btc_spot_price,
         rental_cost_usd, fee_pct, fee_usd, total_usd, pool_stats_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (request_id) DO NOTHING
       RETURNING *`,
      [
        userId,
        idempotencyKey,
        target,
        address,
        String(quoted.rig.rig_id),
        String(quoted.rig.name || ''),
        rigHashrateNice,
        Number(lengthHours),
        quoted.rental_cost_btc,
        quoted.btc_spot_price,
        quoted.rental_cost_usd,
        quoted.fee_pct,
        quoted.fee_usd,
        quoted.total_usd,
        POOL_CONFIG[target].link(address),
      ]
    );
    if (inserted.rowCount === 0) {
      await client.query('ROLLBACK');
      const winner = await findRequest(idempotencyKey);
      if (!winner || winner.owner_wallet !== ownerWallet) {
        throw new ConnectError(409, 'request_id is already in use');
      }
      return publicOrder(winner);
    }

    const order = inserted.rows[0];
    await client.query(
      `UPDATE user_wallets
          SET usdc_balance = usdc_balance - $1, updated_at = CURRENT_TIMESTAMP
        WHERE wallet_id = $2`,
      [quoted.total_usd, walletResult.rows[0].wallet_id]
    );
    await client.query(
      `INSERT INTO protocol_revenue_ledger
        (source_user_id, amount_usdc, transaction_type, connect_order_id)
       VALUES ($1, $2, $3, $4)`,
      [userId, quoted.fee_usd, 'CONNECT_FEE', order.id]
    );
    await client.query('COMMIT');
    return publicOrder(order);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function listConnectOrders(wallet) {
  const ownerWallet = normalizedWallet(wallet);
  const result = await pool.query(
    `SELECT c.id, c.target_pool, c.payout_address, c.rig_name,
            c.rig_hashrate_nice, c.length_hours, c.total_usd, c.status,
            c.failure_reason, c.mrr_rental_id, c.rental_ends_at,
            c.hashrate_confirmed_at, c.unpaid_last, c.unpaid_checked_at,
            c.paid_out_at, c.pool_stats_url, c.created_at
       FROM connect_orders c
       JOIN users u ON u.user_id = c.user_id
      WHERE LOWER(u.wallet_address) = $1
      ORDER BY c.created_at DESC
      LIMIT 25`,
    [ownerWallet]
  );
  return result.rows;
}

module.exports = {
  ADDRESS_RULES,
  ADVERTISED_WINDOWS,
  ConnectError,
  POOL_CONFIG,
  TARGET_TO_ALGO,
  advertisedWindows,
  createConnectOrder,
  listConnectOrders,
  marketFor,
  quote,
  validatePayoutAddress,
};
