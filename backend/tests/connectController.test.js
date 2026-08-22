const fs = require('fs');
const path = require('path');

jest.mock('../services/connectService', () => ({
  ConnectError: class ConnectError extends Error {
    constructor(statusCode, message) {
      super(message);
      this.statusCode = statusCode;
    }
  },
  createConnectOrder: jest.fn(),
  listConnectOrders: jest.fn(),
  marketFor: jest.fn(),
  quote: jest.fn(),
}));

const connectService = require('../services/connectService');
const {
  createConnectOrder,
  getConnectMarket,
  getConnectQuote,
  listConnectOrders,
} = require('../controllers/connectController');

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

test.each([
  ['market', getConnectMarket, { auth: { wallet: '0x1' }, query: { algo: 'kheavyhash' } }],
  ['quote', getConnectQuote, { auth: { wallet: '0x1' }, body: {} }],
  ['order', createConnectOrder, { auth: { wallet: '0x1' }, body: {} }],
  ['orders', listConnectOrders, { auth: { wallet: '0x1' } }],
])('%s returns 503 without touching services when Connect is disabled', async (_name, handler, req) => {
  process.env.ENABLE_CONNECT = '0';
  const res = response();
  await handler(req, res);
  expect(res.statusCode).toBe(503);
  expect(res.body).toEqual({ error: 'Connect is not enabled' });
  expect(connectService.marketFor).not.toHaveBeenCalled();
  expect(connectService.quote).not.toHaveBeenCalled();
  expect(connectService.createConnectOrder).not.toHaveBeenCalled();
  expect(connectService.listConnectOrders).not.toHaveBeenCalled();
});

test('order uses req.auth.wallet and returns the created order', async () => {
  process.env.ENABLE_CONNECT = '1';
  connectService.createConnectOrder.mockResolvedValue({ id: 'connect-1' });
  const req = {
    auth: { wallet: '0x1111111111111111111111111111111111111111' },
    body: {
      wallet: '0xattacker', target_pool: 'KASPA', payout_address: 'kaspa:test',
      rig_id: 'rig-1', length_hours: 24, request_id: 'request-1',
    },
  };
  const res = response();

  await createConnectOrder(req, res);

  expect(res.statusCode).toBe(201);
  expect(res.body).toEqual({ order: { id: 'connect-1' } });
  expect(connectService.createConnectOrder).toHaveBeenCalledWith({
    wallet: req.auth.wallet,
    targetPool: 'KASPA',
    payoutAddress: 'kaspa:test',
    rigId: 'rig-1',
    lengthHours: 24,
    requestId: 'request-1',
  });
});

test('expected Connect errors are friendly and preserve their status', async () => {
  process.env.ENABLE_CONNECT = '1';
  connectService.quote.mockRejectedValue(
    new connectService.ConnectError(409, 'The selected rig is no longer available')
  );
  const res = response();
  await getConnectQuote({ body: { target_pool: 'KASPA' }, auth: { wallet: '0x1' } }, res);
  expect(res.statusCode).toBe(409);
  expect(res.body).toEqual({ error: 'The selected rig is no longer available' });
});

test('all four Connect routes are registered behind requireAuth', () => {
  const source = fs.readFileSync(path.join(__dirname, '../routes/api.js'), 'utf8');
  expect(source).toMatch(/router\.get\('\/connect\/market',\s*requireAuth,\s*getConnectMarket\)/);
  expect(source).toMatch(/router\.post\('\/connect\/quote',\s*requireAuth,\s*getConnectQuote\)/);
  expect(source).toMatch(/router\.post\('\/connect\/order',\s*requireAuth,\s*createConnectOrder\)/);
  expect(source).toMatch(/router\.get\('\/connect\/orders',\s*requireAuth,\s*listConnectOrders\)/);
});
