/**
 * HYBRID session model tests (014_session_capacity, rewritten 2026-08-20):
 *  - distributePayout splits a pool payout by CREDIT hash-hours over REAL
 *    rig hash-hours (fair slices); the platform keeps the residual.
 *  - 95/5 on participant slices; NO maintenance deduction, NO DORMANT pause
 *  - reinvestRig converts mined tokens into the next rental window
 */

jest.mock('../config/db', () => ({
  pool: { connect: jest.fn(), query: jest.fn() },
}));
jest.mock('../services/priceOracle', () => ({
  getLiveBtcPrice: jest.fn(),
}));
jest.mock('../services/roomHash', () => ({
  fetchLiveRealHash: jest.fn(),
}));
jest.mock('../services/hashrateRenter', () => ({
  placeHashpowerOrder: jest.fn(),
  getOrderStatus: jest.fn(),
  POOL_ALGORITHM_MAP: { ZCASH: 'ZHASH', KASPA: 'KHEAVYHASH', LTC_DOGE: 'SCRYPT', XMR: 'RANDOMX' },
  PROVIDER_NAME: 'NICEHASH',
  LIVE_ORDERS_ENV: 'NICEHASH_LIVE_ORDERS',
}));
jest.mock('axios', () => ({ get: jest.fn() }));

const { pool } = require('../config/db');
const axios = require('axios');
const { fetchLiveRealHash } = require('../services/roomHash');
const { distributePayout, distributeMergedReward, distributeAccrued } = require('../services/rewardDistributor');
const { reinvestRig } = require('../controllers/upgradeController');
const { getLiveBtcPrice } = require('../services/priceOracle');
const { placeHashpowerOrder } = require('../services/hashrateRenter');

const REAL_ENV = { ...process.env };
const WALLET = '0x1111111111111111111111111111111111111111';

// The room's REAL hashrate (pool wallet measurement) — 25 GH/s credit is a
// slice of it: share = 25/195.5, NOT 25/25. The rest is platform residual.
const REAL_HASH = 195.5;

function makeRes() {
  const res = { statusCode: null, body: null };
  res.status = jest.fn((code) => { res.statusCode = code; return res; });
  res.json = jest.fn((obj) => { res.body = obj; return res; });
  return res;
}

afterEach(() => {
  process.env = { ...REAL_ENV };
  jest.clearAllMocks();
});

// ---- distributePayout: rental model (95/5, no maintenance) ----------------

function distributionClient({ price = 0.05, hasHistory = true } = {}) {
  const now = Date.now();
  const start = new Date(now - 24 * 3600 * 1000); // 24h period
  fetchLiveRealHash.mockResolvedValue(REAL_HASH);
  // LTC_DOGE path reads active rentals via pool.query BEFORE the tx.
  pool.query.mockResolvedValue({ rowCount: 0, rows: [] });
  const client = {
    query: jest.fn(async (sql, params = []) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 1, rows: [] };
      if (sql.includes('SELECT payout_timestamp FROM real_pool_payouts')) return { rowCount: 0, rows: [] };
      if (sql.includes('SELECT MIN(changed_at)')) return { rowCount: 0, rows: [] };
      if (sql.includes('INSERT INTO real_pool_payouts')) return { rowCount: 1, rows: [{ payout_id: 'payout-1' }] };
      if (sql.includes('SELECT changed_at, hashrate') && sql.includes('real_rig_hashrate_history')) {
        // Room was REALLY delivering 195.5 GH/s the whole period.
        return { rowCount: 1, rows: [{ changed_at: start, hashrate: REAL_HASH }] };
      }
      if (sql.includes('INSERT INTO real_rig_hashrate_history')) return { rowCount: 1, rows: [] };
      if (sql.includes('FROM rig_hashrate_history') && sql.includes('SELECT user_id, changed_at, hashrate')) {
        return hasHistory
          ? { rowCount: 1, rows: [{ user_id: 'user-1', changed_at: start, hashrate: '25.0000' }] }
          : { rowCount: 0, rows: [] };
      }
      if (sql.includes('SELECT user_id, virtual_hashrate FROM virtual_rigs')) return { rowCount: 0, rows: [] };
      if (sql.includes('INSERT INTO user_rewards_ledger')) return { rowCount: 1, rows: [] };
      if (sql.includes('INSERT INTO protocol_revenue_ledger')) return { rowCount: 1, rows: [] };
      if (sql.includes('INSERT INTO maintenance_fee_ledger')) return { rowCount: 1, rows: [] };
      if (sql.includes('UPDATE virtual_rigs')) return { rowCount: 1, rows: [] };
      if (sql.includes('UPDATE user_wallets')) return { rowCount: 1, rows: [] };
      if (sql.includes('INSERT INTO rig_hashrate_history')) return { rowCount: 1, rows: [] };
      if (sql.includes('UPDATE real_pool_payouts')) return { rowCount: 1, rows: [] };
      throw new Error(`unexpected sql: ${sql}`);
    }),
    release: jest.fn(),
  };
  pool.connect.mockResolvedValue(client);
  if (price != null) {
    axios.get.mockResolvedValue({ data: { kaspa: { usd: price } } });
  }
  return client;
}

