const { createHash } = require('crypto');
const { pool } = require('../config/db');

const VALID_WALLET_RE = /^0x[a-f0-9]{40}$/i;

class GameError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'GameError';
    this.statusCode = statusCode;
  }
}

function normalizeWallet(wallet) {
  const normalized = String(wallet || '').trim().toLowerCase();
  if (!VALID_WALLET_RE.test(normalized)) {
    throw new GameError(400, 'Valid wallet address is required');
  }
  return normalized;
}

function deterministicReference(wallet, claimDay) {
  const dateKey = new Date(claimDay).toISOString().slice(0, 10);
  const hex = createHash('sha256').update(`${wallet}:${dateKey}`).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function referralCode(wallet) {
  return createHash('sha256').update(wallet).digest('hex').slice(0, 8);
}

async function payReferralBonus(client, refereeWallet) {
  const referralResult = await client.query(
    `SELECT referral_id, referrer_wallet
       FROM referrals
      WHERE LOWER(referee_wallet) = $1
        AND status = 'PENDING'
      FOR UPDATE`,
    [refereeWallet]
  );
  if (referralResult.rowCount === 0) return false;

  const referral = referralResult.rows[0];
  const referrerResult = await client.query(
    `SELECT u.user_id, w.wallet_id
       FROM users u
       JOIN user_wallets w ON w.user_id = u.user_id
      WHERE LOWER(u.wallet_address) = $1
      FOR UPDATE OF u, w`,
    [String(referral.referrer_wallet).toLowerCase()]
  );
  if (referrerResult.rowCount === 0) {
    throw new GameError(409, 'Referrer wallet is unavailable');
  }

  const paidResult = await client.query(
    `UPDATE referrals
        SET status = 'PAID'
      WHERE referral_id = $1
        AND status = 'PENDING'
      RETURNING referral_id`,
    [referral.referral_id]
  );
  if (paidResult.rowCount === 0) return false;

  const referrer = referrerResult.rows[0];
  await client.query(
    'UPDATE user_wallets SET usdc_balance = usdc_balance + $1, updated_at = CURRENT_TIMESTAMP WHERE wallet_id = $2',
    [0.5, referrer.wallet_id]
  );
  await client.query(
    `INSERT INTO game_rewards_ledger (user_id, amount_usdc, reason, reference_id)
     VALUES ($1, $2, $3, $4)`,
    [referrer.user_id, 0.5, 'REFERRAL_BONUS', referral.referral_id]
  );
  return true;
}

async function claimDaily(wallet) {
  const normalizedWallet = normalizeWallet(wallet);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const userResult = await client.query(
      `SELECT user_id,
              date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS claim_day,
              (date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + INTERVAL '1 day') AT TIME ZONE 'UTC' AS next_claim_at
         FROM users
        WHERE LOWER(wallet_address) = $1
        FOR UPDATE`,
      [normalizedWallet]
    );
    if (userResult.rowCount === 0) {
      throw new GameError(404, 'User not found');
    }

    const { user_id: userId, claim_day: claimDay, next_claim_at: nextClaimAt } = userResult.rows[0];
    const streakResult = await client.query(
      `SELECT current_streak, best_streak, last_claim_at, total_claims,
              CASE
                WHEN last_claim_at >= date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                  THEN 'TODAY'
                WHEN last_claim_at >= (date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '1 day') AT TIME ZONE 'UTC'
                  THEN 'YESTERDAY'
                ELSE 'OLDER'
              END AS claim_period
         FROM game_streaks
        WHERE user_id = $1
        FOR UPDATE`,
      [userId]
    );
    const prior = streakResult.rows[0] || null;
    if (prior?.claim_period === 'TODAY') {
      throw new GameError(409, 'Daily reward already claimed for this UTC day');
    }

    const currentStreak = prior?.claim_period === 'YESTERDAY'
      ? Number(prior.current_streak) + 1
      : 1;
    const bestStreak = Math.max(Number(prior?.best_streak || 0), currentStreak);
    const totalClaims = Number(prior?.total_claims || 0) + 1;
    const rewardUsdc = Number((0.01 * Math.min(currentStreak, 30)).toFixed(2));
    const referenceId = deterministicReference(normalizedWallet, claimDay);

    await client.query(
      `INSERT INTO game_streaks
         (user_id, current_streak, best_streak, last_claim_at, total_claims, updated_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id) DO UPDATE SET
         current_streak = EXCLUDED.current_streak,
         best_streak = EXCLUDED.best_streak,
         last_claim_at = EXCLUDED.last_claim_at,
         total_claims = EXCLUDED.total_claims,
         updated_at = CURRENT_TIMESTAMP`,
      [userId, currentStreak, bestStreak, totalClaims]
    );

    const walletResult = await client.query(
      'SELECT wallet_id, usdc_balance FROM user_wallets WHERE user_id = $1 FOR UPDATE',
      [userId]
    );
    if (walletResult.rowCount === 0) {
      throw new GameError(404, 'User wallet not found');
    }

    await client.query(
      'UPDATE user_wallets SET usdc_balance = usdc_balance + $1, updated_at = CURRENT_TIMESTAMP WHERE wallet_id = $2',
      [rewardUsdc, walletResult.rows[0].wallet_id]
    );
    await client.query(
      `INSERT INTO game_rewards_ledger (user_id, amount_usdc, reason, reference_id)
       VALUES ($1, $2, $3, $4)`,
      [userId, rewardUsdc, 'STREAK', referenceId]
    );

    const referralBonusPaid = currentStreak === 3
      ? await payReferralBonus(client, normalizedWallet)
      : false;

    await client.query('COMMIT');
    return {
      success: true,
      current_streak: currentStreak,
      best_streak: bestStreak,
      total_claims: totalClaims,
      reward_usdc: rewardUsdc,
      next_claim_at: nextClaimAt,
      referral_bonus_paid: referralBonusPaid,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function createReferral(wallet) {
  const normalizedWallet = normalizeWallet(wallet);
  const userResult = await pool.query(
    'SELECT user_id FROM users WHERE LOWER(wallet_address) = $1',
    [normalizedWallet]
  );
  if (userResult.rowCount === 0) {
    throw new GameError(404, 'User not found');
  }

  const code = referralCode(normalizedWallet);
  return {
    referral_code: code,
    referral_link: `?ref=${code}`,
  };
}

async function getGameState(wallet) {
  const normalizedWallet = normalizeWallet(wallet);
  const result = await pool.query(
    `SELECT COALESCE(s.current_streak, 0) AS current_streak,
            COALESCE(s.best_streak, 0) AS best_streak,
            COALESCE(s.total_claims, 0) AS total_claims,
            CASE
              WHEN s.last_claim_at >= date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                THEN FALSE
              ELSE TRUE
            END AS can_claim,
            CASE
              WHEN s.last_claim_at >= date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                THEN (date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + INTERVAL '1 day') AT TIME ZONE 'UTC'
              ELSE CURRENT_TIMESTAMP
            END AS next_claim_at,
            COALESCE((
              SELECT SUM(gl.amount_usdc)
                FROM game_rewards_ledger gl
               WHERE gl.user_id = u.user_id
            ), 0) AS total_rewards_usdc,
            COALESCE((
              SELECT COUNT(*)
                FROM referrals r
               WHERE LOWER(r.referrer_wallet) = $1
            ), 0) AS referral_count,
            COALESCE((
              SELECT SUM(gl.amount_usdc)
                FROM game_rewards_ledger gl
               WHERE gl.user_id = u.user_id
                 AND gl.reason = 'REFERRAL_BONUS'
            ), 0) AS referral_bonus_usdc
       FROM users u
       LEFT JOIN game_streaks s ON s.user_id = u.user_id
      WHERE LOWER(u.wallet_address) = $1`,
    [normalizedWallet]
  );
  if (result.rowCount === 0) {
    throw new GameError(404, 'User not found');
  }

  const row = result.rows[0];
  const code = referralCode(normalizedWallet);
  return {
    current_streak: Number(row.current_streak),
    best_streak: Number(row.best_streak),
    total_claims: Number(row.total_claims),
    can_claim: row.can_claim === true,
    next_claim_at: row.next_claim_at,
    total_rewards_usdc: Number(row.total_rewards_usdc),
    referral_code: code,
    referral_link: `?ref=${code}`,
    referral_count: Number(row.referral_count),
    referral_bonus_usdc: Number(row.referral_bonus_usdc),
  };
}

async function applyReferral(refereeWallet, code) {
  const normalizedReferee = normalizeWallet(refereeWallet);
  const normalizedCode = String(code || '').trim().toLowerCase();
  if (!/^[a-f0-9]{8}$/.test(normalizedCode)) {
    throw new GameError(400, 'Referral code must be eight hexadecimal characters');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const refereeResult = await client.query(
      `SELECT user_id, wallet_address
         FROM users
        WHERE LOWER(wallet_address) = $1
        FOR UPDATE`,
      [normalizedReferee]
    );
    if (refereeResult.rowCount === 0) {
      throw new GameError(404, 'User not found');
    }

    const referrerResult = await client.query(
      `SELECT user_id, wallet_address
         FROM users
        WHERE LEFT(encode(digest(LOWER(wallet_address), 'sha256'), 'hex'), 8) = $1
        ORDER BY user_id
        LIMIT 2
        FOR UPDATE`,
      [normalizedCode]
    );
    if (referrerResult.rowCount === 0) {
      throw new GameError(404, 'Referral code not found');
    }
    if (referrerResult.rowCount > 1) {
      throw new GameError(409, 'Referral code is ambiguous');
    }

    const normalizedReferrer = String(referrerResult.rows[0].wallet_address).toLowerCase();
    if (normalizedReferrer === normalizedReferee) {
      throw new GameError(400, 'You cannot use your own referral code');
    }

    const insertResult = await client.query(
      `INSERT INTO referrals (referrer_wallet, referee_wallet, status)
       VALUES ($1, $2, 'PENDING')
       RETURNING referral_id, status`,
      [normalizedReferrer, normalizedReferee]
    );

    await client.query('COMMIT');
    return { success: true, status: insertResult.rows[0].status };
  } catch (err) {
    await client.query('ROLLBACK');
    if (err?.code === '23505') {
      throw new GameError(409, 'A referral has already been applied to this wallet');
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  GameError,
  applyReferral,
  claimDaily,
  createReferral,
  getGameState,
};
