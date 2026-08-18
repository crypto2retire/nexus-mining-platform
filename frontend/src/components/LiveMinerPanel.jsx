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
  const [balance, setBalance] = useState(null);
  const [balanceError, setBalanceError] = useState('');

  const checkBalance = async () => {
    setBusy(true);
    setBalanceError('');
    try {
      const res = await fetch(`${API_BASE}/api/miner/balance`);
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'balance unavailable');
      setBalance(data);
    } catch (err) {
      setBalanceError(err.message);
      setBalance(null);
    } finally {
      setBusy(false);
    }
  };

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
      {balanceError && <div className="error-banner">Balance: {balanceError}</div>}

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
        <button
          className="btn btn-balance"
          disabled={busy}
          onClick={checkBalance}
        >
          💰 Check Balance
        </button>
        {actionMsg && <span className="miner-action-msg">{actionMsg}</span>}
      </div>

      {balance && (
        <div className="balance-card">
          <div className="balance-row">
            <span className="stat-label">Pool balance (unpaid)</span>
            <span className="stat-value accent">
              {balance.unpaid_xmr ?? '…'} XMR
              {balance.unpaid_usd != null && (
                <span className="balance-usd"> ≈ ${balance.unpaid_usd}</span>
              )}
            </span>
          </div>
          <div className="balance-row">
            <span className="stat-label">Unlocked / Unconfirmed</span>
            <span className="stat-value">
              {balance.unlocked_xmr ?? '…'} / {balance.unconfirmed_xmr ?? '…'} XMR
            </span>
          </div>
          <div className="balance-row">
            <span className="stat-label">Payments (24h / 7d)</span>
            <span className="stat-value">
              {balance.payments_24h ?? '…'} / {balance.payments_7d ?? '…'}
            </span>
          </div>
          <div className="balance-row">
            <span className="stat-label">XMR price</span>
            <span className="stat-value">
              {balance.xmr_usd_price != null ? `$${balance.xmr_usd_price}` : 'n/a'}
            </span>
          </div>
          {balance.last_payment && (
            <div className="balance-row">
              <span className="stat-label">Last payout</span>
              <span className="stat-value stat-small">
                {balance.last_payment.amount} XMR · {balance.last_payment.hash ? balance.last_payment.hash.slice(0, 12) : ''}
              </span>
            </div>
          )}
          <div className="balance-meta">
            Address: {balance.address ? `${balance.address.slice(0, 12)}…${balance.address.slice(-8)}` : '…'}
            {balance.fetched_at ? ` · fetched ${new Date(balance.fetched_at).toLocaleTimeString()}` : ''}
          </div>
        </div>
      )}

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
