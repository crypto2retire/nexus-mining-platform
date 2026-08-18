const axios = require('axios');

/**
 * BTC price oracle.
 *
 * Primary feeds are TRUE BTC/USDC pairs (stablecoin-quoted on real exchanges).
 * Fallback feeds are USD-denominated proxies (Coinbase exchange-rates, Binance
 * USDT, CoinCap, CoinGecko). USDC is redeemable 1:1 for USD, but the distinction
 * is recorded in the audit trail (`isUsdcPair`) so the source of every price is
 * traceable.
 *
 * Order of feeds matters: true USDC pairs first, then proxies.
 */
const FEEDS = [
  {
    name: 'Coinbase BTC-USDC',
    isUsdcPair: true,
    url: 'https://api.coinbase.com/v2/prices/BTC-USDC/spot',
    extract: (data) => parseFloat(data?.data?.amount),
  },
  {
    name: 'Kraken XBT/USDC',
    isUsdcPair: true,
    url: 'https://api.kraken.com/0/public/Ticker?pair=XBTUSDC',
    extract: (data) => {
      const pair = data?.result;
      const ticker = pair?.XBTUSDC || Object.values(pair || {})[0];
      return parseFloat(ticker?.c?.[0]);
    },
  },
  {
    name: 'Coinbase BTC/USD (proxy)',
    isUsdcPair: false,
    url: 'https://api.coinbase.com/v2/exchange-rates?currency=BTC',
    extract: (data) => parseFloat(data?.data?.rates?.USD),
  },
  {
    name: 'Binance BTCUSDT (proxy)',
    isUsdcPair: false,
    url: 'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT',
    extract: (data) => parseFloat(data?.price),
  },
  {
    name: 'CoinCap (proxy)',
    isUsdcPair: false,
    url: 'https://api.coincap.io/v2/assets/bitcoin',
    extract: (data) => parseFloat(data?.data?.priceUsd),
  },
  {
    name: 'CoinGecko (proxy)',
    isUsdcPair: false,
    url: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
    extract: (data) => parseFloat(data?.bitcoin?.usd),
  },
];

function getCacheTtlMs() {
  const v = Number(process.env.PRICE_CACHE_TTL_MS || 30000);
  return Number.isFinite(v) && v > 0 ? v : 30000;
}

const cache = {
  price: null,
  feed: null,
  isUsdcPair: false,
  timestamp: 0,
};

async function fetchFromFeed(feed) {
  const response = await axios.get(feed.url, {
    timeout: 8000,
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'NexusMiningEngine/1.0',
    },
  });
  const price = feed.extract(response.data);
  if (!price || isNaN(price) || price <= 0) {
    throw new Error(`Invalid price payload from ${feed.name}`);
  }
  console.log(`📊 Oracle [${feed.name}]: 1 BTC = $${price} (usdcPair=${feed.isUsdcPair})`);
  return price;
}

/**
 * Fetches the live spot price of BTC in USDC terms.
 * Tries true BTC/USDC feeds first, then USD proxies. Results are cached for
 * PRICE_CACHE_TTL_MS (default 30s) to avoid hammering public endpoints.
 *
 * @returns {Promise<{price: number, feed: string, isUsdcPair: boolean, timestamp: number}>}
 */
async function getLiveBtcPrice() {
  const now = Date.now();
  if (cache.price && now - cache.timestamp < getCacheTtlMs()) {
    return { ...cache };
  }

  let lastError = null;

  for (const feed of FEEDS) {
    try {
      const price = await fetchFromFeed(feed);
      cache.price = price;
      cache.feed = feed.name;
      cache.isUsdcPair = feed.isUsdcPair;
      cache.timestamp = now;
      return { price, feed: feed.name, isUsdcPair: feed.isUsdcPair, timestamp: now };
    } catch (error) {
      lastError = error;
      console.warn(`⚠️ Oracle ${feed.name} failed: ${error.message}`);
    }
  }

  console.error('❌ All BTC price feeds failed:', lastError?.message);
  throw new Error('Unable to fetch BTC/USDC price from any oracle source.');
}

/** Test hook: clear the in-memory cache. */
function clearPriceCache() {
  cache.price = null;
  cache.feed = null;
  cache.isUsdcPair = false;
  cache.timestamp = 0;
}

module.exports = { getLiveBtcPrice, clearPriceCache, FEEDS };
