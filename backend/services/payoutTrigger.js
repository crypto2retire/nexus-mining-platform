const axios = require('axios');
const { pool } = require('../config/db');
const { distributePayout, distributeMergedReward, recordPoolPayment } = require('./rewardDistributor');

/**
 * Payout trigger — watches the platform mining wallets at their pools and
 * automatically distributes newly-landed coins to players via distributePayout.
 *
 * Detection modes (pool endpoints verified reachable 2026-08-21):
 *   unpaid-drop   : ZEC at 2Miners and KAS at HeroMiners — each accounts API `stats.balance`
 *                   field is the wallet's unpaid balance. An increase = a
 *                   balance accrual; a qualifying drop means the pool paid.
 *   unpaid-drop   : XMR at herominers — the API exposes UNPAID balance only.
 *                   When unpaid crosses the pool minimum (0.1 XMR) and then
 *                   drops, the pool paid out; the drop is the payout amount.
 *                   (XMR re-added 2026-08-20 as a rental-backed room; the
 *                   platform XMR wallet has been earning at herominers.)
 *
 * LTC_DOGE uses Blockcypher (F2Pool accepts bech32 workers — stratum-verified
 * — but its stats page can't look up ltc1... addresses).
 *
 * State persists in payout_watch so restarts never double-distribute.
 */

const INTERVAL_MS = Number(process.env.PAYOUT_CHECK_INTERVAL_MS || 600000); // 10 min
const XMR_MIN_PAYOUT = Number(process.env.XMR_MIN_PAYOUT || 0.1);
const EPS = 1e-8;

// Pool minimum payout thresholds (COIN units) — the amount at which each pool
// sends the wallet its accrued earnings. Sources verified through 2026-08-21:
//   KASPA 1 KAS     (HeroMiners live pool config)
//   ZCASH 0.1 ZEC   (2Miners live config: allowedMinPayout=minPayout=1e7
//                    zatoshi = 0.1 ZEC; previously hardcoded 0.01 — wrong)
//   XMR   0.1 XMR   (herominers, XMR_MIN_PAYOUT env)
//   LTC   0.02 LTC  (F2Pool help center payout-thresholds article)
//   DOGE  (merged bonus — F2Pool does not publish a DOGE threshold; the
//          on-chain arrival watch shows the total, no ETA)
const PAYOUT_MIN = {
  ZCASH: Number(process.env.ZCASH_MIN_PAYOUT || 0.1),
  KASPA: Number(process.env.KASPA_MIN_PAYOUT || 1),
  XMR: Number(process.env.XMR_MIN_PAYOUT || 0.1),
  LTC_DOGE: Number(process.env.LTC_MIN_PAYOUT || 0.02),
  LTC_DOGE_DOGE: null,
};

