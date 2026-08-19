const axios = require('axios');
const { COINS, walletFor } = require('./coinRegistry');

/**
 * Market monitor — live per-coin data for CPU mining opportunities.
 *
 * For each VERIFIED coin: fetches the pool's live stats (network difficulty,
 * target block time, last block reward) + CoinGecko price, then computes the
 * estimated daily earnings for the M4's measured hashrate:
 *
 *   est/day = (m4Hashrate / networkHashrate) * (86400 / target) * reward * price
 *   networkHashrate ≈ difficulty / target
 *
 * Unverified coins are returned with `verified:false` and no live numbers.
 */

const COINGECKO_IDS = {
  XMR: 'monero',
  ZEPH: 'zephyr',
  QRL: 'quantum-resistant-ledger',
  WOW: 'wownero',
  ETI: 'etica',
  XDAG: 'dagger',
  RTM: 'raptoreum',
  DERO: 'dero',
};

function round(n, d = 6) {
  if (n == null || !isFinite(n)) return null;
  const p = 10 ** d;
  return Math.round(n * p) / p;
}

async function fetchPoolStats(coin) {
  const { statsApi } = coin;
  if (!statsApi) return null;
  try {
    const res = await axios.get(statsApi, { timeout: 12000 });
    const d = res.data || {};
    const net = d.network || {};
    const lb = d.lastblock || {};
    const cfg = d.config || {};
    const ports = (cfg.ports || []).map((p) => p.port);
    return {
      difficulty: Number(net.difficulty) || null,
      targetSec: Number(net.difficultyTarget) || null,
      reward: lb.reward != null ? Number(lb.reward) / (coin.atomicUnits || 1e12) : null, // atomic units -> coin
      height: lb.height ?? null,
      ports,
      host: cfg.poolHost || null,
    };
  } catch (err) {
    console.warn(`pool stats fetch failed for ${coin.symbol}:`, err.message);
    return null;
  }
}

async function fetchPrices() {
  const ids = Object.values(COINGECKO_IDS).filter(Boolean).join(',');
  if (!ids) return {};
  try {
    const res = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
      params: { ids, vs_currencies: 'usd', include_24hr_change: 'true' },
      timeout: 12000,
    });
    const out = {};
    for (const [symbol, cgId] of Object.entries(COINGECKO_IDS)) {
      const p = res.data?.[cgId];
      out[symbol] = p ? { usd: p.usd ?? null, change24h: p.usd_24h_change ?? null } : { usd: null, change24h: null };
    }
    return out;
  } catch (err) {
    console.warn('price fetch failed:', err.message);
    return {};
  }
}

/**
 * Ranked mining opportunities for the M4.
 * Returns { fetched_at, coins: [...] } sorted by est_usd_day desc (verified first).
 */
async function getOpportunities() {
  const [prices, poolStats] = await Promise.all([
    fetchPrices(),
    Promise.all(Object.values(COINS).map((c) => fetchPoolStats(c))),
  ]);

  const coins = Object.values(COINS).map((coin, i) => {
    const stats = poolStats[i];
    const price = prices[coin.symbol];
    const wallet = walletFor(coin.symbol);

    let estCoinsDay = null;
    let estUsdDay = null;
    let networkHashrate = null;

    if (coin.verified && coin.m4Hashrate && stats && stats.difficulty && stats.targetSec) {
      networkHashrate = stats.difficulty / stats.targetSec; // H/s
      const share = coin.m4Hashrate / networkHashrate;
      estCoinsDay = share * (86400 / stats.targetSec) * (stats.reward ?? 0);
      if (price?.usd != null) estUsdDay = estCoinsDay * price.usd;
    }

    return {
      symbol: coin.symbol,
      name: coin.name,
      algo: coin.algo,
      verified: coin.verified,
      active_pool: coin.pool,
      pool_host: stats?.host || coin.poolHost,
      ports: stats?.ports || [],
      m4_hashrate: coin.m4Hashrate,
      network_hashrate: networkHashrate != null ? round(networkHashrate, 2) : null,
      block_reward: stats?.reward != null ? round(stats.reward, 8) : null,
      price_usd: price?.usd != null ? round(price.usd, 6) : null,
      change_24h: price?.change24h != null ? round(price.change24h, 2) : null,
      est_coins_day: estCoinsDay != null ? round(estCoinsDay, 8) : null,
      est_usd_day: estUsdDay != null ? round(estUsdDay, 4) : null,
      wallet_configured: Boolean(wallet),
      switchable: isSwitchableFlag(coin, wallet),
      liquidity: coin.liquidity,
      note: coin.note,
    };
  });

  const sorted = [...coins].sort((a, b) => {
    if (a.verified !== b.verified) return a.verified ? -1 : 1;
    return (b.est_usd_day ?? -1) - (a.est_usd_day ?? -1);
  });

  return { fetched_at: new Date().toISOString(), coins: sorted };
}

function isSwitchableFlag(coin, wallet) {
  return Boolean(coin.verified && coin.pool && wallet);
}

module.exports = { getOpportunities };
