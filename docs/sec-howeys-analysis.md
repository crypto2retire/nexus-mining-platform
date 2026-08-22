# SEC / Howey Analysis — Pre-Meeting Brief for [BRAND]

> Written 2026-08-22. **Not legal advice** — this is a factual briefing for
> discussion with counsel. Enforcement facts below were verified via federal
> court docket records (CourtListener) on this date unless marked "reported."

---

## 1. The enforcement landscape (what actually happened, docket-verified)

There is not one precedent — there are **three SEC mining enforcement actions**
plus private litigation:

| Case | Court / Docket | Filed | Status | What it was |
|---|---|---|---|---|
| **SEC v. Green United, LLC** | D. Utah, 2:23-cv-00178 | 2023-03-03 | **Summary judgment FOR the SEC (March 2025)** | Sold "green Bitcoin mining" packages — investors paid for hashrate they never controlled, could not access the machines, and marketing promised returns. The court found these were investment contracts. |
| **SEC v. Geosyn Mining, LLC** | N.D. Tex, 4:24-cv-00365 | 2024-04-24 | Civil + **criminal** (US v. McNutt, N.D. Tex, 2025-03-17) | Mining rig sales/hosting; enforcement escalated to criminal wire fraud charges against the founder. |
| **SEC v. VBit Technologies** | (SEC action, reported April 2025; settled mid-2025, reported ~$750K penalty, no admission) | 2025 | Settled | Hosted mining agreements tied to **VBit's own mining pool ("VBit Pool")** — investors had no control over rigs, expected passive income, and the SEC alleged hashrate was pooled into a pool under VBit's control. **I could not fetch the SEC's release directly (sec.gov unreachable from this network) — confirm exact allegations/amount with counsel.** |
| **Private suits against VBit** | E.D. Pa (ENNO 2022, GILL 2023, Brenen 2023, ETTAH 2024); D. Del (Eichler 2022) | 2022–2024 | — | Five investor lawsuits against VBit — **private plaintiffs do not wait for the SEC.** |

**Key context:** all three SEC actions were filed under the previous
enforcement posture. The 2025 leadership change (Crypto Task Force,
enforcement pullbacks) reduces the *probability* of new SEC mining cases —
but **Green United is a court judgment** (binding precedent in D. Utah,
persuasive elsewhere), and private class actions remain a live risk
regardless of SEC posture (see the five VBit suits).

---

## 2. Howey applied to OUR actual model

Howey = (1) investment of money, (2) in a common enterprise, (3) with
expectation of profits, (4) derived **solely/primarily from the efforts of
others**. All four must be met.

| Prong | Our model | Risk | Why |
|---|---|---|---|
| 1. Investment of money | User pays BTC for a rental + flat 5% fee | **LOW-MED** | A service payment can still count if other prongs are met — not the fight. |
| 2. **Common enterprise** | **No pooling.** Each rental is a distinct rig on MiningRigRentals (a public third-party marketplace). The pool pays each user's OWN wallet directly. We operate no pool, hold no coins, and our fee is flat (tied to rental count, NOT to user profits) | **LOW — our strongest structural defense** | VBit's fatal fact was VBit Pool (capital + hashrate pooled under promoter control). Green United pooled investor money into packages. We pool nothing and profit only from a flat service fee. |
| 3. Expectation of profits | Users do expect mining rewards | **MED — controllable** | Mining rewards are arguably compensation for the hardware's work, not "profits from an investment" (SEC's own 2019 framework: mining generally not a securities transaction when the miner controls operations). **Marketing must never promise income** — our "no promises / we show the math" copy rule is the right posture. |
| 4. Solely/primarily from efforts of others | **The crux.** Users choose coin + pool + wallet; hashrate is publicly verifiable on pool dashboards; the rental is on a public marketplace. BUT: we automate the rental and pool setup (users rely on our execution), and rentals are placed under our MRR account, not the user's | **MED — the honest weakness** | VBit/Green United investors had ZERO control and relied entirely on the promoter. We have real user agency — but the facilitation is exactly what users pay for. |

**Bottom line on the structure:** closer to legitimate hosted mining
(no pooling, no profit-sharing, real machines, user-controlled payout
address) than to VBit or Green United — but NOT "regulation free." Prong 4
carries real color because of the 5% facilitation fee and setup automation.

---

## 3. Where the research brief is WRONG (correct this before Monday)

1. **"Pooling of capital — HIGH risk."** Incorrect for this model. There is
   no pooled capital, no pooled hashrate, no shared profit pool, and no
   Nexus-controlled pool. VBit's fatal fact was a pool **under its own
   control**; we operate no pool at all. **Recommending a public third-party
   pool is categorically different from operating a pool** — like
   recommending a bank versus running a bank.
