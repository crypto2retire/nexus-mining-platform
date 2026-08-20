jest.mock('../config/db', () => ({
  pool: {
    query: jest.fn(),
    connect: jest.fn(),
  },
}));

const express = require('express');
const { Wallet } = require('ethers');
const jwt = require('jsonwebtoken');
const { pool } = require('../config/db');
const {
  createChallenge,
  verifySignature,
  getWalletFromToken,
} = require('../services/authService');
const { requireAuth } = require('../middleware/auth');
const { requireAdminKey } = require('../middleware/adminAuth');

const TEST_SECRET = 'test-jwt-secret-that-is-longer-than-32-characters';

function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = jest.fn((code) => {
    res.statusCode = code;
    return res;
  });
  res.json = jest.fn((body) => {
    res.body = body;
    return res;
  });
  return res;
}

function configureNonceStore() {
  const records = [];

  pool.query.mockImplementation(async (sql, params = []) => {
    if (sql.includes('INSERT INTO auth_nonces')) {
      const record = {
        wallet_address: params[0],
        nonce: params[1],
        expires_at: new Date(Date.now() + 5 * 60 * 1000),
        used_at: null,
      };
      records.push(record);
      return { rowCount: 1, rows: [{ expires_at: record.expires_at }] };
    }
    throw new Error(`unexpected pool query: ${sql}`);
  });

  pool.connect.mockImplementation(async () => ({
    query: jest.fn(async (sql, params = []) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('FROM auth_nonces') && sql.includes('FOR UPDATE')) {
        const wallet = params[0];
        const record = [...records]
          .reverse()
          .find(
            (item) =>
              item.wallet_address === wallet &&
              item.used_at === null &&
              item.expires_at.getTime() > Date.now()
          );
        return record
          ? { rowCount: 1, rows: [{ nonce: record.nonce }] }
          : { rowCount: 0, rows: [] };
      }
      if (sql.includes('UPDATE auth_nonces SET used_at')) {
        const record = records.find((item) => item.nonce === params[0]);
        if (record) record.used_at = new Date();
        return { rowCount: record ? 1 : 0, rows: [] };
      }
      if (sql.includes('DELETE FROM auth_nonces')) {
        const index = records.findIndex((item) => item.nonce === params[0]);
        if (index >= 0) records.splice(index, 1);
        return { rowCount: index >= 0 ? 1 : 0, rows: [] };
      }
      throw new Error(`unexpected client query: ${sql}`);
    }),
    release: jest.fn(),
  }));

  return records;
}

describe('wallet authentication service', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_SECRET = TEST_SECRET;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('challenge creates a one-time 32-byte nonce that expires in five minutes', async () => {
    configureNonceStore();
    const wallet = Wallet.createRandom().address.toLowerCase();

    const before = Date.now();
    const challenge = await createChallenge(wallet);
    const after = Date.now();

    expect(challenge.nonce).toMatch(/^[a-f0-9]{64}$/);
    expect(new Date(challenge.expires_at).getTime()).toBeGreaterThanOrEqual(before + 5 * 60 * 1000);
    expect(new Date(challenge.expires_at).getTime()).toBeLessThanOrEqual(after + 5 * 60 * 1000);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("INTERVAL '5 minutes'");
    expect(params).toEqual([wallet, challenge.nonce]);
  });

  test('real signed challenge returns a JWT for the recovered wallet', async () => {
    configureNonceStore();
    const signer = Wallet.createRandom();
    const wallet = signer.address.toLowerCase();
    const challenge = await createChallenge(wallet);
    const signature = await signer.signMessage(challenge.nonce);

    const result = await verifySignature(wallet, signature);

    expect(result.wallet).toBe(wallet);
    expect(getWalletFromToken(result.token)).toBe(wallet);
    const payload = jwt.decode(result.token);
    expect(payload.wallet).toBe(wallet);
    expect(payload.exp - payload.iat).toBe(24 * 60 * 60);
  });

  test('wrong signature is rejected without consuming the nonce', async () => {
    const records = configureNonceStore();
    const owner = Wallet.createRandom();
    const attacker = Wallet.createRandom();
    const wallet = owner.address.toLowerCase();
    const challenge = await createChallenge(wallet);

    await expect(
      verifySignature(wallet, await attacker.signMessage(challenge.nonce))
    ).rejects.toThrow(/invalid wallet signature/i);
    expect(records).toHaveLength(1);
    expect(records[0].used_at).toBeNull();
  });

  test('a used nonce cannot be replayed', async () => {
    configureNonceStore();
    const signer = Wallet.createRandom();
    const wallet = signer.address.toLowerCase();
    const challenge = await createChallenge(wallet);
    const signature = await signer.signMessage(challenge.nonce);

    await verifySignature(wallet, signature);

    await expect(verifySignature(wallet, signature)).rejects.toThrow(/challenge.*expired|no active challenge/i);
  });

  test('an expired nonce cannot be verified', async () => {
    const records = configureNonceStore();
    const signer = Wallet.createRandom();
    const wallet = signer.address.toLowerCase();
    const challenge = await createChallenge(wallet);
    records[0].expires_at = new Date(Date.now() - 1);

    await expect(
      verifySignature(wallet, await signer.signMessage(challenge.nonce))
    ).rejects.toThrow(/challenge.*expired|no active challenge/i);
  });
});

