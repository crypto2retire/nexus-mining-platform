import { useEffect, useMemo, useRef, useState } from 'react';
import MiningRoomCard from './components/MiningRoomCard';
import SummaryRow from './components/SummaryRow';
import LiveMinerPanel from './components/LiveMinerPanel';
import MiningOpportunities from './components/MiningOpportunities';

const API_BASE = import.meta.env.VITE_API_URL || '';
const STORAGE_KEY = 'nexus.wallet';
// Nexus accounts are Ethereum-style addresses only (MetaMask / Coinbase Wallet /
// Trust Wallet). Mining addresses (Monero, Zcash, Kaspa, Bitcoin) are NOT valid.
const VALID_WALLET_RE = /^0x[a-f0-9]{40}$/i;

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
  const [wallet, setWallet] = useState(() => localStorage.getItem(STORAGE_KEY) || '');
  const [connected, setConnected] = useState(false);
  const [minerStatus, setMinerStatus] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

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
      setConnected(true);
    } catch (err) {
      setConnected(false);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const connectWallet = async () => {
    setError('');
    const trimmed = wallet.trim();
    if (!VALID_WALLET_RE.test(trimmed)) {
      setError(
        "That address can't connect. Nexus accounts use an Ethereum-style wallet address — it starts with 0x followed by 40 letters/numbers (from MetaMask, Coinbase Wallet, or Trust Wallet). Mining addresses (Monero, Zcash, Kaspa, Bitcoin) are not supported for accounts."
      );
      setConnected(false);
      return;
    }
    const normalized = trimmed.toLowerCase();
    setWallet(normalized);
    localStorage.setItem(STORAGE_KEY, normalized);
    await fetchDashboard(normalized);
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
    if (wallet && VALID_WALLET_RE.test(wallet)) fetchDashboard(wallet);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
            className={`wallet-input${wallet && !VALID_WALLET_RE.test(wallet.trim()) ? ' invalid' : ''}`}
            value={wallet}
            onChange={(e) => {
              const v = e.target.value;
              setWallet(v);
              localStorage.setItem(STORAGE_KEY, v);
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') connectWallet(); }}
            placeholder="0x..."
            spellCheck={false}
          />
          <button className="btn-primary" onClick={connectWallet}>
            {connected ? 'Reconnect' : 'Connect Wallet'}
          </button>
          {connected && data && (
            <span className="connected-chip" title={wallet}>
              ✓ {wallet.slice(0, 6)}…{wallet.slice(-4)}
            </span>
          )}
        </div>
      </header>

      <main className="container">
        {error && <div className="error-banner">{error}</div>}
        {loading && !data && <div className="loading">Loading dashboard…</div>}

        {!wallet && !error && (
          <div className="empty-wallet-banner">
            Enter your Ethereum-style wallet address above (<strong>0x + 40 characters</strong> — from
            MetaMask, Coinbase Wallet, or Trust Wallet) and click <strong>Connect Wallet</strong> to
            create your account.
          </div>
        )}

        {data && (
          <>
            {connected && isEmptyAccount && (
              <div className="empty-wallet-banner">
                Account connected ✓ — your balance is 0.0000 USDC. Deposit USDC on the Base network to
                fund upgrades, then upgrade any mine to start earning.
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
