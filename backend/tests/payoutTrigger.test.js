jest.mock('../config/db', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

const { computePayoutEvent } = require('../services/payoutTrigger');

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
