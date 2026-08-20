import { useState } from 'react';
import { BrowserProvider } from 'ethers';

const API_BASE = import.meta.env.VITE_API_URL || '';
const AUTH_STORAGE_KEY = 'nexus.auth';

async function responseBody(response, fallback) {
  let body;
  try {
    body = await response.json();
  } catch (_err) {
    throw new Error(fallback);
  }
  if (body?.error) throw new Error(body.error);
  return body;
}

export default function WalletAuth({ auth, onAuthChange }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const hasWalletExtension = typeof window !== 'undefined' && Boolean(window.ethereum);

  const signIn = async () => {
    setBusy(true);
    setError('');
    try {
      const provider = new BrowserProvider(window.ethereum);
      await provider.send('eth_requestAccounts', []);
      const signer = await provider.getSigner();
      const wallet = (await signer.getAddress()).toLowerCase();

      const challengeResponse = await fetch(`${API_BASE}/api/auth/challenge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet }),
      });
      const challenge = await responseBody(challengeResponse, 'Could not start wallet sign-in.');
      if (!challengeResponse.ok) throw new Error(challenge.error || 'Could not start wallet sign-in.');

      const signature = await signer.signMessage(challenge.nonce);
      const verifyResponse = await fetch(`${API_BASE}/api/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet, signature }),
      });
      const session = await responseBody(verifyResponse, 'Wallet sign-in could not be verified.');
      if (!verifyResponse.ok) throw new Error(session.error || 'Wallet sign-in could not be verified.');

      const nextAuth = { token: session.token, wallet: session.wallet };
      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(nextAuth));
      onAuthChange(nextAuth);
    } catch (err) {
      setError(err?.message || 'Wallet sign-in was cancelled or failed.');
    } finally {
      setBusy(false);
    }
  };

  const signOut = () => {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    setError('');
    onAuthChange(null);
  };

  if (auth) {
    return (
      <div className="wallet-auth">
        <span className="connected-chip" title={auth.wallet}>
          ✓ {auth.wallet.slice(0, 6)}…{auth.wallet.slice(-4)}
        </span>
        <button className="btn-secondary wallet-auth-button" onClick={signOut}>Sign out</button>
      </div>
    );
  }

  if (!hasWalletExtension) {
    return (
      <div className="wallet-auth-message">
        A browser wallet such as MetaMask, Coinbase Wallet, or Trust Wallet is required to buy rigs or withdraw.
      </div>
    );
  }

  return (
    <div className="wallet-auth">
      <button className="btn-primary wallet-auth-button" disabled={busy} onClick={signIn}>
        {busy ? 'Waiting for signature…' : 'Sign in with wallet'}
      </button>
      {error && <span className="wallet-auth-error">{error}</span>}
    </div>
  );
}

export { AUTH_STORAGE_KEY };
