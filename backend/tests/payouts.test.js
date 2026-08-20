const { computeContributions } = require('../services/rigHistory');

// ---- computeContributions: the proportionality core -----------------------

describe('computeContributions (time-weighted hashrate)', () => {
  const start = new Date('2026-08-19T00:00:00Z');
  const end = new Date('2026-08-19T24:00:00Z'); // 24h period

  test('full period at constant hashrate = hashrate x hours', () => {
    const hist = [{ changed_at: start, hashrate: 25 }];
    expect(computeContributions(hist, start, end)).toBeCloseTo(25 * 24, 6);
  });

  test('mid-period upgrade: each segment contributes its own hashrate x duration', () => {
    const hist = [
      { changed_at: new Date('2026-08-19T00:00:00Z'), hashrate: 25 }, // 0-12h
      { changed_at: new Date('2026-08-19T12:00:00Z'), hashrate: 60 }, // 12-24h
    ];
    expect(computeContributions(hist, start, end)).toBeCloseTo(25 * 12 + 60 * 12, 6);
  });

  test('buy-in mid-period only counts from the buy time (starts when they buy in)', () => {
    const hist = [{ changed_at: new Date('2026-08-19T08:00:00Z'), hashrate: 60 }];
    // 16 hours of 60 = 960
    expect(computeContributions(hist, start, end)).toBeCloseTo(60 * 16, 6);
  });

  test('period boundaries clamp partial segments', () => {
    const hist = [
      { changed_at: new Date('2026-08-18T20:00:00Z'), hashrate: 10 }, // starts before period
      { changed_at: new Date('2026-08-19T20:00:00Z'), hashrate: 50 }, // ends after period start...
    ];
    // 10 from 00:00-20:00 (20h) + 50 from 20:00-24:00 (4h) = 200 + 200 = 400
    expect(computeContributions(hist, start, end)).toBeCloseTo(10 * 20 + 50 * 4, 6);
  });

  test('rig deleted mid-period stops contributing after deletion', () => {
    const hist = [
      { changed_at: new Date('2026-08-19T00:00:00Z'), hashrate: 40 }, // 0-6h
      { changed_at: new Date('2026-08-19T06:00:00Z'), hashrate: 0 },  // deleted
    ];
    expect(computeContributions(hist, start, end)).toBeCloseTo(40 * 6, 6);
  });

  test('empty history or invalid period contributes zero', () => {
    expect(computeContributions([], start, end)).toBe(0);
    expect(computeContributions([{ changed_at: start, hashrate: 25 }], end, start)).toBe(0);
    expect(computeContributions(null, start, end)).toBe(0);
  });
});

// ---- claim flow (controller with mocked db + mocked coingecko) ------------

jest.mock('../config/db', () => ({
  pool: { connect: jest.fn(), query: jest.fn() },
}));
jest.mock('axios', () => ({
  get: jest.fn(),
}));

const { pool } = require('../config/db');
const axios = require('axios');
const {
  claimRewards,
  withdrawRewards,
  markWithdrawalPaid,
  rejectWithdrawal,
  getRewards,
} = require('../controllers/rewardsController');

const REAL_ENV = { ...process.env };
const WALLET = '0x1111111111111111111111111111111111111111';

function makeClient({ balance = 100, pendingRows = 0, withdrawal = true } = {}) {
  const client = {
    query: jest.fn(async (sql, params = []) => {
      if (sql.includes('SELECT user_id FROM users')) {
        return { rowCount: 1, rows: [{ user_id: 'user-1' }] };
      }
      if (sql.includes('SELECT wallet_id')) {
        return { rowCount: 1, rows: [{ wallet_id: 'wallet-1', usdc_balance: balance }] };
      }
      if (sql.includes("l.status = 'UNCLAIMED'")) {
        const rows = [];
        for (let i = 0; i < pendingRows; i++) {
          rows.push({ ledger_id: `ledger-${i}`, calculated_reward_1: '1.00000000', target_pool: 'ZCASH' });
        }
        return { rowCount: rows.length, rows };
      }
      if (sql.includes('UPDATE user_rewards_ledger')) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('UPDATE user_wallets SET usdc_balance = usdc_balance +')) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('UPDATE user_wallets SET usdc_balance = usdc_balance -')) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('INSERT INTO withdrawal_requests')) {
        return { rowCount: 1, rows: [{ withdrawal_id: 'withdraw-1' }] };
      }
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`unexpected sql: ${sql}`);
    }),
    release: jest.fn(),
  };
  pool.connect.mockResolvedValue(client);
  return client;
}

