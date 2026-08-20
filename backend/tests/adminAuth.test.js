const { requireAdminKey } = require('../middleware/adminAuth');

function makeReq(key) {
  return {
    get(name) {
      return name === 'x-admin-key' ? key : undefined;
    },
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

describe('adminAuth.requireAdminKey', () => {
  const original = process.env.ADMIN_API_KEY;

  afterEach(() => {
    if (original === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = original;
  });

  it('fails closed when ADMIN_API_KEY is not configured', () => {
    delete process.env.ADMIN_API_KEY;
    const res = makeRes();
    const next = jest.fn();

    requireAdminKey(makeReq('any-value'), res, next);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Administrator authentication failed' });
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a missing key', () => {
    process.env.ADMIN_API_KEY = 'configured-admin-key';
    const res = makeRes();
    const next = jest.fn();

    requireAdminKey(makeReq(undefined), res, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects the wrong key', () => {
    process.env.ADMIN_API_KEY = 'configured-admin-key';
    const res = makeRes();
    const next = jest.fn();

    requireAdminKey(makeReq('wrong-key'), res, next);

    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('accepts the configured key', () => {
    process.env.ADMIN_API_KEY = 'configured-admin-key';
    const res = makeRes();
    const next = jest.fn();

    requireAdminKey(makeReq('configured-admin-key'), res, next);

    expect(res.statusCode).toBe(200);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
