const { pool } = require('../config/db');
const { getBacking } = require('../services/backingMonitor');
const { getObservedRates, PAYOUT_MIN, WATCHES } = require('../services/payoutTrigger');
const { tiersFor, sessionPrice, SESSION_HOURS } = require('./upgradeController');
const { coinsOwnedFor, discountPctFor } = require('../services/multiCoinDiscount');

/**
 * The zero address is a burn address — real USDC sent there is unrecoverable.
 * The platform treasury must be a real wallet the operator controls. Until it
 * is, deposits are NOT exposed in the UI and NOT credited by the listener.
 */
function isSafeTreasury() {
  const t = (process.env.PLATFORM_TREASURY_WALLET || '').toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(t) && t !== '0x0000000000000000000000000000000000000000';
}

async function getDashboard(req, res) {
  try {
    const walletAddress = (req.query.wallet || '').toLowerCase();
    if (!walletAddress || !/^0x[a-f0-9]{40}$/i.test(walletAddress)) {
      return res.status(400).json({ error: 'Valid wallet address is required' });
    }

    const client = await pool.connect();
    try {
      const userResult = await client.query(
        'SELECT user_id FROM users WHERE LOWER(wallet_address) = $1',
        [walletAddress]
      );
      let userId = null;
      if (userResult.rowCount === 0) {
        const insertUser = await client.query(
          'INSERT INTO users (wallet_address) VALUES ($1) RETURNING user_id',
          [walletAddress]
        );
        userId = insertUser.rows[0].user_id;
        await client.query(
          'INSERT INTO user_wallets (user_id, usdc_balance) VALUES ($1, 0.0000)',
          [userId]
        );
      } else {
        userId = userResult.rows[0].user_id;
      }

      const wallet = await client.query(
        'SELECT usdc_balance FROM user_wallets WHERE user_id = $1',
        [userId]
      );
      const rigs = await client.query(
        'SELECT rig_id, target_pool, virtual_hashrate, level, maintenance_status, rental_expires_at FROM virtual_rigs WHERE user_id = $1',
        [userId]
      );
      const slices = await client.query(
        `SELECT target_pool, SUM(virtual_hashrate) AS active_hashrate,
                MAX(expires_at) AS active_expires_at
           FROM capacity_slices
          WHERE user_id = $1 AND starts_at <= CURRENT_TIMESTAMP
            AND expires_at > CURRENT_TIMESTAMP
          GROUP BY target_pool`,
        [userId]
      );
      const rates = await client.query('SELECT pool, usdc_per_ghs_per_day FROM pool_maintenance_rates');

      const pools = ['ZCASH', 'KASPA', 'LTC_DOGE', 'XMR'];
      const rigsByPool = {};
      const upgradeCostByPool = {};
      const renewCostByPool = {};
      const maintenanceRateByPool = {};
      // HYBRID: per-room session prices (1h/3h/6h/12h/24h at the 25 GH/s slot)
      // and spare capacity, so the room card can render the session picker.
      const sessionPricesByPool = {};
      const coinsOwned = await coinsOwnedFor(client, userId);
      const discountPct = discountPctFor(coinsOwned);
      for (const row of rates.rows) {
        maintenanceRateByPool[row.pool] = Number(row.usdc_per_ghs_per_day);
      }
      const now = Date.now();
      for (const pool of pools) {
        const rig = rigs.rows.find(r => r.target_pool === pool);
        const live = slices.rows.find(s => s.target_pool === pool);
        const level = rig ? Number(rig.level) : 1;
        const activeExpiry = live?.active_expires_at || null;
        const expiresMs = activeExpiry ? new Date(activeExpiry).getTime() : null;
        // pg returns NUMERIC as strings — coerce so the frontend can call .toFixed()
        rigsByPool[pool] = (rig || live)
          ? {
              rig_id: rig?.rig_id || null,
              target_pool: pool,
              virtual_hashrate: Number(live?.active_hashrate || 0),
              level,
              maintenance_status: live ? 'ACTIVE' : (rig?.maintenance_status || 'INACTIVE'),
              rental_expires_at: activeExpiry ? new Date(activeExpiry).toISOString() : null,
              rental_hours_left: expiresMs && expiresMs > now ? (expiresMs - now) / 3600000 : 0,
              rental_active: expiresMs !== null && expiresMs > now,
            }
          : null;
        // RENTAL model: 'upgrade' rents the NEXT tier; 'renew' re-rents the
        // current tier for another window. Both are shown on the room card.
        const nextTier = tiersFor(pool).find((t) => t.level === level + 1);
        upgradeCostByPool[pool] = nextTier ? nextTier.cost : null;
        const currentTier = tiersFor(pool).find((t) => t.level === level);
        renewCostByPool[pool] = currentTier && currentTier.cost > 0 ? currentTier.cost : null;
        // Session ladder for the tier-2 SLOT (each pool's real unit — ZEC/XMR
        // KH/s, KAS/LTC GH/s). Multi-coin discount already applied — the card
        // shows the discounted price. Session slot = tier 2 hashrate so a
        // session is one unit of what the room really delivers.
        sessionPricesByPool[pool] = {};
        const sessionSlot = tiersFor(pool).find((t) => t.level === 2)?.hashrate || 25;
        for (const hours of Object.keys(SESSION_HOURS).map(Number).sort((a, b) => a - b)) {
          sessionPricesByPool[pool][hours] = sessionPrice(pool, sessionSlot, hours, discountPct);
        }
      }

      const rewards = await client.query(
        `SELECT
          COALESCE(SUM(calculated_reward_1) FILTER (WHERE status = 'UNCLAIMED'), 0) AS pending_reward_1,
          COALESCE(SUM(calculated_reward_2) FILTER (WHERE status = 'UNCLAIMED'), 0) AS pending_reward_2,
          target_pool
         FROM user_rewards_ledger
         LEFT JOIN real_pool_payouts USING (payout_id)
         WHERE user_id = $1
         GROUP BY target_pool`,
        [userId]
      );

      const pendingByPool = {};
      const pendingDogeByPool = {};
      for (const row of rewards.rows) {
        pendingByPool[row.target_pool] = Number(row.pending_reward_1);
        if (Number(row.pending_reward_2) > 0) {
          pendingDogeByPool[row.target_pool] = Number(row.pending_reward_2);
        }
      }

      // HYBRID spare capacity: what the room's real rigs produce MINUS all
      // active credits (operator baseline included) = sellable inventory.
      // Credits are denominated in each pool's REAL unit (ZEC/XMR KH/s,
      // KAS/LTC GH/s) — convert both sides to GH/s before subtracting.
      const spareRows = await client.query(
        `SELECT target_pool,
                COALESCE(SUM(virtual_hashrate) FILTER (
                  WHERE starts_at <= CURRENT_TIMESTAMP AND expires_at > CURRENT_TIMESTAMP
                ), 0) AS active_ghs
           FROM capacity_slices
          WHERE target_pool = ANY($1::varchar[])
          GROUP BY target_pool`,
        [pools]
      );
      const activeGhsByPool = {};
      for (const row of spareRows.rows) {
        // KH/s credits are 1000x smaller than GH/s — convert to GH/s.
        const unit = { ZCASH: 'KH/s', XMR: 'KH/s' }[row.target_pool] || 'GH/s';
        activeGhsByPool[row.target_pool] =
          unit === 'KH/s' ? Number(row.active_ghs) / 1e3 : Number(row.active_ghs);
      }
      const backing = await getBacking();
      const spareGhsByPool = {};
      for (const pool of pools) {
        const real = backing[pool]?.real_hash;
        const unit = backing[pool]?.real_unit || 'GH/s';
        const active = activeGhsByPool[pool] || 0;
        // real_hash arrives in the pool's DISPLAY unit (KH/s for ZEC, H/s
        // for XMR, GH/s for KAS/LTC) while active credits are always GH/s.
        // Convert both to GH/s before subtracting — previously XMR spare
        // was 2715 H/s − 25 GH/s = 2690 (nonsense, showed fake spare on an
        // oversold room).
        const realGhs =
          unit === 'KH/s' ? Number(real) / 1e3
          : unit === 'H/s' ? Number(real) / 1e9
          : Number(real);
        spareGhsByPool[pool] = real == null ? null : Math.max(0, realGhs - active);
      }

      // Pool payout status per room: what the pool owes the wallet (unpaid),
      // the pool's minimum payout, progress toward it, and the observed rate
      // ETA. Only unpaid-type pools (KAS/ZEC/XMR) get an ETA — LTC/DOGE are
      // on-chain balance watches (we can't see F2Pool's internal unpaid).
      const observedRates = await getObservedRates();
      const payoutStatus = {};
      for (const pool of pools) {
        const unpaid = backing[pool]?.pool_unpaid;
        const threshold = PAYOUT_MIN[pool] ?? null;
        const mode = WATCHES[pool]?.mode;
        const rate = observedRates[pool]?.rate_per_day ?? null;
        let eta_hours = null;
        if (mode === 'unpaid-drop' && threshold != null && unpaid != null && unpaid > 0 && rate != null && rate > 0) {
          eta_hours = Math.max(0, ((threshold - unpaid) / rate) * 24);
        }
        payoutStatus[pool] = {
          unpaid: unpaid != null ? Number(unpaid) : null,
          unpaid_unit: { ZCASH: 'ZEC', KASPA: 'KAS', LTC_DOGE: 'LTC', XMR: 'XMR' }[pool],
          threshold,
          progress_pct:
            threshold != null && unpaid != null && threshold > 0
              ? Math.min(100, (unpaid / threshold) * 100)
              : null,
          eta_hours,
          observed_rate_per_day: rate,
          watch_mode: mode,
        };
      }

      return res.json({
        user_id: userId,
        wallet_address: walletAddress,
        usdc_balance: Number(wallet.rows[0]?.usdc_balance || 0),
        rigs: rigsByPool,
        upgrade_cost: upgradeCostByPool,
        renew_cost: renewCostByPool,
        maintenance_rate: maintenanceRateByPool,
        session_prices: sessionPricesByPool,
        spare_ghs: spareGhsByPool,
        payout_status: payoutStatus,
        pending_rewards: pendingByPool,
        pending_rewards_2: pendingDogeByPool,
        multi_coin: { coins_owned: coinsOwned, discount_pct: discountPctFor(coinsOwned) },
        // Real backing per coin (cached 60s) — what ACTUALLY mines this room.
        backing,
        // Never expose a missing/zero-address treasury — the zero address is a
        // burn address and players would lose real USDC sending to it.
        deposit_address: isSafeTreasury() ? process.env.PLATFORM_TREASURY_WALLET : null,
      });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Dashboard error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { getDashboard };
