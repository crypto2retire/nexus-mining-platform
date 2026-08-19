/**
 * Real Backing monitor tests (Phase 2) — per-coin virtual vs real hashrate,
 * pool unpaid, active rentals, 60s cache, and failure degradation.
 */
jest.mock('axios');
jest.mock('../config/db', () => ({
  pool: { query: jest.fn() },
}));
jest.mock('../services/mrrRenter', () => ({
  getOrderStatus: jest.fn(),
}));

const axios = require('axios');
const { pool } = require('../config/db');
const { getBacking, buildBacking, TTL_MS } = require('../services/backingMonitor');

function mockPool(overrides = {}) {
  pool.query.mockImplementation(async (sql) => {
    if (sql.includes('FROM virtual_rigs')) {
      return {
        rows: overrides.virtual || [
          { target_pool: 'KASPA', vghs: '25', rigs: '1' },
        ],
      };
    }
    if (sql.includes('FROM rig_rentals')) {
      return {
        rows: overrides.rentals || [
          { rig_id: 'r1', target_pool: 'KASPA', mrr_rental_id: '5698667', rig_name: 'KS0 PRO', rig_rpi: '100', cost_usd: '0.2166', length_hours: 72 },
        ],
      };
    }
    if (sql.includes('FROM real_pool_payouts')) {
      return {
        rows: overrides.payouts || [{ target_pool: 'KASPA', mined_1: '1.2345', mined_2: '0' }],
      };
    }
    return { rows: [] };
  });
}

// A 2Miners account response: balance in atoms, currentHashrate in H/s.
function twoMiners(balanceAtoms, hashrateHs) {
  return { balance: String(balanceAtoms), currentHashrate: String(hashrateHs) };
}

describe('buildBacking', () => {
  beforeAll(() => {
    // Pool wallet env vars so fetchPoolAccount actually performs the axios calls.
    process.env.MRR_PLATFORM_WALLET_ZEC = 't1test';
    process.env.MRR_PLATFORM_WALLET_KAS = 'kaspa:test';
    process.env.MRR_PLATFORM_WALLET_LTC = 'ltc1test';
    process.env.MRR_PLATFORM_WALLET_DOGE = 'dtest';
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockPool();
  });

  it('combines virtual capacity, active rentals, live pool hashrate and unpaid', async () => {
    axios.get.mockImplementation(async (url) => {
      if (url.includes('kas.2miners.com')) {
        return { data: twoMiners(120591854, 207685529691) }; // 1.2059 KAS unpaid, 207.7 GH/s
      }
      if (url.includes('zec.2miners.com')) {
        return { data: twoMiners(0, 0) };
      }
      if (url.includes('blockcypher.com')) {
        return { data: { balance: 0 } };
      }
      return { data: {} };
    });

    const backing = await buildBacking();

    expect(backing.KASPA.virtual_ghs).toBe(25);
    expect(backing.KASPA.rigs_sold).toBe(1);
    expect(backing.KASPA.active_rentals).toHaveLength(1);
    expect(backing.KASPA.active_rentals[0].mrr_rental_id).toBe('5698667');
    // 207685529691 H/s -> 207.69 GH/s
    expect(backing.KASPA.real_hash).toBeCloseTo(207.69, 1);
    expect(backing.KASPA.real_unit).toBe('GH/s');
    // 120591854 atoms / 1e8 = 1.2059 KAS
    expect(backing.KASPA.pool_unpaid).toBeCloseTo(1.2059, 4);
    expect(backing.KASPA.pool_unpaid_unit).toBe('KAS');
    expect(backing.KASPA.mined_total).toBe(1.2345);
  });

  it('uses MRR rental averages for LTC real hashrate', async () => {
    mockPool({
      rentals: [
        { rig_id: 'r1', target_pool: 'LTC_DOGE', mrr_rental_id: '5697894', rig_name: 'tep9503', rig_rpi: '100', cost_usd: '0.5', length_hours: 3 },
      ],
    });
    // MRR order status: average 7.375 GH/s (scrypt avg type = gh)
    const { getOrderStatus } = require('../services/mrrRenter');
    getOrderStatus.mockResolvedValue({
      data: { hashrate: { average: { hash: '7.375', type: 'gh' } } },
    });
    axios.get.mockResolvedValue({ data: { balance: 0 } });

    const backing = await buildBacking();
    expect(backing.LTC_DOGE.real_hash).toBeCloseTo(7.375, 3);
  });

  it('degrades to nulls when live fetches fail — never throws', async () => {
    axios.get.mockRejectedValue(new Error('ECONNREFUSED'));
    const backing = await buildBacking();
    expect(backing.KASPA.real_hash).toBeNull();
    expect(backing.KASPA.pool_unpaid).toBeNull();
    expect(backing.KASPA.virtual_ghs).toBe(25); // DB data still present
  });
});

describe('getBacking cache', () => {
  beforeAll(() => {
    process.env.MRR_PLATFORM_WALLET_ZEC = 't1test';
    process.env.MRR_PLATFORM_WALLET_KAS = 'kaspa:test';
    process.env.MRR_PLATFORM_WALLET_LTC = 'ltc1test';
    process.env.MRR_PLATFORM_WALLET_DOGE = 'dtest';
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockPool();
    axios.get.mockResolvedValue({ data: {} });
  });

  it('serves from cache within TTL and rebuilds after', async () => {
    const a = await getBacking();
    const b = await getBacking();
    expect(a).toBe(b); // same cached object
    expect(axios.get.mock.calls.length).toBeGreaterThan(0);
    const callsAfterFirst = axios.get.mock.calls.length;

    // Simulate TTL expiry.
    jest.spyOn(Date, 'now').mockReturnValueOnce(Date.now() + TTL_MS + 1000);
    await getBacking();
    expect(axios.get.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    jest.restoreAllMocks();
  });

  it('force=true rebuilds immediately', async () => {
    await getBacking();
    const callsBefore = axios.get.mock.calls.length;
    await getBacking({ force: true });
    expect(axios.get.mock.calls.length).toBeGreaterThan(callsBefore);
  });
});
