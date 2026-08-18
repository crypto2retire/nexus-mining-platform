import { useEffect, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '';

/**
 * Live miner panel — polls the backend /api/miner/status proxy every 10s
 * and shows the local XMRig's live hashrate, shares, uptime and pool.
 */
export default function LiveMinerPanel() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/miner/status`);
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = await res.json();
        if (!cancelled) {
          setStatus(data);
          setError('');
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    };

    poll();
    const id = setInterval(poll, 10000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const online = Boolean(status?.online);
  const [busy, setBusy] = useState(false);
  const [actionMsg, setActionMsg] = useState('');

  const runAction = async (action) => {
    setBusy(true);
    setActionMsg('');
    try {
      const res = await fetch(`${API_BASE}/api/miner/${action}`, { method: 'POST' });
      const data = await res.json();
      setActionMsg(data.ok ? (data.alreadyRunning ? 'Already running' : `Miner ${action === 'start' ? 'started' : 'stopped'}`) : `Error: ${data.error || res.status}`);
      // Refresh status shortly after the action.
      setTimeout(async () => {
        try {
          const r = await fetch(`${API_BASE}/api/miner/status`);
          setStatus(await r.json());
        } catch { /* keep last status */ }
      }, 3000);
    } catch (err) {
      setActionMsg(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mining-card miner-panel">
      <div className="card-header">
        <h2>Live Miner — Local Machine</h2>
        <span className={`status-pill ${online ? 'active' : 'idle'}`}>
          {online ? 'MINING' : 'OFFLINE'}
        </span>
      </div>

      {error && <div className="error-banner">Miner monitor: {error}</div>}

      <div className="miner-controls">
        <button
          className="btn btn-primary"
          disabled={busy || online}
          onClick={() => runAction('start')}
        >
          ▶ Start Miner
        </button>
        <button
          className="btn btn-danger"
          disabled={busy || !online}
          onClick={() => runAction('stop')}
        >
          ■ Stop Miner
        </button>
        {actionMsg && <span className="miner-action-msg">{actionMsg}</span>}
      </div>

      {online ? (
        <div className="card-stats">
          <div className="stat">
            <span className="stat-label">Hashrate (10s)</span>
            <span className="stat-value">{status.hashrate_10s ? status.hashrate_10s.toFixed(1) : '…'} H/s</span>
          </div>
          <div className="stat">
            <span className="stat-label">Hashrate (60s)</span>
            <span className="stat-value">{status.hashrate_60s ? status.hashrate_60s.toFixed(1) : '…'} H/s</span>
          </div>
          <div className="stat">
            <span className="stat-label">Accepted Shares</span>
            <span className="stat-value accent">{status.shares_good ?? '…'}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Uptime</span>
            <span className="stat-value">
              {status.uptime ? `${Math.floor(status.uptime / 60)}m ${status.uptime % 60}s` : '…'}
            </span>
          </div>
          <div className="stat">
            <span className="stat-label">Algorithm</span>
            <span className="stat-value">{status.algo ?? '…'}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Pool</span>
            <span className="stat-value stat-small">{status.pool ?? '…'}</span>
          </div>
        </div>
      ) : (
        <p className="miner-offline">
          {status
            ? 'Miner not running locally. Start XMRig to see live stats here.'
            : 'Connecting to miner monitor…'}
        </p>
      )}
    </section>
  );
}
