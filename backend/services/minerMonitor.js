const axios = require('axios');
const { getCachedStatus } = require('./minerPush');

/**
 * Live miner monitor — serves the latest status PUSHED by the Mac miner
 * agent (see minerPush.js / scripts/minerAgent.js), with a fallback to
 * fetching the XMRig HTTP API directly for single-box setups.
 *
 * Data flow (2026-08-19, tunnel-independent):
 *   Mac XMRig :8080  →  minerAgent.js (outbound HTTPS)  →  POST /api/miner/push
 *   →  in-memory cache  →  GET /api/miner/status  →  LiveMinerPanel (10s poll)
 *
 * Freshness: a push arrives every ~15s. A cached status older than
 * PUSH_STALE_MS is reported stale (online:true, stale:true, last_seen_seconds)
 * so the dashboard shows last-known-good stats instead of a false OFFLINE.
 * Only when NO push has ever arrived does the old direct-fetch path run.
 */

const DEFAULT_XMRIG_URL = 'http://127.0.0.1:8080/1/summary';
const PUSH_STALE_MS = 45000; // 3 missed pushes (~15s interval)

function mapSummary(d, fetchedAt = Date.now()) {
  return {
    online: true,
    source: 'push',
    hashrate_10s: d?.hashrate?.total?.[0] ?? null,
    hashrate_60s: d?.hashrate?.total?.[1] ?? null,
    hashrate_15m: d?.hashrate?.total?.[2] ?? null,
    shares_good: d?.results?.shares_good ?? null,
    shares_total: d?.results?.shares_total ?? null,
    hashes_total: d?.results?.hashes_total ?? null,
    avg_time_ms: d?.results?.avg_time_ms ?? null,
    algo: d?.algo ?? null,
    pool: d?.pool ?? null,
    uptime: d?.uptime ?? null,
    worker_id: d?.worker_id ?? null,
    fetched_at: fetchedAt,
  };
}

async function fetchDirect() {
  const url = process.env.XMRIG_API_URL || DEFAULT_XMRIG_URL;
  const token = process.env.XMRIG_API_TOKEN;
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await axios.get(url, { headers, timeout: 5000 });
  return { ...mapSummary(response.data), source: url };
}

async function getMinerStatus() {
  const cached = getCachedStatus();
  if (cached) {
    const age = Date.now() - (cached.pushed_at || 0);
    const stale = age > PUSH_STALE_MS;
    // Respect the pushed online flag: a pushed {online:false} means the Mac
    // explicitly reported the miner stopped/crashed — that stays OFFLINE
    // (stale or not). STALE only softens a pushed online:true into
    // "last-known-good" when the agent itself has gone quiet.
    return {
      ...cached,
      online: cached.online !== false,
      stale,
      last_seen_seconds: Math.round(age / 1000),
    };
  }
  // No push ever received — fall back to the direct fetch (single-box dev).
  try {
    return await fetchDirect();
  } catch (err) {
    return {
      online: false,
      source: process.env.XMRIG_API_URL || DEFAULT_XMRIG_URL,
      error: err.code || err.message,
      fetched_at: Date.now(),
    };
  }
}

module.exports = { getMinerStatus, fetchDirect, mapSummary, DEFAULT_XMRIG_URL, PUSH_STALE_MS };
