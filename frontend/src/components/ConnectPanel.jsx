import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '';
const WINDOWS = [1, 3, 6, 12, 24, 48, 72];
const COINS = [
  {
    pool: 'KASPA', algo: 'kheavyhash', label: 'KAS', symbol: 'KAS', floor: 1,
    placeholder: 'kaspa:…', pattern: /^kaspa:[a-z0-9]{60,64}$/i,
  },
  {
    pool: 'ZCASH', algo: 'equihash', label: 'ZEC', symbol: 'ZEC', floor: 0.1,
    placeholder: 't1…', pattern: /^t1[a-zA-Z0-9]{33}$/,
  },
  {
    pool: 'BTC', algo: 'sha256', label: 'BTC', symbol: 'BTC', floor: 0.00065536,
    placeholder: 'bc1… or 1…',
    pattern: /^(bc1[ac-hj-np-z02-9]{11,71}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/i,
  },
];

async function responseBody(response, fallback) {
  let body;
  try {
    body = await response.json();
  } catch (_err) {
    const error = new Error(fallback);
    error.status = response.status;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(body?.error || fallback);
    error.status = response.status;
    throw error;
  }
  return body;
}

function money(value, digits = 2) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  return `$${amount.toFixed(digits)}`;
}

function coinAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '0';
  return amount.toFixed(8).replace(/0+$/, '').replace(/\.$/, '') || '0';
}

function statusLabel(status) {
  return String(status || '').replaceAll('_', ' ').toLowerCase()
    .replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
}

function windowsFor(rig) {
  const minimum = Number(rig?.min_hours || 0);
  const maximum = Math.min(Number(rig?.max_hours || 72), 72);
  return WINDOWS.filter((hours) => hours >= minimum && hours <= maximum);
}

function mineVsBuy(rig, symbol) {
  const arithmetic = rig?.profitability?.arithmetic;
  const mined = Number(arithmetic?.cost_per_coin?.[symbol]);
  const spot = Number(arithmetic?.spot_usd?.[symbol]);
  const ratio = Number(arithmetic?.mine_vs_buy?.[symbol]);
  if (!(mined > 0) || !(spot > 0)) return '—';
  return `Mine ${money(mined, 4)} · Buy ${money(spot, 4)}${Number.isFinite(ratio) ? ` · ${ratio.toFixed(1)}×` : ''}`;
}

