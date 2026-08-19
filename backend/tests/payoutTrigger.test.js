jest.mock('../config/db', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

const { computePayoutEvent, WATCHES } = require('../services/payoutTrigger');

describe('DOGE merged watch (011)', () => {
  test('LTC_DOGE_DOGE watches the platform DOGE wallet and routes to merged distribution', () => {
    const cfg = WATCHES.LTC_DOGE_DOGE;
    expect(cfg).toBeTruthy();
    expect(cfg.walletEnv).toBe('MRR_PLATFORM_WALLET_DOGE');
    expect(cfg.distribute).toBe('merged');
    expect(cfg.gamePool).toBe('LTC_DOGE');
    // Blockcypher returns DOGE in smallest units — normalize to whole DOGE.
    expect(cfg.balanceOf({ balance: 123456789 })).toBeCloseTo(1.23456789, 6);
  });
});

describe('2Miners watches (ZEC/KAS) — stats.balance fix', () => {
  test('KASPA balanceOf reads stats.balance (top-level balance does not exist)', () => {
    const cfg = WATCHES.KASPA;
    // Verified live 2026-08-19: the account API has NO top-level `balance`.
    const bal = cfg.balanceOf({ stats: { balance: '125011636' } });
    expect(bal).toBe(125011636);
    expect(bal).not.toBe(0); // the old Number(d.balance) returned 0 forever
  });

  test('ZCASH balanceOf reads stats.balance with a top-level fallback', () => {
    const cfg = WATCHES.ZCASH;
    expect(cfg.balanceOf({ stats: { balance: '100' } })).toBe(100);
    // API variant that still uses top-level balance.
    expect(cfg.balanceOf({ balance: '50' })).toBe(50);
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
