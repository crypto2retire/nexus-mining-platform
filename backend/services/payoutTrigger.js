const axios = require('axios');
const { pool } = require('../config/db');
const { distributePayout } = require('./rewardDistributor');

/**
 * Payout trigger — watches the platform mining wallets at their pools and
 * automatically distributes newly-landed coins to players via distributePayout.
 *
 * Detection modes (all endpoints verified reachable 2026-08-19):
 *   balance-delta : ZEC/KAS at 2Miners — the accounts API `balance` field is
 *                   the wallet's confirmed balance. An increase = a payout
 *                   landed; the delta is the payout amount. A decrease means
 *                   the operator moved coins — baseline resets, no event.
 *   unpaid-drop   : XMR at herominers — the API exposes UNPAID balance only.
 *                   When unpaid crosses the pool minimum (0.1 XMR) and then
 *                   drops, the pool paid out; the drop is the payout amount.
 *                   (XMR payouts are months away at current rates — this is
 *                   a placeholder-safe heuristic.)
 *
 * LTC_DOGE is NOT auto-watched: no verified public balance API for the
 * ltc1... wallet (F2Pool lookup returns 404 for bech32 addresses) — manual
 * webhook fires for LTC until a verified endpoint exists.
 *
 * State persists in payout_watch so restarts never double-distribute.
 */

const INTERVAL_MS = Number(process.env.PAYOUT_CHECK_INTERVAL_MS || 600000); // 10 min
const XMR_MIN_PAYOUT = Number(process.env.XMR_MIN_PAYOUT || 0.1);
const EPS = 1e-8;

const WATCHES = {
  ZCASH: {
    mode: 'balance-delta',
    walletEnv: 'MRR_PLATFORM_WALLET_ZEC',
    accountUrl: (addr) => `https://zec.2miners.com/api/accounts/${addr}`,
    statsUrl: 'https://zec.2miners.com/api/stats',
    balanceOf: (d) => Number(d.balance),
    netHashOf: (d) => Number(d.nodes?.[0]?.networkhashps) || null,
  },
  KASPA: {
    mode: 'balance-delta',
    walletEnv: 'MRR_PLATFORM_WALLET_KAS',
    accountUrl: (addr) => `https://kas.2miners.com/api/accounts/${addr}`,
    statsUrl: 'https://kas.2miners.com/api/stats',
    balanceOf: (d) => Number(d.balance),
    netHashOf: (d) => Number(d.nodes?.[0]?.networkhashps) || null,
  },
  XMR: {
    mode: 'unpaid-drop',
    walletEnv: 'XMR_WALLET_ADDRESS',
    accountUrl: (addr) => `https://monero.herominers.com/api/stats_address?address=${addr}`,
    statsUrl: null,
    balanceOf: (d) => {
      // unlocked array entries are payout records with .amount
      const arr = d.unlocked || [];
      return arr.reduce((s, r) => s + (Number(r?.amount) || 0), 0);
    },
    netHashOf: () => null,
  },
};

let started = false;
let running = false;
let lastRun = null;

async function fetchBalance(poolKey, wallet) {
  const cfg = WATCHES[poolKey];
  const res = await axios.get(cfg.accountUrl(wallet), { timeout: 15000 });
  if (!res.data) throw new Error(`${poolKey}: empty account response`);
  const balance = cfg.balanceOf(res.data);
  if (!Number.isFinite(balance)) throw new Error(`${poolKey}: could not parse balance`);
  return balance;
}

async function fetchNetworkHashrate(poolKey) {
  const cfg = WATCHES[poolKey];
  if (!cfg.statsUrl) return null;
  try {
    const res = await axios.get(cfg.statsUrl, { timeout: 15000 });
    return cfg.netHashOf(res.data);
  } catch (err) {
    console.warn(`network hashrate fetch failed for ${poolKey}:`, err.message);
    return null;
  }
}

/**
 * Pure decision logic: what to do given last known and current balance.
 * Returns {action: 'payout', amount} | {action: 'reset'} | {action: 'none'}
 * (baseline is handled by the caller when last is null).
 *
 * balance-delta mode (ZEC/KAS): increase = payout (the delta), decrease =
 * operator moved coins → reset baseline.
 * unpaid-drop mode (XMR): unpaid grows as earnings accrue — only a LARGE drop
 * (after reaching the pool minimum) means the pool paid out; anything else is
 * accrual noise.
 */
function computePayoutEvent(last, current, { minDrop = 0 } = {}) {
  const round8 = (n) => Math.round(n * 1e8) / 1e8;
  if (last == null) return { action: 'baseline' };
  const delta = current - last;
  if (minDrop > 0) {
    if (last >= minDrop && -delta >= minDrop * 0.5) {
      return { action: 'payout', amount: round8(-delta) };
    }
    return { action: 'none' };
  }
  if (delta > EPS) return { action: 'payout', amount: round8(delta) };
  if (delta < -EPS) return { action: 'reset' };
  return { action: 'none' };
}

