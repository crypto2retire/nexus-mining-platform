import { useEffect, useMemo, useRef, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '';

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

function countdownLabel(milliseconds) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function referralUrl(code) {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('ref', code);
  return url.toString();
}

export default function GamePanel({ auth }) {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [now, setNow] = useState(Date.now());
  const referralHandled = useRef(false);

  const headers = useMemo(() => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${auth.token}`,
  }), [auth.token]);

  const fetchState = async () => {
    const response = await fetch(`${API_BASE}/api/game/state`, { headers });
    const nextState = await responseBody(response, 'Could not load your Game status.');
    setState(nextState);
    return nextState;
  };

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError('');
      try {
        if (!referralHandled.current) {
          referralHandled.current = true;
          const url = new URL(window.location.href);
          const code = url.searchParams.get('ref');
          if (code) {
            url.searchParams.delete('ref');
            window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
            try {
              const response = await fetch(`${API_BASE}/api/game/referral/apply`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ code }),
              });
              await responseBody(response, 'Could not apply the referral code.');
              if (!cancelled) setMessage('Referral applied. Keep your streak going to day 3.');
            } catch (err) {
              if (!cancelled) setError(err?.message || 'Could not apply the referral code.');
            }
          }
        }

        const response = await fetch(`${API_BASE}/api/game/state`, { headers });
        const nextState = await responseBody(response, 'Could not load your Game status.');
        if (!cancelled) setState(nextState);
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Could not load your Game status.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => { cancelled = true; };
  }, [headers]);

  useEffect(() => {
    if (!state || state.can_claim) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [state]);

  const nextClaimTime = state?.next_claim_at ? new Date(state.next_claim_at).getTime() : 0;
  const remaining = Math.max(0, nextClaimTime - now);
  const canClaim = Boolean(state?.can_claim) || (nextClaimTime > 0 && remaining === 0);
  const nextReward = state
    ? (0.01 * Math.min(Number(state.current_streak) + 1, 30)).toFixed(2)
    : '0.01';
  const shareLink = state?.referral_code ? referralUrl(state.referral_code) : '';

  const claim = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch(`${API_BASE}/api/game/streak/claim`, {
        method: 'POST',
        headers,
      });
      const result = await responseBody(response, 'Daily claim failed.');
      setMessage(
        `Claimed $${Number(result.reward_usdc).toFixed(2)} USDC for streak day ${result.current_streak}.` +
        (result.referral_bonus_paid ? ' Your referrer also received the day-3 bonus.' : '')
      );
      await fetchState();
      setNow(Date.now());
    } catch (err) {
      setError(err?.message || 'Daily claim failed.');
    } finally {
      setBusy(false);
    }
  };

  const copyReferral = async () => {
    setError('');
    try {
      await navigator.clipboard.writeText(shareLink);
      setMessage('Referral link copied.');
    } catch (_err) {
      setError('Could not copy automatically. Select and copy the referral link below.');
    }
  };

  return (
    <section className="game-panel" aria-labelledby="game-panel-title">
      <div className="game-panel-header">
        <div>
          <h2 id="game-panel-title">Daily Game</h2>
          <p>Deterministic loyalty rewards — claim once per UTC day.</p>
        </div>
        <span className="game-streak" aria-label={`${state?.current_streak || 0} day current streak`}>
          🔥 {state?.current_streak || 0}
        </span>
      </div>

      {loading && !state && <div className="game-loading">Loading Game status…</div>}
      {error && <div className="game-error" role="alert">{error}</div>}
      {message && <div className="game-message" role="status">{message}</div>}

      {state && (
        <>
          <div className="game-stats">
            <div className="stat">
              <span className="stat-label">Current streak</span>
              <span className="stat-value">{state.current_streak} days</span>
            </div>
            <div className="stat">
              <span className="stat-label">Best streak</span>
              <span className="stat-value">{state.best_streak} days</span>
            </div>
            <div className="stat">
              <span className="stat-label">Game rewards</span>
              <span className="stat-value accent">${Number(state.total_rewards_usdc).toFixed(2)} USDC</span>
            </div>
          </div>

          <button className="btn-primary game-claim" disabled={busy || !canClaim} onClick={claim}>
            {busy
              ? 'Claiming…'
              : canClaim
                ? `Claim $${nextReward} USDC`
                : `Next claim in ${countdownLabel(remaining)}`}
          </button>

          <div className="game-referral">
            <h3>Referral rewards</h3>
            <p>Your referrer earns $0.50 USDC once you reach streak day 3.</p>
            <div className="game-referral-stats">
              <span><strong>{state.referral_count}</strong> referrals</span>
              <span><strong>${Number(state.referral_bonus_usdc).toFixed(2)}</strong> bonuses earned</span>
            </div>
            <div className="game-referral-link">
              <input aria-label="Your referral link" readOnly value={shareLink} onFocus={(event) => event.target.select()} />
              <button className="btn-secondary" disabled={!shareLink} onClick={copyReferral}>Copy link</button>
            </div>
            <span className="game-referral-code">Code: <strong>{state.referral_code}</strong></span>
          </div>
        </>
      )}
    </section>
  );
}
