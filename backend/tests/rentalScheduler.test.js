/**
 * rentalScheduler tests (013_rental_model, rewritten 2026-08-20):
 *  - the scheduler is now an EXPIRY SWEEPER, not a re-rental loop
 *  - rig_rentals rows whose MRR rental is gone → marked ENDED
 *  - virtual rigs whose rental window passed → EXPIRED + 0-hashrate row
 *  - no funds are ever spent by the scheduler (rentals are paid at purchase)
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
  POOL_ALGORITHM_MAP: { ZCASH: 'ZHASH', KASPA: 'KHEAVYHASH', LTC_DOGE: 'SCRYPT', XMR: 'RANDOMX' },
}));

const { pool } = require('../config/db');
const mrr = require('../services/mrrRenter');
const { runSchedulerOnce } = require('../services/rentalScheduler');

const REAL_ENV = { ...process.env };

const EXPIRED_RIG = {
  rig_id: 'rig-expired',
  user_id: 'user-1',
  target_pool: 'KASPA',
};

function makeSchedulerClient({ openRentals = [], expiredRigs = [] } = {}) {
  const client = {
    query: jest.fn(async (sql, params = []) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 1, rows: [] };
      if (sql.includes('SELECT id, mrr_rental_id, rig_id FROM rig_rentals')) {
        return { rowCount: openRentals.length, rows: openRentals };
      }
      if (sql.includes("UPDATE rig_rentals SET status = 'ENDED'")) return { rowCount: 1, rows: [] };
      if (sql.includes('rental_expires_at < CURRENT_TIMESTAMP')) {
        return { rowCount: expiredRigs.length, rows: expiredRigs };
      }
      if (sql.includes("SET maintenance_status = 'EXPIRED'")) return { rowCount: 1, rows: [] };
      if (sql.includes('INSERT INTO rig_hashrate_history')) return { rowCount: 1, rows: [] };
      throw new Error(`unexpected sql: ${sql}`);
    }),
    release: jest.fn(),
  };
  pool.connect.mockResolvedValue(client);
  return client;
}

afterEach(() => {
  process.env = { ...REAL_ENV };
  jest.clearAllMocks();
});

describe('rentalScheduler — expiry sweeper', () => {
  test('MRR list unavailable → still runs the expiry sweep (time-based, not MRR-dependent)', async () => {
    mrr.isLiveMode.mockReturnValue(true);
    mrr.makeMrrRequest.mockRejectedValue(new Error('MRR down'));
    const client = makeSchedulerClient({ expiredRigs: [EXPIRED_RIG] });

    await runSchedulerOnce();

    const expired = client.query.mock.calls.find(([sql]) => sql.includes("SET maintenance_status = 'EXPIRED'"));
    expect(expired).toBeTruthy();
    expect(expired[1][0]).toBe('rig-expired');
  });

  test('rig_rentals row whose MRR rental is gone → marked ENDED', async () => {
    mrr.isLiveMode.mockReturnValue(true);
    mrr.makeMrrRequest.mockResolvedValue({ data: { rentals: [] } }); // nothing active at MRR
    const client = makeSchedulerClient({
      openRentals: [{ id: 1, mrr_rental_id: '5697890', rig_id: 'rig-1' }],
    });

    await runSchedulerOnce();

    const ended = client.query.mock.calls.find(([sql]) => sql.includes("UPDATE rig_rentals SET status = 'ENDED'"));
    expect(ended).toBeTruthy();
    expect(ended[1][0]).toBe(1);
  });

  test('rental still active at MRR → rig_rentals row NOT marked ended', async () => {
    mrr.isLiveMode.mockReturnValue(true);
    mrr.makeMrrRequest.mockResolvedValue({ data: { rentals: [{ id: '5697890', ended: false }] } });
    const client = makeSchedulerClient({
      openRentals: [{ id: 1, mrr_rental_id: '5697890', rig_id: 'rig-1' }],
    });

    await runSchedulerOnce();

    const ended = client.query.mock.calls.find(([sql]) => sql.includes("UPDATE rig_rentals SET status = 'ENDED'"));
    expect(ended).toBeFalsy();
  });

  test('rig whose window passed → EXPIRED + 0-hashrate history row', async () => {
    mrr.isLiveMode.mockReturnValue(true);
    mrr.makeMrrRequest.mockResolvedValue({ data: { rentals: [] } });
    const client = makeSchedulerClient({ expiredRigs: [EXPIRED_RIG] });

    await runSchedulerOnce();

    const expired = client.query.mock.calls.find(([sql]) => sql.includes("SET maintenance_status = 'EXPIRED'"));
    expect(expired).toBeTruthy();
    expect(expired[1][0]).toBe('rig-expired');

    // The 0-hashrate row stops time-weighted payouts counting this rig.
    // hashrate 0 is a SQL literal in the INSERT — match the SQL text.
    const zero = client.query.mock.calls.find(
      ([sql, p]) =>
        sql.includes('INSERT INTO rig_hashrate_history') &&
        sql.includes(', 0)') &&
        p &&
        p[0] === 'user-1' &&
        p[1] === 'KASPA'
    );
    expect(zero).toBeTruthy();
  });

  test('no expired rigs → nothing to do, no history rows written', async () => {
    mrr.isLiveMode.mockReturnValue(true);
    mrr.makeMrrRequest.mockResolvedValue({ data: { rentals: [] } });
    const client = makeSchedulerClient();

    await runSchedulerOnce();

    const expired = client.query.mock.calls.find(([sql]) => sql.includes("SET maintenance_status = 'EXPIRED'"));
    expect(expired).toBeFalsy();
    const history = client.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO rig_hashrate_history'));
    expect(history).toHaveLength(0);
  });

  test('never places new rentals — the scheduler spends no money', async () => {
    mrr.isLiveMode.mockReturnValue(true);
    mrr.makeMrrRequest.mockResolvedValue({ data: { rentals: [] } });
    const client = makeSchedulerClient({ expiredRigs: [EXPIRED_RIG] });

    await runSchedulerOnce();

    expect(mrr.findAffordableRig).not.toHaveBeenCalled();
    const inserts = client.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO rig_rentals'));
    expect(inserts).toHaveLength(0);
    const walletCharges = client.query.mock.calls.filter(([sql]) => sql.includes('usdc_balance = usdc_balance -'));
    expect(walletCharges).toHaveLength(0);
  });
});
