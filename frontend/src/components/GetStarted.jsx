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
            Nexus rents <strong>real</strong> mining hashrate (Zcash, Kaspa, Litecoin/Dogecoin,
            Monero) and pays you a pro-rata share of what it mines while your rental is active.
            Here's how to set up your account:
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
              <strong>Sign in securely.</strong> Click <strong>Sign in with wallet</strong>, choose your
              account, and approve the one-time sign-in message. This proves the address belongs to
              you without sending a transaction or exposing your recovery phrase.
            </li>
            <li>
              <strong>Fund with USDC on the Base network.</strong> Rentals are paid in USDC. Send
              USDC on the <strong>Base</strong> network (not Ethereum mainnet) to the platform
              deposit address:
              <div className="deposit-address" title="Platform USDC deposit address">
                {depositAddress || 'Deposit address unavailable — contact support'}
              </div>
              Your balance appears on the dashboard within a minute of the transfer.
            </li>
            <li>
              <strong>Rent hashrate.</strong> Click <strong>Rent 72h</strong> on any room card.
              Your payment rents a <strong>real</strong> mining rig for 72 hours — you never buy
              anything, you just rent mining time, exactly like renting a server. Entry prices
              follow real rental costs — Kaspa and Monero start at <strong>$5</strong>, Zcash at{' '}
              <strong>$20</strong>, Litecoin at <strong>$50</strong>.
            </li>
            <li>
              <strong>Earn while your rental runs.</strong> Every pool payout is split pro-rata
              among everyone with an active rental in that room, minus a 5% platform fee. When
              your 72h window ends, the rig stops mining — just <strong>Renew</strong> to keep
              going. No hidden costs, no maintenance fees, no surprise pauses.
            </li>
            <li>
              <strong>Reinvest to grow.</strong> Use the <strong>Reinvest Yield → Rent</strong>{' '}
              button to put your mined tokens straight into the next rental window — no new USDC
              needed. Claim anytime with <strong>Claim Yield</strong>, or withdraw the mined token
              itself.
            </li>
          </ol>

          <div className="get-started-tip">
            <strong>Heads up:</strong> mining addresses (Monero, Zcash, Kaspa, Bitcoin) can't be
            used to sign in — Nexus accounts use Ethereum wallets only. Never type or share your
            recovery phrase with Nexus or anyone claiming to represent it.
          </div>
        </div>
      )}
    </div>
  );
}
