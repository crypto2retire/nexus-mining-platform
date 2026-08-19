/**
 * rentalScheduler tests (010_rental_scheduler):
 *  - safety rail: live MRR off → never touches the API
 *  - expired rentals marked ENDED; rigs with active backing skipped
 *  - pool exhausted → auto-pause (DORMANT) unless the owner OK'd loss mining
 *  - OK'd loss mining → funded from USDC balance, never negative
 *  - daily spend cap respected; failed placements never recorded
 */

jest.mock('../config/db', () => ({
  pool: { connect: jest.fn(), query: jest.fn() },
}));
jest.mock('../services/priceOracle', () => ({
  getLiveBtcPrice: jest.fn(),
}));
jest.mock('../services/mrrRenter', () => ({
  isLiveMode: jest.fn(),
  makeMrrRequest: jest.fn(),
  findAffordableRig: jest.fn(),
  POOL_ALGORITHM_MAP: { ZCASH: 'ZHASH', KASPA: 'KHEAVYHASH', LTC_DOGE: 'SCRYPT' },
}));

const { pool } = require('../config/db');
const { getLiveBtcPrice } = require('../services/priceOracle');
const mrr = require('../services/mrrRenter');
const { runSchedulerOnce } = require('../services/rentalScheduler');

const REAL_ENV = { ...process.env };

const RIG = {
  rig_id: 'rig-1',
  user_id: 'user-1',
  target_pool: 'LTC_DOGE',
  virtual_hashrate: '25.0000',
  level: 2,
  mine_at_loss: false,
};

function makeSchedulerClient({
  openRentals = [],
  rigs = [RIG],
  backingRigIds = new Set(),
  collected = 0,
  spent = 0,
  usdcBalance = '0.0000',
  spentToday = 0,
} = {}) {
  const client = {
    query: jest.fn(async (sql, params = []) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 1, rows: [] };
      if (sql.includes('SELECT id, mrr_rental_id, rig_id FROM rig_rentals')) {
        return { rowCount: openRentals.length, rows: openRentals };
      }
      if (sql.includes("UPDATE rig_rentals SET status = 'ENDED'")) return { rowCount: 1, rows: [] };
      if (sql.includes('SUM(cost_usd)') && sql.includes('created_at >= $1')) {
        return { rowCount: 1, rows: [{ total: String(spentToday) }] };
      }
      if (sql.includes('FROM virtual_rigs v')) {
        return { rowCount: rigs.length, rows: rigs };
      }
      if (sql.includes('SELECT id FROM rig_rentals WHERE rig_id = $1')) {
        return { rowCount: backingRigIds.has(params[0]) ? 1 : 0, rows: [] };
      }
      if (sql.includes('SUM(amount_usdc)')) {
        return { rowCount: 1, rows: [{ collected: String(collected), spent: String(spent) }] };
      }
      if (sql.includes('SELECT wallet_id, usdc_balance FROM user_wallets')) {
        return { rowCount: 1, rows: [{ wallet_id: 'wallet-1', usdc_balance: usdcBalance }] };
      }
      if (sql.includes("SET maintenance_status = 'DORMANT'")) return { rowCount: 1, rows: [] };
      if (sql.includes('INSERT INTO rig_hashrate_history')) return { rowCount: 1, rows: [] };
      if (sql.includes('usdc_balance = usdc_balance -')) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('INSERT INTO rig_rentals')) return { rowCount: 1, rows: [] };
      throw new Error(`unexpected sql: ${sql}`);
    }),
    release: jest.fn(),
  };
  pool.connect.mockResolvedValue(client);
  return client;
}

const fit = {
  rigId: '370055',
  rigName: 'tep1ltc',
  rigRpi: 100,
  hourly: 0.0000021,
  length: 3,
  cost: 0.00000669,
  hashrate: 6.6,
};

afterEach(() => {
  process.env = { ...REAL_ENV };
  jest.clearAllMocks();
});