2. **"If you direct hashrate to a pool you recommend, you may be pooling
   capital."** Directing hashrate to a PUBLIC pool is not pooling capital.
   Pooling requires shared capital/hashrate/returns. (The "directing"
   language still matters for prong 4 — reliance — just not for prong 2.)
3. The risk ratings in the table overstate the model's exposure across the
   board. The underlying caution (get counsel) is correct; the specifics are
   not.

---

## 4. What actually works in our favor

- **No common enterprise** — each rental distinct; payouts per-address to
  user wallets; no Nexus pool; no pooled funds.
- **No profit-sharing** — flat 5% connection fee, booked separately; the
  pool pays the user in full. (VBit/Green United both involved promoter
  take from pooled proceeds.)
- **Real rigs on a public marketplace** — Green United's "machines" were
  never usable/controlled by investors; our rentals are real MRR orders
  users can see.
- **User control** — coin choice, pool choice (planned), payout wallet
  choice, public on-chain/pool verification.
- **Honest marketing** — no promised returns; every rig shows Mine vs Buy.
- **2025 SEC posture** — enforcement pullback and PoW-mining signals reduce
  new-SEC risk (counsel should confirm current statements; FIT21 passed the
  House in 2024 but is not law).

---

## 5. Cheap risk-reducers to implement NOW (no lawyer needed to start)

1. **User pool choice (already planned).** "Choose coin → choose pool by
   returns/size/length" is a compliance upgrade, not just a product feature:
   more user agency = less reliance on our efforts. Implement it.
2. **Fee structure: flat, one-time, % of RENTAL cost only.** Never a % of
   mined coins, never a share of rewards. Document this in ToS.
3. **Copy guardrails.** Ban "passive income," "returns," "APY,"
   "guaranteed," "investment" from all marketing. Keep "we show the math."
   (Add to landing spec constraints — see below.)
4. **Transparency per order.** Show the user their rental ID, worker name,
   and pool dashboard link so they can verify their hashrate publicly.
5. **ToS lines for counsel to bless:** "Rental of hashpower services.
   Rewards are compensation for the hardware's work. No guaranteed returns.
   You control the payout address. This is not an investment contract."
6. **No referral/affiliate compensation tied to mining outcomes** (game
   credits for streaks/referrals are fine — they're platform credits, not
   revenue shares).
7. **Structural upgrade if counsel wants more distance:** let users fund
   their own MRR account (rental placed under THEIR MRR account; we only
   configure the pool). Biggest single change; only do it if counsel says
   the reliance prong needs it.
8. **Short windows, fresh user action** — no silent auto-renewals into long
   commitments.

---

## 6. Questions for Monday's counsel (paste-ready)

1. Is a flat-fee facilitation service — where the user picks coin + pool +
   payout wallet and the pool pays the user directly — an "investment
   contract" under Howey, given Green United and VBit as adverse
   precedents?
2. Does our model have a "common enterprise"? (No pooling; distinct
   rentals; public third-party pools; direct-to-wallet payouts; flat fee
   not tied to outcomes.)
3. Does the flat 5% connection fee (not a revenue share) help or hurt the
   "efforts of others" prong?
4. What marketing language is safe ("rent mining capacity," "realistic
   returns") vs. crossing into "profits from an investment"?
5. Should ToS state "not an investment contract / rewards are compensation
   for hardware work / no guaranteed returns"?
6. If counsel thinks prong 4 still wobbles: does user-funded MRR accounts
   (we never touch the rental funds) fix it?
7. Private litigation exposure (VBit drew five investor suits): what
   disclosures, minimums, or friction reduce it?
8. Current SEC posture (Crypto Task Force, PoW statements, FIT21 status) —
   does it change the calculus?
9. Wisconsin: does charging a flat service fee implicate any state
   securities, money-transmitter, or financial-services licensing?
10. Does accepting BTC only for the 5% fee change any of the above?

---

## 7. Bottom line

- Structurally, the model is the *opposite* of VBit on the decisive facts:
  no promoter-controlled pool, no pooling of capital, no profit share,
  direct-to-wallet payouts, real marketplace rigs, and user agency.
- The honest exposure is prong 4 (reliance on our facilitation) — reduced
  by user pool choice, flat-fee structure, transparency, and ToS language.
- **It is not "regulation free."** Get counsel's opinion before public
  launch / new deposits — which is already the standing gate (REV2).
- The landing page work can continue in parallel: its copy rules (no
  promises, real numbers) are already the compliant posture. Add the
  banned-words guardrail below.
