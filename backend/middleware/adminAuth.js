/**
 * Admin authorization middleware.
 *
 * Nexus operator endpoints (withdrawal queue, payout checks, miner control)
 * are gated to a wallet allow-list in ADMIN_WALLETS (comma-separated,
 * case-insensitive 0x addresses). The frontend sends the connected wallet
 * in the `x-wallet` header; API clients may also pass ?wallet= on query
 * routes where the frontend does.
 *
 * Returns 403 for non-admins. If ADMIN_WALLETS is unset, admin routes are
 * FORBIDDEN by default (fail closed — never open operator actions).
 */
function requireAdmin(req, res, next) {
  const allowList = (process.env.ADMIN_WALLETS || '')
    .split(',')
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);

  if (allowList.length === 0) {
    return res.status(403).json({ error: 'Admin access is not configured' });
  }

  const provided =
    (req.get('x-wallet') || '').trim().toLowerCase() ||
    (req.query.wallet || '').trim().toLowerCase();

  if (!provided || !/^0x[a-f0-9]{40}$/i.test(provided)) {
    return res.status(401).json({ error: 'A valid wallet address is required' });
  }

  if (!allowList.includes(provided)) {
    return res.status(403).json({ error: 'Forbidden: wallet is not an administrator' });
  }

  req.adminWallet = provided;
  next();
}

/** True when the given wallet is on the ADMIN_WALLETS allow-list. */
function isAdminWallet(wallet) {
  const allowList = (process.env.ADMIN_WALLETS || '')
    .split(',')
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
  return Boolean(wallet && allowList.includes(String(wallet).trim().toLowerCase()));
}

module.exports = { requireAdmin, isAdminWallet };
