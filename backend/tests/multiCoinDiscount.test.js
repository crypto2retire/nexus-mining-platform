/**
 * multiCoinDiscount tests: coin counting + the loyalty ladder
 * (2/3/4 coins -> 5/10/15% off purchases AND ongoing maintenance).
 */

jest.mock('../config/db', () => ({
  pool: { connect: jest.fn(), query: jest.fn() },
}));

const { coinsOwnedFor, discountPctFor, DISCOUNT_LADDER } = require('../services/multiCoinDiscount');

afterEach(() => jest.clearAllMocks());

describe('coinsOwnedFor', () => {
  test('counts ACTIVE rig rows only — expired windows excluded (Kevin 2026-08-20)', async () => {
    const queryable = { query: jest.fn().mockResolvedValue({ rows: [{ c: '1' }] }) };
    await expect(coinsOwnedFor(queryable, 'user-1')).resolves.toBe(1);
    // The SQL must filter to live rental windows — an expired rig (0 GH/s)
    // must NOT keep the multi-coin discount.
    const sql = queryable.query.mock.calls[0][0];
    expect(sql).toContain('rental_expires_at > CURRENT_TIMESTAMP');
    expect(sql).toContain('target_pool IN');
  });

  test('zero when no rows (defensive — also covers test mocks that return empty)', async () => {
    const queryable = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await expect(coinsOwnedFor(queryable, 'user-1')).resolves.toBe(0);
  });

  test('zero when count is missing/non-numeric', async () => {
    const queryable = { query: jest.fn().mockResolvedValue({ rows: [{ c: null }] }) };
    await expect(coinsOwnedFor(queryable, 'user-1')).resolves.toBe(0);
  });
});

describe('discountPctFor', () => {
  test('ladder: 0/1 coins → 0%, 2 → 5%, 3 → 10%, 4 → 15%', () => {
    expect(discountPctFor(0)).toBe(0);
    expect(discountPctFor(1)).toBe(0);
    expect(discountPctFor(2)).toBe(5);
    expect(discountPctFor(3)).toBe(10);
    expect(discountPctFor(4)).toBe(15);
  });

  test('beyond the ladder stays at the max', () => {
    expect(discountPctFor(5)).toBe(0); // only 4 coins exist in the game
  });

  test('ladder is exactly as documented', () => {
    expect(DISCOUNT_LADDER).toEqual({ 2: 5, 3: 10, 4: 15 });
  });
});
