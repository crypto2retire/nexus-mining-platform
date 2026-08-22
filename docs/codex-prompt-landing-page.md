# Codex Prompt: Nexus Landing Page (SEO static page at /)

> Paste this block into Codex. Work in the local repo:
> /Users/cleartheclutter/dev/nexus-mining-platform. Do NOT commit, do NOT
> deploy. Implement the page + server routing + build changes, run the full
> test suite + production build, and report.

---

## Purpose (Kevin 2026-08-22)

A public landing page for Nexus: describes the app, has strong SEO, and
explains why renting miners can be better than buying. **Copy rules (Kevin's
standing rules, non-negotiable): no promises, no expectations, no fake
stories, no fabricated numbers, no superlatives ("best"/"only").** Only the
reasons below — they are the real reasons from the product history.

## Architecture

- Vite **multi-page build**: `frontend/index.html` (the existing SPA app) +
  `frontend/landing.html` (the new landing page). Configure
  `build.rollupOptions.input = { main: index.html, landing: landing.html }`.
- The landing page is **static HTML + CSS only** (no React) — crawler-friendly,
  loads instantly, no JS needed to read it.
- Server routing (express, `backend/server.js`):
  - `GET /` → serve `frontend/dist/landing.html`
  - `GET /app` → serve the SPA (`frontend/dist/index.html`)
  - All `/api/*` routes unchanged.
  - The SPA's assets (dist/assets/*) must still load — keep the same static
    middleware, mounted so both pages can use it.
- Add a simple in-page anchor nav (no routing library): Why rent / Why mine
  / Taxes / How it works / Get Bitcoin / FAQ.
- Match the existing dark theme (use the SPA's CSS variables as inspiration:
  #0b0d12 bg, #141820 surface, #22d3ee accent — but self-contained CSS in the
  landing page; do NOT import the SPA bundle).

## Copy (write it EXACTLY as below — do not "improve", reword, or add claims)

### <title> + meta

```html
<title>Nexus — Rent Real Mining Hashrate, Paid Directly to Your Wallet</title>
<meta name="description" content="Rent real mining hashrate for as little as a few dollars. No hardware, no pool setup — Nexus connects a real miner to your wallet and the pool pays you directly. Start with Bitcoin." />
<meta name="robots" content="index,follow" />
<link rel="canonical" href="https://nexusmining.app/" /> <!-- adjust to the real domain when known -->
```

Open Graph (og:title, og:description, og:type=website) + Twitter card tags mirroring
the title/description.

### Hero

- H1: **Rent mining hashrate. Get paid straight to your wallet.**
- Sub: Nexus finds a real miner to rent, connects it to a properly configured
  pool, and points it at your payout address. No hardware to buy. No pool
  accounts to open. No middleman holding your mined coins.
