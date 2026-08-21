const { pool } = require('../config/db');

const POLL_MS = Number(process.env.ORDER_OUTBOX_POLL_MS || 15000);
const MAX_ATTEMPTS = 5;
let workerStarted = false;
let workerTimer = null;

function renterFor(marketplace) {
  return String(marketplace || '').toUpperCase() === 'MRR'
    ? require('./mrrRenter')
    : require('./hashrateRenter');
}

async function refundAndFail(client, order, reason) {
  await client.query(
    `UPDATE user_wallets
        SET usdc_balance = usdc_balance + $1, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = $2`,
    [order.usdc_cost, order.user_id]
  );
  await client.query('DELETE FROM protocol_revenue_ledger WHERE order_id = $1', [order.order_id]);

  // Immediate placement failures have not activated a rig. A later terminal
  // marketplace failure in PLACED state must restore the pre-order state.
  if (order.outbox_state === 'PLACED' && order.created_rig) {
    await client.query(
      'DELETE FROM virtual_rigs WHERE user_id = $1 AND target_pool = $2',
      [order.user_id, order.target_pool]
    );
    await client.query(
      "DELETE FROM capacity_slices WHERE user_id = $1 AND target_pool = $2 AND source = 'RENTAL'",
      [order.user_id, order.target_pool]
    );
  } else if (order.outbox_state === 'PLACED') {
    await client.query(
      `UPDATE virtual_rigs
          SET level = $1, virtual_hashrate = $2, rental_expires_at = $3,
              maintenance_status = CASE WHEN $3 > CURRENT_TIMESTAMP THEN 'ACTIVE' ELSE maintenance_status END,
              updated_at = CURRENT_TIMESTAMP
        WHERE user_id = $4 AND target_pool = $5`,
      [
        order.prior_rig_level,
        order.prior_rig_hashrate,
        order.prior_rental_expires_at,
        order.user_id,
        order.target_pool,
      ]
    );
    if (order.prior_rental_expires_at) {
      await client.query(
        `INSERT INTO capacity_slices
          (user_id, target_pool, virtual_hashrate, source, starts_at, expires_at)
         VALUES ($1, $2, $3, 'RENTAL', COALESCE($5, CURRENT_TIMESTAMP), $4)
         ON CONFLICT (user_id, target_pool) WHERE source = 'RENTAL'
         DO UPDATE SET virtual_hashrate = EXCLUDED.virtual_hashrate,
                       expires_at = EXCLUDED.expires_at`,
        [
          order.user_id,
          order.target_pool,
          order.prior_rig_hashrate,
          order.prior_rental_expires_at,
          order.prior_rental_starts_at,
        ]
      );
    } else {
      await client.query(
        "DELETE FROM capacity_slices WHERE user_id = $1 AND target_pool = $2 AND source = 'RENTAL'",
        [order.user_id, order.target_pool]
      );
    }
  }

  await client.query(
    `UPDATE hashrate_orders
        SET status = 'REFUNDED', outbox_state = 'FAILED', failure_reason = $1,
            processing_lease_until = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE order_id = $2`,
    [String(reason || 'Marketplace placement failed'), order.order_id]
  );
}

async function failOrder(order, reason) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query(
      `SELECT * FROM hashrate_orders
        WHERE order_id = $1 AND outbox_state NOT IN ('FAILED', 'RECONCILED')
        FOR UPDATE`,
      [order.order_id]
    );
    if (locked.rowCount > 0) await refundAndFail(client, locked.rows[0], reason);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function claimNextOrder() {
  const { rows } = await pool.query(
    `UPDATE hashrate_orders h
        SET outbox_state = 'PROCESSING',
            processing_lease_until = CURRENT_TIMESTAMP + INTERVAL '60 seconds',
            last_attempt_at = CURRENT_TIMESTAMP,
            attempts = attempts + 1,
            updated_at = CURRENT_TIMESTAMP
      WHERE h.order_id = (
        SELECT order_id FROM hashrate_orders
         WHERE marketplace NOT IN ('SESSION', 'SELF-MINED')
           AND attempts < $1
           AND (
             outbox_state = 'PENDING'
             OR (outbox_state = 'PROCESSING' AND processing_lease_until < CURRENT_TIMESTAMP)
           )
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING h.*`,
    [MAX_ATTEMPTS]
  );
  return rows[0] || null;
}

