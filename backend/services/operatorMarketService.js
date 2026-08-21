const axios = require('axios');
const {
  advertisedGhs,
  meetsAdvertisedMinimum,
  rigIsAvailable,
} = require('./mrrRenter');

const COINGECKO_URL = 'https://api.coingecko.com/api/v3/coins/markets';
const COIN_CACHE_TTL_MS = 60000;

const ALGO_CONFIG = {
  kheavyhash: {
    targetPool: 'KASPA', profileSuffix: 'KHEAVYHASH', primaryCoin: 'KAS',
    coins: { KAS: { id: 'kaspa', production: 1.3832 } },
    anchorGhs: 200,
  },
  equihash: {
    targetPool: 'ZCASH', profileSuffix: 'EQUIHASH', primaryCoin: 'ZEC',
    coins: { ZEC: { id: 'zcash', production: 0.002060 } },
    anchorGhs: 30.55e-6,
  },
  randomx: {
    targetPool: 'XMR', profileSuffix: 'RANDOMX', primaryCoin: 'XMR',
    coins: { XMR: { id: 'monero', production: 0.000479 } },
    anchorGhs: 14.25e-6,
  },
  scrypt: {
    targetPool: 'LTC_DOGE', profileSuffix: 'SCRYPT', primaryCoin: 'LTC',
    coins: {
      LTC: { id: 'litecoin', production: 0.007304 },
      DOGE: { id: 'dogecoin', production: 28.69 },
    },
    anchorGhs: 7,
  },
};

const coinCache = { rows: null, timestamp: 0 };

function finiteNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function envNumber(name, fallback) {
  const value = finiteNumber(process.env[name]);
  return value !== null && value > 0 ? value : fallback;
}

function cleanNumber(value) {
  return Number(Number(value).toFixed(12));
}

function configFor(algo) {
  const base = ALGO_CONFIG[algo];
  if (!base) return null;
  const prefix = `OPERATOR_ANCHOR_${base.targetPool}`;
  return {
    ...base,
    anchorGhs: envNumber(`${prefix}_GHS`, base.anchorGhs),
    coins: Object.fromEntries(Object.entries(base.coins).map(([symbol, coin]) => [
      symbol,
      { ...coin, production: envNumber(`${prefix}_${symbol}_DAY`, coin.production) },
    ])),
  };
}

function priceRowsForAlgo(rows, algo) {
  const config = configFor(algo);
  if (!config) return { spots: {}, priceTrend: [] };
  const byId = new Map((rows || []).map((row) => [row.id, row]));
  const spots = {};
  const priceTrend = [];
  for (const [symbol, coin] of Object.entries(config.coins)) {
    const row = byId.get(coin.id);
    const price = finiteNumber(row?.current_price);
    if (price === null || price <= 0) throw new Error(`Live ${symbol} price is unavailable`);
    spots[symbol] = price;
    priceTrend.push({
      coin: symbol,
      price,
      chg_24h: finiteNumber(row?.price_change_percentage_24h),
      chg_7d: finiteNumber(row?.price_change_percentage_7d_in_currency),
    });
  }
  return { spots, priceTrend };
}

async function getCoinMarketData(algo) {
  const now = Date.now();
  if (!coinCache.rows || now - coinCache.timestamp >= COIN_CACHE_TTL_MS) {
    const ids = [...new Set(Object.values(ALGO_CONFIG)
      .flatMap((config) => Object.values(config.coins).map((coin) => coin.id)))];
    const response = await axios.get(COINGECKO_URL, {
      params: {
        vs_currency: 'usd',
        ids: ids.join(','),
        price_change_percentage: '24h,7d',
      },
      timeout: 8000,
      headers: { 'Accept': 'application/json', 'User-Agent': 'NexusMiningEngine/1.0' },
    });
    if (!Array.isArray(response.data)) throw new Error('Invalid coin market payload');
    coinCache.rows = response.data;
    coinCache.timestamp = now;
  }
  return priceRowsForAlgo(coinCache.rows, algo);
}