describe('distributePayout — hybrid (fair slices over real hashrate)', () => {
  test('splits a payout by credit over REAL hash-hours; residual stays with the platform', async () => {
    const client = distributionClient({ price: 0.05 });
    // 25 GH/s credit x 24h = 600 hash-hours; the room REALLY delivered
    // 195.5 GH/s x 24h = 4692 real hash-hours.
    // share = 600/4692 = 12.788% of 100 KAS = 12.7877 gross -> fee 0.6394 -> net 12.1483.
    // Residual 87.2123 KAS is unsold gross capacity only. The 0.6394 KAS fee
    // is booked separately and must not be included in residual again.
    const result = await distributePayout('KASPA', 100, 1000);

    expect(result.payout_id).toBe('payout-1');
    expect(result.participants).toBe(1);
    expect(result.total_contribution).toBeCloseTo(4692, 3);
    expect(result.residual_coin).toBeCloseTo(87.2123, 3);

    const ledgerInsert = client.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO user_rewards_ledger'));
    expect(ledgerInsert).toBeTruthy();
    // params: [user, payout, net, fee, contrib, total, share]
    expect(Number(ledgerInsert[1][2])).toBeCloseTo(12.1483, 3);
    expect(Number(ledgerInsert[1][3])).toBeCloseTo(0.6394, 3);
    // maintenance_fee_1 is a SQL literal 0 in the rental model (no deduction).
    expect(ledgerInsert[0]).toContain(', 0)');

    // Fee and residual are typed coin rows converted at the same snapshot.
    const fee = client.query.mock.calls.find(
      ([sql, p]) => sql.includes('INSERT INTO protocol_revenue_ledger') && p?.[2] === 'MINING_REWARD_FEE'
    );
    expect(fee[1]).toEqual(expect.arrayContaining(['KAS', 0.05]));
    expect(Number(fee[1][1])).toBeCloseTo(0.6394 * 0.05, 4);

    const residual = client.query.mock.calls.find(
      ([sql, p]) => sql.includes('INSERT INTO protocol_revenue_ledger') && p?.[2] === 'UNSOLD_CAPACITY'
    );
    expect(residual).toBeTruthy();
    expect(residual[1]).toEqual(expect.arrayContaining(['KAS', 0.05]));
    expect(Number(residual[1][1])).toBeCloseTo(87.2123 * 0.05, 3);

    const bookedCoin = Number(fee[1][3]) + Number(residual[1][3]);
    expect(bookedCoin).toBeCloseTo(87.8517, 3);

    // No maintenance ledger rows in the rental model.
    const maintLedger = client.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO maintenance_fee_ledger'));
    expect(maintLedger).toBeFalsy();

    // No dormancy logic exists in the rental model.
    const dormancy = client.query.mock.calls.find(([sql]) => sql.includes("maintenance_status = 'DORMANT'"));
    expect(dormancy).toBeFalsy();
  });

  test('a tiny payout still nets the slice — no DORMANT, no maintenance eating the yield', async () => {
    const client = distributionClient({ price: 0.05 });
    // 1 KAS payout: net = 1 x (600/4692) x 0.95 = 0.1215.
    await distributePayout('KASPA', 1, 1000);

    const ledgerInsert = client.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO user_rewards_ledger'));
    expect(Number(ledgerInsert[1][2])).toBeCloseTo(0.1215, 3);
    expect(ledgerInsert[0]).toContain(', 0)');

    const dormancy = client.query.mock.calls.find(([sql]) => sql.includes("maintenance_status = 'DORMANT'"));
    expect(dormancy).toBeFalsy();
    // No 0-hashrate history row — the rig keeps mining until its window ends.
    const zero = client.query.mock.calls.find(
      ([sql, p]) => sql.includes('INSERT INTO rig_hashrate_history') && p && Number(p[2]) === 0
    );
    expect(zero).toBeFalsy();
  });

  test('price feed availability does not affect distribution — residual booked at 0 USDC', async () => {
    const client = distributionClient({ price: null });
    axios.get.mockRejectedValue(new Error('coingecko down'));

    await distributePayout('KASPA', 100, 1000);

    const ledgerInsert = client.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO user_rewards_ledger'));
    expect(Number(ledgerInsert[1][2])).toBeCloseTo(12.1483, 3); // net = gross - fee only
    expect(ledgerInsert[0]).toContain(', 0)');

    // Residual row still exists, typed in KAS with no price snapshot.
    const residual = client.query.mock.calls.find(
      ([sql, p]) => sql.includes('INSERT INTO protocol_revenue_ledger') && p?.[2] === 'UNSOLD_CAPACITY'
    );
    expect(residual).toBeTruthy();
    expect(residual[1]).toEqual(expect.arrayContaining(['KAS']));
    expect(Number(residual[1][1])).toBe(0);
    expect(residual[1][5]).toBeNull();
  });
});

