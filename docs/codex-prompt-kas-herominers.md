# Codex Prompt: Switch KAS Room from 2Miners to HeroMiners Pool

> Paste the block below into Codex. Work in the local repo:
> `/Users/cleartheclutter/dev/nexus-mining-platform` (backend code under `backend/`).
> Do NOT commit. Do NOT deploy — deployment, .env, and the payout-baseline
> reset are done by the operator after review.

---

## Task

Switch the Nexus platform's KASPA room from the 2Miners pool to the HeroMiners
Kaspa pool. The goal is a **50x faster payout cycle**: 2Miners' minimum is
50 KAS (~36 days at this hashrate); HeroMiners' minimum is **1 KAS (~18 hours)**.

All pool facts below were verified live on 2026-08-21 against the live pool:

- Pool API: `https://kaspa.herominers.com/api/stats_address?address=<wallet>` (route exists; returns `{"error":"Not found"}` for wallets with zero shares — same behavior as the XMR pool before mining starts)
- Stratum host: `de.kaspa.herominers.com`, port **1207** (the `/api/stats` config lists port 1207 as `IceRiver KS0-KS0 PRO&Ultra` — exactly our rental rig class)
- Minimum payout: **1 KAS**, fee 0.9%
- Platform KAS wallet (unchanged): `kaspa:qrdpuucrld27uu0zvkxnhhhxtg2tr23dlknqqg65pa2740lxqqqqgg4qruwnn`

## Exact changes

### 1. `backend/services/payoutTrigger.js`

**a) `WATCHES.KASPA`** — change:

```js
  KASPA: {
    // Same as ZEC: unpaid accrues in atoms, pool pays when it crosses 50 KAS.
    mode: 'unpaid-drop',
    minPayout: PAYOUT_MIN.KASPA,
    walletEnv: 'MRR_PLATFORM_WALLET_KAS',
    accountUrl: (addr) => `https://kas.2miners.com/api/accounts/${addr}`,
    statsUrl: 'https://kas.2miners.com/api/stats',
    balanceOf: (d) => Number(d?.stats?.balance ?? d?.balance ?? 0) / 1e8,
    netHashOf: (d) => Number(d.nodes?.[0]?.networkhashps) || null,
  },
```

to:

```js
  KASPA: {
    // HeroMiners (switched from 2Miners 2026-08-21): unpaid accrues in the
    // account API and the pool pays when it crosses 1 KAS (verified on
    // kaspa.herominers.com). VERIFY the /1e8 sompi divisor against the pool
    // website's displayed unpaid once the first shares land.
    mode: 'unpaid-drop',
    minPayout: PAYOUT_MIN.KASPA,
    walletEnv: 'MRR_PLATFORM_WALLET_KAS',
    accountUrl: (addr) => `https://kaspa.herominers.com/api/stats_address?address=${addr}`,
    statsUrl: null,
    balanceOf: (d) => Number(d?.stats?.balance ?? d?.balance ?? 0) / 1e8,
    netHashOf: () => null,
  },
```

**b) `PAYOUT_MIN.KASPA`** — change the default from `50` to `1` and update the
source comment (it currently says "KASPA 50 KAS (2Miners, verified live)"):

```js
  KASPA: Number(process.env.KASPA_MIN_PAYOUT || 1),
```

**c) Header comment** (top of file): the paragraph starting
`*   balance-delta : ZEC/KAS at 2Miners` is stale — KAS no longer uses 2Miners.
Update the comment to say ZEC watches 2Miners (balance-delta/unpaid-drop as
already documented) and KAS watches HeroMiners unpaid-drop at 1 KAS minimum.

### 2. `backend/services/roomHash.js`

**a) `ACCOUNT_URL` map** — change the KASPA entry:

```js
  KASPA: (addr) => `https://kas.2miners.com/api/accounts/${addr}`,
```

to:

```js
  KASPA: (addr) => `https://kaspa.herominers.com/api/stats_address?address=${addr}`,
```

**b) The KAS branch in `fetchLiveRealHash`** — it currently reads
`data.currentHashrate`, which the HeroMiners stats_address API does NOT return
(it returns `stats.hashrate_1h`, like the XMR pool). The final fallback branch:

```js
  // ZEC / KAS: the pool wallet API reports the ACTUAL landing hashrate.
  const data = await fetchPoolAccount(pool);
  if (!data || data.currentHashrate == null) return null;
  const h = Number(data.currentHashrate);
  return pool === 'ZCASH' ? h / 1e3 : h / 1e9; // H/s -> KH/s | GH/s
```

must become KAS-aware. Add a KASPA branch BEFORE the ZEC/KAS fallback (mirror
the XMR branch's field precedence), converting H/s -> GH/s (/1e9):

```js
  if (pool === 'KASPA') {
    const data = await fetchPoolAccount(pool);
    const h = data?.stats?.hashrate_1h ?? data?.stats?.hashrate ?? data?.stats?.hashrate_24h;
    if (h == null) return null;
    return Number(h) / 1e9; // H/s -> GH/s
  }
```

Leave the ZEC fallback exactly as it is (2Miners `currentHashrate` is still
correct for ZEC). Update any comments that say KAS reads 2Miners.

### 3. Tests

**a) `backend/tests/payoutTrigger.test.js`**
- Line 42: `expect(WATCHES.KASPA.minPayout).toBe(50);` → `expect(WATCHES.KASPA.minPayout).toBe(1);`
- The KASPA `balanceOf` test (stats.balance `'125011636'` → `1.25011636`) stays
  numerically identical — update its comment to say the divisor (1e8 sompi) is
  confirmed from the HeroMiners account API.
- Add an assertion that the KASPA `accountUrl` contains
  `kaspa.herominers.com/api/stats_address` (mirror the existing XMR test).

**b) `backend/tests/backingMonitor.test.js`**
- The axios mock at line ~64 currently keys on `url.includes('kas.2miners.com')`
  and returns `{ balance, currentHashrate }`. Change it to key on
  `url.includes('kaspa.herominers.com')` and return the HeroMiners shape:
  `{ stats: { balance: '120591854', hashrate_1h: '207685529691' } }`
  (balance in sompi → 1.2059 KAS after /1e8; hashrate in H/s → 207.69 GH/s
  after /1e9 — the existing assertions at lines 92–96 stay valid).

### 4. `.env.example`

Add (or update) `KASPA_MIN_PAYOUT=1` alongside the other payout thresholds.
Do NOT touch the live `.env` — the operator handles that at deploy.

## Constraints

- No schema/migration changes. No new dependencies.
- Do NOT touch: auth, deposits, payouts for other rooms (ZCASH, XMR,
  LTC_DOGE), rentals, reward ledger, game code, migrations 001–023.
- Keep the existing test suite green (currently ~147 tests). Run the full
  suite + `git diff --check` and report results.
- Do NOT commit, do NOT deploy, do NOT restart anything.

## Operator step you should hand back (paste-ready for Kevin)

Create the new MRR pool profile in the MiningRigRentals web UI
(miningrigrentals.com → My Account → Pool Profiles → New):

- **Name:** Nexus-KAS-HeroMiners
- **Host:** `de.kaspa.herominers.com`
- **Port:** `1207`
- **Username:** `kaspa:qrdpuucrld27uu0zvkxnhhhxtg2tr23dlknqqg65pa2740lxqqqqgg4qruwnn`
- **Password:** `x`
- **Algorithm:** KHeavyHash

Report the new profile ID back. (MRR v2 has NO pool-profile API — verified
2026-08-21: `/info/pools`, `/pool`, `/pools`, `/pool/<id>` all return "No
Endpoint". The profile must be created in the web UI.)
