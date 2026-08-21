jest.mock('../config/db', () => ({ pool: { connect: jest.fn() } }));

const { pool } = require('../config/db');
const { pollConfirmedDeposits, reconcileDeposits } = require('../services/depositListener');

const TREASURY = '0x2222222222222222222222222222222222222222';
const SENDER = '0x1111111111111111111111111111111111111111';

function database({ failCursor = false } = {}) {
  const state = { cursor: null, deposits: new Set(), balance: 0 };
  let snapshot;
  const client = {
    query: jest.fn(async (sql, params = []) => {
      if (sql === 'BEGIN') {
        snapshot = { cursor: state.cursor, deposits: new Set(state.deposits), balance: state.balance };
        return { rowCount: 0, rows: [] };
      }
      if (sql === 'ROLLBACK') {
        state.cursor = snapshot.cursor;
        state.deposits = snapshot.deposits;
        state.balance = snapshot.balance;
        return { rowCount: 0, rows: [] };
      }
      if (sql === 'COMMIT' || sql.includes('pg_advisory_xact_lock')) return { rowCount: 0, rows: [] };
      if (sql.includes('FROM chain_cursor')) {
        return state.cursor == null ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ last_block: state.cursor }] };
      }
      if (sql.includes('INSERT INTO chain_cursor')) {
        if (failCursor) throw new Error('cursor write failed');
        state.cursor = Number(params[0]);
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('FROM deposit_history')) {
        return state.deposits.has(params[0]) ? { rowCount: 1, rows: [{}] } : { rowCount: 0, rows: [] };
      }
      if (sql.includes('SELECT user_id FROM users')) return { rowCount: 1, rows: [{ user_id: 'user-1' }] };
      if (sql.includes('UPDATE user_wallets')) {
        state.balance += Number(params[0]);
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('INSERT INTO deposit_history')) {
        state.deposits.add(params[1]);
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }),
    release: jest.fn(),
  };
  pool.connect.mockResolvedValue(client);
  return { state, client };
}

function chain(latest, logs = []) {
  const provider = {
    getBlockNumber: jest.fn().mockResolvedValue(latest),
    getLogs: jest.fn(async ({ fromBlock, toBlock }) =>
      logs.filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock)
    ),
  };
  const usdc = {
    interface: {
      parseLog: jest.fn(() => logs[0]?.parsed || null),
    },
  };
  return { provider, usdc };
}

function transfer(blockNumber, txHash = '0xtx1') {
  return {
    blockNumber,
    transactionHash: txHash,
    topics: [],
    data: '0x',
    parsed: { args: { from: SENDER, to: TREASURY, value: 10_000_000n } },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.PLATFORM_TREASURY_WALLET = TREASURY;
});

test('persisted cursor is reused across simulated restarts', async () => {
  const { state } = database();
  const first = chain(100);
  await pollConfirmedDeposits({ ...first, lookbackBlocks: 20 });
  expect(first.provider.getLogs.mock.calls[0][0]).toMatchObject({ fromBlock: 81, toBlock: 88 });
  expect(state.cursor).toBe(88);

  const restarted = chain(110);
  await pollConfirmedDeposits({ ...restarted, lookbackBlocks: 20 });
  expect(restarted.provider.getLogs.mock.calls[0][0]).toMatchObject({ fromBlock: 89, toBlock: 98 });
  expect(state.cursor).toBe(98);
});

test('deposit credit and cursor advance roll back atomically', async () => {
  const { state } = database({ failCursor: true });
  const c = chain(100, [transfer(85)]);
  await expect(pollConfirmedDeposits({ ...c, lookbackBlocks: 20 })).rejects.toThrow('cursor write failed');
  expect(state.balance).toBe(0);
  expect(state.deposits.size).toBe(0);
  expect(state.cursor).toBeNull();
});

test('confirmation gate excludes blocks younger than 12 confirmations', async () => {
  const { state } = database();
  const c = chain(100, [transfer(95)]);
  await pollConfirmedDeposits({ ...c, lookbackBlocks: 20 });
  expect(c.provider.getLogs.mock.calls[0][0].toBlock).toBe(88);
  expect(state.balance).toBe(0);
});

test('reconciliation is idempotent when the same transfer is scanned twice', async () => {
  const { state } = database();
  const c = chain(100, [transfer(85)]);
  const first = await reconcileDeposits({ ...c, lookbackBlocks: 30 });
  const second = await reconcileDeposits({ ...c, lookbackBlocks: 30 });
  expect(first.newly_credited).toBe(1);
  expect(second).toMatchObject({ newly_credited: 0, already_present: 1, scanned_from: 59, scanned_to: 88 });
  expect(state.balance).toBe(10);
  expect(state.deposits.size).toBe(1);
});