// ---- distributePayout: multiple users (pro-rata) ---------------------------

describe('distributePayout — multiple renters pro-rata over real hashrate', () => {
  test('splits by time-weighted hashrate when two users rented', async () => {
    const now = Date.now();
    const start = new Date(now - 24 * 3600 * 1000);
    const client = distributionClient({ price: 0.05 });
    client.query.mockImplementation(async (sql, params = []) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 1, rows: [] };
      if (sql.includes('SELECT payout_timestamp FROM real_pool_payouts')) return { rowCount: 0, rows: [] };
      if (sql.includes('SELECT MIN(changed_at)')) return { rowCount: 0, rows: [] };
      if (sql.includes('INSERT INTO real_pool_payouts')) return { rowCount: 1, rows: [{ payout_id: 'payout-1' }] };
      if (sql.includes('SELECT changed_at, hashrate') && sql.includes('real_rig_hashrate_history')) {
        return { rowCount: 1, rows: [{ changed_at: start, hashrate: REAL_HASH }] };
      }
      if (sql.includes('INSERT INTO real_rig_hashrate_history')) return { rowCount: 1, rows: [] };
      if (sql.includes('FROM rig_hashrate_history') && sql.includes('SELECT user_id, changed_at, hashrate')) {
        return {
          rowCount: 2,
          rows: [
            { user_id: 'user-1', changed_at: start, hashrate: '25.0000' },
            { user_id: 'user-2', changed_at: start, hashrate: '75.0000' },
          ],
        };
      }
      if (sql.includes('SELECT user_id, virtual_hashrate FROM virtual_rigs')) return { rowCount: 0, rows: [] };
      if (sql.includes('INSERT INTO user_rewards_ledger')) return { rowCount: 1, rows: [] };
      if (sql.includes('INSERT INTO protocol_revenue_ledger')) return { rowCount: 1, rows: [] };
      if (sql.includes('INSERT INTO maintenance_fee_ledger')) return { rowCount: 1, rows: [] };
      if (sql.includes('UPDATE real_pool_payouts')) return { rowCount: 1, rows: [] };
      throw new Error(`unexpected sql: ${sql}`);
    });

    await distributePayout('KASPA', 100, 1000);

    const inserts = client.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO user_rewards_ledger'));
    // Real denominator 4692 hash-hours: user-1 = 600/4692 = 12.788% -> net 12.1483;
    // user-2 = 1800/4692 = 38.363% -> net 36.4449. Sum 48.593 (the platform
    // keeps the remaining 51.4% as residual).
    const user1 = inserts.find(([sql, p]) => p && p[0] === 'user-1');
    const user2 = inserts.find(([sql, p]) => p && p[0] === 'user-2');
    expect(Number(user1[1][2])).toBeCloseTo(12.1483, 3);
    expect(Number(user2[1][2])).toBeCloseTo(36.4449, 3);
  });
});

