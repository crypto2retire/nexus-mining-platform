jest.mock('../services/mrrRenter', () => ({
  ...jest.requireActual('../services/mrrRenter'),
  makeMrrRequest: jest.fn(),
}));
jest.mock('../config/db', () => ({
  pool: { connect: jest.fn(), query: jest.fn() },
}));
jest.mock('../services/priceOracle', () => ({ getLiveBtcPrice: jest.fn() }));
jest.mock('../services/operatorMarketService', () => ({
  ...jest.requireActual('../services/operatorMarketService'),
  getCoinMarketData: jest.fn(),
}));

const mrr = require('../services/mrrRenter');
const { pool } = require('../config/db');
const { getLiveBtcPrice } = require('../services/priceOracle');
const { getCoinMarketData } = require('../services/operatorMarketService');
const {
  ConnectError,
  POOL_CONFIG,
  advertisedWindows,
  createConnectOrder,
  listConnectOrders,
  marketFor,
  quote,
  validatePayoutAddress,
} = require('../services/connectService');

const REAL_ENV = { ...process.env };

function availableRig({ id = 'rig-1', hash = 200, type = 'gh', hourly = 0.000001, min = 3 } = {}) {
  return {
    id,
    name: `Rig ${id}`,
    rpi: '98.4',
    region: 'EU',
    online: true,
    status: { status: 'available', rented: false, online: true },
    maxhours: '72',
    price: { BTC: { hour: String(hourly), min_rental_length: min, enabled: true } },
    hashrate: { advertised: { hash, type, nice: `${hash} ${type.toUpperCase()}/s` } },
  };
}

