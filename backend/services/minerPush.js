const crypto = require('crypto');

/**
 * Outbound miner push (2026-08-19) — replaces the reverse-SSH-tunnel path.
 *
 * The Mac miner agent POSTs the XMRig status here every ~15s over outbound
 * HTTPS, and polls GET /commands for start/stop/switch actions that the
 * droplet's admin endpoints have queued (stored in miner_commands).
 *
 * The status cache is in-memory (ephemeral by design — a fresh push arrives
 * every 15s; a droplet restart just waits one interval). Commands live in
 * Postgres so a queued command survives a droplet restart between enqueue
 * and pickup.
 *
 * All three agent endpoints are guarded by MINER_PUSH_KEY (shared secret,
 * sent as `x-push-key`).
 */

let lastStatus = null; // { ...statusFields, pushed_at: <server ms> }

function pushStatus(payload) {
  lastStatus = { ...(payload || {}), pushed_at: Date.now() };
  return lastStatus;
}

function getCachedStatus() {
  return lastStatus;
}

/** Compare the request's x-push-key against MINER_PUSH_KEY (timing-safe). */
function authorizePushKey(req) {
  const expected = process.env.MINER_PUSH_KEY;
  if (!expected) return false; // fail closed — never accept pushes with no key configured
  const provided = req.get && req.get('x-push-key');
  if (!provided) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function enqueueCommand(client, action, params = {}) {
  const {
    rows: [row],
  } = await client.query(
    `INSERT INTO miner_commands (action, params) VALUES ($1, $2) RETURNING id, action, params, status, created_at`,
    [action, JSON.stringify(params)]
  );
  return row;
}

async function listPendingCommands(client, limit = 10) {
  const { rows } = await client.query(
    `SELECT id, action, params, status, created_at FROM miner_commands
     WHERE status = 'pending' ORDER BY id LIMIT $1`,
    [limit]
  );
  return rows.map((r) => ({ ...r, params: r.params || {} }));
}

async function completeCommand(client, commandId, ok, result, error) {
  const { rows } = await client.query(
    `UPDATE miner_commands
        SET status = $2, result = $3, processed_at = now()
      WHERE id = $1
      RETURNING id, status`,
    [commandId, ok ? 'done' : 'failed', JSON.stringify(ok ? { ok, ...(result || {}) } : { ok, error })]
  );
  return rows[0] || null;
}

module.exports = {
  pushStatus,
  getCachedStatus,
  authorizePushKey,
  enqueueCommand,
  listPendingCommands,
  completeCommand,
};
