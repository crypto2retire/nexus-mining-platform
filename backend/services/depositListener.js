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

async function processDeposit(from, to, value, txHash) {
  const treasury = (process.env.PLATFORM_TREASURY_WALLET || '').toLowerCase();
  // SAFETY: the zero/missing treasury is a burn address — never credit
  // deposits (and never display it) until a real wallet is configured.
  if (!/^0x[a-f0-9]{40}$/.test(treasury) || treasury === '0x0000000000000000000000000000000000000000') {
    console.error('❌ PLATFORM_TREASURY_WALLET is missing or the zero address — deposits DISABLED. Set a real wallet before accepting USDC.');
    return;
  }
  if (to.toLowerCase() !== treasury) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const duplicate = await client.query(
      'SELECT 1 FROM deposit_history WHERE tx_hash = $1 FOR UPDATE',
      [txHash]
    );
    if (duplicate.rowCount > 0) {
      await client.query('COMMIT');
      return;
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

    await client.query('COMMIT');
    console.log(`Deposit credited: ${amountUsdc} USDC from ${from} tx ${txHash}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Deposit processing error:', err);
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

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const usdc = new ethers.Contract(USDC_CONTRACT, USDC_ABI, provider);
  const transferTopic = ethers.id('Transfer(address,address,uint256)');
  // topics[2] = the `to` address, left-padded to 32 bytes for the indexed param.
  const toTopic = ethers.zeroPadValue(treasury, 32);

  let lastBlock = 0;

  const poll = async () => {
    try {
      const latest = await provider.getBlockNumber();
      if (lastBlock === 0) {
        // Startup lookback: catch deposits made while we were down.
        lastBlock = Math.max(0, latest - LOOKBACK_BLOCKS_ON_START);
      }
      if (latest <= lastBlock) return;

      const fromBlock = lastBlock + 1;
      const logs = await provider.getLogs({
        address: USDC_CONTRACT,
        topics: [transferTopic, null, toTopic],
        fromBlock,
        toBlock: latest,
      });
      lastBlock = latest;

      for (const log of logs) {
        try {
          const parsed = usdc.interface.parseLog({ topics: log.topics, data: log.data });
          if (!parsed) continue;
          await processDeposit(parsed.args.from, parsed.args.to, parsed.args.value, log.transactionHash);
        } catch (err) {
          console.error('Deposit parse/process error:', err.message);
        }
      }
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

module.exports = { startDepositListener };
