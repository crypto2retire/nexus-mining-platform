const axios = require('axios');
const { pool } = require('../config/db');
const { POOL_CONFIG } = require('./connectService');
const {
  getOrderStatus,
  placeHashpowerOrder,
  switchRentalPool,
} = require('./mrrRenter');

const POLL_MS = 15000;
const SWEEP_MS = 5 * 60 * 1000;
const TERMINAL = new Set(['COMPLETED', 'FAILED', 'FAILED_REVIEW', 'REFUNDED']);
let workerStarted = false;

function errorMessage(error, fallback) {
  return String(error?.response?.data?.data?.message ||
    error?.response?.data?.message || error?.message || fallback);
}

async function claimNextPendingOrder() {
  const result = await pool.query(
    `WITH pending AS (
       SELECT candidate.id, candidate.user_id
         FROM connect_orders candidate
        WHERE candidate.status = 'PENDING_RENT'
          AND candidate.rent_attempts < 1
          AND (SELECT COUNT(*) FROM connect_orders active
                WHERE active.status IN ('RENTING', 'POOL_POINTED', 'ACTIVE')) < 2
          AND NOT EXISTS (
            SELECT 1 FROM connect_orders other
             WHERE other.user_id = candidate.user_id
               AND other.status IN ('RENTING', 'POOL_POINTED', 'ACTIVE')
          )
        ORDER BY candidate.created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     UPDATE connect_orders c
        SET status = 'RENTING',
            rent_attempts = c.rent_attempts + 1,
            processing_lease_until = CURRENT_TIMESTAMP + INTERVAL '90 seconds',
            last_attempt_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
       FROM pending
      WHERE c.id = pending.id
      RETURNING c.*`
  );
  return result.rows[0] || null;
}

function rentalEnd(result, lengthHours) {
  const supplied = result?.mrrResponse?.data?.rental?.end ||
    result?.mrrResponse?.data?.end || result?.mrrResponse?.rental?.end;
  const parsed = supplied && new Date(supplied);
  if (parsed && Number.isFinite(parsed.getTime())) return parsed;
  return new Date(Date.now() + Number(lengthHours) * 3600000);
}

async function markFailedReview(orderId, reason) {
  await pool.query(
    `UPDATE connect_orders
        SET status = 'FAILED_REVIEW', failure_reason = $1,
            processing_lease_until = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2 AND status = 'RENTING'`,
    [String(reason || 'Ambiguous MRR rental result requires operator review'), orderId]
  );
}

async function refundConnectOrder(order, reason) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query(
      'SELECT * FROM connect_orders WHERE id = $1 FOR UPDATE',
      [order.id]
    );
    const current = locked.rows[0];
    if (!current || TERMINAL.has(String(current.status).toUpperCase())) {
      await client.query('COMMIT');
      return false;
    }
    await client.query(
      `UPDATE user_wallets
          SET usdc_balance = usdc_balance + $1, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = $2`,
      [Number(current.total_usd), current.user_id]
    );
    await client.query(
      `UPDATE connect_orders
          SET status = 'REFUNDED', failure_reason = $1,
              processing_lease_until = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2`,
      [String(reason || 'Connect order refunded'), current.id]
    );
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function processClaimedOrder(order) {
  const config = POOL_CONFIG[order.target_pool];
  if (!config) {
    await refundConnectOrder(order, `Unsupported Connect pool ${order.target_pool}`);
    return;
  }

  let rental;
  try {
    rental = await placeHashpowerOrder(
      order.target_pool,
      Number(order.rental_cost_btc),
      {
        rigId: String(order.rig_id),
        lengthHours: Number(order.length_hours),
        profileId: config.profile,
        maxCostBtc: Number(order.rental_cost_btc),
      }
    );
  } catch (err) {
    rental = { success: false, ambiguous: Boolean(err?.ambiguous), error: errorMessage(err, 'MRR rental failed') };
  }

  if (!rental?.success) {
    if (rental?.ambiguous) {
      await markFailedReview(order.id, rental.error);
    } else {
      await refundConnectOrder(order, rental?.error || 'MRR rental rejected');
    }
    return;
  }
  if (rental.mode !== 'live') {
    await refundConnectOrder(order, 'Connect requires a confirmed live MRR rental');
    return;
  }
  if (!rental.orderId) {
    await markFailedReview(order.id, 'MRR accepted the rental but returned no rental id');
    return;
  }

  const rentalId = String(rental.orderId);
  const endsAt = rentalEnd(rental, order.length_hours);
  await pool.query(
    `UPDATE connect_orders
        SET mrr_rental_id = $1, rental_ends_at = $2,
            processing_lease_until = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = $3 AND status = 'RENTING'`,
    [rentalId, endsAt, order.id]
  );

  let switchError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await switchRentalPool(rentalId, {
        host: config.host,
        port: config.port,
        user: order.payout_address,
        pass: 'x',
      });
      if (response?.success === false || response?.data?.success === false) {
        throw new Error(response?.data?.message || 'MRR rejected the pool switch');
      }
      switchError = null;
      break;
    } catch (err) {
      switchError = err;
    }
  }

  if (switchError) {
    const reason = `Pool switch failed after two attempts: ${errorMessage(switchError, 'unknown error')}`;
    console.error(`connectWorker: MANUAL MRR ACTION REQUIRED for rental ${rentalId}: ${reason}`);
    await refundConnectOrder({ ...order, mrr_rental_id: rentalId }, reason);
    return;
  }

  await pool.query(
    `UPDATE connect_orders
        SET status = 'POOL_POINTED', failure_reason = NULL,
            processing_lease_until = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status = 'RENTING'`,
    [order.id]
  );
}

