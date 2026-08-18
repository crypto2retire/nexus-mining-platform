const express = require('express');
const { getDashboard } = require('../controllers/dashboardController');
const { upgradeRig } = require('../controllers/upgradeController');
const { handleRewardWebhook } = require('../services/rewardDistributor');
const { getMinerStatus } = require('../services/minerMonitor');

const router = express.Router();

router.get('/dashboard', getDashboard);
router.post('/rigs/upgrade', upgradeRig);
router.post('/rewards/webhook', handleRewardWebhook);
router.get('/miner/status', async (_req, res) => {
  try {
    res.json(await getMinerStatus());
  } catch (err) {
    res.status(500).json({ online: false, error: err.message });
  }
});

module.exports = router;
