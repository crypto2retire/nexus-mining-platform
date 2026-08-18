const axios = require('axios');
const crypto = require('crypto');

/**
 * MiningRigRentals (MRR) Hashrate Marketplace client (API v2, HMAC-signed).
 *
 * Alternative to NiceHash for the Nexus upgrade loop. Same interface as
 * hashrateRenter.js so the controller can switch providers via
 * MARKETPLACE_PROVIDER=nicehash|mrr.
 *
 * API essentials (verified live 2026-08-18 against www.miningrigrentals.com):
 *   - Base: https://www.miningrigrentals.com/api/v2
 *   - Auth headers: x-api-key, x-api-nonce (must increase per call),
 *     x-api-sign = hex HMAC-SHA1(apiKey + nonce + endpoint, apiSecret)
 *     where endpoint is the path WITHOUT trailing slash and WITHOUT query.
 *   - Endpoints: GET /info/algos (public), GET /rig (public market data),
 *     GET /account/profile (pool profiles), POST /rig/{id} (rent a rig,
 *     body {length: hours, profileid}), GET /rental/{id} (rental status).
 *   - Payment is BTC/LTC/ETH/BCH/DOGE balance held on the MRR account —
 *     NOT USDC. The Nexus loop converts USDC -> BTC at spot, so the MRR
 *     account must hold a BTC balance to cover orders.
 *   - No testnet (unlike NiceHash). Live orders require NODE_ENV=production
 *     + MRR_API_KEY/MRR_API_SECRET + MRR_LIVE_ORDERS=1.
 *
 * SAFETY RAILS — real orders move real BTC, so live placement requires ALL of:
 *   1. NODE_ENV === 'production'
 *   2. MRR_API_KEY / MRR_API_SECRET set
 *   3. MRR_LIVE_ORDERS === '1' (explicit opt-in)
 * Any other combination returns a simulated sandbox order (or a hard error in
 * production when live placement is requested but not enabled).
 */

const MRR_HOST = 'https://www.miningrigrentals.com/api/v2';

// Uppercase values keep the hashrate_orders.algorithm audit column consistent
// with the NiceHash provider; lowercase before hitting the MRR API.
const POOL_ALGORITHM_MAP = {
  ZCASH: 'ZHASH',
  KASPA: 'KHEAVYHASH',
  LTC_DOGE: 'SCRYPT',
  // XMR is a SELF-MINED pool — no marketplace order is placed for it.
  XMR: 'RANDOMX',
};

const PROVIDER_NAME = 'MRR';
const LIVE_ORDERS_ENV = 'MRR_LIVE_ORDERS';

/**
 * Real order placement requires ALL of:
 *   - keys set (MRR_API_KEY / MRR_API_SECRET)
 *   - MRR_LIVE_ORDERS === '1' (explicit opt-in)
 *   - NODE_ENV === 'production' (no testnet exists for MRR)
 */
function isLiveMode() {
  const hasKeys =
    Boolean(process.env.MRR_API_KEY) && Boolean(process.env.MRR_API_SECRET);
  if (!hasKeys || process.env.MRR_LIVE_ORDERS !== '1') return false;
  return process.env.NODE_ENV === 'production';
}

function to8(value) {
  return parseFloat(Number(value).toFixed(8));
}

// MRR requires the nonce to be greater than the previous call's nonce.
// Seconds + milliseconds is monotonic in practice; the guard bumps it if a
// clock collision ever occurs within this process.
let lastNonce = 0;
function nextNonce() {
  const now = Date.now();
  let n = Number(`${Math.floor(now / 1000)}${String(now % 1000).padStart(3, '0')}`);
  if (n <= lastNonce) n = lastNonce + 1;
  lastNonce = n;
  return String(n);
}

/**
 * Builds the MRR API v2 HMAC-SHA1 signature.
 * Message layout (per MRR docs): apiKey + nonce + endpoint — concatenated,
 * NO separators, endpoint WITHOUT trailing slash and WITHOUT query string.
 * @returns {string} hex signature (40 chars)
 */
function buildMrrSignature({ apiKey, nonce, endpoint, apiSecret }) {
  const key = apiKey || process.env.MRR_API_KEY || '';
  const secret = apiSecret || process.env.MRR_API_SECRET || '';
  // MRR signs the path WITHOUT trailing slash (and without query string).
  const cleanEndpoint = String(endpoint || '').replace(/\/+$/, '');
  const message = `${key}${nonce}${cleanEndpoint}`;
  return crypto.createHmac('sha1', secret).update(message, 'utf-8').digest('hex');
}

async function makeMrrRequest(method, path, query = null, bodyObj = null) {
  const nonce = nextNonce();
  const endpoint = path.replace(/\/+$/, ''); // no trailing slash in signature
  const headers = {
    'x-api-key': process.env.MRR_API_KEY || '',
    'x-api-nonce': nonce,
    'x-api-sign': buildMrrSignature({
      apiKey: process.env.MRR_API_KEY,
      nonce,
      endpoint,
      apiSecret: process.env.MRR_API_SECRET,
    }),
    'Content-Type': 'application/json',
  };

  const queryString = query ? new URLSearchParams(query).toString() : '';
  const body = bodyObj ? JSON.stringify(bodyObj) : null;
  const url = `${MRR_HOST}${path}${queryString ? `?${queryString}` : ''}`;

  // Same pitfall as NiceHash: only attach `data` when there is a body.
  // GET requests with `data: null` + Content-Type: application/json can
  // trip servers into malformed-payload 400s.
  const requestConfig = { method, url, headers, timeout: 30000 };
  if (body) {
    requestConfig.data = body;
  }

  const response = await axios(requestConfig);
  return response.data;
}

