import { useEffect, useState } from 'react';

const COIN_NAMES = {
  ZCASH: 'ZEC',
  KASPA: 'KAS',
  LTC_DOGE: 'LTC',
  BTC: 'BTC',
};

// Per-coin hashrate unit matching the REAL rigs: ZEC is KH/s-scale, KAS/LTC
// are GH/s-scale, and BTC is TH/s-scale. The game no longer sells "25 GH/s of
// everything" — credits are denominated in the room's real unit.
const POOL_UNITS = { ZCASH: 'KH/s', KASPA: 'GH/s', LTC_DOGE: 'GH/s', BTC: 'TH/s' };

const RENTAL_HOURS = 72;

export default function MiningRoomCard({
  title, pool, rig, pendingReward, rentCost, renewCost,
  onRent, onRenew, onClaim, onWithdraw, onReinvest,
  discountPct, pendingDoge, payoutStatus, backing,
}) {
  const [animating, setAnimating] = useState(false);
  const [, setNow] = useState(Date.now());
  const hashrate = Number(rig?.virtual_hashrate) || 0;
  const rentalActive = rig?.rental_active === true;
  const hoursLeft = rig?.rental_hours_left != null ? Number(rig.rental_hours_left) : 0;

  // Pool payout status: what the pool owes the wallet, the pool's minimum
  // payout, progress, and the observed-rate ETA ("how long until payout").
  function fmtEta(hours) {
    if (hours == null || !Number.isFinite(hours)) return null;
    if (hours >= 48) return `≈ ${(hours / 24).toFixed(1)} days`;
    if (hours >= 2) return `≈ ${hours.toFixed(1)} hrs`;
    return `≈ ${Math.max(0, Math.round(hours * 60))} min`;
  }
  const ps = payoutStatus || null;
  const poolUnpaid = ps?.unpaid != null ? Number(ps.unpaid) : null;
  const threshold = ps?.threshold != null ? Number(ps.threshold) : null;
  const etaText = ps?.eta_hours != null ? fmtEta(ps.eta_hours) : null;

  // Live countdown while the rental window is active.
  useEffect(() => {
    if (!rentalActive) return undefined;
    const t = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(t);
  }, [rentalActive]);

  const fmt = (h) => {
    const hh = Math.floor(h);
    const mm = Math.floor((h - hh) * 60);
    return `${hh}h ${mm}m`;
  };

  const pulse = (fn) => {
    setAnimating(true);
    fn();
    setTimeout(() => setAnimating(false), 600);
  };

  const discountLabel = discountPct > 0 ? ` (${discountPct}% off)` : '';
  const price = (cost) =>
    cost != null ? `$${discountPct > 0 && cost != null ? (cost * (1 - discountPct / 100)).toFixed(2) : cost}` : null;

  return (
    <div className="mining-card">
      <div className="card-header">
        <h2>{title}</h2>
        <span className={`status-pill ${rentalActive || hashrate > 0 ? 'active' : 'idle'}`}>
          {rentalActive ? 'RENTED' : hashrate > 0 ? 'Mining' : 'Not rented'}
        </span>
      </div>
      <div className="card-stats">
        {ps && (
          <div
            className="stat"
            title={
              ps.watch_mode === 'balance-delta'
                ? "Total settled balance received by this pool's platform wallet. This is the whole-pool amount, not a per-user figure."
                : "Total balance owed to this pool's platform wallet, its payout minimum, and the estimated payout time. This is the whole-pool amount, not a per-user figure."
            }
          >
            <span className="stat-label">
              {ps.watch_mode === 'balance-delta' ? 'Whole pool · paid to wallet' : 'Whole pool · payout progress'}
            </span>
            <span className="stat-value accent">
              {poolUnpaid != null
                ? `${poolUnpaid === 0 ? '0.0000' : poolUnpaid < 0.01 ? poolUnpaid.toPrecision(3) : poolUnpaid.toFixed(4)} ${ps.unpaid_unit || ''}`
                : '—'}
              {threshold != null && ` · pays at ${threshold} ${ps.unpaid_unit || ''}`}
              {etaText && ` · ${etaText}`}
            </span>
          </div>
        )}
        <div className="stat" title="The hashrate assigned to your active miner rental.">
          <span className="stat-label">Your miner hashrate</span>
          <span className="stat-value">{Number(hashrate).toFixed(4)} {POOL_UNITS[pool] || 'GH/s'}</span>
        </div>
        <div
          className="stat"
          title="Total hashrate ACTUALLY mining this room right now — includes player-backed rentals AND operator-funded orders (e.g. from the Mining Market). Your credited hashrate is the line above."
        >
          <span className="stat-label">Real pool hashrate</span>
          <span className="stat-value">
            {backing?.real_hash != null
              ? `${Number(backing.real_hash).toFixed(4)} ${backing.real_unit || POOL_UNITS[pool] || 'GH/s'}`
              : '—'}
          </span>
        </div>
        {rentalActive ? (
          <div className="stat">
            <span className="stat-label">Window left</span>
            <span className="stat-value accent">{fmt(hoursLeft)}</span>
          </div>
        ) : (
          <div className="stat">
            <span className="stat-label">Window</span>
            <span className="stat-value">{RENTAL_HOURS}h per rent</span>
          </div>
        )}
        <div className="stat">
          <span className="stat-label">Your pending payout</span>
          <span className="stat-value accent">{Number(pendingReward).toFixed(8)}</span>
        </div>
        {Number(pendingDoge) > 0 && (
          <div className="stat">
            <span className="stat-label">Your pending DOGE</span>
            <span className="stat-value accent">{Number(pendingDoge).toFixed(8)}</span>
          </div>
        )}
      </div>
      {!rentalActive && hashrate > 0 && (
        <div className="dormant-banner">
          ⏳ Your rental window ended — the rig stopped mining. Renew to start a new {RENTAL_HOURS}h window.
        </div>
      )}
      <div className="card-actions">
        {rentalActive || renewCost != null ? (
          <button
            className={`btn-primary ${animating ? 'pulse' : ''}`}
            onClick={() => pulse(() => onRenew(pool))}
            disabled={!renewCost}
            title={renewCost ? `Rent ${COIN_NAMES[pool] || pool} hashrate for another ${RENTAL_HOURS}h${discountPct > 0 ? ` — ${discountPct}% multi-coin discount applied` : ''}` : 'Rental not renewable'}
          >
            {renewCost != null ? `${rentalActive ? 'Renew' : 'Rent again'} ${RENTAL_HOURS}h — ${price(renewCost)}${discountLabel}` : 'Unavailable'}
          </button>
        ) : (
          <button
            className={`btn-primary ${animating ? 'pulse' : ''}`}
            onClick={() => pulse(() => onRent(pool))}
            disabled={!rentCost}
            title={rentCost ? `Rent ${COIN_NAMES[pool] || pool} hashrate for ${RENTAL_HOURS}h${discountPct > 0 ? ` — ${discountPct}% multi-coin discount applied` : ''}` : 'Rental unavailable'}
          >
            {rentCost != null ? `Rent ${RENTAL_HOURS}h — ${price(rentCost)}${discountLabel}` : 'Unavailable'}
          </button>
        )}
        <button
          className="btn-secondary"
          disabled={pendingReward <= 0 || (!rentalActive && !rentCost && !renewCost)}
          onClick={() => pulse(() => onReinvest(pool))}
          title="Put your mined tokens into the next rental window — no USDC deposit needed"
        >
          Reinvest Yield → Rent
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