export default function ConnectPanel({ auth }) {
  const [coinIndex, setCoinIndex] = useState(0);
  const [market, setMarket] = useState(null);
  const [orders, setOrders] = useState([]);
  const [selectedRigId, setSelectedRigId] = useState('');
  const [lengthHours, setLengthHours] = useState('');
  const [payoutAddress, setPayoutAddress] = useState('');
  const [quote, setQuote] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [quoting, setQuoting] = useState(false);
  const [ordering, setOrdering] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [lastUpdated, setLastUpdated] = useState('');
  const marketInFlight = useRef(false);
  const requestIdRef = useRef('');
  const coin = COINS[coinIndex];

  const headers = useMemo(() => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${auth.token}`,
  }), [auth.token]);

  const selectedRig = useMemo(
    () => (market?.rigs || []).find((rig) => String(rig.rig_id) === selectedRigId) || null,
    [market, selectedRigId]
  );
  const addressValid = coin.pattern.test(payoutAddress.trim());

  const loadMarket = useCallback(async ({ silent = false } = {}) => {
    if (marketInFlight.current) return;
    marketInFlight.current = true;
    if (silent) setRefreshing(true);
    else {
      setLoading(true);
      setError('');
    }
    try {
      const response = await fetch(
        `${API_BASE}/api/connect/market?algo=${encodeURIComponent(coin.algo)}`,
        { headers }
      );
      const body = await responseBody(response, 'Could not load available miners.');
      setMarket(body);
      setDisabled(false);
      setLastUpdated(new Date().toLocaleTimeString());
    } catch (err) {
      if (err.status === 503) {
        setDisabled(true);
        setMarket(null);
      } else if (!silent) {
        setError(err.message);
      }
    } finally {
      marketInFlight.current = false;
      setLoading(false);
      setRefreshing(false);
    }
  }, [coin.algo, headers]);

  const loadOrders = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/api/connect/orders`, { headers });
      const body = await responseBody(response, 'Could not load your connections.');
      setOrders(body.orders || []);
    } catch (err) {
      if (err.status !== 503) setError(err.message);
    }
  }, [headers]);

  useEffect(() => {
    setSelectedRigId('');
    setLengthHours('');
    setPayoutAddress('');
    setQuote(null);
    setDisabled(false);
    setMessage('');
    loadMarket();
  }, [coin.algo, loadMarket]);

  useEffect(() => {
    if (disabled) return undefined;
    loadOrders();
    const timer = window.setInterval(loadOrders, 15000);
    return () => window.clearInterval(timer);
  }, [disabled, loadOrders]);

  useEffect(() => {
    if (disabled) return undefined;
    const timer = window.setInterval(() => loadMarket({ silent: true }), 60000);
    return () => window.clearInterval(timer);
  }, [disabled, loadMarket]);

  useEffect(() => {
    if (!selectedRigId || !lengthHours) {
      setQuote(null);
      return undefined;
    }
    let cancelled = false;
    const loadQuote = async () => {
      setQuoting(true);
      setError('');
      try {
        const response = await fetch(`${API_BASE}/api/connect/quote`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            target_pool: coin.pool,
            rig_id: selectedRigId,
            length_hours: Number(lengthHours),
          }),
        });
        const body = await responseBody(response, 'Could not quote this miner.');
        if (!cancelled) setQuote(body);
      } catch (err) {
        if (!cancelled) {
          setQuote(null);
          setError(err.message);
        }
      } finally {
        if (!cancelled) setQuoting(false);
      }
    };
    loadQuote();
    return () => { cancelled = true; };
  }, [coin.pool, headers, lengthHours, selectedRigId]);

  const selectRig = (rig) => {
    const offered = windowsFor(rig);
    setSelectedRigId(String(rig.rig_id));
    setLengthHours(offered[0] ? String(offered[0]) : '');
    setQuote(null);
    setError('');
    setMessage('');
    requestIdRef.current = '';
  };

  const submitOrder = async () => {
    if (!quote || !addressValid || ordering) return;
    if (!requestIdRef.current) requestIdRef.current = crypto.randomUUID();
    setOrdering(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch(`${API_BASE}/api/connect/order`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          target_pool: coin.pool,
          payout_address: payoutAddress.trim(),
          rig_id: selectedRigId,
          length_hours: Number(lengthHours),
          request_id: requestIdRef.current,
        }),
      });
      const body = await responseBody(response, 'Could not connect this miner.');
      requestIdRef.current = '';
      setMessage(`Connection queued for ${body.order?.rig_name || selectedRig?.name || 'your miner'}.`);
      await loadOrders();
    } catch (err) {
      if (err.status >= 400 && err.status < 500) requestIdRef.current = '';
      setError(err.message);
      loadMarket({ silent: true });
    } finally {
      setOrdering(false);
    }
  };

  const quoteMath = quote?.rig?.profitability?.arithmetic;
  const perCoin = Number(quoteMath?.cost_per_coin?.[coin.symbol]);
  const spot = Number(quoteMath?.spot_usd?.[coin.symbol]);
  const ratio = Number(quoteMath?.mine_vs_buy?.[coin.symbol]);

  return (
    <section className="connect-panel" aria-labelledby="connect-title">
      <div className="connect-header">
        <div>
          <h2 id="connect-title">Connect My Miner</h2>
          <p>Choose a real miner and send pool payouts directly to your own wallet.</p>
        </div>
        <span className="connect-direct">Direct to wallet</span>
      </div>

      <div className="connect-tabs" role="tablist" aria-label="Payout coin">
        {COINS.map((item, index) => (
          <button
            key={item.pool}
            type="button"
            role="tab"
            aria-selected={coinIndex === index}
            className={coinIndex === index ? 'active' : ''}
            onClick={() => setCoinIndex(index)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {disabled ? (
        <div className="connect-notice">
          <strong>Connect is coming soon.</strong>
          <span>This feature is not enabled yet.</span>
          <button type="button" onClick={() => loadMarket()}>Check again</button>
        </div>
      ) : (
        <>
          <div className="connect-refresh">
            <span>{refreshing ? 'Refreshing…' : `Auto-refresh every 60s · data as of ${lastUpdated || '—'}`}</span>
            <button type="button" onClick={() => loadMarket({ silent: true })} disabled={refreshing}>
              ↻ Refresh
            </button>
          </div>

          {loading && <div className="connect-notice">Loading live miners and market prices…</div>}
          {error && <div className="connect-error" role="alert">{error}</div>}
          {message && <div className="connect-message" role="status">{message}</div>}

          {market && !loading && (
            <div className="connect-table-wrap">
              <table className="connect-table">
                <thead>
                  <tr>
                    <th>Rig</th><th>Hashrate</th><th>USD/hr</th><th>Net/day</th>
                    <th>Mine vs Buy</th><th>Break-even</th><th>Min</th><th>RPI</th>
                    <th>Region</th><th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {(market.rigs || []).map((rig) => (
                    <tr key={rig.rig_id} className={selectedRigId === String(rig.rig_id) ? 'selected' : ''}>
                      <td>{rig.name}</td>
                      <td>{rig.hashrate_nice || `${Number(rig.hashrate_ghs).toPrecision(4)} GH/s`}</td>
                      <td>{money(rig.usd_per_hour, 4)}</td>
                      <td className={Number(rig.profitability?.net_day) >= 0 ? 'connect-positive' : 'connect-negative'}>
                        {money(rig.profitability?.net_day)}
                      </td>
                      <td>{mineVsBuy(rig, coin.symbol)}</td>
                      <td>{money(rig.profitability?.break_even_price, 4)}</td>
                      <td>{rig.min_hours}h</td>
                      <td>{rig.rpi ?? '—'}</td>
                      <td>{rig.region || '—'}</td>
                      <td>
                        <button type="button" disabled={!rig.available} onClick={() => selectRig(rig)}>
                          {selectedRigId === String(rig.rig_id) ? 'Selected' : rig.available ? 'Select' : 'Unavailable'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {(market.rigs || []).length === 0 && (
                <div className="connect-notice">No eligible, available miners are currently listed.</div>
              )}
            </div>
          )}

          {selectedRig && (
            <div className="connect-checkout">
              <h3>Connect {selectedRig.name}</h3>
              <div className="connect-form-grid">
                <label>
                  Mining window
                  <select value={lengthHours} onChange={(event) => setLengthHours(event.target.value)}>
                    {windowsFor(selectedRig).map((hours) => <option key={hours} value={hours}>{hours} hours</option>)}
                  </select>
                </label>
                <label>
                  Your {coin.symbol} payout address
                  <input
                    value={payoutAddress}
                    onChange={(event) => setPayoutAddress(event.target.value)}
                    placeholder={coin.placeholder}
                    aria-invalid={Boolean(payoutAddress) && !addressValid}
                  />
                </label>
              </div>
              {payoutAddress && !addressValid && (
                <p className="connect-field-error">Enter a valid {coin.symbol} address.</p>
              )}
              {quoting && <p className="connect-muted">Refreshing your quote…</p>}
              {quote && (
                <div className="connect-quote">
                  <strong>
                    Rental {money(quote.rental_cost_usd)} + {Number(quote.fee_pct)}% connection fee {money(quote.fee_usd)} = {money(quote.total_usd)}
                  </strong>
                  {perCoin > 0 && spot > 0 && (
                    <span>
                      Mining 1 {coin.symbol} costs ~{money(perCoin, 4)} · buying costs {money(spot, 4)}
                      {Number.isFinite(ratio) ? ` — mining is ${ratio.toFixed(1)}× the buy price` : ''}
                    </span>
                  )}
                  <span>Nexus charges the USDC total once. The pool pays your address directly.</span>
                </div>
              )}
              <button
                className="connect-submit"
                type="button"
                onClick={submitOrder}
                disabled={!quote || !addressValid || ordering}
              >
                {ordering ? 'Connecting…' : 'Connect miner'}
              </button>
            </div>
          )}
        </>
      )}

      <div className="connect-orders">
        <h3>My connections</h3>
        {orders.length === 0 ? (
          <p className="connect-muted">No miner connections yet.</p>
        ) : (
          <ul>
            {orders.map((item) => {
              const details = COINS.find((entry) => entry.pool === item.target_pool);
              const isBtcPaid = item.target_pool === 'BTC' && item.paid_out_at;
              return (
                <li key={item.id}>
                  <div className="connect-order-main">
                    <strong>{item.rig_name}</strong>
                    <span className={`connect-status connect-status--${String(item.status || '').toLowerCase()}`}>
                      {statusLabel(item.status)}
                    </span>
                  </div>
                  <span>{item.length_hours}h · {item.target_pool}</span>
                  {item.rental_ends_at && <span>Ends {new Date(item.rental_ends_at).toLocaleString()}</span>}
                  <span>
                    {coinAmount(item.unpaid_last)} / {coinAmount(details?.floor)} {details?.symbol || item.target_pool}
                    {item.target_pool === 'BTC' ? ' address balance baseline' : ` · pays at ${coinAmount(details?.floor)} ${details?.symbol}`}
                  </span>
                  {item.paid_out_at && (
                    <strong className="connect-paid">
                      {isBtcPaid ? 'Address balance increased' : 'Pool payout observed'}
                    </strong>
                  )}
                  {item.failure_reason && <span className="connect-negative">{item.failure_reason}</span>}
                  {item.pool_stats_url && <a href={item.pool_stats_url} target="_blank" rel="noreferrer">Watch at the pool ↗</a>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
