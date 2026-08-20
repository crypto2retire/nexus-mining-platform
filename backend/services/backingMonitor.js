const axios = require('axios');
const { pool } = require('../config/db');
const { WATCHES } = require('./payoutTrigger');
const { logRealHashChange } = require('./rigHistory');
const { fetchLiveRealHash } = require('./roomHash');

/**
 * Real Backing monitor (Phase 2, 2026-08-19) — shows the OPERATOR (and users)
 * what is ACTUALLY mining for each coin vs what players own virtually.
 *
 *   virtual_ghs / rigs_sold  — what players bought in the game (virtual rigs)
 *   active_rentals           — real MRR rentals currently running (rig_rentals)
 *   real_hash / real_unit    — measured hashrate landing at the pool wallet
 *                              (2Miners currentHashrate for ZEC/KAS; MRR rental
 *                              average for LTC; herominers hashrate_24h for XMR)
 *   pool_unpaid              — unpaid balance sitting at the pool (display units)
 *   mined_total / mined_2    — real payouts received (real_pool_payouts)
 *
 * All live fetches are cached 60s so the admin panel never hammers pools.
 * A failed live fetch degrades to nulls — the panel must never block.
 */

const TTL_MS = 60000;
const POOLS = ['ZCASH', 'KASPA', 'LTC_DOGE', 'XMR'];

// Display unit per pool for real hashrate (natural scale).
const REAL_UNITS = { ZCASH: 'KH/s', KASPA: 'GH/s', LTC_DOGE: 'GH/s', XMR: 'H/s' };
// Pool balances come back in smallest units — scale for display.
const POOL_DECIMALS = { ZCASH: 8, KASPA: 8, LTC_DOGE: 8, XMR: 12 };

let cache = null;
let cacheAt = 0;

function walletFor(pool) {
  const watch = WATCHES[pool];
  return watch && watch.walletEnv ? process.env[watch.walletEnv] : null;
}

async function fetchPoolAccount(pool) {
  const watch = WATCHES[pool];
  const addr = walletFor(pool);
  if (!watch || !addr) return null;
  try {
    const url = typeof watch.accountUrl === 'function' ? watch.accountUrl(addr) : watch.accountUrl;
    const r = await axios.get(url, { timeout: 8000 });
    return r.data;
  } catch {
    return null;
  }
}

/** Live real hashrate for a room in its display unit (delegates to roomHash). */
function liveRealHash(pool, activeRentals) {
  return fetchLiveRealHash(pool, activeRentals);
}

