import { useState } from 'react';

/**
 * "Create account / Get started" guide — click-by-click onboarding for new
 * players. Addresses the most common confusion: Nexus accounts use an
 * Ethereum-style wallet (MetaMask etc.), NOT mining addresses.
 */
export default function GetStarted({ depositAddress }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="get-started">
      <button className="btn-secondary get-started-toggle" onClick={() => setOpen(!open)}>
        {open ? '▲ Hide guide' : '🚀 Create account / Get started'}
      </button>

      {open && (
        <div className="get-started-card">
          <h3>How to start mining with Nexus</h3>
          <p className="get-started-intro">
            Nexus pays out a share of <strong>real</strong> mining rewards (Zcash, Kaspa, Litecoin/
            Dogecoin, Monero) based on the hashrate you own. Here's how to set up your account:
          </p>

          <ol className="get-started-steps">
            <li>
              <strong>Get a wallet.</strong> Nexus accounts use an Ethereum-style wallet. If you
              don't have one, install{' '}
              <a href="https://metamask.io/download/" target="_blank" rel="noreferrer">
                MetaMask
              </a>{' '}
              (free browser extension, ~2 minutes). Create a wallet and <em>write down your secret
              recovery phrase</em> — never share it with anyone.
            </li>
            <li>
              <strong>Copy your address.</strong> In MetaMask, click your account name and copy the
              address — it starts with <code>0x</code> and is 42 characters long. Paste it in the
              box above and click <strong>Connect Wallet</strong>. Your address is your account.
            </li>
            <li>
              <strong>Fund with USDC on the Base network.</strong> Upgrades are paid in USDC. Send
              USDC on the <strong>Base</strong> network (not Ethereum mainnet) to the platform
              deposit address:
              <div className="deposit-address" title="Platform USDC deposit address">
                {depositAddress || 'Deposit address unavailable — contact support'}
              </div>
              Your balance appears on the dashboard within a minute of the transfer.
            </li>
            <li>
              <strong>Upgrade a mine.</strong> Click <strong>Upgrade Rig</strong> on any room card.
              The first paid tier is $50 — your account gets real hashrate and a share of that
              pool's real mining rewards. The <strong>Monero (XMR)</strong> room is powered by the
              platform's own miner, so it's the free way to get started.
            </li>
            <li>
              <strong>Earn.</strong> Your share of each pool's rewards accumulates as{' '}
              <em>pending yield</em> on the room card. Claim it anytime with the{' '}
              <strong>Claim Yield</strong> button.
            </li>
          </ol>

          <div className="get-started-tip">
            <strong>Heads up:</strong> mining addresses (Monero, Zcash, Kaspa, Bitcoin) can't be
            used to connect — Nexus accounts use Ethereum wallets only.
          </div>
        </div>
      )}
    </div>
  );
}