function averageMrrHashrate(response) {
  const payload = response?.data?.rental || response?.data || response?.rental || response;
  const value = payload?.hashrate?.average?.hash ?? payload?.hashrate?.average ??
    payload?.average_hashrate?.hash ?? payload?.average_hashrate;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

async function verifyPointedOrder(order) {
  const config = POOL_CONFIG[order.target_pool];
  if (!config) return false;
  if (order.target_pool === 'BTC') {
    const status = await getOrderStatus(order.mrr_rental_id);
    if (averageMrrHashrate(status) > 0) {
      await pool.query(
        `UPDATE connect_orders
            SET status = 'ACTIVE', hashrate_confirmed_at = CURRENT_TIMESTAMP,
                unpaid_last = $1, unpaid_checked_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $2 AND status = 'POOL_POINTED'`,
        [null, order.id]
      );
      return true;
    }
    return false;
  }

  const response = await axios.get(config.statsUrl(order.payout_address), { timeout: 10000 });
  const unpaid = config.balanceOf(response.data);
  const hashrate = config.hashOf(response.data);
  if (hashrate > 0) {
    await pool.query(
      `UPDATE connect_orders
          SET status = 'ACTIVE', hashrate_confirmed_at = CURRENT_TIMESTAMP,
              unpaid_last = $1, unpaid_checked_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $2 AND status = 'POOL_POINTED'`,
      [unpaid, order.id]
    );
    return true;
  }
  await pool.query(
    `UPDATE connect_orders
        SET unpaid_last = $1, unpaid_checked_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = $2 AND status = 'POOL_POINTED'`,
    [unpaid, order.id]
  );
  return false;
}

async function observeActiveOrder(order) {
  const config = POOL_CONFIG[order.target_pool];
  if (!config) return null;
  const response = await axios.get(config.statsUrl(order.payout_address), { timeout: 10000 });
  const current = config.balanceOf(response.data);
  const previous = order.unpaid_last == null ? null : Number(order.unpaid_last);
  const paid = previous !== null && (
    order.target_pool === 'BTC'
      ? current > previous
      : previous >= config.floor && current < previous
  );
  await pool.query(
    `UPDATE connect_orders
        SET unpaid_last = $1, unpaid_checked_at = CURRENT_TIMESTAMP,
            paid_out_at = CASE WHEN $2 AND paid_out_at IS NULL
                               THEN CURRENT_TIMESTAMP ELSE paid_out_at END,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = $3 AND status = 'ACTIVE'`,
    [current, paid, order.id]
  );
  return current;
}

async function runConnectSweeperOnce() {
  const result = await pool.query(
    `SELECT * FROM connect_orders
      WHERE status = 'ACTIVE' AND rental_ends_at < CURRENT_TIMESTAMP
      ORDER BY rental_ends_at
      LIMIT 25`
  );
  for (const order of result.rows) {
    try {
      await observeActiveOrder(order);
    } catch (err) {
      console.warn(`connectWorker: final pool observation deferred for ${order.id}: ${errorMessage(err)}`);
    }
    await pool.query(
      `UPDATE connect_orders
          SET status = 'COMPLETED', updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND status = 'ACTIVE'`,
      [order.id]
    );
  }
  return result.rows.length;
}

async function runConnectWorkerOnce() {
  await pool.query(
    `UPDATE connect_orders
        SET status = 'FAILED_REVIEW',
            failure_reason = 'Processing lease expired; verify MRR before retrying',
            processing_lease_until = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE status = 'RENTING' AND processing_lease_until < CURRENT_TIMESTAMP
        AND mrr_rental_id IS NULL`
  );
  const claimed = await claimNextPendingOrder();
  if (claimed) await processClaimedOrder(claimed);

  const pointed = await pool.query(
    `SELECT * FROM connect_orders WHERE status = 'POOL_POINTED'
      ORDER BY updated_at LIMIT 10`
  );
  for (const order of pointed.rows) {
    try {
      await verifyPointedOrder(order);
    } catch (err) {
      console.warn(`connectWorker: verification deferred for ${order.id}: ${errorMessage(err)}`);
    }
  }

  const active = await pool.query(
    `SELECT * FROM connect_orders
      WHERE status = 'ACTIVE' AND rental_ends_at >= CURRENT_TIMESTAMP
      ORDER BY unpaid_checked_at NULLS FIRST LIMIT 10`
  );
  for (const order of active.rows) {
    try {
      await observeActiveOrder(order);
    } catch (err) {
      console.warn(`connectWorker: pool observation deferred for ${order.id}: ${errorMessage(err)}`);
    }
  }
  return { claimed: Boolean(claimed), verified: pointed.rows.length, observed: active.rows.length };
}

function startConnectWorker() {
  if (process.env.ENABLE_CONNECT !== '1') {
    console.log('connectWorker: disabled');
    return;
  }
  if (workerStarted) return;
  workerStarted = true;
  const poll = () => runConnectWorkerOnce()
    .catch((err) => console.error('connectWorker tick error:', errorMessage(err)));
  const sweep = () => runConnectSweeperOnce()
    .catch((err) => console.error('connectWorker sweep error:', errorMessage(err)));
  poll();
  setInterval(poll, POLL_MS);
  setInterval(sweep, SWEEP_MS);
  console.log('connectWorker: enabled');
}

module.exports = {
  POLL_MS,
  SWEEP_MS,
  claimNextPendingOrder,
  observeActiveOrder,
  processClaimedOrder,
  refundConnectOrder,
  runConnectSweeperOnce,
  runConnectWorkerOnce,
  startConnectWorker,
  verifyPointedOrder,
};
