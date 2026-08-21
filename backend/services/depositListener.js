const { ethers } = require('ethers');
const { pool } = require('../config/db');

const USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

// Polling cadence + startup lookback. Base has ~2s blocks; 200 blocks ≈ 6-7 min
// of history, so deposits made while the service was down are caught on boot.
const POLL_INTERVAL_MS = Number(process.env.DEPOSIT_POLL_INTERVAL_MS || 30000);
const LOOKBACK_BLOCKS_ON_START = Number(process.env.DEPOSIT_LOOKBACK_BLOCKS || 200);
const CONFIRMATION_BLOCKS = 12;

let listenerStarted = false;
let pollingTimer = null;

/**
 * The zero address is a burn address — real USDC sent there is unrecoverable.
 * The platform treasury must be a real wallet the operator controls. Until it
 * is, deposits are NOT exposed in the UI and NOT credited by the listener.
 */
function isSafeTreasury() {
  const t = (process.env.PLATFORM_TREASURY_WALLET || '').toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(t) && t !== '0x0000000000000000000000000000000000000000';
}

async function ensureUser(client, walletAddress) {
  const clean = walletAddress.toLowerCase();
  const existing = await client.query(
    'SELECT user_id FROM users WHERE LOWER(wallet_address) = $1',
    [clean]
  );
  if (existing.rowCount > 0) return existing.rows[0].user_id;

  const created = await client.query(
    'INSERT INTO users (wallet_address) VALUES ($1) RETURNING user_id',
    [clean]
  );
  const userId = created.rows[0].user_id;
  await client.query(
    'INSERT INTO user_wallets (user_id, usdc_balance) VALUES ($1, 0.0000)',
    [userId]
  );
  return userId;
}

async function processDepositInTx(client, from, to, value, txHash) {
  const treasury = (process.env.PLATFORM_TREASURY_WALLET || '').toLowerCase();
  // SAFETY: the zero/missing treasury is a burn address — never credit
  // deposits (and never display it) until a real wallet is configured.
  if (!/^0x[a-f0-9]{40}$/.test(treasury) || treasury === '0x0000000000000000000000000000000000000000') {
    console.error('❌ PLATFORM_TREASURY_WALLET is missing or the zero address — deposits DISABLED. Set a real wallet before accepting USDC.');
    return 'ignored';
  }
  if (to.toLowerCase() !== treasury) return 'ignored';

    // A missing row cannot be locked with SELECT FOR UPDATE. The advisory
    // lock serializes the listener and an operator reconciliation for this tx.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [txHash]);
    const duplicate = await client.query(
      'SELECT 1 FROM deposit_history WHERE tx_hash = $1',
      [txHash]
    );
    if (duplicate.rowCount > 0) {
      return 'duplicate';
    }

    const userId = await ensureUser(client, from);
    const amountUsdc = Number(ethers.formatUnits(value, 6));

    await client.query(
      'UPDATE user_wallets SET usdc_balance = usdc_balance + $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2',
      [amountUsdc, userId]
    );
    await client.query(
      'INSERT INTO deposit_history (user_id, tx_hash, amount_usdc) VALUES ($1, $2, $3)',
      [userId, txHash, amountUsdc]
    );

    console.log(`Deposit credited: ${amountUsdc} USDC from ${from} tx ${txHash}`);
    return 'credited';
}

async function processDeposit(from, to, value, txHash) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await processDepositInTx(client, from, to, value, txHash);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Deposit processing error:', err);
    throw err;
  } finally {
    client.release();
  }
}

function logFilter(treasury, fromBlock, toBlock) {
  return {
    address: USDC_CONTRACT,
    topics: [
      ethers.id('Transfer(address,address,uint256)'),
      null,
      ethers.zeroPadValue(treasury, 32),
    ],
    fromBlock,
    toBlock,
  };
}

async function processLogsInTx(client, usdc, logs) {
  const counts = { credited: 0, duplicate: 0 };
  for (const log of logs) {
    const parsed = usdc.interface.parseLog({ topics: log.topics, data: log.data });
    if (!parsed) continue;
    const result = await processDepositInTx(
      client,
      parsed.args.from,
      parsed.args.to,
      parsed.args.value,
      log.transactionHash
    );
    if (result === 'credited') counts.credited += 1;
    if (result === 'duplicate') counts.duplicate += 1;
  }
  return counts;
}

