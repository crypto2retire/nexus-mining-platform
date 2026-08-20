const { getWalletFromToken } = require('../services/authService');

const AUTH_ERROR = 'Authentication required. Connect and sign your wallet.';

function requireAuth(req, res, next) {
  const authorization = String(req.get('authorization') || '').trim();
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return res.status(401).json({ error: AUTH_ERROR });
  }

  try {
    req.auth = { wallet: getWalletFromToken(match[1]) };
    return next();
  } catch (_err) {
    return res.status(401).json({ error: AUTH_ERROR });
  }
}

module.exports = { requireAuth, AUTH_ERROR };
