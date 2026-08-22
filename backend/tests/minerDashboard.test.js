/**
 * Per-rig dashboard tests (2026-08-22) — SELF-CUSTODY ONLY.
 * No pooled allocation: per-rig P/L is ESTIMATED from the rig's own
 * production math; actual rewards are the user's OWN wallet at the pool.
 */
jest.mock('../config/db', () => ({
  pool: { query: jest.fn() },
}));
jest.mock('../services/backingMonitor', () => ({
  getBacking: jest.fn(),
}));
jest.mock('../services/operatorMarketService', () => ({
  getCoinMarketData: jest.fn(),
  configFor: jest.fn(),
}));

const { pool } = require('../config/db');
const { getBacking } = require('../services/backingMonitor');
const { getCoinMarketData, configFor } = require('../services/operatorMarketService');
const { buildOperatorMiners } = require('../services/minerDashboardService');

const HOUR = 3600 * 1000;
const NOW = Date.now();

// Two ZEC rentals on the same pool wallet: rig A (445 KH/s, 24h, started 10h
// ago), rig B (475 KH/s, 24h, started 5h ago). A THIRD ENDED rental of the
// SAME physical rig A (renewal) ended 3h ago.
const RENTAL_A = {
  id: 1, rig_id: 'vr-a', target_pool: 'ZCASH', mrr_rental_id: '1001',
  rig_name: 'Z15 A', rig_rpi: '99', cost_btc: '0.00016', cost_usd: '10',
  length_hours: 24, funded_from: 'POOL', status: 'ACTIVE',
  started_at: new Date(NOW - 10 * HOUR).toISOString(), ended_at: null,
  requested_rig_id: 'rig-A', requested_rig_hashrate: '445',
};
const RENTAL_B = {
  id: 2, rig_id: 'vr-b', target_pool: 'ZCASH', mrr_rental_id: '1002',
  rig_name: 'Z15 B', rig_rpi: '100', cost_btc: '0.00019', cost_usd: '12',
  length_hours: 24, funded_from: 'POOL', status: 'ACTIVE',
  started_at: new Date(NOW - 5 * HOUR).toISOString(), ended_at: null,
  requested_rig_id: 'rig-B', requested_rig_hashrate: '475',
};
const RENTAL_A_PREV = {
  id: 0, rig_id: 'vr-a', target_pool: 'ZCASH', mrr_rental_id: '0999',
  rig_name: 'Z15 A', rig_rpi: '99', cost_btc: '0.00015', cost_usd: '9',
  length_hours: 6, funded_from: 'POOL', status: 'ENDED',
  started_at: new Date(NOW - 16 * HOUR).toISOString(),
  ended_at: new Date(NOW - 10 * HOUR).toISOString(),
  requested_rig_id: 'rig-A', requested_rig_hashrate: '445',
};

function mockPool(rentals) {
  pool.query.mockImplementation(async (sql) => {
    if (sql.includes('FROM rig_rentals rr')) return { rows: rentals };
    if (sql.includes('FROM virtual_rigs')) return { rows: [] };
    return { rows: [] };
  });
}

function mockMarket() {
  // SELF-CUSTODY: the wallet the rigs mine to is the user's OWN — its unpaid
  // balance is shown as "your rewards", never split across rigs.
  getBacking.mockResolvedValue({
    ZCASH: {
      pool_unpaid: 0.002,
      pool_unpaid_unit: 'ZEC',
      mined_total: 0.003,
      mined_2: 0,
    },
  });
  getCoinMarketData.mockResolvedValue({
    spots: { ZEC: 100 },
    priceTrend: [{ coin: 'ZEC', price: 100, chg_24h: 1.2, chg_7d: 3.4 }],
  });
  configFor.mockReturnValue({
    anchorGhs: 30.55e-6, // GH/s anchor for equihash
    coins: { ZEC: { id: 'zcash', production: 0.0007 } },
  });
}