async function pollConfirmedDeposits({ provider, usdc, lookbackBlocks = LOOKBACK_BLOCKS_ON_START }) {
  if (!isSafeTreasury()) throw new Error('PLATFORM_TREASURY_WALLET is missing or the zero address');
  const latest = await provider.getBlockNumber();
  const confirmedTo = latest - CONFIRMATION_BLOCKS;
  if (confirmedTo < 0) return null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cursor = await client.query(
      "SELECT last_block FROM chain_cursor WHERE chain = 'base' FOR UPDATE"
    );
    const lastBlock = cursor.rowCount > 0
      ? Number(cursor.rows[0].last_block)
      : Math.max(0, latest - lookbackBlocks);
    if (confirmedTo <= lastBlock) {
      await client.query('COMMIT');
      return { from_block: lastBlock + 1, to_block: confirmedTo, credited: 0, duplicate: 0 };
    }

    const treasury = process.env.PLATFORM_TREASURY_WALLET.toLowerCase();
    const logs = await provider.getLogs(logFilter(treasury, lastBlock + 1, confirmedTo));
    const counts = await processLogsInTx(client, usdc, logs);
    await client.query(
      `INSERT INTO chain_cursor (chain, last_block, updated_at)
       VALUES ('base', $1, CURRENT_TIMESTAMP)
       ON CONFLICT (chain) DO UPDATE
         SET last_block = EXCLUDED.last_block, updated_at = CURRENT_TIMESTAMP`,
      [confirmedTo]
    );
    await client.query('COMMIT');
    return { from_block: lastBlock + 1, to_block: confirmedTo, ...counts };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function makeBaseClient() {
  const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL);
  return { provider, usdc: new ethers.Contract(USDC_CONTRACT, USDC_ABI, provider) };
}

async function reconcileDeposits({ provider, usdc, lookbackBlocks } = {}) {
  if (!isSafeTreasury()) throw new Error('PLATFORM_TREASURY_WALLET is missing or the zero address');
  if (!provider || !usdc) ({ provider, usdc } = makeBaseClient());
  const configured = lookbackBlocks ?? Number(process.env.RECONCILE_DEPOSIT_LOOKBACK_BLOCKS || 5000);
  if (!Number.isInteger(configured) || configured < 1) throw new Error('Reconciliation lookback must be a positive integer');
  const latest = await provider.getBlockNumber();
  const scannedTo = latest - CONFIRMATION_BLOCKS;
  const scannedFrom = Math.max(0, scannedTo - configured + 1);
  if (scannedTo < 0) return { newly_credited: 0, already_present: 0, scanned_from: 0, scanned_to: scannedTo };
  const treasury = process.env.PLATFORM_TREASURY_WALLET.toLowerCase();
  const logs = await provider.getLogs(logFilter(treasury, scannedFrom, scannedTo));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const counts = await processLogsInTx(client, usdc, logs);
    await client.query('COMMIT');
    return {
      newly_credited: counts.credited,
      already_present: counts.duplicate,
      scanned_from: scannedFrom,
      scanned_to: scannedTo,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Polls Base for USDC Transfer events to the treasury using eth_getLogs.
 *
 * WHY NOT eth_newFilter/on(): public JSON-RPC endpoints (mainnet.base.org etc.)
 * are load-balanced and drop filter state — eth_getFilterChanges returns
 * "filter not found" within seconds (hit 2026-08-19). eth_getLogs with an
 * explicit block range has no server-side state and works on any RPC.
 */
function startDepositListener() {
  if (listenerStarted) return;
  listenerStarted = true;

  const rpcUrl = process.env.BASE_RPC_URL;
  if (!rpcUrl) {
    console.warn('BASE_RPC_URL not set; deposit listener inactive');
    return;
  }
  if (!isSafeTreasury()) {
    console.error('❌ PLATFORM_TREASURY_WALLET missing or zero address — deposit listener inactive (burn-address protection)');
    return;
  }
  const treasury = (process.env.PLATFORM_TREASURY_WALLET || '').toLowerCase();

  const { provider, usdc } = makeBaseClient();

  const poll = async () => {
    try {
      await pollConfirmedDeposits({ provider, usdc });
    } catch (err) {
      // RPC hiccup — do NOT advance the cursor; retry next tick.
      console.error('Deposit poll error (retrying next tick):', err.message);
    }
  };

  // Fire immediately, then on an interval.
  poll();
  pollingTimer = setInterval(poll, POLL_INTERVAL_MS);
  console.log(`Deposit listener started (eth_getLogs poll every ${POLL_INTERVAL_MS / 1000}s, lookback ${LOOKBACK_BLOCKS_ON_START} blocks)`);
}

module.exports = {
  startDepositListener,
  processDeposit,
  processDepositInTx,
  pollConfirmedDeposits,
  reconcileDeposits,
  CONFIRMATION_BLOCKS,
};
