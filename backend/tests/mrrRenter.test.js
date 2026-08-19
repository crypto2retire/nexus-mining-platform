jest.mock('axios');

const crypto = require('crypto');
const axios = require('axios');

const {
  buildMrrSignature,
  placeHashpowerOrder,
  findAffordableRig,
  makeMrrRequest,
  isLiveMode,
  POOL_ALGORITHM_MAP,
  PROVIDER_NAME,
  LIVE_ORDERS_ENV,
} = require('../services/mrrRenter');

const REAL_ENV = { ...process.env };

function setEnv(overrides = {}) {
  const values = {
    NODE_ENV: overrides.NODE_ENV ?? 'development',
    MRR_API_KEY: overrides.API_KEY ?? 'test-mrr-key',
    MRR_API_SECRET: overrides.API_SECRET ?? 'test-mrr-secret',
    MRR_LIVE_ORDERS: overrides.LIVE_ORDERS ?? '0',
    MRR_POOL_PROFILE_ZHASH: overrides.PROFILE_ZHASH ?? '',
  };
  for (const [name, value] of Object.entries(values)) {
    process.env[name] = value;
  }
}

afterEach(() => {
  process.env = { ...REAL_ENV };
  jest.clearAllMocks();
});

describe('buildMrrSignature (MRR API v2 HMAC-SHA1)', () => {
  test('concatenates apiKey + nonce + endpoint (no separators) and is deterministic', () => {
    const apiKey = 'test-api-key';
    const nonce = '12345';
    const endpoint = '/rig/14';
    const apiSecret = 'test-api-secret';

    // Independent construction per MRR docs: sign "APIKEY12345/rig/14"
    const expected = crypto
      .createHmac('sha1', apiSecret)
      .update(apiKey + nonce + endpoint, 'utf-8')
      .digest('hex');

    const actual = buildMrrSignature({ apiKey, nonce, endpoint, apiSecret });

    expect(actual).toBe(expected);
    expect(actual).toMatch(/^[0-9a-f]{40}$/);
  });

  test('strips trailing slashes from the endpoint before signing', () => {
    const withSlash = buildMrrSignature({
      apiKey: 'k', nonce: '1', endpoint: '/rig/14/', apiSecret: 's',
    });
    const withoutSlash = buildMrrSignature({
      apiKey: 'k', nonce: '1', endpoint: '/rig/14', apiSecret: 's',
    });
    expect(withSlash).toBe(withoutSlash);
  });
});

describe('isLiveMode (MRR safety rail)', () => {
  test('false without keys', () => {
    setEnv({ API_KEY: '', API_SECRET: '' });
    expect(isLiveMode()).toBe(false);
  });

  test('false without MRR_LIVE_ORDERS=1', () => {
    setEnv({ LIVE_ORDERS: '0' });
    expect(isLiveMode()).toBe(false);
  });

  test('false outside production even with keys + opt-in', () => {
    setEnv({ NODE_ENV: 'development', LIVE_ORDERS: '1' });
    expect(isLiveMode()).toBe(false);
  });

  test('true with keys + opt-in + production', () => {
    setEnv({ NODE_ENV: 'production', LIVE_ORDERS: '1' });
    expect(isLiveMode()).toBe(true);
  });
});

