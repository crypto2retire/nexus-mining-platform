jest.mock('axios');
const fs = require('fs');
const path = require('path');
jest.mock('../config/db', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));
jest.mock('../services/mrrRenter', () => ({
  placeHashpowerOrder: jest.fn(),
  switchRentalPool: jest.fn(),
  getOrderStatus: jest.fn(),
}));

const axios = require('axios');
const { pool } = require('../config/db');
const mrr = require('../services/mrrRenter');
const {
  claimNextPendingOrder,
  observeActiveOrder,
  processClaimedOrder,
  refundConnectOrder,
  runConnectSweeperOnce,
  startConnectWorker,
  verifyPointedOrder,
} = require('../services/connectWorker');

const REAL_ENV = { ...process.env };
const KAS_ADDRESS = 'kaspa:qrdpuucrld27uu0zvkxnhhhxtg2tr23dlknqqg65pa2740lxqqqqgg4qruwnn';

function order(overrides = {}) {
  return {
    id: 'connect-1',
    user_id: 'user-1',
    target_pool: 'KASPA',
    payout_address: KAS_ADDRESS,
    rig_id: 'rig-1',
    length_hours: 24,
    rental_cost_btc: '0.000024',
    total_usd: '2.5200',
    status: 'RENTING',
    unpaid_last: null,
    ...overrides,
  };
}

afterEach(() => {
  process.env = { ...REAL_ENV };
  jest.clearAllMocks();
  jest.restoreAllMocks();
});

test('claim atomically leases one order with global and per-user concurrency guards', async () => {
  pool.query.mockResolvedValue({ rows: [order()], rowCount: 1 });
  const claimed = await claimNextPendingOrder();
  expect(claimed.id).toBe('connect-1');
  const [sql] = pool.query.mock.calls[0];
  expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/i);
  expect(sql).toMatch(/rent_attempts = c\.rent_attempts \+ 1/i);
  expect(sql).toMatch(/processing_lease_until/i);
  expect(sql).toMatch(/COUNT\(\*\).*< 2/is);
  expect(sql).toMatch(/other\.user_id = candidate\.user_id/is);
});

test('claimed order rents the exact rig then points it at the customer wallet', async () => {
  pool.query.mockResolvedValue({ rows: [], rowCount: 1 });
  mrr.placeHashpowerOrder.mockResolvedValue({
    success: true,
    mode: 'live',
    orderId: '5701967',
    rigHours: 24,
    mrrResponse: { data: { id: '5701967', end: '2026-08-23T00:00:00.000Z' } },
  });
  mrr.switchRentalPool.mockResolvedValue({ success: true });

  await processClaimedOrder(order());

  expect(mrr.placeHashpowerOrder).toHaveBeenCalledWith('KASPA', 0.000024, {
    rigId: 'rig-1', lengthHours: 24, profileId: '957805', maxCostBtc: 0.000024,
  });
  expect(mrr.switchRentalPool).toHaveBeenCalledWith('5701967', {
    host: 'de.kaspa.herominers.com', port: '1207', user: KAS_ADDRESS, pass: 'x',
  });
  const updates = pool.query.mock.calls.map(([sql]) => sql).join('\n');
  expect(updates).toMatch(/mrr_rental_id/i);
  expect(updates).toMatch(/status = 'POOL_POINTED'/i);
});

test('ambiguous rental result stops for operator review without refunding', async () => {
  pool.query.mockResolvedValue({ rows: [], rowCount: 1 });
  mrr.placeHashpowerOrder.mockResolvedValue({
    success: false, ambiguous: true, error: 'timeout after rental request',
  });
  const refundSpy = jest.spyOn(require('../services/connectWorker'), 'refundConnectOrder');

  await processClaimedOrder(order());

  expect(pool.query).toHaveBeenCalledWith(
    expect.stringMatching(/status = 'FAILED_REVIEW'/i),
    expect.arrayContaining(['connect-1'])
  );
  expect(refundSpy).not.toHaveBeenCalled();
});

test('pool-switch failure retries once then refunds while retaining the rental id', async () => {
  const client = {
    query: jest.fn(async (sql) => (
      sql.includes('SELECT * FROM connect_orders')
        ? { rows: [order({ mrr_rental_id: '5701967' })], rowCount: 1 }
        : { rows: [], rowCount: 1 }
    )),
    release: jest.fn(),
  };
  pool.query.mockResolvedValue({ rows: [], rowCount: 1 });
  pool.connect.mockResolvedValue(client);
  mrr.placeHashpowerOrder.mockResolvedValue({ success: true, mode: 'live', orderId: '5701967', rigHours: 24 });
  mrr.switchRentalPool.mockRejectedValue(new Error('pool switch unavailable'));
  jest.spyOn(console, 'error').mockImplementation(() => {});

  await processClaimedOrder(order());

  expect(mrr.switchRentalPool).toHaveBeenCalledTimes(2);
  expect(client.query).toHaveBeenCalledWith(
    expect.stringMatching(/usdc_balance = usdc_balance \+ \$1/i),
    [2.52, 'user-1']
  );
  expect(client.query).toHaveBeenCalledWith(
    expect.stringMatching(/status = 'REFUNDED'/i),
    expect.arrayContaining(['connect-1'])
  );
});

