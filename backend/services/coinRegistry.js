/**
 * CPU-minable coin registry for the M4 miner (XMRig).
 *
 * Only coins with a VERIFIED live pool (herominers API confirmed 2026-08-18)
 * are switchable. Others are listed for reference but marked not-verified.
 *
 * Est. M4 hashrates measured on this machine (XMRig 6.26.0, 10 threads):
 *   rx/0 (RandomX)   ~3,300 H/s
 *   rx/wow           ~2,850–3,500 H/s (benchmark 2026-08-18)
 */

const COINS = {
  XMR: {
    symbol: 'XMR',
    name: 'Monero',
    algo: 'rx/0',
    coin: 'monero',
    pool: 'us.monero.herominers.com:1111',
    poolHost: 'monero.herominers.com',
    statsApi: 'https://monero.herominers.com/api/stats',
    walletEnv: 'XMR_WALLET_ADDRESS',
    atomicUnits: 1e12,
    m4Hashrate: 3300,
    verified: true,
    liquidity: 'High — listed on major exchanges',
    note: 'The CPU-mining standard. Privacy coin, fixed tail emission.',
  },
  ZEPH: {
    symbol: 'ZEPH',
    name: 'Zephyr',
    algo: 'rx/0',
    coin: 'zephyr',
    pool: 'de.zephyr.herominers.com:1123',
    poolHost: 'zephyr.herominers.com',
    statsApi: 'https://zephyr.herominers.com/api/stats',
    walletEnv: 'ZEPH_WALLET_ADDRESS',
    atomicUnits: 1e12,
    m4Hashrate: 3300,
    verified: true,
    liquidity: 'Low — MEXC/Nonkyc only',
    note: 'Monero fork (Zephyr Protocol). Far lower network hashrate than XMR.',
  },
  QRL: {
    symbol: 'QRL',
    name: 'Quantum Resistant Ledger',
    algo: 'rx/0',
    coin: 'quantum-resistant-ledger',
    pool: 'de.qrl.herominers.com:1166',
    poolHost: 'qrl.herominers.com',
    statsApi: 'https://qrl.herominers.com/api/stats',
    walletEnv: 'QRL_WALLET_ADDRESS',
    atomicUnits: 1e9,
    m4Hashrate: 3300,
    verified: true,
    liquidity: 'Low — MEXC/Nonkyc only',
    note: 'Post-quantum coin (XMSS). Network hashrate similar scale to Zephyr.',
  },
  WOW: {
    symbol: 'WOW',
    name: 'Wownero',
    algo: 'rx/wow',
    coin: 'wownero',
    pool: null, // verified pool pending
    statsApi: null,
    walletEnv: 'WOW_WALLET_ADDRESS',
    m4Hashrate: 3200,
    verified: false,
    liquidity: 'Very low',
    note: 'Fun/meme Monero fork. Benchmark ~2.9–3.5 kH/s. No verified pool yet.',
  },
  ETI: {
    symbol: 'ETI',
    name: 'Etica',
    algo: 'rx/0',
    coin: 'etica',
    pool: null,
    statsApi: null,
    walletEnv: 'ETI_WALLET_ADDRESS',
    m4Hashrate: 3300,
    verified: false,
    liquidity: 'Very low — Nonkyc only',
    note: 'RandomX, whattomine ranks high % but market cap ~$75K (illiquid).',
  },
  XDAG: {
    symbol: 'XDAG',
    name: 'Dagger',
    algo: 'rx/0',
    coin: 'xdag',
    pool: null,
    statsApi: null,
    walletEnv: 'XDAG_WALLET_ADDRESS',
    m4Hashrate: 3300,
    verified: false,
    liquidity: 'Very low — Nonkyc only',
    note: 'RandomX, whattomine ranks high % but ~$921K market cap (illiquid).',
  },
  RTM: {
    symbol: 'RTM',
    name: 'Raptoreum',
    algo: 'ghostrider',
    coin: 'raptoreum',
    pool: null,
    statsApi: null,
    walletEnv: 'RTM_WALLET_ADDRESS',
    m4Hashrate: null, // not benchmarked
    verified: false,
    liquidity: 'Low — CoinEx',
    note: 'GhostRider (CPU ASIC-resistant). No verified pool; profitability low.',
  },
  DERO: {
    symbol: 'DERO',
    name: 'Dero',
    algo: 'astrobwt',
    coin: 'dero',
    pool: null,
    statsApi: null,
    walletEnv: 'DERO_WALLET_ADDRESS',
    m4Hashrate: null,
    verified: false,
    liquidity: 'Low',
    note: 'AstroBWTv3 — CPU-only but M4 not strong here; profitability ~15% of XMR.',
  },
};

/** Wallet address for a coin from env, or null. */
function walletFor(symbol) {
  const coin = COINS[symbol];
  if (!coin || !coin.walletEnv) return null;
  const addr = (process.env[coin.walletEnv] || '').trim();
  return addr || null;
}

/** Is the coin switchable? Requires verified pool AND a configured wallet. */
function isSwitchable(symbol) {
  const coin = COINS[symbol];
  return Boolean(coin && coin.verified && coin.pool && walletFor(symbol));
}

module.exports = { COINS, walletFor, isSwitchable };
