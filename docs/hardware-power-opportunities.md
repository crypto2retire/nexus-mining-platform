# Mining Hardware & Power Opportunity Memo (Aug 21, 2026)

> Research memo — not investment or legal advice. Prices verified live where
> noted; coin P/L depends on the Aug 23 72h audit settling LTC/DOGE rate.

## TL;DR

**Used hardware + hosting + solar/wind + heat recovery does NOT make mining
profitable at current coin prices.** Every lever is real; the combination still
lands at hobby-level returns (~$300-600/yr/machine) unless coin prices rise
50-100%. The used-market prices are a cycle-bottom signal: cheap hardware now =
the setup to execute WHEN prices rise.

---

## 1. Used mining hardware (real eBay prices, verified 2026-08-21)

| Machine | Used price (eBay) | Mines | Notes |
|---|---|---|---|
| **Antminer L7** 9.05-10.5 GH/s | **$390-$700** | LTC/DOGE | Same class as the rented rig ($3.79/day) |
| L9 16-17 GH/s | $2,050-$3,500 | LTC/DOGE | ~2x an L7 |
| S17+ 73 TH/s | **$85** | BTC | e-waste, not viable |
| S19-class 100 TH/s | ~$500-800 | BTC | borderline at best |

The **L7 at $390-500** is the interesting entry point: same machine class as
the rental fleet, at a price that amortizes fast IF the coin math holds.

## 2. Hosting at low-cost facilities

Verified: **MiningStore** (62.5 MW, 11 facilities, Iowa, hosting since 2019 —
reachable + operational). Institutional hosting runs **$0.05-0.08/kWh all-in**
(power + cooling + maintenance + monitoring).

Used L7 (9.5 GH/s, 3425W) hosted economics:

| Hosting rate | Mined/day (optimistic LTC) | Power/day | Net/day |
|---|---|---|---|
| $0.05/kWh | $4.95 | $4.11 | **+$0.84** |
| $0.06/kWh | $4.95 | $4.93 | **+$0.02** (break-even) |
| $0.07/kWh | $4.95 | $5.75 | **−$0.80** |

- Only **sub-$0.05 hosting** works — and only if the optimistic LTC rate holds
  (pending Aug 23 settlement).
- Payback on $500 L7 at +$0.84/day ≈ **596 days**. Hobby, not business.
- At the pessimistic LTC rate, even $0.05 hosting loses **−$2.83/day**.

## 3. Solar / wind in Wisconsin

- **10 kW solar**: ~12,500 kWh/yr, ~$30K installed, 30% ITC → net $21K →
  **~14-year payback** at $0.12. Solar covers only ~15-20% of a 24/7 mining
  load → effective rate ~$0.10-0.11/kWh. Not enough to flip the math.
- **Wind**: Wisconsin is poor small-scale wind (class 2-3) — rooftop wind not
  worth it.
- **Focus on Energy** (verified live): real WI rebates exist (increased solar
  rebates, business incentives) but don't close a 14-year payback.

## 4. Heat recovery (Wisconsin winters)

- An L7 at 3,425W produces ~11,700 BTU/hr ≈ **7.8 space heaters** ≈ 3.4 kW of
  heat.
- **Winter heat credit**: ~$1,200-1,800 per 6-month heating season
  (electric-heat offset $148/mo; gas-heat offset ~$100/mo).
- **BUT**: at home $0.12 power the L7 loses **$4.91/day** on mining → even with
  the $148/mo heat credit: **−$4.91×30 + $148 = −$0.70/month**. Heat credit is
  real but can't rescue a rig that loses money on power first.
- Heat recovery only helps if the rig is profitable at home power first — none
  are at $0.12 (break-even ~$0.06).

---

## Verdict

| Path | Result |
|---|---|
| Used L7 + $0.05 hosting + optimistic LTC | +$0.84/day → 596-day payback (hobby) |
| Used L7 + home power + heat credit | still negative |
| Solar + mining | 14-yr payback, doesn't flip math |
| Any path + pessimistic LTC | negative |

**The only version that works**: used L7 at cycle-low + true industrial power
($0.04-0.05) + optimistic coin rate → **$300-600/yr per machine**. That's a
bet on price recovery, not a business.

**Strategic read**: cheap used hardware ($390 L7s) is a **cycle-bottom signal**.
The tool (rental-intelligence backend) tells us WHEN to execute; this memo is
the setup to execute THEN. Until the 72h audit settles the coin rates, no
hardware purchases.

## Next actions

- [ ] Aug 23 07:00 — 72h P/L audit (cron scheduled) → settles optimistic vs
      pessimistic LTC/DOGE rate
- [ ] Re-run this memo's tables with the confirmed rates
- [ ] Only if a room shows sustained positive P/L: consider a 1-2 machine
      used-L7 test at sub-$0.05 hosting
