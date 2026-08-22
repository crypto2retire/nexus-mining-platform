import { useEffect, useMemo, useRef, useState } from 'react';
import MiningRoomCard from './components/MiningRoomCard';
import SummaryRow from './components/SummaryRow';
import GetStarted from './components/GetStarted';
import AdminPanel from './components/AdminPanel';
import WalletAuth, { AUTH_STORAGE_KEY } from './components/WalletAuth';
import GamePanel from './components/GamePanel';
import MarketPanel from './components/MarketPanel';
import PayoutHistory from './components/PayoutHistory';
import ConnectPanel from './components/ConnectPanel';
import OperatorMinersPanel from './components/OperatorMinersPanel';

const API_BASE = import.meta.env.VITE_API_URL || '';
const VALID_WALLET_RE = /^0x[a-f0-9]{40}$/i;
const OPERATOR_WALLET = String(import.meta.env.VITE_OPERATOR_WALLET || '').trim().toLowerCase();

const POOLS = [
  { key: 'ZCASH', title: 'Zcash (ZEC) Mine' },
  { key: 'KASPA', title: 'Kaspa (KAS) Mine' },
  { key: 'LTC_DOGE', title: 'Litecoin / Dogecoin Merge' },
  { key: 'BTC', title: 'Bitcoin (BTC) Mine' },
];

function storedAuth() {
  try {
    const parsed = JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY) || 'null');
    if (parsed?.token && VALID_WALLET_RE.test(parsed.wallet || '')) return parsed;
  } catch (_err) {
    localStorage.removeItem(AUTH_STORAGE_KEY);
  }
  return null;
}

async function apiResult(response, fallback) {
  let body;
  try {
    body = await response.json();
  } catch (_err) {
    throw new Error(fallback);
  }
  if (!response.ok) throw new Error(body?.error || fallback);
  return body;
}

function useAnimatedPending(pendingByPool) {
  const [display, setDisplay] = useState({});
  const baseRef = useRef(pendingByPool);

  useEffect(() => {
    baseRef.current = pendingByPool;
    setDisplay(pendingByPool);
  }, [pendingByPool]);

  useEffect(() => {
    const id = setInterval(() => {
      setDisplay(prev => {
        const next = {};
        for (const pool of POOLS) {
          const base = baseRef.current[pool.key] || 0;
          next[pool.key] = base + (Math.random() * base * 0.0001);
        }
        return next;
      });
    }, 1000);
    return () => clearInterval(id);
  }, []);

  return display;
}

