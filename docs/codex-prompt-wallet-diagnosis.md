# Codex Prompt: Diagnose "Trust Wallet shows as Rabby Wallet 2" in the wallet chooser

> Paste this block into Codex. Work in the local repo:
> /Users/cleartheclutter/dev/nexus-mining-platform. Do NOT commit, do NOT
> deploy. Investigate, add tests + a diagnostic, and REPORT the root cause.

---

## Symptom (Kevin, 2026-08-22, live site)

The sign-in wallet chooser lists TWO entries, both labeled "Rabby Wallet"
("Rabby Wallet" + "Rabby Wallet 2") with the R icon. Kevin reports the second
entry is actually his **Trust Wallet** extension. He has Rabby AND Trust
Wallet extensions installed. Trust Wallet appears misidentified as Rabby.

## What has already been tried (do NOT repeat these — they did not fix it)

1. Added EIP-6963 discovery (`eip6963:announceProvider` listener +
   `window.__eip6963Providers`, `nexus:walletsChanged` event; WalletAuth
   refreshes the chooser on arrival).
2. Identity now prefers the EIP-6963 announcement (`identityForProvider`:
   rdns `com.trustwallet.app` → trust, `io.rabby` → rabby) BEFORE flag
   matching — but the user STILL saw "Rabby Wallet 2" after deploy, which
   suggests the misidentified provider is NOT matched to an eip6963 entry by
   object identity (either it never announced, or it's a different wrapper
   object than the one that announced).
3. Reordered WALLET_IDENTITIES to check own-brand flags first
   (isTrust before isRabby) — deployed after the last report; outcome
   unknown/unverified, and hard-refresh may not have happened.

Current detection (frontend/src/wallets/providers.js):
- Collects providers from: `window.ethereum.providers[]`, `window.ethereum`,
  `window.phantom?.ethereum`, `window.coinbaseWalletExtension`,
  `window.__eip6963Providers[]` (deduped by OBJECT identity via a Set).
- `identityForProvider(provider)`: eip6963 rdns → brand id; else flag match
  from WALLET_IDENTITIES (now ordered trust, phantom, coinbase, rabby,
  metamask); else generic EIP-1193.
- Final dedupe by brand id (Map keeps first per id).

## Your task

### 1. Research the real injection behavior (ground truth, not guesses)
- How does the **Trust Wallet browser extension** inject today? Check Trust
  Wallet's docs/GitHub (`com.trustwallet.app` EIP-6963 rdns, whether it sets
  `window.ethereum`, whether it appears inside `window.ethereum.providers[]`,
  and EXACTLY which flags its provider object sets: isTrust, isMetaMask,
  isRabby, isCoinbaseWallet, isPhantom — cite sources).
- How does **Rabby** inject when OTHER wallets are installed (does Rabby
  expose other providers via its own provider list / providers[])? Does
  Rabby set isRabby on its provider?
- Explain concretely the mechanism by which Trust Wallet's provider ends up
  matching `isRabby` (or `isMetaMask`) — i.e., why our matching mislabels it.

### 2. Build a deterministic unit test harness for identity resolution
Create `frontend/src/wallets/providers.test.js` (or a plain node test under
`backend/tests/` if jsdom is not set up — CHECK what test infra exists first;
frontend currently has NO jest setup, backend does. If frontend lacks jest,
add a `frontend/src/wallets/providers.test.js` runnable via a small standalone
node script or document how to run it with the existing toolchain — do NOT add
a new heavyweight test framework to the frontend).
Cover at least:
- Rabby only (window.ethereum with isRabby) → ONE entry id 'rabby'.
- Trust only (eip6963 rdns com.trustwallet.app) → ONE entry id 'trust'.
- Rabby + Trust, both via `window.ethereum.providers[]`, Trust provider
  carrying BOTH `isTrust: true` AND `isRabby: true` (the compat-flag trap) →
  exactly TWO entries: 'rabby' and 'trust'.
- Rabby + Trust, Trust ONLY in eip6963 list, Rabby in window.ethereum →
  exactly 'rabby' + 'trust'.
- Trust with `isTrust` FALSE but eip6963 announcement present → still 'trust'
  (rdns authoritative).
- Same wallet announced via BOTH paths (same brand) → exactly ONE entry.
Make the harness mock `window` (providers, __eip6963Providers, events) so the
tests run headless.

### 3. Add a diagnostic dump (the priority deliverable)
In `frontend/src/components/WalletAuth.jsx`, when the chooser opens, log to
`console.info('[wallets]', ...)` for EACH discovered wallet: its resolved
`{id, name}`, the provider's raw brand flags (isTrust/isPhantom/isCoinbaseWallet/isRabby/isMetaMask),
whether it has an eip6963 entry and its `rdns`, and its source path
(window.ethereum / providers[] / eip6963 / brand-global). Do this in a way
that is harmless in production (console.info only, no PII). This lets Kevin
open DevTools → Console and screenshot the truth on his machine.

### 4. Determine the definitive fix
Given the research + tests, specify the exact change that guarantees Trust
Wallet is labeled "Trust Wallet" (not Rabby) on Kevin's setup, EVEN IF the
provider object carries compat flags and does not announce via eip6963.
Candidate strategies to evaluate (pick the most robust, justify with the
research):
- Order-independent flag matching: exact boolean (`=== true`) own-brand flag
  wins over compat flags; or scoring (own-brand +2, compat +1) instead of
  first-match.
- Treat `window.ethereum.providers[]` entries WITHOUT an eip6963 announcement
  as unknown-brand unless their own-brand flag is set, and only then fall
  back.
- Ask the user at connect time? (reject — UX must stay automatic)
- Anything the research reveals about Trust Wallet's actual flags.

## Constraints
- Frontend-only investigation + tests + diagnostic. Do not touch backend,
  auth endpoints, Connect flow, or production behavior beyond the chooser
  logging.
- Do not commit, do not deploy, do not restart.
- Report: (a) the concrete mechanism from the research, (b) test file +
  how to run it, (c) the diagnostic you added, (d) the recommended fix with
  exact code.