/** Full algorithm list with suggested prices (public). */
async function getAlgorithms() {
  const data = await makeMrrRequest('GET', '/info/algos');
  return data;
}

/** Pool profiles on the MRR account (needed to point rented hashrate). */
async function getPoolProfiles() {
  const data = await makeMrrRequest('GET', '/account/profile');
  return data;
}

/**
 * Finds the cheapest available rig for an algorithm that fits a BTC budget.
 * Uses the rig's minimum hours (minhours) as the floor; extends the rental
 * length up to maxhours while the hourly cost stays within the budget.
 *
 * @returns {Promise<{rigId, rigName, hourly, length, cost, hashrate}|null>}
 */
async function findAffordableRig(algorithm, budgetBtc) {
  const data = await makeMrrRequest('GET', '/rig', {
    type: algorithm,
    rented: 'false',
    orderby: 'price',
    orderdir: 'asc',
    limit: '10',
  });
  const records = data?.data?.records || [];
  for (const rig of records) {
    const hourly = Number(rig?.price?.BTC?.hour || 0);
    if (!hourly) continue;
    const minHours = Number(rig?.minhours || 0);
    const maxHours = Number(rig?.maxhours || Math.max(minHours, 24));
    if (!minHours) continue;
    const length = Math.min(Math.max(Math.floor(budgetBtc / hourly), minHours), maxHours);
    const cost = to8(length * hourly);
    if (cost <= budgetBtc) {
      return {
        rigId: rig.id,
        rigName: rig.name || '',
        hourly,
        length,
        cost,
        hashrate: rig.hashrate || null,
      };
    }
  }
  return null;
}

/** Rental status lookup for audit/UI. */
async function getOrderStatus(orderId) {
  const data = await makeMrrRequest(
    'GET',
    `/rental/${encodeURIComponent(orderId)}`
  );
  return data;
}

/**
 * Places a MiningRigRentals rental order for the given target pool.
 *
 * @param {string} targetPool - one of ZCASH, KASPA, LTC_DOGE
 * @param {number} spendBtcAmount - BTC amount to spend (e.g. 0.000475)
 * @returns {Promise<{success: boolean, mode: 'sandbox'|'live', orderId?: string, sandbox?: boolean, error?: string, mrrResponse?: object}>}
 */
async function placeHashpowerOrder(targetPool, spendBtcAmount) {
  const algorithm = POOL_ALGORITHM_MAP[targetPool];
  if (!algorithm) {
    return { success: false, mode: 'sandbox', error: `Unknown target pool: ${targetPool}` };
  }

  // Production without explicit live opt-in must NEVER silently simulate.
  if (process.env.NODE_ENV === 'production' && !isLiveMode()) {
    return {
      success: false,
      mode: 'sandbox',
      error:
        'Live MiningRigRentals orders are not enabled. Set MRR_LIVE_ORDERS=1 and configure ' +
        'MRR_API_KEY/MRR_API_SECRET before going live.',
    };
  }

  if (!isLiveMode()) {
    console.warn('🏖️ Sandbox mode: MiningRigRentals order simulated.', {
      targetPool,
      algorithm,
      spendBtcAmount,
    });
    return {
      success: true,
      mode: 'sandbox',
      orderId: `sandbox-mrr-${crypto.randomUUID()}`,
      sandbox: true,
    };
  }

  try {
    // The MRR account must hold a pool profile (pointing at the Nexus pool)
    // for each algorithm before live orders can be placed.
    const profileId = process.env[`MRR_POOL_PROFILE_${algorithm}`] || '';
    if (!profileId) {
      return {
        success: false,
        mode: 'live',
        error:
          `MRR_POOL_PROFILE_${algorithm} is required for live orders. Create a pool profile ` +
          'in the MiningRigRentals account and set the env var to its id.',
      };
    }

    // Financial integrity: never spend MORE than the user paid to satisfy a
    // rig minimum. If the cheapest rig's minimum cost exceeds the budget the
    // upgrade is rejected; the controller refunds the user automatically.
    const fit = await findAffordableRig(algorithm.toLowerCase(), spendBtcAmount);
    if (!fit) {
      return {
        success: false,
        mode: 'live',
        error:
          `No affordable ${algorithm} rig on MiningRigRentals within ${to8(spendBtcAmount)} BTC. ` +
          'Upgrade below the cheapest available rig minimum — no order placed.',
      };
    }

    const result = await makeMrrRequest(
      'POST',
      `/rig/${fit.rigId}`,
      null,
      { length: fit.length, profileid: profileId }
    );

    const orderId =
      result?.data?.rental?.id ||
      result?.data?.id ||
      result?.rental?.id ||
      result?.id ||
      null;

    return {
      success: true,
      mode: 'live',
      orderId,
      mrrResponse: result,
    };
  } catch (err) {
    console.error('❌ MRR order placement failed:', err.response?.data || err.message);
    return {
      success: false,
      mode: 'live',
      error: err.response?.data?.data?.message || err.response?.data?.message || err.message,
    };
  }
}

module.exports = {
  placeHashpowerOrder,
  getOrderStatus,
  getAlgorithms,
  getPoolProfiles,
  findAffordableRig,
  buildMrrSignature,
  makeMrrRequest,
  isLiveMode,
  POOL_ALGORITHM_MAP,
  PROVIDER_NAME,
  LIVE_ORDERS_ENV,
  MRR_HOST,
};
