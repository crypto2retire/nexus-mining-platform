# Mining Option Scan — WhatToMine API (Aug 21, 2026)

**Source:** WhatToMine trial API (`/api/v1/calculate`, `/api/v1/coins`), live data at
read time. Electricity = **$0.12/kWh** (Kevin's rate). Hardware profiles = public
estimates (flags below). API usage: 4/1000 calls.

## Verdict in one line

**At $0.12/kWh, EVERY coin the platform currently mines is unprofitable on owned
hardware — and the only profitable *liquid* mining is CPU RandomX (XMR) and GPU
Autolykos (ERG). The big "profits" on the list are illiquid micro-caps you cannot
sell.**

## Full ranked results (owned hardware, $0.12/kWh)

| Coin | Algo | Profit $/day | Revenue $/day | Liquidity | Verdict |
|---|---|---|---|---|---|
| ETI | RandomX | +$1.24 | $2.04 | **ILLIQUID** ($76K cap, $20 vol) | ❌ can't sell — fake profit |
| XDAG | RandomX | +$1.17 | $1.98 | **ILLIQUID** ($1M cap, $42 vol) | ❌ can't sell |
| **XMR** | RandomX | **+$0.65** | $1.45 | ✅ Liquid ($7.9B, $2.9M vol) | ✅ **the only real winner** |
| QRL | RandomX | +$0.53 | $1.34 | ✅ ($68M cap, $14K vol) | ⚠️ thin volume |
| ZEPH | RandomX | +$0.52 | $1.32 | ⚠️ ($4.8M cap, $61K vol) | ⚠️ risky |
| ERG | Autolykos | +$0.21 | $1.16 | ✅ ($21.6M cap, $219K vol) | ⚠️ marginal |
| EPIC | RandomX | +$0.13 | $0.94 | ⚠️ ($4M cap, $33K vol) | ⚠️ marginal |
| ZEC | Equihash | **−$1.33** | $0.83 | ✅ | ❌ current room, loses |
| RVN | KawPow | −$0.33 | $0.63 | ✅ ($50M, $1.3M vol) | ❌ loses (post-exploit) |
| DOGE | Scrypt | −$4.24 | $5.62 | ✅ | ❌ current room, loses |
| KAS | kHeavyHash | −$4.84 | $3.79 | ✅ | ❌ current room, loses |
| LTC | Scrypt | −$9.21 | $0.66 | ✅ | ❌ current room, loses |
| ALPH | Blake3 | −$6.42 | $2.22 | ✅ | ❌ |
| CKB | Eaglesong | −$7.00 | $1.64 | ✅ | ❌ |

## What this means

1. **Every current room (ZEC, KAS, LTC/DOGE, XMR) is net-negative on owned
   hardware at $0.12/kWh.** Rented (the platform's actual model), they're worse —
   rental prices carry a premium on top of power.
2. **The only genuinely profitable, liquid mining at $0.12 is XMR on CPU**
   (RandomX, ~+$0.65/day per EPYC-class CPU) — and the platform already mines it.
3. **The headline "profits" (RTM +$145, ETI, XDAG) are mirages** — RTM's CoinEx
   volume is $0.04 BTC/day; you can't exit the position at the quoted price.
4. **This confirms the strategic conclusion:** mining spread is not the business
   at current prices. The game + service fee model is what the platform sells;
   mining capacity is a cost center (or a bet on coin prices).

## Caveats

- Hardware profiles are public estimates (L7 9.5 GH/s@3425W, KS5 20 TH/s@3000W,
  Z9 30 kSol/s@750W, EPYC 45 kH/s@280W, 4090 for GPU algos). Verify exact
  machines/prices before purchase decisions.
- WhatToMine difficulty/price data is live at read time but changes daily.
- Liquidity verdicts from WhatToMine exchange volume fields (24h).
- Not investment or legal advice.

---

## Re-scan 2026-08-21 (evening) — "anything worth a 2nd look?"

**Source:** free WhatToMine `coins.json` (GPU coins only — ASIC coins not covered;
license NOT commercial — research-only, never wire into the platform) + live
network data (2Miners ZEC / herominers XMR difficulty) + CoinGecko spot at read
time. BTC $78,447. Production anchors = 8/21 verified fleet rates.

### Rented fleet (platform's actual model) — today's prices

| Rig | Production (8/21) | Value today | Rental cost | Net |
|---|---|---|---|---|
| KAS KS0 PRO 200 GH/s | 1.3832 KAS × $0.02953 | $0.041 | $0.07 | **−$0.03/d** (flat) |
| ZEC z9 30.55 kSol/s | 0.002060 ZEC × $733.6 | $1.511 | $1.97 | **−$0.46/d** (was −$0.63 — best mover) |
| XMR CPU 14.25 kH/s | 0.000479 XMR × $409.5 | $0.196 | $0.64 | **−$0.44/d** (flat) |
| LTC/DOGE 7 GH/s | ≈$2.80 full credit (8/21) | ≈$2.93 | $3.46–3.90 | **−$0.53 to −$0.97/d** (DOGE +11%) |

Fleet: **≈ −$1.46 to −$1.90/day** (was −$1.76 to −$2.20).

### Owned hardware at $0.12/kWh (WhatToMine-style)

| Rig | Revenue | Power | Net |
|---|---|---|---|
| L7 9.5 GH/s scrypt (+DOGE) | $3.19 | $9.86 | **−$6.67/d** (was −$9.21) |
| KS5 20 TH/s kHeavyHash | $4.09 | $8.64 | **−$4.56/d** (was −$4.84) |
| Z9 30 kSol/s equihash | $1.48 | $2.16 | **−$0.68/d** (was −$1.33) |
| EPYC RandomX 45 kH/s | $0.62–1.18* | $0.81 | **±borderline** (was +$0.65) |

*XMR nethash estimate spread: difficulty/blocktime ≈ 6.8 GH/s (→ +$0.37/d) vs
fleet-observed-implied ≈ 12.9 GH/s (→ −$0.19/d). Network appears to have grown
since the morning scan — the margin compressed.

### GPU screen (free coins.json, 4090 @ 330W)

ERG +$0.13/d (marginal, thin volume), RVN −$0.23/d (skip holds; re-entry only
≥$0.008), ETC −$0.89/d. No new buildable candidate.

### Verdict

- **Nothing flipped positive for the rented fleet**, but ZEC narrowed the most
  (price +12%): z9 loss −$0.63 → −$0.46/d. Watch ZEC — it's the only room
  trending toward break-even.
- **XMR's owned-hardware edge may be gone** (network growth) — re-check next
  scan; rental XMR unchanged.
- **No new coin/algorithm worth opening.** Micro-caps remain the same
  illiquid mirage. RVN skip valid.
- Strategic conclusion unchanged: mining is a cost center; the business is
  service fees + the game layer. Weekly re-scan = the alert system.


---

## Price + trend addendum (same evening) — report format now includes price & trend

Kevin: "reports should include coin price and trending up/down." Every scan
from here on carries spot price + 24h/7d change per coin (CoinGecko
`/coins/markets?price_change_percentage=24h,7d`). Live at read time:

| Coin | Price | 24h | 7d |
|---|---|---|---|
| BTC | $78,381 | +8.1% | +24.8% |
| ZEC | $737.30 | +28.8% | **+49.1%** |
| XMR | $409.32 | -1.2% | +2.9% |
| LTC | $53.84 | +12.0% | +23.5% |
| DOGE | $0.0939 | +17.4% | +34.6% |
| KAS | $0.02960 | +4.8% | +17.1% |
| RVN | $0.00342 | +14.2% | +27.9% |
| ERG | $0.2667 | +10.2% | +29.5% |

**Whole market ripping (BTC +25%/week). Recomputed fleet nets (shown
arithmetic):**

| Rig | Value today | Cost | Net | 7d trend |
|---|---|---|---|---|
| KAS 200 GH/s | 1.3832 KAS x $0.02960 = $0.041 | $0.07 | **-$0.03/d** | +17% up |
| ZEC z9 | 0.002060 x $737.30 = $1.519 | $1.97 | **-$0.45/d** | +49% up up |
| XMR CPU | 0.000479 x $409.32 = $0.196 | $0.64 | **-$0.44/d** | +2.9% flat |
| LTC/DOGE | 0.007304 LTC = $0.393 + 28.69 DOGE = $2.693 to $3.086 | $3.46-3.90 | **-$0.37 to -$0.81/d** | LTC +23%, DOGE +35% up |

**Fleet approx -$1.30 to -$1.74/day** (was -$1.76 to -$2.20 this morning —
the rally improved every room; ZEC + LTC/DOGE carry the gain). Verdict unchanged
(nothing profitable yet), but the trend column is now the early-warning: if
ZEC/DOGE hold this pace, ZEC and LTC/DOGE approach break-even before the
Aug 23 audit.
