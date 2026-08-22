/**
 * Per-miner dashboard tests (2026-08-22) — pro-rata allocation of pool-level
 * payouts to individual rigs, current vs overall P/L, and window estimates.
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
const { buildOperatorMiners, allocateShare, activeAt } = require('../services/minerDashboardService');

const HOUR = 3600 * 1000;
const NOW = Date.now();

// Two ZEC rentals on the same pool wallet: rig A (445 KH/s, 24h, started 10h
// ago), rig B (475 KH/s, 24h, started 5h ago). One settled payout 6h ago;
// current pool unpaid 0.002 ZEC. ZEC spot $100.
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
// A third, ENDED rental of the SAME physical rig A (renewal) that ended 3h ago.
const RENTAL_A_PREV = {
  id: 0, rig_id: 'vr-a', target_pool: 'ZCASH', mrr_rental_id: '0999',
  rig_name: 'Z15 A', rig_rpi: '99', cost_btc: '0.00015', cost_usd: '9',
  length_hours: 6, funded_from: 'POOL', status: 'ENDED',
  started_at: new Date(NOW - 16 * HOUR).toISOString(),
  ended_at: new Date(NOW - 10 * HOUR).toISOString(),
  requested_rig_id: 'rig-A', requested_rig_hashrate: '445',
};

function mockPool(rentals, payouts) {
  pool.query.mockImplementation(async (sql) => {
    if (sql.includes('FROM rig_rentals rr')) return { rows: rentals };
    if (sql.includes('FROM virtual_rigs')) return { rows: [] };
    if (sql.includes('FROM real_pool_payouts')) return { rows: payouts };
    return { rows: [] };
  });
}

function mockMarket() {
  getBacking.mockResolvedValue({
    ZCASH: {
      pool_unpaid: 0.002,
      pool_unpaid_unit: 'ZEC',
      mined_total: 0.003, // 0.001 settled + 0.002 unpaid
      mined_2: 0,
    },
  });
  getCoinMarketData.mockResolvedValue({
    spots: { ZEC: 100 },
    priceTrend: [{ coin: 'ZEC', price: 100, chg_24h: 1.2, chg_7d: 3.4 }],
  });
  configFor.mockReturnValue({
    anchorGhs: 30.55e-6, // GH/s anchor for equihash
    coins: { ZEC: { id: 'zcash', production: 0.002060 } },
  });
}

describe('allocateShare / activeAt', () => {
  it('splits by hashrate among rentals active at a timestamp', () => {
    const a = { ...RENTAL_A, hashrate: 445, started_at: new Date(NOW - 10 * HOUR).toISOString(), expires_at_ms: NOW - 10 * HOUR + 24 * HOUR };
    const b = { ...RENTAL_B, hashrate: 475, started_at: new Date(NOW - 5 * HOUR).toISOString(), expires_at_ms: NOW - 5 * HOUR + 24 * HOUR };
    const splits = allocateShare([a, b], NOW - 6 * HOUR);
    // At T=6h ago, only A had started → A gets 100%.
    expect(splits).toHaveLength(1);
    expect(splits[0].rental).toBe(a);
    expect(splits[0].share).toBe(1);
  });

  it('returns null when no rental is active', () => {
    const a = { ...RENTAL_A, hashrate: 445, started_at: new Date(NOW - 30 * HOUR).toISOString(), expires_at_ms: NOW - 6 * HOUR };
    expect(activeAt(a, NOW)).toBe(false);
    expect(allocateShare([a], NOW)).toBeNull();
  });
});

describe('buildOperatorMiners', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPool([RENTAL_A_PREV, RENTAL_A, RENTAL_B], [
      { target_pool: 'ZCASH', total_crypto_reward_1: '0.001', total_crypto_reward_2: '0', payout_timestamp: new Date(NOW - 6 * HOUR).toISOString() },
    ]);
    mockMarket();
  });

  it('allocates each settled payout to the rentals active at payout time', async () => {
    const result = await buildOperatorMiners('op-user');
    const zec = result.pools.ZCASH;
    const a = zec.miners.find((m) => m.mrr_rental_id === '1001');
    const b = zec.miners.find((m) => m.mrr_rental_id === '1002');
    // 0.001 settled (all to A, the only active rig at T) + 0.002 unpaid split
    // 445/920 vs 475/920.
    expect(a.earned_coin_1).toBeCloseTo(0.001 + 0.002 * (445 / 920), 6);
    expect(b.earned_coin_1).toBeCloseTo(0.002 * (475 / 920), 6);
    // Both coins valued at $100 → USD.
    expect(a.earned_usd).toBeCloseTo(a.earned_coin_1 * 100, 4);
    expect(b.earned_usd).toBeCloseTo(b.earned_coin_1 * 100, 4);
  });

  it('computes current P/L as earned − cost-so-far for ACTIVE rentals', async () => {
    const result = await buildOperatorMiners('op-user');
    const zec = result.pools.ZCASH;
    const a = zec.miners.find((m) => m.mrr_rental_id === '1001');
    const b = zec.miners.find((m) => m.mrr_rental_id === '1002');
    // A: 10h of 24h elapsed → cost_so_far 10 × (10/24) = 4.1667
    expect(a.cost_so_far_usd).toBeCloseTo(10 * (10 / 24), 4);
    expect(a.pnl_current_usd).toBeCloseTo(a.earned_usd - a.cost_so_far_usd, 4);
    expect(b.cost_so_far_usd).toBeCloseTo(12 * (5 / 24), 4);
    expect(b.pnl_current_usd).toBeCloseTo(b.earned_usd - b.cost_so_far_usd, 4);
  });

  it('groups overall P/L by PHYSICAL miner (same requested_rig_id across renewals)', async () => {
    const result = await buildOperatorMiners('op-user');
    const zec = result.pools.ZCASH;
    const a = zec.miners.find((m) => m.mrr_rental_id === '1001');
    const prev = zec.miners.find((m) => m.mrr_rental_id === '0999');
    // Rig A overall = (A earned + prev earned) − (10 + 9). The ENDED rental
    // earned nothing from the settled payout (it had already ended at T) and
    // nothing from the current unpaid (ended) → its earned is 0.
    expect(prev.earned_coin_1).toBe(0);
    expect(a.pnl_overall_miner_usd).toBeCloseTo(a.earned_usd - 10 - 9, 4);
    expect(prev.pnl_overall_miner_usd).toBeCloseTo(a.pnl_overall_miner_usd, 4);
    // Rig B overall is just its own rental.
    const b = zec.miners.find((m) => m.mrr_rental_id === '1002');
    expect(b.pnl_overall_miner_usd).toBeCloseTo(b.earned_usd - 12, 4);
  });

  it('computes coin overall P/L and reconciles with mined value', async () => {
    const result = await buildOperatorMiners('op-user');
    const zec = result.pools.ZCASH;
    // mined_value = (0.001 + 0.002) ZEC × $100 = $0.30
    expect(zec.mined_value_usd).toBeCloseTo(0.3, 4);
    // earned_allocated sums to the same 0.003 ZEC → $0.30
    expect(zec.earned_allocated_usd).toBeCloseTo(0.3, 4);
    // total cost = 10 + 12 + 9 = 31 → overall −30.70
    expect(zec.total_cost_usd).toBeCloseTo(31, 4);
    expect(zec.pnl_overall_usd).toBeCloseTo(0.3 - 31, 4);
  });

  it('reports hours left and estimated payout for the remaining window', async () => {
    const result = await buildOperatorMiners('op-user');
    const zec = result.pools.ZCASH;
    const a = zec.miners.find((m) => m.mrr_rental_id === '1001');
    // A has 14h left; scale 445 KH/s / 30.55e-6 GH/s × 0.002060 ZEC/day × 14/24
    const scale = 445 / 30.55e-6;
    const expected = scale * 0.002060 * (14 / 24);
    expect(a.hours_left).toBeCloseTo(14, 1);
    expect(a.est_payout_coin_1).toBeCloseTo(expected, 1);
    expect(a.est_payout_usd).toBeCloseTo(expected * 100, 0);
    // Ended rental: no estimate, zero time left.
    const prev = zec.miners.find((m) => m.mrr_rental_id === '0999');
    expect(prev.hours_left).toBe(0);
    expect(prev.est_payout_coin_1).toBeNull();
    expect(prev.pnl_current_usd).toBeNull();
  });

  it('includes price trend so the panel can render Price | 24h | 7d', async () => {
    const result = await buildOperatorMiners('op-user');
    const zec = result.pools.ZCASH;
    expect(zec.price_trend).toEqual([{ coin: 'ZEC', price: 100, chg_24h: 1.2, chg_7d: 3.4 }]);
  });

  it('degrades cleanly when prices fail — no throw, spots empty', async () => {
    getCoinMarketData.mockRejectedValue(new Error('network'));
    const result = await buildOperatorMiners('op-user');
    const zec = result.pools.ZCASH;
    expect(zec.earned_usd).toBeUndefined(); // pool-level earned only via miners
    expect(zec.miners[0].earned_usd).toBe(0); // no spot → USD value is 0
    expect(zec.price_usd).toBeNull();
    expect(zec.mined_value_usd).toBe(0);
  });
});
