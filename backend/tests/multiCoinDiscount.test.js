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
  test('counts rig rows for the user', async () => {
    const queryable = { query: jest.fn().mockResolvedValue({ rows: [{ c: '3' }] }) };
    await expect(coinsOwnedFor(queryable, 'user-1')).resolves.toBe(3);
    expect(queryable.query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT COUNT(*)'),
      ['user-1']
    );
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
