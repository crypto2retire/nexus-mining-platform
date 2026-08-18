const { pool } = require('../config/db');
const { getLiveBtcPrice } = require('../services/priceOracle');
const { placeHashpowerOrder, POOL_ALGORITHM_MAP } = require('../services/hashrateRenter');

const UPGRADE_TIERS = [
  { level: 1, cost: 0, hashrate: 10 },
  { level: 2, cost: 50, hashrate: 25 },
  { level: 3, cost: 120, hashrate: 60 },
  { level: 4, cost: 300, hashrate: 150 },
  { level: 5, cost: 750, hashrate: 400 },
];

const PROTOCOL_FEE_PCT = 0.05;

function toSatPrecision(value) {
  return parseFloat(value.toFixed(8));
}

async function upgradeRig(req, res) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const walletAddress = (req.body.wallet || '').toLowerCase();
    const targetPool = req.body.target_pool;

    if (!walletAddress || !/^0x[a-f0-9]{40}$/i.test(walletAddress)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Valid wallet address is required' });
    }
    if (!['ZCASH', 'KASPA', 'LTC_DOGE'].includes(targetPool)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid target pool' });
    }

    const userResult = await client.query(
      'SELECT user_id FROM users WHERE LOWER(wallet_address) = $1 FOR UPDATE',
      [walletAddress]
    );
    if (userResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found' });
    }
    const userId = userResult.rows[0].user_id;

    const walletResult = await client.query(
      'SELECT wallet_id, usdc_balance FROM user_wallets WHERE user_id = $1 FOR UPDATE',
      [userId]
    );
    const wallet = walletResult.rows[0];

    const rigResult = await client.query(
      'SELECT rig_id, level, virtual_hashrate FROM virtual_rigs WHERE user_id = $1 AND target_pool = $2 FOR UPDATE',
      [userId, targetPool]
    );

    let rig = rigResult.rows[0];
    const currentLevel = rig ? rig.level : 1;
    const nextTier = UPGRADE_TIERS.find((t) => t.level === currentLevel + 1);

    if (!nextTier) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Already at max level' });
    }

    if (Number(wallet.usdc_balance) < nextTier.cost) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient USDC balance' });
    }

    // Fetch live BTC/USDC spot price and convert net fee proceeds to BTC.
    const btcSpotPrice = await getLiveBtcPrice();
    const protocolFeeUsdc = toSatPrecision(nextTier.cost * PROTOCOL_FEE_PCT);
    const netPurchaseUsdc = toSatPrecision(nextTier.cost - protocolFeeUsdc);
    const spendBtcAmount = toSatPrecision(netPurchaseUsdc / btcSpotPrice);

    // Attempt to place the NiceHash hashpower order (sandboxed outside production).
    const orderResult = await placeHashpowerOrder(targetPool, spendBtcAmount);
    if (!orderResult.success) {
      await client.query('ROLLBACK');
      return res.status(502).json({ error: `Hashrate marketplace order failed: ${orderResult.error}` });
    }

    // Deduct balance, record fee, upgrade rig.
    const newBalance = toSatPrecision(Number(wallet.usdc_balance) - nextTier.cost);
    await client.query(
      'UPDATE user_wallets SET usdc_balance = $1, updated_at = CURRENT_TIMESTAMP WHERE wallet_id = $2',
      [newBalance, wallet.wallet_id]
    );

    await client.query(
      'INSERT INTO protocol_revenue_ledger (source_user_id, amount_usdc, transaction_type) VALUES ($1, $2, $3)',
      [userId, nextTier.cost, 'RIG_UPGRADE']
    );

    if (rig) {
      await client.query(
        'UPDATE virtual_rigs SET level = $1, virtual_hashrate = $2, updated_at = CURRENT_TIMESTAMP WHERE rig_id = $3',
        [nextTier.level, nextTier.hashrate, rig.rig_id]
      );
    } else {
      await client.query(
        'INSERT INTO virtual_rigs (user_id, target_pool, virtual_hashrate, level) VALUES ($1, $2, $3, $4)',
        [userId, targetPool, nextTier.hashrate, nextTier.level]
      );
    }

    // Audit trail: store the NiceHash order linkage.
    await client.query(
      `INSERT INTO hashrate_orders
       (user_id, target_pool, nicehash_order_id, sandbox, usdc_cost, protocol_fee_usdc, btc_spent, btc_spot_price, algorithm, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        userId,
        targetPool,
        orderResult.orderId || null,
        Boolean(orderResult.sandbox),
        nextTier.cost,
        protocolFeeUsdc,
        spendBtcAmount,
        toSatPrecision(btcSpotPrice),
        POOL_ALGORITHM_MAP[targetPool],
        orderResult.sandbox ? 'SIMULATED' : 'PLACED',
      ]
    );

    await client.query('COMMIT');
    return res.json({
      success: true,
      level: nextTier.level,
      hashrate: nextTier.hashrate,
      remaining_balance: newBalance,
      btc_spent: spendBtcAmount,
      btc_spot_price: toSatPrecision(btcSpotPrice),
      protocol_fee_usdc: protocolFeeUsdc,
      nicehash_order_id: orderResult.orderId || null,
      sandbox: Boolean(orderResult.sandbox),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Upgrade error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  } finally {
    client.release();
  }
}

module.exports = { upgradeRig, UPGRADE_TIERS };
