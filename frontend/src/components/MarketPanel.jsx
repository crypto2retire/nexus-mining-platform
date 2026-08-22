import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import RigList from './RigList';

const API_BASE = import.meta.env.VITE_API_URL || '';
const MAX_RENTAL_HOURS = 72;
const ALGOS = [
  { id: 'kheavyhash', label: 'KAS' },
  { id: 'scrypt', label: 'LTC + DOGE' },
  { id: 'equihash', label: 'ZEC' },
  { id: 'sha256', label: 'BTC' },
];

// Primary mined coin per algo tab — used by the Mine vs Buy detail stat.
const ALGO_COIN = { kheavyhash: 'KAS', scrypt: 'LTC', equihash: 'ZEC', sha256: 'BTC' };

async function responseBody(response, fallback) {
  let body;
  try {
    body = await response.json();
  } catch (_err) {
    throw new Error(fallback);
  }
  if (!response.ok) throw new Error(body?.error || fallback);
  return body;
}

function money(value, digits = 2) {
  if (value === null || value === undefined || value === '') return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  if (Math.abs(number) > 0 && Math.abs(number) < 0.01) return `$${number.toFixed(4)}`;
  return `$${number.toFixed(digits)}`;
}

function percent(value) {
  if (value === null || value === undefined || value === '') return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return `${number >= 0 ? '▲' : '▼'} ${Math.abs(number).toFixed(2)}%`;
}

function trendClass(value) {
  if (value === null || value === undefined || value === '') return '';
  return Number(value) >= 0 ? 'market-positive' : 'market-negative';
}