beforeEach(() => {
  process.env.CONNECT_FEE_PCT = '5';
  process.env.MRR_MAX_RENTAL_HOURS = '72';
  getLiveBtcPrice.mockResolvedValue({
    price: 100000,
    feed: 'test BTC/USD',
    isUsdcPair: false,
  });
  getCoinMarketData.mockImplementation(async (algo) => ({
    spots: algo === 'kheavyhash' ? { KAS: 0.03 }
      : algo === 'equihash' ? { ZEC: 50 }
        : { BTC: 100000 },
    priceTrend: [],
  }));
  pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

afterEach(() => {
  process.env = { ...REAL_ENV };
  jest.clearAllMocks();
});

test('pool configuration uses the verified direct-to-wallet endpoints and parsers', () => {
  expect(POOL_CONFIG.KASPA.host).toBe('de.kaspa.herominers.com');
  expect(POOL_CONFIG.KASPA.port).toBe('1207');
  expect(POOL_CONFIG.KASPA.profile).toBe('957805');
  expect(POOL_CONFIG.KASPA.balanceOf({ stats: { balance: '120591854' } })).toBeCloseTo(1.20591854);
  expect(POOL_CONFIG.KASPA.hashOf({ stats: { hashrate_1h: '207685529691' } })).toBe(207685529691);

  expect(POOL_CONFIG.ZCASH.host).toBe('zec.2miners.com');
  expect(POOL_CONFIG.ZCASH.port).toBe('1010');
  expect(POOL_CONFIG.ZCASH.profile).toBe('957592');
  expect(POOL_CONFIG.ZCASH.balanceOf({ unpaid: '25000000' })).toBe(0.25);
  expect(POOL_CONFIG.ZCASH.hashOf({ currentHashrate: 12345 })).toBe(12345);

  expect(POOL_CONFIG.BTC.host).toBe('mine.ocean.xyz');
  expect(POOL_CONFIG.BTC.port).toBe('3334');
  expect(POOL_CONFIG.BTC.profile).toBe('957824');
  expect(POOL_CONFIG.BTC.balanceOf({ balance: 65536 })).toBe(0.00065536);
  expect(POOL_CONFIG.BTC.hashOf({})).toBeNull();
});

test.each([
  ['KASPA', 'kaspa:qrdpuucrld27uu0zvkxnhhhxtg2tr23dlknqqg65pa2740lxqqqqgg4qruwnn'],
  ['ZCASH', 't1V5oarvihbomZswPw381AowjPpGj1t2B3K'],
  ['BTC', '1BoatSLRHtKNngkdXEeobR76b53LETtpyT'],
])('validates a supported %s payout address', (pool, address) => {
  expect(validatePayoutAddress(pool, address)).toBe(true);
  expect(validatePayoutAddress(pool, `${address}!`)).toBe(false);
});

test('advertisedWindows respects the advertised options and rig bounds', () => {
  const rig = availableRig({ min: 5 });
  rig.maxhours = '50';
  expect(advertisedWindows(rig)).toEqual([6, 12, 24, 48]);
});

test('quote returns independently verifiable rental and fee arithmetic', async () => {
  mrr.makeMrrRequest.mockResolvedValue({ data: { records: [availableRig()] } });

  const result = await quote({ targetPool: 'KASPA', rigId: 'rig-1', lengthHours: 24 });

  expect(result.rental_cost_btc).toBe(0.000024);
  expect(result.rental_cost_usd).toBe(2.4);
  expect(result.fee_pct).toBe(5);
  expect(result.fee_usd).toBe(0.12);
  expect(result.total_usd).toBe(2.52);
  expect(result.windows).toEqual([3, 6, 12, 24, 48, 72]);
  expect(result.rig.rig_id).toBe('rig-1');
});

test('quote rejects a window not offered for the selected rig', async () => {
  mrr.makeMrrRequest.mockResolvedValue({ data: { records: [availableRig({ min: 6 })] } });
  await expect(quote({ targetPool: 'KASPA', rigId: 'rig-1', lengthHours: 3 }))
    .rejects.toEqual(expect.objectContaining({ statusCode: 400 }));
});

test.each([
  ['kheavyhash', availableRig(), { KAS: 0.03 }],
  ['equihash', availableRig({ hash: 30, type: 'kh' }), { ZEC: 50 }],
  ['sha256', availableRig({ hash: 500, type: 'th' }), { BTC: 100000 }],
])('marketFor returns live sorted rows for %s', async (algo, rig, spots) => {
  const expensive = { ...rig, id: `${rig.id}-expensive`, price: { BTC: { ...rig.price.BTC, hour: '0.000002' } } };
  mrr.makeMrrRequest.mockImplementation(async (_method, requestPath) => (
    requestPath === '/rig'
      ? { data: { records: [expensive, rig] } }
      : { data: [{ name: algo, stats: { available: {}, prices: {} } }] }
  ));
  getCoinMarketData.mockResolvedValueOnce({ spots, priceTrend: [] });

  const result = await marketFor(algo);

  expect(result.rigs).toHaveLength(2);
  expect(result.rigs[0].profitability.net_day)
    .toBeGreaterThan(result.rigs[1].profitability.net_day);
  expect(result.algo).toBe(algo);
});

test('marketFor rejects the excluded scrypt algorithm', async () => {
  await expect(marketFor('scrypt')).rejects.toBeInstanceOf(ConnectError);
  expect(mrr.makeMrrRequest).not.toHaveBeenCalled();
});

function transactionClient(overrides = {}) {
  return {
    query: jest.fn(async (sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (sql.includes('FROM users')) {
        return { rows: [{ user_id: 'user-1' }], rowCount: 1 };
      }
      if (sql.includes('status IN') && sql.includes('FROM connect_orders')) {
        return overrides.nonterminal || { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM connect_orders') && sql.includes('request_id')) {
        return overrides.duplicate || { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM user_wallets')) {
        return { rows: [{ wallet_id: 'wallet-1', usdc_balance: overrides.balance ?? '10.0000' }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO connect_orders')) {
        return {
          rows: [{
            id: 'connect-1', user_id: 'user-1', request_id: 'request-1',
            target_pool: 'KASPA', payout_address: overrides.payoutAddress,
            status: 'PENDING_RENT', total_usd: '2.5200',
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    }),
    release: jest.fn(),
  };
}

const KAS_ADDRESS = 'kaspa:qrdpuucrld27uu0zvkxnhhhxtg2tr23dlknqqg65pa2740lxqqqqgg4qruwnn';

test('createConnectOrder debits total once and books only the connection fee', async () => {
  const client = transactionClient({ payoutAddress: KAS_ADDRESS });
  pool.connect.mockResolvedValue(client);
  mrr.makeMrrRequest.mockResolvedValue({ data: { records: [availableRig()] } });

  const order = await createConnectOrder({
    wallet: '0x1111111111111111111111111111111111111111',
    targetPool: 'KASPA',
    payoutAddress: KAS_ADDRESS,
    rigId: 'rig-1',
    lengthHours: 24,
    requestId: 'request-1',
  });

  expect(order.id).toBe('connect-1');
  const walletUpdate = client.query.mock.calls.find(([sql]) => /UPDATE\s+user_wallets/i.test(sql));
  expect(walletUpdate[1][0]).toBe(2.52);
  const revenue = client.query.mock.calls.find(([sql]) => /INSERT INTO protocol_revenue_ledger/i.test(sql));
  expect(revenue[0]).toContain('connect_order_id');
  expect(revenue[1]).toEqual(['user-1', 0.12, 'CONNECT_FEE', 'connect-1']);
  expect(client.query.mock.calls.map(([sql]) => sql)).toEqual(expect.arrayContaining(['BEGIN', 'COMMIT']));
  expect(client.query.mock.calls.map(([sql]) => sql)).not.toContain('ROLLBACK');
  expect(client.release).toHaveBeenCalled();
});

test('createConnectOrder returns a same-user duplicate without a second debit', async () => {
  const existing = {
    id: 'connect-existing', user_id: 'user-1', request_id: 'request-1',
    target_pool: 'KASPA', status: 'PENDING_RENT',
  };
  const client = transactionClient({ payoutAddress: KAS_ADDRESS });
  pool.connect.mockResolvedValue(client);
  pool.query.mockResolvedValue({
    rows: [{ ...existing, owner_wallet: '0x1111111111111111111111111111111111111111' }],
    rowCount: 1,
  });

  const order = await createConnectOrder({
    wallet: '0x1111111111111111111111111111111111111111',
    targetPool: 'KASPA', payoutAddress: KAS_ADDRESS,
    rigId: 'rig-1', lengthHours: 24, requestId: 'request-1',
  });

  expect(order).toEqual(existing);
  expect(mrr.makeMrrRequest).not.toHaveBeenCalled();
  expect(client.query.mock.calls.some(([sql]) => /UPDATE\s+user_wallets/i.test(sql))).toBe(false);
  expect(client.query.mock.calls.some(([sql]) => /INSERT INTO protocol_revenue_ledger/i.test(sql))).toBe(false);
});

test('createConnectOrder rejects insufficient USDC without ledger or order writes', async () => {
  const client = transactionClient({ balance: '2.5100', payoutAddress: KAS_ADDRESS });
  pool.connect.mockResolvedValue(client);
  mrr.makeMrrRequest.mockResolvedValue({ data: { records: [availableRig()] } });

  await expect(createConnectOrder({
    wallet: '0x1111111111111111111111111111111111111111',
    targetPool: 'KASPA', payoutAddress: KAS_ADDRESS,
    rigId: 'rig-1', lengthHours: 24, requestId: 'request-1',
  })).rejects.toEqual(expect.objectContaining({ statusCode: 400, message: 'Insufficient USDC balance' }));

  expect(client.query.mock.calls.some(([sql]) => /INSERT INTO connect_orders/i.test(sql))).toBe(false);
  expect(client.query.mock.calls.some(([sql]) => /protocol_revenue_ledger/i.test(sql))).toBe(false);
  expect(client.query.mock.calls.map(([sql]) => sql)).toContain('ROLLBACK');
});

test('createConnectOrder enforces one nonterminal Connect order per user before debit', async () => {
  const client = transactionClient({
    nonterminal: { rows: [{ id: 'connect-active' }], rowCount: 1 },
    payoutAddress: KAS_ADDRESS,
  });
  pool.connect.mockResolvedValue(client);
  mrr.makeMrrRequest.mockResolvedValue({ data: { records: [availableRig()] } });

  await expect(createConnectOrder({
    wallet: '0x1111111111111111111111111111111111111111',
    targetPool: 'KASPA', payoutAddress: KAS_ADDRESS,
    rigId: 'rig-1', lengthHours: 24, requestId: 'request-2',
  })).rejects.toEqual(expect.objectContaining({ statusCode: 409 }));

  expect(client.query.mock.calls.some(([sql]) => /UPDATE\s+user_wallets/i.test(sql))).toBe(false);
  expect(client.query.mock.calls.some(([sql]) => /INSERT INTO connect_orders/i.test(sql))).toBe(false);
});

test('listConnectOrders resolves the authenticated wallet and limits newest-first results', async () => {
  pool.query.mockResolvedValue({ rows: [{ id: 'connect-1' }] });
  const rows = await listConnectOrders('0x1111111111111111111111111111111111111111');
  expect(rows).toEqual([{ id: 'connect-1' }]);
  expect(pool.query).toHaveBeenCalledWith(
    expect.stringMatching(/ORDER BY c\.created_at DESC\s+LIMIT 25/i),
    ['0x1111111111111111111111111111111111111111']
  );
});
