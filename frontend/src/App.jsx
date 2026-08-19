import { useEffect, useMemo, useRef, useState } from 'react';
import MiningRoomCard from './components/MiningRoomCard';
import SummaryRow from './components/SummaryRow';
import LiveMinerPanel from './components/LiveMinerPanel';
import MiningOpportunities from './components/MiningOpportunities';

const API_BASE = import.meta.env.VITE_API_URL || '';
const DEFAULT_WALLET = '0x0000000000000000000000000000000000000001';
const STORAGE_KEY = 'nexus.wallet';

const POOLS = [
  { key: 'ZCASH', title: 'Zcash (ZEC) Mine' },
  { key: 'KASPA', title: 'Kaspa (KAS) Mine' },
  { key: 'LTC_DOGE', title: 'Litecoin / Dogecoin Merge' },
  { key: 'XMR', title: 'Monero (XMR) Mine' },
];

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
  const [wallet, setWallet] = useState(() => localStorage.getItem(STORAGE_KEY) || DEFAULT_WALLET);
  const [minerStatus, setMinerStatus] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const fetchDashboard = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/api/dashboard?wallet=${encodeURIComponent(wallet)}`);
      if (!res.ok) throw new Error(await res.text());
      setData(await res.json());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const upgrade = async (pool) => {
    try {
      setError('');
      // Idempotency key: prevents double-click / network retry from placing two orders.
      const requestId = crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const res = await fetch(`${API_BASE}/api/rigs/upgrade`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet, target_pool: pool, request_id: requestId }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Upgrade failed');

      const sandboxTag = result.sandbox ? ' [SANDBOX]' : '';
      const marketplaceTag = result.marketplace ? `\nMarketplace: ${result.marketplace}` : '';
      const summary = result.btc_spent
        ? `\n\nBTC spent: ${result.btc_spent}\nOrder ID: ${result.nicehash_order_id || 'n/a'}\nStatus: ${result.order_status || 'n/a'}${marketplaceTag}${sandboxTag}`
        : '';
      alert(`🎉 Upgrade successful! ${result.level} → hashrate ${result.hashrate} GH/s${summary}`);
      await fetchDashboard();
    } catch (err) {
      setError(err.message);
    }
  };

  useEffect(() => {
    fetchDashboard();
  }, []);

  // Track the miner's current pool so the opportunities panel can mark ACTIVE.
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/miner/status`);
        if (!res.ok) return;
        const d = await res.json();
        if (!cancelled) setMinerStatus(d);
      } catch { /* miner monitor offline — keep last known */ }
    };
    poll();
    const id = setInterval(poll, 15000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const totalHashrate = useMemo(() => {
    if (!data) return 0;
    return POOLS.reduce((sum, p) => sum + (Number(data.rigs[p.key]?.virtual_hashrate) || 0), 0);
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
        <div className="wallet-bar">
          <input
            className="wallet-input"
            value={wallet}
            onChange={(e) => {
              const v = e.target.value;
              setWallet(v);
              localStorage.setItem(STORAGE_KEY, v);
            }}
            placeholder="0x..."
          />
          <button className="btn-primary" onClick={fetchDashboard}>
            Connect Wallet
          </button>
        </div>
      </header>

      <main className="container">
        {error && <div className="error-banner">{error}</div>}
        {loading && !data && <div className="loading">Loading dashboard…</div>}

        {data && (
          <>
            {isEmptyAccount && (
              <div className="empty-wallet-banner">
                This wallet has no mining account yet. Enter your wallet address in the box
                above, then click <strong>Connect Wallet</strong> to create one.
              </div>
            )}

            <SummaryRow
              balance={data.usdc_balance}
              totalHashrate={totalHashrate}
              pendingTotal={pendingTotal}
            />

            <LiveMinerPanel />
            <MiningOpportunities currentPool={minerStatus?.pool} />

            <section className="mining-grid">
              {POOLS.map((pool) => (
                <MiningRoomCard
                  key={pool.key}
                  title={pool.title}
                  pool={pool.key}
                  rig={data.rigs[pool.key]}
                  pendingReward={animated[pool.key] || data.pending_rewards[pool.key] || 0}
                  onUpgrade={upgrade}
                />
              ))}
            </section>
          </>
        )}
      </main>

      <footer className="footer">
        <p>Virtual cloud mining accounting layer. No native token. 5% protocol service fee.</p>
      </footer>
    </div>
  );
}
