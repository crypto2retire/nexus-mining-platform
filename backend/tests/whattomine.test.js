/**
 * WhatToMine operator tool tests (2026-08-22) — anchor verification,
 * profitable-coin scan with the liquidity filter, coin screen.
 */
jest.mock('axios');
jest.mock('../config/db', () => ({
  pool: { query: jest.fn() },
}));
jest.mock('../services/backingMonitor', () => ({
  getBacking: jest.fn(),
}));
jest.mock('../services/operatorMarketService', () => ({
  configFor: jest.fn(),
}));

const axios = require('axios');
const { pool } = require('../config/db');
const { getBacking } = require('../services/backingMonitor');
const { configFor } = require('../services/operatorMarketService');
const { verifyAnchors, scanProfitable, screenCoins, configured, ALGO_PARAM, __resetCache } = require('../services/whattomineService');

const HOUR = 3600 * 1000;

describe('whattomineService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetCache();
    process.env.WTM_API_TOKEN='***';
  });
  afterAll(() => {
    delete process.env.WTM_API_TOKEN;
  });

  it('maps our pools to WhatToMine algorithm params', () => {
    expect(ALGO_PARAM).toEqual({
      KASPA: 'hh',
      ZCASH: 'eq',
      LTC_DOGE: 'scrypt',
      BTC: 'sha256',
      XMR: 'rmx',
    });
  });

  it('reports not-configured before any call', () => {
    delete process.env.WTM_API_TOKEN;
    expect(configured()).toBe(false);
  });

  describe('verifyAnchors', () => {
    beforeEach(() => {
      pool.query.mockResolvedValue({
        rows: [
          { target_pool: 'ZCASH', hash_total: '475' },
          { target_pool: 'KASPA', hash_total: '75' },
        ],
      });
      getBacking.mockResolvedValue({
        ZCASH: { pool_unpaid: 0.00621, pool_unpaid_unit: 'ZEC' },
        KASPA: { pool_unpaid: 0.577, pool_unpaid_unit: 'KAS' },
      });
      configFor.mockImplementation((algo) => {
        if (algo === 'equihash') return { anchorGhs: 30.55e-6, coins: { ZEC: { production: 0.0007 } } };
        if (algo === 'kheavyhash') return { anchorGhs: 200, coins: { KAS: { production: 0.60 } } };
        return null;
      });
      axios.mockImplementation(async (opts) => {
        if (opts.url.includes('/calculate')) {
          return {
            headers: { 'x-ratelimit-remaining': '998' },
            data: [
              { tag: 'ZEC', name: 'Zcash', estimated_rewards24: '0.0111', revenue: '8.8', profit: '-2' },
              { tag: 'KAS', name: 'Kaspa', estimated_rewards24: '0.225', revenue: '0.2', profit: '-1' },
            ],
          };
        }
        return { data: {} };
      });
    });

    it('builds WTM settings from active rented hashrate (KH/s → Sol/s for ZEC, GH/s → H/s for KAS)', async () => {
      await verifyAnchors('op-user');
      const call = axios.mock.calls.find((c) => c[0].url.includes('/calculate'));
      expect(call[0].data.settings).toEqual([
        { algorithm: 'eq', power: 1500, hashrate: 475e3 },
        { algorithm: 'hh', power: 50, hashrate: 75e9 },
      ]);
    });

    it('compares WTM estimate vs our anchor and exposes the ratio', async () => {
      const result = await verifyAnchors('op-user');
      const zec = result.rows.find((r) => r.target_pool === 'ZCASH');
      // Anchor: 475 KH/s → 475e-6/30.55e-6 × 0.0007 = 0.01088 ZEC/day
      expect(zec.anchor_est_24h).toBeCloseTo(0.01088, 5);
      expect(zec.wtm_est_24h).toBeCloseTo(0.0111, 5);
      expect(zec.ratio_wtm_vs_anchor).toBeCloseTo(0.0111 / 0.01088, 3);
      // Pool's real accrued balance is surfaced, not split.
      expect(zec.pool_unpaid).toBeCloseTo(0.00621, 5);
      expect(zec.pool_unpaid_unit).toBe('ZEC');
    });

    it('returns rate-limit remaining from the WTM response headers', async () => {
      const result = await verifyAnchors('op-user');
      expect(result.rate_limit.remaining).toBe(998);
    });
  });

  describe('scanProfitable', () => {
    it('applies the liquidity filter and ranks by profit', async () => {
      axios.mockImplementation(async (opts) => {
        if (opts.url.includes('/coins')) {
          return {
            headers: {},
            data: [
              { tag: 'XMR', name: 'Monero', market_cap: '3000000000', price: '150', price30: '140', exchanges: [{ name: 'Binance', volume: '12000' }] },
              { tag: 'RTM', name: 'Raptoreum', market_cap: '1000000', price: '0.01', price30: '0.01', exchanges: [{ name: 'CoinEx', volume: '0.04' }] },
            ],
          };
        }
        return {
          headers: {},
          data: [
            { tag: 'XMR', name: 'Monero', algorithm: 'RandomX', estimated_rewards24: '0.09', revenue: '13.5', profit: '4.2' },
            { tag: 'RTM', name: 'Raptoreum', algorithm: 'GhostRider', estimated_rewards24: '2000', revenue: '150', profit: '145' },
          ],
        };
      });
      const result = await scanProfitable();
      const xmr = result.rows.find((r) => r.coin === 'XMR');
      const rtm = result.rows.find((r) => r.coin === 'RTM');
      // RTM profits $145 but is ILLIQUID (0.04 BTC/day) — the mirage filter.
      expect(rtm.liquid).toBe(false);
      expect(rtm.sellable).toBe(false);
      expect(xmr.liquid).toBe(true);
      expect(xmr.sellable).toBe(true);
      // Ranked by profit, but the liquid flag is the decision driver.
      expect(result.rows[0].coin).toBe('RTM');
      expect(result.rows.find((r) => r.coin === 'XMR').top_volume_btc_day).toBe(12000);
    });
  });

  describe('screenCoins', () => {
    it('computes 30d momentum and sorts by volume', async () => {
      axios.mockResolvedValue({
        headers: {},
        data: [
          { tag: 'ZEC', name: 'Zcash', price: '795', price30: '490', market_cap: '1200000000', exchanges: [{ name: 'Binance', volume: '5000' }], difficulty30: '45' },
          { tag: 'KAS', name: 'Kaspa', price: '0.0306', price30: '0.025', market_cap: '800000000', exchanges: [{ name: 'MEXC', volume: '9000' }], difficulty30: '12' },
        ],
      });
      const result = await screenCoins();
      const zec = result.rows.find((r) => r.coin === 'ZEC');
      // 795/490 − 1 = +62.2% 30d momentum
      expect(zec.change_30d_pct).toBeCloseTo(62.24, 1);
      expect(zec.difficulty_30d_pct).toBe(45);
      expect(result.rows[0].coin).toBe('KAS'); // higher volume first
    });
  });
});
