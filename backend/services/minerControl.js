const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Miner control — starts and stops the local XMRig process (via launchd).
 *
 * Local mode (this server runs the miner):
 *   the miner is a launchd agent (com.nexus.xmrig) — start/stop bootstrap /
 *   bootout the job, so Stop stays stopped and Start auto-heals on crash.
 * Remote mode (this server proxies to the machine that runs the miner):
 *   MINER_CONTROL_URL + MINER_CONTROL_KEY → POST to the remote control endpoint
 *
 * The control endpoint is protected by MINER_CONTROL_KEY (sent as
 * `x-miner-control-key`). If unset, control is allowed only from localhost.
 */

const DEFAULT_DIR = path.join(os.homedir(), 'xmrig-test', 'xmrig-6.26.0');
const DEFAULT_CONFIG = path.join(os.homedir(), 'xmrig-test', 'config-xmr.json');
const LOG_FILE = process.env.XMRIG_LOG || '/tmp/xmrig.log';

// The miner runs as a launchd agent (com.nexus.xmrig, KeepAlive=true) so it
// survives reboots and auto-restarts on crash. Start/Stop therefore control
// the launchd job instead of raw pkill/spawn:
//   stop  → launchctl bootout   (job unloaded — stays stopped)
//   start → launchctl bootstrap (job loaded — runs + auto-heals)
const LAUNCHD_LABEL = 'com.nexus.xmrig';
const LAUNCHD_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
// The config the launchd job always runs (coin switching rewrites this file).
const ACTIVE_CONFIG = process.env.XMRIG_CONFIG || DEFAULT_CONFIG;

function isLocalMiner() {
  return Boolean(process.env.XMRIG_DIR) || fs.existsSync(path.join(DEFAULT_DIR, 'xmrig'));
}

function isRunning() {
  return new Promise((resolve) => {
    exec('pgrep -f "xmrig -c" >/dev/null 2>&1', (err) => resolve(err === null));
  });
}

function startLocal() {
  return new Promise((resolve) => {
    exec(`launchctl bootstrap gui/$(id -u) ${LAUNCHD_PLIST}`, () => {
      // 'already loaded' errors are fine — the job is what we want.
      setTimeout(async () => {
        try {
          const running = await isRunning();
          resolve({ started: running, source: 'launchd' });
        } catch (e) {
          resolve({ started: false, source: 'launchd', error: e.message });
        }
      }, 3000);
    });
  });
}

function stopLocal() {
  return new Promise((resolve) => {
    exec(`launchctl bootout gui/$(id -u)/${LAUNCHD_LABEL}`, () => {
      // 'service not loaded' errors are fine — the job is already stopped.
      resolve({ stopped: true, source: 'launchd' });
    });
  });
}

/**
 * Build an XMRig config for a target coin (see coinRegistry) and write it to
 * the ACTIVE_CONFIG path the launchd job always runs
 * (default: ~/xmrig-test/config-xmr.json). Returns the config path.
 */
function writeCoinConfig(coin) {
  const fs = require('fs');
  const wallet = coin.wallet;
  if (!wallet) throw new Error(`No wallet configured for ${coin.symbol}`);
  const config = {
    autosave: false,
    background: false,
    colors: false,
    api: { id: '1', 'worker-id': 'macmini' },
    cpu: { enabled: true, priority: 1, yield: true },
    pools: [
      {
        algo: coin.algo,
        coin: coin.coin || null,
        url: coin.pool,
        user: wallet,
        pass: 'x',
        tls: false,
      },
    ],
    'print-time': 10,
    'donate-level': 1,
    http: { enabled: true, host: '127.0.0.1', port: 8080, 'access-token': process.env.XMRIG_API_TOKEN || 'nexus', restricted: false },
  };
  if (!config.pools[0].coin) delete config.pools[0].coin;
  fs.writeFileSync(ACTIVE_CONFIG, JSON.stringify(config, null, 2));
  return ACTIVE_CONFIG;
}

/**
 * Switch the local miner to a different coin.
 * Requires a verified pool + configured wallet (caller validates via coinRegistry).
 */
async function switchCoin(coin) {
  const running = await isRunning();
  if (running) await stopLocal();
  const configPath = writeCoinConfig(coin);
  // Small settle so the old process fully releases port 8080.
  await new Promise((r) => setTimeout(r, 1200));
  const result = await startLocal();
  return { ok: true, symbol: coin.symbol, pool: coin.pool, config: configPath, ...result };
}

/** Start the miner — locally or via the remote control endpoint. */
async function startMiner() {
  if (process.env.MINER_CONTROL_URL) {
    const axios = require('axios');
    const res = await axios.post(
      process.env.MINER_CONTROL_URL.replace(/\/$/, '') + '/start',
      {},
      {
        headers: { 'x-miner-control-key': process.env.MINER_CONTROL_KEY || '' },
        timeout: 15000,
      }
    );
    return res.data;
  }
  if (!isLocalMiner()) {
    return { ok: false, error: 'Miner is not hosted on this server (no MINER_CONTROL_URL configured).' };
  }
  const running = await isRunning();
  if (running) return { ok: true, alreadyRunning: true };
  return startLocal();
}

/** Stop the miner — locally or via the remote control endpoint. */
async function stopMiner() {
  if (process.env.MINER_CONTROL_URL) {
    const axios = require('axios');
    const res = await axios.post(
      process.env.MINER_CONTROL_URL.replace(/\/$/, '') + '/stop',
      {},
      {
        headers: { 'x-miner-control-key': process.env.MINER_CONTROL_KEY || '' },
        timeout: 15000,
      }
    );
    return res.data;
  }
  if (!isLocalMiner()) {
    return { ok: false, error: 'Miner is not hosted on this server (no MINER_CONTROL_URL configured).' };
  }
  return stopLocal();
}

/**
 * Control-endpoint handler (used by the server that RUNS the miner).
 * Requires MINER_CONTROL_KEY match, or localhost when unset.
 */
function authorizeControl(req) {
  const key = process.env.MINER_CONTROL_KEY;
  if (!key) {
    // No key configured: allow only loopback requests.
    const ip = req.ip || req.socket?.remoteAddress || '';
    return ip.startsWith('::1') || ip.startsWith('::ffff:127.') || ip === '127.0.0.1';
  }
  const provided = req.get('x-miner-control-key');
  return provided && provided === key;
}

module.exports = { startMiner, stopMiner, startLocal, stopLocal, switchCoin, writeCoinConfig, isRunning, isLocalMiner, authorizeControl, LOG_FILE };
