const { pool } = require('../config/db');
const { getBacking } = require('./backingMonitor');
const { getCoinMarketData, configFor } = require('./operatorMarketService');

/**
 * minerDashboardService.js — per-rig dashboard for the rigs the operator
 * holds (Kevin 2026-08-22).
 *
 * 🔒 SELF-CUSTODY ONLY (non-negotiable, Kevin 2026-08-22): each rig is its
 * own rental with its own results. Nothing is pooled and we never touch
 * funds. Users see ONLY their own numbers:
 *
 *   - own hashrate (the rig they rented)
 *   - own rewards (what has accrued to THEIR wallet at the pool — shown at
 *     the pool/wallet level, because pools report per-wallet, not per-rig:
 *     2Miners /workers returns nothing and HeroMiners rejects it — verified
 *     live 2026-08-22)
 *   - time remaining (their rental window)
 *
 * Per-rig ACTUAL rewards are NOT available from any pool API (no per-worker
 * endpoint), so per-rig reward columns show null ("—") and per-rig P/L is
 * ESTIMATED from the rig's own production math (anchor × spot), clearly
 * labeled. NEVER allocate pool-level totals to individual rigs — that is
 * pooled accounting and the exact drift Kevin called out.
 */

const POOL_ALGO = { ZCASH: 'equihash', KASPA: 'kheavyhash', LTC_DOGE: 'scrypt', BTC: 'sha256' };
// Display unit per pool for RENTED hashrate (storage units written by
// operatorController.storageHashrateFor: ZEC KH/s, KAS/LTC GH/s, BTC TH/s).
const POOL_UNITS = { ZCASH: 'KH/s', KASPA: 'GH/s', LTC_DOGE: 'GH/s', BTC: 'TH/s', XMR: 'kH/s' };
const POOL_COIN = { ZCASH: 'ZEC', KASPA: 'KAS', LTC_DOGE: 'LTC', BTC: 'BTC', XMR: 'XMR' };
// Normalize rental hashrate to GH/s before scaling against the anchor
// (anchors are always GH/s). Miss this and ZEC estimates are off ~1e6×.
const HASH_TO_GHS = { 'KH/s': 1e-6, 'TH/s': 1e3, 'kH/s': 1e-9, 'GH/s': 1 };

function finiteNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

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

