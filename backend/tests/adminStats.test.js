/**
 * Admin stats controller tests.
 *
 * getAdminStats must aggregate platform-wide capacity, payouts, treasury fees
 * and the user rewards ledger into a shape the operator dashboard renders.
 */
const { getAdminStats } = require('../controllers/adminStatsController');
const { pool } = require('../config/db');

jest.mock('../config/db', () => ({
  pool: { query: jest.fn() },
}));

// The controller now pulls LIVE production from getBacking() (same source as
// the Real Backing panel) instead of a 6h-old room_accrual snapshot.
jest.mock('../services/backingMonitor', () => ({
  getBacking: jest.fn(),
}));
const { getBacking } = require('../services/backingMonitor');

function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = jest.fn((code) => {
    res.statusCode = code;
    return res;
  });
  res.json = jest.fn((obj) => {
    res.body = obj;
    return res;
  });
  return res;
}

describe('adminStatsController.getAdminStats', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('aggregates capacity, payouts, fees, ledger, users and deposits', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [
          { target_pool: 'KASPA', total_hashrate: '125', rig_count: '3' },
          { target_pool: 'ZCASH', total_hashrate: '60', rig_count: '2' },
        ],
      }) // capacity
      .mockResolvedValueOnce({
        rows: [
          { target_pool: 'KASPA', distributed_crypto: '40.00000000' },
        ],
      }) // distributed (for treasury 5%)
      .mockResolvedValueOnce({
        rows: [{ total_revenue_usdc: '12.50', revenue_entry_count: '3' }],
      }) // protocol revenue
      .mockResolvedValueOnce({
        rows: [
          { coin_symbol: 'KAS', total_coin: '42.50000000' },
          { coin_symbol: 'ZEC', total_coin: '1.25000000' },
        ],
      }) // typed coin revenue
      .mockResolvedValueOnce({
        rows: [
          {
            target_pool: 'KASPA',
            total_earned_crypto: '95.00000000',
            unclaimed_crypto: '60.00000000',
            claimed_crypto: '20.00000000',
            paid_crypto: '15.00000000',
          },
        ],
      }) // ledger
      .mockResolvedValueOnce({ rows: [{ user_count: '4' }] }) // users
      .mockResolvedValueOnce({
        rows: [{ total_deposits_usdc: '250.0000', deposit_count: '5' }],
      }); // deposits
    // LIVE production from the Real Backing source.
    getBacking.mockResolvedValue({
      KASPA: { mined_total: 100, fetched_at: '2026-08-20T06:00:00Z' },
      ZCASH: { mined_total: 0 },
      LTC_DOGE: { mined_total: 0 },
      BTC: { mined_total: 0 },
      generated_at: '2026-08-20T06:00:00Z',
      cache_ttl_ms: 60000,
    });

    const res = makeRes();
    await getAdminStats({}, res);

    // Guard: confirm the mock chain consumed exactly as expected.
    expect(pool.query).toHaveBeenCalledTimes(7);
    expect(getBacking).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.body.capacity_by_pool.KASPA.total_hashrate).toBe(125);
    expect(res.body.capacity_by_pool.ZCASH.rig_count).toBe(2);
    expect(res.body.payouts_by_pool.KASPA.total_crypto).toBe(100);
    expect(res.body.payouts_by_pool.KASPA.treasury_share_crypto).toBe(2); // 5% of distributed (40)
    expect(res.body.treasury.protocol_revenue_usdc).toBe(12.5);
    expect(res.body.treasury.coin_amounts_by_symbol).toEqual({ KAS: 42.5, ZEC: 1.25 });
    expect(res.body.ledger_by_pool.KASPA.unclaimed_crypto).toBe(60);
    expect(res.body.users.count).toBe(4);
    expect(res.body.deposits.total_usdc).toBe(250);
  });

  it('returns zeros gracefully when tables are empty', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    getBacking.mockResolvedValue({
      KASPA: { mined_total: 0 },
      ZCASH: { mined_total: 0 },
      LTC_DOGE: { mined_total: 0 },
      BTC: { mined_total: 0 },
      generated_at: '2026-08-20T06:00:00Z',
    });

    const res = makeRes();
    await getAdminStats({}, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.capacity_by_pool).toEqual({});
    // LIVE production comes from Real Backing — every pool is present even at 0.
    expect(Object.keys(res.body.payouts_by_pool).sort()).toEqual(['BTC', 'KASPA', 'LTC_DOGE', 'ZCASH']);
    expect(res.body.payouts_by_pool.KASPA.total_crypto).toBe(0);
    expect(res.body.ledger_by_pool).toEqual({});
    expect(res.body.treasury.protocol_revenue_usdc).toBe(0);
    expect(res.body.treasury.coin_amounts_by_symbol).toEqual({});
    expect(res.body.users.count).toBe(0);
    expect(res.body.deposits.total_usdc).toBe(0);
  });

  it('returns 500 on a DB failure', async () => {
    pool.query.mockRejectedValue(new Error('db down'));

    const res = makeRes();
    await getAdminStats({}, res);

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/Internal/);
  });
});
