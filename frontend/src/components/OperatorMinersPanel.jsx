import { useCallback, useEffect, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '';

const TREND_ARROWS = { up: '▲', down: '▼', flat: '•' };

function trendArrow(chg) {
  if (chg == null || !Number.isFinite(Number(chg))) return TREND_ARROWS.flat;
  return Number(chg) > 0.05 ? TREND_ARROWS.up : Number(chg) < -0.05 ? TREND_ARROWS.down : TREND_ARROWS.flat;
}

function usd(value, digits = 2) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const n = Number(value);
  return `${n < 0 ? '-$' : '$'}${Math.abs(n).toFixed(digits)}`;
}

function signedUsd(value, digits = 2) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const n = Number(value);
  return `${n > 0 ? '+' : n < 0 ? '-' : ''}$${Math.abs(n).toFixed(digits)}`;
}

function coinAmount(value, digits = 6) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const n = Number(value);
  return n === 0 ? '0' : n < 0.01 ? n.toPrecision(3) : n.toFixed(digits);
}

function fmtHours(hours) {
  if (hours == null || !Number.isFinite(hours) || hours <= 0) return 'ended';
  if (hours >= 48) return `${(hours / 24).toFixed(1)} days`;
  if (hours >= 2) return `${hours.toFixed(1)} hrs`;
  return `${Math.max(0, Math.round(hours * 60))} min`;
}

function pnlClass(value) {
  if (value == null || !Number.isFinite(Number(value))) return '';
  return Number(value) > 0 ? 'pnl-pos' : Number(value) < 0 ? 'pnl-neg' : '';
}

const POOL_LABELS = { ZCASH: 'Zcash (ZEC)', KASPA: 'Kaspa (KAS)', LTC_DOGE: 'LTC / DOGE', BTC: 'Bitcoin (BTC)', XMR: 'Monero (XMR)' };

/**
 * My Miners — per-rig dashboard for the rigs the operator holds.
 * 🔒 SELF-CUSTODY ONLY (Kevin 2026-08-22): every number is the user's OWN —
 * their rigs, their hashrate, their wallet's rewards, their time remaining.
 * Nothing is pooled; per-rig P/L is ESTIMATED from the rig's production math
 * because pools report per-wallet, not per-rig.
 */
