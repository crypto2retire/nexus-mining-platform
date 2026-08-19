/**
 * Admin authorization tests.
 *
 * requireAdmin must:
 *  - reject requests with no ADMIN_WALLETS configured (fail closed)
 *  - reject requests without a wallet / with an invalid wallet
 *  - reject wallets NOT on the allow-list
 *  - pass wallets on the allow-list (case-insensitive)
 */
const { requireAdmin, isAdminWallet } = require('../middleware/adminAuth');

const ADMIN = '0x181a33d257e4d660144c0ac5ac0754fe00f0e28d';
const OTHER = '0x1234567890abcdef1234567890abcdef12345678';

function makeReq({ header, query } = {}) {
  return {
    get(name) {
      if (name === 'x-wallet') return header;
      return undefined;
    },
    query: query || {},
  };
}

function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = function (code) {
    res.statusCode = code;
    return this;
  };
  res.json = function (body) {
    res.body = body;
    return this;
  };
  return res;
}

describe('adminAuth.requireAdmin', () => {
  const original = process.env.ADMIN_WALLETS;

  afterEach(() => {
    if (original === undefined) delete process.env.ADMIN_WALLETS;
    else process.env.ADMIN_WALLETS = original;
  });

  it('fails closed when ADMIN_WALLETS is not configured', () => {
    delete process.env.ADMIN_WALLETS;
    const req = makeReq({ header: ADMIN });
    const res = makeRes();
    const next = jest.fn();
    requireAdmin(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/not configured/i);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a missing wallet', () => {
    process.env.ADMIN_WALLETS = ADMIN;
    const req = makeReq({});
    const res = makeRes();
    const next = jest.fn();
    requireAdmin(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a wallet not on the allow-list', () => {
    process.env.ADMIN_WALLETS = ADMIN;
    const req = makeReq({ header: OTHER });
    const res = makeRes();
    const next = jest.fn();
    requireAdmin(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/not an administrator/i);
    expect(next).not.toHaveBeenCalled();
  });

  it('passes an admin wallet from the x-wallet header', () => {
    process.env.ADMIN_WALLETS = ADMIN;
    const req = makeReq({ header: ADMIN });
    const res = makeRes();
    const next = jest.fn();
    requireAdmin(req, res, next);
    expect(res.statusCode).toBe(200);
    expect(next).toHaveBeenCalled();
    expect(req.adminWallet).toBe(ADMIN);
  });

  it('matches wallets case-insensitively', () => {
    process.env.ADMIN_WALLETS = ADMIN;
    const req = makeReq({ header: ADMIN.toUpperCase() });
    const res = makeRes();
    const next = jest.fn();
    requireAdmin(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('falls back to ?wallet= query param', () => {
    process.env.ADMIN_WALLETS = ADMIN;
    const req = makeReq({ query: { wallet: ADMIN } });
    const res = makeRes();
    const next = jest.fn();
    requireAdmin(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});

describe('adminAuth.isAdminWallet', () => {
  const original = process.env.ADMIN_WALLETS;

  afterEach(() => {
    if (original === undefined) delete process.env.ADMIN_WALLETS;
    else process.env.ADMIN_WALLETS = original;
  });

  it('returns true for an allow-listed wallet', () => {
    process.env.ADMIN_WALLETS = ADMIN;
    expect(isAdminWallet(ADMIN)).toBe(true);
  });

  it('returns false for a non-allow-listed wallet', () => {
    process.env.ADMIN_WALLETS = ADMIN;
    expect(isAdminWallet(OTHER)).toBe(false);
  });

  it('returns false when ADMIN_WALLETS is unset', () => {
    delete process.env.ADMIN_WALLETS;
    expect(isAdminWallet(ADMIN)).toBe(false);
  });
});
