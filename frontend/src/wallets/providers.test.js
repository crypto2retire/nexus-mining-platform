import assert from 'node:assert/strict';
import test from 'node:test';

function provider(flags = {}) {
  return { request() {}, ...flags };
}

function setWindow(overrides = {}) {
  globalThis.window = {
    addEventListener() {},
    dispatchEvent() {},
    __eip6963Providers: [],
    ...overrides,
  };
}

setWindow();
const walletProviders = await import('./providers.js');

test('identifies a lone Rabby provider', () => {
  setWindow({ ethereum: provider({ isRabby: true }) });

  assert.deepEqual(
    walletProviders.getAvailableWallets().map(({ id }) => id),
    ['rabby'],
  );
});

test('uses Trust Wallet EIP-6963 rdns when no legacy flag is present', () => {
  const trust = provider();
  setWindow({
    __eip6963Providers: [{
      info: { uuid: 'trust-1', name: 'Trust Wallet', rdns: 'com.trustwallet.app' },
      provider: trust,
    }],
  });

  assert.deepEqual(
    walletProviders.getAvailableWallets().map(({ id }) => id),
    ['trust'],
  );
});

test('keeps Rabby and Trust distinct when Trust also carries the Rabby compatibility flag', () => {
  const rabby = provider({ isRabby: true });
  const trust = provider({ isTrust: true, isRabby: true });
  rabby.providers = [rabby, trust];
  setWindow({ ethereum: rabby });

  assert.deepEqual(
    walletProviders.getAvailableWallets().map(({ id }) => id),
    ['rabby', 'trust'],
  );
});

test('combines injected Rabby with EIP-6963-only Trust', () => {
  const rabby = provider({ isRabby: true });
  const trust = provider();
  setWindow({
    ethereum: rabby,
    __eip6963Providers: [{
      info: { uuid: 'trust-2', name: 'Trust Wallet', rdns: 'com.trustwallet.app' },
      provider: trust,
    }],
  });

  assert.deepEqual(
    walletProviders.getAvailableWallets().map(({ id }) => id),
    ['rabby', 'trust'],
  );
});

test('treats EIP-6963 rdns as authoritative when isTrust is false', () => {
  const trust = provider({ isTrust: false, isRabby: true });
  setWindow({
    __eip6963Providers: [{
      info: { uuid: 'trust-3', name: 'Trust Wallet', rdns: 'com.trustwallet.app' },
      provider: trust,
    }],
  });

  assert.deepEqual(
    walletProviders.getAvailableWallets().map(({ id }) => id),
    ['trust'],
  );
});

test('deduplicates a wallet discovered through injected and EIP-6963 paths', () => {
  const trustInjected = provider({ isTrust: true });
  const trustAnnounced = provider();
  setWindow({
    ethereum: trustInjected,
    __eip6963Providers: [{
      info: { uuid: 'trust-4', name: 'Trust Wallet', rdns: 'com.trustwallet.app' },
      provider: trustAnnounced,
    }],
  });

  assert.deepEqual(
    walletProviders.getAvailableWallets().map(({ id }) => id),
    ['trust'],
  );
});

test('diagnostics expose identity, source paths, raw flags, and EIP-6963 metadata without account data', () => {
  const trust = provider({ isTrust: true, isRabby: true, selectedAddress: '0xprivate' });
  trust.providers = [trust];
  setWindow({
    ethereum: trust,
    __eip6963Providers: [{
      info: { uuid: 'trust-5', name: 'Trust Wallet', rdns: 'com.trustwallet.app' },
      provider: trust,
    }],
  });

  assert.equal(typeof walletProviders.getWalletDiagnostics, 'function');
  assert.deepEqual(walletProviders.getWalletDiagnostics(), [{
    id: 'trust',
    name: 'Trust Wallet',
    source: 'window.ethereum.providers[0], window.ethereum, eip6963',
    flags: {
      isTrust: true,
      isPhantom: undefined,
      isCoinbaseWallet: undefined,
      isRabby: true,
      isMetaMask: undefined,
    },
    eip6963: true,
    rdns: 'com.trustwallet.app',
  }]);
});

test('diagnostics retain raw same-brand provider objects hidden by chooser deduplication', () => {
  const rabby = provider({ isRabby: true });
  const secondProvider = provider({ isRabby: true });
  rabby.providers = [rabby, secondProvider];
  setWindow({ ethereum: rabby });

  assert.deepEqual(
    walletProviders.getAvailableWallets().map(({ id }) => id),
    ['rabby'],
  );
  assert.deepEqual(
    walletProviders.getWalletDiagnostics().map(({ id, source }) => ({ id, source })),
    [
      { id: 'rabby', source: 'window.ethereum.providers[0], window.ethereum' },
      { id: 'rabby', source: 'window.ethereum.providers[1]' },
    ],
  );
});

test('diagnostics inspect the documented Trust brand-global without changing chooser behavior', () => {
  const rabby = provider({ isRabby: true });
  const trustGlobal = provider({ isRabby: true });
  setWindow({ ethereum: rabby, trustwallet: trustGlobal });

  assert.deepEqual(
    walletProviders.getAvailableWallets().map(({ id }) => id),
    ['rabby'],
  );
  assert.deepEqual(
    walletProviders.getWalletDiagnostics().map(({ id, source }) => ({ id, source })),
    [
      { id: 'rabby', source: 'window.ethereum' },
      { id: 'rabby', source: 'window.trustwallet' },
    ],
  );
});