// ---- distributeMergedReward: DOGE side of LTC_DOGE (011) -------------------

describe('distributeMergedReward — merged DOGE distribution', () => {
  test('splits DOGE by credit over real hashrate; residual stays with the platform', async () => {
    const client = distributionClient({ price: null });
    axios.get.mockRejectedValue(new Error('doge feed down')); // fee not converted, distribution still runs
    const result = await distributeMergedReward('LTC_DOGE', 1000, 100000);

    expect(result.payout_id).toBe('payout-1');
    expect(result.participants).toBe(1);
    // 25 GH/s credit over 195.5 GH/s real = 12.788% of 1000 DOGE = 127.877
    // gross -> 6.394 fee -> 121.484 net (calculated_reward_2).
    const ledgerInsert = client.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO user_rewards_ledger'));
    expect(ledgerInsert).toBeTruthy();
    // params: [user, payout, reward_2 (net), fee, contrib, total, share]
    expect(Number(ledgerInsert[1][2])).toBeCloseTo(121.4834, 3);
    expect(Number(ledgerInsert[1][3])).toBeCloseTo(6.3939, 3);

    // No maintenance fee rows (cost anchor stays on the LTC side).
    const maintRows = client.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO maintenance_fee_ledger'));
    expect(maintRows).toHaveLength(0);
    // No dormancy (dormancy is driven by the base coin's payouts).
    const dormant = client.query.mock.calls.find(([sql]) => sql.includes("maintenance_status = 'DORMANT'"));
    expect(dormant).toBeFalsy();
  });

  test('books the 5% fee and residual in USDC when the DOGE price is available', async () => {
    const client = distributionClient({ price: null });
    axios.get.mockResolvedValue({ data: { dogecoin: { usd: 0.1 } } });
    await distributeMergedReward('LTC_DOGE', 1000, 100000);

    // First positive protocol row = the per-user 5% fee (6.394 DOGE x $0.10).
    const fee = client.query.mock.calls.find(
      ([sql, p]) => sql.includes('INSERT INTO protocol_revenue_ledger') && p && p[0] !== null && Number(p[1]) > 0
    );
    expect(fee).toBeTruthy();
    expect(Number(fee[1][1])).toBeCloseTo(0.6394, 3); // 6.394 DOGE × $0.10

    // Residual excludes the separately booked fee: 872.123 DOGE at $0.10.
    const residual = client.query.mock.calls.find(
      ([sql, p]) => sql.includes('INSERT INTO protocol_revenue_ledger') && p?.[2] === 'UNSOLD_CAPACITY'
    );
    expect(residual).toBeTruthy();
    expect(residual[1]).toEqual(expect.arrayContaining(['DOGE', 0.1]));
    expect(Number(residual[1][1])).toBeCloseTo(87.2123, 3);
  });
});

// ---- distributeAccrued: daily in-game payouts (016, 2026-08-20) -----------

