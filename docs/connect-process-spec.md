# THE ONLY PROCESS — Connect spec (Kevin 2026-08-22)

> "The only process this should be using: the user chooses a coin, the user
> reviews pool returns, size, cost, length. If they decide to rent we
> facilitate the correct miner and correctly set up pool. User pays the
> miner directly and receives rewards from the pool. We get a 5% fee that
> is added and separate from the amount sent to the miner."

This is the ONLY product process. The game/rooms/operator-market flows are
not part of it and must not be presented as the product.

## The six steps (non-negotiable)

1. **User chooses a coin.**
2. **User reviews pools by returns, size, cost, length** — the pool-choice
   UX must exist (sortable by those four).
3. **If they rent: we facilitate the correct miner + correctly set up the
   pool** — wallet-only pool; the user's payout address is the worker.
4. **User pays the miner directly** — the full rental amount goes to the
   miner (MRR / rig host). Nexus never takes a cut out of it.
5. **Pool pays the user directly.**
6. **Our 5% fee is ADDED ON TOP and SEPARATE** from the miner payment —
   never deducted from it.

## Audit vs current implementation (2026-08-22)

| Step | Status | Evidence |
|---|---|---|
| 1. Choose coin | ✅ | Connect tab: KAS/ZEC/BTC |
| 2. Review pools (returns/size/cost/length) | ❌ | One wallet-only pool per coin hard-coded (`POOL_CONFIG`: HeroMiners/2Miners/Ocean) — no pool-choice UX |
| 3. Facilitate rig + correct pool | ✅ | connectWorker places the MRR rental + `PUT /rental/{id}/pool` |
| 4. **User pays miner directly** | ❌ | Funding = user's Nexus **USDC** balance (`user_wallets.usdc_balance >= total_usd`, connectService.createConnectOrder); worker spends the **operator's MRR BTC balance**; refunds credit user USDC. That is user→Nexus→MRR |
| 5. Pool pays user directly | ✅ | Pool → user payout address (REV 3 proven live) |
| 6. **5% fee added and separate** | ⚠️ | Displayed as added on top ("Rental $X + 5% fee $Y = $Z") but collected from the same USDC balance as the rental — not a separate payment |

## The MRR constraint — why step 4 needs a decision

MRR rentals are funded from an **account BTC balance**. There is no
per-rental third-party payment or invoice link. "User pays the miner
directly" therefore means one of:

- **Option A — user-owned MRR accounts:** the user provides their own MRR
  API key/secret (or funds their own MRR account); we place the rental FROM
  their account pointed at their chosen pool + their payout wallet. True
  direct payment. Cost: MRR account verification, API-key custody (encrypt
  at rest), MRR TOS check, more onboarding friction.
- **Option B — fee separation within current architecture:** the user's
  rental payment (BTC) is earmarked for the rental; the worker pays MRR the
  FULL rental amount from the operator balance; the 5% fee is a SEPARATE
  payment (separate USDC line or separate BTC address) that never touches
  the miner payment. Money flow: rental amount 100% → miner; fee → Nexus as
  its own line item. Not literally "user→miner" on-chain, but the accounting
  is fully separated.

**Decision needed from Kevin: A or B** (or a hybrid: B now, A later when
MRR API-key onboarding is productized).
