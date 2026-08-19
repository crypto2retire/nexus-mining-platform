/**
 * Miner agent — runs on the Mac (launchd: com.nexus.miner-agent).
 *
 * Replaces the reverse-SSH-tunnel dependency (2026-08-19):
 *   1. Every POLL_MS, read the LOCAL XMRig status and PUSH it to the droplet
 *      (outbound HTTPS — works through any NAT/Wi-Fi/ISP change).
 *   2. Every POLL_MS, POLL the droplet for queued start/stop/switch commands
 *      and execute them locally via the Mac backend's /api/miner/control/*.
 *
 * Env (from backend/.env via dotenv, or launchd EnvironmentVariables):
 *   MINER_PUSH_KEY   shared secret with the droplet (REQUIRED)
 *   MINER_AGENT_URL  droplet base URL (default http://146.190.79.225)
 *   XMRIG_API_TOKEN  XMRig HTTP API token (for the local :8080 read)
 *   MINER_CONTROL_KEY key for the local control endpoints (optional — localhost is allowed)
 *   LOCAL_BACKEND    Mac backend base URL (default http://127.0.0.1:3999)
 *   MINER_STATUS_URL local XMRig API (default http://127.0.0.1:8080/1/summary)
 */

require('dotenv').config();
const axios = require('axios');

const POLL_MS = 15000;
const DROPLET = (process.env.MINER_AGENT_URL || 'http://146.190.79.225').replace(/\/$/, '');
const LOCAL = (process.env.LOCAL_BACKEND || 'http://127.0.0.1:3999').replace(/\/$/, '');
const STATUS_URL = process.env.MINER_STATUS_URL || 'http://127.0.0.1:8080/1/summary';
const PUSH_KEY = process.env.MINER_PUSH_KEY;
const TOKEN = process.env.XMRIG_API_TOKEN;
const CONTROL_KEY = process.env.MINER_CONTROL_KEY;

const PUSH_HEADERS = PUSH_KEY ? { 'x-push-key': PUSH_KEY } : {};
const CONTROL_HEADERS = CONTROL_KEY ? { 'x-miner-control-key': CONTROL_KEY } : {};

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function mapSummary(d) {
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
    fetched_at: Date.now(),
  };
}

async function pushStatus() {
  try {
    const headers = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
    const r = await axios.get(STATUS_URL, { headers, timeout: 5000 });
    const payload = mapSummary(r.data);
    await axios.post(`${DROPLET}/api/miner/push`, payload, { headers: PUSH_HEADERS, timeout: 8000 });
  } catch (err) {
    // Don't spam the log every 15s while the miner is simply stopped —
    // only log when the LOCAL status call itself fails.
    log('status push failed:', err.code || err.message);
  }
}

async function pollCommands() {
  try {
    const r = await axios.get(`${DROPLET}/api/miner/commands`, { headers: PUSH_HEADERS, timeout: 8000 });
    const commands = r.data?.commands || [];
    for (const cmd of commands) {
      await executeCommand(cmd);
    }
  } catch (err) {
    log('command poll failed:', err.code || err.message);
  }
}

async function executeCommand(cmd) {
  try {
    let out;
    if (cmd.action === 'switch') {
      out = await axios.post(
        `${LOCAL}/api/miner/control/switch`,
        { symbol: cmd.params?.symbol },
        { headers: CONTROL_HEADERS, timeout: 90000 }
      );
    } else if (cmd.action === 'start') {
      out = await axios.post(`${LOCAL}/api/miner/control/start`, {}, { headers: CONTROL_HEADERS, timeout: 30000 });
    } else if (cmd.action === 'stop') {
      out = await axios.post(`${LOCAL}/api/miner/control/stop`, {}, { headers: CONTROL_HEADERS, timeout: 30000 });
    } else {
      throw new Error(`unknown action: ${cmd.action}`);
    }
    await axios.post(
      `${DROPLET}/api/miner/command-result`,
      { command_id: cmd.id, ok: true, result: out.data },
      { headers: PUSH_HEADERS, timeout: 8000 }
    );
    log(`command ${cmd.id} (${cmd.action}) done`);
  } catch (err) {
    try {
      await axios.post(
        `${DROPLET}/api/miner/command-result`,
        { command_id: cmd.id, ok: false, error: err.message },
        { headers: PUSH_HEADERS, timeout: 8000 }
      );
    } catch (_) { /* result reporting is best-effort */ }
    log(`command ${cmd.id} (${cmd.action}) failed:`, err.message);
  }
}

function start() {
  if (!PUSH_KEY) {
    log('FATAL: MINER_PUSH_KEY is not set — agent refusing to start');
    process.exit(1);
  }
  log(`miner agent started (push to ${DROPLET}, poll ${POLL_MS}ms)`);
  pushStatus();
  pollCommands();
  setInterval(pushStatus, POLL_MS);
  setInterval(pollCommands, POLL_MS);
}

start();
