import { useCallback, useEffect, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '';
const ADMIN_KEY_STORAGE = 'nexus.adminKey';

const POOL_LABELS = {
  ZCASH: 'ZEC',
  KASPA: 'KAS',
  LTC_DOGE: 'LTC/DOGE',
  XMR: 'XMR',
};

const POOL_KEYS = ['ZCASH', 'KASPA', 'LTC_DOGE', 'XMR'];

// Per-coin hashrate unit (2026-08-20): credits are in each room's REAL unit.
const POOL_UNITS = { ZCASH: 'KH/s', KASPA: 'GH/s', LTC_DOGE: 'GH/s', XMR: 'KH/s' };

/**
 * Operator-only panel. The administrator enters a credential that is separate
 * from wallet authentication. Every operator request sends that credential in
 * the x-admin-key header; a public wallet address is never an admin credential.
 */
async function adminResult(response, fallback) {
  let body;
  try {
    body = await response.json();
  } catch (_err) {
    throw new Error(fallback);
  }
  if (!response.ok) throw new Error(body?.error || fallback);
  return body;
}

export default function AdminPanel({ refreshKey = 0 }) {
  const [adminKey, setAdminKey] = useState(() => localStorage.getItem(ADMIN_KEY_STORAGE) || '');
  const [keyDraft, setKeyDraft] = useState(() => localStorage.getItem(ADMIN_KEY_STORAGE) || '');
  const [withdrawals, setWithdrawals] = useState(null);
  const [payoutStatus, setPayoutStatus] = useState(null);
  const [stats, setStats] = useState(null);
  const [backing, setBacking] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [txHashes, setTxHashes] = useState({});

  const headers = {
    'Content-Type': 'application/json',
    'x-admin-key': adminKey,
  };

  const flash = (m) => {
    setMsg(m);
    setTimeout(() => setMsg(''), 4000);
  };

  const loadAll = useCallback(async () => {
    if (!adminKey) return;
    try {
      const [w, p, s, b] = await Promise.all([
        fetch(`${API_BASE}/api/rewards/withdrawals`, { headers }).then((r) => adminResult(r, 'Could not load withdrawals.')),
        fetch(`${API_BASE}/api/rewards/payout-status`, { headers }).then((r) => adminResult(r, 'Could not load payout status.')),
        fetch(`${API_BASE}/api/admin/stats`, { headers }).then((r) => adminResult(r, 'Could not load platform statistics.')),
        fetch(`${API_BASE}/api/admin/backing`, { headers }).then((r) => adminResult(r, 'Could not load backing data.')),
      ]);
      setWithdrawals(w.withdrawals || []);
      setPayoutStatus(p);
      setStats(s);
      setBacking(b.backing || null);
    } catch (e) {
      setMsg(`Load failed: ${e.message}`);
    }
  }, [adminKey]);

  useEffect(() => {
    if (adminKey) loadAll();
    // refreshKey bumps after every dashboard fetch (purchases, deposits,
    // claims) — re-load the admin tables so they never go stale.
  }, [adminKey, loadAll, refreshKey]);

  const saveAdminKey = () => {
    const normalized = keyDraft.trim();
    if (!normalized) return flash('Enter the administrator API key');
    localStorage.setItem(ADMIN_KEY_STORAGE, normalized);
    setAdminKey(normalized);
  };

  const clearAdminKey = () => {
    localStorage.removeItem(ADMIN_KEY_STORAGE);
    setAdminKey('');
    setKeyDraft('');
    setWithdrawals(null);
    setPayoutStatus(null);
    setStats(null);
    setBacking(null);
  };

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
      await adminResult(r, 'Could not mark the withdrawal paid.');
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
      await adminResult(r, 'Could not reject the withdrawal.');
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
      await adminResult(r, 'Could not run the payout check.');
      flash('Payout check complete — refresh status below');
      loadAll();
    } catch (e) {
      flash(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="admin-panel">
      <div className="admin-title-row">
        <h2 className="admin-title">⚙ Admin</h2>
        {adminKey && (
          <button className="btn-secondary btn-small" onClick={() => loadAll()}>
            ↻ Refresh
          </button>
        )}
      </div>
      <div className="admin-auth-row">
        <input
          className="admin-key-input"
          type="password"
          autoComplete="off"
          value={keyDraft}
          onChange={(event) => setKeyDraft(event.target.value)}
          placeholder="Administrator API key"
          aria-label="Administrator API key"
        />
        <button className="btn-secondary btn-small" onClick={saveAdminKey}>Use key</button>
        {adminKey && <button className="btn-secondary btn-small" onClick={clearAdminKey}>Clear</button>}
      </div>
      {msg && <div className="admin-msg">{msg}</div>}

      {adminKey ? <div className="admin-grid">
        {/* Platform overview */}
        <div className="admin-card">
          <h3>Platform overview</h3>
          {!stats ? (
            <p className="admin-empty">Loading…</p>
          ) : (
            <>
              <p className="admin-miner">
                <strong>Users:</strong> {stats.users?.count ?? 0} ·{' '}
                <strong>Deposits:</strong> ${Number(stats.deposits?.total_usdc ?? 0).toFixed(2)} USDC ({stats.deposits?.count ?? 0} txns)
              </p>
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Coin</th>
                    <th>Virtual capacity</th>
                    <th>Rigs</th>
                    <th>Mined</th>
                    <th>Users earned</th>
                    <th>Treasury (5%)</th>
                  </tr>
                </thead>
                <tbody>
                  {POOL_KEYS.map((key) => {
                    const cap = stats.capacity_by_pool?.[key];
                    const pay = stats.payouts_by_pool?.[key];
                    const led = stats.ledger_by_pool?.[key];
                    return (
                      <tr key={key}>
                        <td>{POOL_LABELS[key] || key}</td>
                        <td>{cap ? Number(cap.total_hashrate).toFixed(2) : '0.00'} {POOL_UNITS[key] || 'GH/s'}</td>
                        <td>{cap?.rig_count ?? 0}</td>
                        <td>{pay ? Number(pay.total_crypto).toFixed(6) : '0.000000'}</td>
                        <td>{led ? Number(led.total_earned_crypto).toFixed(6) : '0.000000'}</td>
                        <td>{pay ? Number(pay.treasury_share_crypto).toFixed(6) : '0.000000'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="admin-miner">
                <strong>Treasury revenue:</strong> ${Number(stats.treasury?.protocol_revenue_usdc ?? 0).toFixed(2)} USDC
                ({stats.treasury?.revenue_entry_count ?? 0} ledger entries, converted at recorded price snapshots).
              </p>
            </>
          )}
        </div>

        {/* Real Backing — what ACTUALLY mines vs virtual capacity sold */}
        <div className="admin-card">
          <h3>Real Backing</h3>
          {!backing ? (
            <p className="admin-empty">Loading…</p>
          ) : (
            <>
              <p className="admin-miner">
                <strong>Virtual</strong> = what players own. <strong>Real rig</strong> = rented hashrate actually mining
                to the platform wallet. Users' payouts come pro-rata from the real pool earnings.
              </p>
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Coin</th>
                    <th>Virtual sold</th>
                    <th>Rigs sold</th>
                    <th>Real rig</th>
                    <th>Real rate</th>
                    <th>Pool unpaid</th>
                    <th>Mined (pool)</th>
                  </tr>
                </thead>
                <tbody>
                  {POOL_KEYS.map((key) => {
                    const b = backing[key];
                    if (!b) return null;
                    const rentals = b.active_rentals || [];
                    return (
                      <tr key={key}>
                        <td>{POOL_LABELS[key] || key}</td>
                        <td>{Number(b.virtual_ghs).toFixed(2)} {POOL_UNITS[key] || 'GH/s'}</td>
                        <td>{b.rigs_sold}</td>
                        <td title={rentals.map((r) => `${r.rig_name} (rpi ${r.rig_rpi}, ${r.length_hours}h)`).join('\n')}>
                          {rentals.length > 0 ? rentals.map((r) => `#${r.mrr_rental_id}`).join(', ') : 'none'}
                        </td>
                        <td>
                          {b.real_hash != null ? `${Number(b.real_hash).toFixed(1)} ${b.real_unit}` : 'n/a'}
                        </td>
                        <td>
                          {b.pool_unpaid != null ? `${Number(b.pool_unpaid).toFixed(4)} ${b.pool_unpaid_unit}` : 'n/a'}
                        </td>
                        <td>
                          {Number(b.mined_total) > 0
                            ? `${Number(b.mined_total).toFixed(4)}${Number(b.mined_2) > 0 ? ` + ${Number(b.mined_2).toFixed(2)} DOGE` : ''}`
                            : '0'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="admin-miner">
                <strong>Real rate</strong> comes from the pool's own wallet API (ZEC/KAS), the rented rig's live
                average (LTC), or the F2Pool worker stats (DOGE). Refreshes every 60s.
                {backing.generated_at && (
                  <span className="admin-freshness"> · data as of {new Date(backing.generated_at).toLocaleTimeString()}</span>
                )}
              </p>
            </>
          )}
        </div>

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
      </div> : <p className="admin-empty">Enter the separate administrator API key to load operator controls.</p>}
    </section>
  );
}
