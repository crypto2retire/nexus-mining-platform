/**
 * GoMiner model tests (008_gominer_model):
 *  - distributePayout deducts per-GH/s maintenance from each payout
 *  - a payout that can't cover maintenance → miner DORMANT + 0 hashrate
 *  - reinvestRig converts mined tokens into the next upgrade
 */

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
jest.mock('axios', () => ({ get: jest.fn() }));

const { pool } = require('../config/db');
const axios = require('axios');
const { distributePayout, distributeMergedReward } = require('../services/rewardDistributor');
const { reinvestRig, setMineAtLoss } = require('../controllers/upgradeController');
const { getLiveBtcPrice } = require('../services/priceOracle');
const { placeHashpowerOrder } = require('../services/hashrateRenter');

const REAL_ENV = { ...process.env };
const WALLET = '0x1111111111111111111111111111111111111111';

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

// ---- distributePayout: maintenance deduction + dormancy -------------------

function distributionClient({ rate = 0.006, price = 0.05, hasHistory = true, mineAtLoss = false, usdcBalance = '10.0000', coins = 0 } = {}) {
  const now = Date.now();
  const start = new Date(now - 24 * 3600 * 1000); // 24h period
  const client = {
    query: jest.fn(async (sql, params = []) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 1, rows: [] };
      if (sql.includes('SELECT payout_timestamp FROM real_pool_payouts')) return { rowCount: 0, rows: [] };
      if (sql.includes('SELECT MIN(changed_at)')) return { rowCount: 0, rows: [] };
      if (sql.includes('INSERT INTO real_pool_payouts')) return { rowCount: 1, rows: [{ payout_id: 'payout-1' }] };
      if (sql.includes('FROM rig_hashrate_history') && sql.includes('SELECT user_id, changed_at, hashrate')) {
        return hasHistory
          ? { rowCount: 1, rows: [{ user_id: 'user-1', changed_at: start, hashrate: '25.0000' }] }
          : { rowCount: 0, rows: [] };
      }
      if (sql.includes('SELECT user_id, virtual_hashrate FROM virtual_rigs')) return { rowCount: 0, rows: [] };
      if (sql.includes('SELECT COUNT(*) AS c FROM virtual_rigs')) {
        return { rowCount: 1, rows: [{ c: String(coins) }] };
      }
      if (sql.includes('SELECT usdc_per_ghs_per_day FROM pool_maintenance_rates')) {
        return { rowCount: 1, rows: [{ usdc_per_ghs_per_day: String(rate) }] };
      }
      if (sql.includes('SELECT mine_at_loss FROM virtual_rigs')) {
        return { rowCount: 1, rows: [{ mine_at_loss: mineAtLoss }] };
      }
      if (sql.includes('SELECT wallet_id, usdc_balance FROM user_wallets')) {
        return { rowCount: 1, rows: [{ wallet_id: 'wallet-1', usdc_balance: String(usdcBalance) }] };
      }
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

describe('distributePayout — GoMiner maintenance', () => {
  test('deducts maintenance per GH/s/day from gross, books ledger, stays ACTIVE', async () => {
    const client = distributionClient({ rate: 0.006, price: 0.05 });
    // 25 GH/s for 24h → 600 hashrate-hours, avg 25 GH/s, 1 day.
    // maintenance = 25 × 0.006 × 1 = $0.15 → /0.05 = 3.0 KAS.
    // gross 100 KAS, fee 5, maintenance 3 → net 92.
    const result = await distributePayout('KASPA', 100, 1000);

    expect(result.payout_id).toBe('payout-1');
    expect(result.participants).toBe(1);

    const ledgerInsert = client.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO user_rewards_ledger'));
    expect(ledgerInsert).toBeTruthy();
    // params: [user, payout, net, fee, contrib, total, share, maintenance]
    expect(ledgerInsert[1][2]).toBeCloseTo(92, 6);
    expect(ledgerInsert[1][3]).toBeCloseTo(5, 6);
    expect(ledgerInsert[1][7]).toBeCloseTo(3, 6);

    const maintLedger = client.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO maintenance_fee_ledger'));
    expect(maintLedger).toBeTruthy();
    expect(Number(maintLedger[1][5])).toBeCloseTo(0.15, 6); // amount_usdc

    // No dormancy for a profitable miner.
    const dormancy = client.query.mock.calls.find(([sql]) => sql.includes("maintenance_status = 'DORMANT'"));
    expect(dormancy).toBeFalsy();
  });

  test('payout that cannot cover maintenance → DORMANT + zero hashrate (GoMiner pause)', async () => {
    const client = distributionClient({ rate: 0.006, price: 0.05 });
    // Same 25 GH/s × 1 day → maintenance 3.0 KAS, but the payout is only 1 KAS.
    // gross 1, fee 0.05 → remaining 0.95 → net 0, shortfall → DORMANT.
    await distributePayout('KASPA', 1, 1000);

    const ledgerInsert = client.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO user_rewards_ledger'));
    expect(Number(ledgerInsert[1][2])).toBeCloseTo(0, 6); // net clamped at 0
    expect(Number(ledgerInsert[1][7])).toBeCloseTo(0.95, 6); // maintenance ate everything available

    const dormancy = client.query.mock.calls.find(([sql]) => sql.includes("maintenance_status = 'DORMANT'"));
    expect(dormancy).toBeTruthy();
    expect(dormancy[1][0]).toBe('user-1');
    expect(dormancy[1][1]).toBe('KASPA');

    // A 0-hashrate history row stops the miner earning future shares
    // (VALUES ($1,$2,0) — the zero is a literal).
    const zero = client.query.mock.calls.find(
      ([sql]) => sql.includes('INSERT INTO rig_hashrate_history') && /VALUES \(\$1, \$2, 0\)/.test(sql)
    );
    expect(zero).toBeTruthy();
  });

  test('price feed down → still distributes, skips maintenance, no dormancy', async () => {
    const client = distributionClient({ rate: 0.006, price: null });
    axios.get.mockRejectedValue(new Error('coingecko down'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await distributePayout('KASPA', 100, 1000);

    const ledgerInsert = client.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO user_rewards_ledger'));
    expect(Number(ledgerInsert[1][2])).toBeCloseTo(95, 6); // net = gross - fee only
    expect(Number(ledgerInsert[1][7])).toBe(0); // no maintenance charged
    const dormancy = client.query.mock.calls.find(([sql]) => sql.includes("maintenance_status = 'DORMANT'"));
    expect(dormancy).toBeFalsy();
    warn.mockRestore();
  });
});

// ---- distributePayout: multi-coin maintenance discount --------------------

describe('distributePayout — multi-coin discount', () => {
  test('2 coins → 5% lower maintenance (lower ongoing cost)', async () => {
    const client = distributionClient({ rate: 0.006, price: 0.05, coins: 2 });
    // 25 GH/s × 1 day → maintenance 3 KAS full, 2.85 KAS with 5% off.
    await distributePayout('KASPA', 100, 1000);

    const ledgerInsert = client.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO user_rewards_ledger'));
    expect(Number(ledgerInsert[1][7])).toBeCloseTo(2.85, 6); // maintenance 5% off
    expect(Number(ledgerInsert[1][2])).toBeCloseTo(92.15, 6); // net = 95 - 2.85

    const maintLedger = client.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO maintenance_fee_ledger'));
    expect(Number(maintLedger[1][5])).toBeCloseTo(0.1425, 6); // 2.85 × $0.05
  });

  test('4 coins → 15% off maintenance; no discount at 0-1 coins', async () => {
    const client4 = distributionClient({ rate: 0.006, price: 0.05, coins: 4 });
    await distributePayout('KASPA', 100, 1000);
    const ledger4 = client4.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO user_rewards_ledger'));
    expect(Number(ledger4[1][7])).toBeCloseTo(2.55, 6); // 3 × 0.85

    const client0 = distributionClient({ rate: 0.006, price: 0.05, coins: 0 });
    await distributePayout('KASPA', 100, 1000);
    const ledger0 = client0.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO user_rewards_ledger'));
    expect(Number(ledger0[1][7])).toBeCloseTo(3, 6); // full maintenance
  });
});

// ---- distributeMergedReward: DOGE side of LTC_DOGE (011) -------------------

describe('distributeMergedReward — merged DOGE distribution', () => {
  test('splits DOGE pro-rata 95/5 into calculated_reward_2, no maintenance, no dormancy', async () => {
    const client = distributionClient({ price: null });
    axios.get.mockRejectedValue(new Error('doge feed down')); // fee not converted, distribution still runs
    const result = await distributeMergedReward('LTC_DOGE', 1000, 100000);

    expect(result.payout_id).toBe('payout-1');
    expect(result.participants).toBe(1);

    const ledgerInsert = client.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO user_rewards_ledger'));
    expect(ledgerInsert).toBeTruthy();
    // params: [user, payout, reward_2 (net), fee, contrib, total, share]
    expect(Number(ledgerInsert[1][2])).toBeCloseTo(950, 6); // 95% of 1000 DOGE
    expect(Number(ledgerInsert[1][3])).toBeCloseTo(50, 6); // 5% fee

    // No maintenance fee rows (cost anchor stays on the LTC side).
    const maintRows = client.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO maintenance_fee_ledger'));
    expect(maintRows).toHaveLength(0);
    // No dormancy (dormancy is driven by the base coin's payouts).
    const dormant = client.query.mock.calls.find(([sql]) => sql.includes("maintenance_status = 'DORMANT'"));
    expect(dormant).toBeFalsy();
  });

  test('books the 5% fee in USDC when the DOGE price is available', async () => {
    const client = distributionClient({ price: null });
    axios.get.mockResolvedValue({ data: { dogecoin: { usd: 0.1 } } });
    await distributeMergedReward('LTC_DOGE', 1000, 100000);

    const fee = client.query.mock.calls.find(
      ([sql, p]) => sql.includes('INSERT INTO protocol_revenue_ledger') && p && Number(p[1]) > 0
    );
    expect(fee).toBeTruthy();
    expect(Number(fee[1][1])).toBeCloseTo(5, 6); // 50 DOGE × $0.10
  });
});

// ---- distributePayout: mine-at-loss opt-in (009) --------------------------

describe('distributePayout — mine-at-loss opt-in (009)', () => {
  test('OK at a loss + shortfall + sufficient USDC → stays ACTIVE, shortfall charged to balance', async () => {
    const client = distributionClient({ rate: 0.006, price: 0.05, mineAtLoss: true, usdcBalance: '10.0000' });
    // 25 GH/s × 1 day → maintenance 3 KAS; payout only 1 KAS → shortfall.
    // remainingAfterFee = 0.95, deduct 0.95 → shortfallCoin = 2.05 KAS
    // shortfallUsdc = 2.05 × $0.05 = $0.1025 → balance 10 − 0.1025 = 9.8975
    await distributePayout('KASPA', 1, 1000);

    // Explicit OK → the miner does NOT go dormant.
    const dormancy = client.query.mock.calls.find(([sql]) => sql.includes("maintenance_status = 'DORMANT'"));
    expect(dormancy).toBeFalsy();

    // The shortfall came out of the user's USDC balance, not the platform.
    const walletUpdate = client.query.mock.calls.find(([sql]) => sql.includes('UPDATE user_wallets SET usdc_balance'));
    expect(walletUpdate).toBeTruthy();
    expect(Number(walletUpdate[1][0])).toBeCloseTo(9.8975, 4);

    // USDC-funded maintenance row booked with source='USDC'.
    const usdcLedger = client.query.mock.calls.find(
      ([sql, p]) => sql.includes('INSERT INTO maintenance_fee_ledger') && sql.includes("'USDC'")
    );
    expect(usdcLedger).toBeTruthy();
    expect(Number(usdcLedger[1][5])).toBeCloseTo(0.1025, 6);
  });

  test('OK at a loss but balance canNOT cover shortfall → still DORMANT, no charge, never negative', async () => {
    const client = distributionClient({ rate: 0.006, price: 0.05, mineAtLoss: true, usdcBalance: '0.0500' });
    await distributePayout('KASPA', 1, 1000);

    // shortfall $0.1025 > $0.05 balance → auto-pause protects the user.
    const dormancy = client.query.mock.calls.find(([sql]) => sql.includes("maintenance_status = 'DORMANT'"));
    expect(dormancy).toBeTruthy();

    const walletUpdate = client.query.mock.calls.find(([sql]) => sql.includes('UPDATE user_wallets SET usdc_balance'));
    expect(walletUpdate).toBeFalsy();

    const usdcLedger = client.query.mock.calls.find(
      ([sql, p]) => sql.includes('INSERT INTO maintenance_fee_ledger') && sql.includes("'USDC'")
    );
    expect(usdcLedger).toBeFalsy();
  });
});

// ---- setMineAtLoss: OK-at-a-loss toggle endpoint ---------------------------

describe('setMineAtLoss — OK-at-a-loss toggle', () => {
  beforeEach(() => {
    pool.query.mockReset();
    pool.connect.mockReset();
  });

  test('enables mine-at-loss for the wallet pool', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ rig_id: 'rig-1', mine_at_loss: true }] });
    const res = makeRes();
    await setMineAtLoss({ body: { wallet: WALLET, target_pool: 'KASPA', enabled: true } }, res);
    expect(res.statusCode).toBeNull();
    expect(res.body).toEqual({ success: true, rig_id: 'rig-1', mine_at_loss: true });
  });

  test('404 when the pool has no rig yet', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const res = makeRes();
    await setMineAtLoss({ body: { wallet: WALLET, target_pool: 'KASPA', enabled: true } }, res);
    expect(res.statusCode).toBe(404);
  });

  test('rejects invalid wallet and unknown pool', async () => {
    const res = makeRes();
    await setMineAtLoss({ body: { wallet: 'nope', target_pool: 'KASPA', enabled: true } }, res);
    expect(res.statusCode).toBe(400);

    const res2 = makeRes();
    await setMineAtLoss({ body: { wallet: WALLET, target_pool: 'DOGE', enabled: true } }, res2);
    expect(res2.statusCode).toBe(400);
  });
});

