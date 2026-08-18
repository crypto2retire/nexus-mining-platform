jest.mock('axios');

const axios = require('axios');
const { getLiveBtcPrice, clearPriceCache } = require('../services/priceOracle');

describe('priceOracle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearPriceCache();
    process.env.PRICE_CACHE_TTL_MS = '30000';
  });

  test('uses the true BTC/USDC pair feed first', async () => {
    axios.get.mockResolvedValueOnce({ data: { data: { amount: '100000.50' } } });
    const result = await getLiveBtcPrice();

    expect(result.price).toBe(100000.5);
    expect(result.isUsdcPair).toBe(true);
    expect(result.feed).toBe('Coinbase BTC-USDC');
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  test('caches the price for the TTL window', async () => {
    axios.get.mockResolvedValue({ data: { data: { amount: '100000.50' } } });

    await getLiveBtcPrice();
    await getLiveBtcPrice();
    await getLiveBtcPrice();

    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  test('refetches after the TTL window expires', async () => {
    process.env.PRICE_CACHE_TTL_MS = '1';
    axios.get.mockResolvedValue({ data: { data: { amount: '100000.50' } } });

    await getLiveBtcPrice();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await getLiveBtcPrice();

    expect(axios.get).toHaveBeenCalledTimes(2);
  });

  test('falls back through feeds when primary feeds fail', async () => {
    axios.get
      .mockRejectedValueOnce(new Error('coinbase exchange down'))
      .mockRejectedValueOnce(new Error('kraken down'))
      .mockResolvedValueOnce({ data: { data: { rates: { USD: '99000.25' } } } });

    const result = await getLiveBtcPrice();

    expect(result.price).toBe(99000.25);
    expect(result.isUsdcPair).toBe(false); // USD proxy, honestly labelled
    expect(result.feed).toBe('Coinbase BTC/USD (proxy)');
  });

  test('throws when every feed fails', async () => {
    axios.get.mockRejectedValue(new Error('network down'));

    await expect(getLiveBtcPrice()).rejects.toThrow('Unable to fetch BTC/USDC price');
  });

  test('rejects invalid (zero/NaN) price payloads and moves to the next feed', async () => {
    axios.get.mockResolvedValueOnce({ data: { price: '0' } });

    await expect(getLiveBtcPrice()).rejects.toThrow('Unable to fetch BTC/USDC price');
    expect(axios.get.mock.calls.length).toBeGreaterThan(1); // tried next feed
  });
});
