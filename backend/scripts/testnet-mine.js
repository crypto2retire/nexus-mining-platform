#!/usr/bin/env node
/**
 * TESTNET MINE SESSION — proves the full NiceHash order loop with ZERO real funds.
 *
 * Usage:
 *   NICEHASH_ENV=test \
 *   NICEHASH_API_KEY=<key> NICEHASH_API_SECRET=<secret> NICEHASH_ORG_ID=<org> \
 *   NICEHASH_LIVE_ORDERS=1 \
 *   [NICEHASH_POOL_ID=<pool>] \
 *   node backend/scripts/testnet-mine.js [ZHASH|KHEAVYHASH|SCRYPT]
 *
 * Key permissions needed: PRCO (place orders), VHOR (view orders),
 * VBTD (view balances), MAPO (manage pools).
 */
require('dotenv').config();
const {
  placeHashpowerOrder,
  getOrderStatus,
  getAlgorithms,
  getBuyInfo,
  makeNiceHashRequest,
  getNiceHashHost,
  POOL_ALGORITHM_MAP,
} = require('../services/hashrateRenter');

const ALGO = (process.argv[2] || 'ZHASH').toUpperCase();
const TARGET_POOL = Object.keys(POOL_ALGORITHM_MAP).find((k) => POOL_ALGORITHM_MAP[k] === ALGO);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!TARGET_POOL) {
    console.error(`Unknown algorithm '${ALGO}'. Use one of: ${Object.values(POOL_ALGORITHM_MAP).join(', ')}`);
    process.exit(1);
  }
  const env = process.env.NICEHASH_ENV || 'main';
  console.log(`🔬 TESTNET MINE SESSION — ${ALGO} (target pool: ${TARGET_POOL})`);
  console.log(`   API host: ${getNiceHashHost()}   environment: ${env}`);

  if (env !== 'test') {
    console.error('⚠️  NICEHASH_ENV=test is required for a free testnet session.');
    process.exit(1);
  }
  if (!process.env.NICEHASH_API_KEY || !process.env.NICEHASH_API_SECRET || !process.env.NICEHASH_ORG_ID) {
    console.error('⚠️  Set NICEHASH_API_KEY, NICEHASH_API_SECRET, NICEHASH_ORG_ID (test platform keys).');
    process.exit(1);
  }
  if (process.env.NICEHASH_LIVE_ORDERS !== '1') {
    console.error('⚠️  Set NICEHASH_LIVE_ORDERS=1 to allow real (testnet) order placement.');
    process.exit(1);
  }

  // 1) Wallet balance (VBTD)
  try {
    const accounts = await makeNiceHashRequest('GET', '/main/api/v2/accounting/accounts2/');
    const btc = (accounts || []).find((a) => a.currency === 'BTC') || {};
    console.log(`\n[1/4] Testnet wallet: BTC balance = ${btc.balance ?? 'n/a'} ${btc.availableBalance ? `(available ${btc.availableBalance})` : ''}`);
  } catch (e) {
    console.error('\n[1/4] Balance fetch failed:', e.response?.data?.errors?.[0]?.message || e.message);
    console.error('      (key needs VBTD permission)');
  }

  // 2) Pool (MAPO) — order cannot be placed without poolId
  let poolId = process.env.NICEHASH_POOL_ID || '';
  if (!poolId) {
    try {
      const pools = await makeNiceHashRequest('GET', '/main/api/v2/pool');
      if (Array.isArray(pools) && pools.length > 0) {
        poolId = pools[0].id;
        console.log(`\n[2/4] Using existing pool: ${poolId}`);
      }
    } catch (e) {
      console.error('\n[2/4] Pool list failed:', e.response?.data?.errors?.[0]?.message || e.message);
    }
  }
  if (!poolId) {
    console.error('\n[2/4] No pool configured. Either:');
    console.error('   - set NICEHASH_POOL_ID, or');
    console.error('   - on https://test.nicehash.com create a pool: Hashrate Marketplace → Your Pools → Add Pool,');
    console.error('     then copy its ID into NICEHASH_POOL_ID.');
    process.exit(1);
  }
  console.log(`\n[2/4] Pool ID: ${poolId}`);

  // 3) Live testnet limits + smallest possible order
  console.log('\n[3/4] Fetching live testnet limits…');
  const [algoRes, buyInfo] = await Promise.all([getAlgorithms(), getBuyInfo(ALGO)]);
  const algo = (algoRes.miningAlgorithms || []).find((a) => a.algorithm === ALGO);
  const book = (buyInfo.miningAlgorithms || []).find((a) => String(a.name || '').toUpperCase() === ALGO.toUpperCase());
  const minimalOrderAmount = Number(algo?.minimalOrderAmount ?? book?.min_amount ?? 0.001);
  const minSpeedLimit = Number(algo?.minSpeedLimit ?? book?.min_limit ?? 0);
  const minPrice = Number(book?.min_price ?? 0.0001);

  console.log(`   minimalOrderAmount: ${minimalOrderAmount} BTC | minPrice: ${minPrice} | minSpeedLimit: ${minSpeedLimit} ${algo?.displayMarketFactor || book?.speed_text || ''}`);

  const result = await placeHashpowerOrder(TARGET_POOL, minimalOrderAmount);
  console.log('\n   Order result:', JSON.stringify(result, null, 2));
  if (!result.success || !result.orderId) {
    console.error('\n❌ ORDER PLACEMENT FAILED — test session incomplete.');
    process.exit(1);
  }

  // 4) Poll order status (VHOR)
  console.log('\n[4/4] Polling order status…');
  for (let i = 0; i < 3; i++) {
    await sleep(5000);
    try {
      const status = await getOrderStatus(result.orderId);
      console.log(`   poll ${i + 1}:`, JSON.stringify(status).slice(0, 400));
    } catch (e) {
      console.error(`   poll ${i + 1} failed:`, e.response?.data?.errors?.[0]?.message || e.message);
    }
  }

  console.log('\n✅ TESTNET SESSION COMPLETE — order placed and tracked with zero real funds.');
  console.log('   Audit: orderId=' + result.orderId + ' algo=' + ALGO + ' amount=' + minimalOrderAmount + ' BTC');
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
