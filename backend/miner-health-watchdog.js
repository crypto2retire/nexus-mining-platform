/**
 * Miner health watchdog — alerts ONLY on state transitions.
 *
 * Prints nothing when the miner stays healthy (silent = no message),
 * prints a line when the state CHANGES (online → offline / stale, or back).
 * Run on the droplet; state persists in /tmp/miner-health-state.json.
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const STATE = '/tmp/miner-health-state.json';
const URL = 'http://127.0.0.1:3000/api/miner/status';

async function main() {
  let status;
  try {
    const r = await axios.get(URL, { timeout: 8000 });
    status = r.data;
  } catch (err) {
    status = { online: false, error: err.code || err.message };
  }

  const key = status.online ? (status.stale ? 'stale' : 'online') : 'offline';
  const now = new Date().toISOString();

  let prev = null;
  try {
    prev = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch (_) {
    /* first run */
  }

  const lines = [];
  if (!prev || prev.key !== key) {
    if (key === 'offline') {
      lines.push(`⚠️ MINER OFFLINE — ${now} (${status.error || 'XMRig unreachable'})`);
    } else if (key === 'stale') {
      lines.push(`⚠️ MINER STATUS STALE — ${now} (no agent push for ${status.last_seen_seconds}s)`);
    } else {
      lines.push(`✅ Miner back online — ${now} (${status.hashrate_10s || '?'} H/s)`);
    }
  }
  fs.writeFileSync(STATE, JSON.stringify({ key, at: now }));

  if (lines.length) process.stdout.write(lines.join('\n') + '\n');
}

main().catch((err) => {
  process.stdout.write(`⚠️ miner-health watchdog error: ${err.message}\n`);
});