describe('distributeAccrued — daily accrual payouts (016)', () => {
  function accrualClient({ unpaidNow = 1.7, earnedLast = 1.5 } = {}) {
    const now = Date.now();
    const start = new Date(now - 6 * 3600 * 1000); // 6h since last run
    fetchLiveRealHash.mockResolvedValue(REAL_HASH);
    pool.query.mockResolvedValue({ rowCount: 0, rows: [] });
    const client = {
      query: jest.fn(async (sql, params = []) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 1, rows: [] };
        if (sql.includes('FROM room_accrual WHERE pool = $1 FOR UPDATE')) {
          return { rowCount: 1, rows: [{ earned_total: String(earnedLast), last_distributed_at: start }] };
        }
        if (sql.includes('SELECT last_balance FROM payout_watch')) {
          return { rowCount: 1, rows: [{ last_balance: String(unpaidNow) }] };
        }
        if (sql.includes('FROM real_pool_payouts') && sql.includes('source')) {
          return { rowCount: 1, rows: [{ paid: '0' }] };
        }
        if (sql.includes('INSERT INTO real_pool_payouts')) return { rowCount: 1, rows: [{ payout_id: 'payout-accrual' }] };
        if (sql.includes('INSERT INTO real_rig_hashrate_history')) return { rowCount: 1, rows: [] };
        if (sql.includes('SELECT changed_at, hashrate') && sql.includes('real_rig_hashrate_history')) {
          return { rowCount: 1, rows: [{ changed_at: start, hashrate: REAL_HASH }] };
        }
        if (sql.includes('FROM rig_hashrate_history') && sql.includes('SELECT user_id, changed_at, hashrate')) {
          return { rowCount: 1, rows: [{ user_id: 'user-1', changed_at: start, hashrate: '25.0000' }] };
        }
        if (sql.includes('SELECT user_id, virtual_hashrate FROM virtual_rigs')) return { rowCount: 0, rows: [] };
        if (sql.includes('INSERT INTO user_rewards_ledger')) return { rowCount: 1, rows: [] };
        if (sql.includes('INSERT INTO protocol_revenue_ledger')) return { rowCount: 1, rows: [] };
        if (sql.includes('UPDATE room_accrual')) return { rowCount: 1, rows: [] };
        if (sql.includes('UPDATE real_pool_payouts')) return { rowCount: 1, rows: [] };
        throw new Error(`unexpected accrual sql: ${sql}`);
      }),
      release: jest.fn(),
    };
    pool.connect.mockResolvedValue(client);
    return client;
  }

  test('distributes ONLY the new accrued production (delta), not the whole balance', async () => {
    const client = accrualClient({ unpaidNow: 1.7, earnedLast: 1.5 });
    const result = await distributeAccrued('KASPA');

    expect(result.status).toBe('distributed');
    expect(result.delta).toBeCloseTo(0.2, 6);

    // Payout row is an ACCRUAL source (never counts toward the E basis).
    const payoutInsert = client.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO real_pool_payouts'));
    expect(payoutInsert[0]).toContain("'ACCRUAL'");
    expect(Number(payoutInsert[1][1])).toBeCloseTo(0.2, 6);

    // User credited their slice of the 0.2 delta: 25 GH/s x 6h over real
    // 195.5 x 6h = 12.79% of 0.2 = 0.02558 gross -> net 0.02430.
    const ledger = client.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO user_rewards_ledger'));
    expect(Number(ledger[1][2])).toBeCloseTo(0.0243, 4);

    // State advanced so the NEXT run distributes from the new baseline.
    const stateUpdate = client.query.mock.calls.find(([sql]) => sql.includes('UPDATE room_accrual'));
    expect(Number(stateUpdate[1][0])).toBeCloseTo(1.7, 6);
  });

  test('no new accrual -> no distribution, state untouched', async () => {
    const client = accrualClient({ unpaidNow: 1.5, earnedLast: 1.5 });
    const result = await distributeAccrued('KASPA');
    expect(result.status).toBe('no-change');
    const inserts = client.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO user_rewards_ledger'));
    expect(inserts).toHaveLength(0);
  });

  test('fresh install (no room_accrual row) -> seeds the baseline and distributes nothing yet', async () => {
    const now = Date.now();
    const client = accrualClient({ unpaidNow: 1.7, earnedLast: 1.5 });
    client.query.mockImplementation(async (sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 1, rows: [] };
      if (sql.includes('FROM room_accrual WHERE pool = $1 FOR UPDATE')) return { rowCount: 0, rows: [] };
      if (sql.includes('SELECT last_balance FROM payout_watch')) return { rowCount: 1, rows: [{ last_balance: '1.7' }] };
      if (sql.includes('FROM real_pool_payouts') && sql.includes('source')) return { rowCount: 1, rows: [{ paid: '0' }] };
      if (sql.includes('INSERT INTO room_accrual')) return { rowCount: 1, rows: [] };
      throw new Error(`unexpected sql: ${sql}`);
    });
    const result = await distributeAccrued('KASPA');
    expect(result.status).toBe('seeded');
    expect(Number(result.earned_total)).toBeCloseTo(1.7, 6);
    // No user rows yet — the NEXT run distributes the delta.
    const seed = client.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO room_accrual'));
    expect(seed).toBeTruthy();
  });
});

