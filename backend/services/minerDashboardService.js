const { pool } = require('../config/db');
const { getBacking } = require('./backingMonitor');
const { getCoinMarketData, configFor } = require('./operatorMarketService');

/**
 * minerDashboardService.js — per-miner dashboard for the rigs the OPERATOR
 * holds (Kevin 2026-08-22).
 *
 * Every rig the operator rents (exact-rig orders placed from the Mining
 * Market) gets its own row: hashrate, estimated payout for the window, time
 * left, current P/L, overall P/L on that miner, and the coin's overall P/L.
 *
 * DATA REALITY: pool payouts (real_pool_payouts + the pool's current unpaid
 * balance) are recorded at the POOL level — the wallet is shared by every
 * rig mining that coin. There is no per-rig payout tag. So each miner's
 * earned amount is allocated pro-rata by ADVERTISED hashrate-hours:
 *
 *   - for every settled pool payment at time T: each rental active at T
 *     earns amount x (its hashrate / sum of active hashrates at T)
 *   - the pool's CURRENT unpaid balance: same split among rentals active now
 *
 * This is an estimate and the API says so (allocation_method = 'pro-rata
 * advertised hashrate-hours'). It is the fairest split possible without
 * per-worker pool stats.
 */

const POOL_ALGO = { ZCASH: 'equihash', KASPA: 'kheavyhash', LTC_DOGE: 'scrypt', BTC: 'sha256' };
// Display unit per pool for RENTED hashrate (matches requested_rig_hashrate
// storage units written by operatorController.storageHashrateFor).
const POOL_UNITS = { ZCASH: 'KH/s', KASPA: 'GH/s', LTC_DOGE: 'GH/s', BTC: 'TH/s', XMR: 'kH/s' };
const POOL_COIN = { ZCASH: 'ZEC', KASPA: 'KAS', LTC_DOGE: 'LTC', BTC: 'BTC', XMR: 'XMR' };

function finiteNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function activeAt(rental, timestamp) {
  const start = new Date(rental.started_at).getTime();
  const end = rental.expires_at_ms;
  const t = new Date(timestamp).getTime();
  return t >= start && t <= end;
}

function allocateShare(rentals, timestamp) {
  const active = rentals.filter((r) => activeAt(r, timestamp));
  const totalHash = active.reduce((sum, r) => sum + r.hashrate, 0);
  if (totalHash <= 0) return null;
  return active.map((r) => ({
    rental: r,
    share: r.hashrate / totalHash,
  }));
}

/**
 * Load every rental the operator placed (all statuses) joined to the
 * hashrate_orders row that created it so we know each rig's advertised
 * hashrate and its physical MRR rig id (requested_rig_id groups renewals of
 * the SAME miner across rentals).
 */
async function loadRentals(userId) {
  const { rows } = await pool.query(
    `SELECT rr.id, rr.rig_id, rr.target_pool, rr.mrr_rental_id, rr.rig_name,
            rr.rig_rpi, rr.cost_btc, rr.cost_usd, rr.length_hours,
            rr.funded_from, rr.status, rr.started_at, rr.ended_at,
            h.requested_rig_id, h.requested_rig_hashrate
       FROM rig_rentals rr
       LEFT JOIN hashrate_orders h
              ON h.nicehash_order_id = rr.mrr_rental_id
      WHERE rr.user_id = $1
      ORDER BY rr.started_at ASC`,
    [userId]
  );
  const byId = new Map();
  for (const row of rows) {
    if (!byId.has(row.id)) byId.set(row.id, row);
  }
  return [...byId.values()];
}

/** Fallback hashrate for rentals whose hashrate_orders row is missing: the
 * user's current virtual rig for that pool (room-level credited hashrate). */
async function fallbackHashrates(userId) {
  const { rows } = await pool.query(
    `SELECT target_pool, virtual_hashrate FROM virtual_rigs WHERE user_id = $1`,
    [userId]
  );
  return Object.fromEntries(rows.map((r) => [r.target_pool, Number(r.virtual_hashrate) || 0]));
}

function rentalExpiry(row) {
  const start = new Date(row.started_at).getTime();
  const lengthMs = Number(row.length_hours) * 3600 * 1000;
  return { startMs: start, lengthMs, expiresAtMs: start + lengthMs };
}

