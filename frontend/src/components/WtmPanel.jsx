import { useCallback, useEffect, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '';

function num(value, digits = 4) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const n = Number(value);
  return n === 0 ? '0' : n < 0.01 && n > -0.01 ? n.toPrecision(3) : n.toFixed(digits);
}

function usd(value, digits = 2) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return `$${Number(value).toFixed(digits)}`;
}

function pct(value, digits = 1) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return `${Number(value) > 0 ? '+' : ''}${Number(value).toFixed(digits)}%`;
}

const COIN_LABEL = { ZCASH: 'ZEC', KASPA: 'KAS', LTC_DOGE: 'LTC/DOGE', BTC: 'BTC', XMR: 'XMR' };

/**
 * WhatToMine operator tool (Kevin 2026-08-22) — verify our production
 * anchors against WhatToMine + the pool, scan for profitable/liquid coins,
 * screen the coin list. OPERATOR-ONLY: the free WhatToMine API is not
 * commercially licensed; user-facing use requires the paid tier.
 */
export default function WtmPanel({ auth }) {
  const [tab, setTab] = useState('verify');
  const [verify, setVerify] = useState(null);
  const [scan, setScan] = useState(null);
  const [coins, setCoins] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (which) => {
    if (!auth?.token) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/api/operator/wtm/${which}`, {
        headers: { Authorization: `Bearer ${auth.token}` },
      });
      let body;
      try {
        body = await res.json();
      } catch {
        throw new Error('WhatToMine data unavailable');
      }
      if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`);
      if (which === 'verify') setVerify(body);
      if (which === 'scan') setScan(body);
      if (which === 'coins') setCoins(body);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [auth]);

  useEffect(() => {
    load('verify');
  }, [load]);

  const rateLimit = verify?.rate_limit || scan?.rate_limit || coins?.rate_limit;

  return (
    <section className="admin-panel">
      <div className="admin-title-row">
        <h2 className="admin-title">📊 WhatToMine (operator)</h2>
        <button className="btn-secondary btn-small" disabled={loading} onClick={() => load(tab)}>
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
      </div>
      {rateLimit && (
        <p className="admin-miner admin-note">
          API calls remaining this month: <strong>{rateLimit.remaining}</strong> (trial key)
        </p>
      )}
      {error && <div className="admin-msg">{error}</div>}

      <div className="connect-tabs">
        <button className={tab === 'verify' ? 'active' : ''} onClick={() => { setTab('verify'); if (!verify) load('verify'); }}>Verify anchors</button>
        <button className={tab === 'scan' ? 'active' : ''} onClick={() => { setTab('scan'); if (!scan) load('scan'); }}>Profitable coins</button>
        <button className={tab === 'coins' ? 'active' : ''} onClick={() => { setTab('coins'); if (!coins) load('coins'); }}>Coin screen</button>
      </div>

      {tab === 'verify' && (
        <div className="admin-card">
          <h3>Anchor verification — WTM vs ours vs pool</h3>
          <p className="admin-miner admin-note">
            For each coin you are actively mining: WhatToMine&apos;s estimate for your rented hashrate vs our anchor
            estimate. The ratio flags anchors that drifted (e.g. ZEC was 3× too high until re-anchored 2026-08-22).
            Pool unpaid is the real ground truth (cumulative, unsplit).
          </p>
          {!verify && !error && <p className="admin-empty">Loading…</p>}
          {verify && (
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Coin</th>
                  <th>Rented hashrate</th>
                  <th>WTM est. 24h</th>
                  <th>Our anchor 24h</th>
                  <th>WTM / anchor</th>
                  <th>Pool unpaid (real)</th>
                </tr>
              </thead>
              <tbody>
                {verify.rows.map((r) => (
                  <tr key={r.target_pool}>
                    <td>{COIN_LABEL[r.target_pool] || r.target_pool}</td>
                    <td>{num(r.rented_hashrate)} {r.rented_unit}</td>
                    <td>{r.wtm_est_24h != null ? `${num(r.wtm_est_24h)} ${r.coin}` : '—'}</td>
                    <td>{r.anchor_est_24h != null ? `${num(r.anchor_est_24h)} ${r.coin}` : '—'}</td>
                    <td className={r.ratio_wtm_vs_anchor != null ? (Math.abs(r.ratio_wtm_vs_anchor - 1) > 0.35 ? 'pnl-neg' : 'pnl-pos') : ''}>
                      {r.ratio_wtm_vs_anchor != null ? `${r.ratio_wtm_vs_anchor.toFixed(2)}×` : '—'}
                    </td>
                    <td>{r.pool_unpaid != null ? `${num(r.pool_unpaid)} ${r.pool_unpaid_unit}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === 'scan' && (
        <div className="admin-card">
          <h3>Profitable + liquid mining options (rentable rig classes)</h3>
          <p className="admin-miner admin-note">
            WhatToMine profit at $0.12/kWh for our rig classes, ranked. The liquidity filter is the anti-mirage rule:
            <strong> liquid = top-exchange volume ≥ $10k BTC/day</strong> (sellable ≥ $1k). A high profit on an
            illiquid coin is not real — you cannot exit.
          </p>
          {!scan && !error && <p className="admin-empty">Loading…</p>}
          {scan && (
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Coin</th>
                  <th>Algorithm</th>
                  <th>Profit/day</th>
                  <th>Revenue/day</th>
                  <th>Liquidity</th>
                </tr>
              </thead>
              <tbody>
                {scan.rows.map((r) => (
                  <tr key={r.coin} className={r.liquid ? '' : 'wtm-mirage'}>
                    <td>{r.coin} <span className="admin-freshness">{r.name}</span></td>
                    <td>{r.algorithm || '—'}</td>
                    <td className={Number(r.profit_usd_day) > 0 ? 'pnl-pos' : 'pnl-neg'}>{usd(r.profit_usd_day)}</td>
                    <td>{usd(r.revenue_usd_day)}</td>
                    <td title={`${r.top_exchange || 'no volume'} — ${num(r.top_volume_btc_day)} BTC/day`}>
                      {r.liquid ? '✅ liquid' : r.sellable ? '⚠️ thin' : '❌ unsellable'}
                      {r.top_exchange && <span className="admin-freshness"> · {r.top_exchange}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === 'coins' && (
        <div className="admin-card">
          <h3>Coin screen — volume, momentum, difficulty</h3>
          <p className="admin-miner admin-note">
            All coins by top-exchange volume. 30d momentum + difficulty change spot early movers and closing
            windows (rising difficulty on a small coin = miners already arrived).
          </p>
          {!coins && !error && <p className="admin-empty">Loading…</p>}
          {coins && (
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Coin</th>
                  <th>Market cap</th>
                  <th>Price</th>
                  <th>30d change</th>
                  <th>30d difficulty</th>
                  <th>Volume (BTC/day)</th>
                </tr>
              </thead>
              <tbody>
                {coins.rows.slice(0, 40).map((r) => (
                  <tr key={r.coin}>
                    <td>{r.coin} <span className="admin-freshness">{r.name}</span></td>
                    <td>{r.market_cap != null ? `$${num(r.market_cap / 1e6, 1)}M` : '—'}</td>
                    <td>{r.price != null ? usd(r.price, 4) : '—'}</td>
                    <td className={Number(r.change_30d_pct) > 5 ? 'pnl-pos' : Number(r.change_30d_pct) < -5 ? 'pnl-neg' : ''}>
                      {pct(r.change_30d_pct)}
                    </td>
                    <td>{pct(r.difficulty_30d_pct)}</td>
                    <td>{num(r.top_volume_btc_day)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}
