/**
 * Outbound miner push tests (012) — status cache freshness/staleness,
 * push-key authorization, and the command queue lifecycle.
 */
const { pushStatus, getCachedStatus, authorizePushKey, enqueueCommand, listPendingCommands, completeCommand } = require('../services/minerPush');
const { getMinerStatus, mapSummary, PUSH_STALE_MS } = require('../services/minerMonitor');

function makeReq(key) {
  return { get: (name) => (name === 'x-push-key' ? key : undefined) };
}

function makeClient() {
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('INSERT INTO miner_commands')) {
        return { rows: [{ id: 42, action: params[0], params: params[1] || '{}', status: 'pending', created_at: new Date() }] };
      }
      if (sql.includes('UPDATE miner_commands')) {
        return { rows: [{ id: params[0], status: params[1] === 'done' ? 'done' : 'failed' }] };
      }
      if (sql.includes('SELECT id, action')) {
        return { rows: [{ id: 1, action: 'start', params: {}, status: 'pending', created_at: new Date() }] };
      }
      return { rows: [] };
    },
  };
  client.calls = calls;
  return client;
}

describe('minerPush cache', () => {
  beforeEach(() => {
    // Reset module state between tests.
    pushStatus({ online: true, hashrate_10s: 100 });
  });

  it('stores a pushed status with a server-side pushed_at timestamp', () => {
    const cached = getCachedStatus();
    expect(cached.hashrate_10s).toBe(100);
    expect(cached.pushed_at).toEqual(expect.any(Number));
  });
});

describe('minerMonitor status freshness', () => {
  let nowSpy;
  const now = Date.now();

  beforeEach(() => {
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  it('returns live (stale:false) for a fresh push', async () => {
    pushStatus({ online: true, hashrate_10s: 321 });
    const status = await getMinerStatus();
    expect(status.online).toBe(true);
    expect(status.stale).toBe(false);
    expect(status.hashrate_10s).toBe(321);
    expect(status.last_seen_seconds).toBe(0);
  });

  it('flags a stale push as last-known-good instead of offline', async () => {
    pushStatus({ online: true, hashrate_10s: 321 });
    nowSpy.mockReturnValue(now + PUSH_STALE_MS + 30000); // 75s later
    const status = await getMinerStatus();
    expect(status.online).toBe(true); // last-known-good, not a false OFFLINE
    expect(status.stale).toBe(true);
    expect(status.last_seen_seconds).toBe(75);
    expect(status.hashrate_10s).toBe(321);
  });

  it('keeps an explicitly-pushed offline as OFFLINE (honest stop)', async () => {
    // The Mac pushes {online:false} when XMRig is stopped/crashed — the
    // dashboard must show OFFLINE, not last-known-good.
    pushStatus({ online: false, error: 'ECONNREFUSED', fetched_at: Date.now() });
    nowSpy.mockReturnValue(now + PUSH_STALE_MS + 30000); // even when stale
    const status = await getMinerStatus();
    expect(status.online).toBe(false);
    expect(status.error).toBe('ECONNREFUSED');
  });

  it('falls back to a direct fetch when no push has ever arrived', async () => {
    // A fresh module instance has an empty cache (pushStatus(undefined) would
    // still create a cache entry — pushed_at only). isolateModules resets the
    // module registry so getCachedStatus() returns null and fetchDirect runs.
    await jest.isolateModules(async () => {
      const fresh = require('../services/minerMonitor');
      const axios = require('axios');
      const getSpy = jest.spyOn(axios, 'get').mockRejectedValue({ code: 'ECONNREFUSED' });
      try {
        const status = await fresh.getMinerStatus();
        expect(status.online).toBe(false);
        expect(status.error).toBe('ECONNREFUSED');
      } finally {
        getSpy.mockRestore();
      }
    });
  });

  it('maps an XMRig summary into the push payload shape', () => {
    const d = {
      hashrate: { total: [10, 20, 30] },
      results: { shares_good: 5, shares_total: 6, hashes_total: 1000, avg_time_ms: 123 },
      algo: 'rx/0',
      pool: 'herominers',
      uptime: 99,
      worker_id: 'macmini',
    };
    const m = mapSummary(d, 111);
    expect(m.hashrate_10s).toBe(10);
    expect(m.shares_good).toBe(5);
    expect(m.algo).toBe('rx/0');
    expect(m.fetched_at).toBe(111);
  });
});

describe('minerPush authorizePushKey', () => {
  const original = process.env.MINER_PUSH_KEY;

  afterEach(() => {
    if (original === undefined) delete process.env.MINER_PUSH_KEY;
    else process.env.MINER_PUSH_KEY = original;
  });

  it('fails closed when MINER_PUSH_KEY is not configured', () => {
    delete process.env.MINER_PUSH_KEY;
    expect(authorizePushKey(makeReq('anything'))).toBe(false);
  });

  it('rejects a missing key', () => {
    process.env.MINER_PUSH_KEY = 'secret123';
    expect(authorizePushKey(makeReq(''))).toBe(false);
  });

  it('rejects a wrong key', () => {
    process.env.MINER_PUSH_KEY = 'secret123';
    expect(authorizePushKey(makeReq('wrong'))).toBe(false);
  });

  it('accepts the correct key', () => {
    process.env.MINER_PUSH_KEY = 'secret123';
    expect(authorizePushKey(makeReq('secret123'))).toBe(true);
  });
});

describe('miner_commands queue', () => {
  it('enqueues a command with params', async () => {
    const client = makeClient();
    const row = await enqueueCommand(client, 'switch', { symbol: 'ZEC' });
    expect(row.id).toBe(42);
    expect(row.action).toBe('switch');
  });

  it('lists pending commands', async () => {
    const client = makeClient();
    const commands = await listPendingCommands(client);
    expect(commands).toHaveLength(1);
    expect(commands[0].action).toBe('start');
  });

  it('completes a command as done', async () => {
    const client = makeClient();
    const row = await completeCommand(client, 7, true, { started: true });
    expect(row.status).toBe('done');
  });

  it('completes a failed command with the error captured', async () => {
    const client = makeClient();
    const row = await completeCommand(client, 7, false, null, 'boom');
    expect(row.status).toBe('failed');
    const update = client.calls.find((c) => c.sql.includes('UPDATE miner_commands'));
    expect(update.params[2]).toContain('boom');
  });
});
