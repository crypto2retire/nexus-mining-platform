export const WALLET_PROVIDER_STORAGE_KEY = 'nexus.walletProvider';

const WALLET_IDENTITIES = [
  { matches: (provider) => provider.isRabby, id: 'rabby', name: 'Rabby Wallet', icon: 'R' },
  { matches: (provider) => provider.isTrust, id: 'trust', name: 'Trust Wallet', icon: 'T' },
  { matches: (provider) => provider.isCoinbaseWallet, id: 'coinbase', name: 'Coinbase Wallet', icon: 'C' },
  { matches: (provider) => provider.isPhantom, id: 'phantom', name: 'Phantom', icon: 'P' },
  { matches: (provider) => provider.isMetaMask, id: 'metamask', name: 'MetaMask', icon: 'M' },
];

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

  const counts = new Map();
  return providers.map((provider) => {
    const identity = identityFor(provider);
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
