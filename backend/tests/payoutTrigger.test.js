jest.mock('../config/db', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

const { computePayoutEvent, WATCHES, PAYOUT_MIN } = require('../services/payoutTrigger');
const { ACCRUAL_POOLS } = require('../services/accrualDistributor');

describe('DOGE merged watch (011)', () => {
  test('LTC_DOGE_DOGE watches the platform DOGE wallet and routes to merged distribution', () => {
    const cfg = WATCHES.LTC_DOGE_DOGE;
    expect(cfg).toBeTruthy();
    expect(cfg.walletEnv).toBe('MRR_PLATFORM_WALLET_DOGE');
    expect(cfg.distribute).toBe('merged');
    expect(cfg.gamePool).toBe('LTC_DOGE');
    // 2026-08-22 fix: on-chain balance-delta watches must distribute on
    // arrival — never the accrual-recording path (or players get nothing).
    expect(cfg.settlementGated).toBe(true);
    // Blockcypher returns DOGE in smallest units — normalize to whole DOGE.
    expect(cfg.balanceOf({ balance: 123456789 })).toBeCloseTo(1.23456789, 6);
  });
});

describe('pool watches (2Miners ZEC / HeroMiners KAS) — balance normalization (015)', () => {
  test('KASPA balanceOf reads stats.balance and normalizes atoms → KAS', () => {
    const cfg = WATCHES.KASPA;
    // HeroMiners stats.balance is sompi (1 KAS = 1e8) — normalize to coin units so the
    // payout ledger never sees 157,240,000 "KAS" (numeric overflow bug).
    const bal = cfg.balanceOf({ stats: { balance: '125011636' } });
    expect(bal).toBeCloseTo(1.25011636, 8);
    expect(bal).not.toBe(0); // the old Number(d.balance) returned 0 forever
    expect(cfg.accountUrl('kaspa:test')).toContain('kaspa.herominers.com/api/stats_address');
  });

  test('ZCASH balanceOf reads stats.balance (normalized) with a top-level fallback', () => {
    const cfg = WATCHES.ZCASH;
    expect(cfg.balanceOf({ stats: { balance: '100' } })).toBeCloseTo(0.000001, 8);
    // API variant that still uses top-level balance.
    expect(cfg.balanceOf({ balance: '50' })).toBeCloseTo(0.0000005, 8);
  });

  test('KAS/ZEC use unpaid-drop detection with the pool minimum, NOT balance-delta', () => {
    // stats.balance ACCRUES while mining and DROPS when the pool pays the
    // wallet — balance-delta would fire a bogus payout on every accrual.
    expect(WATCHES.KASPA.mode).toBe('unpaid-drop');
    expect(WATCHES.ZCASH.mode).toBe('unpaid-drop');
    expect(WATCHES.KASPA.minPayout).toBe(1);
    expect(WATCHES.ZCASH.minPayout).toBeCloseTo(0.1, 4); // 2Miners live config: 1e7 zatoshi
  });
});

describe('BTC Ocean settlement watch', () => {
  test('watches the platform BTC wallet through Blockcypher balance deltas', () => {
    const cfg = WATCHES.BTC;
    expect(cfg.mode).toBe('balance-delta');
    expect(cfg.walletEnv).toBe('MRR_PLATFORM_WALLET_BTC');
    expect(cfg.accountUrl('bc1test')).toContain('api.blockcypher.com/v1/btc/main/addrs/bc1test');
    expect(cfg.gamePool).toBe('BTC');
    expect(cfg.settlementGated).toBe(true);
    expect(cfg.minPayout).toBe(0.00065536);
    expect(PAYOUT_MIN.BTC).toBe(0.00065536);
  });

  test('normalizes Blockcypher satoshis to BTC', () => {
    expect(WATCHES.BTC.balanceOf({ balance: 65536 })).toBe(0.00065536);
  });

  test('keeps BTC out of the accrual distributor', () => {
    expect(ACCRUAL_POOLS).toEqual(['ZCASH', 'KASPA']);
    expect(ACCRUAL_POOLS).not.toContain('BTC');
  });
});

describe('computePayoutEvent (payout trigger decision logic)', () => {
  test('no baseline → baseline (no event)', () => {
    expect(computePayoutEvent(null, 5)).toEqual({ action: 'baseline' });
  });

  test('balance increase → payout with the exact delta', () => {
    expect(computePayoutEvent(10, 10.5)).toEqual({ action: 'payout', amount: 0.5 });
  });

  test('tiny dust increases are ignored (below epsilon)', () => {
    expect(computePayoutEvent(10, 10.000000001)).toEqual({ action: 'none' });
  });

  test('balance decrease → reset baseline, no event (operator moved coins)', () => {
    expect(computePayoutEvent(10, 5)).toEqual({ action: 'reset' });
  });

  test('no change → none', () => {
    expect(computePayoutEvent(10, 10)).toEqual({ action: 'none' });
  });
});