describe('buildOperatorMiners — self-custody model', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPool([RENTAL_A_PREV, RENTAL_A, RENTAL_B]);
    mockMarket();
  });

  it('never allocates pool-level rewards to rigs — per-rig rewards are null', async () => {
    const result = await buildOperatorMiners('op-user');
    const zec = result.pools.ZCASH;
    for (const m of zec.miners) {
      expect(m.rewards_coin_1).toBeNull();
      expect(m.rewards_coin_2).toBeNull();
    }
    // The user's OWN wallet rewards are shown at the pool level, unsplit.
    expect(zec.your_rewards_coin).toBeCloseTo(0.002, 6);
    expect(zec.your_rewards_unit).toBe('ZEC');
    expect(result.rewards_model).toContain('self-custody');
  });

  it('estimates payout per rig from its own hashrate (GH/s-normalized anchor math)', async () => {
    const result = await buildOperatorMiners('op-user');
    const zec = result.pools.ZCASH;
    const a = zec.miners.find((m) => m.mrr_rental_id === '1001');
    const b = zec.miners.find((m) => m.mrr_rental_id === '1002');
    // 445 KH/s → 445e-6 GH/s ÷ 30.55e-6 × 0.0007 ZEC/day × (14h left /24)
    const scaleA = (445 * 1e-6) / 30.55e-6;
    expect(a.est_payout_coin_1).toBeCloseTo(scaleA * 0.0007 * (14 / 24), 1);
    // Rig B: 14.92×... 475 KH/s, 19h left
    const scaleB = (475 * 1e-6) / 30.55e-6;
    expect(b.est_payout_coin_1).toBeCloseTo(scaleB * 0.0007 * (19 / 24), 1);
    expect(a.est_payout_usd).toBeCloseTo(a.est_payout_coin_1 * 100, 0);
  });

  it('computes est. current P/L as est. earned so far − cost so far', async () => {
    const result = await buildOperatorMiners('op-user');
    const zec = result.pools.ZCASH;
    const a = zec.miners.find((m) => m.mrr_rental_id === '1001');
    // A: 10h elapsed of 24h → est earned = scale×0.00206×(10/24)×$100
    const scaleA = (445 * 1e-6) / 30.55e-6;
    const estEarned = scaleA * 0.0007 * (10 / 24) * 100;
    const costSoFar = 10 * (10 / 24);
    expect(a.cost_so_far_usd).toBeCloseTo(costSoFar, 4);
    expect(a.est_pnl_current_usd).toBeCloseTo(estEarned - costSoFar, 4);
    // Ended rental: no current P/L.
    const prev = zec.miners.find((m) => m.mrr_rental_id === '0999');
    expect(prev.est_pnl_current_usd).toBeNull();
  });

  it('groups est. overall P/L by PHYSICAL miner across renewals, incl. ended windows', async () => {
    const result = await buildOperatorMiners('op-user');
    const zec = result.pools.ZCASH;
    const a = zec.miners.find((m) => m.mrr_rental_id === '1001');
    const prev = zec.miners.find((m) => m.mrr_rental_id === '0999');
    // Rig A overall = est earned (active) + est full-window (ended) − 10 − 9
    const scaleA = (445 * 1e-6) / 30.55e-6;
    const activeEarned = scaleA * 0.0007 * (10 / 24) * 100;
    const endedEarned = scaleA * 0.0007 * (6 / 24) * 100; // full 6h window
    expect(a.est_pnl_overall_miner_usd).toBeCloseTo(activeEarned + endedEarned - 19, 4);
    expect(prev.est_pnl_overall_miner_usd).toBeCloseTo(a.est_pnl_overall_miner_usd, 4);
    // Rig B is its own group.
    const b = zec.miners.find((m) => m.mrr_rental_id === '1002');
    const scaleB = (475 * 1e-6) / 30.55e-6;
    expect(b.est_pnl_overall_miner_usd).toBeCloseTo(scaleB * 0.0007 * (5 / 24) * 100 - 12, 4);
  });

  it('reports time left, hours-left=0 for ended, and per-rig cost', async () => {
    const result = await buildOperatorMiners('op-user');
    const zec = result.pools.ZCASH;
    const a = zec.miners.find((m) => m.mrr_rental_id === '1001');
    const prev = zec.miners.find((m) => m.mrr_rental_id === '0999');
    expect(a.hours_left).toBeCloseTo(14, 1);
    expect(prev.hours_left).toBe(0);
    expect(a.cost_usd).toBe(10);
    expect(prev.status).toBe('ENDED');
  });

  it('includes price trend so the panel can render Price | 24h | 7d', async () => {
    const result = await buildOperatorMiners('op-user');
    expect(result.pools.ZCASH.price_trend).toEqual([{ coin: 'ZEC', price: 100, chg_24h: 1.2, chg_7d: 3.4 }]);
  });

  it('degrades cleanly when prices fail — no throw, estimates stay null', async () => {
    getCoinMarketData.mockRejectedValue(new Error('network'));
    const result = await buildOperatorMiners('op-user');
    const zec = result.pools.ZCASH;
    const active = zec.miners.find((m) => m.status === 'ACTIVE');
    // No spot → no USD estimates, but hashrate/time/cost still present.
    expect(active.est_earned_usd).toBeNull();
    expect(active.hashrate).toBeGreaterThan(0);
    expect(active.hours_left).toBeGreaterThan(0);
    expect(zec.your_rewards_coin).toBeCloseTo(0.002, 6); // wallet data still shown
  });
});
