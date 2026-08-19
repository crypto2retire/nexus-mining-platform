import { useCallback, useEffect, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '';

const POOL_LABELS = {
  ZCASH: 'ZEC',
  KASPA: 'KAS',
  LTC_DOGE: 'LTC/DOGE',
  XMR: 'XMR',
};

/**
 * Operator-only panel. Rendered only when the connected wallet is on the
 * ADMIN_WALLETS allow-list (backend sets is_admin on the dashboard payload).
 * Every admin call sends the wallet as the x-wallet header so the backend
 * can enforce the same allow-list on each request.
 */
export default function AdminPanel({ wallet }) {
  const [withdrawals, setWithdrawals] = useState(null);
  const [payoutStatus, setPayoutStatus] = useState(null);
  const [minerStatus, setMinerStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [txHashes, setTxHashes] = useState({});

  const headers = {
    'Content-Type': 'application/json',
    'x-wallet': wallet,
  };

  const flash = (m) => {
    setMsg(m);
    setTimeout(() => setMsg(''), 4000);
  };

  const loadAll = useCallback(async () => {
    try {
      const [w, p, m] = await Promise.all([
        fetch(`${API_BASE}/api/rewards/withdrawals`, { headers }).then((r) => r.json()),
        fetch(`${API_BASE}/api/rewards/payout-status`, { headers }).then((r) => r.json()),
        fetch(`${API_BASE}/api/miner/status`).then((r) => r.json()),
      ]);
      setWithdrawals(w.withdrawals || []);
      setPayoutStatus(p);
      setMinerStatus(m);
    } catch (e) {
      setMsg(`Load failed: ${e.message}`);
    }
  }, [wallet]);

  useEffect(() => {
    if (wallet) loadAll();
  }, [wallet, loadAll]);

  const markPaid = async (id) => {
    const txHash = (txHashes[id] || '').trim();
    if (!txHash) return flash('Enter the transaction hash first');
    setBusy(true);
    try {
      const r = await fetch(`${API_BASE}/api/rewards/withdrawals/${id}/paid`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ tx_hash: txHash }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      flash(`Withdrawal ${id} marked PAID`);
      loadAll();
    } catch (e) {
      flash(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const reject = async (id) => {
    if (!window.confirm(`Reject withdrawal ${id}? Rewards return to the user's ledger.`)) return;
    setBusy(true);
    try {
      const r = await fetch(`${API_BASE}/api/rewards/withdrawals/${id}/reject`, {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      flash(`Withdrawal ${id} REJECTED — rewards released`);
      loadAll();
    } catch (e) {
      flash(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const checkPayouts = async () => {
    setBusy(true);
    try {
      const r = await fetch(`${API_BASE}/api/rewards/check-payouts`, {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      flash('Payout check complete — refresh status below');
      loadAll();
    } catch (e) {
      flash(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const setMiner = async (action) => {
    setBusy(true);
    try {
      const r = await fetch(`${API_BASE}/api/miner/${action}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      flash(`Miner ${action} request sent`);
      loadAll();
    } catch (e) {
      flash(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="admin-panel">
      <h2 className="admin-title">⚙ Admin</h2>
      {msg && <div className="admin-msg">{msg}</div>}

      <div className="admin-grid">
        {/* Withdrawal queue */}
        <div className="admin-card">
          <h3>Withdrawal queue</h3>
          {withdrawals === null ? (
            <p className="admin-empty">Loading…</p>
          ) : withdrawals.length === 0 ? (
            <p className="admin-empty">No withdrawal requests.</p>
          ) : (
            <table className="admin-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>User</th>
                  <th>Coin</th>
                  <th>Amount</th>
                  <th>To address</th>
                  <th>Status</th>
                  <th>Tx hash</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {withdrawals.map((w) => (
                  <tr key={w.withdrawal_id}>
                    <td>{w.withdrawal_id}</td>
                    <td title={w.wallet_address}>
                      {w.wallet_address ? `${w.wallet_address.slice(0, 6)}…${w.wallet_address.slice(-4)}` : '—'}
                    </td>
                    <td>{POOL_LABELS[w.target_pool] || w.target_pool}</td>
                    <td>{Number(w.amount_coin || 0).toFixed(6)}</td>
                    <td title={w.to_address} className="admin-addr">
                      {w.to_address ? w.to_address.slice(0, 14) + '…' : '—'}
                    </td>
                    <td>
                      <span className={`status-${String(w.status).toLowerCase()}`}>{w.status}</span>
                    </td>
                    <td className="admin-addr">{w.tx_hash ? w.tx_hash.slice(0, 12) + '…' : '—'}</td>
                    <td>
                      {w.status === 'PENDING' && (
                        <div className="admin-actions">
                          <input
                            className="admin-tx"
                            placeholder="tx hash"
                            value={txHashes[w.withdrawal_id] || ''}
                            onChange={(e) => setTxHashes({ ...txHashes, [w.withdrawal_id]: e.target.value })}
                          />
                          <button className="btn-small" disabled={busy} onClick={() => markPaid(w.withdrawal_id)}>
                            Mark paid
                          </button>
                          <button className="btn-small btn-danger" disabled={busy} onClick={() => reject(w.withdrawal_id)}>
                            Reject
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Payout status */}
        <div className="admin-card">
          <h3>Payout watcher</h3>
          {payoutStatus ? (
            <ul className="admin-list">
              {Object.entries(payoutStatus).map(([k, v]) => (
                <li key={k}>
                  <strong>{k}</strong>: {typeof v === 'object' ? JSON.stringify(v) : String(v)}
                </li>
              ))}
            </ul>
          ) : (
            <p className="admin-empty">Loading…</p>
          )}
          <button className="btn-small" disabled={busy} onClick={checkPayouts}>
            Check payouts now
          </button>
        </div>

        {/* Miner controls */}
        <div className="admin-card">
          <h3>Platform miner</h3>
          {minerStatus ? (
            <p className="admin-miner">
              <strong>Status:</strong> {minerStatus.online ? '🟢 mining' : '🔴 offline'}
              {minerStatus.hashrate ? ` · ${minerStatus.hashrate}` : ''}
              {minerStatus.algo ? ` · ${minerStatus.algo}` : ''}
              {minerStatus.pool ? ` · ${minerStatus.pool}` : ''}
            </p>
          ) : (
            <p className="admin-empty">Loading…</p>
          )}
          <div className="admin-actions">
            <button className="btn-small" disabled={busy} onClick={() => setMiner('start')}>
              Start miner
            </button>
            <button className="btn-small btn-danger" disabled={busy} onClick={() => setMiner('stop')}>
              Stop miner
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
