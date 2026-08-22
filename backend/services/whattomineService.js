const axios = require('axios');
const { pool } = require('../config/db');
const { getBacking } = require('./backingMonitor');
const { configFor } = require('./operatorMarketService');

/**
 * whattomineService.js — WhatToMine verification + coin-scan tool
 * (Kevin 2026-08-22: "add whattomine data… verify data, look for new coins
 * to mine… if it is useful to me for testing it will be useful to users
 * when live").
 *
 * LICENSE (Kevin's rule 2026-08-21, still in force): the free WhatToMine API
 * is NOT commercially licensed. This tool is OPERATOR-ONLY (wallet-gated)
 * for verification/decision support. Going user-facing requires the paid
 * tier — that is the "worth the cost" question Kevin is testing.
 *
 * Rate budget: trial key = 1000 calls/month. Cache aggressively (coins 1h,
 * calculate 5min), surface X-RateLimit-Remaining on every response.
 */

const WTM_BASE = 'https://whattomine.com/api/v1';
const TTL_COINS_MS = 60 * 60 * 1000;
const TTL_CALC_MS = 5 * 60 * 1000;

// Our rentable rig classes → WhatToMine algorithm param + realistic power
// (W). Hashrate is passed per-rig at call time. Powers are public estimates
// (skill ref 2026-08-21); verify before any purchase decision.
const ALGO_PARAM = {
  KASPA: 'hh', // kHeavyHash
  ZCASH: 'eq', // Equihash
  LTC_DOGE: 'scrypt',
  BTC: 'sha256',
  XMR: 'rmx',
};
const RIG_POWER_W = {
  KASPA: 50, // KS0 PRO class
  ZCASH: 1500, // Z15 class
  LTC_DOGE: 3425, // L7 class
  BTC: 3500, // S21 class
  XMR: 280, // EPYC-class CPU
};

let coinsCache = { rows: null, at: 0 };
let calcCache = { rows: null, at: 0 };
let lastRateLimit = null;

function token() {
  return String(process.env.WTM_API_TOKEN || '').trim();
}

function configured() {
  return Boolean(token());
}

async function wtmRequest(method, path, body) {
  const headers = { Authorization: `Token ${token()}` };
  const response = await axios({ method, url: `${WTM_BASE}${path}`, headers, data: body, timeout: 15000 });
  const remaining = response.headers?.['x-ratelimit-remaining'];
  if (remaining != null) lastRateLimit = { remaining: Number(remaining), at: Date.now() };
  return response.data;
}

async function getCoins({ force = false } = {}) {
  if (!configured()) throw new Error('WTM_API_TOKEN is not configured');
  if (!force && coinsCache.rows && Date.now() - coinsCache.at < TTL_COINS_MS) return coinsCache.rows;
  const data = await wtmRequest('GET', '/coins');
  coinsCache = { rows: data, at: Date.now() };
  return data;
}

async function calculate(settings, { force = false } = {}) {
  if (!configured()) throw new Error('WTM_API_TOKEN is not configured');
  const key = JSON.stringify(settings);
  if (!force && calcCache.rows && calcCache.key === key && Date.now() - calcCache.at < TTL_CALC_MS) {
    return calcCache.rows;
  }
  const data = await wtmRequest('POST', '/calculate', { cost: 0.12, settings });
  calcCache = { rows: data, key, at: Date.now() };
  return data;
}

/** Top-exchange liquidity per coin (BTC/day) from /api/v1/coins — the
 * anti-mirage filter (skill: vol < $1k/day = unsellable regardless of
 * profit; ≥ $10k/day to plan on selling). */
function liquidityByCoin(coins) {
  const byTag = {};
  for (const coin of coins || []) {
    const exchanges = coin.exchanges || [];
    let best = 0;
    let bestName = '';
    for (const ex of exchanges) {
      const vol = Number(ex?.volume || 0);
      if (vol > best) {
        best = vol;
        bestName = String(ex?.name || '');
      }
    }
    byTag[coin.tag] = { top_volume_btc_day: best, top_exchange: bestName, market_cap: coin.market_cap, price: coin.price, price30: coin.price30 };
  }
  return byTag;
}