const WATCHES = {
  ZCASH: {
    // 2Miners stats.balance = UNPAID balance in ATOMS (1 ZEC = 1e8). It
    // ACCRUES while mining and DROPS when the pool pays the wallet — so the
    // watch is unpaid-drop (like XMR), NOT balance-delta. Fixed 2026-08-20:
    // balanceOf used to return raw atoms and balance-delta treated every
    // accrual as a payout (numeric overflow in the ledger).
    mode: 'unpaid-drop',
    minPayout: PAYOUT_MIN.ZCASH,
    walletEnv: 'MRR_PLATFORM_WALLET_ZEC',
    accountUrl: (addr) => `https://zec.2miners.com/api/accounts/${addr}`,
    statsUrl: 'https://zec.2miners.com/api/stats',
    balanceOf: (d) => Number(d?.stats?.balance ?? d?.balance ?? 0) / 1e8,
    netHashOf: (d) => Number(d.nodes?.[0]?.networkhashps) || null,
  },
  KASPA: {
    // HeroMiners: unpaid accrues in sompi, pool pays when it crosses 1 KAS.
    mode: 'unpaid-drop',
    minPayout: PAYOUT_MIN.KASPA,
    walletEnv: 'MRR_PLATFORM_WALLET_KAS',
    accountUrl: (addr) => `https://kaspa.herominers.com/api/stats_address?address=${addr}`,
    statsUrl: null,
    balanceOf: (d) => Number(d?.stats?.balance ?? d?.balance ?? 0) / 1e8,
    netHashOf: () => null,
  },
  XMR: {
    mode: 'unpaid-drop',
    minPayout: PAYOUT_MIN.XMR,
    walletEnv: 'XMR_WALLET_ADDRESS',
    accountUrl: (addr) => `https://monero.herominers.com/api/stats_address?address=${addr}`,
    statsUrl: null,
    balanceOf: (d) => {
      return Number(d?.stats?.balance || 0) / 1e12;
    },
    netHashOf: () => null,
  },
  LTC_DOGE: {
    // F2Pool accepts bech32 workers for MINING (stratum-authorize verified
    // 2026-08-19) but its stats page 404s on ltc1... addresses — so the
    // watcher uses Blockcypher's on-chain balance instead. On-chain balance
    // INCREASES when the pool pays out (delta = payout) — balance-delta is
    // correct here.
    mode: 'balance-delta',
    minPayout: PAYOUT_MIN.LTC_DOGE,
    walletEnv: 'MRR_PLATFORM_WALLET_LTC',
    accountUrl: (addr) => `https://api.blockcypher.com/v1/ltc/main/addrs/${addr}`,
    statsUrl: null,
    balanceOf: (d) => Number(d.balance) / 1e8,
    netHashOf: () => null,
  },
  // The DOGE side of the LTC_DOGE pool: F2Pool merged mining pays DOGE to its
  // own bound address (011_doge_merged). Same on-chain balance-delta watch,
  // distributed as calculated_reward_2 (DOGE units) instead of the LTC column.
  LTC_DOGE_DOGE: {
    mode: 'balance-delta',
    minPayout: PAYOUT_MIN.LTC_DOGE_DOGE,
    walletEnv: 'MRR_PLATFORM_WALLET_DOGE',
    accountUrl: (addr) => `https://api.blockcypher.com/v1/doge/main/addrs/${addr}`,
    statsUrl: null,
    balanceOf: (d) => Number(d.balance) / 1e8,
    netHashOf: () => null,
    distribute: 'merged',
    gamePool: 'LTC_DOGE',
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

  let balance;
  try {
    balance = await fetchBalance(poolKey, wallet);
  } catch (err) {
    // 404 = the pool has NO account for this wallet yet (zero shares ever
    // recorded) — that is a genuine zero balance, not an API failure.
    if (err.response?.status === 404) {
      balance = 0;
    } else {
      throw err;
    }
  }
  const netHash = await fetchNetworkHashrate(poolKey);

  const row = await pool.query('SELECT last_balance FROM payout_watch WHERE pool = $1', [poolKey]);
  const last = row.rowCount > 0 ? Number(row.rows[0].last_balance) : null;

  const minDrop = cfg.mode === 'unpaid-drop' ? cfg.minPayout ?? 0 : 0;
  const event = computePayoutEvent(last, balance, { minDrop });

  // Append a balance snapshot BEFORE any event handling — this is the
  // observed-accrual source for the "time until payout" estimate. Coins
  // (not atoms) in coin units, same as payout_watch.
  try {
    await pool.query(
      'INSERT INTO payout_balance_history (pool, balance) VALUES ($1, $2)',
      [poolKey, balance]
    );
    await pool.query(
      `DELETE FROM payout_balance_history
        WHERE checked_at < CURRENT_TIMESTAMP - INTERVAL '30 days'`
    );
  } catch (histErr) {
    console.warn(`payout balance history write failed for ${poolKey}:`, histErr.message);
  }

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
    if (process.env.ACCRUAL_DISTRIBUTION_ENABLED === '1') {
      // ACCRUAL mode (016): the accrual distributor already credited users as
      // the room accrued — the pool settling now only records the basis row
      // (keeps earnedTotal continuous). Crediting again = double payment.
      await recordPoolPayment(cfg.gamePool || poolKey, event.amount, netHash ?? 0);
      await upsertBaseline(poolKey, balance, event.amount, new Date());
      return {
        pool: poolKey,
        status: 'payout-settled',
        amount: event.amount,
        note: 'recorded as settlement (accrual mode)',
      };
    }
    const result = cfg.distribute === 'merged'
      ? await distributeMergedReward(cfg.gamePool || poolKey, event.amount, netHash ?? 0)
      : await distributePayout(poolKey, event.amount, netHash ?? 0);
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

/**
 * Observed accrual rate per pool from the balance history (last 48h window).
 * This is the honest basis for "how long until payout" — it reflects what
 * THIS wallet actually accumulated, including network variance and the real
 * rig share. Returns null until >= 2 samples span >= 1 hour.
 */
async function getObservedRates() {
  const { rows } = await pool.query(
    `SELECT pool, balance, checked_at FROM payout_balance_history
      WHERE checked_at >= CURRENT_TIMESTAMP - INTERVAL '48 hours'
      ORDER BY pool, checked_at`
  );
  const byPool = {};
  for (const r of rows) {
    (byPool[r.pool] = byPool[r.pool] || []).push(r);
  }
  const out = {};
  for (const [poolKey, pts] of Object.entries(byPool)) {
    if (pts.length < 2) {
      out[poolKey] = { rate_per_day: null, sample_hours: null, reason: 'insufficient-history' };
      continue;
    }
    const first = pts[0];
    const last = pts[pts.length - 1];
    const hours = (new Date(last.checked_at).getTime() - new Date(first.checked_at).getTime()) / 3600000;
    if (hours < 1) {
      out[poolKey] = { rate_per_day: null, sample_hours: hours, reason: 'sample-too-short' };
      continue;
    }
    const ratePerDay = ((Number(last.balance) - Number(first.balance)) / hours) * 24;
    out[poolKey] = {
      rate_per_day: ratePerDay > 0 ? ratePerDay : null,
      sample_hours: hours,
      reason: ratePerDay > 0 ? 'ok' : 'non-positive-rate',
    };
  }
  return out;
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
      LTC_DOGE: process.env.MRR_PLATFORM_WALLET_LTC ? 'set' : 'unset',
      LTC_DOGE_DOGE: process.env.MRR_PLATFORM_WALLET_DOGE ? 'set' : 'unset',
      XMR: process.env.XMR_WALLET_ADDRESS ? 'set' : 'unset',
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

module.exports = { startPayoutTrigger, checkPayouts, getPayoutStatus, getObservedRates, computePayoutEvent, WATCHES, PAYOUT_MIN };
