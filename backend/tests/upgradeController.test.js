jest.mock('../config/db', () => ({
  pool: { connect: jest.fn(), query: jest.fn() },
}));
jest.mock('../services/priceOracle', () => ({
  getLiveBtcPrice: jest.fn(),
}));
jest.mock('../services/hashrateRenter', () => ({
  placeHashpowerOrder: jest.fn(),
  getOrderStatus: jest.fn(),
  POOL_ALGORITHM_MAP: { ZCASH: 'EQUIHASH', KASPA: 'KHEAVYHASH', LTC_DOGE: 'SCRYPT', BTC: 'SHA256' },
  PROVIDER_NAME: 'NICEHASH',
  LIVE_ORDERS_ENV: 'NICEHASH_LIVE_ORDERS',
}));
jest.mock('../services/mrrRenter', () => ({
  placeHashpowerOrder: jest.fn(),
  getOrderStatus: jest.fn(),
  POOL_ALGORITHM_MAP: { ZCASH: 'EQUIHASH', KASPA: 'KHEAVYHASH', LTC_DOGE: 'SCRYPT', BTC: 'SHA256' },
  PROVIDER_NAME: 'MRR',
  LIVE_ORDERS_ENV: 'MRR_LIVE_ORDERS',
}));

const { pool } = require('../config/db');
const { getLiveBtcPrice } = require('../services/priceOracle');
const { placeHashpowerOrder } = require('../services/hashrateRenter');
const { upgradeRig } = require('../controllers/upgradeController');

const REAL_ENV = { ...process.env };
const WALLET = '0x1111111111111111111111111111111111111111';

