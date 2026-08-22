import { useMemo, useState } from 'react';

// Shared "Available Miners" list — newbie-first, expert details on expand.
//
// Design (Kevin 2026-08-22): the main list shows only 4 plain-language columns
// (Miner, Cost/day, Est. mined value/day, Est. profit/day as a PROFIT/LOSS
// badge). The best estimated return is always first (default sort net_day
// desc) with a ⭐ banner naming it — and when the whole market is at a loss the
// banner switches to an honest "least-bad pick" state. Clicking a row expands
// the advanced stats (mine vs buy, break-even, RPI, region, price-move
// scenarios, rental windows) for experienced users. Every figure is labeled an
// estimate — estimates are scaled from pool-measured production anchors at
// current prices (anchor-recalibration rule: no profitability display reaches
// users unverified or without the estimate label).

const PROFIT_EPS = 0.0005;

function money(value, digits = 2) {
  if (value === null || value === undefined || value === '') return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  if (Math.abs(number) > 0 && Math.abs(number) < 0.01) return `$${number.toFixed(4)}`;
  return `$${number.toFixed(digits)}`;
}

function signed(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return `${number >= 0 ? '+' : '−'}${money(Math.abs(number))}`;
}

function signedPrecise(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return `${number >= 0 ? '+' : '−'}${money(Math.abs(number), 4)}`;
}

function netClass(value) {
  return Number(value) >= 0 ? 'rig-positive' : 'rig-negative';
}

function badgeFor(net) {
  if (net > PROFIT_EPS) return 'profit';
  if (net < -PROFIT_EPS) return 'loss';
  return 'flat';
}