describe('rentalScheduler — safety rail', () => {
  test('live MRR orders not enabled → no MRR calls, no DB work', async () => {
    mrr.isLiveMode.mockReturnValue(false);
    await runSchedulerOnce();
    expect(mrr.makeMrrRequest).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test('missing pool profile env → rig skipped, no order', async () => {
    mrr.isLiveMode.mockReturnValue(true);
    mrr.makeMrrRequest.mockImplementation(async (method, path) => {
      if (method === 'GET' && path === '/rental') return { data: { rentals: [] } };
      throw new Error(`unexpected ${method} ${path}`);
    });
    getLiveBtcPrice.mockResolvedValue({ price: 100000 });
    const client = makeSchedulerClient({ collected: 5, spent: 0 });
    delete process.env.MRR_POOL_PROFILE_SCRYPT;
    await runSchedulerOnce();
    expect(mrr.findAffordableRig).not.toHaveBeenCalled();
  });
});

describe('rentalScheduler — rental lifecycle', () => {
  beforeEach(() => {
    process.env.MRR_POOL_PROFILE_SCRYPT = '957451';
  });

  test('rig already backed by an ACTIVE rental → skipped', async () => {
    mrr.isLiveMode.mockReturnValue(true);
    mrr.makeMrrRequest.mockResolvedValue({ data: { rentals: [{ id: '5697894', ended: false }] } });
    getLiveBtcPrice.mockResolvedValue({ price: 100000 });
    const client = makeSchedulerClient({
      collected: 5,
      spent: 0,
      backingRigIds: new Set(['rig-1']),
    });
    await runSchedulerOnce();
    expect(mrr.findAffordableRig).not.toHaveBeenCalled();
    const inserts = client.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO rig_rentals'));
    expect(inserts).toHaveLength(0);
  });

  test('rig_rentals row whose MRR rental is gone → marked ENDED', async () => {
    mrr.isLiveMode.mockReturnValue(true);
    mrr.makeMrrRequest.mockResolvedValue({ data: { rentals: [] } }); // nothing active at MRR
    getLiveBtcPrice.mockResolvedValue({ price: 100000 });
    const client = makeSchedulerClient({
      openRentals: [{ id: 1, mrr_rental_id: '5697890', rig_id: 'rig-1' }],
    });
    await runSchedulerOnce();
    const ended = client.query.mock.calls.find(([sql]) => sql.includes("UPDATE rig_rentals SET status = 'ENDED'"));
    expect(ended).toBeTruthy();
    expect(ended[1][0]).toBe(1);
  });
});

describe('rentalScheduler — funding rules', () => {
  beforeEach(() => {
    process.env.MRR_POOL_PROFILE_SCRYPT = '957451';
  });

  test('pool exhausted + no loss-OK → auto-pause (DORMANT), no order', async () => {
    mrr.isLiveMode.mockReturnValue(true);
    mrr.makeMrrRequest.mockResolvedValue({ data: { rentals: [] } });
    getLiveBtcPrice.mockResolvedValue({ price: 100000 });
    const client = makeSchedulerClient({ collected: 0.1, spent: 0.2 }); // available < MIN_FUND_USD
    await runSchedulerOnce();

    const dormant = client.query.mock.calls.find(([sql]) => sql.includes("SET maintenance_status = 'DORMANT'"));
    expect(dormant).toBeTruthy();
    const zero = client.query.mock.calls.find(
      ([sql]) => sql.includes('INSERT INTO rig_hashrate_history') && /VALUES \(\$1, \$2, 0\)/.test(sql)
    );
    expect(zero).toBeTruthy();
    expect(mrr.findAffordableRig).not.toHaveBeenCalled();
  });

  test('pool sufficient → rental placed and recorded, funded from POOL', async () => {
    mrr.isLiveMode.mockReturnValue(true);
    mrr.makeMrrRequest.mockImplementation(async (method, path) => {
      if (method === 'GET' && path === '/rental') return { data: { rentals: [] } };
      if (method === 'PUT' && path === '/rental') {
        return { success: true, data: { id: '5697900', renter: 'letsmakemoney' } };
      }
      throw new Error(`unexpected ${method} ${path}`);
    });
    getLiveBtcPrice.mockResolvedValue({ price: 100000 });
    mrr.findAffordableRig.mockResolvedValue(fit);
    const client = makeSchedulerClient({ collected: 5, spent: 0 });
    await runSchedulerOnce();

    expect(mrr.findAffordableRig).toHaveBeenCalledWith('scrypt', expect.any(Number));
    const insert = client.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO rig_rentals'));
    expect(insert).toBeTruthy();
    // [user, rig, pool, mrr_rental_id, rig_name, rig_rpi, cost_btc, cost_usd, length_hours, funded_from, status]
    expect(insert[1][0]).toBe('user-1');
    expect(insert[1][1]).toBe('rig-1');
    expect(insert[1][3]).toBe('5697900');
    expect(insert[1][7]).toBeCloseTo(0.669, 3); // 0.00000669 BTC × 100k
    expect(insert[1][9]).toBe('POOL');
  });

  test('pool exhausted + loss-OK + USDC balance → funded from USDC and charged', async () => {
    mrr.isLiveMode.mockReturnValue(true);
    mrr.makeMrrRequest.mockImplementation(async (method, path) => {
      if (method === 'GET' && path === '/rental') return { data: { rentals: [] } };
      if (method === 'PUT' && path === '/rental') {
        return { success: true, data: { id: '5697901' } };
      }
      throw new Error(`unexpected ${method} ${path}`);
    });
    getLiveBtcPrice.mockResolvedValue({ price: 100000 });
    mrr.findAffordableRig.mockResolvedValue(fit);
    const client = makeSchedulerClient({
      collected: 0,
      spent: 0,
      usdcBalance: '5.0000',
      rigs: [{ ...RIG, mine_at_loss: true }],
    });
    await runSchedulerOnce();

    const charge = client.query.mock.calls.find(([sql]) => sql.includes('usdc_balance = usdc_balance -'));
    expect(charge).toBeTruthy();
    expect(Number(charge[1][0])).toBeCloseTo(0.669, 3);
    const insert = client.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO rig_rentals'));
    expect(insert[1][9]).toBe('USDC');
  });

  test('daily spend cap reached → rig waits, no order', async () => {
    mrr.isLiveMode.mockReturnValue(true);
    mrr.makeMrrRequest.mockResolvedValue({ data: { rentals: [] } });
    getLiveBtcPrice.mockResolvedValue({ price: 100000 });
    const client = makeSchedulerClient({ collected: 5, spent: 0, spentToday: 20 }); // cap = $20 default
    await runSchedulerOnce();
    expect(mrr.findAffordableRig).not.toHaveBeenCalled();
  });

  test('MRR rejects the order → nothing recorded', async () => {
    mrr.isLiveMode.mockReturnValue(true);
    mrr.makeMrrRequest.mockImplementation(async (method, path) => {
      if (method === 'GET' && path === '/rental') return { data: { rentals: [] } };
      if (method === 'PUT' && path === '/rental') {
        return { success: false, data: { message: 'This rig is presently unavailable' } };
      }
      throw new Error(`unexpected ${method} ${path}`);
    });
    getLiveBtcPrice.mockResolvedValue({ price: 100000 });
    mrr.findAffordableRig.mockResolvedValue(fit);
    const client = makeSchedulerClient({ collected: 5, spent: 0 });
    await runSchedulerOnce();

    const inserts = client.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO rig_rentals'));
    expect(inserts).toHaveLength(0);
  });
});
