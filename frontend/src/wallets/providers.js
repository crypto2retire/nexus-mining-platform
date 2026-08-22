export const WALLET_PROVIDER_STORAGE_KEY = 'nexus.walletProvider';

// EIP-6963 discovery: modern wallets (Trust Wallet, Coinbase, Phantom, ...)
// announce via eip6963:announceProvider rather than injecting
// window.ethereum. Providers register here as the page loads; we then expose
// them through getAvailableWallets() and ping listeners on new arrivals.
if (typeof window !== 'undefined') {
  window.__eip6963Providers = window.__eip6963Providers || [];
  window.addEventListener('eip6963:announceProvider', (event) => {
    const detail = event.detail;
    const provider = detail?.provider;
    if (!provider || typeof provider.request !== 'function') return;
    if (!window.__eip6963Providers.some((entry) => entry.provider === provider)) {
      window.__eip6963Providers.push(detail);
      window.dispatchEvent(new Event('nexus:walletsChanged'));
    }
  });
  // Ask any already-loaded wallet to announce itself.
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}

const WALLET_IDENTITIES = [
  { matches: (provider) => provider.isRabby, id: 'rabby', name: 'Rabby Wallet', icon: 'R' },
  { matches: (provider) => provider.isTrust, id: 'trust', name: 'Trust Wallet', icon: 'T' },
  { matches: (provider) => provider.isCoinbaseWallet, id: 'coinbase', name: 'Coinbase Wallet', icon: 'C' },
  { matches: (provider) => provider.isPhantom, id: 'phantom', name: 'Phantom', icon: 'P' },
  { matches: (provider) => provider.isMetaMask, id: 'metamask', name: 'MetaMask', icon: 'M' },
];

// Stable ids for EIP-6963-announced wallets (rdns) so the remembered wallet
// provider matches whether the wallet injected window.ethereum, exposed
// window.<brand>.ethereum, or announced via eip6963.
const EIP6963_RDNS_IDS = {
  'com.trustwallet.app': 'trust',
  'com.phantom': 'phantom',
  'com.coinbase.wallet': 'coinbase',
  'io.metamask': 'metamask',
  'io.rabby': 'rabby',
};

function identityFor(provider) {
  return WALLET_IDENTITIES.find(({ matches }) => matches(provider)) || {
    id: 'eip1193',
    name: 'EIP-1193 Wallet',
    icon: 'W',
  };
}

function addProvider(providers, seen, provider) {
  if (!provider || typeof provider.request !== 'function' || seen.has(provider)) return;
  seen.add(provider);
  providers.push(provider);
}

export function getAvailableWallets() {
  if (typeof window === 'undefined') return [];

  const providers = [];
  const seen = new Set();
  const injected = window.ethereum;

  // Multi-wallet injectors commonly expose every provider here while also
  // aliasing one of them as window.ethereum.
  if (Array.isArray(injected?.providers)) {
    for (const provider of injected.providers) addProvider(providers, seen, provider);
  }
  addProvider(providers, seen, injected);
  addProvider(providers, seen, window.phantom?.ethereum);
  addProvider(providers, seen, window.coinbaseWalletExtension);

  // EIP-6963-announced providers (Trust Wallet extension, etc.).
  for (const entry of window.__eip6963Providers || []) {
    addProvider(providers, seen, entry.provider);
  }

  const counts = new Map();
  return providers.map((provider) => {
    let identity = identityFor(provider);
    // Fall back to the EIP-6963 announcement metadata when the provider has
    // no brand flags (e.g. Trust Wallet extension).
    if (identity.id === 'eip1193') {
      const entry = (window.__eip6963Providers || []).find((e) => e.provider === provider);
      const info = entry?.info;
      if (info?.name) {
        const name = String(info.name).trim();
        const icon = name ? name.charAt(0).toUpperCase() : 'W';
        identity = {
          id: EIP6963_RDNS_IDS[info.rdns] || `eip6963-${info.rdns || name.toLowerCase()}`,
          name,
          icon,
        };
      }
    }
    const count = (counts.get(identity.id) || 0) + 1;
    counts.set(identity.id, count);
    return {
      id: count === 1 ? identity.id : `${identity.id}-${count}`,
      name: count === 1 ? identity.name : `${identity.name} ${count}`,
      icon: identity.icon,
      provider,
    };
  });
}

export function getWalletById(id) {
  const wallets = getAvailableWallets();
  let chosenId = id;
  if (!chosenId && typeof localStorage !== 'undefined') {
    try {
      chosenId = localStorage.getItem(WALLET_PROVIDER_STORAGE_KEY);
    } catch (_err) {
      // Storage can be unavailable in privacy-restricted browser contexts.
    }
  }
  return wallets.find((wallet) => wallet.id === chosenId) || wallets[0] || null;
}