async function buildOperatorMiners(userId) {
  const [rentalRows, fallbacks, backing, backingByPool] = await Promise.all([
    loadRentals(userId),
    fallbackHashrates(userId),
    getBacking(),
  ]);

  // Payload per pool: rentals + settled payouts (POOL_PAYMENT only — ACCRUAL
  // rows are game distributions and would double-count).
  const pools = {};
  const { rows: payoutRows } = await pool.query(
    `SELECT target_pool, total_crypto_reward_1, total_crypto_reward_2,
            payout_timestamp
       FROM real_pool_payouts
      WHERE source = 'POOL_PAYMENT'
      ORDER BY payout_timestamp ASC`
  );
  for (const row of payoutRows) {
    (pools[row.target_pool] = pools[row.target_pool] || { payouts: [] }).payouts.push({
      amount1: Number(row.total_crypto_reward_1) || 0,
      amount2: Number(row.total_crypto_reward_2) || 0,
      at: new Date(row.payout_timestamp).getTime(),
    });
  }

  for (const row of rentalRows) {
    const targetPool = row.target_pool;
    const entry = (pools[targetPool] = pools[targetPool] || { payouts: [] });
    (entry.rentals = entry.rentals || []).push(row);
  }

  const now = Date.now();
  const out = {};
  const coinsById = { kaspa: 'KAS', zcash: 'ZEC', bitcoin: 'BTC', litecoin: 'LTC', dogecoin: 'DOGE' };

  for (const [targetPool, entry] of Object.entries(pools)) {
    const rentals = entry.rentals || [];
    if (rentals.length === 0 && (entry.payouts || []).length === 0) continue;
    const unit = POOL_UNITS[targetPool] || 'GH/s';
    const coin = POOL_COIN[targetPool] || targetPool;
    const algo = POOL_ALGO[targetPool];
    const backingInfo = backing[targetPool] || {};
    const unpaid = finiteNumber(backingInfo.pool_unpaid, 0);
    const unpaidUnit = backingInfo.pool_unpaid_unit || coin;

    // Annotate each rental: hashrate, window, hours left.
    for (const r of rentals) {
      const expiry = rentalExpiry(r);
      r.hashrate = finiteNumber(r.requested_rig_hashrate, fallbacks[targetPool] || 0);
      r.hashrate = Math.max(0, Number(r.hashrate));
      r.expires_at_ms = expiry.expiresAtMs;
      r.length_ms = expiry.lengthMs;
      r.elapsed_ms = Math.min(Math.max(now - expiry.startMs, 0), expiry.lengthMs);
      r.hours_left = Math.max(0, (expiry.expiresAtMs - now) / 3600000);
      r.elapsed_frac = r.length_ms > 0 ? Math.min(1, r.elapsed_ms / r.length_ms) : 1;
      r.cost_usd = finiteNumber(r.cost_usd, 0);
      r.cost_btc = finiteNumber(r.cost_btc, 0);
      r.cost_so_far_usd = (r.status === 'ACTIVE' ? r.elapsed_frac : 1) * r.cost_usd;
      r.earned1 = 0;
      r.earned2 = 0;
      r.earned_usd = 0;
    }

    // 1) Settled payouts: allocate each by the hashrate mix active at payout time.
    for (const payout of entry.payouts || []) {
      const splits = allocateShare(rentals, payout.at);
      if (!splits) continue;
      for (const { rental, share } of splits) {
        rental.earned1 += payout.amount1 * share;
        rental.earned2 += payout.amount2 * share;
      }
    }
    // 2) Current unpaid balance: split among rentals active RIGHT NOW.
    const currentSplits = allocateShare(rentals, now);
    if (currentSplits) {
      for (const { rental, share } of currentSplits) {
        rental.earned1 += unpaid * share;
      }
    }

    // Prices + trend for the coin(s) in this pool.
    let spots = {};
    let priceTrend = [];
    let coinSymbols = [];
    if (algo) {
      try {
        const market = await getCoinMarketData(algo);
        spots = market.spots;
        priceTrend = market.priceTrend;
        coinSymbols = Object.keys(spots);
      } catch {
        spots = {};
        priceTrend = [];
      }
    }
    const value1 = (amount) => {
      const sym = targetPool === 'LTC_DOGE' ? 'LTC' : coin;
      const spot = spots[sym] != null ? Number(spots[sym]) : null;
      return spot != null ? Number(amount) * spot : null;
    };
    const value2 = (amount) => {
      const spot = spots.DOGE != null ? Number(spots.DOGE) : null;
      return spot != null ? Number(amount) * spot : null;
    };

    // Per-rental P/L once prices are known.
    const minersByRig = new Map();
    for (const r of rentals) {
      const v1 = value1(r.earned1);
      const v2 = value2(r.earned2);
      r.earned_usd = (v1 != null ? v1 : 0) + (v2 != null ? v2 : 0);
      r.pnl_overall_miner_usd = null; // filled after grouping
      const rigKey = r.requested_rig_id || String(r.rig_id);
      if (!minersByRig.has(rigKey)) minersByRig.set(rigKey, []);
      minersByRig.get(rigKey).push(r);
    }
    // Overall P/L per PHYSICAL miner = all rentals of the same MRR rig.
    for (const group of minersByRig.values()) {
      const totalCost = group.reduce((s, r) => s + r.cost_usd, 0);
      const totalEarned = group.reduce((s, r) => s + r.earned_usd, 0);
      for (const r of group) r.pnl_overall_miner_usd = totalEarned - totalCost;
    }

    // Estimated payout for the remaining window (anchor production math).
    // Rental hashrate is stored in the pool's display unit (KH/s for ZEC,
    // TH/s for BTC, GH/s for KAS/LTC) — normalize to GH/s before scaling
    // against the anchor (which is always expressed in GH/s).
    let anchor = null;
    if (algo) {
      try {
        const config = configFor(algo);
        anchor = config ? { anchorGhs: config.anchorGhs, productionDay: config.coins } : null;
      } catch {
        anchor = null;
      }
    }
    const hashToGhs = { 'KH/s': 1e-6, 'TH/s': 1e3, 'kH/s': 1e-9, 'GH/s': 1 };
    for (const r of rentals) {
      r.est_payout1 = null;
      r.est_payout2 = null;
      r.est_payout_usd = null;
      if (!anchor || r.hashrate <= 0 || r.status !== 'ACTIVE') continue;
      const scale = (r.hashrate * (hashToGhs[unit] || 1)) / anchor.anchorGhs;
      const hours = r.hours_left;
      for (const [symbol, coinCfg] of Object.entries(anchor.productionDay)) {
        const amount = scale * coinCfg.production * (hours / 24);
        const spot = spots[symbol] != null ? Number(spots[symbol]) : null;
        if (symbol === 'LTC' || (targetPool !== 'LTC_DOGE' && symbol === coin)) {
          r.est_payout1 = (r.est_payout1 || 0) + amount;
        } else if (symbol === 'DOGE') {
          r.est_payout2 = (r.est_payout2 || 0) + amount;
        }
        if (spot != null) r.est_payout_usd = (r.est_payout_usd || 0) + amount * spot;
      }
    }

    // Group totals.
    const active = rentals.filter((r) => r.status === 'ACTIVE');
    const totalCostAll = rentals.reduce((s, r) => s + r.cost_usd, 0);
    const totalEarnedAll = rentals.reduce((s, r) => s + r.earned_usd, 0);
    const minedValue =
      (value1(finiteNumber(backingInfo.mined_total, 0)) != null
        ? value1(finiteNumber(backingInfo.mined_total, 0))
        : 0) +
      (value2(finiteNumber(backingInfo.mined_2, 0)) != null
        ? value2(finiteNumber(backingInfo.mined_2, 0))
        : 0);

    out[targetPool] = {
      coin,
      unit,
      active_rentals: active.length,
      total_rentals: rentals.length,
      total_hashrate: active.reduce((s, r) => s + r.hashrate, 0),
      total_cost_usd: totalCostAll,
      mined_coin_1: finiteNumber(backingInfo.mined_total, 0),
      mined_coin_2: finiteNumber(backingInfo.mined_2, 0),
      mined_value_usd: minedValue,
      pool_unpaid: unpaid,
      pool_unpaid_unit: unpaidUnit,
      earned_allocated_usd: totalEarnedAll,
      pnl_current_usd: active.reduce((s, r) => s + (r.earned_usd - r.cost_so_far_usd), 0),
      pnl_overall_usd: totalEarnedAll - totalCostAll,
      price_usd: Object.keys(spots).length ? spots : null,
      price_trend: priceTrend,
      miners: rentals.map((r) => ({
        mrr_rental_id: r.mrr_rental_id,
        rig_name: r.rig_name,
        rig_rpi: r.rig_rpi,
        requested_rig_id: r.requested_rig_id,
        hashrate: r.hashrate,
        length_hours: Number(r.length_hours),
        started_at: r.started_at,
        ends_at: new Date(r.expires_at_ms).toISOString(),
        hours_left: r.hours_left,
        status: r.status,
        cost_usd: r.cost_usd,
        cost_btc: r.cost_btc,
        cost_so_far_usd: r.cost_so_far_usd,
        earned_coin_1: r.earned1,
        earned_coin_2: r.earned2,
        earned_usd: r.earned_usd,
        pnl_current_usd: r.status === 'ACTIVE' ? r.earned_usd - r.cost_so_far_usd : null,
        pnl_overall_miner_usd: r.pnl_overall_miner_usd,
        est_payout_coin_1: r.est_payout1,
        est_payout_coin_2: r.est_payout2,
        est_payout_usd: r.est_payout_usd,
      })),
      allocation_method: 'pro-rata advertised hashrate-hours (pool-level payouts shared by active rigs)',
    };
  }

  return {
    generated_at: new Date(now).toISOString(),
    allocation_method: 'pro-rata advertised hashrate-hours (pool-level payouts shared by active rigs)',
    pools: out,
  };
}

module.exports = { buildOperatorMiners, allocateShare, activeAt, rentalExpiry, POOL_UNITS, POOL_COIN };