// ---- reinvestRig: mined tokens → next rental window -----------------------

describe('reinvestRig — mined tokens fund the next rental', () => {
  function reinvestClient({ hasRig = true, coins = 0 } = {}) {
    const client = {
      query: jest.fn(async (sql, params = []) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 1, rows: [] };
        if (sql.includes('SELECT user_id FROM users')) return { rowCount: 1, rows: [{ user_id: 'user-1' }] };
        if (sql.includes('SELECT wallet_id FROM user_wallets')) return { rowCount: 1, rows: [{ wallet_id: 'wallet-1' }] };
        if (sql.includes('SELECT level FROM virtual_rigs')) {
          return hasRig
            ? { rowCount: 1, rows: [{ level: 2 }] }
            : { rowCount: 0, rows: [] };
        }
        if (sql.includes('SELECT COUNT(*) AS c FROM virtual_rigs')) {
          return { rowCount: 1, rows: [{ c: String(coins) }] };
        }
        // claimPoolRewardsInTx: SELECT l.ledger_id, l.calculated_reward_1...
        if (sql.includes('SELECT l.ledger_id, l.calculated_reward_1')) {
          return { rowCount: 0, rows: [] };
        }
        if (sql.includes('UPDATE user_rewards_ledger') && sql.includes("status = 'CLAIMED'")) {
          return { rowCount: 0, rows: [] };
        }
        if (sql.includes('INSERT INTO deposit_history')) return { rowCount: 1, rows: [] };
        throw new Error(`unexpected reinvest sql: ${sql}`);
      }),
      release: jest.fn(),
    };
    pool.connect.mockResolvedValue(client);
    return client;
  }

  test('rejects invalid wallet', async () => {
    const res = makeRes();
    await reinvestRig({ auth: { wallet: 'nope' }, body: { target_pool: 'KASPA', request_id: 'req-1' } }, res);
    expect(res.statusCode).toBe(400);
  });

  test('rejects unknown pool', async () => {
    const res = makeRes();
    await reinvestRig({ auth: { wallet: WALLET }, body: { target_pool: 'DOGE', request_id: 'req-1' } }, res);
    expect(res.statusCode).toBe(400);
  });

  test('no mined tokens → 400 with a clear message', async () => {
    const client = reinvestClient();
    axios.get.mockResolvedValue({ data: { kaspa: { usd: 0.05 } } });
    client.query.mockImplementation(async (sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 1, rows: [] };
      if (sql.includes('SELECT user_id FROM users')) return { rowCount: 1, rows: [{ user_id: 'user-1' }] };
      if (sql.includes('SELECT wallet_id FROM user_wallets')) return { rowCount: 1, rows: [{ wallet_id: 'wallet-1' }] };
      if (sql.includes('SELECT level FROM virtual_rigs')) return { rowCount: 1, rows: [{ level: 2 }] };
      // No unclaimed mined tokens -> claim returns 0 -> reinvest refuses.
      if (sql.includes('SELECT l.ledger_id, l.calculated_reward_1')) return { rowCount: 0, rows: [] };
      if (sql.includes('SELECT COUNT(*) AS c FROM virtual_rigs')) return { rowCount: 1, rows: [{ c: '1' }] };
      throw new Error(`unexpected sql: ${sql}`);
    });
    const res = makeRes();
    await reinvestRig({ auth: { wallet: WALLET }, body: { target_pool: 'KASPA', request_id: 'req-empty' } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/No mined KASPA tokens/);
  });
});