// pool.query handles the pre-tx lookups: user + distinct pending pools.
function mockPoolQueries({ userExists = true, pendingPools = ['ZCASH'] } = {}) {
  pool.query
    .mockResolvedValueOnce(userExists ? { rowCount: 1, rows: [{ user_id: 'user-1' }] } : { rowCount: 0, rows: [] })
    .mockResolvedValueOnce({ rowCount: pendingPools.length, rows: pendingPools.map((p) => ({ target_pool: p })) });
}

function mockPrice(price) {
  axios.get.mockResolvedValue({ data: { zcash: { usd: price } } });
}

afterEach(() => {
  process.env = { ...REAL_ENV };
  jest.clearAllMocks();
});

function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = jest.fn((code) => {
    res.statusCode = code;
    return res;
  });
  res.json = jest.fn((body) => {
    res.body = body;
    return res;
  });
  return res;
}

describe('claimRewards', () => {
  test('claims UNCLAIMED rows at live price and credits the wallet balance', async () => {
    const client = makeClient({ pendingRows: 2 }); // 2 x 1.0 ZEC
    mockPoolQueries(); // user + pending pools = ['ZCASH']
    mockPrice(50); // $50/ZEC → each row = $50, total $100
    const res = makeRes();
    await claimRewards({ auth: { wallet: WALLET }, body: {} }, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, claimed_usdc: 100, rows: 2, pools: ['ZCASH'] })
    );
    // balance credit query ran with +100
    const credit = client.query.mock.calls.find(([sql]) => sql.includes('usdc_balance = usdc_balance +'));
    expect(credit).toBeTruthy();
    expect(credit[1][0]).toBe(100);
    // every ledger row marked CLAIMED
    const updates = client.query.mock.calls.filter(([sql]) => sql.includes('SET status'));
    expect(updates.length).toBe(2);
  });

  test('nothing to claim returns 0 without touching the wallet', async () => {
    makeClient({ pendingRows: 0 });
    mockPoolQueries({ pendingPools: [] });
    mockPrice(50);
    const res = makeRes();
    await claimRewards({ auth: { wallet: WALLET }, body: {} }, res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, claimed_usdc: 0 }));
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test('refuses when the price oracle is unavailable', async () => {
    makeClient({ pendingRows: 1 });
    mockPoolQueries();
    axios.get.mockRejectedValue(new Error('coingecko down'));
    const res = makeRes();
    await claimRewards({ auth: { wallet: WALLET }, body: {} }, res);
    expect(res.status).toHaveBeenCalledWith(502);
  });

  test('rejects invalid wallet format', async () => {
    const res = makeRes();
    await claimRewards({ auth: { wallet: 'not-a-wallet' }, body: {} }, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('withdrawRewards', () => {
  function withdrawClient({ rewards = [5] } = {}) {
    const state = {
      rows: rewards.map((amount, index) => ({
        ledger_id: `ledger-${index + 1}`,
        calculated_reward_1: Number(amount),
        status: 'UNCLAIMED',
        withdrawal_id: null,
      })),
      allocations: [],
      requests: [],
    };
    const client = {
      query: jest.fn(async (sql, params = []) => {
        if (sql.includes('SELECT user_id FROM users')) {
          return { rowCount: 1, rows: [{ user_id: 'user-1' }] };
        }
        if (sql.includes("l.status = 'UNCLAIMED' AND l.withdrawal_id IS NULL")) {
          const rows = state.rows
            .filter((row) => row.status === 'UNCLAIMED' && row.withdrawal_id === null)
            .map((row) => ({ ...row, calculated_reward_1: String(row.calculated_reward_1) }));
          return { rowCount: rows.length, rows };
        }
        if (sql.includes('INSERT INTO withdrawal_requests')) {
          const withdrawal_id = `withdraw-${state.requests.length + 1}`;
          state.requests.push({ withdrawal_id, status: 'PENDING' });
          return { rowCount: 1, rows: [{ withdrawal_id }] };
        }
        if (sql.includes('INSERT INTO withdrawal_allocations')) {
          state.allocations.push({
            withdrawal_id: params[0],
            ledger_id: params[1],
            amount_coin: Number(params[2]),
          });
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes('UPDATE user_rewards_ledger SET withdrawal_id')) {
          const row = state.rows.find((candidate) => candidate.ledger_id === params[1]);
          row.withdrawal_id = params[0];
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes("SET status = 'PAID', tx_hash")) {
          const request = state.requests.find((candidate) => candidate.withdrawal_id === params[0] && candidate.status === 'PENDING');
          if (!request) return { rowCount: 0, rows: [] };
          request.status = 'PAID';
          return { rowCount: 1, rows: [{ withdrawal_id: request.withdrawal_id }] };
        }
        if (sql.includes('FROM withdrawal_allocations') && sql.includes('FOR UPDATE')) {
          const rows = state.allocations
            .filter((allocation) => allocation.withdrawal_id === params[0])
            .map((allocation) => ({
              ...allocation,
              calculated_reward_1: String(state.rows.find((row) => row.ledger_id === allocation.ledger_id).calculated_reward_1),
            }));
          return { rowCount: rows.length, rows };
        }
        if (sql.includes("SET status = 'PAID'") && sql.includes('ledger_id = $1')) {
          const row = state.rows.find((candidate) => candidate.ledger_id === params[0]);
          row.status = 'PAID';
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes('calculated_reward_1 = calculated_reward_1 - $2')) {
          const row = state.rows.find((candidate) => candidate.ledger_id === params[0]);
          row.calculated_reward_1 -= Number(params[1]);
          row.withdrawal_id = null;
          row.status = 'UNCLAIMED';
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes('withdrawal_id = NULL')) {
          state.rows.filter((row) => row.withdrawal_id === params[0]).forEach((row) => { row.withdrawal_id = null; });
          return { rowCount: 1, rows: [] };
        }
        // Reproduces the old broken blanket payment behavior until the
        // allocation-aware implementation replaces it.
        if (sql.includes("SET status = 'PAID'") && sql.includes('withdrawal_id = $1')) {
          state.rows.filter((row) => row.withdrawal_id === params[0]).forEach((row) => { row.status = 'PAID'; });
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes("SET status = 'REJECTED'")) {
          const request = state.requests.find((candidate) => candidate.withdrawal_id === params[0] && candidate.status === 'PENDING');
          if (!request) return { rowCount: 0, rows: [] };
          request.status = 'REJECTED';
          return { rowCount: 1, rows: [{ withdrawal_id: request.withdrawal_id }] };
        }
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return { rowCount: 1, rows: [] };
        }
        throw new Error(`unexpected sql: ${sql}`);
      }),
      release: jest.fn(),
    };
    pool.connect.mockResolvedValue(client);
    return { client, state };
  }

  async function requestWithdrawal(amount, res = makeRes()) {
    await withdrawRewards({
      auth: { wallet: WALLET },
      body: { target_pool: 'ZCASH', amount_coin: amount, to_address: 't1V5oarvihbomZswPw381AowjPpGj1t2B3K' },
    }, res);
    return res;
  }

  test('full-row withdrawal records the exact allocation and marks the row paid', async () => {
    const { state } = withdrawClient({ rewards: [5] });
    const res = makeRes();
    await requestWithdrawal(5, res);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, withdrawal_id: 'withdraw-1', target_pool: 'ZCASH', amount_coin: 5, status: 'PENDING' })
    );
    expect(state.allocations).toEqual([
      { withdrawal_id: 'withdraw-1', ledger_id: 'ledger-1', amount_coin: 5 },
    ]);

    const paid = makeRes();
    await markWithdrawalPaid({ params: { id: 'withdraw-1' }, body: { tx_hash: 'coin-tx-1' } }, paid);
    expect(paid.statusCode).toBe(200);
    expect(state.rows[0]).toEqual(expect.objectContaining({ status: 'PAID', calculated_reward_1: 5 }));
  });

  test('partial withdrawal leaves the unwithdrawn remainder claimable after payment', async () => {
    const { state } = withdrawClient({ rewards: [2, 5] });
    await requestWithdrawal(3);
    expect(state.allocations).toEqual([
      { withdrawal_id: 'withdraw-1', ledger_id: 'ledger-1', amount_coin: 2 },
      { withdrawal_id: 'withdraw-1', ledger_id: 'ledger-2', amount_coin: 1 },
    ]);

    const paid = makeRes();
    await markWithdrawalPaid({ params: { id: 'withdraw-1' }, body: { tx_hash: 'coin-tx-2' } }, paid);
    expect(paid.statusCode).toBe(200);
    expect(state.rows[0]).toEqual(expect.objectContaining({ status: 'PAID', calculated_reward_1: 2 }));
    expect(state.rows[1]).toEqual(expect.objectContaining({
      status: 'UNCLAIMED',
      calculated_reward_1: 4,
      withdrawal_id: null,
    }));
  });

  test('rejecting a partial withdrawal releases the original full reward', async () => {
    const { state } = withdrawClient({ rewards: [2, 5] });
    await requestWithdrawal(3);

    const rejected = makeRes();
    await rejectWithdrawal({ params: { id: 'withdraw-1' }, body: {} }, rejected);
    expect(rejected.statusCode).toBe(200);
    expect(state.rows[0]).toEqual(expect.objectContaining({
      status: 'UNCLAIMED',
      calculated_reward_1: 2,
      withdrawal_id: null,
    }));
    expect(state.rows[1]).toEqual(expect.objectContaining({
      status: 'UNCLAIMED',
      calculated_reward_1: 5,
      withdrawal_id: null,
    }));
    expect(state.allocations).toHaveLength(2);
  });

  test('a held ledger row cannot fund a second concurrent withdrawal', async () => {
    const { state } = withdrawClient({ rewards: [5] });
    await requestWithdrawal(2);
    const second = await requestWithdrawal(1);

    expect(second.statusCode).toBe(400);
    expect(state.requests).toHaveLength(1);
    expect(state.allocations).toHaveLength(1);
  });

  test('rejects withdrawals exceeding unclaimed rewards', async () => {
    withdrawClient({ rewards: [1] });
    const res = makeRes();
    await withdrawRewards({
      auth: { wallet: WALLET },
      body: { target_pool: 'ZCASH', amount_coin: 5, to_address: 't1V5oarvihbomZswPw381AowjPpGj1t2B3K' },
    }, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('rejects invalid destination addresses for the coin', async () => {
    withdrawClient({ rewards: [5] });
    const res = makeRes();
    // ZEC addresses must start t1... — a 0x EVM address is not valid ZEC.
    await withdrawRewards({
      auth: { wallet: WALLET },
      body: { target_pool: 'ZCASH', amount_coin: 1, to_address: '0x2222222222222222222222222222222222222222' },
    }, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('rejects unknown target pools', async () => {
    const res = makeRes();
    await withdrawRewards({
      auth: { wallet: WALLET },
      body: { target_pool: 'DOGE', amount_coin: 1, to_address: 'DLB4xWPeFU9mXjLTJUJcQhNZX6pWPYv8VW' },
    }, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('getRewards', () => {
  test('returns empty rewards for a wallet with no account', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const res = makeRes();
    await getRewards({ auth: { wallet: WALLET }, query: { wallet: '0x2222222222222222222222222222222222222222' } }, res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ rewards: [] }));
  });
});
