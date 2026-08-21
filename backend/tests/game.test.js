jest.mock('../config/db', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

const express = require('express');
const { pool } = require('../config/db');
const {
  claimDaily,
  createReferral,
  applyReferral,
  getGameState,
} = require('../services/gameService');

const PLAYER = '0x1111111111111111111111111111111111111111';
const USER_ID = '11111111-1111-1111-1111-111111111111';
const WALLET_ID = '22222222-2222-2222-2222-222222222222';
const REFERRER = '0x3333333333333333333333333333333333333333';
const REFERRER_USER_ID = '33333333-3333-3333-3333-333333333333';
const REFERRER_WALLET_ID = '44444444-4444-4444-4444-444444444444';
const REFERRAL_ID = '55555555-5555-5555-5555-555555555555';

function utcStart(value) {
  const date = new Date(value);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function makeGameDb({
  now = '2026-08-21T12:00:00.000Z',
  streak = null,
  balance = 0,
  referral = null,
  referrerBalance = 0,
} = {}) {
  const state = {
    now: new Date(now),
    streak: streak ? { ...streak } : null,
    balance,
    referral: referral ? { ...referral } : null,
    referrerBalance,
    ledger: [],
  };

  const client = {
    query: jest.fn(async (sql, params = []) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('JOIN user_wallets') && sql.includes('FOR UPDATE')) {
        return {
          rowCount: 1,
          rows: [{ user_id: REFERRER_USER_ID, wallet_id: REFERRER_WALLET_ID }],
        };
      }
      if (sql.includes('FROM users') && sql.includes('FOR UPDATE')) {
        const claimDay = utcStart(state.now);
        return {
          rowCount: 1,
          rows: [{
            user_id: USER_ID,
            claim_day: claimDay,
            next_claim_at: new Date(claimDay.getTime() + 24 * 60 * 60 * 1000),
          }],
        };
      }
      if (sql.includes('FROM game_streaks') && sql.includes('FOR UPDATE')) {
        if (!state.streak) return { rowCount: 0, rows: [] };
        const lastDay = utcStart(state.streak.last_claim_at);
        const today = utcStart(state.now);
        const dayDifference = (today.getTime() - lastDay.getTime()) / (24 * 60 * 60 * 1000);
        return {
          rowCount: 1,
          rows: [{
            ...state.streak,
            claim_period: dayDifference === 0 ? 'TODAY' : dayDifference === 1 ? 'YESTERDAY' : 'OLDER',
          }],
        };
      }
      if (sql.includes('INSERT INTO game_streaks')) {
        state.streak = {
          current_streak: params[1],
          best_streak: params[2],
          last_claim_at: state.now,
          total_claims: params[3],
        };
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('FROM user_wallets') && sql.includes('FOR UPDATE')) {
        return { rowCount: 1, rows: [{ wallet_id: WALLET_ID, usdc_balance: String(state.balance) }] };
      }
      if (sql.includes('UPDATE user_wallets SET usdc_balance = usdc_balance +')) {
        if (params[1] === REFERRER_WALLET_ID) state.referrerBalance += Number(params[0]);
        else state.balance += Number(params[0]);
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('FROM referrals') && sql.includes("status = 'PENDING'") && sql.includes('FOR UPDATE')) {
        return state.referral?.status === 'PENDING'
          ? { rowCount: 1, rows: [{ ...state.referral }] }
          : { rowCount: 0, rows: [] };
      }
      if (sql.includes('UPDATE referrals') && sql.includes("status = 'PAID'")) {
        if (state.referral?.status !== 'PENDING') return { rowCount: 0, rows: [] };
        state.referral.status = 'PAID';
        return { rowCount: 1, rows: [{ referral_id: state.referral.referral_id }] };
      }
      if (sql.includes('INSERT INTO game_rewards_ledger')) {
        state.ledger.push({
          user_id: params[0],
          amount_usdc: Number(params[1]),
          reason: params[2],
          reference_id: params[3],
        });
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`unexpected client query: ${sql}`);
    }),
    release: jest.fn(),
  };
  pool.connect.mockResolvedValue(client);
  return { state, client };
}

