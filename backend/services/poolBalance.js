const axios = require('axios');

/**
 * Pool balance — live unpaid Monero balance from monero.herominers.com plus
 * a spot XMR/USD price for a human-readable value.
 *
 * The pool API reports balance through the `unlocked` / `unconfirmed` arrays
 * (each entry is a payout record; empty array = nothing due yet).
 */

const POOL_API = 'https://monero.herominers.com/api/stats_address';
const PRICE_API = 'https://api.coingecko.com/api/v3/simple/price';
const DEFAULT_WALLET = '43iF2iW82XCTKrS65Nod5NieyX2fvgDSWYBbr7mVT3GsducRXFEn58pCPXcKM88aS2fXMoJAmkVm4TV3LKndWBT8LJC8t1B';

function sumXmr(records) {
  if (!Array.isArray(records)) return 0;
  return records.reduce((sum, r) => sum + (Number(r?.amount) || 0), 0);
}

async function getPoolBalance(walletAddress) {
  const address = walletAddress || process.env.XMR_WALLET_ADDRESS || DEFAULT_WALLET;
  const [poolRes, priceRes] = await Promise.allSettled([
    axios.get(POOL_API, { params: { address }, timeout: 15000 }),
    axios.get(PRICE_API, { params: { ids: 'monero', vs_currencies: 'usd' }, timeout: 15000 }),
  ]);

  let stats = {};
  let payments = [];
  let unlockedXmr = 0;
  let unconfirmedXmr = 0;
  if (poolRes.status === 'fulfilled') {
    const d = poolRes.value.data || {};
    stats = d.stats || {};
    payments = d.payments || [];
    unlockedXmr = sumXmr(d.unlocked);
    unconfirmedXmr = sumXmr(d.unconfirmed);
  } else {
    console.warn('pool balance fetch failed:', poolRes.reason?.message);
  }

  let priceUsd = null;
  if (priceRes.status === 'fulfilled') {
    priceUsd = priceRes.value.data?.monero?.usd ?? null;
  }

  const totalXmr = unlockedXmr + unconfirmedXmr;
  return {
    ok: poolRes.status === 'fulfilled',
    address,
    unpaid_xmr: round8(totalXmr),
    unlocked_xmr: round8(unlockedXmr),
    unconfirmed_xmr: round8(unconfirmedXmr),
    unpaid_usd: priceUsd != null ? round2(totalXmr * priceUsd) : null,
    xmr_usd_price: priceUsd,
    hashrate: stats.hashrate ?? null,
    hashrate_1h: stats.hashrate_1h ?? null,
    shares_good: stats.shares_good ?? null,
    payments_24h: stats.payments_24h ?? null,
    payments_7d: stats.payments_7d ?? null,
    payments_count: payments.length,
    last_payment: payments[0] ?? null,
    fetched_at: new Date().toISOString(),
  };
}

function round8(n) {
  return Math.round(n * 1e8) / 1e8;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { getPoolBalance, DEFAULT_WALLET, sumXmr };
