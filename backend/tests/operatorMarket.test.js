const {
  buildMarketView,
  calculateProfitability,
  marketStatsFor,
} = require('../services/operatorMarketService');

const KAS_RIG = {
  id: 'kas-200',
  name: 'KAS 200G',
  owner: 'owner-a',
  type: 'kheavyhash',
  region: 'us-east',
  rpi: '98.5',
  online: true,
  status: { status: 'available', rented: false, online: true },
  extensions: true,
  minhours: '3',
  maxhours: '72',
  hashrate: { advertised: { hash: 200, type: 'gh', nice: '200.00G' } },
  price: { BTC: { hour: '0.000001', minhrs: '0.000003', min_rental_length: 3, enabled: true } },
};

test('KAS profitability scales the observed 200 GH/s anchor and all scenarios exactly', () => {
  const result = calculateProfitability({
    algo: 'kheavyhash',
    hashrateGhs: 200,
    usdPerHour: 0.1,
    minHours: 3,
    spots: { KAS: 0.2 },
  });

  expect(result.arithmetic.production_day.KAS).toBeCloseTo(1.3832, 12);
  expect(result.revenue_day).toBeCloseTo(0.27664, 12);
  expect(result.cost_day).toBeCloseTo(2.4, 12);
  expect(result.net_current).toBeCloseTo(-2.12336, 12);
  expect(result.net_plus10).toBeCloseTo((0.27664 * 1.1) - 2.4, 12);
  expect(result.net_minus10).toBeCloseTo((0.27664 * 0.9) - 2.4, 12);
  expect(result.net_plus25).toBeCloseTo((0.27664 * 1.25) - 2.4, 12);
  expect(result.net_minus25).toBeCloseTo((0.27664 * 0.75) - 2.4, 12);
  expect(result.break_even_price).toBeCloseTo(2.4 / 1.3832, 12);
  expect(result.lengths.find((row) => row.length_hours === 24)).toEqual({
    length_hours: 24,
    total_cost: 2.4,
    expected_value: 0.27664,
    net: expect.closeTo(-2.12336, 12),
  });
});

test('ZEC profitability uses the observed 30.55 kSol/s delivery anchor', () => {
  const result = calculateProfitability({
    algo: 'equihash',
    hashrateGhs: 0.00003055,
    usdPerHour: 0.001,
    minHours: 3,
    spots: { ZEC: 40 },
  });

  expect(result.arithmetic.anchor_ghs).toBeCloseTo(0.00003055, 14);
  expect(result.arithmetic.production_day.ZEC).toBeCloseTo(0.002060, 12);
  expect(result.revenue_day).toBeCloseTo(0.0824, 12);
  expect(result.net_current).toBeCloseTo(0.0584, 12);
  expect(result.break_even_price).toBeCloseTo(0.024 / 0.002060, 12);
});

test('market ranking filters junk, prefers verified available rigs, and sorts table by net day', () => {
  const newRig = {
    ...KAS_RIG,
    id: 'new-cheap',
    name: 'New cheap rig',
    rpi: 'new',
    price: { BTC: { ...KAS_RIG.price.BTC, hour: '0.0000005', minhrs: '0.0000015' } },
  };
  const verifiedRig = { ...KAS_RIG, id: 'verified', name: 'Verified rig' };
  const junkRig = {
    ...KAS_RIG,
    id: 'junk',
    hashrate: { advertised: { hash: 0.001, type: 'th', nice: '1.00G' } },
  };

  const result = buildMarketView({
    records: [newRig, verifiedRig, junkRig],
    algo: 'kheavyhash',
    btcUsd: 100000,
    spots: { KAS: 0.2 },
    profileId: '957805',
  });

  expect(result.rigs.map((rig) => rig.rig_id)).toEqual(['new-cheap', 'verified']);
  expect(result.best_value.rig_id).toBe('verified');
  expect(result.best_value.reason).toMatch(/net at current KAS price/);
  expect(result.rigs[0].usd_per_ghs_day).toBeLessThan(result.rigs[1].usd_per_ghs_day);
});

test('market header converts MRR unit-day prices and available hash to GH/s', () => {
  const stats = marketStatsFor({
    algo: 'kheavyhash',
    btcUsd: 100000,
    algorithmRows: [{
      name: 'kheavyhash',
      stats: {
        available: { rigs: '4', hash: { hash: '2', unit: 'th', nice: '2.00T' } },
        prices: {
          lowest: { amount: '0.00001', unit: 'th*day' },
          last_10: { amount: '0.00002', unit: 'th*day' },
        },
      },
    }],
  });

  expect(stats).toEqual({
    available_rigs: 4,
    available_hash_ghs: 2000,
    available_hash_nice: '2.00T',
    lowest_usd_per_ghs_day: 0.001,
    last_10_usd_per_ghs_day: 0.002,
  });
});