- Primary CTA button: **See live miners** (anchor to #how-it-works)
- Secondary CTA: **How to get Bitcoin** (anchor to #get-bitcoin)

### Section: Why rent instead of buy (#why-rent)

Intro: We looked at buying mining hardware and decided renting makes more
sense for most people starting out. Here is why.

- **No thousands of dollars upfront.** Mining ASICs cost real money — top
  machines run into the thousands. Renting starts at a few dollars for a day
  of hashrate.
- **No power, heat, or noise.** Rented rigs run in the host's facility. You
  never deal with electricity costs, cooling, or fan noise.
- **No maintenance.** Rigs break, firmware needs updating, and ASICs lose
  value as network difficulty rises. With a rental, the window ends and
  you're done.
- **Try before you commit.** Rent an hour or a day of Kaspa, Zcash, Bitcoin,
  or Litecoin/Dogecoin hashrate and see real payouts before deciding anything
  bigger.
- **No resale risk.** Hardware prices drop when difficulty climbs. A rental
  has no resale value to lose.

Honest counterbalance (must appear, word-for-word intent):

> Renting usually costs more than the raw hardware math — that is the
> tradeoff for flexibility. Right now, at market prices, mining most coins
> costs MORE than simply buying them. We show you that number on every rig
> ("Mine vs Buy"). We would rather you see the real math than promise a
> profit that is not there.

### Section: Why mine instead of buy-and-hold (#why-mine)

Intro: Buying and holding is not the only way to get crypto. Mining is a
different way to accumulate coins, and some people prefer it. Here is why —
none of it is a promise of profit.

- **You get coins an exchange cannot sell you.** Some mineable coins —
  Kaspa is the big one — are not available on major US exchanges. Mining is
  one of the only ways to hold them.
- **Coins go straight to your wallet.** Payouts come from the pool to the
  payout address you provide. No exchange holds your coins, no middleman
  sits between you and what you mine.
- **You accumulate in small, regular amounts.** Instead of timing one big
  purchase, you earn coins continuously as payouts cross each pool's floor —
  a form of dollar-cost averaging that happens automatically.
- **You set your own cost basis by mining.** Your tax basis is the fair
  market value on the day the pool pays you — not an exchange price you
  have no control over.

### Section: Taxes (#taxes)

Intro: Mining can have a different tax treatment than buying — which is an
advantage for some people, especially anyone running crypto as a business.
This is general information, NOT tax advice: **always consult an
accountant** about your situation, and tax rules for crypto are changing.

- **Mining costs can be deductible.** If you mine as a business, the costs
  of producing coins — hashrate rentals, electricity, hardware, internet —
  are business expenses that can offset mining income (e.g., Schedule C).
  Renting hashrate is a simpler paper trail than buying and depreciating
  hardware.
- **Mined coins are income at fair market value on the day you receive
  them.** The pool payout is ordinary income at the coin's price that day,
  and that price is your tax basis for later sales.
- **A later sale below that basis is a capital loss.** Losses can offset
  other capital gains, which can soften the tax hit from other investments.
- **No wash-sale rule for crypto (as of now).** Unlike stocks, you can sell
  a coin and immediately repurchase it without losing the loss deduction.
  This may change — new broker-reporting rules are rolling out.
- **Keep records.** Pool statements, payout addresses, and the price of each
  coin on each payout day are what an accountant needs to file correctly.

### Section: How it works (#how-it-works)

1. **Get some Bitcoin.** The rental marketplace Nexus uses
   (MiningRigRentals) requires BTC to fund rentals. Venmo, CashApp, or
   Phantom are the easiest ways to buy it (see the next section).
2. **Pick a miner to rent.** See live rigs with real numbers: hashrate,
   cost per day, net profit/loss at current prices, break-even price, and
   mine-vs-buy.
3. **We connect it — to your wallet.** Nexus rents the rig and points it at
   a properly configured, wallet-only pool (Kaspa on HeroMiners, Zcash on
   2Miners, Bitcoin on Ocean). Your payout address is the worker. Nexus
   charges a flat 5% connection fee.
4. **The pool pays you directly.** When your mining crosses the pool's
   payout floor, the pool sends the coins straight to your wallet. Nexus
   never holds them.

### Section: How to get Bitcoin (#get-bitcoin)

- **Phantom** — buy Bitcoin with Apple Pay or Google Pay (identity
  verification required). The easiest option if you are starting from zero.
- **Venmo or CashApp** — buy Bitcoin there, then transfer it to Phantom,
  Rabby, or Trust Wallet — the wallets you connect to Nexus and receive
  payouts in.
- Your BTC funds the rental on MiningRigRentals; mined coins land in the
  payout wallet you provide.

### Section: Real numbers, no promises (#real-numbers)

- Every rig shows live market math: cost per day, expected production,
  net/day, break-even price, and Mine vs Buy.
- Market conditions change daily. Mining can cost more than buying — we do
  not promise profits, we show the numbers.
- Past results are not a promise of future results.

### FAQ (#faq) — visible + FAQPage JSON-LD (same Q&A in both)

1. **Do I need to buy a mining machine?** No. Nexus rents real hashrate for
   fixed windows (as short as a day) on MiningRigRentals. You never own or
   maintain hardware.
2. **Where do my mined coins go?** Directly to the payout address you
   provide. Nexus uses wallet-only pools (Kaspa/HeroMiners, Zcash/2Miners,
   Bitcoin/Ocean), and the pool sends your coins to your wallet when they
   cross the payout floor.
3. **Why do I pay with Bitcoin?** The rental marketplace Nexus uses funds
   rentals in BTC. Buy it with Venmo, CashApp, or Phantom, or transfer it
   from an exchange into Phantom, Rabby, or Trust Wallet.
4. **What can I mine?** Kaspa, Zcash, and Bitcoin through the self-custody
   connect flow, plus Litecoin/Dogecoin through the platform's own mining.
5. **What is the 5% fee?** A flat connection fee for finding the miner,
   setting up the rental, and pointing it at a correctly configured pool.
   The mined coins themselves go to you in full.
6. **Is this cloud mining?** Not in the traditional sense. You are renting
   real hashrate on a real marketplace for a fixed window — not buying a
   share of a miner you do not control and being promised a return.
7. **Do you promise returns?** No. We show the current market math on every
   rig. Mining can cost more than buying, and we want you to see that before
   you spend anything.
8. **Are there tax advantages to mining instead of buying?** Possibly —
   mining costs can be deductible business expenses, mined coins are taxed
   as income at their value on the day you receive them, and a later sale
   below that value can be a capital loss that offsets other gains. This is
   general information, not tax advice: consult an accountant.
9. **Is mining or buying cheaper right now?** At current market prices,
   mining most coins costs more than buying them. We show the exact
   mine-vs-buy number on every rig so you can decide for yourself.

### Footer

- Product: Nexus Mining Engine. Virtual cloud-mining accounting layer; no
  native token; 5% connection fee.
- Links: Why rent / Why mine / Taxes / How it works / Get Bitcoin / FAQ
  (same-page anchors).
- Honest line: "Cryptocurrency mining is risky and may lose money. Nothing
  on this page is financial advice or a promise of returns."
- Domain placeholder comment for the canonical URL.

## SEO requirements

- One H1 per page, natural keyword phrasing (no stuffing): "rent mining
  hashrate", "rent bitcoin miner", "hashrate rental", "mine without buying
  hardware", "self-custody mining", "Kaspa/Zcash/Bitcoin mining rental",
  "cloud mining alternative", "paid directly to your wallet", "mine instead
  of buy", "crypto mining tax advantages".
- FAQPage JSON-LD schema (same Q&A text as the visible FAQ).
- Organization + WebSite JSON-LD (name Nexus Mining Engine, no invented
  addresses/phone numbers — omit contact info entirely rather than fake it).
- Semantic HTML5 (header/main/section/footer, h1-h3 hierarchy).
- Responsive: same standards as the app (works on phones/tablets/desktop;
  no horizontal overflow; anchor nav wraps or scrolls).

## Constraints

- Do NOT touch: auth, deposits, withdrawals, game, operator pipeline,
  Connect flow, payout trigger, backing monitor, database.
- Do NOT change existing SPA behavior — only add the landing page + routes.
- No new npm dependencies. No fabricated numbers, testimonials, awards, or
  contact info.
- Full Jest suite must stay green (currently 225 tests / 24 suites) +
  `npm run build` (multi-page) + `git diff --check`.
- Do NOT commit, do NOT deploy, do NOT restart.
- Report: files changed, build output, and any assumption you had to make.