/** Fallback hashrate for rentals whose hashrate_orders row is missing. */
async function fallbackHashrates(userId) {
  const { rows } = await pool.query(
    'SELECT target_pool, virtual_hashrate FROM virtual_rigs WHERE user_id = $1',
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
  const [rentalRows, fallbacks, backing] = await Promise.all([
    loadRentals(userId),
    fallbackHashrates(userId),
    getBacking(),
  ]);

  const now = Date.now();
  const pools = {};
  for (const row of rentalRows) {
    (pools[row.target_pool] = pools[row.target_pool] || []).push(row);
  }

  const out = {};
  for (const [targetPool, rentals] of Object.entries(pools)) {
    const unit = POOL_UNITS[targetPool] || 'GH/s';
    const coin = POOL_COIN[targetPool] || targetPool;
    const algo = POOL_ALGO[targetPool];
    const backingInfo = backing[targetPool] || {};

    // Per-rig data (the user's OWN numbers).
    for (const r of rentals) {
      const expiry = rentalExpiry(r);
      r.hashrate = Math.max(0, finiteNumber(r.requested_rig_hashrate, fallbacks[targetPool] || 0));
      r.expires_at_ms = expiry.expiresAtMs;
      r.length_ms = expiry.lengthMs;
      r.hours_left = Math.max(0, (expiry.expiresAtMs - now) / 3600000);
      const elapsedMs = Math.max(0, Math.min(now - expiry.startMs, r.length_ms));
      r.elapsed_hours = elapsedMs / 3600000;
      r.elapsed_frac = r.length_ms > 0 ? elapsedMs / r.length_ms : 1;
      r.cost_usd = finiteNumber(r.cost_usd, 0);
      r.cost_btc = finiteNumber(r.cost_btc, 0);
      r.cost_so_far_usd = (r.status === 'ACTIVE' ? r.elapsed_frac : 1) * r.cost_usd;
    }

    // Prices + trend for the coin(s).
    let spots = {};
    let priceTrend = [];
    if (algo) {
      try {
        const market = await getCoinMarketData(algo);
        spots = market.spots;
        priceTrend = market.priceTrend;
      } catch {
        spots = {};
        priceTrend = [];
      }
    }

    // Anchor production math for estimates (per-rig, never pooled).
    let anchor = null;
    if (algo) {
      try {
        const config = configFor(algo);
        anchor = config ? { anchorGhs: config.anchorGhs, productionDay: config.coins } : null;
      } catch {
        anchor = null;
      }
    }

    const spotOf = (symbol) => (spots[symbol] != null ? Number(spots[symbol]) : null);

    const minersByRig = new Map();
    for (const r of rentals) {
      // Estimated production for the rig's own window (anchor × spot).
      r.est_payout1 = null; // remaining window
      r.est_payout2 = null;
      r.est_payout_usd = null; // remaining window, USD
      r.est_window_usd = null; // FULL window, USD (for ended rentals' overall)
      r.est_earned_usd = null; // est value mined so far in THIS rental
      if (anchor && r.hashrate > 0) {
        const scale = (r.hashrate * (HASH_TO_GHS[unit] || 1)) / anchor.anchorGhs;
        const dayRate = {};
        for (const [symbol, coinCfg] of Object.entries(anchor.productionDay)) {
          dayRate[symbol] = scale * coinCfg.production;
        }
        // Remaining window estimate.
        const hours = r.hours_left;
        for (const [symbol, perDay] of Object.entries(dayRate)) {
          const amount = perDay * (hours / 24);
          if (symbol === 'LTC' || (targetPool !== 'LTC_DOGE' && symbol === coin)) {
            r.est_payout1 = (r.est_payout1 || 0) + amount;
          } else if (symbol === 'DOGE') {
            r.est_payout2 = (r.est_payout2 || 0) + amount;
          }
          const spot = spotOf(symbol);
          if (spot != null) r.est_payout_usd = (r.est_payout_usd || 0) + amount * spot;
        }
        // FULL window estimate (used for ENDED rentals' overall P/L).
        for (const [symbol, perDay] of Object.entries(dayRate)) {
          const amount = perDay * (Number(r.length_hours) / 24);
          const spot = spotOf(symbol);
          if (spot != null) r.est_window_usd = (r.est_window_usd || 0) + amount * spot;
        }
        // Estimated earned SO FAR (elapsed part of the window).
        for (const [symbol, perDay] of Object.entries(dayRate)) {
          const amount = perDay * (r.elapsed_hours / 24);
          const spot = spotOf(symbol);
          if (spot != null) r.est_earned_usd = (r.est_earned_usd || 0) + amount * spot;
        }
      }
      // Estimated P/L: est earned so far − cost so far (ACTIVE only).
      r.est_pnl_current_usd = r.status === 'ACTIVE' && r.est_earned_usd != null
        ? r.est_earned_usd - r.cost_so_far_usd
        : null;
      r.est_pnl_overall_miner_usd = null; // filled after grouping
      const rigKey = r.requested_rig_id || String(r.rig_id);
      if (!minersByRig.has(rigKey)) minersByRig.set(rigKey, []);
      minersByRig.get(rigKey).push(r);
    }

    // Overall ESTIMATED P/L per PHYSICAL miner (same MRR rig across renewals).
    for (const group of minersByRig.values()) {
      const totalCost = group.reduce((s, r) => s + r.cost_usd, 0);
      const totalEstEarned = group.reduce((s, r) => s + (r.status === 'ACTIVE' && r.est_earned_usd != null
        ? r.est_earned_usd
        : r.est_window_usd != null ? r.est_window_usd : 0), 0);
      for (const r of group) r.est_pnl_overall_miner_usd = totalEstEarned - totalCost;
    }

    const active = rentals.filter((r) => r.status === 'ACTIVE');
    const totalCostAll = rentals.reduce((s, r) => s + r.cost_usd, 0);
    const totalEstEarned = rentals.reduce(
      (s, r) => s + (r.status === 'ACTIVE' && r.est_earned_usd != null ? r.est_earned_usd : 0),
      0
    );
    const totalEstPnlCurrent = active.reduce(
      (s, r) => s + (r.est_pnl_current_usd != null ? r.est_pnl_current_usd : 0),
      0
    );
    // Overall coin estimate: est earned for ACTIVE windows + full-window est
    // for ENDED rentals, minus all costs.
    const totalEstPnlOverall =
      totalEstEarned +
      rentals
        .filter((r) => r.status !== 'ACTIVE')
        .reduce((s, r) => s + (r.est_window_usd != null ? r.est_window_usd : 0), 0) -
      totalCostAll;

    out[targetPool] = {
      coin,
      unit,
      active_rentals: active.length,
      total_rentals: rentals.length,
      total_hashrate: active.reduce((s, r) => s + r.hashrate, 0),
      total_cost_usd: totalCostAll,
      // SELF-CUSTODY rewards: the user's OWN wallet at this pool — what the
      // pool currently owes THEIR address (never split across rigs). null =
      // pool has no live balance data for this coin ("—").
      your_rewards_coin: backingInfo.pool_unpaid != null ? finiteNumber(backingInfo.pool_unpaid, 0) : null,
      your_rewards_coin_2: finiteNumber(backingInfo.pool_unpaid_2, 0),
      your_rewards_unit: backingInfo.pool_unpaid_unit || coin,
      est_pnl_current_usd: totalEstPnlCurrent,
      est_pnl_overall_usd: totalEstPnlOverall,
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
        // Per-rig ACTUAL rewards are NOT available from any pool API
        // (verified 2026-08-22: no per-worker endpoints). null = "—".
        rewards_coin_1: null,
        rewards_coin_2: null,
        est_payout_coin_1: r.est_payout1,
        est_payout_coin_2: r.est_payout2,
        est_payout_usd: r.est_payout_usd,
        est_earned_usd: r.est_earned_usd,
        est_pnl_current_usd: r.est_pnl_current_usd,
        est_pnl_overall_miner_usd: r.est_pnl_overall_miner_usd,
      })),
    };
  }

  return {
    generated_at: new Date(now).toISOString(),
    // SELF-CUSTODY: per-rig estimates only; actual rewards are the user's own
    // wallet at the pool. No pooled allocation anywhere.
    rewards_model: 'self-custody — rewards accrue to your own wallet; per-rig P/L is estimated from rig production math',
    pools: out,
  };
}

module.exports = { buildOperatorMiners, rentalExpiry, POOL_UNITS, POOL_COIN, HASH_TO_GHS };
