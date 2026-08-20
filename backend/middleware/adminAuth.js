const crypto = require('crypto');

const ADMIN_ERROR = 'Administrator authentication failed';

function keyHash(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest();
}

function requireAdminKey(req, res, next) {
  const expected = process.env.ADMIN_API_KEY;
  const provided = req.get('x-admin-key');

  if (!expected) {
    if (process.env.NODE_ENV === 'production') {
      console.error('ADMIN_API_KEY is required in production');
    }
    return res.status(403).json({ error: ADMIN_ERROR });
  }
  if (!provided) {
    return res.status(401).json({ error: ADMIN_ERROR });
  }

  const matches = crypto.timingSafeEqual(keyHash(provided), keyHash(expected));
  if (!matches) {
    return res.status(403).json({ error: ADMIN_ERROR });
  }
  return next();
}

module.exports = { requireAdminKey, ADMIN_ERROR };
