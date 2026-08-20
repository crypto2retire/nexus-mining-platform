const { distributeAccrued } = require('./rewardDistributor');

/**
 * accrualDistributor.js — daily/6-hourly in-game payouts (016, 2026-08-20).
 *
 * Kevin's catch: a 72h rental waited ~27 days for the pool's 50 KAS minimum
 * to settle — nobody plays that. Fix: every interval, distribute each room's
 * NEW real production (delta of the pool's unpaid + settled payments), so
 * users see yield grow and can claim/withdraw immediately. The platform
 * float is structurally capped at the unsettled unpaid; the pool's payment
 * reimburses the treasury (payoutTrigger records it as settlement only when
 * ACCRUAL_DISTRIBUTION_ENABLED=1).
 *
 * Only unpaid-visible rooms accrue (ZCASH/KASPA/XMR). LTC_DOGE's unpaid is
 * hidden (F2Pool 404s on ltc1 addresses), so its earnedTotal basis would
 * double-count the on-chain balance — it stays settlement-gated (~1 day
 * horizon, fine).
 */

const INTERVAL_MS = Number(process.env.ACCRUAL_DISTRIBUTION_INTERVAL_HOURS || 6) * 3600 * 1000;
const ACCRUAL_POOLS = ['ZCASH', 'KASPA', 'XMR'];

let timer = null;
let running = false;

function startAccrualDistributor() {
  if (process.env.ACCRUAL_DISTRIBUTION_ENABLED !== '1') {
    console.log('accrualDistributor: disabled (set ACCRUAL_DISTRIBUTION_ENABLED=1 to run)');
    return;
  }
  if (timer) return;
  console.log(`accrualDistributor: starting (every ${Math.round(INTERVAL_MS / 3600000)}h) for ${ACCRUAL_POOLS.join(', ')}`);
  timer = setInterval(() => {
    runAccrualOnce().catch((err) => console.error('accrualDistributor tick error:', err));
  }, INTERVAL_MS);
  // First run shortly after boot so pending yield appears quickly.
  setTimeout(() => runAccrualOnce().catch((err) => console.error('accrualDistributor first tick error:', err)), 20000);
}

function stopAccrualDistributor() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function runAccrualOnce() {
  if (running) return { skipped: true, reason: 'already-running' };
  running = true;
  const results = [];
  try {
    for (const pool of ACCRUAL_POOLS) {
      try {
        results.push(await distributeAccrued(pool));
      } catch (err) {
        console.error(`accrual failed for ${pool}:`, err.message);
        results.push({ pool, status: 'error', error: err.message });
      }
    }
  } finally {
    running = false;
  }
  return results;
}

module.exports = { startAccrualDistributor, stopAccrualDistributor, runAccrualOnce, ACCRUAL_POOLS, INTERVAL_MS };
