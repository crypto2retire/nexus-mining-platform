const axios = require('axios');
const crypto = require('crypto');

/**
 * NiceHash Hashrate Marketplace client (API v2, HMAC-signed).
 *
 * SAFETY RAILS — real orders move real BTC, so live placement requires ALL of:
 *   1. NODE_ENV === 'production'
 *   2. NICEHASH_API_KEY / NICEHASH_API_SECRET / NICEHASH_ORG_ID set
 *   3. NICEHASH_LIVE_ORDERS === '1' (explicit opt-in)
 * Any other combination returns a simulated sandbox order (or a hard error in
 * production when live placement is requested but not enabled). The controller
 * layer refuses to move user funds unless the order was REALLY placed.
 */

/**
 * Host selection: NICEHASH_ENV=test routes ALL requests to the free NiceHash
 * TESTNET (api-test.nicehash.com) — test BTC, no real funds. Default = mainnet.
 */
function getNiceHashHost() {
  return (process.env.NICEHASH_ENV || 'main') === 'test'
    ? 'https://api-test.nicehash.com'
    : 'https://api2.nicehash.com';
}

const NICEHASH_HOST = 'https://api2.nicehash.com';
const NICEHASH_TEST_HOST = 'https://api-test.nicehash.com';

const PROVIDER_NAME = 'NICEHASH';
const LIVE_ORDERS_ENV = 'NICEHASH_LIVE_ORDERS';

const POOL_ALGORITHM_MAP = {
  ZCASH: 'ZHASH',
  KASPA: 'KHEAVYHASH',
  LTC_DOGE: 'SCRYPT',
  BTC: 'SHA256',
};

/**
 * Real order placement requires ALL of:
 *   - keys set (API_KEY / API_SECRET / ORG_ID)
 *   - NICEHASH_LIVE_ORDERS === '1' (explicit opt-in)
 *   - AND EITHER NICEHASH_ENV=test (free testnet) OR NODE_ENV=production (mainnet)
 */
function isLiveMode() {
  const hasKeys =
    Boolean(process.env.NICEHASH_API_KEY) &&
    Boolean(process.env.NICEHASH_API_SECRET) &&
    Boolean(process.env.NICEHASH_ORG_ID);
  if (!hasKeys || process.env.NICEHASH_LIVE_ORDERS !== '1') return false;
  if ((process.env.NICEHASH_ENV || 'main') === 'test') return true;
  return process.env.NODE_ENV === 'production';
}

function to8(value) {
  return parseFloat(Number(value).toFixed(8));
}

function getEpochMs() {
  return Date.now();
}

function generateNonce() {
  return crypto.randomUUID();
}

/**
 * Builds the NiceHash API v2 HMAC-SHA256 signature.
 * Message layout (per NiceHash docs / rest-clients-demo):
 *   apiKey \0 time \0 nonce \0 "" \0 orgId \0 "" \0 METHOD \0 path \0 query [ \0 body ]
 * @returns {string} hex signature
 */
function buildSignature({ xTime, xNonce, method, path, query, body, apiKey, apiSecret, orgId }) {
  const key = apiKey || process.env.NICEHASH_API_KEY || '';
  const secret = apiSecret || process.env.NICEHASH_API_SECRET || '';
  const organizationId = orgId || process.env.NICEHASH_ORG_ID || '';

  const msgParts = [
    key,
    xTime,
    xNonce,
    '', // empty field
    organizationId,
    '', // empty field
    method.toUpperCase(),
    path,
    query || '',
  ];

  let message = Buffer.from(msgParts.join('\x00'), 'utf-8');
  if (body) {
    const bodyBuffer = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf-8');
    message = Buffer.concat([message, Buffer.from('\x00', 'utf-8'), bodyBuffer]);
  }

  return crypto
    .createHmac('sha256', secret)
    .update(message)
    .digest('hex');
}

