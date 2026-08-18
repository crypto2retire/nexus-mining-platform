const axios = require('axios');
const crypto = require('crypto');

const IS_PROD = process.env.NODE_ENV === 'production';

const NICEHASH_HOST = IS_PROD
  ? 'https://api2.nicehash.com'
  : 'https://api-test.nicehash.com';

const API_KEY = process.env.NICEHASH_API_KEY || '';
const API_SECRET = process.env.NICEHASH_API_SECRET || '';
const ORG_ID = process.env.NICEHASH_ORG_ID || '';

const POOL_ALGORITHM_MAP = {
  ZCASH: 'ZHASH',
  KASPA: 'KHEAVYHASH',
  LTC_DOGE: 'SCRYPT',
};

function getEpochMs() {
  return Date.now();
}

function generateNonce() {
  return crypto.randomUUID();
}

function buildSignature({ xTime, xNonce, method, path, query, body }) {
  const msgParts = [
    API_KEY,
    xTime,
    xNonce,
    '', // empty field
    ORG_ID,
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
    .createHmac('sha256', API_SECRET)
    .update(message)
    .digest('hex');
}

async function makeNiceHashRequest(method, path, query = null, bodyObj = null) {
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
    'X-Auth': `${API_KEY}:${signature}`,
    'X-Organization-Id': ORG_ID,
    'X-Request-Id': crypto.randomUUID(),
    'Content-Type': 'application/json',
  };

  const url = `${NICEHASH_HOST}${path}${queryString ? `?${queryString}` : ''}`;
  const response = await axios({
    method,
    url,
    headers,
    data: body,
    timeout: 30000,
  });

  return response.data;
}

async function getBuyInfo(algorithm) {
  const data = await makeNiceHashRequest(
    'GET',
    '/main/api/v2/public/buy/info',
    { algorithm }
  );
  return data;
}

/**
 * Places a NiceHash hashpower order.
 * In non-production mode (or when credentials are missing), returns a sandbox
 * order response without touching real funds.
 *
 * @param {string} targetPool - one of ZCASH, KASPA, LTC_DOGE
 * @param {number} spendBtcAmount - BTC amount to spend (e.g. 0.00123456)
 * @returns {Promise<{success: boolean, orderId?: string, sandbox?: boolean, error?: string}>}
 */
async function placeHashpowerOrder(targetPool, spendBtcAmount) {
  const algorithm = POOL_ALGORITHM_MAP[targetPool];
  if (!algorithm) {
    return { success: false, error: `Unknown target pool: ${targetPool}` };
  }

  if (!IS_PROD || !API_KEY || !API_SECRET || !ORG_ID) {
    console.warn('🏖️ Sandbox mode: NiceHash order simulated.', {
      targetPool,
      algorithm,
      spendBtcAmount,
    });
    return {
      success: true,
      orderId: `sandbox-${crypto.randomUUID()}`,
      sandbox: true,
    };
  }

  try {
    const buyInfo = await getBuyInfo(algorithm);
    const market = buyInfo?.market || 'EU';
    const marketFactor = buyInfo?.marketFactor || 1;
    const displayMarketFactor = buyInfo?.displayMarketFactor || 'GH';
    const displayPriceFactor = buyInfo?.displayPriceFactor || 'GH';
    const priceFactor = buyInfo?.priceFactor || 1;
    const minAmount = buyInfo?.minAmount || 0.001;
    const minPrice = buyInfo?.minPrice || 0.0001;

    const amount = Math.max(parseFloat(spendBtcAmount.toFixed(8)), minAmount);
    const price = Math.max(minPrice, parseFloat((amount * 0.0001).toFixed(8)));
    const limit = 0; // unlimited speed

    const body = {
      market,
      algorithm,
      type: 'STANDARD',
      currencyMarket: 'BTC',
      amount,
      price,
      limit,
      marketFactor,
      displayMarketFactor,
      priceFactor,
      displayPriceFactor,
      // NOTE: poolId must be a real NiceHash pool registered under your account.
      // For sandbox mode this is skipped. In production, create a pool first via POST /main/api/v2/pool
      poolId: process.env.NICEHASH_POOL_ID || '',
    };

    const result = await makeNiceHashRequest(
      'POST',
      '/main/api/v2/hashpower/order',
      null,
      body
    );

    return {
      success: true,
      orderId: result?.id || result?.orderId || null,
      niceHashResponse: result,
    };
  } catch (err) {
    console.error('❌ NiceHash order placement failed:', err.response?.data || err.message);
    return {
      success: false,
      error: err.response?.data?.errors?.[0]?.message || err.message,
    };
  }
}

module.exports = { placeHashpowerOrder, POOL_ALGORITHM_MAP };
