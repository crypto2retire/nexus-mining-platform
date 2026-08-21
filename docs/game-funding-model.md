# Game Funding Model — Rented vs Owned Mining (Aug 21, 2026)

**Purpose:** Compare the monthly cost of funding the Nexus game layer from (A) rented
hashrate (current model) vs (B) owned miners, at realistic power rates.

**Inputs:**
- Rental costs: real `rig_rentals.cost_btc` from deployment DB, converted at BTC $74,808
- Mined: live pool unpaid balances (2Miners/HeroMiners) + F2Pool settlement screenshot,
  converted at live CoinGecko prices
- Machine specs: public estimates (L7 9.5 GH/s @ 3425W; Z9 30 KH/s @ 750W; KS0 Pro
  200 GH/s @ 100W), hardware amortized over 24 months
- ⚠️ LTC+DOGE mined is **extrapolated** from a partial F2Pool settlement — unverified
- ⚠️ Not legal advice; verify all prices/specs before purchase

---

## A. RENTED-FUNDED GAME (current model)

| Room | Rent/mo | Mined/mo | Net/mo |
|---|---|---|---|
| ZEC (z9 + test) | $70.10 | $49.20 | **−$20.90** |
| XMR | $20.56 | $3.60 | **−$16.96** |
| KAS | $2.36 | $2.10 | **−$0.26** |
| LTC+DOGE (extrapolated) | $112.71 | $113.70 | **+$0.99** |
| **TOTAL** | **$205.74** | **$168.60** | **−$37.14/mo** |

→ The rented fleet **loses ~$37/month** at today's prices. The game layer would have
zero mining-funded budget — it would be funded at a loss.

## B. OWNED-FUNDED GAME (same capacity, owned machines)

| Power rate | L7 net/mo | Z9 net/mo | KS0 Pro net/mo | Fleet total |
|---|---|---|---|---|
| $0.05/kWh | −$137.62 | −$15.34 | −$26.50 | **−$179.46/mo** |
| $0.08/kWh | −$211.60 | −$31.54 | −$28.66 | **−$271.80/mo** |
| $0.12/kWh | −$310.24 | −$53.14 | −$31.54 | **−$394.92/mo** |
| $0.17/kWh (typical WI) | −$433.54 | −$80.14 | −$35.14 | **−$548.82/mo** |

## C. BREAK-EVEN POWER RATES (mining covers electricity only, ignoring hardware)

| Machine | Break-even power |
|---|---|
| Antminer L7 (scrypt) | ≤ $0.062/kWh |
| Z9-class (equihash) | ≤ $0.068/kWh |
| KS0 Pro (kaspa) | ≤ $0.029/kWh |

## Bottom line

1. **Owned mining is worse than renting at every realistic power rate** — even at
   $0.05/kWh (near-industrial), the fleet loses ~$179/month before hardware is even
   counted. At WI residential (~$0.17), it loses ~$549/month.
2. **Renting is cheaper than owning today** because rental prices already include
   cheap industrial power; home power can't beat the market.
3. **Mining does NOT fund the game at current prices/difficulty** — not rented
   (−$37/mo), not owned (−$179 to −$549/mo).
4. Owned hardware only makes sense with: a sub-$0.06 power deal (colocation, solar,
   industrial rate) AND/OR higher coin prices — not at home rates.

## DECISION (Kevin, Aug 21 2026): RENTAL-ONLY — no owned hardware

**Decision:** the platform rents hashrate (MRR/NiceHash); it does not buy miners.

**Rationale (Kevin):** buying doesn't make sense unless hosted, and hosting adds
cost; renting is easier to shift with the market.

**Data supports it:**
- WhatToMine scan at $0.12/kWh: every ASIC coin the platform mines is net-negative
  on owned hardware (ZEC −$1.33, DOGE −$4.24, KAS −$4.84, LTC −$9.21/day)
- Owned loses more than rented at the same power rate (rental prices already
  include cheap industrial power the operator can't access at home)
- 72h rental windows = flexibility: switch coins/rigs as the market shifts, no
  capital lockup, no hardware/power risk

**Implications for the model:**
- The platform is a **rental-service business**: arrange user-directed rentals
  (REV-2 model) + optionally mine its own rented capacity
- Rental prices sit at ≈ EV (sellers price at their own cost), so the mining
  spread is thin-to-negative — the business is: (a) service fees on user
  rentals, (b) catching rental-arbitrage windows when coin prices move faster
  than rental repricing, (c) the game layer
- **The WhatToMine scan + MRR/NiceHash rental-price tracking is the operational
  tool**: it detects when any room turns profitable at rental prices, so the
  platform can shift capacity there (that's the "shift with the market" edge)

## What this means for strategy

- The game layer must be funded from **service fees and platform margin** (not mining
  spread) — or mining must be treated as a strategic bet on coin prices, not a
  funding engine.
- If owned mining is ever pursued, it should be a **separate capital decision**
  (power deal first), not a way to fund the game.
- The consumer value proposition is the game + service, not mining income.
