const axios = require('axios');

const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd';
const BINANCE_URL = 'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT';

/**
 * Fetches the live spot price of BTC in USDC/USD.
 * Uses CoinGecko first, then Binance as fallback.
 * @returns {Promise<number>} BTC price in USDC.
 */
async function getLiveBtcPrice() {
  try {
    const response = await axios.get(COINGECKO_URL, { timeout: 10000 });
    const price = response.data?.bitcoin?.usd;

    if (!price || isNaN(price)) {
      throw new Error('Invalid price feed payload received from CoinGecko.');
    }

    console.log(`📊 Oracle Price: 1 BTC = $${price} USDC`);
    return parseFloat(price);
  } catch (error) {
    console.warn('⚠️ CoinGecko oracle failed, falling back to Binance:', error.message);

    try {
      const backupResponse = await axios.get(BINANCE_URL, { timeout: 10000 });
      const backupPrice = backupResponse.data?.price;

      if (!backupPrice || isNaN(backupPrice)) {
        throw new Error('Invalid price feed payload received from Binance.');
      }

      console.log(`📊 Oracle Price (Binance fallback): 1 BTC = $${backupPrice} USDC`);
      return parseFloat(backupPrice);
    } catch (backupError) {
      console.error('❌ Both price feeds failed:', backupError.message);
      throw new Error('Unable to fetch BTC/USDC price from any oracle source.');
    }
  }
}

module.exports = { getLiveBtcPrice };