function calculateProfitability({ algo, hashrateGhs, usdPerHour, minHours, spots }) {
  const config = configFor(algo);
  if (!config) throw new Error(`Unsupported market algorithm: ${algo}`);
  const scale = Number(hashrateGhs) / config.anchorGhs;
  const productionDay = {};
  const revenueComponents = {};
  let revenueDay = 0;
  for (const [symbol, coin] of Object.entries(config.coins)) {
    const spot = Number(spots?.[symbol]);
    if (!Number.isFinite(spot) || spot <= 0) throw new Error(`Live ${symbol} price is unavailable`);
    const production = scale * coin.production;
    const revenue = production * spot;
    productionDay[symbol] = production;
    revenueComponents[symbol] = revenue;
    revenueDay += revenue;
  }
  const costDay = Number(usdPerHour) * 24;
  const ratio = revenueDay > 0 ? costDay / revenueDay : null;
  const breakEvenPrices = Object.fromEntries(Object.keys(config.coins).map((symbol) => [
    symbol,
    ratio === null ? null : Number(spots[symbol]) * ratio,
  ]));
  const lengths = [...new Set([Number(minHours), 24, 48, 72])]
    .filter((hours) => Number.isFinite(hours) && hours > 0)
    .sort((a, b) => a - b)
    .map((hours) => {
      const totalCost = cleanNumber(Number(usdPerHour) * hours);
      const expectedValue = cleanNumber(revenueDay * (hours / 24));
      return {
        length_hours: hours,
        total_cost: totalCost,
        expected_value: expectedValue,
        net: cleanNumber(expectedValue - totalCost),
      };
    });
  return {
    revenue_day: revenueDay,
    cost_day: costDay,
    net_day: revenueDay - costDay,
    net_current: revenueDay - costDay,
    net_plus10: (revenueDay * 1.10) - costDay,
    net_minus10: (revenueDay * 0.90) - costDay,
    net_plus25: (revenueDay * 1.25) - costDay,
    net_minus25: (revenueDay * 0.75) - costDay,
    break_even_price: breakEvenPrices[config.primaryCoin],
    break_even_prices: breakEvenPrices,
    lengths,
    arithmetic: {
      hashrate_ghs: Number(hashrateGhs),
      anchor_ghs: config.anchorGhs,
      scale,
      anchor_production_day: Object.fromEntries(
        Object.entries(config.coins).map(([symbol, coin]) => [symbol, coin.production])
      ),
      production_day: productionDay,
      spot_usd: { ...spots },
      revenue_components: revenueComponents,
      revenue_day: revenueDay,
      cost_day: costDay,
      net_day: revenueDay - costDay,
    },
  };
}

function bestReason(rig, config, spots) {
  const net = rig.profitability.net_day;
  const breakEven = rig.profitability.break_even_price;
  const current = Number(spots[config.primaryCoin]);
  const delta = current > 0 && breakEven !== null
    ? Math.abs((breakEven / current - 1) * 100)
    : null;
  const direction = breakEven <= current ? 'below' : 'above';
  const netText = `${net >= 0 ? '+' : '-'}$${Math.abs(net).toFixed(2)}/day`;
  const breakEvenText = breakEven === null
    ? 'break-even unavailable'
    : `break-even $${breakEven.toFixed(4)}${delta === null ? '' : ` — ${delta.toFixed(1)}% ${direction} spot`}`;
  return `≈ ${netText} net at current ${config.primaryCoin} price (${breakEvenText})`;
}

