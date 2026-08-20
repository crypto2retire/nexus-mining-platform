import { useEffect, useState } from 'react';

const COIN_NAMES = {
  ZCASH: 'ZEC',
  KASPA: 'KAS',
  LTC_DOGE: 'LTC',
  XMR: 'XMR',
};

const RENTAL_HOURS = 72;

export default function MiningRoomCard({
  title, pool, rig, pendingReward, upgradeCost, renewCost,
  onUpgrade, onRenew, onClaim, onWithdraw, onReinvest,
  discountPct, pendingDoge, realBacking, payoutStatus,
  sessionPrices, spareGhs, onBuySession,
}) {
  const [animating, setAnimating] = useState(false);
  const [now, setNow] = useState(Date.now());
  const level = Number(rig?.level) || 1;
  const hashrate = Number(rig?.virtual_hashrate) || 0;
  const backing = realBacking && realBacking.real_hash != null ? realBacking : null;
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

  // Session picker: spare_ghs arrives ALREADY in GH/s (backend converts the
  // pool's display unit — KH/s/H/s — to GH/s before subtracting credits).
  // The 25 GH/s slot compares directly; no re-normalization here.
  const spareGhsNorm = spareGhs == null ? null : Number(spareGhs);
  const canSell = spareGhsNorm != null && spareGhsNorm >= 25;

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
        <span className={`status-pill ${rentalActive ? 'active' : hashrate > 0 ? 'active' : 'idle'}`}>
          {rentalActive ? 'RENTED' : hashrate > 0 ? 'Mining' : 'Not rented'}
        </span>
      </div>
      <div className="card-stats">
        {backing && (
          <div className="stat" title="Real rented hashrate actually mining for this room's platform wallet right now. All players' active rentals share its payouts pro-rata.">
            <span className="stat-label">Room's real rig (live)</span>
            <span className="stat-value accent">
              {backing.active_rentals && backing.active_rentals.length > 0
                ? `${Number(backing.real_hash).toFixed(1)} ${backing.real_unit}`
                : 'no rig running'}
            </span>
          </div>
        )}
        {ps && (
          <div
            className="stat"
            title={
              ps.watch_mode === 'balance-delta'
                ? "On-chain balance received at this room's wallet. F2Pool hides its internal unpaid balance for ltc1 addresses, so this shows actual payments only — the pool pays the wallet at the threshold."
                : "Balance owed to this room's wallet at the mining pool, the pool's minimum payout, and the estimated time until the pool pays at the observed accrual rate."
            }
          >
            <span className="stat-label">
              {ps.watch_mode === 'balance-delta' ? 'Paid to wallet' : 'Pool payout'}
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
        <div className="stat" title="The hashrate you rented for this window — your share of the room's real payouts is (your virtual / total virtual) × real pool earnings.">
          <span className="stat-label">Your rented hashrate</span>
          <span className="stat-value">{Number(hashrate).toFixed(4)} GH/s</span>
        </div>
        <div className="stat">
          <span className="stat-label">Tier</span>
          <span className="stat-value">{level}</span>
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
          <span className="stat-label">Pending Yield</span>
          <span className="stat-value accent">{Number(pendingReward).toFixed(8)}</span>
        </div>
        {Number(pendingDoge) > 0 && (
          <div className="stat">
            <span className="stat-label">Pending DOGE</span>
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
        {rentalActive || (hashrate > 0 && renewCost) ? (
          <>
            <button
              className={`btn-primary ${animating ? 'pulse' : ''}`}
              onClick={() => pulse(() => onRenew(pool))}
              disabled={!renewCost}
              title={renewCost ? `Rent ${COIN_NAMES[pool] || pool} hashrate for another ${RENTAL_HOURS}h${discountPct > 0 ? ` — ${discountPct}% multi-coin discount applied` : ''}` : 'Rental not renewable'}
            >
              {renewCost != null ? `${rentalActive ? 'Renew' : 'Rent again'} ${RENTAL_HOURS}h — ${price(renewCost)}${discountLabel}` : 'Max Level'}
            </button>
            <button
              className="btn-secondary"
              onClick={() => pulse(() => onUpgrade(pool))}
              disabled={!upgradeCost}
              title={upgradeCost ? `Upgrade to a bigger hashrate for ${RENTAL_HOURS}h${discountPct > 0 ? ` — ${discountPct}% multi-coin discount applied` : ''}` : 'Max tier'}
            >
              {upgradeCost != null ? `Upgrade — ${price(upgradeCost)}${discountLabel}` : 'Max Tier'}
            </button>
          </>
        ) : (
          <button
            className={`btn-primary ${animating ? 'pulse' : ''}`}
            onClick={() => pulse(() => onUpgrade(pool))}
            disabled={!upgradeCost}
            title={upgradeCost ? `Rent ${COIN_NAMES[pool] || pool} hashrate for ${RENTAL_HOURS}h${discountPct > 0 ? ` — ${discountPct}% multi-coin discount applied` : ''}` : 'Max tier'}
          >
            {upgradeCost != null ? `Rent ${RENTAL_HOURS}h — ${price(upgradeCost)}${discountLabel}` : 'Max Tier'}
          </button>
        )}
        <button
          className="btn-secondary"
          disabled={pendingReward <= 0 || (!rentalActive && !upgradeCost && !renewCost)}
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
      {sessionPrices && (
        <div className="session-picker">
          <div className="session-picker-head">
            <span className="session-picker-title">⚡ Short sessions — 25 GH/s slice</span>
            {spareGhs != null && (
              <span className={`session-spare ${canSell ? '' : 'session-spare-low'}`}>
                Spare: {spareGhs >= 100 ? spareGhs.toFixed(0) : spareGhs.toFixed(1)} GH/s
              </span>
            )}
          </div>
          {canSell ? (
            <div className="session-picker-buttons">
              {Object.entries(sessionPrices)
                .map(([hours, sessionPrice]) => ({ hours: Number(hours), price: sessionPrice }))
                .sort((a, b) => a.hours - b.hours)
                .map(({ hours, price: sessionPrice }) => (
                  <button
                    key={hours}
                    className="btn-secondary btn-session"
                    disabled={price == null}
                    onClick={() => pulse(() => onBuySession(hours))}
                    title={
                      `25 GH/s for ${hours}h — a slice of the room's REAL running hashrate. No new rental, so shorter sessions cost more per hour.${discountPct > 0 ? ` ${discountPct}% multi-coin discount applied` : ''}`
                    }
                  >
                    {hours}h — {sessionPrice != null ? `$${sessionPrice.toFixed(2)}` : '—'}
                  </button>
                ))}
            </div>
          ) : (
            <div className="session-picker-note session-picker-note-low">
              No sellable spare capacity — the room needs 25 GH/s of free real hashrate for a session.
            </div>
          )}
          <div className="session-picker-note">
            Drawn from the room's live rigs — the rig is already running, no new rental.
          </div>
        </div>
      )}
    </div>
  );
}
