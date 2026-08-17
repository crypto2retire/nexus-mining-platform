const { ethers } = require('ethers');
const { pool } = require('../config/db');

const USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bda02913';
const USDC_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

let listenerStarted = false;

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

function startDepositListener() {
  if (listenerStarted) return;
  listenerStarted = true;

  const rpcUrl = process.env.BASE_RPC_URL;
  if (!rpcUrl) {
    console.warn('BASE_RPC_URL not set; deposit listener inactive');
    return;
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const usdc = new ethers.Contract(USDC_CONTRACT, USDC_ABI, provider);

  const filter = usdc.filters.Transfer(null, process.env.PLATFORM_TREASURY_WALLET);
  usdc.on(filter, async (from, to, value, event) => {
    await processDeposit(from, to, value, event.log.transactionHash);
  });

  console.log('Deposit listener started on Base USDC Transfer events');
}

module.exports = { startDepositListener };
