const express = require('express');
const { getDashboard } = require('../controllers/dashboardController');
const { upgradeRig } = require('../controllers/upgradeController');
const { handleRewardWebhook } = require('../services/rewardDistributor');

const router = express.Router();

router.get('/dashboard', getDashboard);
router.post('/rigs/upgrade', upgradeRig);
router.post('/rewards/webhook', handleRewardWebhook);

module.exports = router;