function makeClient({ balance = 1000, hasRig = false, coins = 0 } = {}) {
  const queries = [];
  const client = {
    query: jest.fn(async (sql, params = []) => {
      queries.push({ sql, params });
      if (sql.includes('SELECT user_id FROM users')) {
        return { rowCount: 1, rows: [{ user_id: 'user-1' }] };
      }
      if (sql.includes('SELECT order_id FROM hashrate_orders')) return { rowCount: 0, rows: [] };
      if (sql.includes('SELECT COUNT(*) AS c FROM virtual_rigs')) {
        return { rowCount: 1, rows: [{ c: String(coins) }] };
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
  const { wallet = WALLET, ...bodyOverrides } = overrides;
  return {
    auth: { wallet },
    body: {
      target_pool: 'ZCASH',
      request_id: 'req-1',
      ...bodyOverrides,
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

    expect(res.statusCode).toBe(202);
    expect(res.body.success).toBe(true);
    // Level 1 -> 2 costs 20 USDC (ZCASH per-coin pricing). Fee 5% = 1.0. Net 19 USDC / 100000 = 0.00019 BTC.
    expect(res.body.protocol_fee_usdc).toBe(1);
    expect(res.body.btc_spent).toBe(0.00019);
    expect(res.body.btc_spot_price).toBe(100000);
    expect(res.body.order_status).toBe('PENDING');
    expect(res.body.status).toBe('PENDING');

    // Revenue ledger books the FEE, not the full upgrade cost.
    const revenueInsert = queries.find((q) => q.sql.includes('INSERT INTO protocol_revenue_ledger'));
    expect(revenueInsert).toBeTruthy();
    expect(revenueInsert.params[1]).toBe(1);
    expect(revenueInsert.params[2]).toBe('RIG_UPGRADE');

    // Balance deducted 20 -> 980.
    const balanceUpdate = queries.find((q) => q.sql.includes('UPDATE user_wallets'));
    expect(balanceUpdate.params[0]).toBe(980);

    // Idempotency key stored on the order row; row reserved as PENDING.
    const orderInsert = queries.find((q) => q.sql.includes('INSERT INTO hashrate_orders'));
    expect(orderInsert.params[2]).toBe('req-1');
    expect(orderInsert.sql).toContain("'PENDING'");

    expect(placeHashpowerOrder).not.toHaveBeenCalled();
  });

  test('multi-coin discount: 2 coins → 5% off the purchase, fee and spend scale down', async () => {
    const { client } = makeClient({ coins: 2 });
    pool.connect.mockResolvedValue(client);

    const res = makeRes();
    await upgradeRig(req(), res);

    expect(res.body.success).toBe(true);
    // ZCASH tier 1→2 = $20 → 5% off = $19. Fee 5% = 0.95. Net 18.05 / 100000 BTC.
    expect(res.body.discount_pct).toBe(5);
    expect(res.body.discounted_cost).toBe(19);
    expect(res.body.protocol_fee_usdc).toBe(0.95);
    expect(res.body.btc_spent).toBe(0.0001805);

    // Balance deducted the discounted price: 1000 - 19 = 981.
    const balanceUpdate = client.query.mock.calls.find(([sql]) => sql.includes('UPDATE user_wallets'));
    expect(balanceUpdate[1][0]).toBe(981);

    // Order row books the discounted cost.
    const orderInsert = client.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO hashrate_orders'));
    expect(orderInsert[1][3]).toBe(19);
  });

  test('4 coins → 15% off (max ladder rung)', async () => {
    const { client } = makeClient({ coins: 4 });
    pool.connect.mockResolvedValue(client);

    const res = makeRes();
    await upgradeRig(req(), res);

    // $20 → $17. Fee 5% = 0.85. Net 16.15 → 0.0001615 BTC.
    expect(res.body.discount_pct).toBe(15);
    expect(res.body.discounted_cost).toBe(17);
    expect(res.body.btc_spent).toBe(0.0001615);
  });

  test('insufficient balance: 400, no order placed, no deduction', async () => {
    const { client } = makeClient({ balance: 10 });
    pool.connect.mockResolvedValue(client);

    const res = makeRes();
    await upgradeRig(req(), res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Insufficient USDC balance');
    expect(placeHashpowerOrder).not.toHaveBeenCalled();
    expect(client.query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false);
  });

  test('request defers marketplace placement and compensation to the worker', async () => {
    const { client, queries } = makeClient();
    pool.connect.mockResolvedValue(client);
    placeHashpowerOrder.mockResolvedValue({
      success: false,
      mode: 'live',
      error: 'Unable to allocate hashrate (5191)',
    });

    const res = makeRes();
    await upgradeRig(req(), res);

    expect(res.statusCode).toBe(202);
    expect(res.body.status).toBe('PENDING');
    expect(placeHashpowerOrder).not.toHaveBeenCalled();
    expect(queries.some((q) => q.sql.includes('usdc_balance = usdc_balance +'))).toBe(false);
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

    expect(res.statusCode).toBe(202);
    expect(res.body.success).toBe(true);
    expect(res.body.marketplace).toBe('MRR');
    expect(res.body.order_status).toBe('PENDING');

    // The NiceHash renter must NOT be involved.
    expect(placeHashpowerOrder).not.toHaveBeenCalled();
    expect(mrrPlace).not.toHaveBeenCalled();

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

  test('per-coin pricing: KASPA tier 2 is $5 (not the flat $50), LTC_DOGE stays premium', async () => {
    const { client } = makeClient({ balance: 1000 });
    pool.connect.mockResolvedValue(client);

    // KASPA tier 2 = $5. Fee 5% = 0.25. Net 4.75 / 100000 = 0.0000475 BTC.
    const res = makeRes();
    await upgradeRig(req({ target_pool: 'KASPA', request_id: 'req-kas-1' }), res);
    expect(res.body.success).toBe(true);
    expect(res.body.protocol_fee_usdc).toBe(0.25);
    expect(res.body.btc_spent).toBe(0.0000475);
    expect(placeHashpowerOrder).not.toHaveBeenCalled();

    // LTC_DOGE tier 2 = $50. Fee 5% = 2.5. Net 47.5 / 100000 = 0.000475 BTC.
    const res2 = makeRes();
    await upgradeRig(req({ target_pool: 'LTC_DOGE', request_id: 'req-ltc-1' }), res2);
    expect(res2.body.success).toBe(true);
    expect(res2.body.protocol_fee_usdc).toBe(2.5);
    expect(res2.body.btc_spent).toBe(0.000475);
    expect(placeHashpowerOrder).not.toHaveBeenCalled();

    // BTC tier 2 = $100 for 50 TH/s. Fee 5% = $5. Net $95 / $100,000.
    const res3 = makeRes();
    await upgradeRig(req({ target_pool: 'BTC', request_id: 'req-btc-1' }), res3);
    expect(res3.body.success).toBe(true);
    expect(res3.body.protocol_fee_usdc).toBe(5);
    expect(res3.body.btc_spent).toBe(0.00095);
    expect(placeHashpowerOrder).not.toHaveBeenCalled();
  });

  test('MRR live order remains pending until the outbox worker runs', async () => {
    process.env.NODE_ENV = 'production';
    process.env.MRR_LIVE_ORDERS = '1';
    process.env.MARKETPLACE_PROVIDER = 'mrr';
    const mrrPlace = require('../services/mrrRenter').placeHashpowerOrder;
    mrrPlace.mockResolvedValue({
      success: true,
      mode: 'live',
      orderId: '5699001',
      actualCostBtc: 0.00000316,
      rigName: 'ICERIVER KS0 PRO',
      rigRpi: 100,
      rigHours: 72,
      mrrResponse: {},
    });
    const { client } = makeClient({ balance: 1000, coins: 2 });
    pool.connect.mockResolvedValue(client);
    // The rental audit row runs AFTER the tx via module-level pool.query.
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT rig_id FROM virtual_rigs')) {
        return { rowCount: 1, rows: [{ rig_id: 'rig-1' }] };
      }
      return { rowCount: 0, rows: [] };
    });

    const res = makeRes();
    await upgradeRig(req({ target_pool: 'KASPA', request_id: 'req-live-mrr' }), res);

    expect(res.body.success).toBe(true);
    expect(res.body.order_status).toBe('PENDING');
    expect(mrrPlace).not.toHaveBeenCalled();

    // 1) RENTAL model: the rig window is the ACTUAL rented hours (72h).
    const poolCalls = pool.query.mock.calls.map(([sql, params]) => ({ sql, params }));
    const expiryUpdate = poolCalls.find((c) => c.sql.includes('SET rental_expires_at'));
    expect(expiryUpdate).toBeFalsy();
    expect(res.body.rig_hours).toBeNull();
    expect(res.body.rental_expires_at).toBeNull();

    // 2) No maintenance POOL fund in the rental model — nothing booked to it.
    const maintInsert = poolCalls.find((c) => c.sql.includes('INSERT INTO maintenance_fee_ledger'));
    expect(maintInsert).toBeFalsy();

    // 3) rig_rentals records the ACTUAL cost (audit trail of the real rental).
    const rentalInsert = poolCalls.find((c) => c.sql.includes('INSERT INTO rig_rentals'));
    expect(rentalInsert).toBeFalsy();
  });
});

// ---- buySession: HYBRID short sessions (1h-24h slices of spare capacity) ---

jest.mock('../services/roomHash', () => ({ fetchLiveRealHash: jest.fn() }));
const { fetchLiveRealHash } = require('../services/roomHash');
const { buySession } = require('../controllers/upgradeController');
const mrrRenter = require('../services/mrrRenter');

function sessionClient({ balance = 1000, activeCredits = 25, myHashrate = 25 } = {}) {
  const calls = [];
  const client = {
    query: jest.fn(async (sql, params = []) => {
      calls.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 1, rows: [] };
      if (sql.includes('pg_advisory_xact_lock')) return { rowCount: 1, rows: [] };
      if (sql.includes('SELECT user_id FROM users')) return { rowCount: 1, rows: [{ user_id: 'user-1' }] };
      if (sql.includes('SELECT COUNT(*) AS c FROM virtual_rigs')) return { rowCount: 1, rows: [{ c: '0' }] };
      if (sql.includes('SELECT wallet_id, usdc_balance')) {
        return { rowCount: 1, rows: [{ wallet_id: 'wallet-1', usdc_balance: balance }] };
      }
      if (sql.includes('FROM capacity_slices')) {
        return {
          rowCount: 1,
          rows: [{ slice_id: 'slice-1', virtual_hashrate: activeCredits }],
        };
      }
      if (sql.includes('INSERT INTO hashrate_orders')) return { rowCount: 1, rows: [{ order_id: 'order-s1' }] };
      if (sql.includes('INSERT INTO protocol_revenue_ledger')) return { rowCount: 1, rows: [] };
      if (sql.includes('UPDATE user_wallets')) return { rowCount: 1, rows: [] };
      if (sql.includes('INSERT INTO capacity_slices')) return { rowCount: 1, rows: [] };
      throw new Error(`unexpected sql: ${sql}`);
    }),
    release: jest.fn(),
  };
  pool.connect.mockResolvedValue(client);
  fetchLiveRealHash.mockResolvedValue(195.5);
  return { client, calls };
}

function makeSessionRes() {
  const res = { statusCode: null, body: null };
  res.status = jest.fn((code) => { res.statusCode = code; return res; });
  res.json = jest.fn((obj) => { res.body = obj; return res; });
  return res;
}

describe('buySession — hybrid short sessions', () => {
  test('full flow: charges the marked-up price and inserts an independent SESSION slice', async () => {
    const { client, calls } = sessionClient();
    const res = makeSessionRes();
    await buySession(
      { auth: { wallet: WALLET }, body: { target_pool: 'KASPA', request_id: 'sess-1', hours: 1, ghs: 25 } },
      res
    );

    expect(res.statusCode).toBeFalsy(); // success path: no status set
    expect(res.body.success).toBe(true);
    expect(res.body.session).toBe(true);
    // 25 GH/s x 1h x base(5/25/72=0.0027778) x markup 5 = 0.3472 (no discount)
    expect(Number(res.body.price)).toBeCloseTo(0.3472, 4);
    expect(res.body.ghs).toBe(25);
    expect(res.body.hours).toBe(1);
    expect(res.body.rental_expires_at).toBeTruthy();

    // SESSION audit row: marketplace literal, algorithm mapped, hours recorded.
    const orderInsert = calls.find((c) => c.sql.includes('INSERT INTO hashrate_orders'));
    expect(orderInsert).toBeTruthy();
    expect(orderInsert.sql).toContain("'SESSION'");
    expect(orderInsert.params[4]).toBe('KHEAVYHASH'); // POOL_ALGORITHM_MAP — was ReferenceError before the fix
    expect(orderInsert.params[6]).toBe(1); // rig_hours

    // FULL price booked as platform revenue (the rig was already paid for).
    const revenue = calls.find((c) => c.sql.includes('INSERT INTO protocol_revenue_ledger'));
    expect(revenue.params[2]).toBe('SESSION_SALE'); // type is a $N param, not a literal
    expect(Number(revenue.params[1])).toBeCloseTo(0.3472, 4);

    // NO marketplace order ever placed for a session.
    expect(mrrRenter.placeHashpowerOrder).not.toHaveBeenCalled();

    const sliceInsert = calls.find((c) => c.sql.includes('INSERT INTO capacity_slices'));
    expect(sliceInsert.params[2]).toBe(25);
    expect(sliceInsert.sql).toContain("'SESSION'");
    expect(calls.some((c) => c.sql.includes('UPDATE virtual_rigs'))).toBe(false);
  });

  test('oversell guard: rejects when the slot exceeds spare capacity', async () => {
    // Credits 180 GH/s on a 195.5 GH/s room -> spare 15.5 < 25 slot.
    const { client } = sessionClient({ activeCredits: 180, myHashrate: 180 });
    const res = makeSessionRes();
    await buySession(
      { auth: { wallet: WALLET }, body: { target_pool: 'KASPA', request_id: 'sess-2', hours: 1, ghs: 25 } },
      res
    );
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/spare capacity/);
  });

  test('validation: 72h is NOT a session — must use the rent flow', async () => {
    const res = makeSessionRes();
    await buySession(
      { auth: { wallet: WALLET }, body: { target_pool: 'KASPA', request_id: 'sess-3', hours: 72, ghs: 25 } },
      res
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/72h rentals go through the rent flow/);
  });

  test('capacity must be MEASURABLE — a failed live fetch blocks the sale (503)', async () => {
    fetchLiveRealHash.mockResolvedValue(null);
    const res = makeSessionRes();
    await buySession(
      { auth: { wallet: WALLET }, body: { target_pool: 'KASPA', request_id: 'sess-4', hours: 1, ghs: 25 } },
      res
    );
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toMatch(/cannot be measured/);
  });
});
