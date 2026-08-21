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
