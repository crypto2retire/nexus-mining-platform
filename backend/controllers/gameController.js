const {
  GameError,
  applyReferral,
  claimDaily,
  createReferral,
  getGameState,
} = require('../services/gameService');

async function sendGameResult(res, operation) {
  try {
    return res.json(await operation());
  } catch (err) {
    const expected = err instanceof GameError;
    return res.status(expected ? err.statusCode : 500).json({
      error: expected ? err.message : 'Game request failed',
    });
  }
}

async function getState(req, res) {
  return sendGameResult(res, () => getGameState(req.auth.wallet));
}

async function claimStreak(req, res) {
  return sendGameResult(res, () => claimDaily(req.auth.wallet));
}

async function createReferralLink(req, res) {
  return sendGameResult(res, () => createReferral(req.auth.wallet));
}

async function applyReferralCode(req, res) {
  return sendGameResult(res, () => applyReferral(req.auth.wallet, req.body?.code));
}

module.exports = {
  applyReferralCode,
  claimStreak,
  createReferralLink,
  getState,
};
