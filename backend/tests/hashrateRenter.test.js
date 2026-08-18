jest.mock('axios');

const crypto = require('crypto');
const axios = require('axios');

const {
  buildSignature,
  placeHashpowerOrder,
  isLiveMode,
  POOL_ALGORITHM_MAP,
} = require('../services/hashrateRenter');

const REAL_ENV = { ...process.env };

function setEnv(overrides = {}) {
  const values = {
    NODE_ENV: overrides.NODE_ENV ?? 'development',
    NICEHASH_ENV: overrides.ENV ?? 'main',
    NICEHASH_API_KEY: overrides.API_KEY ?? 'test-api-key',
    NICEHASH_API_SECRET: overrides.API_SECRET ?? 'test-api-secret',
    NICEHASH_ORG_ID: overrides.ORG_ID ?? 'test-org',
    NICEHASH_LIVE_ORDERS: overrides.LIVE_ORDERS ?? '0',
    NICEHASH_POOL_ID: overrides.POOL_ID ?? '',
  };
  for (const [name, value] of Object.entries(values)) {
    process.env[name] = value;
  }
}

afterEach(() => {
  process.env = { ...REAL_ENV };
  jest.clearAllMocks();
});

describe('buildSignature (NiceHash API v2 HMAC)', () => {
  test('matches the documented field layout and is deterministic', () => {
    const apiKey = 'test-api-key';
    const apiSecret = 'test-api-secret';
    const orgId = 'test-org';
    const xTime = '1700000000000';
    const xNonce = 'nonce-123';
    const method = 'POST';
    const path = '/main/api/v2/hashpower/order';
    const query = '';
    const body = '{"market":"EU"}';

    // Independent construction of the documented message:
    // apiKey \0 time \0 nonce \0 "" \0 orgId \0 "" \0 METHOD \0 path \0 query \0 body
    const parts = [apiKey, xTime, xNonce, '', orgId, '', method, path, query];
    let message = Buffer.from(parts.join('\x00'), 'utf-8');
    message = Buffer.concat([message, Buffer.from('\x00', 'utf-8'), Buffer.from(body, 'utf-8')]);
    const expected = crypto.createHmac('sha256', apiSecret).update(message).digest('hex');

    const actual = buildSignature({
      xTime,
      xNonce,
      method,
      path,
      query,
      body,
      apiKey,
      apiSecret,
      orgId,
    });

    expect(actual).toBe(expected);
    expect(actual).toMatch(/^[0-9a-f]{64}$/);
  });

  test('GET signatures omit the body field', () => {
    const sig = buildSignature({
      xTime: '1',
      xNonce: 'n',
      method: 'GET',
      path: '/main/api/v2/public/buy/info',
      query: 'algorithm=ZHASH',
      apiKey: 'k',
      apiSecret: 's',
      orgId: 'o',
    });
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('placeHashpowerOrder safety rails', () => {
  test('sandbox mode (development) simulates without touching the API', async () => {
    setEnv({ NODE_ENV: 'development' });
    const result = await placeHashpowerOrder('ZCASH', 0.000475);

    expect(result.success).toBe(true);
    expect(result.sandbox).toBe(true);
    expect(result.mode).toBe('sandbox');
    expect(result.orderId).toMatch(/^sandbox-/);
    expect(axios).not.toHaveBeenCalled();
  });

  test('production WITHOUT explicit live opt-in refuses (no silent simulation)', async () => {
    setEnv({ NODE_ENV: 'production', LIVE_ORDERS: '0' });
    const result = await placeHashpowerOrder('KASPA', 0.001);

    expect(result.success).toBe(false);
    expect(result.mode).toBe('sandbox');
    expect(result.error).toMatch(/NICEHASH_LIVE_ORDERS/);
  });

  test('production WITH opt-in and keys calls the real API with a valid payload', async () => {
    setEnv({
      NODE_ENV: 'production',
      LIVE_ORDERS: '1',
      POOL_ID: 'pool-abc-123',
    });

    axios
      .mockResolvedValueOnce({
        data: {
          miningAlgorithms: [
            {
              algorithm: 'KHEAVYHASH',
              marketFactor: '1000000000000000000.00000000',
              displayMarketFactor: 'EH',
              minimalOrderAmount: '0.00050000',
              minSpeedLimit: '0.00010000',
              maxSpeedLimit: '10000.00000000',
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: {
          miningAlgorithms: [
            { name: 'KHeavyHash', min_amount: 0.0005, min_price: 0.00005, min_limit: 0.0001 },
          ],
        },
      })
      .mockResolvedValueOnce({ data: { id: 'order-42' } });

    const result = await placeHashpowerOrder('KASPA', 0.001);

    expect(result.success).toBe(true);
    expect(result.mode).toBe('live');
    expect(result.sandbox).toBeFalsy();
    expect(result.orderId).toBe('order-42');

    expect(axios).toHaveBeenCalledTimes(3);
    const algosCall = axios.mock.calls[0][0];
    expect(algosCall.method).toBe('GET');
    expect(algosCall.url).toContain('/main/api/v2/mining/algorithms');
    const buyInfoCall = axios.mock.calls[1][0];
    expect(buyInfoCall.method).toBe('GET');
    expect(buyInfoCall.url).toContain('/main/api/v2/public/buy/info');

    const postCall = axios.mock.calls[2][0];
    expect(postCall.method).toBe('POST');
    expect(postCall.url).toBe('https://api2.nicehash.com/main/api/v2/hashpower/order/');
    const body = JSON.parse(postCall.data);
    expect(body.algorithm).toBe('KHEAVYHASH');
    expect(body.type).toBe('STANDARD');
    expect(body.poolId).toBe('pool-abc-123');
    expect(body.marketFactor).toBe(1e18);
    expect(body.displayMarketFactor).toBe('EH');
    // exact user budget — never padded up to the minimum
    expect(body.amount).toBe(0.001);
    // price must never dip below marketplace minimum
    expect(body.price).toBeGreaterThanOrEqual(0.00005);
  });

  test('TESTNET: development + NICEHASH_ENV=test + keys + opt-in places a REAL order on api-test.nicehash.com', async () => {
    setEnv({
      NODE_ENV: 'development',
      ENV: 'test',
      LIVE_ORDERS: '1',
      POOL_ID: 'pool-test-1',
    });

    axios
      .mockResolvedValueOnce({
        data: {
          miningAlgorithms: [
            {
              algorithm: 'ZHASH',
              marketFactor: '1000000.00000000',
              displayMarketFactor: 'MSol',
              minimalOrderAmount: '0.00100000',
              minSpeedLimit: '0.00100000',
              maxSpeedLimit: '10000.00000000',
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: { miningAlgorithms: [{ name: 'ZHash', min_amount: 0.001, min_price: 0.0001, min_limit: 0.001 }] },
      })
      .mockResolvedValueOnce({ data: { id: 'testnet-order-1' } });

    const result = await placeHashpowerOrder('ZCASH', 0.001);

    expect(result.success).toBe(true);
    expect(result.mode).toBe('live');
    expect(result.orderId).toBe('testnet-order-1');

    const postCall = axios.mock.calls[2][0];
    expect(postCall.url).toBe('https://api-test.nicehash.com/main/api/v2/hashpower/order/');
    const body = JSON.parse(postCall.data);
    expect(body.amount).toBe(0.001);
    expect(body.poolId).toBe('pool-test-1');
  });

  test('production live order below marketplace minimum amount is rejected (no overspend)', async () => {
    setEnv({ NODE_ENV: 'production', LIVE_ORDERS: '1', POOL_ID: 'pool-abc-123' });
    axios
      .mockResolvedValueOnce({
        data: {
          miningAlgorithms: [
            {
              algorithm: 'KHEAVYHASH',
              marketFactor: '1000000000000000000.00000000',
              displayMarketFactor: 'EH',
              minimalOrderAmount: '0.00050000',
              minSpeedLimit: '0.00010000',
              maxSpeedLimit: '10000.00000000',
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: { miningAlgorithms: [{ name: 'KHeavyHash', min_amount: 0.0005, min_price: 0.00005 }] },
      });

    const result = await placeHashpowerOrder('KASPA', 0.0001);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/minimum order amount/);
    expect(axios).toHaveBeenCalledTimes(2); // never reached the POST
  });

  test('production live order without a pool id fails with a clear error (no API calls)', async () => {
    setEnv({ NODE_ENV: 'production', LIVE_ORDERS: '1', POOL_ID: '' });

    const result = await placeHashpowerOrder('LTC_DOGE', 0.01);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/NICEHASH_POOL_ID/);
    expect(axios).not.toHaveBeenCalled();
  });

  test('isLiveMode requires every condition', () => {
    setEnv({ NODE_ENV: 'development', LIVE_ORDERS: '1' });
    expect(isLiveMode()).toBe(false);

    setEnv({ NODE_ENV: 'production', LIVE_ORDERS: '1' });
    expect(isLiveMode()).toBe(true);

    setEnv({ NODE_ENV: 'production', LIVE_ORDERS: '1', API_SECRET: '' });
    expect(isLiveMode()).toBe(false);
  });

  test('maps pools to NiceHash algorithms', () => {
    expect(POOL_ALGORITHM_MAP).toEqual({
      ZCASH: 'ZHASH',
      KASPA: 'KHEAVYHASH',
      LTC_DOGE: 'SCRYPT',
    });
  });
});
