import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '';
const MAX_RENTAL_HOURS = 72;
const ALGOS = [
  { id: 'kheavyhash', label: 'KAS' },
  { id: 'scrypt', label: 'LTC + DOGE' },
  { id: 'equihash', label: 'ZEC' },
  { id: 'sha256', label: 'BTC' },
];

// Primary mined coin per algo tab — used by the Mine vs Buy column.
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

function signedMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return `${number >= 0 ? '+' : '-'}${money(Math.abs(number))}`;
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

function arithmeticText(rig) {
  const math = rig?.profitability?.arithmetic;
  if (!math) return '';
  const production = Object.entries(math.production_day || {})
    .map(([coin, amount]) => `${Number(amount).toPrecision(6)} ${coin}/day × ${money(math.spot_usd?.[coin], 4)}`)
    .join(' + ');
  return `${Number(math.hashrate_ghs).toPrecision(6)} GH/s ÷ ${Number(math.anchor_ghs).toPrecision(6)} GH/s anchor → ${production} = ${money(math.revenue_day)}/day revenue − ${money(math.cost_day)}/day cost = ${signedMoney(math.net_day)}/day.`;
}

export default function MarketPanel({ auth }) {
  const [algo, setAlgo] = useState('kheavyhash');
  const [market, setMarket] = useState(null);
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [orderingRig, setOrderingRig] = useState('');
  const [expanded, setExpanded] = useState('');
  const [sortKey, setSortKey] = useState('net_day');
  const [sortDir, setSortDir] = useState('desc');
  const [lastUpdated, setLastUpdated] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const refreshInFlight = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => () => { mountedRef.current = false; }, []);

  const headers = useMemo(() => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${auth.token}`,
  }), [auth.token]);

  // Column definitions: key -> { label, accessor, defaultDir }
  const COLUMNS = useMemo(() => ({
    name: { label: 'Rig', accessor: (r) => String(r.name || '').toLowerCase(), defaultDir: 'asc' },
    hashrate: { label: 'Hashrate', accessor: (r) => Number(r.hashrate_ghs) || 0, defaultDir: 'desc' },
    usd_per_hour: { label: 'USD/hr', accessor: (r) => Number(r.usd_per_hour) || 0, defaultDir: 'asc' },
    usd_per_day: { label: 'Cost/day', accessor: (r) => Number(r.usd_per_day) || 0, defaultDir: 'asc' },
    usd_min_rental: { label: 'Min rent', accessor: (r) => Number(r.usd_min_rental) || 0, defaultDir: 'asc' },
    net_day: { label: 'Net/day', accessor: (r) => Number(r.profitability?.net_day) || 0, defaultDir: 'desc' },
    mine_vs_buy: {
      label: 'Mine vs Buy',
      accessor: (r) => {
        const m = r.profitability?.arithmetic;
        if (algo === 'scrypt' || !m) return Number(m?.cost_per_dollar_mined) || Number.POSITIVE_INFINITY;
        return Number(m?.mine_vs_buy?.[ALGO_COIN[algo]]) || Number.POSITIVE_INFINITY;
      },
      defaultDir: 'asc',
    },
    break_even: { label: 'Break-even', accessor: (r) => {
        const v = Number(r.profitability?.break_even_price);
        return Number.isFinite(v) && v > 0 ? v : Number.POSITIVE_INFINITY;
      }, defaultDir: 'asc' },
    min_hours: { label: 'Min', accessor: (r) => Number(r.min_hours) || 0, defaultDir: 'asc' },
    rpi: { label: 'RPI', accessor: (r) => Number(r.rpi) || 0, defaultDir: 'desc' },
    region: { label: 'Region', accessor: (r) => String(r.region || '').toLowerCase(), defaultDir: 'asc' },
  }), [algo]);

  const sortedRigs = useMemo(() => {
    const col = COLUMNS[sortKey] || COLUMNS.net_day;
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...(market?.rigs || [])].sort((a, b) => {
      const va = col.accessor(a);
      const vb = col.accessor(b);
      if (va === vb) return String(a.rig_id).localeCompare(String(b.rig_id));
      if (typeof va === 'string' || typeof vb === 'string') return String(va).localeCompare(String(vb)) * dir;
      return (va - vb) * dir;
    });
  }, [market, sortKey, sortDir]);

  const requestSort = (key) => {
    if (sortKey === key) {
      setSortDir((current) => (current === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(COLUMNS[key]?.defaultDir || 'asc');
    }
  };

  const fetchOrders = async () => {
    const response = await fetch(`${API_BASE}/api/operator/orders`, { headers });
    const body = await responseBody(response, 'Could not load operator orders.');
    setOrders(body.orders || []);
  };

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

  const renderMineVsBuy = (rig) => {
    const m = rig.profitability?.arithmetic;
    if (!m) return '—';
    if (algo === 'scrypt') {
      // Merged LTC+DOGE: per-coin cost alone would overstate, so show the
      // universal ratio — dollars of rental spent per $1 of mined value.
      const spend = Number(m.cost_per_dollar_mined);
      if (!Number.isFinite(spend) || spend <= 0) return '—';
      return (
        <span className={`mine-vs-buy ${spend < 1 ? 'mine-vs-buy--good' : 'mine-vs-buy--bad'}`}>
          Spend {money(spend)} / $1 mined
        </span>
      );
    }
    const coin = ALGO_COIN[algo];
    const perCoin = Number(m.cost_per_coin?.[coin]);
    const spot = Number(m.spot_usd?.[coin]);
    const ratio = Number(m.mine_vs_buy?.[coin]);
    if (!Number.isFinite(perCoin) || perCoin <= 0 || !Number.isFinite(spot) || spot <= 0) return '—';
    return (
      <span className={`mine-vs-buy ${Number.isFinite(ratio) && ratio < 1 ? 'mine-vs-buy--good' : 'mine-vs-buy--bad'}`}>
        Mine {money(perCoin, 4)} · Buy {money(spot, 4)}
        {Number.isFinite(ratio) ? ` · ${ratio.toFixed(1)}×` : ''}
      </span>
    );
  };

  return (
    <section className="market-panel" aria-labelledby="market-panel-title">
      <div className="market-panel__header">
        <div>
          <h2 id="market-panel-title">Mining Market</h2>
          <p>Live MRR inventory, delivery-adjusted P/L, and BTC-funded operator ordering.</p>
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
            <div className="stat"><span className="stat-label">Sort</span><span className="stat-value">{COLUMNS[sortKey]?.label} {sortDir === 'asc' ? '▲' : '▼'}</span></div>
          </div>

          {market.best_value ? (
            <div className="market-best">⭐ Best value: <strong>{market.best_value.name}</strong> — {market.best_value.reason}</div>
          ) : (
            <div className="market-panel__notice">No eligible, available MRR rig is currently listed.</div>
          )}

          <div className="market-table-wrap">
            <table className="market-table">
              <thead>
                <tr>
                  {Object.entries(COLUMNS).map(([key, col]) => (
                    <th key={key} aria-sort={sortKey === key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                      <button type="button" className="market-sort" onClick={() => requestSort(key)}>
                        {col.label} {sortKey === key ? (sortDir === 'asc' ? '▲' : '▼') : ''}
                      </button>
                    </th>
                  ))}
                  <th>Ext.</th><th>Action</th>
                </tr>
              </thead>
              <tbody>
                {sortedRigs.map((rig) => {
                  const pending = pendingRigIds.has(String(rig.rig_id));
                  const open = expanded === rig.rig_id;
                  const net = Number(rig.profitability?.net_day);
                  return [
                    <tr key={rig.rig_id}>
                      <td>
                        <button className="market-rig-name" type="button" aria-expanded={open} onClick={() => setExpanded(open ? '' : rig.rig_id)}>
                          {open ? '▾' : '▸'} {rig.name}
                        </button>
                      </td>
                      <td>{rig.hashrate_nice || `${Number(rig.hashrate_ghs).toPrecision(4)} GH/s`}</td>
                      <td>{money(rig.usd_per_hour, 4)}</td>
                      <td>{money(rig.usd_per_day)}</td>
                      <td>{money(rig.usd_min_rental, 4)}</td>
                      <td className={net >= 0 ? 'market-positive' : 'market-negative'}>{signedMoney(net)}</td>
                      <td>{renderMineVsBuy(rig)}</td>
                      <td>{money(rig.profitability?.break_even_price, 4)}</td>
                      <td>{rig.min_hours}h</td>
                      <td>{rig.rpi ?? '—'}</td>
                      <td>{rig.region || '—'}</td>
                      <td>{rig.extensions ? 'Yes' : 'No'}</td>
                      <td>
                        <button
                          className="btn-primary market-rent"
                          type="button"
                          disabled={!rig.available || pending || orderingRig === rig.rig_id || !rig.pool_profile_id}
                          onClick={() => rentRig(rig)}
                        >
                          {pending ? 'Pending' : orderingRig === rig.rig_id ? 'Queuing…' : rig.available ? 'Rent' : 'Unavailable'}
                        </button>
                      </td>
                    </tr>,
                    open && (
                      <tr className="market-scenarios" key={`${rig.rig_id}-scenarios`}>
                        <td colSpan="13">
                          <p>{arithmeticText(rig)}</p>
                          <div className="market-scenario-grid">
                            <span>−25% <strong>{signedMoney(rig.profitability.net_minus25)}</strong></span>
                            <span>−10% <strong>{signedMoney(rig.profitability.net_minus10)}</strong></span>
                            <span>Current <strong>{signedMoney(rig.profitability.net_current)}</strong></span>
                            <span>+10% <strong>{signedMoney(rig.profitability.net_plus10)}</strong></span>
                            <span>+25% <strong>{signedMoney(rig.profitability.net_plus25)}</strong></span>
                          </div>
                          <table className="market-lengths">
                            <thead><tr><th>Hours</th><th>Cost</th><th>Expected value</th><th>Net</th></tr></thead>
                            <tbody>
                              {(rig.profitability.lengths || []).map((row) => (
                                <tr key={row.length_hours}>
                                  <td>{row.length_hours}</td><td>{money(row.total_cost)}</td>
                                  <td>{money(row.expected_value)}</td>
                                  <td className={Number(row.net) >= 0 ? 'market-positive' : 'market-negative'}>{signedMoney(row.net)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    ),
                  ];
                })}
              </tbody>
            </table>
          </div>

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