describe('placeHashpowerOrder (MRR)', () => {
  test('sandbox mode in development: simulated order, no network calls', async () => {
    setEnv();
    const result = await placeHashpowerOrder('ZCASH', 0.000475);
    expect(result.success).toBe(true);
    expect(result.mode).toBe('sandbox');
    expect(result.sandbox).toBe(true);
    expect(result.orderId).toMatch(/^sandbox-mrr-/);
    expect(axios).not.toHaveBeenCalled();
  });

  test('production without MRR_LIVE_ORDERS refuses to silently simulate', async () => {
    setEnv({ NODE_ENV: 'production', LIVE_ORDERS: '0' });
    const result = await placeHashpowerOrder('KASPA', 0.000475);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/MRR_LIVE_ORDERS/);
    expect(axios).not.toHaveBeenCalled();
  });

  test('rejects unknown target pools', async () => {
    setEnv();
    const result = await placeHashpowerOrder('DOGE', 1);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Unknown target pool/);
  });

  test('POOL_ALGORITHM_MAP covers all marketplace pools (uppercase audit values)', () => {
    expect(POOL_ALGORITHM_MAP).toEqual({
      ZCASH: 'ZHASH',
      KASPA: 'KHEAVYHASH',
      LTC_DOGE: 'SCRYPT',
      XMR: 'RANDOMX',
    });
  });

  test('live order: finds cheapest affordable rig and posts the rental', async () => {
    setEnv({ NODE_ENV: 'production', LIVE_ORDERS: '1', PROFILE_ZHASH: '40073' });
    axios.mockImplementation(({ method, url, data }) => {
      if (url.includes('/rig') && method === 'GET') {
        return Promise.resolve({
          data: {
            success: true,
            data: {
              records: [
                {
                  id: '274435',
                  name: 'Cheap Zhash Rig',
                  rpi: '98.5',
                  price: { BTC: { hour: '0.000002181767' } },
                  minhours: 24,
                  maxhours: 120,
                  hashrate: { advertised: { nice: '30.00M' } },
                },
              ],
            },
          },
        });
      }
      if (url.endsWith('/rental') && method === 'PUT') {
        // Correct MRR v2 rental shape (per apidoc): PUT /rental with
        // {rig, length, profile, currency}. The renter extends the rental
        // to spend the user budget but is capped by MRR_MAX_RENTAL_HOURS
        // (default 72): 0.000475 / 0.000002181767/h ≈ 217h → capped to 72.
        expect(JSON.parse(data).rig).toBe('274435');
        expect(JSON.parse(data).length).toBe(72);
        expect(JSON.parse(data).profile).toBe('40073');
        expect(JSON.parse(data).currency).toBe('BTC');
        return Promise.resolve({
          data: { success: true, data: { rental: { id: 'rental-999' } } },
        });
      }
      return Promise.reject(new Error(`unexpected call ${method} ${url}`));
    });

    const result = await placeHashpowerOrder('ZCASH', 0.000475);
    expect(result.success).toBe(true);
    expect(result.mode).toBe('live');
    expect(result.orderId).toBe('rental-999');
    expect(result.rigName).toBe('Cheap Zhash Rig');
    expect(result.rigRpi).toBe(98.5);
    expect(result.rigHours).toBe(72);

    // GET (market scan) + PUT (rental) — and GET carried no body data.
    const getCall = axios.mock.calls.find(([c]) => c.method === 'GET');
    expect(getCall[0].data).toBeUndefined();
  });

  test('live order: rejects when the cheapest rig minimum exceeds the budget', async () => {
    setEnv({ NODE_ENV: 'production', LIVE_ORDERS: '1', PROFILE_ZHASH: '40073' });
    axios.mockImplementation(({ method, url }) => {
      if (method === 'GET') {
        return Promise.resolve({
          data: {
            success: true,
            data: {
              records: [
                {
                  id: 'expensive',
                  name: 'Expensive Zhash Rig',
                  price: { BTC: { hour: '0.01' } },
                  minhours: 6,
                  maxhours: 120,
                },
              ],
            },
          },
        });
      }
      return Promise.reject(new Error('must not place an order'));
    });

    const result = await placeHashpowerOrder('ZCASH', 0.000475);
    expect(result.success).toBe(false);
    expect(result.mode).toBe('live');
    expect(result.error).toMatch(/No affordable/);
    // Only the market scan happened — no rental PUT.
    expect(axios.mock.calls.every(([c]) => c.method === 'GET')).toBe(true);
  });

  test('live order: surfaces MRR rental rejection instead of false success', async () => {
    setEnv({ NODE_ENV: 'production', LIVE_ORDERS: '1', PROFILE_ZHASH: '40073' });
    axios.mockImplementation(({ method, url }) => {
      if (method === 'GET') {
        return Promise.resolve({
          data: {
            success: true,
            data: {
              records: [
                {
                  id: '274435',
                  name: 'Cheap Zhash Rig',
                  price: { BTC: { hour: '0.000002181767' } },
                  minhours: 24,
                  maxhours: 120,
                  hashrate: { advertised: { nice: '30.00M' } },
                },
              ],
            },
          },
        });
      }
      if (url.endsWith('/rental') && method === 'PUT') {
        return Promise.resolve({
          data: { success: false, data: { message: 'Rig is already rented' } },
        });
      }
      return Promise.reject(new Error(`unexpected call ${method} ${url}`));
    });

    const result = await placeHashpowerOrder('ZCASH', 0.000475);
    expect(result.success).toBe(false);
    expect(result.mode).toBe('live');
    expect(result.error).toMatch(/already rented/);
    expect(result.orderId).toBeUndefined();
  });

  test('live order: requires a configured pool profile for the algorithm', async () => {
    setEnv({ NODE_ENV: 'production', LIVE_ORDERS: '1', PROFILE_ZHASH: '' });
    const result = await placeHashpowerOrder('ZCASH', 0.000475);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/MRR_POOL_PROFILE_ZHASH/);
    expect(axios).not.toHaveBeenCalled();
  });

  test('live order: surfaces API errors without throwing', async () => {
    setEnv({ NODE_ENV: 'production', LIVE_ORDERS: '1', PROFILE_ZHASH: '40073' });
    axios.mockRejectedValue({ response: { data: { data: { message: 'Insufficient balance' } } } });
    const result = await placeHashpowerOrder('ZCASH', 0.000475);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Insufficient balance/);
  });
});

