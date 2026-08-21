jest.mock('../config/db', () => ({ pool: { query: jest.fn(), connect: jest.fn() } }));
jest.mock('../services/mrrRenter', () => ({
  makeMrrRequest: jest.fn(),
  advertisedInBase: jest.fn((rig) => Number(rig?.hashrate?.advertised?.hash || 0)),
  advertisedGhs: jest.fn((rig) => Number(rig?.hashrate?.advertised?.hash || 0)),
  meetsAdvertisedMinimum: jest.fn(() => true),
  rigIsAvailable: jest.fn(() => true),
}));
jest.mock('../services/priceOracle', () => ({ getLiveBtcPrice: jest.fn() }));
jest.mock('../services/operatorMarketService', () => ({
  ...jest.requireActual('../services/operatorMarketService'),
  getCoinMarketData: jest.fn(),
}));

const { pool } = require('../config/db');
const mrr = require('../services/mrrRenter');
const { getLiveBtcPrice } = require('../services/priceOracle');
const marketService = require('../services/operatorMarketService');
const { getMarket, createOrder } = require('../controllers/operatorController');

const REAL_ENV = { ...process.env };

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

afterEach(() => {
  process.env = { ...REAL_ENV };
  jest.clearAllMocks();
});

test('operator gate returns 403 when OPERATOR_WALLET is absent', async () => {
  delete process.env.OPERATOR_WALLET;
  const res = response();
  await getMarket({ auth: { wallet: '0xabc' }, query: { algo: 'kheavyhash' } }, res);
  expect(res.statusCode).toBe(403);
  expect(res.body.error).toMatch(/not configured/i);
  expect(mrr.makeMrrRequest).not.toHaveBeenCalled();
});

test('operator gate returns 403 for a different authenticated wallet', async () => {
  process.env.OPERATOR_WALLET = '0x1111111111111111111111111111111111111111';
  const res = response();
  await getMarket({ auth: { wallet: '0x2222222222222222222222222222222222222222' }, query: { algo: 'kheavyhash' } }, res);
  expect(res.statusCode).toBe(403);
  expect(mrr.makeMrrRequest).not.toHaveBeenCalled();
});

test('operator order inserts a PENDING exact-rig outbox row without touching USDC', async () => {
  const wallet = '0x1111111111111111111111111111111111111111';
  process.env.OPERATOR_WALLET = wallet;
  process.env.MRR_POOL_PROFILE_KHEAVYHASH = '957805';
  process.env.MRR_MAX_RENTAL_HOURS = '72';
  mrr.makeMrrRequest.mockResolvedValue({
    data: { records: [{
      id: 'rig-42',
      name: 'KAS Rig 42',
      rpi: '99.1',
      online: true,
      status: { status: 'available', rented: false, online: true },
      minhours: '3',
      maxhours: '96',
      price: { BTC: { hour: '0.000001', min_rental_length: 3, enabled: true } },
      hashrate: { advertised: { hash: 200, type: 'gh', nice: '200G' } },
    }] },
  });
  getLiveBtcPrice.mockResolvedValue({ price: 100000, feed: 'test-feed', isUsdcPair: false });

  const client = {
    query: jest.fn(async (sql) => {
      if (sql.includes('FROM users')) return { rowCount: 1, rows: [{ user_id: 'user-1' }] };
      if (sql.includes('FROM hashrate_orders')) return { rowCount: 0, rows: [] };
      if (sql.includes('FROM virtual_rigs')) return { rowCount: 0, rows: [] };
      if (sql.includes('FROM capacity_slices')) return { rowCount: 0, rows: [] };
      if (sql.includes('INSERT INTO hashrate_orders')) return { rowCount: 1, rows: [{ order_id: 'order-42' }] };
      return { rowCount: 0, rows: [] };
    }),
    release: jest.fn(),
  };
  pool.connect.mockResolvedValue(client);

  const res = response();
  await createOrder({
    auth: { wallet },
    body: { rig_id: 'rig-42', algo: 'kheavyhash', length_hours: 24 },
  }, res);

  expect(res.statusCode).toBe(202);
  expect(res.body).toEqual({ status: 'PENDING', order_id: 'order-42' });
  const insert = client.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO hashrate_orders'));
  expect(insert[0]).toContain('requested_rig_id');
  expect(insert[0]).toContain('pool_profile_id');
  expect(insert[0]).toContain('requested_length_hours');
  expect(insert[1]).toEqual(expect.arrayContaining(['rig-42', '957805', 24, 0, 0]));
  expect(client.query.mock.calls.some(([sql]) => /UPDATE\s+user_wallets/i.test(sql))).toBe(false);
  expect(client.query.mock.calls.some(([sql]) => /protocol_revenue_ledger/i.test(sql))).toBe(false);
});
