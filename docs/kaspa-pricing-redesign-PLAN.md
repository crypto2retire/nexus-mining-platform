# KASPA Pricing Redesign — PLAN (2026-08-20, Kevin)

**Status: PLAN ONLY — nothing implemented, no rigs rented, no prices changed.**

## Goal

Rent a LARGER KAS miner so the 72h buy-in price can drop to **$1.00**, with
**50% return for the platform**, and fund a **competition/rewards pool** from
platform profits to make the game fun instead of a 99% loss machine.

## Why

- Current $5/72h KAS buy-in returns ~$0.014 in real mining (KAS at $0.0267).
- Nobody plays a game where they lose $4.86 per round.
- $1.00 is psychologically trivial — most won't compute the return.
- A competition/jackpot pool funded from platform margin adds the fun layer.

## Market reality (verified live on MRR, 2026-08-20)

| Rig | Size | Price/72h | Real output/72h |
|-----|------|-----------|------------------|
| KS0 PRO (current) | 200 GH/s | $0.22 | ~$0.14 |
| **KS0 Ultra (target)** | **400 GH/s** | **$0.44–0.49** | **~$0.27** |
| KS0 | 100 GH/s | $0.10 | ~$0.07 |
| 600 GH/s rig | 600 GH/s | $10.00 (rpi 82 — risky, skip) | ~$0.40 |

Real mining output is small regardless of rig size — the value comes from the
game margin + jackpot, NOT from raw mining yield. Be honest about this.

## Proposed model (per $1.00 slot = 25 GH/s of a 400 GH/s room)

- Platform keeps: **$0.50** (50%)
- Competition/rewards pool: **$0.45** (funded from buy-ins → daily jackpot / leaderboard)
- Real mining to player: ~$0.02 (honest)
- Rig cost: ~$0.03

At full occupancy (16 slots): platform $8.00, jackpot pool **$7.20/day**, rig
pays for itself from slot #1. No subsidy, no fake money.

## Timing

- Current KAS rental (#5698667, KS0 PRO 200 GH/s) expires **2026-08-22 20:18 UTC**.
- Swap to the 400 GH/s KS0 Ultra when the current window ends (or before, per Kevin).
- "Lets wait until this one is finished before adding another" — Kevin 2026-08-20.

## Open items (Kevin wants these factored in later)

1. **Same model for other coins** — ZEC / XMR / LTC-DOGE pricing redesign, one room at a time.
2. **Upgrades to encourage more spending** — e.g. bigger hashrate tiers, loyalty bonuses,
   upgrade discounts, reinvest incentives. Needs a design pass.
3. Jackpot structure specifics: daily draw vs leaderboard, prize split, odds, compliance review.
4. Re-verify KAS price/market before the swap — price moves change the whole table.