export default function OperatorMinersPanel({ auth }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  const load = useCallback(async () => {
    if (!auth?.token) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/api/operator/miners`, {
        headers: { Authorization: `Bearer ${auth.token}` },
      });
      let body;
      try {
        body = await res.json();
      } catch {
        throw new Error('Miner dashboard unavailable');
      }
      if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`);
      setData(body);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [auth]);

  useEffect(() => {
    load();
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
  }, [load, refreshTick]);

  const pools = data?.pools || {};
  const poolKeys = Object.keys(pools);

  return (
    <section className="admin-panel">
      <div className="admin-title-row">
        <h2 className="admin-title">⛏ My Miners</h2>
        <button
          className="btn-secondary btn-small"
          onClick={() => {
            setRefreshTick((t) => t + 1);
            load();
          }}
          disabled={loading}
        >
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
      </div>
      {error && <div className="admin-msg">{error}</div>}

      {!data && !error && <p className="admin-empty">Loading your miners…</p>}
      {data && poolKeys.length === 0 && (
        <p className="admin-empty">No rigs rented yet — rent from the Mining Market and your miners show up here.</p>
      )}

      {data && (
        <>
          <p className="admin-miner">
            <strong>Your rigs:</strong>{' '}
            {poolKeys.reduce((s, k) => s + (pools[k].active_rentals || 0), 0)} active rental
            {poolKeys.reduce((s, k) => s + (pools[k].active_rentals || 0), 0) === 1 ? '' : 's'} across{' '}
            {poolKeys.length} coin{poolKeys.length === 1 ? '' : 's'} · Est. overall P/L{' '}
            <span className={pnlClass(poolKeys.reduce((s, k) => s + (pools[k].est_pnl_overall_usd || 0), 0))}>
              {signedUsd(poolKeys.reduce((s, k) => s + (pools[k].est_pnl_overall_usd || 0), 0))}
            </span>
            <span className="admin-freshness">
              {' '}
              · data as of {data.generated_at ? new Date(data.generated_at).toLocaleTimeString() : '—'}
            </span>
          </p>
          <p className="admin-miner admin-note">
            Self-custody: every number is your own. Rewards accrue to your own wallet at the pool; per-rig P/L is
            estimated from the rig&apos;s production math at current difficulty — pools report per-wallet, not per-rig.
          </p>

          {poolKeys.map((key) => {
            const p = pools[key];
            const trend = p.price_trend || [];
            const trendText = trend.map((t) => `${t.coin} ${usd(t.price, 4)} ${trendArrow(t.chg_24h)}${t.chg_24h != null ? `${Math.abs(Number(t.chg_24h)).toFixed(1)}%` : ''}·24h ${trendArrow(t.chg_7d)}${t.chg_7d != null ? `${Math.abs(Number(t.chg_7d)).toFixed(1)}%` : ''}·7d`).join(' · ');
            return (
              <details className="admin-card miner-card" key={key} open={poolKeys.length === 1}>
                <summary className="miner-card-summary">
                  <div>
                    <h3>{POOL_LABELS[key] || key}</h3>
                    <span className="admin-freshness">
                      {p.active_rentals} active · {p.total_rentals} total rentals
                    </span>
                  </div>
                  <div className="miner-card-totals">
                    <span title="Combined hashrate of your active rigs">
                      <strong>{Number(p.total_hashrate).toFixed(4)}</strong> {p.unit}
                    </span>
                    <span title={`What the pool currently owes YOUR wallet (${p.your_rewards_unit}) — self-custody rewards`}>
                      your rewards{' '}
                      <strong>{p.your_rewards_coin != null ? `${coinAmount(p.your_rewards_coin)} ${p.your_rewards_unit}` : '—'}</strong>
                    </span>
                    <span title="Estimated current P/L on active rigs (est. earned so far − cost so far)">
                      now <strong className={pnlClass(p.est_pnl_current_usd)}>{signedUsd(p.est_pnl_current_usd)}</strong>
                    </span>
                    <span title="Estimated overall P/L on the coin (all your rentals)">
                      coin <strong className={pnlClass(p.est_pnl_overall_usd)}>{signedUsd(p.est_pnl_overall_usd)}</strong>
                    </span>
                  </div>
                </summary>

                {trendText && <p className="admin-miner admin-note">Price: {trendText}</p>}

                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Miner</th>
                      <th>Your hashrate</th>
                      <th>Est. payout (window)</th>
                      <th>Time left</th>
                      <th>Cost</th>
                      <th>Est. earned so far</th>
                      <th>Est. current P/L</th>
                      <th>Est. overall P/L (miner)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.miners.map((m) => (
                      <tr key={m.mrr_rental_id || m.started_at}>
                        <td title={`MRR rental #${m.mrr_rental_id}${m.requested_rig_id ? ` · rig ${m.requested_rig_id}` : ''}`}>
                          {m.rig_name || 'Miner'} <span className="admin-freshness">#{m.mrr_rental_id}</span>
                          {m.status !== 'ACTIVE' && <span className="status-pill idle">ended</span>}
                        </td>
                        <td>{Number(m.hashrate).toFixed(4)} {p.unit}</td>
                        <td title={m.est_payout_coin_2 ? `incl. ${coinAmount(m.est_payout_coin_2)} DOGE` : undefined}>
                          {m.est_payout_coin_1 != null
                            ? `${coinAmount(m.est_payout_coin_1)} ${p.coin}${m.est_payout_coin_2 ? ` + ${coinAmount(m.est_payout_coin_2)} DOGE` : ''}`
                            : '—'}
                          {m.est_payout_usd != null && <span className="admin-freshness"> · {usd(m.est_payout_usd)}</span>}
                        </td>
                        <td>{m.status === 'ACTIVE' ? fmtHours(m.hours_left) : 'ended'}</td>
                        <td title={`${m.cost_btc != null ? `${m.cost_btc} BTC at rental time` : ''}`}>{usd(m.cost_usd)}</td>
                        <td title="Estimated value mined so far this window at current prices — actual rewards land in your wallet">
                          {usd(m.est_earned_usd)}
                        </td>
                        <td className={pnlClass(m.est_pnl_current_usd)}>{signedUsd(m.est_pnl_current_usd)}</td>
                        <td className={pnlClass(m.est_pnl_overall_miner_usd)}>{signedUsd(m.est_pnl_overall_miner_usd)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="miner-total-row">
                      <td colSpan="4">Coin overall (est.)</td>
                      <td>{usd(p.total_cost_usd)}</td>
                      <td>—</td>
                      <td className={pnlClass(p.est_pnl_current_usd)}>{signedUsd(p.est_pnl_current_usd)}</td>
                      <td className={pnlClass(p.est_pnl_overall_usd)}>{signedUsd(p.est_pnl_overall_usd)}</td>
                    </tr>
                  </tfoot>
                </table>
              </details>
            );
          })}
        </>
      )}
    </section>
  );
}
