/**
 * rentalScheduler.js — GoMiner re-rental loop.
 *
 * Keeps "owned hashrate" honest: every ACTIVE virtual rig must be backed by a
 * real MRR rental, and that rental is paid ONLY from what the rig itself
 * earned (collected maintenance) — or, when the owner has explicitly OK'd
 * mining at a loss, from their USDC balance. The platform never fronts
 * ongoing mining costs, and a rig whose funds run out auto-pauses (DORMANT).
 *
 * Loop per tick (every RENTAL_SCHEDULER_INTERVAL_MS, default 15 min):
 *   1. Fetch MRR's active rental list; mark any rig_rentals ACTIVE rows whose
 *      rental is gone as ENDED.
 *   2. For each ACTIVE virtual rig in a marketplace pool (ZCASH/KASPA/LTC_DOGE/XMR):
 *      a. Skip if it already has an ACTIVE rental backing it.
 *      b. available = SUM(maintenance_fee_ledger) - SUM(rig_rentals.cost_usd)
 *         for this user+pool. That is the rig's own mining fund.
 *      c. If available <= 0:
 *         - mine_at_loss OFF -> DORMANT (auto-pause; user protected).
 *         - mine_at_loss ON  -> fund the next rental from the user's USDC
 *           balance instead (they OK'd the loss). Still never goes negative.
 *      d. Place the rental via the platform's own MRR client (verified-rig
 *         selection + minimum-hashrate filter), record the rig_rentals row.
 *
 * Safety rails:
 *   - Real orders only when the MRR live triple-gate passes (isLiveMode).
 *   - RENTAL_DAILY_SPEND_CAP_USD global daily cap (default $20) — the
 *     scheduler can never spend more than this per UTC day.
 *   - RENTAL_SCHEDULER_ENABLED=1 must be set explicitly to start the loop.
 *   - Per-rig budget is bounded by what it collected (or the USDC the owner
 *     approved) — a single rig can never consume the whole platform float.
 */

const { pool } = require('../config/db');
const { getLiveBtcPrice } = require('./priceOracle');
const mrr = require('./mrrRenter');

const INTERVAL_MS = Number(process.env.RENTAL_SCHEDULER_INTERVAL_MS || 15 * 60 * 1000);
const DAILY_CAP_USD = Number(process.env.RENTAL_DAILY_SPEND_CAP_USD || 20);
const MIN_FUND_USD = 0.25; // don't chase sub-25c rentals

let timer = null;
let running = false;

function startRentalScheduler() {
  if (process.env.RENTAL_SCHEDULER_ENABLED !== '1') {
    console.log('rentalScheduler: disabled (set RENTAL_SCHEDULER_ENABLED=1 to run)');
    return;
  }
  if (timer) return;
  console.log(`rentalScheduler: starting (every ${Math.round(INTERVAL_MS / 60000)} min, daily cap $${DAILY_CAP_USD})`);
  timer = setInterval(() => {
    schedulerTick().catch((err) => console.error('rentalScheduler tick error:', err));
  }, INTERVAL_MS);
  // First tick shortly after boot so rigs aren't left unbacked for a full interval.
  setTimeout(() => schedulerTick().catch((err) => console.error('rentalScheduler first tick error:', err)), 5000);
}

function stopRentalScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function schedulerTick() {
  if (running) return; // never overlap ticks
  running = true;
  try {
    await runSchedulerOnce();
  } catch (err) {
    console.error('rentalScheduler error:', err);
  } finally {
    running = false;
  }
}

/** Extract the rental id from an MRR placement response (several shapes seen). */
function rentalIdOf(result) {
  return (
    result?.data?.rental?.id ||
    result?.data?.id ||
    result?.rental?.id ||
    result?.id ||
    null
  );
}

