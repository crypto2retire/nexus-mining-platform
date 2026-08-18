const axios = require('axios');

/**
 * Live miner monitor — proxies the local XMRig HTTP API (or any miner API
 * exposing the XMRig /summary shape) so the dashboard can display live mining
 * stats without CORS issues.
 *
 * Configure the source URL with XMRIG_API_URL (default: local XMRig on :8080).
 */

const DEFAULT_XMRIG_URL = 'http://127.0.0.1:8080/1/summary';

async function getMinerStatus() {
  const url = process.env.XMRIG_API_URL || DEFAULT_XMRIG_URL;
  try {
    const response = await axios.get(url, { timeout: 5000 });
    const d = response.data || {};
    return {
      online: true,
      source: url,
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
      fetched_at: Date.now(),
    };
  } catch (err) {
    return {
      online: false,
      source: url,
      error: err.code || err.message,
      fetched_at: Date.now(),
    };
  }
}

module.exports = { getMinerStatus, DEFAULT_XMRIG_URL };