describe('authentication middleware', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.JWT_SECRET = TEST_SECRET;
    process.env.ADMIN_API_KEY = 'admin-api-key-that-is-longer-than-32-characters';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('requireAuth rejects a request without a bearer token', () => {
    const req = { get: jest.fn(() => undefined) };
    const res = makeRes();
    const next = jest.fn();

    requireAuth(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Authentication required. Connect and sign your wallet.' });
    expect(next).not.toHaveBeenCalled();
  });

  test('requireAuth accepts a valid token and sets req.auth.wallet', async () => {
    configureNonceStore();
    const signer = Wallet.createRandom();
    const wallet = signer.address.toLowerCase();
    const challenge = await createChallenge(wallet);
    const { token } = await verifySignature(wallet, await signer.signMessage(challenge.nonce));
    const req = { get: jest.fn((name) => (name === 'authorization' ? `Bearer ${token}` : undefined)) };
    const res = makeRes();
    const next = jest.fn();

    requireAuth(req, res, next);

    expect(req.auth).toEqual({ wallet });
    expect(next).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['missing', undefined, 401],
    ['wrong', 'wrong-admin-key', 403],
  ])('requireAdminKey rejects a %s key', (_label, key, status) => {
    const req = { get: jest.fn((name) => (name === 'x-admin-key' ? key : undefined)) };
    const res = makeRes();
    const next = jest.fn();

    requireAdminKey(req, res, next);

    expect(res.statusCode).toBe(status);
    expect(res.body).toEqual({ error: 'Administrator authentication failed' });
    expect(next).not.toHaveBeenCalled();
  });

  test('requireAdminKey accepts the configured key', () => {
    const key = process.env.ADMIN_API_KEY;
    const req = { get: jest.fn((name) => (name === 'x-admin-key' ? key : undefined)) };
    const res = makeRes();
    const next = jest.fn();

    requireAdminKey(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('money route authentication boundary', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = TEST_SECRET;
  });

  async function startApi() {
    const router = require('../routes/api');
    const app = express();
    app.use(express.json());
    app.use('/api', router);
    const server = app.listen(0);
    return {
      server,
      baseUrl: `http://127.0.0.1:${server.address().port}/api`,
    };
  }

  test('POST /api/auth/verify returns 401 for a signature from the wrong wallet', async () => {
    configureNonceStore();
    const owner = Wallet.createRandom();
    const attacker = Wallet.createRandom();
    const { server, baseUrl } = await startApi();

    try {
      const challengeResponse = await fetch(`${baseUrl}/auth/challenge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: owner.address }),
      });
      const challenge = await challengeResponse.json();
      const response = await fetch(`${baseUrl}/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet: owner.address,
          signature: await attacker.signMessage(challenge.nonce),
        }),
      });

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: 'Invalid wallet signature' });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('POST /api/rewards/claim rejects a request without a token', async () => {
    const { server, baseUrl } = await startApi();

    try {
      const response = await fetch(`${baseUrl}/rewards/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        error: 'Authentication required. Connect and sign your wallet.',
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