export default function MarketPanel({ auth }) {
  const [algo, setAlgo] = useState('kheavyhash');
  const [market, setMarket] = useState(null);
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [orderingRig, setOrderingRig] = useState('');
  const [lastUpdated, setLastUpdated] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const refreshInFlight = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => () => { mountedRef.current = false; }, []);

  const headers = useMemo(() => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${auth.token}`,
  }), [auth.token]);

  // Load the available rig list. silent=true keeps the current table on the
  // screen and only updates data (auto-refresh / manual refresh); non-silent
  // (algo switch / first load) blanks the table with the loading state.
  const loadMarket = useCallback(async ({ silent = false } = {}) => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    if (silent) {
      setRefreshing(true);
    } else {
      setLoading(true);
      setError('');
      setMessage('');
      setMarket(null);
    }
    try {
      const response = await fetch(`${API_BASE}/api/operator/market?algo=${encodeURIComponent(algo)}`, { headers });
      const body = await responseBody(response, 'Could not load the MRR market.');
      if (mountedRef.current) {
        setMarket(body);
        setLastUpdated(new Date().toLocaleTimeString());
      }
    } catch (err) {
      if (!silent && mountedRef.current) setError(err?.message || 'Could not load the MRR market.');
    } finally {
      refreshInFlight.current = false;
      if (mountedRef.current) {
        setRefreshing(false);
        setLoading(false);
      }
    }
  }, [algo, headers]);

  // Initial load + reload when algo or the auth token changes.
  useEffect(() => { loadMarket(); }, [loadMarket]);

  // AUTO-REFRESH: the MRR inventory is a live market — rigs get rented by
  // other miners constantly. Refresh silently every 60s so the list never
  // shows rigs that are no longer available.
  useEffect(() => {
    const timer = window.setInterval(() => loadMarket({ silent: true }), 60000);
    return () => window.clearInterval(timer);
  }, [loadMarket]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch(`${API_BASE}/api/operator/orders`, { headers });
        const body = await responseBody(response, 'Could not load operator orders.');
        if (!cancelled) setOrders(body.orders || []);
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Could not load operator orders.');
      }
    };
    poll();
    const timer = window.setInterval(poll, 10000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [headers]);

  const pendingRigIds = useMemo(() => new Set(
    orders
      .filter((order) => ['PENDING', 'PROCESSING'].includes(String(order.outbox_state || order.status).toUpperCase()))
      .map((order) => String(order.requested_rig_id))
  ), [orders]);

  const rentRig = async (rig) => {
    const maximum = Math.min(Number(rig.max_hours) || MAX_RENTAL_HOURS, MAX_RENTAL_HOURS);
    const raw = window.prompt(
      `Rental length in whole hours (${rig.min_hours}–${maximum}). MRR will charge its BTC balance directly.`,
      String(rig.min_hours)
    );
    if (raw === null) return;
    const length = Number(raw);
    if (!Number.isInteger(length) || length < rig.min_hours || length > maximum) {
      setError(`Enter a whole number from ${rig.min_hours} through ${maximum} hours.`);
      return;
    }
    const estimated = Number(rig.usd_per_hour) * length;
    if (!window.confirm(`Rent “${rig.name}” for ${length} hours? Estimated market cost: ${money(estimated)}. MRR charges BTC directly.`)) return;

    setOrderingRig(rig.rig_id);
    setError('');
    setMessage('');
    try {
      const response = await fetch(`${API_BASE}/api/operator/order`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ rig_id: rig.rig_id, algo, length_hours: length }),
      });
      const body = await responseBody(response, 'Could not place the MRR order.');
      setMessage(`Order placed (pending): ${body.order_id}`);
      await fetchOrders();
    } catch (err) {
      setError(err?.message || 'Could not place the MRR order.');
      // The rig may have been rented by someone else — refresh the list now
      // so the unavailable row disappears immediately.
      loadMarket({ silent: true });
    } finally {
      setOrderingRig('');
    }
  };

  const fetchOrders = async () => {
    const response = await fetch(`${API_BASE}/api/operator/orders`, { headers });
    const body = await responseBody(response, 'Could not load operator orders.');
    setOrders(body.orders || []);
  };

  const renderRentButton = (rig) => {
    const pending = pendingRigIds.has(String(rig.rig_id));
    return (
      <button
        className="rig-action"
        type="button"
        disabled={!rig.available || pending || orderingRig === rig.rig_id || !rig.pool_profile_id}
        onClick={() => rentRig(rig)}
      >
        {pending ? 'Pending' : orderingRig === rig.rig_id ? 'Queuing…' : rig.available ? 'Rent' : 'Unavailable'}
      </button>
    );
  };

  const renderRentDetail = (rig) => {
    const pending = pendingRigIds.has(String(rig.rig_id));
    return (
      <button
        className="rig-detail-cta"
        type="button"
        disabled={!rig.available || pending || orderingRig === rig.rig_id || !rig.pool_profile_id}
        onClick={() => rentRig(rig)}
      >
        {pending ? 'Order pending…' : orderingRig === rig.rig_id ? 'Queuing…' : rig.available ? 'Rent this miner' : 'Currently unavailable'}
      </button>
    );
  };

  return (
    <section className="market-panel" aria-labelledby="market-panel-title">
      <div className="market-panel__header">
        <div>
          <h2 id="market-panel-title">Mining Market</h2>
          <p>Live MRR inventory, delivery-adjusted P/L, and BTC-funded operator ordering. Best estimated return is listed first — profit green, loss red, details on click.</p>
        </div>
        <span className="market-panel__operator">Operator only</span>
      </div>

      <div className="market-tabs" role="tablist" aria-label="Mining algorithm">
        {ALGOS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={algo === item.id}
            className={algo === item.id ? 'active' : ''}
            onClick={() => setAlgo(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="market-refresh">
        <span className="market-refresh__note">
          {refreshing ? 'Refreshing…' : `Auto-refresh every 60s · data as of ${lastUpdated || '—'}`}
        </span>
        <button
          type="button"
          className="market-refresh__btn"
          onClick={() => loadMarket({ silent: true })}
          disabled={refreshing}
        >
          ↻ Refresh
        </button>
      </div>

      {loading && <div className="market-panel__notice">Loading live MRR prices and coin markets…</div>}
      {error && <div className="market-panel__error" role="alert">{error}</div>}
      {message && <div className="market-panel__message" role="status">{message}</div>}

      {market && !loading && (
        <>
          <div className="market-trends" aria-label="Current token prices">
            {(market.price_trend || []).map((trend) => (
              <div key={trend.coin} className="market-trend">
                <strong>{trend.coin} {money(trend.price, 4)}</strong>
                <span className={trendClass(trend.chg_24h)}>24h {percent(trend.chg_24h)}</span>
                <span className={trendClass(trend.chg_7d)}>7d {percent(trend.chg_7d)}</span>
              </div>
            ))}
          </div>

          <div className="market-summary">
            <div className="stat"><span className="stat-label">Available rigs</span><span className="stat-value">{market.market_stats?.available_rigs ?? '—'}</span></div>
            <div className="stat"><span className="stat-label">Available hash</span><span className="stat-value">{market.market_stats?.available_hash_nice || '—'}</span></div>
            <div className="stat"><span className="stat-label">Lowest cost</span><span className="stat-value">{money(market.market_stats?.lowest_usd_per_ghs_day, 4)}/GH·day</span></div>
            <div className="stat"><span className="stat-label">Last 10</span><span className="stat-value">{money(market.market_stats?.last_10_usd_per_ghs_day, 4)}/GH·day</span></div>
          </div>

          <RigList
            rigs={market.rigs || []}
            bestValue={market.best_value}
            algo={algo}
            primaryCoin={ALGO_COIN[algo]}
            renderAction={renderRentButton}
            detailActions={renderRentDetail}
          />

          {orders.length > 0 && (
            <div className="market-orders">
              <h3>Recent operator orders</h3>
              <ul>
                {orders.slice(0, 8).map((order) => (
                  <li key={order.order_id}>
                    <code>{order.order_id}</code> · rig {order.requested_rig_id} · {order.requested_length_hours}h · <strong>{order.outbox_state || order.status}</strong>
                    {order.failure_reason ? ` — ${order.failure_reason}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}