test('sandbox rental results never trigger a real pool-switch request', async () => {
  const client = {
    query: jest.fn(async (sql) => (
      sql.includes('SELECT * FROM connect_orders')
        ? { rows: [order()], rowCount: 1 }
        : { rows: [], rowCount: 1 }
    )),
    release: jest.fn(),
  };
  pool.connect.mockResolvedValue(client);
  mrr.placeHashpowerOrder.mockResolvedValue({
    success: true, mode: 'sandbox', orderId: 'sandbox-mrr-1', rigHours: 24,
  });

  await processClaimedOrder(order());

  expect(mrr.switchRentalPool).not.toHaveBeenCalled();
  expect(client.query).toHaveBeenCalledWith(
    expect.stringMatching(/status = 'REFUNDED'/i),
    expect.arrayContaining(['connect-1'])
  );
});

test('verifyPointedOrder records KAS hashrate and unpaid balance', async () => {
  axios.get.mockResolvedValue({
    data: { stats: { balance: '120591854', hashrate_1h: '207685529691' } },
  });
  pool.query.mockResolvedValue({ rows: [], rowCount: 1 });

  await verifyPointedOrder(order({ status: 'POOL_POINTED', mrr_rental_id: '5701967' }));

  expect(pool.query).toHaveBeenCalledWith(
    expect.stringMatching(/status = 'ACTIVE'.*hashrate_confirmed_at/is),
    [1.20591854, 'connect-1']
  );
});

test('verifyPointedOrder confirms BTC from positive MRR average hashrate', async () => {
  mrr.getOrderStatus.mockResolvedValue({ data: { hashrate: { average: { hash: '500', type: 'th' } } } });
  pool.query.mockResolvedValue({ rows: [], rowCount: 1 });

  await verifyPointedOrder(order({
    target_pool: 'BTC', payout_address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
    status: 'POOL_POINTED', mrr_rental_id: '5701967',
  }));

  expect(pool.query).toHaveBeenCalledWith(
    expect.stringMatching(/status = 'ACTIVE'.*hashrate_confirmed_at/is),
    [null, 'connect-1']
  );
});

test('active KAS observation records a threshold-crossing balance drop as paid', async () => {
  axios.get.mockResolvedValue({ data: { stats: { balance: '25000000' } } });
  pool.query.mockResolvedValue({ rows: [], rowCount: 1 });
  await observeActiveOrder(order({ status: 'ACTIVE', unpaid_last: '1.20000000' }));
  expect(pool.query).toHaveBeenCalledWith(expect.stringMatching(/paid_out_at/i), [0.25, true, 'connect-1']);
});

test('active BTC observation records an address balance increase without attribution claims', async () => {
  axios.get.mockResolvedValue({ data: { balance: 70000 } });
  pool.query.mockResolvedValue({ rows: [], rowCount: 1 });
  await observeActiveOrder(order({
    target_pool: 'BTC', payout_address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
    status: 'ACTIVE', unpaid_last: '0.00060000',
  }));
  expect(pool.query).toHaveBeenCalledWith(expect.stringMatching(/paid_out_at/i), [0.0007, true, 'connect-1']);
});

test('refundConnectOrder is idempotent for an already terminal order', async () => {
  const client = {
    query: jest.fn(async (sql) => (
      sql.includes('SELECT * FROM connect_orders')
        ? { rows: [order({ status: 'REFUNDED' })], rowCount: 1 }
        : { rows: [], rowCount: 1 }
    )),
    release: jest.fn(),
  };
  pool.connect.mockResolvedValue(client);
  await refundConnectOrder(order(), 'repeat');
  expect(client.query.mock.calls.some(([sql]) => /UPDATE\s+user_wallets/i.test(sql))).toBe(false);
});

test('sweeper completes expired active orders after a final observation', async () => {
  pool.query
    .mockResolvedValueOnce({ rows: [order({ status: 'ACTIVE', rental_ends_at: '2026-08-20T00:00:00Z' })], rowCount: 1 })
    .mockResolvedValue({ rows: [], rowCount: 1 });
  axios.get.mockResolvedValue({ data: { stats: { balance: '50000000', hashrate_1h: '0' } } });
  await runConnectSweeperOnce();
  expect(pool.query).toHaveBeenCalledWith(
    expect.stringMatching(/status = 'COMPLETED'/i),
    ['connect-1']
  );
});

test('worker is disabled by default and creates no timers', () => {
  delete process.env.ENABLE_CONNECT;
  const interval = jest.spyOn(global, 'setInterval');
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  startConnectWorker();
  expect(interval).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith('connectWorker: disabled');
});

test('server starts the feature-flagged Connect worker with other workers', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  expect(source).toMatch(/const \{ startConnectWorker \} = require\('\.\/services\/connectWorker'\)/);
  expect(source).toMatch(/startConnectWorker\(\)/);
});
