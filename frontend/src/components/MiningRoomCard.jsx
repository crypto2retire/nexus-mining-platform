import { useEffect, useState } from 'react';

export default function MiningRoomCard({ title, pool, rig, pendingReward, onUpgrade, onClaim, onWithdraw }) {
  const [animating, setAnimating] = useState(false);
  const level = Number(rig?.level) || 1;
  const hashrate = Number(rig?.virtual_hashrate) || 0;

  const handleUpgrade = () => {
    setAnimating(true);
    onUpgrade(pool);
    setTimeout(() => setAnimating(false), 600);
  };

  const handleClaim = () => {
    setAnimating(true);
    onClaim(pool);
    setTimeout(() => setAnimating(false), 600);
  };

  const handleWithdraw = () => {
    setAnimating(true);
    onWithdraw(pool);
    setTimeout(() => setAnimating(false), 600);
  };

  return (
    <div className="mining-card">
      <div className="card-header">
        <h2>{title}</h2>
        <span className={`status-pill ${hashrate > 0 ? 'active' : 'idle'}`}>
          {hashrate > 0 ? 'Mining' : 'Idle'}
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
      </div>
      <div className="card-actions">
        <button
          className={`btn-primary ${animating ? 'pulse' : ''}`}
          onClick={handleUpgrade}
          disabled={level >= 5}
        >
          Upgrade Rig
        </button>
        <button className="btn-secondary" disabled={pendingReward <= 0} onClick={handleClaim}>
          Claim Yield
        </button>
        <button className="btn-secondary" disabled={pendingReward <= 0} onClick={handleWithdraw} title="Withdraw the mined token to your own wallet">
          Withdraw {pool === 'ZCASH' ? 'ZEC' : pool === 'KASPA' ? 'KAS' : pool === 'LTC_DOGE' ? 'LTC' : 'XMR'}
        </button>
      </div>
    </div>
  );
}
