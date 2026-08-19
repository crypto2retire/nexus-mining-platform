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
}) {
  const [animating, setAnimating] = useState(false);
  const level = Number(rig?.level) || 1;
  const hashrate = Number(rig?.virtual_hashrate) || 0;
  const dormant = rig?.maintenance_status === 'DORMANT';

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
        <div className="stat">
          <span className="stat-label">Level</span>
          <span className="stat-value">{level}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Hashrate</span>
          <span className="stat-value">{Number(hashrate).toFixed(4)} GH/s</span>
        </div>
        <div className="stat">
          <span className="stat-label">Pending Yield</span>
          <span className="stat-value accent">{Number(pendingReward).toFixed(8)}</span>
        </div>
        {dailyMaintenance !== null && (
          <div className="stat">
            <span className="stat-label">Maintenance</span>
            <span className="stat-value">{dailyMaintenance.toFixed(4)} USDC/day</span>
          </div>
        )}
      </div>
      {dormant && (
        <div className="dormant-banner">
          ⏸ Miner paused — payouts couldn't cover maintenance. Grow it (Upgrade / Reinvest) or
          deposit USDC to resume.
        </div>
      )}
      <div className="card-actions">
        <button
          className={`btn-primary ${animating ? 'pulse' : ''}`}
          onClick={() => pulse(() => onUpgrade(pool))}
          disabled={level >= 5}
          title={upgradeCost ? `Upgrade to level ${level + 1} — $${upgradeCost}` : 'Max level reached'}
        >
          {level >= 5 ? 'Max Level' : `Upgrade Rig — $${upgradeCost ?? '—'}`}
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
