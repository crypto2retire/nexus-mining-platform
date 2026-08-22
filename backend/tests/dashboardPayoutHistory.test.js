jest.mock('../config/db', () => ({
  pool: { connect: jest.fn() },
}));

jest.mock('../services/backingMonitor', () => ({ getBacking: jest.fn() }));
jest.mock('../services/payoutTrigger', () => ({
  getObservedRates: jest.fn(),
  PAYOUT_MIN: {},
  WATCHES: {},
}));
jest.mock('../controllers/upgradeController', () => ({
  tiersFor: jest.fn(() => []),
  sessionPrice: jest.fn(),
  SESSION_HOURS: {},
}));
jest.mock('../services/multiCoinDiscount', () => ({
  coinsOwnedFor: jest.fn(),
  discountPctFor: jest.fn(),
}));

const { getPayoutHistory } = require('../controllers/dashboardController');

describe('dashboard payout history', () => {
  let client;

  beforeEach(() => {
    client = { query: jest.fn() };
  });

  it('returns an empty history when the ledgers have no rows', async () => {
    client.query.mockResolvedValue({ rows: [] });

    await expect(getPayoutHistory(client, 'user-1')).resolves.toEqual([]);
  });

  it('returns mining rewards joined to their pool with exact string amounts', async () => {
    client.query.mockResolvedValue({
      rows: [{
        kind: 'mining',
        date: new Date('2026-08-21T16:00:00.000Z'),
        pool: 'KASPA',
        amount: '1.20591854',
        symbol: 'KAS',
        status: 'CLAIMED',
      }],
    });

    await expect(getPayoutHistory(client, 'user-1')).resolves.toEqual([{
      kind: 'mining',
      date: '2026-08-21T16:00:00.000Z',
      pool: 'KASPA',
      amount: '1.20591854',
      symbol: 'KAS',
      status: 'CLAIMED',
    }]);
  });

  it('includes game rewards as USDC entries with their reason as status', async () => {
    client.query.mockResolvedValue({
      rows: [{
        kind: 'game',
        date: '2026-08-20T10:30:00.000Z',
        pool: null,
        amount: '0.0300',
        symbol: 'USDC',
        status: 'STREAK',
      }],
    });

    await expect(getPayoutHistory(client, 'user-1')).resolves.toEqual([{
      kind: 'game',
      date: '2026-08-20T10:30:00.000Z',
      pool: null,
      amount: '0.0300',
      symbol: 'USDC',
      status: 'STREAK',
    }]);
  });

  it('combines both ledgers, orders by payout date, and limits the result to 20', async () => {
    client.query.mockResolvedValue({ rows: [] });

    await getPayoutHistory(client, 'user-42');

    const [sql, params] = client.query.mock.calls[0];
    expect(sql).toContain('FROM user_rewards_ledger');
    expect(sql).toContain('JOIN real_pool_payouts');
    expect(sql).toContain('payout_timestamp');
    expect(sql).toContain('updated_at');
    expect(sql).toContain('FROM game_rewards_ledger');
    expect(sql).toMatch(/ORDER BY date DESC\s+LIMIT 20/);
    expect(params).toEqual(['user-42']);
  });
});