// ---- reinvestRig: mined tokens → next upgrade -----------------------------

describe('reinvestRig — GoMiner reinvest', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'development';
    delete process.env.NICEHASH_LIVE_ORDERS;
    getLiveBtcPrice.mockResolvedValue({ price: 100000, feed: 'Kraken XBT/USDC', isUsdcPair: true, timestamp: 1 });
    placeHashpowerOrder.mockResolvedValue({ success: true, mode: 'sandbox', orderId: 'sandbox-r1', sandbox: true });
    pool.query.mockResolvedValue({ rowCount: 0, rows: [] }); // request_id not found
  });

  function reinvestClient({ balance = 1000 } = {}) {
    const client = {
      query: jest.fn(async (sql, params = []) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 1, rows: [] };
        if (sql.includes('SELECT user_id FROM users')) return { rowCount: 1, rows: [{ user_id: 'user-1' }] };
        if (sql.includes('SELECT wallet_id')) return { rowCount: 1, rows: [{ wallet_id: 'wallet-1', usdc_balance: balance }] };
        if (sql.includes('SELECT level FROM virtual_rigs')) return { rowCount: 0, rows: [] };
        if (sql.includes('SELECT l.ledger_id')) {
          // claimPoolRewardsInTx: 2 unclaimed rows of 1.0 ZEC each
          return { rowCount: 2, rows: [{ ledger_id: 'ledger-1', calculated_reward_1: '1.00000000' }, { ledger_id: 'ledger-2', calculated_reward_1: '1.00000000' }] };
        }
        if (sql.includes('UPDATE user_rewards_ledger')) return { rowCount: 1, rows: [] };
        if (sql.includes('UPDATE user_wallets SET usdc_balance = usdc_balance +')) return { rowCount: 1, rows: [] };
        if (sql.includes('SELECT rig_id')) return { rowCount: 0, rows: [] };
        if (sql.includes('INSERT INTO hashrate_orders')) return { rowCount: 1, rows: [{ order_id: 'order-1' }] };
        if (sql.includes('INSERT INTO protocol_revenue_ledger')) return { rowCount: 1, rows: [] };
        if (sql.includes('INSERT INTO virtual_rigs')) return { rowCount: 1, rows: [{ rig_id: 'rig-new' }] };
        if (sql.includes('INSERT INTO rig_hashrate_history')) return { rowCount: 1, rows: [] };
        if (sql.includes('UPDATE user_wallets SET usdc_balance = $1')) return { rowCount: 1, rows: [] };
        return { rowCount: 1, rows: [] };
      }),
      release: jest.fn(),
    };
    pool.connect.mockResolvedValue(client);
    axios.get.mockResolvedValue({ data: { zcash: { usd: 50 } } }); // $50/ZEC → 2 ZEC = $100
    return client;
  }

  test('converts mined tokens to USDC, then runs the normal upgrade (sandbox order)', async () => {
    const client = reinvestClient();
    const res = makeRes();
    await reinvestRig({ body: { wallet: WALLET, target_pool: 'ZCASH', request_id: 'reinvest-1' } }, res);

    expect(res.statusCode).toBeNull(); // 200
    expect(res.body.success).toBe(true);
    expect(res.body.level).toBe(2);
    expect(res.body.reinvested_usdc).toBe(100); // 2 ZEC × $50

    // The mined tokens were claimed (ledger rows → CLAIMED) and the balance credited.
    const claims = client.query.mock.calls.filter(([sql]) => sql.includes("SET status = 'CLAIMED'"));
    expect(claims.length).toBe(2);
    const credit = client.query.mock.calls.find(([sql]) => sql.includes('usdc_balance = usdc_balance +'));
    expect(Number(credit[1][0])).toBe(100);

    // The upgrade placed the marketplace order (sandbox) with 95% of $20 = 19 USDC → BTC.
    expect(placeHashpowerOrder).toHaveBeenCalledTimes(1);
    expect(placeHashpowerOrder).toHaveBeenCalledWith('ZCASH', 0.00019);
  });

  test('rejects when there are no mined tokens to reinvest', async () => {
    const client = reinvestClient();
    client.query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT l.ledger_id')) return { rowCount: 0, rows: [] };
      return reinvestClient().query(sql);
    });
    const res = makeRes();
    await reinvestRig({ body: { wallet: WALLET, target_pool: 'ZCASH', request_id: 'reinvest-2' } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/No mined ZCASH tokens/);
    expect(placeHashpowerOrder).not.toHaveBeenCalled();
  });

  test('duplicate request_id returns the stored order without re-claiming', async () => {
    const stored = {
      order_id: 'order-done', status: 'PLACED', nicehash_order_id: 'nh-9', sandbox: false,
      usdc_cost: 20, protocol_fee_usdc: 1, btc_spent: 0.00019, btc_spot_price: 100000,
      price_feed: 'Kraken', price_is_usdc_pair: true, failure_reason: null, request_id: 'reinvest-3',
      level: 2, virtual_hashrate: 25,
    };
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [stored] });
    const res = makeRes();
    await reinvestRig({ body: { wallet: WALLET, target_pool: 'ZCASH', request_id: 'reinvest-3' } }, res);
    expect(res.body.duplicated).toBe(true);
    expect(pool.connect).not.toHaveBeenCalled();
    expect(placeHashpowerOrder).not.toHaveBeenCalled();
  });

  test('rejects invalid wallets and unknown pools', async () => {
    const res = makeRes();
    await reinvestRig({ body: { wallet: 'nope', target_pool: 'ZCASH', request_id: 'x' } }, res);
    expect(res.statusCode).toBe(400);

    const res2 = makeRes();
    await reinvestRig({ body: { wallet: WALLET, target_pool: 'DOGE', request_id: 'x' } }, res2);
    expect(res2.statusCode).toBe(400);
  });
});
