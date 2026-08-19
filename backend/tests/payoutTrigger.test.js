jest.mock('../config/db', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

const { computePayoutEvent, WATCHES } = require('../services/payoutTrigger');

describe('XMR watch (unpaid-drop)', () => {
  test('reads unpaid balance from stats.balance; string unlocked entries are ignored', () => {
    const cfg = WATCHES.XMR;
    const bal = cfg.balanceOf({
      stats: { balance: '134569291' },
      unlocked: ['3743625:9ea87efc:670125668133:unlocked:eu-de:prop'],
      payments: [],
    });
    // 134,569,291 atomic units = 0.000134569291 XMR
    expect(bal).toBeCloseTo(0.000134569291, 12);
    // The old implementation summed r.amount over unlocked and always got 0.
    expect(bal).not.toBe(0);
  });
});

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

  test('unpaid-drop mode: crossing the pool minimum and dropping = payout', () => {
    // XMR: unpaid was 0.12 (≥ 0.1 min), now 0.02 → the pool paid ~0.10
    expect(computePayoutEvent(0.12, 0.02, { minDrop: 0.1 })).toEqual({ action: 'payout', amount: 0.1 });
  });

  test('unpaid-drop mode: small unpaid changes are accrual noise, not payouts', () => {
    expect(computePayoutEvent(0.03, 0.04, { minDrop: 0.1 })).toEqual({ action: 'none' });
    expect(computePayoutEvent(0.03, 0.01, { minDrop: 0.1 })).toEqual({ action: 'none' });
  });
});
