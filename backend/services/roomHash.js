const axios = require('axios');
const { getOrderStatus } = require('./mrrRenter');

/**
 * roomHash.js — live REAL hashrate per room, shared by the backing monitor
 * and the payout distributor (hybrid session model, 2026-08-20).
 *
 * Deliberately dependency-free of payoutTrigger/rewardDistributor so the
 * payout path never risks a circular require. The wallet env names mirror
 * payoutTrigger.WATCHES; the actual hashrate measurement comes from the pool
 * wallet API (what the room is REALLY delivering right now), NOT from any
 * virtual credit.
 *
 * Returned units match the room's display unit (REAL_UNITS):
 *   ZCASH -> KH/s, KASPA -> GH/s, LTC_DOGE -> GH/s, XMR -> H/s
 * The payout denominator only needs per-pool consistency, so unit choice is
 * cosmetic there; the admin panel displays it directly.
 */

const WALLET_ENV = {
  ZCASH: 'MRR_PLATFORM_WALLET_ZEC',
  KASPA: 'MRR_PLATFORM_WALLET_KAS',
  LTC_DOGE: 'MRR_PLATFORM_WALLET_LTC',
  XMR: 'XMR_WALLET_ADDRESS',
};

const ACCOUNT_URL = {
  ZCASH: (addr) => `https://zec.2miners.com/api/accounts/${addr}`,
  KASPA: (addr) => `https://kas.2miners.com/api/accounts/${addr}`,
  XMR: (addr) => `https://monero.herominers.com/api/stats_address?address=${addr}`,
  LTC_DOGE: null, // handled via MRR rental averages below
};

function walletFor(pool) {
  const env = WALLET_ENV[pool];
  return env ? process.env[env] : null;
}

async function fetchPoolAccount(pool) {
  const addr = walletFor(pool);
  if (!addr) return null;
  const url = ACCOUNT_URL[pool];
  if (typeof url !== 'function') return null;
  try {
    const r = await axios.get(url(addr), { timeout: 8000 });
    return r.data;
  } catch {
    return null;
  }
}

/** MRR live average for an active rental, converted to the pool's GH/s.
 *  Prefers the rig's LIVE reading (last_5min > last_15min > last_30min) over
 *  the lifetime average — a freshly-started rig has average=0 while its 5min
 *  reading is real (matches MRR's own "Current Hashrate" page). */
async function rentalRealGhs(mrrRentalId) {
  try {
    const s = await getOrderStatus(String(mrrRentalId));
    const live =
      s?.data?.rig?.hashrate?.last_5min ??
      s?.data?.rig?.hashrate?.last_15min ??
      s?.data?.rig?.hashrate?.last_30min;
    const avg = s?.data?.hashrate?.average;
    const pick = live && Number(live.hash) > 0 ? live : avg;
    if (!pick) return 0;
    const mult = { kh: 1e-3, mh: 1, gh: 1, th: 1e3 }[String(pick.type || '').toLowerCase()];
    if (mult === undefined) return 0;
    return Number(pick.hash || 0) * mult;
  } catch {
    return 0;
  }
}

/**
 * Live real hashrate for a room in its display unit (GH/s etc).
 * @param {string} pool ZCASH | KASPA | LTC_DOGE | XMR
 * @param {Array<{mrr_rental_id:string}>} [activeRentals] rig_rentals rows (LTC only)
 * @returns {Promise<number|null>} null when the pool can't be measured
 */
async function fetchLiveRealHash(pool, activeRentals = []) {
  if (pool === 'LTC_DOGE' || pool === 'ZCASH') {
    // MRR rental average (what the rig itself reports, steady) is the
    // operator-facing number — MRR's own page shows "21.33K" while the pool
    // API's currentHashrate for a tiny equihash rig swings 2K→55K sample to
    // sample. When a rental exists, prefer its average; fall back to the
    // pool wallet API (ZEC only) if no rental is registered.
    let total = 0;
    for (const r of activeRentals) {
      if (r.mrr_rental_id) total += await rentalRealGhs(r.mrr_rental_id);
    }
    if (total > 0) {
      return pool === 'ZCASH' ? total * 1e6 : total; // GH/s -> KH/s (1 GH = 1e6 KH)
    }
    if (pool === 'ZCASH') {
      const data = await fetchPoolAccount(pool);
      if (!data || data.currentHashrate == null) return null;
      return Number(data.currentHashrate) / 1e3; // H/s -> KH/s
    }
    return total;
  }
  if (pool === 'XMR') {
    const data = await fetchPoolAccount(pool);
    // Prefer the 1h average (fresh rental: 24h avg dilutes with pre-rental
    // zeros — was showing 2715 H/s while the rig delivers ~13.6 KH/s).
    // Fall back to current, then 24h.
    const h = data?.stats?.hashrate_1h ?? data?.stats?.hashrate ?? data?.stats?.hashrate_24h;
    if (h == null) return null;
    return Number(h);
  }
  // ZEC / KAS: the pool wallet API reports the ACTUAL landing hashrate.
  const data = await fetchPoolAccount(pool);
  if (!data || data.currentHashrate == null) return null;
  const h = Number(data.currentHashrate);
  return pool === 'ZCASH' ? h / 1e3 : h / 1e9; // H/s -> KH/s | GH/s
}

module.exports = { fetchLiveRealHash, walletFor };
