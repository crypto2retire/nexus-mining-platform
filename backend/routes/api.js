const express = require('express');
const { getDashboard } = require('../controllers/dashboardController');
const { upgradeRig } = require('../controllers/upgradeController');
const { handleRewardWebhook } = require('../services/rewardDistributor');
const { getMinerStatus } = require('../services/minerMonitor');
const { startMiner, stopMiner, authorizeControl } = require('../services/minerControl');

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

// Miner control: proxy to the machine that runs XMRig, or act locally.
router.post('/miner/start', async (_req, res) => {
  try {
    res.json(await startMiner());
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/miner/stop', async (_req, res) => {
  try {
    res.json(await stopMiner());
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Direct control endpoints — only valid on the machine that runs the miner
// (guarded by MINER_CONTROL_KEY or localhost-only).
router.post('/miner/control/start', async (req, res) => {
  if (!authorizeControl(req)) return res.status(403).json({ ok: false, error: 'Forbidden' });
  try {
    const { startLocal } = require('../services/minerControl');
    const running = await require('../services/minerControl').isRunning();
    if (running) return res.json({ ok: true, alreadyRunning: true });
    const result = await startLocal();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/miner/control/stop', async (req, res) => {
  if (!authorizeControl(req)) return res.status(403).json({ ok: false, error: 'Forbidden' });
  try {
    const { stopLocal } = require('../services/minerControl');
    const result = await stopLocal();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
