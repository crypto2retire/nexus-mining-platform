const connectService = require('../services/connectService');

function connectEnabled(res) {
  if (process.env.ENABLE_CONNECT === '1') return true;
  res.status(503).json({ error: 'Connect is not enabled' });
  return false;
}

async function sendResult(res, operation, { status = 200, wrap } = {}) {
  try {
    const value = await operation();
    return res.status(status).json(wrap ? { [wrap]: value } : value);
  } catch (err) {
    const expected = err instanceof connectService.ConnectError;
    return res.status(expected ? err.statusCode : 500).json({
      error: expected ? err.message : 'Connect request failed',
    });
  }
}

async function getConnectMarket(req, res) {
  if (!connectEnabled(res)) return res;
  return sendResult(res, () => connectService.marketFor(req.query?.algo));
}

async function getConnectQuote(req, res) {
  if (!connectEnabled(res)) return res;
  return sendResult(res, () => connectService.quote({
    targetPool: req.body?.target_pool,
    rigId: req.body?.rig_id,
    lengthHours: req.body?.length_hours,
  }));
}

async function createConnectOrder(req, res) {
  if (!connectEnabled(res)) return res;
  return sendResult(res, () => connectService.createConnectOrder({
    wallet: req.auth.wallet,
    targetPool: req.body?.target_pool,
    payoutAddress: req.body?.payout_address,
    rigId: req.body?.rig_id,
    lengthHours: req.body?.length_hours,
    requestId: req.body?.request_id,
  }), { status: 201, wrap: 'order' });
}

async function listConnectOrders(req, res) {
  if (!connectEnabled(res)) return res;
  return sendResult(
    res,
    () => connectService.listConnectOrders(req.auth.wallet),
    { wrap: 'orders' }
  );
}

module.exports = {
  createConnectOrder,
  getConnectMarket,
  getConnectQuote,
  listConnectOrders,
};
