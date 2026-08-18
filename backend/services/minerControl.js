const { spawn, exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Miner control — starts and stops the local XMRig process.
 *
 * Local mode (this server runs the miner):
 *   XMRIG_DIR, XMRIG_CONFIG  → spawn/kill the miner directly
 * Remote mode (this server proxies to the machine that runs the miner):
 *   MINER_CONTROL_URL + MINER_CONTROL_KEY → POST to the remote control endpoint
 *
 * The control endpoint is protected by MINER_CONTROL_KEY (sent as
 * `x-miner-control-key`). If unset, control is allowed only from localhost.
 */

const DEFAULT_DIR = path.join(os.homedir(), 'xmrig-test', 'xmrig-6.26.0');
const DEFAULT_CONFIG = path.join(os.homedir(), 'xmrig-test', 'config-xmr.json');
const LOG_FILE = process.env.XMRIG_LOG || '/tmp/xmrig.log';

function isLocalMiner() {
  return Boolean(process.env.XMRIG_DIR) || fs.existsSync(path.join(DEFAULT_DIR, 'xmrig'));
}

function isRunning() {
  return new Promise((resolve) => {
    exec('pgrep -f "xmrig -c" >/dev/null 2>&1', (err) => resolve(err === null));
  });
}

function startLocal() {
  return new Promise((resolve, reject) => {
    const dir = process.env.XMRIG_DIR || DEFAULT_DIR;
    const config = process.env.XMRIG_CONFIG || DEFAULT_CONFIG;
    const bin = path.join(dir, 'xmrig');
    if (!fs.existsSync(bin)) {
      return reject(new Error(`XMRig binary not found at ${bin}`));
    }
    const logFd = fs.openSync(LOG_FILE, 'a');
    const child = spawn(bin, ['-c', config], {
      cwd: dir,
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    child.unref();
    // Give it a moment to start, then confirm.
    setTimeout(async () => {
      try {
        const running = await isRunning();
        resolve({ started: running, pid: child.pid });
      } catch (e) {
        reject(e);
      }
    }, 3000);
  });
}

function stopLocal() {
  return new Promise((resolve, reject) => {
    exec('pkill -f "xmrig -c"', (err) => {
      if (err && err.code !== 1) return reject(err); // exit 1 = no process, fine
      resolve({ stopped: true });
    });
  });
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

module.exports = { startMiner, stopMiner, startLocal, stopLocal, isRunning, isLocalMiner, authorizeControl, LOG_FILE };
