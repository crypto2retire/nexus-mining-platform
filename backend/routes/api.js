const express = require('express');
const { getDashboard } = require('../controllers/dashboardController');
const { upgradeRig, reinvestRig, setMineAtLoss } = require('../controllers/upgradeController');
const { handleRewardWebhook } = require('../services/rewardDistributor');
const { getRewards, claimRewards, withdrawRewards, listWithdrawals, markWithdrawalPaid, rejectWithdrawal } = require('../controllers/rewardsController');
const { getAdminStats } = require('../controllers/adminStatsController');
const { getMinerStatus } = require('../services/minerMonitor');
const { authorizeControl, switchCoin } = require('../services/minerControl');
const { authorizePushKey, enqueueCommand, listPendingCommands, completeCommand } = require('../services/minerPush');
const { pool } = require('../config/db');
const { getPoolBalance } = require('../services/poolBalance');
const { getOpportunities } = require('../services/coinMonitor');
const { COINS, walletFor, isSwitchable } = require('../services/coinRegistry');
const { requireAdmin } = require('../middleware/adminAuth');

const router = express.Router();

router.get('/dashboard', getDashboard);
router.post('/rigs/upgrade', upgradeRig);
router.post('/rigs/reinvest', reinvestRig);
// GoMiner opt-in: OK mining at a loss (shortfall charged to USDC balance).
router.post('/rigs/mine-at-loss', setMineAtLoss);
router.post('/rewards/webhook', handleRewardWebhook);
// Payout ledger + claim/withdraw (time-weighted contributions per payout).
router.get('/rewards', getRewards);
router.post('/rewards/claim', claimRewards);
router.post('/rewards/withdraw', withdrawRewards);
// Operator withdrawal queue: list, mark paid (with tx hash), reject.
// ADMIN ONLY — these move/release real mined coins.
router.get('/rewards/withdrawals', requireAdmin, listWithdrawals);
router.post('/rewards/withdrawals/:id/paid', requireAdmin, markWithdrawalPaid);
router.post('/rewards/withdrawals/:id/reject', requireAdmin, rejectWithdrawal);
// Operator dashboard: platform-wide capacity, rewards, treasury, users.
router.get('/admin/stats', requireAdmin, getAdminStats);
// Automatic payout trigger: watch status + manual check (baselines + events).
// Status is admin-only (internal state); manual check triggers real API calls.
router.get('/rewards/payout-status', requireAdmin, async (_req, res) => {
  try {
    const { getPayoutStatus } = require('../services/payoutTrigger');
    res.json(await getPayoutStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
router.post('/rewards/check-payouts', requireAdmin, async (_req, res) => {
  try {
    const { checkPayouts } = require('../services/payoutTrigger');
    res.json({ results: await checkPayouts() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
router.get('/miner/status', async (_req, res) => {
  try {
    res.json(await getMinerStatus());
  } catch (err) {
    res.status(500).json({ online: false, error: err.message });
  }
});

// Live pool balance (unpaid Monero + USD value). Optional ?address= override.
router.get('/miner/balance', async (req, res) => {
  try {
    res.json(await getPoolBalance(req.query.address));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Mining opportunities — live market monitor, ranked by est. $/day for the M4.
router.get('/mining/opportunities', async (_req, res) => {
  try {
    res.json(await getOpportunities());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Switch the miner to a different coin.
// ADMIN ONLY — switches the platform's real mining hardware.
// The command is queued (miner_commands) and executed by the Mac miner
// agent on its next poll (~15s) — no reverse tunnel required.
router.post('/miner/switch', requireAdmin, async (req, res) => {
  const symbol = (req.body?.symbol || '').toUpperCase();
  if (!COINS[symbol]) return res.status(400).json({ ok: false, error: `Unknown coin: ${symbol}` });
  if (!isSwitchable(symbol)) {
    return res.status(400).json({
      ok: false,
      error: `${symbol} is not switchable: requires a verified pool and a configured wallet (${COINS[symbol].walletEnv}).`,
    });
  }
  try {
    const row = await enqueueCommand(pool, 'switch', { symbol });
    return res.json({ ok: true, queued: true, command_id: row.id });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Direct switch endpoint — only valid on the machine that runs the miner.
router.post('/miner/control/switch', async (req, res) => {
  if (!authorizeControl(req)) return res.status(403).json({ ok: false, error: 'Forbidden' });
  const symbol = (req.body?.symbol || '').toUpperCase();
  if (!COINS[symbol]) return res.status(400).json({ ok: false, error: `Unknown coin: ${symbol}` });
  if (!isSwitchable(symbol)) {
    return res.status(400).json({
      ok: false,
      error: `${symbol} is not switchable: requires a verified pool and a configured wallet (${COINS[symbol].walletEnv}).`,
    });
  }
  try {
    const coin = { ...COINS[symbol], wallet: walletFor(symbol) };
    res.json(await switchCoin(coin));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Miner control: enqueue start/stop commands for the Mac miner agent.
// ADMIN ONLY — anyone could otherwise stop the platform's miner.
// The agent picks these up on its next poll (~15s) and executes them
// locally via the Mac's /api/miner/control/* endpoints.
router.post('/miner/start', requireAdmin, async (_req, res) => {
  try {
    const row = await enqueueCommand(pool, 'start');
    res.json({ ok: true, queued: true, command_id: row.id });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/miner/stop', requireAdmin, async (_req, res) => {
  try {
    const row = await enqueueCommand(pool, 'stop');
    res.json({ ok: true, queued: true, command_id: row.id });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Outbound miner agent endpoints (guard: MINER_PUSH_KEY, `x-push-key`) ---
// These are called BY THE MAC's miner agent over outbound HTTPS — no tunnel.

// The agent pushes the XMRig status every ~15s.
router.post('/miner/push', async (req, res) => {
  if (!authorizePushKey(req)) return res.status(403).json({ ok: false, error: 'Forbidden' });
  const { pushStatus } = require('../services/minerPush');
  pushStatus(req.body || {});
  res.json({ ok: true, received_at: Date.now() });
});

// The agent polls for pending commands (start/stop/switch).
router.get('/miner/commands', async (_req, res) => {
  if (!authorizePushKey(_req)) return res.status(403).json({ ok: false, error: 'Forbidden' });
  try {
    const commands = await listPendingCommands(pool);
    res.json({ commands });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// The agent reports a command's result.
router.post('/miner/command-result', async (req, res) => {
  if (!authorizePushKey(req)) return res.status(403).json({ ok: false, error: 'Forbidden' });
  const { command_id, ok, result, error } = req.body || {};
  if (!command_id) return res.status(400).json({ ok: false, error: 'command_id required' });
  try {
    const row = await completeCommand(pool, command_id, Boolean(ok), result, error);
    res.json({ ok: true, command: row });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Direct control endpoints — only valid on the machine that runs the miner
// (guarded by MINER_CONTROL_KEY or localhost-only).
router.post('/miner/control/start', async (req, res) => {
  if (!authorizeControl(req)) return res.status(403).json({ ok: false, error: 'Forbidden' });
  try {
    const running = await require('../services/minerControl').isRunning();
    if (running) return res.json({ ok: true, alreadyRunning: true });
    const result = await require('../services/minerControl').startLocal();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/miner/control/stop', async (req, res) => {
  if (!authorizeControl(req)) return res.status(403).json({ ok: false, error: 'Forbidden' });
  try {
    const result = await require('../services/minerControl').stopLocal();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
