import { useEffect, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '';

/**
 * Mining Opportunities — live market monitor for CPU-minable coins.
 * Ranked by estimated $/day for THIS machine (M4, measured hashrates).
 * Verified coins with a configured wallet can be switched to with one click.
 */
export default function MiningOpportunities({ currentPool, isAdmin = false, wallet = '' }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/mining/opportunities`);
        if (!res.ok) throw new Error(`status ${res.status}`);
        const d = await res.json();
        if (!cancelled) setData(d);
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    };
    load();
    const id = setInterval(load, 60000); // refresh prices/network every minute
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const isCurrent = (coin) => {
    if (!currentPool) return false;
    return coin.pool_host && currentPool.includes(coin.pool_host.split('.')[0]);
  };

  const doSwitch = async (symbol) => {
    setBusy(symbol);
    setMsg('');
    try {
      const res = await fetch(`${API_BASE}/api/miner/switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-wallet': wallet },
        body: JSON.stringify({ symbol }),
      });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error || `status ${res.status}`);
      setMsg(`Switched to ${symbol} — mining on ${d.pool}. Give it ~30s to ramp up.`);
      // Force a refresh of the opportunities list + miner status shortly after.
      setTimeout(() => {
        const res2 = fetch(`${API_BASE}/api/mining/opportunities`);
        res2.then((r) => r.json()).then((dd) => setData(dd)).catch(() => {});
      }, 5000);
    } catch (err) {
      setMsg(`Switch failed: ${err.message}`);
    } finally {
      setBusy('');
    }
  };

  if (!data && !error) return <section className="mining-card"><h2>Mining Opportunities</h2><p className="miner-offline">Loading market data…</p></section>;

  return (
    <section className="mining-card">
      <div className="card-header">
        <h2>Mining Opportunities</h2>
        {data?.fetched_at && (
          <span className="status-pill idle">live · {new Date(data.fetched_at).toLocaleTimeString()}</span>
        )}
      </div>

      {error && <div className="error-banner">Market monitor: {error}</div>}
      {msg && <div className="miner-action-msg">{msg}</div>}

      {data?.coins?.map((coin) => {
        const current = isCurrent(coin);
        return (
          <div key={coin.symbol} className={`opp-row ${current ? 'opp-current' : ''} ${coin.verified ? '' : 'opp-unverified'}`}>
            <div className="opp-main">
              <span className="opp-symbol">{coin.symbol}</span>
              <span className="opp-name">{coin.name}</span>
              {current && <span className="status-pill active">CURRENT</span>}
              {!coin.verified && <span className="status-pill idle">unverified</span>}
            </div>
            {coin.verified && coin.est_usd_day != null ? (
              <div className="opp-stats">
                <span className="stat-label">Est. /day</span>
                <span className="stat-value accent">${coin.est_usd_day.toFixed(4)}</span>
                <span className="stat-label">Price</span>
                <span className="stat-value">${coin.price_usd != null ? coin.price_usd.toFixed(6) : 'n/a'}</span>
                {coin.change_24h != null && (
                  <span className={`opp-change ${coin.change_24h >= 0 ? 'up' : 'down'}`}>
                    {coin.change_24h >= 0 ? '+' : ''}{coin.change_24h}% 24h
                  </span>
                )}
                <span className="stat-label">Est. coins/day</span>
                <span className="stat-value">{coin.est_coins_day != null ? coin.est_coins_day.toFixed(6) : 'n/a'}</span>
                <span className="stat-label">Network</span>
                <span className="stat-value stat-small">{coin.network_hashrate != null ? `${(coin.network_hashrate / 1e6).toFixed(1)} MH/s` : 'n/a'}</span>
                <span className="stat-label">M4 hashrate</span>
                <span className="stat-value stat-small">{coin.m4_hashrate ? `${coin.m4_hashrate} H/s` : 'n/a'}</span>
              </div>
            ) : (
              <div className="opp-stats">
                <span className="stat-label">Status</span>
                <span className="stat-value stat-small">{coin.note}</span>
              </div>
            )}
            <div className="opp-actions">
              {coin.verified && isAdmin ? (
                <button
                  className="btn btn-balance"
                  disabled={busy || current || !coin.switchable}
                  onClick={() => doSwitch(coin.symbol)}
                >
                  {busy === coin.symbol ? 'Switching…' : current ? 'Mining' : 'Switch to'}
                </button>
              ) : coin.verified ? (
                <span className="miner-action-msg">switch is operator-only</span>
              ) : null}
              {coin.verified && !coin.wallet_configured && (
                <span className="miner-action-msg">add {coin.symbol}_WALLET_ADDRESS to enable</span>
              )}
            </div>
          </div>
        );
      })}

      <p className="opp-footnote">
        Estimates use your measured M4 hashrate, live pool difficulty and live prices.
        CPU mining on this Mac is a loop-prover, not income — all coins pay roughly
        $0.05–0.15/day here. Unverified coins lack a confirmed pool on this setup.
      </p>
    </section>
  );
}