export default function RigList({
  rigs = [],
  bestValue = null,
  algo = '',
  primaryCoin = '',
  selectedId = '',
  renderAction = null,
  detailActions = null,
  emptyMessage = 'No eligible, available miners are currently listed.',
}) {
  const [filter, setFilter] = useState('all');
  const [expandedId, setExpandedId] = useState('');
  const [sortKey, setSortKey] = useState('net_day');
  const [sortDir, setSortDir] = useState('desc');

  const merged = algo === 'scrypt';

  const sorted = useMemo(() => {
    const accessors = {
      name: (r) => String(r.name || '').toLowerCase(),
      cost_day: (r) => Number(r.usd_per_day) || 0,
      mined_day: (r) => Number(r.profitability?.revenue_day) || 0,
      net_day: (r) => Number(r.profitability?.net_day) || 0,
    };
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...rigs].sort((a, b) => {
      const va = accessors[sortKey](a);
      const vb = accessors[sortKey](b);
      if (va === vb) return String(a.rig_id).localeCompare(String(b.rig_id));
      if (typeof va === 'string' || typeof vb === 'string') return String(va).localeCompare(String(vb)) * dir;
      return (va - vb) * dir;
    });
  }, [rigs, sortKey, sortDir]);

  const counts = useMemo(() => {
    let profit = 0;
    let loss = 0;
    for (const rig of rigs) {
      const net = Number(rig.profitability?.net_day);
      if (net > PROFIT_EPS) profit += 1;
      else if (net < -PROFIT_EPS) loss += 1;
    }
    return { profit, loss, flat: rigs.length - profit - loss };
  }, [rigs]);

  const visible = useMemo(() => {
    if (filter === 'profit') return sorted.filter((r) => Number(r.profitability?.net_day) > PROFIT_EPS);
    if (filter === 'loss') return sorted.filter((r) => Number(r.profitability?.net_day) < -PROFIT_EPS);
    return sorted;
  }, [sorted, filter]);

  const requestSort = (key) => {
    if (sortKey === key) {
      setSortDir((current) => (current === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'name' ? 'asc' : 'desc');
    }
  };

  const toggle = (rigId) => setExpandedId((current) => (current === rigId ? '' : rigId));

  const bestNet = Number(bestValue?.net_day);
  const bestIsProfit = Number.isFinite(bestNet) && bestNet > PROFIT_EPS;

  // Plain-language one-liner for the expanded row.
  const explainer = (rig) => {
    const cost = money(rig.usd_per_day);
    const mined = money(rig.profitability?.revenue_day);
    const net = Number(rig.profitability?.net_day);
    const word = net >= 0 ? 'profit' : 'loss';
    const coinNote = merged ? ' of value (LTC + DOGE combined)' : ' of value';
    const rpi = String(rig.rpi ?? '').trim();
    const caveat = /^new$/i.test(rpi)
      ? 'This miner is new on the market, so there is no track record yet — the estimate could be off.'
      : `Rated ${rpi} on the market trust index.`;
    return (
      <>
        Rents for {cost}/day. At current prices this miner is estimated to mine about {mined}/day{coinNote},
        so the estimated result is roughly <b className={net >= 0 ? 'rig-positive' : 'rig-negative'}>{signed(net)}/day {word}</b>. {caveat}
      </>
    );
  };

  // "1.20 KAS/day × $0.0296" production breakdown from the anchor arithmetic.
  const productionNote = (rig) => {
    const arithmetic = rig.profitability?.arithmetic;
    if (!arithmetic) return '';
    return Object.entries(arithmetic.production_day || {})
      .map(([coin, amount]) => `${Number(amount).toPrecision(6)} ${coin}/day × ${money(arithmetic.spot_usd?.[coin], 4)}`)
      .join(' + ');
  };

  const mineVsBuyCell = (rig) => {
    const m = rig.profitability?.arithmetic;
    if (!m) return null;
    if (merged) {
      const spend = Number(m.cost_per_dollar_mined);
      if (!Number.isFinite(spend) || spend <= 0) return null;
      return {
        value: `Spend ${money(spend)} / $1 mined`,
        note: spend < 1 ? 'every $1 of mined value costs less than $1 to rent' : 'each $1 of mined value costs more than $1 to rent',
        good: spend < 1,
      };
    }
    const coin = primaryCoin;
    const perCoin = Number(m.cost_per_coin?.[coin]);
    const spot = Number(m.spot_usd?.[coin]);
    const ratio = Number(m.mine_vs_buy?.[coin]);
    if (!Number.isFinite(perCoin) || perCoin <= 0 || !Number.isFinite(spot) || spot <= 0) return null;
    return {
      value: `Mine ${money(perCoin, 4)} · Buy ${money(spot, 4)}${Number.isFinite(ratio) ? ` · ${ratio.toFixed(1)}×` : ''}`,
      note: Number.isFinite(ratio) && ratio < 1 ? 'mining is cheaper than buying today' : 'buying is cheaper than mining today',
      good: Number.isFinite(ratio) && ratio < 1,
    };
  };

  const rpiCell = (rig) => {
    const rpi = String(rig.rpi ?? '').trim();
    if (!rpi || rpi === '—') return { value: '—', note: 'no rating available' };
    if (/^new$/i.test(rpi)) return { value: 'New — no track record', note: 'marketplace reliability index' };
    return { value: `${Number(rpi).toFixed(1)} / 100`, note: 'marketplace reliability index' };
  };

  const renderBadge = (net) => {
    const kind = badgeFor(net);
    if (kind === 'flat') {
      return <span className="rig-badge rig-badge--flat">≈ BREAK-EVEN<span className="rig-badge-note">est. / day</span></span>;
    }
    return (
      <span className={`rig-badge rig-badge--${kind}`}>
        {kind === 'profit' ? 'PROFIT' : 'LOSS'} {signed(net)}
        <span className="rig-badge-note">est. / day</span>
      </span>
    );
  };

  const renderDetail = (rig) => {
    const m = rig.profitability?.arithmetic;
    const rpi = rpiCell(rig);
    const mvb = mineVsBuyCell(rig);
    const scenarios = [
      { label: '−25%', value: rig.profitability?.net_minus25 },
      { label: '−10%', value: rig.profitability?.net_minus10 },
      { label: 'Current', value: rig.profitability?.net_current },
      { label: '+10%', value: rig.profitability?.net_plus10 },
      { label: '+25%', value: rig.profitability?.net_plus25 },
    ];
    const lengths = rig.profitability?.lengths || [];
    const mathText = m
      ? `${Number(m.hashrate_ghs).toPrecision(6)} GH/s ÷ ${Number(m.anchor_ghs).toPrecision(6)} GH/s anchor → ${Object.entries(m.production_day || {}).map(([coin, amount]) => `${Number(amount).toPrecision(6)} ${coin}/day × ${money(m.spot_usd?.[coin], 4)}`).join(' + ')} = ${money(m.revenue_day)}/day mined − ${money(m.cost_day)}/day cost = ${signed(m.net_day)}/day. Estimates only.`
      : '';

    return (
      <div className="rig-detail-inner">
        <p className="rig-explain">{explainer(rig)}</p>

        <div className="rig-detail-grid">
          <div className="rig-dstat">
            <span className="rig-dstat-label">Cost</span>
            <span className="rig-dstat-value">{money(rig.usd_per_day)}/day</span>
            <span className="rig-dstat-note">{money(Number(rig.usd_per_hour), 4)}/hr</span>
          </div>
          <div className="rig-dstat">
            <span className="rig-dstat-label">Est. mined value</span>
            <span className="rig-dstat-value">{money(rig.profitability?.revenue_day)}/day</span>
            <span className="rig-dstat-note">{productionNote(rig)}</span>
          </div>
          <div className="rig-dstat">
            <span className="rig-dstat-label">Est. result</span>
            <span className={`rig-dstat-value ${netClass(rig.profitability?.net_day)}`}>{signed(rig.profitability?.net_day)}/day</span>
            <span className="rig-dstat-note">after rental cost</span>
          </div>
          <div className="rig-dstat">
            <span className="rig-dstat-label">Mine vs buy</span>
            <span className="rig-dstat-value">{mvb ? mvb.value : '—'}</span>
            <span className="rig-dstat-note">{mvb ? mvb.note : 'not available'}</span>
          </div>
          <div className="rig-dstat">
            <span className="rig-dstat-label">Break-even price</span>
            <span className="rig-dstat-value">{money(rig.profitability?.break_even_price, 4)}</span>
            <span className="rig-dstat-note">
              {primaryCoin} must stay above this for profit · spot {money(m?.spot_usd?.[primaryCoin], 4)}
            </span>
          </div>
          <div className="rig-dstat">
            <span className="rig-dstat-label">Trust rating (RPI)</span>
            <span className="rig-dstat-value">{rpi.value}</span>
            <span className="rig-dstat-note">{rpi.note}</span>
          </div>
          <div className="rig-dstat">
            <span className="rig-dstat-label">Region</span>
            <span className="rig-dstat-value">{rig.region || '—'}</span>
          </div>
          <div className="rig-dstat">
            <span className="rig-dstat-label">Rental window</span>
            <span className="rig-dstat-value">{rig.min_hours}–{rig.max_hours} hours</span>
            <span className="rig-dstat-note">{rig.extensions ? 'extensions allowed' : 'no extensions'}</span>
          </div>
        </div>

        <div className="rig-detail-section">
          <h4>If prices move (delivery-adjusted estimate)</h4>
          <div className="rig-scenario-grid">
            {scenarios.map((scenario) => (
              <div className="rig-scenario" key={scenario.label}>
                {scenario.label}
                <strong className={Number(scenario.value) >= 0 ? 'rig-positive' : 'rig-negative'}>{signed(scenario.value)}</strong>
              </div>
            ))}
          </div>
        </div>

        {lengths.length > 0 && (
          <div className="rig-detail-section">
            <h4>Rental windows</h4>
            <table className="rig-length-table">
              <thead>
                <tr><th>Hours</th><th>Cost</th><th>Est. mined value</th><th>Est. net</th></tr>
              </thead>
              <tbody>
                {lengths.map((row) => (
                  <tr key={row.length_hours}>
                    <td>{row.length_hours}h</td>
                    <td>{money(row.total_cost)}</td>
                    <td>{money(row.expected_value)}</td>
                    <td className={Number(row.net) >= 0 ? 'rig-positive' : 'rig-negative'}>{signed(row.net)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {detailActions && <div className="rig-detail-actions">{detailActions(rig)}</div>}

        {mathText && <p className="rig-math-note">{mathText}</p>}
      </div>
    );
  };

  const renderCard = (rig, isBest) => {
    const net = Number(rig.profitability?.net_day);
    const kind = badgeFor(net);
    return (
      <div key={rig.rig_id} className={`rig-card rig-card--${kind} ${expandedId === rig.rig_id ? 'open' : ''} ${selectedId === String(rig.rig_id) ? 'selected' : ''}`}>
        <div className="rig-card-top">
          <div>
            <div className="rig-card-name">{rig.name}{isBest ? <span className="rig-star">★</span> : ''}</div>
            <div className="rig-card-hash">{rig.hashrate_nice || `${Number(rig.hashrate_ghs).toPrecision(4)} GH/s`}</div>
          </div>
          {renderBadge(net)}
        </div>
        <div className="rig-card-rows">
          <div><span className="rig-card-lbl">Cost / day</span>{money(rig.usd_per_day)}</div>
          <div><span className="rig-card-lbl">Est. mined / day</span>{money(rig.profitability?.revenue_day)}</div>
        </div>
        {renderAction && (
          <div className="rig-card-action">{renderAction(rig)}</div>
        )}
        <button
          type="button"
          className="rig-card-details"
          aria-expanded={expandedId === rig.rig_id}
          onClick={() => toggle(rig.rig_id)}
        >
          {expandedId === rig.rig_id ? '▾ Hide details' : '▸ Details & full stats'}
        </button>
        {expandedId === rig.rig_id && <div className="rig-card-detail">{renderDetail(rig)}</div>}
      </div>
    );
  };

  if (rigs.length === 0) {
    return <div className="rig-empty">{emptyMessage}</div>;
  }

  const bestStarId = filter === 'all' && visible.length > 0 ? String(visible[0].rig_id) : '';

  return (
    <div className="rig-list">
      {bestValue && (
        <div className={`rig-banner rig-banner--${bestIsProfit ? 'profit' : 'loss'}`}>
          <span className="rig-banner-icon">{bestIsProfit ? '⭐' : '⚠️'}</span>
          <div>
            <strong>
              {bestIsProfit
                ? `Best return right now: ${bestValue.name} — est. ${signed(bestNet)}/day profit`
                : `Everything is estimated at a loss right now. Least-bad pick: ${bestValue.name} — est. ${signed(bestNet)}/day`}
            </strong>
            <div className="rig-banner-note">{bestValue.reason}</div>
          </div>
        </div>
      )}

      <div className="rig-filter-row">
        <span className="rig-filter-label">Show</span>
        <button type="button" className={`rig-pill ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>
          All
        </button>
        <button type="button" className={`rig-pill rig-pill--profit ${filter === 'profit' ? 'active' : ''}`} onClick={() => setFilter('profit')}>
          Profit
        </button>
        <button type="button" className={`rig-pill rig-pill--loss ${filter === 'loss' ? 'active' : ''}`} onClick={() => setFilter('loss')}>
          Loss
        </button>
        <span className="rig-filter-count">
          {visible.length} of {rigs.length} miners · sorted by best return first
        </span>
      </div>

      <div className="rig-table-wrap">
        <table className="rig-table">
          <thead>
            <tr>
              <th>
                <button type="button" className="rig-sort" onClick={() => requestSort('name')}>
                  Miner {sortKey === 'name' ? (sortDir === 'asc' ? '▲' : '▼') : ''}
                </button>
              </th>
              <th className="num">
                <button type="button" className="rig-sort" onClick={() => requestSort('cost_day')}>
                  Cost / day {sortKey === 'cost_day' ? (sortDir === 'asc' ? '▲' : '▼') : ''}
                </button>
              </th>
              <th className="num">
                <button type="button" className="rig-sort" onClick={() => requestSort('mined_day')}>
                  Est. mined value / day {sortKey === 'mined_day' ? (sortDir === 'asc' ? '▲' : '▼') : ''}
                </button>
              </th>
              <th className="num">
                <button type="button" className="rig-sort" onClick={() => requestSort('net_day')}>
                  Est. profit / day {sortKey === 'net_day' ? (sortDir === 'asc' ? '▲' : '▼') : ''}
                </button>
              </th>
              <th style={{ width: '1%' }} />
            </tr>
          </thead>
          <tbody>
            {visible.map((rig) => {
              const net = Number(rig.profitability?.net_day);
              const open = expandedId === rig.rig_id;
              const isBest = String(rig.rig_id) === bestStarId;
              return [
                <tr
                  key={rig.rig_id}
                  className={`rig-row rig-row--${badgeFor(net)} ${open ? 'open' : ''} ${selectedId === String(rig.rig_id) ? 'selected' : ''}`}
                  onClick={() => toggle(rig.rig_id)}
                >
                  <td>
                    <button type="button" className="rig-name-btn" aria-expanded={open} onClick={() => toggle(rig.rig_id)}>
                      <span className="rig-chev">{open ? '▾' : '▸'}</span>
                      <span className="rig-name">{rig.name}{isBest ? <span className="rig-star">★</span> : ''}</span>
                    </button>
                    <span className="rig-hash">{rig.hashrate_nice || `${Number(rig.hashrate_ghs).toPrecision(4)} GH/s`}</span>
                  </td>
                  <td className="num">{money(rig.usd_per_day)}</td>
                  <td className="num">{money(rig.profitability?.revenue_day)}</td>
                  <td className="num">{renderBadge(net)}</td>
                  <td className="num">{renderAction ? renderAction(rig) : null}</td>
                </tr>,
                open && (
                  <tr className="rig-detail-row" key={`${rig.rig_id}-detail`}>
                    <td colSpan={5}>{renderDetail(rig)}</td>
                  </tr>
                ),
              ];
            })}
          </tbody>
        </table>
      </div>

      <div className="rig-cards">
        {visible.map((rig) => renderCard(rig, String(rig.rig_id) === bestStarId))}
      </div>
    </div>
  );
}
