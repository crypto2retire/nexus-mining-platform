# US Regulatory Briefing — Nexus Mining Platform (Aug 20, 2026)

> **⚠️ This is research, NOT legal advice.** No attorney–client relationship is created.
> Have a licensed securities / financial-services / gaming attorney review before
> taking the next deposit, adding game mechanics, or marketing to new users.
>
> **Verification status:** Core legal framework below is settled law (Howey 1946,
> FinCEN guidance 2013/2019, lottery test, Green United March 2025, SEC PoW mining
> statement March 20, 2025). Items marked **[VERIFY]** are 2025–2026 developments
> that could not be live-verified at research time (web tooling was down) and must
> be confirmed against primary sources.

---

## REVISION 2 (Aug 21, 2026) — corrections adopted from legal review

A second review corrected several conclusions in the original memo. Adopted
verbatim in substance:

1. **"Room 1" is NOT fully non-custodial as originally described.** The flow
   `User → Nexus → MRR/NiceHash` (user pays Nexus, Nexus purchases the rental)
   is still an intermediary payment flow — FinCEN may examine it as accepting
   and transmitting value even though no coins later flow back through Nexus.
   The cleanest flow is:
   ```
   User → MRR/NiceHash directly   (user owns the marketplace account + order)
   User → Nexus service fee separately
   Pool → User wallet directly
   ```
   Nexus should hold **limited API authority to configure** the rental (no
   withdrawal permission). A second-best model is Nexus selling a complete
   **fixed-price mining service as principal** (one fixed price, Nexus procures
   compute, delivers hashpower to the user's pool endpoint) — that supports a
   merchant/service argument but is still a cloud-mining product needing specific
   legal analysis, and must NOT be described as "facilitating" someone else's
   rental.
2. **"Session markups are pure platform margin" is economically true but
   legally wrong as stated.** If a user pays for a session and receives whatever
   crypto a rig generates, that is still a cloud-mining service — direct pool
   payment removes custody but does NOT automatically remove the
   investment-contract question. Sell sessions as: a specific quantity of
   hashpower, a specific algorithm and duration, a disclosed pool destination,
   no promised revenue, no managed reinvestment, no pooled performance, no
   representation that the purchase will recover its cost. **Measureable
   compute — not an income product.**
3. **"Platform-owned production is 100% legal" is too absolute.** Correct
   language: *lower regulatory risk*. Legality still depends on marketplace and
   hosting terms, state/local rules, tax and accounting treatment, sanctions
   exposure, how coins are sold, environmental/utility rules, and whether
   production supports prizes or promised returns.
4. **"Funded from platform revenue" does not by itself make a sweepstakes
   lawful.** A sweepstakes must have a genuine free method of entry; purchases
   must not improve odds; free and paid entrants must be treated equivalently;
   official rules must state eligibility, odds, prizes, dates; prohibited states
   must be excluded; required registrations/bonds handled; and the game must be
   visually and operationally separated from rental purchases. If streaks,
   referrals, or rental purchases increase jackpot odds, the separation fails.
5. **Green United is distinguishable, not a death sentence.** It involved
   alleged fake mining (boxes that didn't mine the promised token), expected
   token appreciation, promoter-managed operations, and return claims. Nexus
   improves its position when: real hashpower is demonstrably delivered, the
   user controls the rental and pool destination, rewards come from the genuine
   network, Nexus makes no token/appreciation promises, Nexus does not pool
   returns, and marketing emphasizes service specifications and risks.
6. **The P/L paragraph was NOT supportable as written.** Corrected below with
   live data and explicit provenance.

### Corrected live P/L (Aug 21, 2026, ~03:30 UTC — data as of read time)

Sources: live pool unpaid balances (2Miners/HeroMiners), F2Pool settlement
screenshot, `rig_rentals.cost_btc` from the deployment DB, CoinGecko prices at
read time. **This is a read-time snapshot, NOT a settled reconciliation — do not
use in investor/legal/strategy documents until rental costs are reconciled
against pool earnings at contemporaneous prices.**

| Room | Mined/day (live) | Rental cost/day | P/L/day |
|---|---|---|---|
| ZEC | $1.64 | $2.77 (z9 $2.12 + test $0.65) | **−$1.13** |
| XMR | $0.12 | $0.69 | **−$0.57** |
| KAS | $0.07 | $0.08 | **−$0.01** |
| LTC+DOGE | $3.79 *extrapolated* | $3.76 | **+$0.03** *(unverified)* |
| **TOTAL** | $5.61 | $7.29 | **−$1.68/day** |

Caveats:
- LTC/DOGE is **extrapolated from a partial F2Pool settlement** (~7.7h of full
  rate; no on-chain payout has ever landed) — treat as unverified.
- ZEC test rig (#5699114) ends Aug 21 05:19 UTC; after that ZEC cost drops to
  $2.12/day → ZEC ≈ −$0.48/day.
- XMR unpaid is small and noisy (rig started Aug 20 04:29); hashrate 12 KH/s.
- KAS unpaid 3.03 KAS over ~31h → ~2.34 KAS/day ≈ $0.07/day.

**The fleet is net-negative at current prices/difficulty.** This is exactly why
the strategy matters: mining spread is NOT the business — service fees,
company-owned mining, and the game layer are.

---

## 1. THE BIG PICTURE (plain English)

The platform as currently designed sits under **four separate regulatory lenses**,
each of which can independently stop the business:

| # | Lens | Risk now | What triggers it |
|---|------|----------|------------------|
| A | **Securities (SEC)** — is a "virtual rig" an investment contract? | **HIGH (probable security)** | Users deposit money → pooled treasury → platform rents rigs and does all the work → users expect profits. Textbook *Howey*. |
| B | **Money transmission (FinCEN + states)** | **HIGH** | Platform holds user USDC in its own wallet + internal ledger, and pays out coins from platform wallets. Custody = transmission. |
| C | **AML/KYC (BSA)** | **HIGH** | Unregistered MSB + zero KYC + privacy coins (XMR/KAS) = the exact profile FinCEN/DOJ prosecute. |
| D | **Gambling/lottery (state + federal)** | **HIGH for jackpot as designed** | Daily jackpot with tickets from paid activity = prize + chance + consideration = illegal lottery. |

**The single most important fact:** the **custodial design** (users send USDC to a
platform wallet; platform keeps balances; payouts come from platform wallets) is
what triggers B and C. **The pooled-rewards design** (all money into one treasury,
platform operates everything, users get coin payouts) is what triggers A.
**The jackpot design** (tickets from purchases) is what triggers D.
Each one is fixable by restructuring — but only if done deliberately, and the
fixes interact.

---

## 2. SECURITIES (SEC) — "virtual rig" = investment contract?

### The Howey test (SEC v. W.J. Howey Co., 328 U.S. 293 (1946))
A security exists when there is:
1. **Investment of money** — ✅ users deposit USDC
2. **Common enterprise** — ✅ all money pooled into one treasury; rewards from the pool
3. **Expectation of profits** — ✅ users buy "virtual rigs" to receive daily mined coins
4. **Efforts of others** — ✅ the platform selects rigs, rents hashrate, manages mining, distributes payouts; users do nothing

All four prongs are cleanly met. Courts apply Howey to crypto products
repeatedly: *SEC v. Telegram* (2020), *SEC v. Ripple* (2023), *SEC v. Green
United* (D. Utah, summary judgment **March 11, 2025** — mining hardware + promised
operator-run mining = securities), *SEC v. Garza* (GAW Miners "hashlets", 2015),
*SEC v. Giga Watt* (2018, tokens + mining packages).

### The March 20, 2025 SEC mining statement — and why it does NOT save the platform
The SEC Division of Corporation Finance (with the Crypto Task Force) issued a
**"Statement on Proof-of-Work Mining"** (March 20, 2025; sec.gov URL:
/newsroom/speeches-statements/staff-statement-proof-work-mining-032025) [VERIFY].
It says PoW **mining** — specifically **solo mining** and **mining pools where
participants contribute their own hashrate** — does not involve the offer and
sale of securities. Commissioner Peirce's companion speech "Mining in America"
made the same day framed mining as an industrial activity.

**The decisive point:** the statement's pool analysis assumes participants
**contribute their own computational power**. Nexus users contribute **money** to
a **third party** that rents hashrate and distributes rewards — users contribute no
mining activity at all. The statement does not bless cloud-mining middlemen,
"virtual rigs," or any promoter-run pooled mining scheme. *Green United* (same
week, same month) shows courts still apply Howey to mining products.

### What this means
- **Verdict: the current model is probably a security** (researchers estimate
  75–85% under Howey as courts apply it).
- Non-registration consequences: SEC enforcement (disgorgement, penalties),
  **rescission liability to every purchaser** (§12 of the '33 Act), fraud claims
  (§17(a), Rule 10b-5) if marketing overstates returns, Wisconsin blue-sky
  liability (Wis. Stat. ch. 551), possible wire-fraud referral if deceptive.

### Legal paths (each has real costs)
1. **Restructure to "service, not investment"** — users' coins pay directly to
   each user's own wallet from the pool; no pooling of rewards through the
   platform; no return promises; fixed-fee service framing. Weakens prongs 3–4.
   (This also helps money transmission — see §3.)
2. **Regulation A+ (Tier 2)** — up to $75M/12mo, allows some retail, requires SEC
   qualification + ongoing reporting. The only realistic path for broad US retail
   as a securities offering — and it means full financial disclosure, audits.
3. **Reg D 506(c)** — accredited investors only, verified. Kills retail.
4. **Regulation S** — non-US persons only. Doesn't help US users.

---

## 3. MONEY TRANSMISSION + AML/KYC (FinCEN, states, BSA)

### Federal: this IS money transmission
- 31 C.F.R. § 1010.100(ff)(5)(i)(A): money transmission = **"the acceptance of
  currency, funds, or other value that substitutes for currency from one person
  and the transmission of currency, funds, or other value that substitutes for
  currency to another location or person."**
- FinCEN guidance FIN-2013-G001 (2013) and FIN-2019-G001 (2019): convertible
  virtual currency (incl. USDC) is "value that substitutes for currency."
- **Nexus accepts USDC into its own treasury wallet, credits internal balances,
  and transmits mined coins out of platform wallets to users.** That is
  acceptance + transmission. **There is no de minimis** — 4 users × $85 still
  counts.
- Unlicensed money transmission is a **federal felony** (18 U.S.C. § 1960).

### State: licenses nearly everywhere
- **New York:** BitLicense (23 NYCRR Part 200) — receiving VC for transmission +
  custody both covered. Serving NY users requires it.
- **California:** Money Transmission Act + **Digital Financial Assets Law
  (DFAL)** operative **July 1, 2025** [VERIFY].
- **Wisconsin:** Wis. Stat. ch. 217 license (WI Dept. of Financial Institutions).
- **40+ states** have adopted the CSBS Money Transmission Modernization Act
  (MTMA), treating virtual currency as transmittable value.

### AML/KYC (Bank Secrecy Act) — applies TODAY
As an MSB the platform must:
- **Register with FinCEN** (Form 107) within 180 days of commencing business
- Maintain a **written AML program** (officer, training, independent review)
- File **SARs** for suspicious activity ≥ **$2,000** within 30 days
- Comply with the **travel rule** at **$3,000** transmittals (pass originator/
  beneficiary info)
- Screen **OFAC** sanctions

Zero KYC makes SAR/travel-rule/OFAC compliance **impossible** — regulators treat
zero-KYC as BSA non-compliance. Enforcement proof points: FinCEN v. Ripple
($700K), FinCEN v. BTC-e ($110M), FinCEN v. Harmon ($60M), DOJ prosecutions of
Bitcoin Fog (convicted 2024), Samourai (charged 2024) [VERIFY statuses].

### ⚠️ XMR (Monero) is a self-inflicted red flag
Privacy-coin payouts can't be traced on-chain — elevated AML risk, delisted by
major exchanges, looks like deliberate evasion to examiners. **Seriously consider
dropping XMR payouts** (and review KAS).

---

## 4. GAMBLING / LOTTERY — the game mechanics

### The test: illegal lottery = Prize + Chance + Consideration
- **Prize:** redeemable USDC ✅
- **Chance:** BTC-block-hash draw ✅
- **Consideration:** tickets earned from deposits/purchases ✅

**The jackpot as designed (tickets from paid activity) is an illegal lottery** in
Wisconsin (Wis. Const. Art. IV § 24 bans lotteries; Wis. Stat. ch. 945) and most
states. "Funded from platform margin" does NOT cure it — consideration is what the
**player gives**, not what the operator funds.

### Federal exposure once state law is violated
- **IGBA (18 U.S.C. § 1955):** operating an illegal gambling business — 5+ people
  involved + 30+ days or $2,000/day gross. A live platform qualifies instantly.
- **Travel Act (18 U.S.C. § 1952):** using interstate facilities (the internet)
  to further unlawful gambling.
- **RICO (18 U.S.C. § 1961):** private civil suits by aggrieved users.
- **UIGEA (31 U.S.C. §§ 5361–5367):** doesn't criminalize operators directly but
  forces payment processors to refuse — the business-killing consequence.
- The **Wire Act** (18 U.S.C. § 1084) applies only to sports betting post-2019 —
  not a factor here, and keep it that way.

### What the research says per mechanic (before redesign)

| Mechanic | Risk as designed | Why |
|---|---|---|
| **Daily jackpot, tickets from paid activity** | 🔴 **HIGH — do not launch** | Prize + chance + consideration = illegal lottery |
| **Weekly league, cash prizes, pay-to-win** | 🔴 HIGH / 🟡 MEDIUM | If winners correlate with spend → consideration |
| **Daily claim streak (deterministic USDC)** | 🟢 **LOW** | No chance, no entry fee — loyalty/marketing |
| **Referral bonuses (deterministic, single-level)** | 🟢 **LOW** | Standard affiliate marketing; avoid MLM shape |

### The legal redesign (keeps the fun, cuts exposure)
1. **Jackpot → free-entry sweepstakes:** tickets ONLY from free actions (daily
   login, quiz, social follow). **Purchases grant zero tickets and zero odds
   advantage.** Publish formal rules ("no purchase necessary"), provide a true
   free entry method, geo-block hostile states, register in NY/FL/RI above prize
   thresholds.
2. **Weekly league → deterministic skill contest:** fixed hashrate for all
   entrants, prize by user-controlled metrics (uptime, efficiency), no
   randomness, free entry.
3. **Streaks + referrals:** keep as deterministic marketing; never tie to chance;
   single-level referrals only.
4. **Economy separation (Phillips v. Double Down, Kater v. Churchill Downs —
   9th Cir. 2018):** purchased play currency must never be redeemable; only
   earned value (real mining yield, sweepstakes winnings) is redeemable. If users
   can buy → convert to tickets → win USDC, it's a casino.

### State landmines
- **Washington** — strictest test in the country ("material degree" of chance).
  **Geo-block regardless of design.**
- **Wisconsin** — constitutional lottery ban; consideration-bearing chance
  schemes are illegal.
- **Michigan** — active sweepstakes-casino enforcement (VGW litigation).
- **NY/FL/RI** — promotional sweepstakes registration above ~$5,000 prize pools.
- **Texas** — hostile to chance-based prizes (AG Op. KP-0047, 2016).
- **Florida** — federal "internet café" prosecutions; sham sweepstakes draw
  federal attention.

---

## 5. WHAT TO DO (prioritized)

1. **Engage counsel NOW.** Securities/FinTech attorney (for A/B/C) + gaming
   attorney (for D). This briefing is a starting point, not the answer.
2. **Decide the structural model before building more:**
   - **Option 1 — Non-custodial service model** (biggest risk reduction, cheapest):
     user coins pay out **directly to each user's wallet from the pool**; platform
     never holds customer value; fixed-fee service framing; no pooled
     redistribution; no return promises. Kills most of A, B, C.
   - **Option 2 — Custodial + licensed**: FinCEN MSB registration, AML program,
     KYC, state licenses per state, segregated customer assets. Expensive
     (months, six figures).
   - **Option 3 — Reg A+ securities offering**: if you keep the pooled-rewards
     model, this is the compliant retail path — with full disclosure obligations.
3. **Do not launch the jackpot as designed.** If the game layer must ship first,
   ship **streak + referrals only** (low risk) and redesign the jackpot as a
   free-entry sweepstakes with attorney sign-off.
4. **Drop or de-emphasize XMR payouts** (privacy-coin AML red flag).
5. **Geo-block Washington + Michigan** (at minimum) until licensed/cleared.
6. **Stop taking new USDC deposits until counsel weighs in** — every deposit
   today is a data point in a future rescission/enforcement case.

---

## 6. CITATIONS (verify current status before relying)

**Securities:** *SEC v. W.J. Howey Co.*, 328 U.S. 293 (1946); *SEC v. Glenn W.
Turner Enters.*, 474 F.2d 476 (9th Cir. 1973); SEC DAO Report (Release 81207,
2017); SEC Framework for Investment Contract Analysis (Apr 2019); SEC Division of
Corporation Finance, Statement on Proof-of-Work Mining (Mar 20, 2025) [VERIFY];
Peirce, "Mining in America" (Mar 20, 2025) [VERIFY]; *SEC v. Green United*, D.
Utah No. 2:23-cv-158 (summ. j. Mar 11, 2025) [VERIFY]; *SEC v. Garza* (2015);
*SEC v. Giga Watt* (2018); *SEC v. BitConnect* (2021; $2.4B, 2022); *SEC v.
Telegram* (2020); *SEC v. Ripple* (2023); Securities Act §§2(a)(1), 5, 12, 17(a);
Exchange Act §§3(a)(10), 5, 10(b), 15(a).

**CFTC/commodity pool:** CEA §§1a(9), 1a(11), 4m(1); 17 C.F.R. §§1.3(10),
1.3(cc), 4.13(a)(3) (de minimis: ≤15 participants, <$400K, no marketing); *CFTC
v. McDonnell* (2018); *CFTC v. Gelfman* (2018); *CFTC v. MTI* (2022).

**Money transmission/AML:** 31 U.S.C. §§5312, 5330; 31 C.F.R. §§1010.100(ff),
1022.210, 1022.320, 1022.380, 1010.410(e); FIN-2013-G001; FIN-2019-G001; 18
U.S.C. §1960; NY 23 NYCRR Part 200 (BitLicense); Cal. Fin. Code §§2000+ and DFAL
§§3100+ [VERIFY operative status]; Wis. Stat. ch. 217; CSBS MTMA.

**Gambling/lottery:** 18 U.S.C. §§1084, 1952, 1955, 1961; 31 U.S.C. §§5361–5367;
*FCC v. ABC*, 347 U.S. 284 (1954); *N.H. Lottery Comm'n v. Barr*, 945 F.3d 503
(5th Cir. 2019); *Phillips v. Double Down Interactive*, 899 F.3d 1061 (9th Cir.
2018); *Kater v. Churchill Downs*, 886 F.3d 784 (9th Cir. 2018); Wis. Const. Art.
IV §24; Wis. Stat. chs. 945, 563; RCW 9.46 (WA); NY Gen. Oblig. Law §369-e; Fla.
Stat. §849.094; R.I. Gen. Laws §11-50-2; Tex. Penal Code ch. 47; VGW v. Michigan
MGCB (Mich. Ct. Cl. 2024) [VERIFY appeal status].

---

*Prepared by Hermes research agents for Kevin. Not legal advice. Verify all
2025–2026 items with counsel before relying.*
