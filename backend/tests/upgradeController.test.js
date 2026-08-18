jest.mock('../config/db', () => ({
  pool: { connect: jest.fn(), query: jest.fn() },
}));
jest.mock('../services/priceOracle', () => ({
  getLiveBtcPrice: jest.fn(),
}));
jest.mock('../services/hashrateRenter', () => ({
  placeHashpowerOrder: jest.fn(),
  getOrderStatus: jest.fn(),
  POOL_ALGORITHM_MAP: { ZCASH: 'ZHASH', KASPA: 'KHEAVYHASH', LTC_DOGE: 'SCRYPT' },
  PROVIDER_NAME: 'NICEHASH',
  LIVE_ORDERS_ENV: 'NICEHASH_LIVE_ORDERS',
}));
jest.mock('../services/mrrRenter', () => ({
  placeHashpowerOrder: jest.fn(),
  getOrderStatus: jest.fn(),
  POOL_ALGORITHM_MAP: { ZCASH: 'ZHASH', KASPA: 'KHEAVYHASH', LTC_DOGE: 'SCRYPT' },
  PROVIDER_NAME: 'MRR',
  LIVE_ORDERS_ENV: 'MRR_LIVE_ORDERS',
}));

const { pool } = require('../config/db');
const { getLiveBtcPrice } = require('../services/priceOracle');
const { placeHashpowerOrder } = require('../services/hashrateRenter');
const { upgradeRig } = require('../controllers/upgradeController');

const REAL_ENV = { ...process.env };
const WALLET = '0x1111111111111111111111111111111111111111';

function makeClient({ balance = 1000, hasRig = false } = {}) {
  const queries = [];
  const client = {
    query: jest.fn(async (sql, params = []) => {
      queries.push({ sql, params });
      if (sql.includes('SELECT user_id FROM users')) {
        return { rowCount: 1, rows: [{ user_id: 'user-1' }] };
      }
      if (sql.includes('SELECT wallet_id, usdc_balance')) {
        return { rowCount: 1, rows: [{ wallet_id: 'wallet-1', usdc_balance: balance }] };
      }
      if (sql.includes('SELECT rig_id')) {
        return hasRig
          ? { rowCount: 1, rows: [{ rig_id: 'rig-1', level: 1, virtual_hashrate: 10 }] }
          : { rowCount: 0, rows: [] };
      }
      if (sql.includes('INSERT INTO hashrate_orders')) {
        return { rowCount: 1, rows: [{ order_id: 'order-1' }] };
      }
      if (sql.includes('INSERT INTO virtual_rigs')) {
        return { rowCount: 1, rows: [{ rig_id: 'rig-new' }] };
      }
      return { rowCount: 1, rows: [] };
    }),
    release: jest.fn(),
  };
  return { client, queries };
}

