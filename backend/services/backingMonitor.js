const axios = require('axios');
const { pool } = require('../config/db');
const { WATCHES } = require('./payoutTrigger');
const { getMinerStatus } = require('./minerMonitor');
const { getOrderStatus } = require('./mrrRenter');

/**
 * Real Backing monitor (Phase 2, 2026-08-19) — shows the OPERATOR (and users)
 * what is ACTUALLY mining for each coin vs what players own virtually.
 *
 *   virtual_ghs / rigs_sold  — what players bought in the game (virtual rigs)
 *   active_rentals           — real MRR rentals currently running (rig_rentals)
 *   real_hash / real_unit    — measured hashrate landing at the pool wallet
 *                              (2Miners currentHashrate for ZEC/KAS; MRR rental
 *                              average for LTC; the Mac push for XMR)
 *   pool_unpaid              — unpaid balance sitting at the pool (display units)
 *   mined_total / mined_2    — real payouts received (real_pool_payouts)
 *
 * All live fetches are cached 60s so the admin panel never hammers pools.
 * A failed live fetch degrades to nulls — the panel must never block.
 */

const TTL_MS = 60000;
const POOLS = ['ZCASH', 'KASPA', 'LTC_DOGE', 'XMR'];

// Display unit per pool for real hashrate (natural scale).
const REAL_UNITS = { ZCASH: 'KH/s', KASPA: 'GH/s', LTC_DOGE: 'GH/s', XMR: 'kH/s' };
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

/** MRR live average for an active rental, converted to the pool's GH/s. */
async function rentalRealGhs(mrrRentalId) {
  try {
    const s = await getOrderStatus(String(mrrRentalId));
    const avg = s?.data?.hashrate?.average;
    if (!avg) return 0;
    // MRR average.hash is in the algo's natural unit (kheavyhash=TH, scrypt=GH,
    // zhash=KH). Normalize to GH/s.
    const mult = { kh: 1e-3, mh: 1, gh: 1, th: 1e3 }[String(avg.type || '').toLowerCase()];
    if (mult === undefined) return 0;
    return Number(avg.hash || 0) * mult;
  } catch {
    return 0;
  }
}

async function liveRealHash(pool, activeRentals) {
  if (pool === 'XMR') {
    // Defensive: getMinerStatus may not return a thenable (unmocked in tests).
    const s = await Promise.resolve(getMinerStatus()).catch(() => null);
    const h = s?.hashrate_10s;
    return h != null ? h / 1000 : null; // H/s -> kH/s
  }
  if (pool === 'LTC_DOGE') {
    // F2Pool can't look up bech32 workers — use the rented rigs' live average.
    let total = 0;
    for (const r of activeRentals) {
      if (r.mrr_rental_id) total += await rentalRealGhs(r.mrr_rental_id);
    }
    return total;
  }
  // ZEC / KAS: the pool wallet API reports the ACTUAL landing hashrate.
  const data = await fetchPoolAccount(pool);
  if (!data || data.currentHashrate == null) return null;
  const h = Number(data.currentHashrate);
  return pool === 'ZCASH' ? h / 1e3 : h / 1e9; // H/s -> KH/s | GH/s
}

async function buildBacking() {
  const [virtRows, rentalRows, payoutRows] = await Promise.all([
    pool.query(
      `SELECT target_pool, COALESCE(SUM(virtual_hashrate),0) AS vghs, COUNT(*) AS rigs
         FROM virtual_rigs GROUP BY target_pool`
    ),
    pool.query(
      `SELECT rig_id, target_pool, mrr_rental_id, rig_name, rig_rpi, cost_usd, length_hours
         FROM rig_rentals WHERE status = 'ACTIVE' ORDER BY id`
    ),
    pool.query(
      `SELECT target_pool,
              COALESCE(SUM(total_crypto_reward_1),0) AS mined_1,
              COALESCE(SUM(total_crypto_reward_2),0) AS mined_2
         FROM real_pool_payouts GROUP BY target_pool`
    ),
  ]);

  const virt = Object.fromEntries(virtRows.rows.map((r) => [r.target_pool, r]));
  const payouts = Object.fromEntries(payoutRows.rows.map((r) => [r.target_pool, r]));
  const rentalsByPool = {};
  for (const r of rentalRows.rows) {
    (rentalsByPool[r.target_pool] = rentalsByPool[r.target_pool] || []).push(r);
  }

  const out = {};
  for (const poolName of POOLS) {
    const v = virt[poolName];
    const rentals = rentalsByPool[poolName] || [];
    const account = await fetchPoolAccount(poolName);
    const rawUnpaid = account && WATCHES[poolName] ? WATCHES[poolName].balanceOf(account) : null;
    // WATCHES.balanceOf returns raw atoms for ZEC/KAS (2Miners); Blockcypher and
    // herominers balanceOf already scale. Normalize to display units.
    const unpaid =
      rawUnpaid == null
        ? null
        : poolName === 'ZCASH' || poolName === 'KASPA'
          ? rawUnpaid / 1e8
          : rawUnpaid;
    const realHash = await liveRealHash(poolName, rentals);
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
      mined_total: payouts[poolName] ? Number(payouts[poolName].mined_1) : 0,
      mined_2: payouts[poolName] ? Number(payouts[poolName].mined_2) : 0,
    };
  }
  return out;
}

async function getBacking({ force = false } = {}) {
  if (!force && cache && Date.now() - cacheAt < TTL_MS) return cache;
  cache = await buildBacking();
  cacheAt = Date.now();
  return cache;
}

module.exports = { getBacking, buildBacking, TTL_MS, POOLS, REAL_UNITS };