function fmtHashrate(hashrate, unit) {
  // normalize rig hashrate to the base unit WTM expects: H/s for most,
  // Sol/s for equihash.
  const multiplier = { h: 1, kh: 1e3, mh: 1e6, gh: 1e9, th: 1e12, ph: 1e15 }[
    String(unit || '').toLowerCase()
  ];
  return multiplier === undefined ? Number(hashrate) || 0 : Number(hashrate) * multiplier;
}

/**
 * Verify our production anchors against WhatToMine + (where available) the
 * pool's own 24h measurement. Per mined coin:
 *   rented hashrate → WTM estimated_rewards24 vs our anchor/day vs pool 24h.
 */
async function verifyAnchors(userId) {
  if (!configured()) throw new Error('WTM_API_TOKEN is not configured');
  const [rentalRows, backing] = await Promise.all([
    pool.query(
      `SELECT rr.target_pool, COALESCE(SUM(h.requested_rig_hashrate), 0) AS hash_total
         FROM rig_rentals rr
         LEFT JOIN hashrate_orders h ON h.nicehash_order_id = rr.mrr_rental_id
        WHERE rr.user_id = $1 AND rr.status = 'ACTIVE'
        GROUP BY rr.target_pool`,
      [userId]
    ),
    getBacking(),
  ]);

  const settings = [];
  const rowsByPool = {};
  for (const row of rentalRows.rows) {
    const algo = ALGO_PARAM[row.target_pool];
    if (!algo) continue;
    const unit = { ZCASH: 'kh', KASPA: 'gh', LTC_DOGE: 'gh', BTC: 'th', XMR: 'kh' }[row.target_pool];
    const hashrateBase = fmtHashrate(row.hash_total, unit);
    if (hashrateBase <= 0) continue;
    rowsByPool[row.target_pool] = row;
    settings.push({
      algorithm: algo,
      power: RIG_POWER_W[row.target_pool] || 0,
      hashrate: hashrateBase,
    });
  }

  let wtmRows = [];
  if (settings.length) {
    const calc = await calculate(settings);
    wtmRows = Array.isArray(calc) ? calc : calc?.coins ? Object.values(calc.coins) : [];
  }

  // Match WTM rows back by algorithm; WTM returns one row per mineable coin
  // per algo — take the row whose tag matches our primary coin.
  const out = [];
  for (const [targetPool, row] of Object.entries(rowsByPool)) {
    const config = configFor({ KASPA: 'kheavyhash', ZCASH: 'equihash', LTC_DOGE: 'scrypt', BTC: 'sha256' }[targetPool] || targetPool);
    const anchorDay = config ? (Number(row.hash_total) * (ALGO_UNIT_GHS[targetPool] || 1) / config.anchorGhs) * Object.values(config.coins)[0].production : null;
    const primary = { KASPA: 'KAS', ZCASH: 'ZEC', LTC_DOGE: 'LTC', BTC: 'BTC' }[targetPool];
    const wtmMatch = wtmRows.find((w) => String(w.tag || '').toUpperCase() === primary);
    const backingInfo = backing[targetPool] || {};
    out.push({
      target_pool: targetPool,
      coin: primary,
      rented_hashrate: Number(row.hash_total),
      rented_unit: { ZCASH: 'KH/s', KASPA: 'GH/s', LTC_DOGE: 'GH/s', BTC: 'TH/s' }[targetPool],
      // WhatToMine's estimate for the rented hashrate (24h, primary coin).
      wtm_est_24h: wtmMatch ? Number(wtmMatch.estimated_rewards24 ?? wtmMatch.estimated_rewards) : null,
      wtm_coin: wtmMatch?.name || null,
      // Our anchor estimate (24h, primary coin).
      anchor_est_24h: anchorDay,
      // Pool's OWN current accrued balance (real ground truth, cumulative).
      pool_unpaid: backingInfo.pool_unpaid != null ? Number(backingInfo.pool_unpaid) : null,
      pool_unpaid_unit: backingInfo.pool_unpaid_unit || primary,
      ratio_wtm_vs_anchor: anchorDay && anchorDay > 0 && wtmMatch && Number(wtmMatch.estimated_rewards24 ?? wtmMatch.estimated_rewards) > 0
        ? Number(wtmMatch.estimated_rewards24 ?? wtmMatch.estimated_rewards) / anchorDay
        : null,
    });
  }
  return { generated_at: new Date().toISOString(), rate_limit: lastRateLimit, rows: out };
}

