jest.mock('../config/db', () => ({ pool: { query: jest.fn(), connect: jest.fn() } }));
jest.mock('../services/hashrateRenter', () => ({ placeHashpowerOrder: jest.fn(), getOrderStatus: jest.fn() }));
jest.mock('../services/mrrRenter', () => ({ placeHashpowerOrder: jest.fn(), getOrderStatus: jest.fn() }));
jest.mock('../services/backingMonitor', () => ({ getBacking: jest.fn() }));

const { pool } = require('../config/db');
const { contributionsForPool } = require('../services/rigHistory');
const { markPlaced } = require('../services/orderOutboxWorker');

beforeEach(() => jest.clearAllMocks());

test('reward contribution reads independently expiring slices over the payout interval', async () => {
  const client = {
    query: jest.fn().mockResolvedValue({
      rows: [
        { user_id: 'user-1', contribution: '1800' },
        { user_id: 'user-2', contribution: '25' },
      ],
    }),
  };
  const start = new Date('2026-08-20T00:00:00Z');
  const end = new Date('2026-08-20T03:00:00Z');
  const result = await contributionsForPool(client, 'KASPA', start, end);
  expect(result).toEqual([
    { user_id: 'user-1', contribution: 1800 },
    { user_id: 'user-2', contribution: 25 },
  ]);
  const sql = client.query.mock.calls[0][0];
  expect(sql).toContain('FROM capacity_slices');
  expect(sql).toContain('LEAST(expires_at');
  expect(sql).toContain('GREATEST(starts_at');
});

test('renewal extends only the RENTAL slice and leaves SESSION slices untouched', async () => {
  jest.useFakeTimers().setSystemTime(new Date('2026-08-20T00:00:00Z'));
  const client = {
    query: jest.fn(async (sql) => {
      if (sql.includes('SELECT rig_id, virtual_hashrate FROM virtual_rigs')) {
        return { rowCount: 1, rows: [{ rig_id: 'rig-1', virtual_hashrate: '25' }] };
      }
      return { rowCount: 1, rows: [] };
    }),
    release: jest.fn(),
  };
  pool.connect.mockResolvedValue(client);
  const prior = new Date('2026-08-23T00:00:00Z');
  await markPlaced(
    {
      order_id: 'order-1', user_id: 'user-1', target_pool: 'KASPA',
      renewal: true, prior_rental_expires_at: prior,
    },
    { success: true, mode: 'live', orderId: 'nh-1', rigHours: 72 }
  );
  const upsert = client.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO capacity_slices'));
  expect(upsert[0]).toContain("'RENTAL'");
  expect(upsert[0]).toContain("WHERE source = 'RENTAL'");
  expect(new Date(upsert[1][3]).toISOString()).toBe('2026-08-26T00:00:00.000Z');
  expect(client.query.mock.calls.some(([sql]) => sql.includes("source = 'SESSION'"))).toBe(false);
  jest.useRealTimers();
});

test('live-capacity SQL ignores future and expired slices', async () => {
  const { getAdminStats } = require('../controllers/adminStatsController');
  const { getBacking } = require('../services/backingMonitor');
  const backing = { ZCASH: {}, KASPA: {}, LTC_DOGE: {}, XMR: {} };
  getBacking.mockResolvedValue(backing);
  pool.query.mockResolvedValue({ rows: [] });
  const res = { json: jest.fn(), status: jest.fn(() => res) };
  await getAdminStats({}, res);
  const capacitySql = pool.query.mock.calls[0][0];
  expect(capacitySql).toContain('FROM capacity_slices');
  expect(capacitySql).toContain('starts_at <= CURRENT_TIMESTAMP');
  expect(capacitySql).toContain('expires_at > CURRENT_TIMESTAMP');
});
