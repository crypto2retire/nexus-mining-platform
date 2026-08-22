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

// Order matters: check OWN-BRAND flags before COMPAT flags. Trust Wallet's
// provider carries isRabby/isMetaMask compatibility flags alongside its own
// isTrust — if isRabby is checked first, Trust gets labeled "Rabby Wallet 2".
const WALLET_IDENTITIES = [
  { matches: (provider) => provider.isTrust, id: 'trust', name: 'Trust Wallet', icon: 'T' },
  { matches: (provider) => provider.isPhantom, id: 'phantom', name: 'Phantom', icon: 'P' },
  { matches: (provider) => provider.isCoinbaseWallet, id: 'coinbase', name: 'Coinbase Wallet', icon: 'C' },
  { matches: (provider) => provider.isRabby, id: 'rabby', name: 'Rabby Wallet', icon: 'R' },
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

// Brand is decided by the EIP-6963 announcement FIRST (rdns is authoritative
// — e.g. com.trustwallet.app). Some providers carry compat flags for OTHER
// wallets (Trust Wallet can expose isMetaMask/isRabby), so flag matching
// alone misidentifies them (Trust showed as a 2nd "Rabby"). Flags are the
// fallback for legacy injectors with no announcement.
function identityForProvider(provider) {
  const entry = (window.__eip6963Providers || []).find((e) => e.provider === provider);
  const rdns = entry?.info?.rdns;
  if (rdns) {
    const knownId = EIP6963_RDNS_IDS[rdns];
    if (knownId) {
      const base = WALLET_IDENTITIES.find((i) => i.id === knownId);
      if (base) return base;
    }
    const name = String(entry?.info?.name || '').trim();
    if (name) return { id: `eip6963-${rdns}`, name, icon: name.charAt(0).toUpperCase() };
  }
  return identityFor(provider);
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
  const mapped = providers.map((provider) => {
    const identity = identityForProvider(provider);
    const count = (counts.get(identity.id) || 0) + 1;
    counts.set(identity.id, count);
    return {
      id: count === 1 ? identity.id : `${identity.id}-${count}`,
      name: count === 1 ? identity.name : `${identity.name} ${count}`,
      icon: identity.icon,
      provider,
    };
  });

  // Dedupe by brand id: the same wallet can be discovered through multiple
  // paths (window.ethereum, window.<brand>.ethereum, eip6963) with different
  // provider objects — show ONE chooser entry per wallet. First provider wins.
  const byId = new Map();
  for (const entry of mapped) {
    if (!byId.has(entry.id)) byId.set(entry.id, entry);
  }
  return [...byId.values()];
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