async function buildBacking() {
  const [virtRows, rentalRows, payoutRows, accrualRows] = await Promise.all([
    pool.query(
      // ACTIVE credits only — expired 0-GH/s rigs are NOT "sold" (Kevin
      // 2026-08-20: "Rigs sold 1" with 0 GH/s and no real backing confused
      // the LTC/XMR rows).
      `SELECT target_pool, COALESCE(SUM(virtual_hashrate),0) AS vghs, COUNT(*) AS rigs
         FROM virtual_rigs
        WHERE rental_expires_at > CURRENT_TIMESTAMP
          AND virtual_hashrate > 0
        GROUP BY target_pool`
    ),
    pool.query(
      `SELECT rig_id, target_pool, mrr_rental_id, rig_name, rig_rpi, cost_usd, length_hours
         FROM rig_rentals WHERE status = 'ACTIVE' ORDER BY id`
    ),
    pool.query(
      // Settled pool payments ONLY (source='POOL_PAYMENT'). ACCRUAL rows are
      // game distributions — summing them double-counts mined production.
      `SELECT target_pool,
              COALESCE(SUM(total_crypto_reward_1),0) AS mined_1,
              COALESCE(SUM(total_crypto_reward_2),0) AS mined_2
         FROM real_pool_payouts WHERE source = 'POOL_PAYMENT' GROUP BY target_pool`
    ),
  ]);

  const virt = Object.fromEntries(virtRows.rows.map((r) => [r.target_pool, r]));
  const payouts = Object.fromEntries(payoutRows.rows.map((r) => [r.target_pool, r]));
  const rentalsByPool = {};
  for (const r of rentalRows.rows) {
    (rentalsByPool[r.target_pool] = rentalsByPool[r.target_pool] || []).push(r);
  }

  const out = {};
  const generatedAt = new Date().toISOString();
  for (const poolName of POOLS) {
    const v = virt[poolName];
    const rentals = rentalsByPool[poolName] || [];
    const account = await fetchPoolAccount(poolName);
    const rawUnpaid = account && WATCHES[poolName] ? WATCHES[poolName].balanceOf(account) : null;
    // WATCHES.balanceOf already returns COIN units (2Miners atoms normalized
    // /1e8, herominers /1e12, Blockcypher /1e8) — no extra scaling here.
    const unpaid = rawUnpaid == null ? null : rawUnpaid;
    const realHash = await liveRealHash(poolName, rentals);
    // HYBRID model: every backing refresh records what the room ACTUALLY
    // delivered — this is the fair-slice payout denominator and the spare
    // capacity ledger. A failed live fetch (null) is never logged: the last
    // known measurement stays authoritative.
    if (realHash != null) {
      try {
        await logRealHashChange(pool, poolName, realHash, REAL_UNITS[poolName]);
      } catch (logErr) {
        console.warn(`backing: could not log real hash for ${poolName}: ${logErr.message}`);
      }
    }
    // LIVE production (Kevin 2026-08-20: "all data must be current"): the
    // pool wallet's CURRENT unpaid balance + settled POOL_PAYMENT rows.
    // Computed at read time — NEVER the 6h-old room_accrual snapshot.
    // LTC/DOGE (balance-delta, on-chain watch): unpaid IS the on-chain
    // balance already received — adding POOL_PAYMENT rows would double-count.
    const watchMode = WATCHES[poolName]?.mode;
    const settled = payouts[poolName] ? Number(payouts[poolName].mined_1) : 0;
    const minedLive =
      unpaid == null
        ? (watchMode === 'balance-delta' ? settled : 0)
        : watchMode === 'balance-delta'
          ? unpaid
          : unpaid + settled;
    out[poolName] = {
      virtual_ghs: v ? Number(v.vghs) : 0,
      rigs_sold: v ? Number(v.rigs) : 0,
      active_rentals: rentals.map((r) => ({
        mrr_rental_id: r.mrr_rental_id,
        rig_name: r.rig_name,
        rig_rpi: r.rig_rpi,
        cost_usd: r.cost_usd,
        length_hours: r.length_hours,
      })),
      real_hash: realHash,
      real_unit: REAL_UNITS[poolName],
      pool_unpaid: unpaid,
      pool_unpaid_unit: { ZCASH: 'ZEC', KASPA: 'KAS', LTC_DOGE: 'LTC', XMR: 'XMR' }[poolName],
      // LIVE production (computed above at read time) — never a stale
      // snapshot. For unpaid-drop pools (KAS/ZEC/XMR): current unpaid + all
      // settled pool payments. For balance-delta (LTC/DOGE): the on-chain
      // balance already received.
      mined_total: minedLive,
      mined_2: payouts[poolName] ? Number(payouts[poolName].mined_2) : 0,
      fetched_at: generatedAt,
    };
  }
  return out;
}

async function getBacking({ force = false } = {}) {
  if (!force && cache && Date.now() - cacheAt < TTL_MS) return cache;
  cache = await buildBacking();
  cacheAt = Date.now();
  // Expose the cache timestamp so the admin panel can show "as of X" and
  // nothing is ever presented as fresher than it is. Mutate the cached
  // object so cache hits return the SAME reference (identity preserved).
  cache.generated_at = new Date(cacheAt).toISOString();
  cache.cache_ttl_ms = TTL_MS;
  return cache;
}

module.exports = { getBacking, buildBacking, liveRealHash, TTL_MS, POOLS, REAL_UNITS };