async function upsertBaseline(poolKey, balance, lastPayoutAmount, lastPayoutAt) {
  await pool.query(
    `INSERT INTO payout_watch (pool, last_balance, last_checked_at, last_payout_amount, last_payout_at)
     VALUES ($1, $2, CURRENT_TIMESTAMP, $3, $4)
     ON CONFLICT (pool) DO UPDATE SET
       last_balance = EXCLUDED.last_balance,
       last_checked_at = CURRENT_TIMESTAMP,
       last_payout_amount = COALESCE(EXCLUDED.last_payout_amount, payout_watch.last_payout_amount),
       last_payout_at = COALESCE(EXCLUDED.last_payout_at, payout_watch.last_payout_at)`,
    [poolKey, balance, lastPayoutAmount ?? null, lastPayoutAt ?? null]
  );
}

async function checkPool(poolKey) {
  const cfg = WATCHES[poolKey];
  const wallet = process.env[cfg.walletEnv];
  if (!wallet) return { pool: poolKey, status: 'no-wallet-configured' };

  const balance = await fetchBalance(poolKey, wallet);
  const netHash = await fetchNetworkHashrate(poolKey);

  const row = await pool.query('SELECT last_balance FROM payout_watch WHERE pool = $1', [poolKey]);
  const last = row.rowCount > 0 ? Number(row.rows[0].last_balance) : null;

  const minDrop = cfg.mode === 'unpaid-drop' ? XMR_MIN_PAYOUT : 0;
  const event = computePayoutEvent(last, balance, { minDrop });

  if (event.action === 'baseline') {
    await upsertBaseline(poolKey, balance, null, null);
    return { pool: poolKey, status: 'baselined', balance };
  }

  if (event.action === 'payout') {
    if (!netHash) {
      // Keep the baseline unchanged so the payout isn't lost — retry next tick
      // with a network-hashrate fetch (or accept null and record it).
      console.warn(`${poolKey}: detected payout ${event.amount} but no network hashrate; recording with null`);
    }
    const result = await distributePayout(poolKey, event.amount, netHash ?? 0);
    await upsertBaseline(poolKey, balance, event.amount, new Date());
    return {
      pool: poolKey,
      status: 'payout',
      amount: event.amount,
      payout_id: result.payout_id,
      participants: result.participants,
    };
  }

  if (event.action === 'reset') {
    await upsertBaseline(poolKey, balance, null, null);
    return { pool: poolKey, status: 'reset-baseline', balance };
  }

  await upsertBaseline(poolKey, balance, null, null);
  return { pool: poolKey, status: 'no-change', balance };
}

async function checkPayouts() {
  if (running) return { skipped: true, reason: 'already-running' };
  running = true;
  const results = [];
  try {
    for (const poolKey of Object.keys(WATCHES)) {
      try {
        results.push(await checkPool(poolKey));
      } catch (err) {
        console.error(`payout check failed for ${poolKey}:`, err.message);
        results.push({ pool: poolKey, status: 'error', error: err.message });
      }
    }
  } finally {
    running = false;
    lastRun = new Date();
  }
  for (const r of results) {
    if (r.status === 'payout') {
      console.log(`💰 Payout detected ${r.pool}: ${r.amount} coin → payout ${r.payout_id} (${r.participants} participants)`);
    }
  }
  return results;
}

async function getPayoutStatus() {
  const { rows } = await pool.query(
    'SELECT pool, last_balance, last_checked_at, last_payout_amount, last_payout_at FROM payout_watch ORDER BY pool'
  );
  return {
    last_run: lastRun,
    interval_ms: INTERVAL_MS,
    xmr_min_payout: XMR_MIN_PAYOUT,
    wallets: {
      ZCASH: process.env.MRR_PLATFORM_WALLET_ZEC ? 'set' : 'unset',
      KASPA: process.env.MRR_PLATFORM_WALLET_KAS ? 'set' : 'unset',
      XMR: process.env.XMR_WALLET_ADDRESS ? 'set' : 'unset',
      LTC_DOGE: 'not-auto-watched',
    },
    watches: rows,
  };
}

function startPayoutTrigger() {
  if (started) return;
  started = true;
  // First check shortly after boot (let the deposit listener settle), then on
  // the interval.
  setTimeout(() => {
    checkPayouts().catch((err) => console.error('initial payout check failed:', err.message));
  }, 15000);
  setInterval(() => {
    checkPayouts().catch((err) => console.error('payout check failed:', err.message));
  }, INTERVAL_MS);
  console.log(`Payout trigger started (every ${INTERVAL_MS / 60000} min): watching ${Object.keys(WATCHES).join(', ')}`);
}

module.exports = { startPayoutTrigger, checkPayouts, getPayoutStatus, computePayoutEvent, WATCHES };
