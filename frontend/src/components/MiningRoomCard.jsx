import { useEffect, useState } from 'react';

const COIN_NAMES = {
  ZCASH: 'ZEC',
  KASPA: 'KAS',
  LTC_DOGE: 'LTC',
  XMR: 'XMR',
};

export default function MiningRoomCard({
  title, pool, rig, pendingReward, upgradeCost,
  maintenanceRate, onUpgrade, onClaim, onWithdraw, onReinvest,
  mineAtLoss, onToggleLoss, discountPct, pendingDoge, realBacking,
}) {
  const [animating, setAnimating] = useState(false);
  const level = Number(rig?.level) || 1;
  const hashrate = Number(rig?.virtual_hashrate) || 0;
  const dormant = rig?.maintenance_status === 'DORMANT';
  const backing = realBacking && realBacking.real_hash != null ? realBacking : null;

  const pulse = (fn) => {
    setAnimating(true);
    fn();
    setTimeout(() => setAnimating(false), 600);
  };

  // GoMiner maintenance: USDC per GH/s per day × this miner's hashrate.
  const dailyMaintenance = maintenanceRate > 0 ? maintenanceRate * hashrate : null;

  return (
    <div className="mining-card">
      <div className="card-header">
        <h2>{title}</h2>
        <span className={`status-pill ${dormant ? 'dormant' : hashrate > 0 ? 'active' : 'idle'}`}>
          {dormant ? 'Dormant' : hashrate > 0 ? 'Mining' : 'Idle'}
        </span>
      </div>
      <div className="card-stats">
        {backing && (
          <div className="stat" title="Real rented hashrate actually mining for this room's platform wallet right now. All players' virtual rigs share its payouts pro-rata.">
            <span className="stat-label">Room's real rig (live)</span>
            <span className="stat-value accent">
              {backing.active_rentals && backing.active_rentals.length > 0
                ? `${Number(backing.real_hash).toFixed(1)} ${backing.real_unit}`
                : 'no rig running'}
            </span>
          </div>
        )}
        <div className="stat" title="Your ownership basis in the game — your share of the room's real payouts is (your virtual / total virtual) × real pool earnings.">
          <span className="stat-label">Your virtual share</span>
          <span className="stat-value">{Number(hashrate).toFixed(4)} GH/s</span>
        </div>
        <div className="stat">
          <span className="stat-label">Level</span>
          <span className="stat-value">{level}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Pending Yield</span>
          <span className="stat-value accent">{Number(pendingReward).toFixed(8)}</span>
        </div>
        {Number(pendingDoge) > 0 && (
          <div className="stat">
            <span className="stat-label">Pending DOGE</span>
            <span className="stat-value accent">{Number(pendingDoge).toFixed(8)}</span>
          </div>
        )}
        {dailyMaintenance !== null && (
          <div className="stat">
            <span className="stat-label">Maintenance</span>
            <span className="stat-value">{dailyMaintenance.toFixed(4)} USDC/day</span>
          </div>
        )}
      </div>
      {dormant && (
        <div className="dormant-banner">
          ⏸ Miner paused — payouts couldn't cover maintenance. Grow it (Upgrade / Reinvest),
          deposit USDC, or OK mining at a loss to continue.
        </div>
      )}
      <div className="loss-toggle">
        <label
          className="loss-toggle-label"
          title="When payouts can't cover maintenance, the shortfall is charged to your USDC balance instead of pausing. If your balance can't cover it, the miner still pauses — you can never go negative."
        >
          <input
            type="checkbox"
            checked={mineAtLoss === true}
            onChange={(e) => onToggleLoss(pool, e.target.checked)}
          />
          ⚠ OK to mine at a loss
        </label>
      </div>
      <div className="card-actions">
        <button
          className={`btn-primary ${animating ? 'pulse' : ''}`}
          onClick={() => pulse(() => onUpgrade(pool))}
          disabled={level >= 5}
          title={
            upgradeCost
              ? `Buy a miner for ${COIN_NAMES[pool] || pool} (level ${level + 1})${discountPct > 0 ? ` — ${discountPct}% multi-coin discount applied` : ''}`
              : 'Max level reached'
          }
        >
          {level >= 5
            ? 'Max Level'
            : `${rig ? 'Upgrade Rig' : 'Buy Miner'} — $${discountPct > 0 && upgradeCost != null ? (upgradeCost * (1 - discountPct / 100)).toFixed(2) : (upgradeCost ?? '—')}${discountPct > 0 ? ` (${discountPct}% off)` : ''}`}
        </button>
        <button
          className="btn-secondary"
          disabled={pendingReward <= 0 || level >= 5 || !upgradeCost}
          onClick={() => pulse(() => onReinvest(pool))}
          title="Put your mined tokens into the next upgrade — no USDC deposit needed"
        >
          Reinvest Yield → Upgrade
        </button>
        <button className="btn-secondary" disabled={pendingReward <= 0} onClick={() => pulse(() => onClaim(pool))}>
          Claim Yield
        </button>
        <button
          className="btn-secondary"
          disabled={pendingReward <= 0}
          onClick={() => pulse(() => onWithdraw(pool))}
          title="Withdraw the mined token to your own wallet"
        >
          Withdraw {COIN_NAMES[pool] || pool}
        </button>
      </div>
    </div>
  );
}