const ALGO_UNIT_GHS = { ZCASH: 1e-6, KASPA: 1, LTC_DOGE: 1, BTC: 1e3 };

/** Scan for profitable + liquid mining options using our rentable rig
 * classes (the "look for new coins" use). Applies the liquidity filter. */
async function scanProfitable() {
  if (!configured()) throw new Error('WTM_API_TOKEN is not configured');
  const [coins, calc] = await Promise.all([
    getCoins(),
    calculate([
      { algorithm: 'hh', power: 50, hashrate: 75e9 }, // KS0 PRO class
      { algorithm: 'eq', power: 1500, hashrate: 475e3 }, // Z15 class
      { algorithm: 'scrypt', power: 3425, hashrate: 9.5e9 }, // L7 class
      { algorithm: 'sha256', power: 3500, hashrate: 200e12 }, // S21 class
      { algorithm: 'rmx', power: 280, hashrate: 45e3 }, // EPYC class
    ]),
  ]);
  const liquidity = liquidityByCoin(coins);
  const rows = Array.isArray(calc) ? calc : calc?.coins ? Object.values(calc.coins) : [];
  const ranked = rows
    .map((w) => {
      const liq = liquidity[w.tag] || {};
      const profitUsd = Number(w.profit || 0);
      const revenueUsd = Number(w.revenue || 0);
      return {
        coin: w.tag,
        name: w.name,
        algorithm: w.algorithm || null,
        profit_usd_day: profitUsd,
        revenue_usd_day: revenueUsd,
        wtm_est_24h: Number(w.estimated_rewards24 ?? w.estimated_rewards ?? 0),
        top_volume_btc_day: liq.top_volume_btc_day || 0,
        top_exchange: liq.top_exchange || null,
        market_cap: liq.market_cap != null ? Number(liq.market_cap) : null,
        // Anti-mirage: is the coin actually sellable?
        liquid: (liq.top_volume_btc_day || 0) >= 10000,
        sellable: (liq.top_volume_btc_day || 0) >= 1000,
      };
    })
    .filter((w) => Number.isFinite(w.profit_usd_day))
    .sort((a, b) => b.profit_usd_day - a.profit_usd_day);
  return { generated_at: new Date().toISOString(), rate_limit: lastRateLimit, rows: ranked.slice(0, 50) };
}

/** Coin screen: market cap, volume, 30d momentum, difficulty change. */
async function screenCoins() {
  if (!configured()) throw new Error('WTM_API_TOKEN is not configured');
  const coins = await getCoins();
  const rows = (coins || [])
    .map((c) => {
      const liquidity = liquidityByCoin([c]);
      const l = liquidity[c.tag] || {};
      const price = Number(c.price || 0);
      const price30 = Number(c.price30 || 0);
      return {
        coin: c.tag,
        name: c.name,
        market_cap: l.market_cap != null ? Number(l.market_cap) : null,
        price: price,
        change_30d_pct: price > 0 && price30 > 0 ? ((price / price30) - 1) * 100 : null,
        top_volume_btc_day: l.top_volume_btc_day || 0,
        top_exchange: l.top_exchange || null,
        difficulty_30d_pct: c.difficulty30 ? Number(c.difficulty30) : null,
        block_reward: Number(c.block_reward || 0),
      };
    })
    .sort((a, b) => (b.top_volume_btc_day || 0) - (a.top_volume_btc_day || 0));
  return { generated_at: new Date().toISOString(), rate_limit: lastRateLimit, rows: rows.slice(0, 126) };
}

module.exports = {
  configured,
  verifyAnchors,
  scanProfitable,
  screenCoins,
  ALGO_PARAM,
  RIG_POWER_W,
  __resetCache: () => {
    coinsCache = { rows: null, at: 0 };
    calcCache = { rows: null, key: null, at: 0 };
    lastRateLimit = null;
  },
};
