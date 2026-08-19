const express = require('express');
const { getDashboard } = require('../controllers/dashboardController');
const { upgradeRig, reinvestRig, setMineAtLoss } = require('../controllers/upgradeController');
const { handleRewardWebhook } = require('../services/rewardDistributor');
const { getRewards, claimRewards, withdrawRewards, listWithdrawals, markWithdrawalPaid, rejectWithdrawal } = require('../controllers/rewardsController');
const { getAdminStats } = require('../controllers/adminStatsController');
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
// Real Backing panel: what ACTUALLY mines per coin vs virtual capacity sold.
router.get('/admin/backing', requireAdmin, async (_req, res) => {
  try {
    const { getBacking } = require('../services/backingMonitor');
    res.json({ backing: await getBacking() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
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

module.exports = router;