function buildMarketView({ records, algo, btcUsd, spots, profileId }) {
  const config = configFor(algo);
  if (!config) throw new Error(`Unsupported market algorithm: ${algo}`);
  const rigs = [];
  for (const source of records || []) {
    if (!meetsAdvertisedMinimum(source, algo)) continue;
    const hashrateGhs = advertisedGhs(source);
    const btc = source?.price?.BTC;
    const btcPerHour = finiteNumber(btc?.hour);
    const minHours = finiteNumber(btc?.min_rental_length, finiteNumber(source?.minhours));
    if (!hashrateGhs || !btcPerHour || !minHours || btc?.enabled === false) continue;
    const usdPerHour = btcPerHour * Number(btcUsd);
    const profitability = calculateProfitability({
      algo, hashrateGhs, usdPerHour, minHours, spots,
    });
    rigs.push({
      rig_id: String(source.id),
      name: String(source.name || ''),
      owner: source.owner || null,
      region: source.region || null,
      rpi: source.rpi ?? null,
      available: rigIsAvailable(source),
      hashrate_nice: source?.hashrate?.advertised?.nice || null,
      hashrate_ghs: hashrateGhs,
      usd_per_hour: usdPerHour,
      usd_per_day: usdPerHour * 24,
      usd_min_rental: finiteNumber(btc?.minhrs, btcPerHour * minHours) * Number(btcUsd),
      usd_per_ghs_day: (usdPerHour * 24) / hashrateGhs,
      min_hours: minHours,
      max_hours: finiteNumber(source?.maxhours),
      extensions: Boolean(source.extensions),
      pool_profile_id: profileId || null,
      profitability,
    });
  }
  rigs.sort((a, b) =>
    b.profitability.net_day - a.profitability.net_day ||
    a.usd_per_ghs_day - b.usd_per_ghs_day ||
    a.rig_id.localeCompare(b.rig_id)
  );
  const available = rigs.filter((rig) => rig.available);
  const verified = available.filter((rig) => Number(rig.rpi) >= 90);
  const nonNew = available.filter((rig) => !/^new$/i.test(String(rig.rpi || '').trim()));
  const candidates = verified.length ? verified : nonNew.length ? nonNew : available;
  const best = candidates[0] || null;
  return {
    rigs: rigs.slice(0, 25),
    best_value: best ? {
      rig_id: best.rig_id,
      name: best.name,
      usd_per_ghs_day: best.usd_per_ghs_day,
      usd_per_day: best.usd_per_day,
      hashrate_ghs: best.hashrate_ghs,
      rpi: best.rpi,
      min_hours: best.min_hours,
      usd_min_rental: best.usd_min_rental,
      net_day: best.profitability.net_day,
      break_even_price: best.profitability.break_even_price,
      reason: bestReason(best, config, spots),
    } : null,
  };
}

function hashToGhs(hash, unit) {
  const multiplier = { h: 1e-9, kh: 1e-6, mh: 1e-3, gh: 1, th: 1e3, ph: 1e6 }[
    String(unit || '').toLowerCase()
  ];
  return multiplier === undefined ? null : finiteNumber(hash, 0) * multiplier;
}

function unitDayToGhs(amount, unit) {
  const unitName = String(unit || '').toLowerCase().split('*')[0];
  const unitGhs = hashToGhs(1, unitName);
  return unitGhs ? finiteNumber(amount, 0) / unitGhs : null;
}

function marketStatsFor({ algo, btcUsd, algorithmRows }) {
  const row = (algorithmRows || []).find((candidate) => candidate?.name === algo);
  if (!row) return null;
  const available = row?.stats?.available || {};
  const prices = row?.stats?.prices || {};
  const lowestBtc = unitDayToGhs(prices?.lowest?.amount, prices?.lowest?.unit);
  const last10Btc = unitDayToGhs(prices?.last_10?.amount, prices?.last_10?.unit);
  return {
    available_rigs: finiteNumber(available.rigs, 0),
    available_hash_ghs: hashToGhs(available?.hash?.hash, available?.hash?.unit),
    available_hash_nice: available?.hash?.nice || null,
    lowest_usd_per_ghs_day: lowestBtc === null ? null : lowestBtc * Number(btcUsd),
    last_10_usd_per_ghs_day: last10Btc === null ? null : last10Btc * Number(btcUsd),
  };
}

function storageHashrateFor(algo, rig) {
  const ghs = advertisedGhs(rig);
  if (!ghs) return null;
  return algo === 'equihash' || algo === 'randomx' ? ghs * 1e6 : ghs;
}

module.exports = {
  ALGO_CONFIG,
  configFor,
  getCoinMarketData,
  calculateProfitability,
  buildMarketView,
  marketStatsFor,
  storageHashrateFor,
};