async function markPlaced(order, result) {
  const rentalHours = Number(result.rigHours) > 0 ? Number(result.rigHours) : 72;
  const priorExpiry = order.prior_rental_expires_at && new Date(order.prior_rental_expires_at).getTime();
  const base = order.renewal && priorExpiry > Date.now() ? priorExpiry : Date.now();
  const expiresAt = new Date(base + rentalHours * 3600000);
  const status = result.mode === 'live' ? 'PLACED' : 'SIMULATED';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const placed = await client.query(
      `UPDATE hashrate_orders
          SET nicehash_order_id = $1, status = $2, sandbox = $3,
              rig_name = $4, rig_rpi = $5, rig_hours = $6,
              outbox_state = 'PLACED', processing_lease_until = NULL,
              updated_at = CURRENT_TIMESTAMP
        WHERE order_id = $7 AND outbox_state = 'PROCESSING'`,
      [
        result.orderId || null,
        status,
        result.mode !== 'live',
        result.rigName || null,
        result.rigRpi == null ? null : String(result.rigRpi),
        rentalHours,
        order.order_id,
      ]
    );
    if (placed.rowCount === 0) {
      await client.query('COMMIT');
      return;
    }
    if (order.created_rig) {
      await client.query(
        `INSERT INTO virtual_rigs
          (user_id, target_pool, virtual_hashrate, level, maintenance_status, rental_expires_at)
         VALUES ($1, $2, $3, $4, 'ACTIVE', $5)`,
        [order.user_id, order.target_pool, order.requested_rig_hashrate, order.requested_rig_level, expiresAt]
      );
    } else {
      await client.query(
        `UPDATE virtual_rigs SET level = $1, virtual_hashrate = $2,
                rental_expires_at = $3, maintenance_status = 'ACTIVE', updated_at = CURRENT_TIMESTAMP
          WHERE user_id = $4 AND target_pool = $5`,
        [order.requested_rig_level, order.requested_rig_hashrate, expiresAt, order.user_id, order.target_pool]
      );
    }
    const rig = await client.query(
      `SELECT rig_id, virtual_hashrate FROM virtual_rigs
        WHERE user_id = $1 AND target_pool = $2`,
      [order.user_id, order.target_pool]
    );
    await client.query(
      `INSERT INTO capacity_slices
        (user_id, target_pool, virtual_hashrate, source, starts_at, expires_at)
       VALUES ($1, $2, $3, 'RENTAL', CURRENT_TIMESTAMP, $4)
       ON CONFLICT (user_id, target_pool) WHERE source = 'RENTAL'
       DO UPDATE SET virtual_hashrate = EXCLUDED.virtual_hashrate,
                     starts_at = CASE
                       WHEN $5 AND capacity_slices.expires_at > CURRENT_TIMESTAMP
                         THEN capacity_slices.starts_at
                       ELSE CURRENT_TIMESTAMP
                     END,
                     expires_at = EXCLUDED.expires_at`,
      [order.user_id, order.target_pool, rig.rows[0].virtual_hashrate, expiresAt, order.renewal]
    );
    if (result.orderId && rig.rows[0]?.rig_id) {
      const actualCostBtc = Number(result.actualCostBtc) > 0
        ? Number(result.actualCostBtc)
        : Number(order.btc_spent);
      await client.query(
        `INSERT INTO rig_rentals
          (user_id, rig_id, target_pool, mrr_rental_id, rig_name, rig_rpi,
           cost_btc, cost_usd, length_hours, funded_from, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'POOL', 'ACTIVE')`,
        [
          order.user_id,
          rig.rows[0].rig_id,
          order.target_pool,
          String(result.orderId),
          result.rigName || null,
          result.rigRpi == null ? null : String(result.rigRpi),
          actualCostBtc,
          actualCostBtc * Number(order.btc_spot_price),
          rentalHours,
        ]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function processOneOrder() {
  const order = await claimNextOrder();
  if (!order) return false;
  let result;
  try {
    result = await renterFor(order.marketplace).placeHashpowerOrder(
      order.target_pool,
      Number(order.btc_spent),
      order.request_id
    );
  } catch (err) {
    result = { success: false, error: err.message };
  }
  if (!result?.success) {
    await failOrder(order, result?.error || 'Marketplace placement failed');
    return true;
  }
  await markPlaced(order, result);
  return true;
}

async function failExhaustedOrders() {
  const { rows } = await pool.query(
    `SELECT * FROM hashrate_orders
      WHERE marketplace NOT IN ('SESSION', 'SELF-MINED') AND attempts >= $1
        AND (outbox_state = 'PENDING'
          OR (outbox_state = 'PROCESSING' AND processing_lease_until < CURRENT_TIMESTAMP))`,
    [MAX_ATTEMPTS]
  );
  for (const order of rows) await failOrder(order, `Marketplace placement failed after ${MAX_ATTEMPTS} attempts`);
  return rows.length;
}

function confirmedStatus(status) {
  return ['PLACED', 'ACTIVE', 'RUNNING', 'COMPLETED', 'FINISHED'].includes(String(status || '').toUpperCase());
}

function failedStatus(status) {
  return ['FAILED', 'CANCELLED', 'CANCELED', 'EXPIRED', 'DEAD'].includes(String(status || '').toUpperCase());
}

async function reconcilePlacedOrders() {
  const { rows } = await pool.query(
    `SELECT * FROM hashrate_orders
      WHERE outbox_state = 'PLACED' AND nicehash_order_id IS NOT NULL
      ORDER BY updated_at LIMIT 25`
  );
  let reconciled = 0;
  for (const order of rows) {
    try {
      const result = await renterFor(order.marketplace).getOrderStatus(order.nicehash_order_id);
      const status = result?.status || result?.data?.status;
      if (confirmedStatus(status)) {
        await pool.query(
          `UPDATE hashrate_orders SET outbox_state = 'RECONCILED', updated_at = CURRENT_TIMESTAMP
            WHERE order_id = $1 AND outbox_state = 'PLACED'`,
          [order.order_id]
        );
        reconciled += 1;
      } else if (failedStatus(status)) {
        await failOrder(order, `Marketplace reports terminal status ${status}`);
      }
    } catch (err) {
      console.warn(`Outbox reconciliation deferred for ${order.request_id}: ${err.message}`);
    }
  }
  return reconciled;
}

async function runOutboxOnce() {
  const exhausted = await failExhaustedOrders();
  const processed = await processOneOrder();
  const reconciled = await reconcilePlacedOrders();
  return { exhausted, processed, reconciled };
}

function startOrderOutboxWorker() {
  if (workerStarted) return;
  workerStarted = true;
  const poll = () => runOutboxOnce().catch((err) => console.error('Order outbox error:', err));
  poll();
  workerTimer = setInterval(poll, POLL_MS);
  console.log(`Order outbox worker started (every ${POLL_MS / 1000}s)`);
}

module.exports = {
  startOrderOutboxWorker,
  runOutboxOnce,
  claimNextOrder,
  processOneOrder,
  reconcilePlacedOrders,
  failExhaustedOrders,
  refundAndFail,
  markPlaced,
  MAX_ATTEMPTS,
};