describe('findAffordableRig', () => {
  test('picks the cheapest eligible rig, capped at MRR_MAX_RENTAL_HOURS (72)', async () => {
    axios.mockResolvedValue({
      data: {
        success: true,
        data: {
          records: [
            { id: 'a', price: { BTC: { hour: '0.000002' } }, minhours: 6, maxhours: 120 },
            { id: 'b', price: { BTC: { hour: '0.000010' } }, minhours: 3, maxhours: 24 },
          ],
        },
      },
    });
    const fit = await findAffordableRig('zhash', 0.000475);
    expect(fit.rigId).toBe('a');
    // 0.000475 / 0.000002 = 237h -> capped at MAX_RENTAL_HOURS 72 (not maxhours 120)
    expect(fit.length).toBe(72);
    expect(fit.cost).toBe(0.000144);
  });

  test('skips untested rigs (rpi "new") and the known-idle RPI-100+ family', async () => {
    axios.mockResolvedValue({
      data: {
        success: true,
        data: {
          records: [
            { id: 'newrig', rpi: 'new', price: { BTC: { hour: '0.0000001' } }, minhours: 3, maxhours: 24 },
            { id: 'rpifam', name: 'ZHASH___RPI-100+___AUTOEXTEND___AUTOSTART___3', rpi: '97.37', price: { BTC: { hour: '0.0000001' } }, minhours: 3, maxhours: 24 },
            { id: 'good', rpi: '98.00', price: { BTC: { hour: '0.000001' } }, minhours: 3, maxhours: 24 },
          ],
        },
      },
    });
    const fit = await findAffordableRig('zhash', 0.000475);
    expect(fit.rigId).toBe('good');
    expect(fit.rigRpi).toBe(98);
  });

  test('prefers a verified high-rpi rig over a cheaper low-rpi rig', async () => {
    axios.mockResolvedValue({
      data: {
        success: true,
        data: {
          records: [
            { id: 'low', rpi: '80.00', price: { BTC: { hour: '0.0000005' } }, minhours: 3, maxhours: 24 },
            { id: 'high', rpi: '99.00', price: { BTC: { hour: '0.000002' } }, minhours: 3, maxhours: 24 },
          ],
        },
      },
    });
    const fit = await findAffordableRig('zhash', 0.000475);
    expect(fit.rigId).toBe('high');
    expect(fit.rigRpi).toBe(99);
  });

  test('falls back to unknown-rpi rigs when no verified rig fits', async () => {
    axios.mockResolvedValue({
      data: {
        success: true,
        data: {
          records: [
            { id: 'unknown', price: { BTC: { hour: '0.000002' } }, minhours: 3, maxhours: 24 },
          ],
        },
      },
    });
    const fit = await findAffordableRig('zhash', 0.000475);
    expect(fit.rigId).toBe('unknown');
    expect(fit.rigRpi).toBeNull();
  });

  test('returns null when no rig fits the budget', async () => {
    axios.mockResolvedValue({
      data: {
        success: true,
        data: {
          records: [
            { id: 'a', price: { BTC: { hour: '0.01' } }, minhours: 6, maxhours: 120 },
          ],
        },
      },
    });
    const fit = await findAffordableRig('zhash', 0.000475);
    expect(fit).toBeNull();
  });

  test('skips candidates whose total cost is below the MRR order minimum (code 104 floor)', async () => {
    axios.mockResolvedValue({
      data: {
        success: true,
        data: {
          records: [
            // 24h x 3.7e-8 = 8.88e-7 BTC < 0.000001 -> MRR rejects with code 104
            { id: 'too-cheap', rpi: '99.00', price: { BTC: { hour: '0.000000037' } }, minhours: 24, maxhours: 24 },
            // 24h x 1e-7 = 2.4e-6 BTC >= 0.000001 -> placeable
            { id: 'placeable', rpi: '98.00', price: { BTC: { hour: '0.0000001' } }, minhours: 3, maxhours: 24 },
          ],
        },
      },
    });
    const fit = await findAffordableRig('kheavyhash', 0.00008);
    expect(fit.rigId).toBe('placeable');
  });
});

describe('makeMrrRequest', () => {
  test('GET requests do not carry a data payload (malformed-payload pitfall)', async () => {
    axios.mockResolvedValue({ data: { success: true } });
    await makeMrrRequest('GET', '/info/algos');
    const call = axios.mock.calls[0][0];
    expect(call.method).toBe('GET');
    expect(call.data).toBeUndefined();
    expect(call.headers['x-api-nonce']).toBeTruthy();
    expect(call.headers['x-api-sign']).toMatch(/^[0-9a-f]{40}$/);
  });

  test('nonce strictly increases between calls', async () => {
    axios.mockResolvedValue({ data: { success: true } });
    await makeMrrRequest('GET', '/info/algos');
    await makeMrrRequest('GET', '/info/algos');
    const [first, second] = axios.mock.calls.map(([c]) => c.headers['x-api-nonce']);
    expect(Number(second)).toBeGreaterThan(Number(first));
  });

  test('PUT requests attach the JSON body', async () => {
    axios.mockResolvedValue({ data: {} });
    await makeMrrRequest('PUT', '/rental', null, { rig: 123, length: 6, profile: 'p1' });
    const call = axios.mock.calls.find(([c]) => c.method === 'PUT');
    expect(call[0].data).toBe('{"rig":123,"length":6,"profile":"p1"}');
  });
});

describe('provider metadata', () => {
  test('exports provider name + live-orders env for the controller safety rail', () => {
    expect(PROVIDER_NAME).toBe('MRR');
    expect(LIVE_ORDERS_ENV).toBe('MRR_LIVE_ORDERS');
  });
});