async function runSchedulerOnce() {
  if (!mrr.isLiveMode()) {
    console.log('rentalScheduler: live MRR orders not enabled — skipping (safety rail)');
    return;
  }

  // 1. Which MRR rentals are still active right now?
  let activeRentals = new Map();
  try {
    const data = await mrr.makeMrrRequest('GET', '/rental');
    for (const r of data?.data?.rentals || []) {
      if (!r?.ended) activeRentals.set(String(r.id), r);
    }
  } catch (err) {
    console.error('rentalScheduler: MRR rental list unavailable:', err.message);
    return;
  }

  // BTC price once per tick for USD<->BTC conversions.
  let btcPrice = 100000; // last-resort fallback; refreshed below
  try {
    const quote = await getLiveBtcPrice();
    if (quote?.price > 0) btcPrice = quote.price;
  } catch (err) {
    console.warn(`rentalScheduler: price oracle down (${err.message}) — using fallback ${btcPrice}`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 2. Close out rig_rentals rows whose MRR rental is no longer active.
    const openRows = await client.query(
      `SELECT id, mrr_rental_id, rig_id FROM rig_rentals WHERE status = 'ACTIVE'`
    );
    for (const row of openRows.rows) {
      if (!activeRentals.has(String(row.mrr_rental_id))) {
        await client.query(
          `UPDATE rig_rentals SET status = 'ENDED', ended_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [row.id]
        );
        console.log(`rentalScheduler: rental ${row.mrr_rental_id} for rig ${row.rig_id} ended`);
      }
    }

    // 3. Today's spend so far (UTC) against the global cap.
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const spent = await client.query(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM rig_rentals
        WHERE created_at >= $1 AND status = 'ACTIVE'`,
      [todayStart]
    );
    let remainingCapUsd = DAILY_CAP_USD - Number(spent.rows[0]?.total || 0);

    // 4. Rigs that need real backing. All four rooms are rental-backed.
    const rigs = await client.query(
      `SELECT v.rig_id, v.user_id, v.target_pool, v.virtual_hashrate, v.level, v.mine_at_loss
        FROM virtual_rigs v
       WHERE v.maintenance_status = 'ACTIVE'
         AND v.target_pool IN ('ZCASH', 'KASPA', 'LTC_DOGE', 'XMR')`
    );

    for (const rig of rigs.rows) {
      const backing = await client.query(
        `SELECT id FROM rig_rentals WHERE rig_id = $1 AND status = 'ACTIVE' LIMIT 1`,
        [rig.rig_id]
      );
      if (backing.rowCount > 0) continue;

      // b. The rig's own mining fund: collected maintenance minus all rentals spent.
      const funds = await client.query(
        `SELECT
           COALESCE((SELECT SUM(amount_usdc) FROM maintenance_fee_ledger
                      WHERE user_id = $1 AND target_pool = $2), 0) AS collected,
           COALESCE((SELECT SUM(cost_usd) FROM rig_rentals
                      WHERE user_id = $1 AND target_pool = $2), 0) AS spent`,
        [rig.user_id, rig.target_pool]
      );
      let availableUsd = Number(funds.rows[0]?.collected || 0) - Number(funds.rows[0]?.spent || 0);
      let fundedFrom = 'POOL';
      let walletId = null;

      // c. Fund check — the honest auto-pause.
      if (availableUsd < MIN_FUND_USD) {
        if (rig.mine_at_loss !== true) {
          await goDormant(client, rig, `maintenance pool exhausted (${availableUsd.toFixed(4)} USD)`);
          continue;
        }
        // Owner OK'd mining at a loss: fund from their USDC balance instead.
        const wallet = await client.query(
          'SELECT wallet_id, usdc_balance FROM user_wallets WHERE user_id = $1 FOR UPDATE',
          [rig.user_id]
        );
        const balance = Number(wallet.rows[0]?.usdc_balance || 0);
        if (balance < MIN_FUND_USD) {
          await goDormant(client, rig, `pool exhausted and USDC balance ${balance.toFixed(2)} can't fund loss mining`);
          continue;
        }
        availableUsd = balance;
        fundedFrom = 'USDC';
        walletId = wallet.rows[0].wallet_id;
      }

      if (remainingCapUsd <= 0) {
        console.log(`rentalScheduler: daily cap $${DAILY_CAP_USD} reached — rig ${rig.rig_id}/${rig.target_pool} waits`);
        continue;
      }

      // d. Rent with the platform's verified selection within the rig's own budget.
      const budgetBtc = Math.min(availableUsd, remainingCapUsd) / btcPrice;
      const algo = mrr.POOL_ALGORITHM_MAP[rig.target_pool];
      const profileId = process.env[`MRR_POOL_PROFILE_${algo}`] || '';
      if (!profileId) {
        console.log(`rentalScheduler: no MRR_POOL_PROFILE_${algo} env — rig ${rig.rig_id} can't be backed`);
        continue;
      }

      let fit;
      try {
        fit = await mrr.findAffordableRig(algo.toLowerCase(), budgetBtc);
      } catch (err) {
        console.error(`rentalScheduler: market scan failed for ${algo}:`, err.message);
        continue;
      }
      if (!fit) {
        console.log(`rentalScheduler: no affordable verified ${algo} rig within $${Math.min(availableUsd, remainingCapUsd).toFixed(2)} for rig ${rig.rig_id}`);
        continue;
      }

      let result;
      try {
        result = await mrr.makeMrrRequest('PUT', '/rental', null, {
          rig: fit.rigId,
          length: fit.length,
          profile: profileId,
          currency: 'BTC',
        });
      } catch (err) {
        console.error(`rentalScheduler: rental placement failed for ${fit.rigName}:`, err.message);
        continue;
      }
      if (!result?.success) {
        console.error(`rentalScheduler: MRR rejected rental (${fit.rigName}):`, JSON.stringify(result?.data || result).slice(0, 300));
        continue;
      }

      const rentalId = rentalIdOf(result);
      const costUsd = parseFloat((fit.cost * btcPrice).toFixed(4));

      // Charge the user's USDC when they funded this loss-rental. The guard
      // makes it atomic: never let the balance go negative.
      if (fundedFrom === 'USDC') {
        const charged = await client.query(
          `UPDATE user_wallets
              SET usdc_balance = usdc_balance - $1, updated_at = CURRENT_TIMESTAMP
            WHERE wallet_id = $2 AND usdc_balance >= $1`,
          [costUsd, walletId]
        );
        if (charged.rowCount === 0) {
          console.log(`rentalScheduler: USDC balance changed — rental ${rentalId} placed but not charged; flagging`);
        }
      }

      await client.query(
        `INSERT INTO rig_rentals
          (user_id, rig_id, target_pool, mrr_rental_id, rig_name, rig_rpi,
           cost_btc, cost_usd, length_hours, funded_from, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'ACTIVE')`,
        [
          rig.user_id,
          rig.rig_id,
          rig.target_pool,
          rentalId ? String(rentalId) : null,
          fit.rigName || null,
          fit.rigRpi != null ? String(fit.rigRpi) : null,
          fit.cost,
          costUsd,
          fit.length,
          fundedFrom,
        ]
      );
      remainingCapUsd -= costUsd;
      console.log(`rentalScheduler: backed rig ${rig.rig_id}/${rig.target_pool} — ${fit.rigName} (${fit.rigRpi}) ${fit.length}h $${costUsd.toFixed(2)} ${fundedFrom} rental ${rentalId || 'n/a'}`);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('rentalScheduler transaction error:', err);
    throw err;
  } finally {
    client.release();
  }
}

async function goDormant(client, rig, reason) {
  await client.query(
    `UPDATE virtual_rigs
        SET maintenance_status = 'DORMANT', dormant_at = CURRENT_TIMESTAMP
      WHERE rig_id = $1`,
    [rig.rig_id]
  );
  await client.query(
    'INSERT INTO rig_hashrate_history (user_id, target_pool, hashrate) VALUES ($1, $2, 0)',
    [rig.user_id, rig.target_pool]
  );
  console.log(`⏸ rentalScheduler: rig ${rig.rig_id}/${rig.target_pool} DORMANT — ${reason}`);
}

module.exports = {
  startRentalScheduler,
  stopRentalScheduler,
  schedulerTick,
  runSchedulerOnce,
  INTERVAL_MS,
  DAILY_CAP_USD,
};
