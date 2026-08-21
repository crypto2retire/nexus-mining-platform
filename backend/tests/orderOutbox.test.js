jest.mock('../config/db', () => ({ pool: { query: jest.fn(), connect: jest.fn() } }));
jest.mock('../services/hashrateRenter', () => ({
  placeHashpowerOrder: jest.fn(),
  getOrderStatus: jest.fn(),
}));
jest.mock('../services/mrrRenter', () => ({
  placeHashpowerOrder: jest.fn(),
  getOrderStatus: jest.fn(),
}));

const { pool } = require('../config/db');
const renter = require('../services/hashrateRenter');
const {
  processOneOrder,
  claimNextOrder,
  failExhaustedOrders,
  reconcilePlacedOrders,
  MAX_ATTEMPTS,
} = require('../services/orderOutboxWorker');

const ORDER = {
  order_id: 'order-1', user_id: 'user-1', target_pool: 'KASPA', request_id: 'req-1',
  marketplace: 'NICEHASH', btc_spent: '0.0001', usdc_cost: '5', attempts: 1,
  created_rig: true, renewal: false,
};

function txClient(locked = ORDER) {
  const client = {
    query: jest.fn(async (sql) => {
      if (sql.includes('SELECT * FROM hashrate_orders')) return { rowCount: 1, rows: [locked] };
      if (sql.includes('SELECT rig_id, virtual_hashrate FROM virtual_rigs')) {
        return { rowCount: 1, rows: [{ rig_id: 'rig-1', virtual_hashrate: '25' }] };
      }
      return { rowCount: 1, rows: [] };
    }),
    release: jest.fn(),
  };
  pool.connect.mockResolvedValue(client);
  return client;
}

beforeEach(() => {
  jest.clearAllMocks();
});

test('worker places an order only after it has been claimed from committed PENDING state', async () => {
  pool.query.mockResolvedValueOnce({ rows: [ORDER] });
  renter.placeHashpowerOrder.mockResolvedValue({ success: true, mode: 'live', orderId: 'nh-1', rigHours: 72 });
  const client = txClient();

  await expect(processOneOrder()).resolves.toBe(true);
  expect(pool.query.mock.invocationCallOrder[0]).toBeLessThan(renter.placeHashpowerOrder.mock.invocationCallOrder[0]);
  expect(renter.placeHashpowerOrder).toHaveBeenCalledWith('KASPA', 0.0001, 'req-1');
  expect(client.query.mock.calls.some(([sql]) => sql.includes("outbox_state = 'PLACED'"))).toBe(true);
});

test('placement failure refunds funds and reverts a newly created rig in one transaction', async () => {
  pool.query.mockResolvedValueOnce({ rows: [ORDER] });
  renter.placeHashpowerOrder.mockResolvedValue({ success: false, error: 'no capacity' });
  const client = txClient();

  await processOneOrder();
  expect(client.query.mock.calls[0][0]).toBe('BEGIN');
  expect(client.query.mock.calls.some(([sql]) => sql.includes('usdc_balance = usdc_balance +'))).toBe(true);
  expect(client.query.mock.calls.some(([sql]) => sql.includes('DELETE FROM virtual_rigs'))).toBe(false);
  expect(client.query.mock.calls.some(([sql]) => sql.includes("outbox_state = 'FAILED'"))).toBe(true);
  expect(client.query.mock.calls.at(-1)[0]).toBe('COMMIT');
});

test('claim query reclaims PROCESSING orders whose lease expired', async () => {
  pool.query.mockResolvedValue({ rows: [] });
  await claimNextOrder();
  const sql = pool.query.mock.calls[0][0];
  expect(sql).toContain("outbox_state = 'PROCESSING'");
  expect(sql).toContain('processing_lease_until < CURRENT_TIMESTAMP');
  expect(sql).toContain('attempts = attempts + 1');
});

test('orders at the max attempt count are refunded and failed', async () => {
  pool.query.mockResolvedValueOnce({ rows: [{ ...ORDER, attempts: MAX_ATTEMPTS }] });
  const client = txClient({ ...ORDER, attempts: MAX_ATTEMPTS });
  await expect(failExhaustedOrders()).resolves.toBe(1);
  expect(pool.query.mock.calls[0][1]).toEqual([MAX_ATTEMPTS]);
  expect(client.query.mock.calls.some(([sql]) => sql.includes("outbox_state = 'FAILED'"))).toBe(true);
});

test('reconciliation confirms a placed order from marketplace status', async () => {
  pool.query
    .mockResolvedValueOnce({ rows: [{ ...ORDER, outbox_state: 'PLACED', nicehash_order_id: 'nh-1' }] })
    .mockResolvedValueOnce({ rowCount: 1, rows: [] });
  renter.getOrderStatus.mockResolvedValue({ status: 'ACTIVE' });
  await expect(reconcilePlacedOrders()).resolves.toBe(1);
  expect(renter.getOrderStatus).toHaveBeenCalledWith('nh-1');
  expect(pool.query.mock.calls[1][0]).toContain("outbox_state = 'RECONCILED'");
});
