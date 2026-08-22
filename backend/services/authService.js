const crypto = require('crypto');
const { ethers } = require('ethers');
const jwt = require('jsonwebtoken');
const { pool } = require('../config/db');

const WALLET_RE = /^0x[a-f0-9]{40}$/i;

function normalizeWallet(wallet) {
  const normalized = String(wallet || '').trim().toLowerCase();
  if (!WALLET_RE.test(normalized)) {
    throw new Error('A valid wallet address is required');
  }
  return normalized;
}

function jwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      console.error('JWT_SECRET is required in production');
    }
    throw new Error('JWT_SECRET environment variable is required');
  }
  return secret;
}

async function createChallenge(wallet) {
  const normalized = normalizeWallet(wallet);
  // Nonce is prefixed so it is NOT a bare hex string: hex-looking messages
  // make some wallets (Rabby, "Unknown Signature Type") sign a different
  // message format than ethers.verifyMessage expects -> "Invalid wallet
  // signature" (hit live 2026-08-22). "nexus-auth:" makes it plain text on
  // every EIP-1193 wallet; the exact string is what gets signed AND verified.
  const nonce = 'nexus-auth:' + crypto.randomBytes(24).toString('hex');
  const result = await pool.query(
    `INSERT INTO auth_nonces (wallet_address, nonce, expires_at)
     VALUES ($1, $2, CURRENT_TIMESTAMP + INTERVAL '5 minutes')
     RETURNING expires_at`,
    [normalized, nonce]
  );
  return { nonce, expires_at: result.rows[0].expires_at };
}

async function verifySignature(wallet, signature) {
  const normalized = normalizeWallet(wallet);
  if (typeof signature !== 'string' || !signature.trim()) {
    throw new Error('Wallet signature is required');
  }
  const secret = jwtSecret();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const challenge = await client.query(
      `SELECT nonce
         FROM auth_nonces
        WHERE LOWER(wallet_address) = $1
          AND used_at IS NULL
          AND expires_at > CURRENT_TIMESTAMP
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE`,
      [normalized]
    );
    if (challenge.rowCount === 0) {
      throw new Error('No active challenge or challenge expired');
    }

    const nonce = challenge.rows[0].nonce;
    let recovered;
    try {
      recovered = ethers.verifyMessage(nonce, signature).toLowerCase();
    } catch (_err) {
      throw new Error('Invalid wallet signature');
    }
    if (recovered !== normalized) {
      throw new Error('Invalid wallet signature');
    }

    const token = jwt.sign({ wallet: recovered }, secret, { expiresIn: '24h' });
    await client.query(
      'UPDATE auth_nonces SET used_at = CURRENT_TIMESTAMP WHERE nonce = $1',
      [nonce]
    );
    await client.query('DELETE FROM auth_nonces WHERE nonce = $1', [nonce]);
    await client.query('COMMIT');
    return { token, wallet: recovered };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function getWalletFromToken(token) {
  const payload = jwt.verify(token, jwtSecret());
  return normalizeWallet(payload.wallet);
}

module.exports = {
  createChallenge,
  verifySignature,
  getWalletFromToken,
  normalizeWallet,
};