async function makeNiceHashRequest(method, path, query = null, bodyObj = null, requestId = null) {
  const xTime = getEpochMs();
  const xNonce = generateNonce();
  const queryString = query ? new URLSearchParams(query).toString() : '';
  const body = bodyObj ? JSON.stringify(bodyObj) : null;

  const signature = buildSignature({
    xTime,
    xNonce,
    method,
    path,
    query: queryString,
    body,
  });

  const headers = {
    'X-Time': String(xTime),
    'X-Nonce': xNonce,
    'X-Auth': `${process.env.NICEHASH_API_KEY}:${signature}`,
    'X-Organization-Id': process.env.NICEHASH_ORG_ID,
    'X-Request-Id': requestId || crypto.randomUUID(),
    'Content-Type': 'application/json',
  };

  const url = `${getNiceHashHost()}${path}${queryString ? `?${queryString}` : ''}`;

  // CRITICAL: only attach `data` when there is a body. NiceHash returns 400 on
  // GET requests that carry `data: null` + Content-Type: application/json
  // (axios sends an empty JSON payload the server treats as malformed).
  const requestConfig = { method, url, headers, timeout: 30000 };
  if (body) {
    requestConfig.data = body;
  }

  const response = await axios(requestConfig);

  return response.data;
}

/** Algorithm limits & market factors. Always validate before placing an order. */
async function getAlgorithms() {
  const data = await makeNiceHashRequest(
    'GET',
    '/main/api/v2/mining/algorithms'
  );
  return data;
}

/** Per-algorithm order book info (min price, min amount, limits). */
async function getBuyInfo(algorithm) {
  const data = await makeNiceHashRequest(
    'GET',
    '/main/api/v2/public/buy/info',
    { algorithm }
  );
  return data;
}

/** Order status lookup for audit/UI. */
async function getOrderStatus(orderId) {
  const data = await makeNiceHashRequest(
    'GET',
    `/main/api/v2/hashpower/order/${encodeURIComponent(orderId)}/`
  );
  return data;
}

/**
 * Places a NiceHash hashpower order for the given target pool.
 *
 * @param {string} targetPool - one of ZCASH, KASPA, LTC_DOGE
 * @param {number} spendBtcAmount - BTC amount to spend (e.g. 0.000475)
 * @returns {Promise<{success: boolean, mode: 'sandbox'|'live', orderId?: string, sandbox?: boolean, error?: string, niceHashResponse?: object}>}
 */