function makeReferralDb() {
  const state = { referrals: [] };
  const client = {
    query: jest.fn(async (sql, params = []) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('LOWER(wallet_address) = $1') && sql.includes('FOR UPDATE')) {
        return { rowCount: 1, rows: [{ user_id: USER_ID, wallet_address: PLAYER }] };
      }
      if (sql.includes('digest(LOWER(wallet_address)')) {
        return params[0] === 'a8a32d43'
          ? { rowCount: 1, rows: [{ user_id: REFERRER_USER_ID, wallet_address: PLAYER }] }
          : { rowCount: 0, rows: [] };
      }
      if (sql.includes('INSERT INTO referrals')) {
        const row = {
          referral_id: REFERRAL_ID,
          referrer_wallet: params[0],
          referee_wallet: params[1],
          status: 'PENDING',
        };
        state.referrals.push(row);
        return { rowCount: 1, rows: [row] };
      }
      throw new Error(`unexpected client query: ${sql}`);
    }),
    release: jest.fn(),
  };
  pool.connect.mockResolvedValue(client);
  return { state, client };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('claimDaily', () => {
  test('first claim starts streak 1 and atomically credits $0.01 with a ledger row', async () => {
    const { state, client } = makeGameDb();

    const result = await claimDaily(PLAYER);

    expect(result).toEqual(expect.objectContaining({
      success: true,
      current_streak: 1,
      best_streak: 1,
      total_claims: 1,
      reward_usdc: 0.01,
    }));
    expect(state.balance).toBeCloseTo(0.01, 8);
    expect(state.ledger).toEqual([expect.objectContaining({
      user_id: USER_ID,
      amount_usdc: 0.01,
      reason: 'STREAK',
      reference_id: expect.stringMatching(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
    })]);
    expect(client.query.mock.calls[0][0]).toBe('BEGIN');
    expect(client.query.mock.calls.at(-1)[0]).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test('a second claim on the same UTC day is rejected with 409 and no credit', async () => {
    const { state, client } = makeGameDb({
      now: '2026-08-21T23:59:00.000Z',
      streak: {
        current_streak: 1,
        best_streak: 1,
        last_claim_at: new Date('2026-08-21T00:01:00.000Z'),
        total_claims: 1,
      },
    });

    await expect(claimDaily(PLAYER)).rejects.toMatchObject({ statusCode: 409 });

    expect(state.balance).toBe(0);
    expect(state.ledger).toHaveLength(0);
    expect(client.query.mock.calls.at(-1)[0]).toBe('ROLLBACK');
  });

  test('a claim on the next UTC day increments the streak and credits $0.02', async () => {
    const { state } = makeGameDb({
      now: '2026-08-22T00:01:00.000Z',
      streak: {
        current_streak: 1,
        best_streak: 1,
        last_claim_at: new Date('2026-08-21T23:59:00.000Z'),
        total_claims: 1,
      },
    });

    const result = await claimDaily(PLAYER);

    expect(result).toEqual(expect.objectContaining({
      current_streak: 2,
      best_streak: 2,
      total_claims: 2,
      reward_usdc: 0.02,
    }));
    expect(state.balance).toBeCloseTo(0.02, 8);
    expect(state.ledger[0]).toEqual(expect.objectContaining({ amount_usdc: 0.02, reason: 'STREAK' }));
  });

  test('a claim after a missed UTC day resets the current streak to 1', async () => {
    const { state } = makeGameDb({
      now: '2026-08-24T12:00:00.000Z',
      streak: {
        current_streak: 7,
        best_streak: 10,
        last_claim_at: new Date('2026-08-21T12:00:00.000Z'),
        total_claims: 20,
      },
    });

    const result = await claimDaily(PLAYER);

    expect(result).toEqual(expect.objectContaining({
      current_streak: 1,
      best_streak: 10,
      total_claims: 21,
      reward_usdc: 0.01,
    }));
    expect(state.streak.current_streak).toBe(1);
  });

  test('the reward remains capped at $0.30 after day 30', async () => {
    const { state } = makeGameDb({
      now: '2026-08-22T12:00:00.000Z',
      streak: {
        current_streak: 30,
        best_streak: 30,
        last_claim_at: new Date('2026-08-21T12:00:00.000Z'),
        total_claims: 30,
      },
    });

    const result = await claimDaily(PLAYER);

    expect(result).toEqual(expect.objectContaining({
      current_streak: 31,
      best_streak: 31,
      total_claims: 31,
      reward_usdc: 0.3,
    }));
    expect(state.balance).toBeCloseTo(0.3, 8);
    expect(state.ledger[0].amount_usdc).toBe(0.3);
  });
});

describe('referrals', () => {
  test('createReferral returns the deterministic first eight SHA-256 characters', async () => {
    pool.query.mockResolvedValue({ rowCount: 1, rows: [{ user_id: USER_ID }] });

    await expect(createReferral(PLAYER)).resolves.toEqual({
      referral_code: 'a8a32d43',
      referral_link: '?ref=a8a32d43',
    });
  });

  test('applyReferral creates one pending referral for the authenticated referee', async () => {
    const { state, client } = makeReferralDb();
    const referee = '0x2222222222222222222222222222222222222222';

    const result = await applyReferral(referee, 'A8A32D43');

    expect(result).toEqual({ success: true, status: 'PENDING' });
    expect(state.referrals).toEqual([expect.objectContaining({
      referral_id: REFERRAL_ID,
      referrer_wallet: PLAYER,
      referee_wallet: referee,
      status: 'PENDING',
    })]);
    expect(client.query.mock.calls[0][0]).toBe('BEGIN');
    expect(client.query.mock.calls.at(-1)[0]).toBe('COMMIT');
  });

  test('applyReferral rejects a wallet using its own referral code', async () => {
    const { state, client } = makeReferralDb();

    await expect(applyReferral(PLAYER, 'a8a32d43')).rejects.toMatchObject({ statusCode: 400 });

    expect(state.referrals).toHaveLength(0);
    expect(client.query.mock.calls.at(-1)[0]).toBe('ROLLBACK');
  });

  test('the referee reaching streak day 3 pays the referrer $0.50 exactly once', async () => {
    const { state } = makeGameDb({
      now: '2026-08-22T12:00:00.000Z',
      streak: {
        current_streak: 2,
        best_streak: 2,
        last_claim_at: new Date('2026-08-21T12:00:00.000Z'),
        total_claims: 2,
      },
      referral: {
        referral_id: REFERRAL_ID,
        referrer_wallet: REFERRER,
        referee_wallet: PLAYER,
        status: 'PENDING',
      },
    });

    const dayThree = await claimDaily(PLAYER);
    state.now = new Date('2026-08-23T12:00:00.000Z');
    const dayFour = await claimDaily(PLAYER);

    expect(dayThree).toEqual(expect.objectContaining({
      current_streak: 3,
      referral_bonus_paid: true,
    }));
    expect(dayFour).toEqual(expect.objectContaining({
      current_streak: 4,
      referral_bonus_paid: false,
    }));
    expect(state.referral.status).toBe('PAID');
    expect(state.referrerBalance).toBeCloseTo(0.5, 8);
    expect(state.ledger.filter((entry) => entry.reason === 'REFERRAL_BONUS')).toEqual([
      expect.objectContaining({
        user_id: REFERRER_USER_ID,
        amount_usdc: 0.5,
        reference_id: REFERRAL_ID,
      }),
    ]);
  });
});

describe('getGameState', () => {
  test('returns streak, reward, and referral totals with the deterministic link', async () => {
    const nextClaimAt = new Date('2026-08-22T00:00:00.000Z');
    pool.query.mockResolvedValue({
      rowCount: 1,
      rows: [{
        current_streak: 3,
        best_streak: 5,
        total_claims: 7,
        can_claim: false,
        next_claim_at: nextClaimAt,
        total_rewards_usdc: '0.5600',
        referral_count: '2',
        referral_bonus_usdc: '0.5000',
      }],
    });

    await expect(getGameState(PLAYER)).resolves.toEqual({
      current_streak: 3,
      best_streak: 5,
      total_claims: 7,
      can_claim: false,
      next_claim_at: nextClaimAt,
      total_rewards_usdc: 0.56,
      referral_code: 'a8a32d43',
      referral_link: '?ref=a8a32d43',
      referral_count: 2,
      referral_bonus_usdc: 0.5,
    });
  });
});

describe('Game API authentication boundary', () => {
  test.each([
    ['GET', '/game/state'],
    ['POST', '/game/streak/claim'],
    ['POST', '/game/referral/create'],
    ['POST', '/game/referral/apply'],
  ])('%s /api%s requires wallet authentication', async (method, path) => {
    const router = require('../routes/api');
    const app = express();
    app.use(express.json());
    app.use('/api', router);
    const server = app.listen(0);

    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(method === 'POST' ? { body: JSON.stringify({ code: 'a8a32d43' }) } : {}),
      });

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        error: 'Authentication required. Connect and sign your wallet.',
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
