# SELF-CUSTODY ONLY — Non-Negotiable Product Principle

> Source: Kevin, 2026-08-22. "There is no pooled hashrate. Each user owns
> their own mining and results. … It is self custody and only self custody.
> So users only see their own hashrate total, rewards amount, time
> remaining. Nothing is pooled, we never touch funds."

## The rule

1. **Each user owns their own rig rental and their own results.** Their own
   hashrate, their own rewards, their own time remaining, their own P/L.
2. **There is no pooled hashrate.** Never present "pooled hashrate,"
   shared-wallet splits, or pro-rata allocation as a user's results. That
   was built once and rejected ("you seem confused") — do not reintroduce
   it.
3. **Users see only their own numbers:** hashrate total, rewards amount,
   time remaining. That's it.
4. **We never touch funds.** Payouts go DIRECT from the pool to the user's
   wallet. Nexus charges a flat 5% connection fee — never a % of mined
   coins, never custody of coins.

## How to build against it

- **Per-rig / per-user data only.** Every dashboard, report, or UI for a
  renter is built per-rig: their rig's hashrate, their rental window, their
  wallet's rewards at the pool.
- **Per-rig actual rewards are not available** from pool APIs (verified
  2026-08-22: 2Miners `/workers` returns nothing; HeroMiners rejects it;
  pools report per-wallet, not per-rig). So:
  - Per-rig rewards column = null → render "—". NEVER allocate the pool
    wallet's balance across rigs to fake per-rig rewards.
  - Per-rig P/L = ESTIMATED from the rig's own production math (anchor
    hashrate × production × spot), clearly labeled "est."
  - The user's OWN rewards = the pool's unpaid balance for THEIR wallet,
    shown at the pool/coin level, unsplit.
- **Operator-only tooling** (admin panel) may show pool-level figures —
  but never as a user's "results."
- **Copy:** no "pooled," no "all renters," no "shared" in user-facing UI.