function makeRes() {
  const res = { statusCode: null, body: null };
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

function req(overrides = {}) {
  return {
    body: {
      wallet: WALLET,
      target_pool: 'ZCASH',
      request_id: 'req-1',
      ...overrides,
    },
  };
}

beforeEach(() => {
  process.env.NODE_ENV = 'development';
  delete process.env.NICEHASH_LIVE_ORDERS;
  jest.clearAllMocks();

  getLiveBtcPrice.mockResolvedValue({
    price: 100000,
    feed: 'Kraken XBT/USDC',
    isUsdcPair: true,
    timestamp: 1,
  });
  placeHashpowerOrder.mockResolvedValue({
    success: true,
    mode: 'sandbox',
    orderId: 'sandbox-abc',
    sandbox: true,
  });
  pool.query.mockResolvedValue({ rowCount: 0, rows: [] });
});

afterEach(() => {
  process.env = { ...REAL_ENV };
});

describe('upgradeRig — currency conversion + order loop', () => {
  test('happy path: converts USDC -> BTC at live price, books ONLY the 5% fee as revenue', async () => {
    const { client, queries } = makeClient();
    pool.connect.mockResolvedValue(client);

    const res = makeRes();
    await upgradeRig(req(), res);

    expect(res.statusCode).toBeNull(); // 200 via res.json directly
    expect(res.body.success).toBe(true);
    // Level 1 -> 2 costs 50 USDC. Fee 5% = 2.5. Net 47.5 USDC / 100000 = 0.000475 BTC.
    expect(res.body.protocol_fee_usdc).toBe(2.5);
    expect(res.body.btc_spent).toBe(0.000475);
    expect(res.body.btc_spot_price).toBe(100000);
    expect(res.body.order_status).toBe('SIMULATED');
    expect(res.body.sandbox).toBe(true);

    // Revenue ledger books the FEE, not the full upgrade cost.
    const revenueInsert = queries.find((q) => q.sql.includes('INSERT INTO protocol_revenue_ledger'));
    expect(revenueInsert).toBeTruthy();
    expect(revenueInsert.params[1]).toBe(2.5);
    expect(revenueInsert.params[2]).toBe('RIG_UPGRADE');

    // Balance deducted 50 -> 950.
    const balanceUpdate = queries.find((q) => q.sql.includes('UPDATE user_wallets'));
    expect(balanceUpdate.params[0]).toBe(950);

    // Idempotency key stored on the order row; row reserved as PENDING.
    const orderInsert = queries.find((q) => q.sql.includes('INSERT INTO hashrate_orders'));
    expect(orderInsert.params[2]).toBe('req-1');
    expect(orderInsert.sql).toContain("'PENDING'");

    // Order placed once, AFTER commit.
    expect(placeHashpowerOrder).toHaveBeenCalledTimes(1);
    expect(placeHashpowerOrder).toHaveBeenCalledWith('ZCASH', 0.000475);

    // Audit row updated with the order id + status.
    const finalUpdate = pool.query.mock.calls.find(([sql]) => sql.includes('UPDATE hashrate_orders'));
    expect(finalUpdate[1][0]).toBe('sandbox-abc');
    expect(finalUpdate[1][1]).toBe('SIMULATED');
  });

  test('insufficient balance: 400, no order placed, no deduction', async () => {
    const { client } = makeClient({ balance: 30 });
    pool.connect.mockResolvedValue(client);

    const res = makeRes();
    await upgradeRig(req(), res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Insufficient USDC balance');
    expect(placeHashpowerOrder).not.toHaveBeenCalled();
    expect(client.query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false);
  });

  test('order placement failure: user refunded, order row marked REFUNDED', async () => {
    const { client, queries } = makeClient();
    pool.connect.mockResolvedValue(client);
    placeHashpowerOrder.mockResolvedValue({
      success: false,
      mode: 'live',
      error: 'Unable to allocate hashrate (5191)',
    });

    const res = makeRes();
    await upgradeRig(req(), res);

    expect(res.statusCode).toBe(502);
    expect(res.body.error).toMatch(/USDC refunded/);

    // Refund credited back (50 USDC) and status REFUNDED.
    const refundUpdate = queries.find((q) => q.sql.includes('usdc_balance = usdc_balance +'));
    expect(refundUpdate).toBeTruthy();
    expect(refundUpdate.params[0]).toBe(50);

    const statusUpdate = queries.find((q) => q.sql.includes("status = 'REFUNDED'"));
    expect(statusUpdate).toBeTruthy();
    expect(statusUpdate.params[0]).toMatch(/5191/);
  });

  test('duplicate request_id returns the stored order without double-charging', async () => {
    const stored = {
      order_id: 'order-existing',
      status: 'PLACED',
      nicehash_order_id: 'nh-1',
      sandbox: false,
      usdc_cost: 50,
      protocol_fee_usdc: 2.5,
      btc_spent: 0.000475,
      btc_spot_price: 100000,
      price_feed: 'Coinbase BTC-USDC',
      price_is_usdc_pair: true,
      failure_reason: null,
      request_id: 'req-dup',
      level: 2,
      virtual_hashrate: 25,
    };
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [stored] });

    const res = makeRes();
    await upgradeRig(req({ request_id: 'req-dup' }), res);

    expect(res.body.duplicated).toBe(true);
    expect(res.body.nicehash_order_id).toBe('nh-1');
    expect(pool.connect).not.toHaveBeenCalled();
    expect(placeHashpowerOrder).not.toHaveBeenCalled();
  });

  test('production without NICEHASH_LIVE_ORDERS refuses to move funds', async () => {
    process.env.NODE_ENV = 'production';

    const res = makeRes();
    await upgradeRig(req(), res);

    expect(res.statusCode).toBe(503);
    expect(res.body.error).toMatch(/NICEHASH_LIVE_ORDERS/);
    expect(pool.connect).not.toHaveBeenCalled();
    expect(placeHashpowerOrder).not.toHaveBeenCalled();
  });

  test('MARKETPLACE_PROVIDER=mrr routes orders through the MRR renter (marketplace=MRR)', async () => {
    process.env.MARKETPLACE_PROVIDER = 'mrr';
    const mrrPlace = require('../services/mrrRenter').placeHashpowerOrder;
    mrrPlace.mockResolvedValue({
      success: true,
      mode: 'sandbox',
      orderId: 'sandbox-mrr-1',
      sandbox: true,
    });

    const { client, queries } = makeClient();
    pool.connect.mockResolvedValue(client);

    const res = makeRes();
    await upgradeRig(req({ request_id: 'req-mrr-1' }), res);

    expect(res.statusCode).toBeNull(); // 200
    expect(res.body.success).toBe(true);
    expect(res.body.marketplace).toBe('MRR');
    expect(res.body.order_status).toBe('SIMULATED');

    // The NiceHash renter must NOT be involved.
    expect(placeHashpowerOrder).not.toHaveBeenCalled();
    expect(mrrPlace).toHaveBeenCalledTimes(1);
    expect(mrrPlace).toHaveBeenCalledWith('ZCASH', 0.000475);

    // Order row records the marketplace for the audit trail.
    const orderInsert = queries.find((q) => q.sql.includes('INSERT INTO hashrate_orders'));
    expect(orderInsert.params).toContain('MRR');
  });

  test('production with MARKETPLACE_PROVIDER=mrr refuses without MRR_LIVE_ORDERS', async () => {
    process.env.MARKETPLACE_PROVIDER = 'mrr';
    process.env.NODE_ENV = 'production';

    const res = makeRes();
    await upgradeRig(req(), res);

    expect(res.statusCode).toBe(503);
    expect(res.body.error).toMatch(/MRR_LIVE_ORDERS/);
    expect(pool.connect).not.toHaveBeenCalled();
    expect(require('../services/mrrRenter').placeHashpowerOrder).not.toHaveBeenCalled();
  });

  test('XMR self-mined upgrade: no USDC charge, no marketplace order, SELF_MINING status', async () => {
    const { client, queries } = makeClient();
    pool.connect.mockResolvedValue(client);

    const res = makeRes();
    await upgradeRig(req({ target_pool: 'XMR', request_id: 'req-xmr-1' }), res);

    expect(res.body.success).toBe(true);
    expect(res.body.order_status).toBe('SELF_MINING');
    expect(res.body.btc_spent).toBe(0);
    expect(res.body.protocol_fee_usdc).toBe(0);
    expect(res.body.sandbox).toBe(false);

    // No marketplace interaction, no price fetch, no money movement.
    expect(placeHashpowerOrder).not.toHaveBeenCalled();
    expect(getLiveBtcPrice).not.toHaveBeenCalled();
    expect(queries.some((q) => q.sql.includes('UPDATE user_wallets'))).toBe(false);
    expect(queries.some((q) => q.sql.includes('INSERT INTO protocol_revenue_ledger'))).toBe(false);

    // Idempotent order row recorded as SELF_MINING.
    const orderInsert = queries.find((q) => q.sql.includes('INSERT INTO hashrate_orders'));
    expect(orderInsert.params[2]).toBe('req-xmr-1');
    expect(orderInsert.sql).toContain("'SELF_MINING'");
  });

  test('rejects bad input', async () => {
    const res = makeRes();
    await upgradeRig(req({ wallet: 'not-a-wallet' }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/Valid wallet/);

    const res2 = makeRes();
    await upgradeRig(req({ target_pool: 'ETHEREUM' }), res2);
    expect(res2.statusCode).toBe(400);

    const res3 = makeRes();
    await upgradeRig(req({ request_id: '' }), res3);
    expect(res3.statusCode).toBe(400);
    expect(res3.body.error).toMatch(/request_id/);
  });
});
