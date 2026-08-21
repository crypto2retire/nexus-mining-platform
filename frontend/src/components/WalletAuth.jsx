import { useEffect, useRef, useState } from 'react';
import {
  getAvailableWallets,
  getWalletById,
  WALLET_PROVIDER_STORAGE_KEY,
} from '../wallets/providers';

const API_BASE = import.meta.env.VITE_API_URL || '';
const AUTH_STORAGE_KEY = 'nexus.auth';

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

export default function WalletAuth({ auth, onAuthChange }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [wallets, setWallets] = useState(() => getAvailableWallets());
  const [selectedWallet, setSelectedWallet] = useState(() => getWalletById());
  const [chooserOpen, setChooserOpen] = useState(false);
  const dialogRef = useRef(null);

  useEffect(() => {
    if (!chooserOpen) return undefined;
    dialogRef.current?.focus();
    const dismissOnEscape = (event) => {
      if (event.key === 'Escape') setChooserOpen(false);
    };
    window.addEventListener('keydown', dismissOnEscape);
    return () => window.removeEventListener('keydown', dismissOnEscape);
  }, [chooserOpen]);

  const signIn = async (walletChoice) => {
    setBusy(true);
    setError('');
    try {
      const accounts = await walletChoice.provider.request({ method: 'eth_requestAccounts' });
      const wallet = String(accounts?.[0] || '').toLowerCase();
      if (!/^0x[a-f0-9]{40}$/.test(wallet)) {
        throw new Error('The selected wallet did not return a valid EVM account.');
      }

      const challengeResponse = await fetch(`${API_BASE}/api/auth/challenge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet }),
      });
      const challenge = await responseBody(challengeResponse, 'Could not start wallet sign-in.');

      const signature = await walletChoice.provider.request({
        method: 'personal_sign',
        params: [challenge.nonce, wallet],
      });
      const verifyResponse = await fetch(`${API_BASE}/api/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet, signature }),
      });
      const session = await responseBody(verifyResponse, 'Wallet sign-in could not be verified.');

      const nextAuth = { token: session.token, wallet: session.wallet };
      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(nextAuth));
      localStorage.setItem(WALLET_PROVIDER_STORAGE_KEY, walletChoice.id);
      setSelectedWallet(walletChoice);
      onAuthChange(nextAuth);
    } catch (err) {
      setError(err?.message || 'Wallet sign-in was cancelled or failed.');
    } finally {
      setBusy(false);
    }
  };

  const connectWallet = () => {
    const available = getAvailableWallets();
    setWallets(available);
    setError('');
    if (available.length === 1) {
      const onlyWallet = available[0];
      localStorage.setItem(WALLET_PROVIDER_STORAGE_KEY, onlyWallet.id);
      setSelectedWallet(onlyWallet);
      signIn(onlyWallet);
      return;
    }
    if (available.length > 1) setChooserOpen(true);
  };

  const chooseWallet = (walletChoice) => {
    localStorage.setItem(WALLET_PROVIDER_STORAGE_KEY, walletChoice.id);
    setSelectedWallet(walletChoice);
    setChooserOpen(false);
    signIn(walletChoice);
  };

  const signOut = () => {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    localStorage.removeItem(WALLET_PROVIDER_STORAGE_KEY);
    setSelectedWallet(null);
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

  if (wallets.length === 0) {
    return (
      <div className="wallet-auth-message">
        <span>No EVM browser wallet was detected. Install one:</span>{' '}
        <a href="https://metamask.io" target="_blank" rel="noreferrer">MetaMask</a>,{' '}
        <a href="https://rabby.io" target="_blank" rel="noreferrer">Rabby</a>,{' '}
        <a href="https://trustwallet.com" target="_blank" rel="noreferrer">Trust Wallet</a>,{' '}
        <a href="https://www.coinbase.com/wallet" target="_blank" rel="noreferrer">Coinbase Wallet</a>, or{' '}
        <a href="https://phantom.app" target="_blank" rel="noreferrer">Phantom</a>.
      </div>
    );
  }

  return (
    <div className="wallet-auth">
      <button className="btn-primary wallet-auth-button" disabled={busy} onClick={connectWallet}>
        {busy ? 'Waiting for signature…' : 'Connect wallet'}
      </button>
      {!busy && selectedWallet && wallets.length > 1 && (
        <span className="wallet-provider-hint">Last used: {selectedWallet.name}</span>
      )}
      {error && <span className="wallet-auth-error">{error}</span>}
      {chooserOpen && (
        <div
          className="wallet-modal-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setChooserOpen(false);
          }}
        >
          <div
            className="wallet-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="wallet-modal-title"
            tabIndex={-1}
            ref={dialogRef}
          >
            <div className="wallet-modal-header">
              <div>
                <h2 id="wallet-modal-title">Choose a wallet</h2>
                <p>Select the wallet you want to use with Nexus.</p>
              </div>
              <button
                type="button"
                className="wallet-modal-close"
                aria-label="Close wallet chooser"
                onClick={() => setChooserOpen(false)}
              >
                ×
              </button>
            </div>
            <div className="wallet-options" aria-label="Available wallets">
              {wallets.map((walletChoice) => (
                <button
                  type="button"
                  className="wallet-option"
                  key={walletChoice.id}
                  onClick={() => chooseWallet(walletChoice)}
                >
                  <span className="wallet-option-icon" aria-hidden="true">{walletChoice.icon}</span>
                  <span>{walletChoice.name}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export { AUTH_STORAGE_KEY, WALLET_PROVIDER_STORAGE_KEY };