async function placeHashpowerOrder(targetPool, spendBtcAmount, requestId = null) {
  const algorithm = POOL_ALGORITHM_MAP[targetPool];
  if (!algorithm) {
    return { success: false, mode: 'sandbox', error: `Unknown target pool: ${targetPool}` };
  }

  // Production (mainnet) without explicit live opt-in must NEVER silently simulate.
  // (Testnet is exempt — NICEHASH_ENV=test is always a safe, free environment.)
  if (process.env.NODE_ENV === 'production' && (process.env.NICEHASH_ENV || 'main') !== 'test' && !isLiveMode()) {
    return {
      success: false,
      mode: 'sandbox',
      error:
        'Live NiceHash orders are not enabled. Set NICEHASH_LIVE_ORDERS=1 and configure ' +
        'NICEHASH_API_KEY/NICEHASH_API_SECRET/NICEHASH_ORG_ID before going live.',
    };
  }

  if (!isLiveMode()) {
    console.warn('🏖️ Sandbox mode: NiceHash order simulated.', {
      targetPool,
      algorithm,
      spendBtcAmount,
    });
    return {
      success: true,
      mode: 'sandbox',
      orderId: `sandbox-${crypto.randomUUID()}`,
      sandbox: true,
    };
  }

  try {
    const poolId = process.env.NICEHASH_POOL_ID || '';
    if (!poolId) {
      return {
        success: false,
        mode: 'live',
        error:
          'NICEHASH_POOL_ID is required for live orders. Create a pool via POST /main/api/v2/pool first.',
      };
    }

    // Pull real limits from the marketplace (official demo flow):
    //   - /main/api/v2/mining/algorithms -> marketFactor, displayMarketFactor, order limits
    //   - /main/api/v2/public/buy/info    -> min price/amount per algorithm
    const [algoRes, buyInfo] = await Promise.all([
      getAlgorithms(),
      getBuyInfo(algorithm),
    ]);
    const algo = (algoRes?.miningAlgorithms || []).find(
      (a) => a?.algorithm === algorithm
    );
    const book = (buyInfo?.miningAlgorithms || []).find(
      (a) => String(a?.name || a?.algorithm || '').toUpperCase() === algorithm.toUpperCase()
    );

    const minimalOrderAmount = Number(algo?.minimalOrderAmount ?? book?.min_amount ?? 0.001);
    const minSpeedLimit = Number(algo?.minSpeedLimit ?? book?.min_limit ?? 0);
    const maxSpeedLimit = Number(algo?.maxSpeedLimit ?? book?.max_limit ?? 0);
    const minPrice = Number(book?.min_price ?? 0.0001);
    const marketFactor = Number(algo?.marketFactor ?? 1);
    const displayMarketFactor = algo?.displayMarketFactor || 'GH';
    const market = process.env.NICEHASH_MARKET || 'EU';

    // Financial integrity: never place an order that spends MORE than the user
    // paid just to satisfy the marketplace minimum. Below-minimum upgrades are
    // rejected; the controller refunds the user automatically.
    if (to8(spendBtcAmount) < minimalOrderAmount) {
      return {
        success: false,
        mode: 'live',
        error: `Upgrade below NiceHash marketplace minimum order amount (${minimalOrderAmount} BTC) for ${algorithm}.`,
      };
    }

    const amount = to8(spendBtcAmount);
    const price = Math.max(
      Number(process.env.NICEHASH_ORDER_PRICE || minPrice),
      minPrice
    );
    const configuredLimit = Number(process.env.NICEHASH_ORDER_LIMIT || minSpeedLimit || 0);
    const limit = maxSpeedLimit > 0 ? Math.min(configuredLimit, maxSpeedLimit) : configuredLimit;

    const body = {
      market,
      algorithm,
      type: 'STANDARD',
      amount,
      price,
      limit,
      marketFactor,
      displayMarketFactor,
      poolId,
    };

    // Retries for one Nexus order reuse a deterministic provider request id.
    // This lets NiceHash reject/reconcile a repeated POST instead of creating
    // a second live order after a worker crash.
    const requestHash = requestId
      ? crypto.createHash('sha256').update(String(requestId)).digest('hex').slice(0, 32)
      : null;
    const providerRequestId = requestHash
      ? `${requestHash.slice(0, 8)}-${requestHash.slice(8, 12)}-${requestHash.slice(12, 16)}-${requestHash.slice(16, 20)}-${requestHash.slice(20)}`
      : null;
    const result = await makeNiceHashRequest(
      'POST',
      '/main/api/v2/hashpower/order/',
      null,
      body,
      providerRequestId
    );

    return {
      success: true,
      mode: 'live',
      orderId: result?.id || result?.orderId || null,
      niceHashResponse: result,
    };
  } catch (err) {
    console.error('❌ NiceHash order placement failed:', err.response?.data || err.message);
    return {
      success: false,
      mode: 'live',
      error: err.response?.data?.errors?.[0]?.message || err.message,
    };
  }
}

module.exports = {
  placeHashpowerOrder,
  getOrderStatus,
  getBuyInfo,
  getAlgorithms,
  getNiceHashHost,
  buildSignature,
  makeNiceHashRequest,
  isLiveMode,
  POOL_ALGORITHM_MAP,
  PROVIDER_NAME,
  LIVE_ORDERS_ENV,
  NICEHASH_HOST,
  NICEHASH_TEST_HOST,
};
