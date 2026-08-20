import { useEffect, useMemo, useRef, useState } from 'react';
import MiningRoomCard from './components/MiningRoomCard';
import SummaryRow from './components/SummaryRow';
import GetStarted from './components/GetStarted';
import AdminPanel from './components/AdminPanel';

const API_BASE = import.meta.env.VITE_API_URL || '';
const STORAGE_KEY = 'nexus.wallet';
// Nexus accounts are Ethereum-style addresses only (MetaMask / Coinbase Wallet /
// Trust Wallet). Mining addresses (Zcash, Kaspa, Bitcoin) are NOT valid.
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

  // RENT: pay USDC (or reinvested tokens) to rent hashrate for a 72h window.
  // `renew=true` re-rents the current tier; otherwise rents the next tier.
  const rent = async (pool, { renew = false } = {}) => {
    try {
      setError('');
      // Idempotency key: prevents double-click / network retry from placing two orders.
      const requestId = crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const res = await fetch(`${API_BASE}/api/rigs/upgrade`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet, target_pool: pool, request_id: requestId, renew }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Rent failed');

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
          ? `🔄 Rental renewed! ${result.level} tier → ${result.hashrate} GH/s for ${result.rig_hours || 72}h${expires}${summary}`
          : `🎉 Rented! ${result.level} tier → ${result.hashrate} GH/s for ${result.rig_hours || 72}h${expires}${summary}`
      );
      await fetchDashboard();
    } catch (err) {
      setError(err.message);
    }
  };

  // BUY SESSION: a short hashrate slice (1h-24h, 25 GH/s slot) drawn from the
  // room's SPARE real capacity — no new marketplace rental, the rig is already
  // running. Higher markup = shorter session. Idempotent like rent.
  const buySession = async (pool, hours) => {
    try {
      setError('');
      const requestId = crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const res = await fetch(`${API_BASE}/api/rigs/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet, target_pool: pool, request_id: requestId, hours, ghs: 25 }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Session purchase failed');
      alert(
        `⏱ Session rented! ${result.ghs} GH/s for ${result.hours}h — $${Number(result.price).toFixed(2)}\n` +
          `Window: until ${new Date(result.rental_expires_at).toLocaleString()}\n` +
          `Room spare left: ${Number(result.room_spare_ghs ?? 0).toFixed(1)} GH/s`
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet, target_pool: pool, request_id: requestId }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Reinvest failed');

      const sandboxTag = result.sandbox ? ' [SANDBOX]' : '';
      const marketplaceTag = result.marketplace ? `\nMarketplace: ${result.marketplace}` : '';
      const summary = result.btc_spent
        ? `\n\nBTC spent: ${result.btc_spent}\nOrder ID: ${result.nicehash_order_id || 'n/a'}\nStatus: ${result.order_status || 'n/a'}${marketplaceTag}${sandboxTag}`
        : '';
      alert(
        `🔄 Reinvested ${Number(result.reinvested_usdc || 0).toFixed(2)} USDC of mined tokens — ` +
        `rented tier ${result.level} (${result.hashrate} GH/s) for ${result.rig_hours || 72}h${summary}`
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet, target_pool: pool }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Claim failed');
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
      const coinName = pool === 'ZCASH' ? 'ZEC' : pool === 'KASPA' ? 'KAS (Kaspa)' : pool === 'LTC_DOGE' ? 'LTC' : 'XMR';
      const example =
        pool === 'ZCASH' ? 't1...' : pool === 'KASPA' ? 'kaspa:...' : pool === 'LTC_DOGE' ? 'ltc1...' : '4...';
      const amount = window.prompt(`Withdraw ${coinName} — how much? (available: ${Number(data.pending_rewards[pool] || 0).toFixed(8)})`, '');
      if (!amount) return;
      const toAddress = window.prompt(`Send ${coinName} to which address? (${example})`, '');
      if (!toAddress) return;
      const res = await fetch(`${API_BASE}/api/rewards/withdraw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet, target_pool: pool, amount_coin: Number(amount), to_address: toAddress }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Withdrawal request failed');
      alert(`📤 Withdrawal requested: ${result.amount_coin} ${result.target_pool} to ${result.to_address}\nThe platform operator will send it and mark it PAID.`);
      await fetchDashboard();
    } catch (err) {
      setError(err.message);
    }
  };

  useEffect(() => {
    if (wallet && VALID_WALLET_RE.test(wallet)) fetchDashboard(wallet);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
                Account connected ✓ — your balance is 0.0000 USDC. Fund your account by sending{' '}
                <strong>USDC on the Base network</strong> to:
                <div className="deposit-address" title="Platform USDC deposit address (copy all)">
                  {data.deposit_address || 'Deposit address unavailable — contact support'}
                </div>
                <span className="fund-hint">
                  Balance updates within ~1 minute of the transfer. Then upgrade any mine to start earning.
                </span>
              </div>
            )}

            <SummaryRow
              balance={data.usdc_balance}
              totalHashrate={totalHashrate}
              pendingTotal={pendingTotal}
            />

            <GetStarted depositAddress={data.deposit_address} />

            {data.is_admin && <AdminPanel wallet={wallet} />}

            <section className="mining-grid">
              {POOLS.map((pool) => (
                <MiningRoomCard
                  key={pool.key}
                  title={pool.title}
                  pool={pool.key}
                  rig={data.rigs[pool.key]}
                  pendingReward={animated[pool.key] || data.pending_rewards[pool.key] || 0}
                  upgradeCost={data.upgrade_cost?.[pool.key] ?? null}
                  renewCost={data.renew_cost?.[pool.key] ?? null}
                  onUpgrade={() => rent(pool.key)}
                  onRenew={() => rent(pool.key, { renew: true })}
                  onClaim={claim}
                  onWithdraw={withdraw}
                  onReinvest={reinvest}
                  discountPct={data.multi_coin?.discount_pct ?? 0}
                  pendingDoge={data.pending_rewards_2?.[pool.key] ?? 0}
                  realBacking={data.backing?.[pool.key] ?? null}
                  payoutStatus={data.payout_status?.[pool.key] ?? null}
                  sessionPrices={data.session_prices?.[pool.key] ?? null}
                  spareGhs={data.spare_ghs?.[pool.key] ?? null}
                  onBuySession={(hours) => buySession(pool.key, hours)}
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
