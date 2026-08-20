const express = require('express');
const { getDashboard } = require('../controllers/dashboardController');
const { upgradeRig, reinvestRig, buySession } = require('../controllers/upgradeController');
const { handleRewardWebhook } = require('../services/rewardDistributor');
const { getRewards, claimRewards, withdrawRewards, listWithdrawals, markWithdrawalPaid, rejectWithdrawal } = require('../controllers/rewardsController');
const { getAdminStats } = require('../controllers/adminStatsController');
const { createChallenge, verifySignature } = require('../services/authService');
const { requireAuth } = require('../middleware/auth');
const { requireAdminKey } = require('../middleware/adminAuth');

const router = express.Router();

router.get('/dashboard', getDashboard);
router.post('/auth/challenge', async (req, res) => {
  try {
    return res.json(await createChallenge(req.body.wallet));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});
router.post('/auth/verify', async (req, res) => {
  try {
    return res.json(await verifySignature(req.body.wallet, req.body.signature));
  } catch (err) {
    const configurationError = /environment variable is required/.test(err.message);
    return res.status(configurationError ? 500 : 401).json({
      error: configurationError ? 'Authentication service is not configured' : err.message,
    });
  }
});
router.get('/auth/me', requireAuth, (req, res) => res.json({ wallet: req.auth.wallet }));
router.post('/rigs/upgrade', requireAuth, upgradeRig);
// HYBRID: short hashrate sessions drawn from the room's spare capacity.
router.post('/rigs/session', requireAuth, buySession);
router.post('/rigs/reinvest', requireAuth, reinvestRig);
router.post('/rewards/webhook', handleRewardWebhook);
// Payout ledger + claim/withdraw (time-weighted contributions per payout).
router.get('/rewards', requireAuth, getRewards);
router.post('/rewards/claim', requireAuth, claimRewards);
router.post('/rewards/withdraw', requireAuth, withdrawRewards);
// Operator withdrawal queue: list, mark paid (with tx hash), reject.
// ADMIN ONLY — these move/release real mined coins.
router.get('/rewards/withdrawals', requireAdminKey, listWithdrawals);
router.post('/rewards/withdrawals/:id/paid', requireAdminKey, markWithdrawalPaid);
router.post('/rewards/withdrawals/:id/reject', requireAdminKey, rejectWithdrawal);
// Operator dashboard: platform-wide capacity, rewards, treasury, users.
router.get('/admin/stats', requireAdminKey, getAdminStats);
// Real Backing panel: what ACTUALLY mines per coin vs virtual capacity sold.
router.get('/admin/backing', requireAdminKey, async (_req, res) => {
  try {
    const { getBacking } = require('../services/backingMonitor');
    res.json({ backing: await getBacking() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Automatic payout trigger: watch status + manual check (baselines + events).
// Status is admin-only (internal state); manual check triggers real API calls.
router.get('/rewards/payout-status', requireAdminKey, async (_req, res) => {
  try {
    const { getPayoutStatus } = require('../services/payoutTrigger');
    res.json(await getPayoutStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
router.post('/rewards/check-payouts', requireAdminKey, async (_req, res) => {
  try {
    const { checkPayouts } = require('../services/payoutTrigger');
    res.json({ results: await checkPayouts() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