export default function App() {
  const [auth, setAuth] = useState(storedAuth);
  const [activeView, setActiveView] = useState('dashboard');
  const [restoringSession, setRestoringSession] = useState(true);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // Bumped after every successful dashboard fetch so the admin panel (which
  // self-fetches) can re-load after purchases/deposits — it was stuck showing
  // pre-purchase numbers (KAS 25 GH/s while the card showed 75).
  const [dataVersion, setDataVersion] = useState(0);
  const wallet = auth?.wallet || '';
  const isOperator = Boolean(OPERATOR_WALLET) && wallet.trim().toLowerCase() === OPERATOR_WALLET;

  const fetchDashboard = async (address) => {
    const addr = (address ?? wallet).trim().toLowerCase();
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/api/dashboard?wallet=${encodeURIComponent(addr)}`);
      if (!res.ok) {
        let msg = `Request failed (${res.status})`;
        try {
          const body = await res.json();
          if (body?.error) msg = body.error;
        } catch { /* keep default message */ }
        throw new Error(msg);
      }
      setData(await res.json());
      setDataVersion((v) => v + 1);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const authHeaders = () => {
    if (!auth?.token) throw new Error('Sign in with your wallet before using this action.');
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth.token}`,
    };
  };

  const handleAuthChange = (nextAuth) => {
    setAuth(nextAuth);
    setError('');
    if (nextAuth) {
      fetchDashboard(nextAuth.wallet);
    } else {
      setActiveView('dashboard');
      setData(null);
    }
  };

  // RENT: pay USDC (or reinvested tokens) to rent hashrate for a 72h window.
  // `renew=true` repeats the current rental configuration.
  const rent = async (pool, { renew = false } = {}) => {
    try {
      setError('');
      // Idempotency key: prevents double-click / network retry from placing two orders.
      const requestId = crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const res = await fetch(`${API_BASE}/api/rigs/upgrade`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ target_pool: pool, request_id: requestId, renew }),
      });
      const result = await apiResult(res, 'Rent failed');

      const sandboxTag = result.sandbox ? ' [SANDBOX]' : '';
      const marketplaceTag = result.marketplace ? `\nMarketplace: ${result.marketplace}` : '';
      const summary = result.btc_spent
        ? `\n\nBTC spent: ${result.btc_spent}\nOrder ID: ${result.nicehash_order_id || 'n/a'}\nStatus: ${result.order_status || 'n/a'}${marketplaceTag}${sandboxTag}`
        : '';
      const expires = result.rental_expires_at
        ? `\nRental window: ${result.rig_hours}h (until ${new Date(result.rental_expires_at).toLocaleString()})`
        : '';
      alert(
        renew
          ? `🔄 Rental renewed! ${result.hashrate} ${result.unit || 'GH/s'} for ${result.rig_hours || 72}h${expires}${summary}`
          : `🎉 Rented! ${result.hashrate} ${result.unit || 'GH/s'} for ${result.rig_hours || 72}h${expires}${summary}`
      );
      await fetchDashboard();
    } catch (err) {
      setError(err.message);
    }
  };

  // Reinvest: mined tokens fund the next rental window directly — no USDC
  // deposit step. Same idempotent rent path behind the scenes.
  const reinvest = async (pool) => {
    try {
      setError('');
      const requestId = crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const res = await fetch(`${API_BASE}/api/rigs/reinvest`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ target_pool: pool, request_id: requestId }),
      });
      const result = await apiResult(res, 'Reinvest failed');

      const sandboxTag = result.sandbox ? ' [SANDBOX]' : '';
      const marketplaceTag = result.marketplace ? `\nMarketplace: ${result.marketplace}` : '';
      const summary = result.btc_spent
        ? `\n\nBTC spent: ${result.btc_spent}\nOrder ID: ${result.nicehash_order_id || 'n/a'}\nStatus: ${result.order_status || 'n/a'}${marketplaceTag}${sandboxTag}`
        : '';
      alert(
        `🔄 Reinvested ${Number(result.reinvested_usdc || 0).toFixed(2)} USDC of mined tokens — ` +
        `rented ${result.hashrate} ${result.unit || 'GH/s'} for ${result.rig_hours || 72}h${summary}`
      );
      await fetchDashboard();
    } catch (err) {
      setError(err.message);
    }
  };

  // Claim pending yield → USDC balance (live price, 5% fee already taken).
  const claim = async (pool) => {
    try {
      setError('');
      const res = await fetch(`${API_BASE}/api/rewards/claim`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ target_pool: pool }),
      });
      const result = await apiResult(res, 'Claim failed');
      if (result.claimed_usdc > 0) {
        alert(`💰 Claimed ${result.claimed_usdc} USDC${result.pools?.length ? ` (${result.pools.join(', ')})` : ''} — added to your balance.`);
      } else {
        alert('Nothing to claim yet — yield accumulates after real pool payouts.');
      }
      await fetchDashboard();
    } catch (err) {
      setError(err.message);
    }
  };

  // Withdraw pending yield in the mined token (e.g. ZEC for ZEC rewards) to a
  // user-supplied wallet address of that coin.
  const withdraw = async (pool) => {
    try {
      setError('');
      const coinName = pool === 'ZCASH' ? 'ZEC' : pool === 'KASPA' ? 'KAS (Kaspa)' : pool === 'LTC_DOGE' ? 'LTC' : 'BTC';
      const example =
        pool === 'ZCASH' ? 't1...' : pool === 'KASPA' ? 'kaspa:...' : pool === 'LTC_DOGE' ? 'ltc1...' : 'bc1...';
      const amount = window.prompt(`Withdraw ${coinName} — how much? (available: ${Number(data.pending_rewards[pool] || 0).toFixed(8)})`, '');
      if (!amount) return;
      const toAddress = window.prompt(`Send ${coinName} to which address? (${example})`, '');
      if (!toAddress) return;
      const res = await fetch(`${API_BASE}/api/rewards/withdraw`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ target_pool: pool, amount_coin: Number(amount), to_address: toAddress }),
      });
      const result = await apiResult(res, 'Withdrawal request failed');
      alert(`📤 Withdrawal requested: ${result.amount_coin} ${result.target_pool} to ${result.to_address}\nThe platform operator will send it and mark it PAID.`);
      await fetchDashboard();
    } catch (err) {
      setError(err.message);
    }
  };

  useEffect(() => {
    const restore = async () => {
      if (!auth?.token) {
        setRestoringSession(false);
        return;
      }
      try {
        const response = await fetch(`${API_BASE}/api/auth/me`, {
          headers: { Authorization: `Bearer ${auth.token}` },
        });
        const session = await apiResult(response, 'Your wallet session has expired.');
        const restored = { token: auth.token, wallet: session.wallet };
        localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(restored));
        setAuth(restored);
        await fetchDashboard(session.wallet);
      } catch (err) {
        localStorage.removeItem(AUTH_STORAGE_KEY);
        setAuth(null);
        setData(null);
        setError(err.message);
      } finally {
        setRestoringSession(false);
      }
    };
    restore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totalHashrate = useMemo(() => {
    if (!data) return 0;
    // Virtual credits are per-coin units (ZEC KH/s, KAS/LTC GH/s, BTC TH/s) —
    // normalize to GH/s before summing so the header is honest.
    return POOLS.reduce((sum, p) => {
      const h = Number(data.rigs[p.key]?.virtual_hashrate) || 0;
      const unit = { ZCASH: 'KH/s', KASPA: 'GH/s', LTC_DOGE: 'GH/s', BTC: 'TH/s' }[p.key];
      return sum + (unit === 'KH/s' ? h / 1e3 : unit === 'TH/s' ? h * 1e3 : h);
    }, 0);
  }, [data]);

  const pendingTotal = useMemo(() => {
    if (!data) return 0;
    return POOLS.reduce((sum, p) => sum + (Number(data.pending_rewards[p.key]) || 0), 0);
  }, [data]);

  const isEmptyAccount = useMemo(
    () => data && totalHashrate === 0 && pendingTotal === 0 && Number(data.usdc_balance) === 0,
    [data, totalHashrate, pendingTotal]
  );

  const animated = useAnimatedPending(data?.pending_rewards || {});

  return (
    <div className="app">
      <header className="topbar">
        <h1 className="logo">Nexus Mining Engine</h1>
        <WalletAuth auth={auth} onAuthChange={handleAuthChange} />
      </header>

      <main className="container">
        {error && <div className="error-banner">{error}</div>}
        {(restoringSession || (loading && !data)) && <div className="loading">Loading wallet session…</div>}

        {!restoringSession && auth && (
          <nav className="app-nav" aria-label="Player dashboard">
            <button
              type="button"
              className={activeView === 'dashboard' ? 'active' : ''}
              aria-current={activeView === 'dashboard' ? 'page' : undefined}
              onClick={() => setActiveView('dashboard')}
            >
              Dashboard
            </button>
            <button
              type="button"
              className={activeView === 'connect' ? 'active' : ''}
              aria-current={activeView === 'connect' ? 'page' : undefined}
              onClick={() => setActiveView('connect')}
            >
              Connect
            </button>
          </nav>
        )}

        {!restoringSession && auth && activeView === 'connect' && <ConnectPanel auth={auth} />}

        {activeView === 'dashboard' && (
          <>

        {!restoringSession && !auth && !error && (
          <div className="empty-wallet-banner">
            Sign in with your browser wallet to view your account and authorize purchases, claims, and withdrawals.
            Nexus never asks for your recovery phrase.
          </div>
        )}

        {!restoringSession && auth && data && <GamePanel auth={auth} />}
        {!restoringSession && auth && data && isOperator && <OperatorMinersPanel auth={auth} />}
        {!restoringSession && auth && data && isOperator && <MarketPanel auth={auth} />}

        {data && (
          <>
            {auth && isEmptyAccount && (
              <div className="empty-wallet-banner">
                Account connected ✓ — your balance is 0.0000 USDC. Fund your account by sending{' '}
                <strong>USDC on the Base network</strong> to:
                <div className="deposit-address" title="Platform USDC deposit address (copy all)">
                  {data.deposit_address || 'Deposit address unavailable — contact support'}
                </div>
                <span className="fund-hint">
                  Balance updates within ~1 minute of the transfer. Then rent any miner to start earning.
                </span>
              </div>
            )}

            <SummaryRow
              balance={data.usdc_balance}
              totalHashrate={totalHashrate}
              pendingTotal={pendingTotal}
            />

            <GetStarted depositAddress={data.deposit_address} />

            <section className="mining-grid">
              {POOLS.map((pool) => (
                <MiningRoomCard
                  key={pool.key}
                  title={pool.title}
                  pool={pool.key}
                  rig={data.rigs[pool.key]}
                  pendingReward={animated[pool.key] || data.pending_rewards[pool.key] || 0}
                  rentCost={data.upgrade_cost?.[pool.key] ?? null}
                  renewCost={data.renew_cost?.[pool.key] ?? null}
                  onRent={() => rent(pool.key)}
                  onRenew={() => rent(pool.key, { renew: true })}
                  onClaim={claim}
                  onWithdraw={withdraw}
                  onReinvest={reinvest}
                  discountPct={data.multi_coin?.discount_pct ?? 0}
                  pendingDoge={data.pending_rewards_2?.[pool.key] ?? 0}
                  payoutStatus={data.payout_status?.[pool.key] ?? null}
                />
              ))}
            </section>

            {auth && <PayoutHistory payouts={data.payout_history || []} />}
          </>
        )}

        {!restoringSession && <AdminPanel refreshKey={dataVersion} />}
          </>
        )}
      </main>

      <footer className="footer">
        <p>Virtual cloud mining accounting layer. No native token. 5% protocol service fee.</p>
      </footer>
    </div>
  );
}
