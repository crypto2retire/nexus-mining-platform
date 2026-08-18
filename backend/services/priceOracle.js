const axios = require('axios');

const FEEDS = [
  {
    name: 'Coinbase',
    url: 'https://api.coinbase.com/v2/exchange-rates?currency=BTC',
    extract: (data) => parseFloat(data?.data?.rates?.USD),
  },
  {
    name: 'Kraken',
    url: 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD',
    extract: (data) => {
      const pair = data?.result;
      const ticker = pair?.XXBTZUSD || pair?.XBTUSD || Object.values(pair || {})[0];
      return parseFloat(ticker?.c?.[0]);
    },
  },
  {
    name: 'CoinCap',
    url: 'https://api.coincap.io/v2/assets/bitcoin',
    extract: (data) => parseFloat(data?.data?.priceUsd),
  },
  {
    name: 'Binance',
    url: 'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT',
    extract: (data) => parseFloat(data?.price),
  },
  {
    name: 'CoinGecko',
    url: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
    extract: (data) => parseFloat(data?.bitcoin?.usd),
  },
];

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
  console.log(`📊 Oracle [${feed.name}]: 1 BTC = $${price} USDC`);
  return price;
}

/**
 * Fetches the live spot price of BTC in USDC/USD.
 * Tries multiple public feeds with resilient fallbacks.
 * @returns {Promise<number>} BTC price in USDC.
 */
async function getLiveBtcPrice() {
  let lastError = null;

  for (const feed of FEEDS) {
    try {
      const price = await fetchFromFeed(feed);
      return price;
    } catch (error) {
      lastError = error;
      console.warn(`⚠️ Oracle ${feed.name} failed: ${error.message}`);
    }
  }

  console.error('❌ All BTC/USDC price feeds failed:', lastError?.message);
  throw new Error('Unable to fetch BTC/USDC price from any oracle source.');
}

module.exports = { getLiveBtcPrice };
