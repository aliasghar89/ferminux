# Ferminux DEX — web app

The trading front end for the Ferminux AMM (`../contracts`) on the Ferminux
Network, chain **3961**, native coin **FMX**.

Vite + React 18 + TypeScript + ethers v6. One bundle, no CDNs, no analytics, no
backend: every number on the page is read from the chain over JSON-RPC, and the
build fails if any external URL sneaks into `dist/`. `base` is `./`, so the same
`dist/` serves from `https://dex.ferminux.net` **and** from
`https://ferminux.net/dex/`.

Three tabs:

| Tab | What it does |
|---|---|
| **Swap** | Token in / token out with a live quote from `FerminuxRouter.getAmountsOut`, price impact as a percentage, slippage and deadline settings, minimum-received, the route for multi-hop, and an approve-then-swap flow with allowance checks; below it, **FMX markets** |
| **Liquidity** | Add at the pool's ratio (or set the opening price as the first depositor), your positions with pooled amounts and share of pool, and remove with a percentage slider |
| **Pools** | **FMX markets**, then every pair in the factory with reserves and price, and — read from `LiquidityLocker` — a **LOCKED** badge saying how much of the LP supply is time-locked and until when |

**FMX markets** lists FMX against each first-party token (AZNT, USDF): the
pool's price, reserves, last trade and a Swap link where a pool exists, and
**no pool yet** where it does not, so a missing market is visible rather than
absent. WFMX has its own line: it is FMX at 1:1, not a market.

**Deep links** open a tab with a pair selected, with the parameter names every
V2-style front end uses:

```
https://dex.ferminux.net/?inputCurrency=0xFc81ad7c145B868ef0CEC8D7Ec881Ac93f724178&outputCurrency=FMX
https://dex.ferminux.net/?outputCurrency=FMX          # FMX's counterpart in, FMX out
https://dex.ferminux.net/?tab=pools
```

A value is an address or a symbol (`FMX`/`native`, `WFMX`, or a first-party
symbol). A link can only select a token the app already lists and never
imports one; a symbol only ever selects a first-party token, so a copied name
cannot land a buyer on an impostor. ferminux.net and ferminux.com link "Swap on
Ferminux DEX" this way.

## Why FMX trades here first, and PancakeSwap second

FMX is the native coin of chain 3961, and this DEX runs on chain 3961. A swap
here settles native FMX into the buyer's own address in one 7-second block,
with no bridge and no wrapped IOU in between, against a pool whose LP is locked
in `LiquidityLocker` until 2027-08-20 (lock #0: all of the WFMX/AZNT LP but
the 1,000-wei minimum). It has been live since 2026-08-20.

PancakeSwap only ever traded **wFMX**, the bridge's IOU on BNB Chain. It was
used because that is where buyers already hold BNB and USDT, and because the
first public market was planned there. It is thinner (about $100 of depth
against about $53,000 here on 2026-09-26), and while the bridge validators are
not signing, wFMX cannot become native FMX at all. So every Ferminux surface
now quotes this DEX as FMX's market, and mentions PancakeSwap only as "also
traded on BNB Chain", with the bridge's live state. The one thing the BNB
Chain pool still does that this DEX cannot is get FMX a price on public
trackers: DexScreener and CoinGecko read BNB Chain pools, and neither reads
chain 3961 (see `infra/listings/README.md`).

What this DEX still lacks is a **USD pool and an on-ramp to it**. Its only
pool is WFMX/AZNT (AZNT = 1 AZN), all 500,000 USDF sit in the treasury, and
nobody outside the project holds AZNT or USDF. So a buyer arriving with USDC,
USDT or BNB cannot trade here directly yet: the pay-in at ferminux.net/buy-fmx
is the way in until a WFMX/USDF pool is seeded and USDF can be bought.

The LOCKED badge is the point of the Pools tab. It is how a buyer checks that
the liquidity behind a token cannot be pulled.

## Layout

```
dex/ui/
├── index.html
├── vite.config.ts            base './', dev/preview on port 8602
├── src/
│   ├── config.ts             chain-3961 addresses, chain id, RPC, explorer, thresholds
│   ├── App.tsx               shell: header, tabs, RPC/wallet status, footer
│   ├── styles.css            institutional dark: one accent, 6px radius, tabular numerals
│   ├── lib/                  the data layer — NO browser globals except wallet.ts
│   │   ├── abi.ts            every contract surface the app touches
│   │   ├── math.ts           the AMM math, mirroring FerminuxLibrary exactly
│   │   ├── amounts.ts        parsing and display (never rounds up)
│   │   ├── gas.ts            fee head-room for "Max" on native FMX
│   │   ├── pairs.ts          factory registry, reserves, token metadata cache, pair index
│   │   ├── route.ts          route finding (pure, over the index)
│   │   ├── swap.ts           quoting through the router + execution
│   │   ├── liquidity.ts      add / remove / create-pair + positions
│   │   ├── locker.ts         LiquidityLocker reads — the LOCKED badge
│   │   ├── deeplink.ts       ?inputCurrency=…&outputCurrency=…&tab=… → the pair to select
│   │   ├── tokens.ts         the token model + ERC-20 reads/approvals
│   │   ├── rpc.ts            ordered RPC fallback with a health probe
│   │   ├── connector.ts      the wallet choice: Ferminux Wallet, injected, WalletConnect
│   │   └── wallet.ts         EIP-1193 wallet helpers (browser-only, with connector.ts)
│   ├── state/                React hooks over the data layer
│   ├── views/                SwapPanel, FmxMarkets, AddLiquidity, PositionsPanel, PoolsPanel, TokenSelect, TradeSettings
│   └── components/ui.tsx     Modal, Notice, StatRow, TxStatus, links
├── tests/                    75 unit tests (node:test, no chain)
└── scripts/
    ├── check-dist.mjs        build guard: no unexpected external URL in dist/
    ├── e2e.mjs               real-chain data-layer test on anvil :8602
    └── ui-check.mjs          headless-browser test of the built app (optional deps)
```

Everything under `src/lib` is importable under plain Node — that is what lets
`scripts/e2e.mjs` drive **the app's own modules** against a real chain instead
of a reimplementation of them. `src/lib/wallet.ts` is the single exception and
touches only `window.ethereum`.

## Configure

`src/config.ts` defaults to the Ferminux AMM on chain 3961 (deployed
2026-08-20: factory `0x2034…7040`, router `0x018C…A9f`, WFMX `0x8a9A…77Ae`,
locker `0xe588…3951`). A devnet build overrides all four; an override set to an
empty string blanks that address, and the app then renders a plain "Not
configured" screen listing exactly what is missing rather than pointing users
at a guessed address.

| Variable | Meaning |
|---|---|
| `VITE_FACTORY_ADDRESS` | `FerminuxFactory` |
| `VITE_ROUTER_ADDRESS` | `FerminuxRouter` |
| `VITE_WFMX_ADDRESS` | `WFMX` |
| `VITE_LOCKER_ADDRESS` | `LiquidityLocker` |
| `VITE_RPC_URLS` | comma-separated fallback list (default `https://rpc.ferminux.net,https://ferminux.net/rpc`) |
| `VITE_CHAIN_ID` | default `3961` |
| `VITE_EXPLORER_URL` | default `https://explorer.ferminux.net` |
| `VITE_WC_PROJECT_ID` | adds WalletConnect to the wallet choice; unset = not bundled (see `shared/fxwallet/README.md`) |

```sh
VITE_FACTORY_ADDRESS=0x… \
VITE_ROUTER_ADDRESS=0x… \
VITE_WFMX_ADDRESS=0x… \
VITE_LOCKER_ADDRESS=0x… \
  npm run build
```

AZNT (`0xFc81ad7c145B868ef0CEC8D7Ec881Ac93f724178`, 6 decimals) and USDF
(`0xCd032A609e34121D1881E8DE7355b2c2c7092363`, 6 decimals) are preloaded from
the shared registry (`shared/tokens.ts`); WFMX is added from the configured address; everything else comes
from the factory's own pair list, plus any token the user imports by address.

## Commands

Every command below was run in this directory; the numbers under **Results** are
from those runs.

```sh
cd <repo>/dex/ui

npm install          # 79 packages
npm run dev          # dev server on http://127.0.0.1:8602
npm run build        # tsc --noEmit && vite build && node scripts/check-dist.mjs
npm run preview      # serve dist/ on 8602
npm test             # 75 unit tests, no chain needed
npm run e2e          # real anvil on :8602 — deploys the AMM and drives the app's lib modules
npm run ui           # headless-browser check of the built app (skips cleanly without playwright/chromium)
```

Port 8602 is this component's assigned port and is shared by the dev server, the
e2e anvil and the ui-check anvil, so only one of them can run at a time;
`DEX_TEST_PORT=<port>` moves the e2e and ui-check anvil when 8602 is taken. The
ui-check's static file server takes an OS-assigned ephemeral port.

`npm run e2e` and `npm run ui` need `anvil` (foundry) on `PATH` and a
`forge build` in `../contracts` (and, for AZNT, in `../../contracts`).

## Results

### `npm run build`

```
✓ 199 modules transformed.
dist/index.html                   0.66 kB │ gzip:   0.39 kB
dist/assets/index-*.css          16.48 kB │ gzip:   3.76 kB
dist/assets/index-*.js          478.84 kB │ gzip: 163.36 kB
✓ built in 656ms
  (inert)   reactjs.org / www.w3.org / gateway.ipfs.io / github.com /
            gasstation(-testnet).polygon.technology / localhost
check-dist: no unexpected external URLs in dist/.
```

The `(inert)` hosts are string constants inside React and ethers (error-decoder
links, an XML namespace, ethers' Polygon fee-plugin and IPFS-gateway constants)
that are never fetched on chain 3961. They are allowlisted **by name** in
`scripts/check-dist.mjs`, so any *new* external host fails the build.

### `npm test` — 75 unit tests, 0 failures

The table covers the math, amounts and routing files; `tests/deeplink.test.mjs`
(3) pins the deep-link rules above, and the token, handoff and bridge-gate
files cover the shared registry, the phone hand-off and the bridge tab.


| File | Tests | What it pins down |
|---|---:|---|
| `tests/math.test.mjs` | 15 | `getAmountOut` against the three worked examples published in `../contracts/README.md` (5 / 50 / 250 FMX into the 10,000 SEED + 5,000 FMX pool → 9.9601 / 98.7158 / 474.8297 SEED at 39 / 128 / 503 bps); the exact Solidity formula on hand-checkable integers; `getAmountIn` rounding up and being the *tight* inverse (one wei less never suffices); k never falling; `quote` being fee-free; multi-hop fee chaining; price impact measured against the mid price and monotone in size; `minimumReceived` / `maximumSold` rounding in the pool's favour; deadlines; LP share, pooled amounts and `liquidityMinted`; and a 2,000-case deterministic fuzz over all the invariants |
| `tests/amounts.test.mjs` | 8 | Parsing rejects more precision than a token can hold; formatting truncates and never rounds up (1 wei renders `<0.000001`, not `0`); a 6-decimal token priced against an 18-decimal one in both directions; percentage conversions; UTC timestamps and relative unlock dates; the "Max" fee head-room |
| `tests/route.test.mjs` | 9 | Pair keys and reserve orientation; candidate paths (direct + one hop through a base); the two-hop route winning when the direct pool is shallow and losing when it is deep; a genuine tie going to the shorter path; route amounts equalling the chained pool math hop by hop; unroutable requests returning `null` instead of a wrong number |

The unit tests are the *fast* check of the math. The authoritative check is in
the e2e, where the same functions are compared with the deployed contract.

### `npm run e2e` — 26 steps, all passing

Spawns anvil on 8602 (`--chain-id 3961 --balance 100000`), deploys WFMX →
`FerminuxFactory` → `FerminuxRouter` → `LiquidityLocker` from `../contracts`'
forge artifacts, plus `SeedDemoToken` (SEED, 18 decimals) and the real `AZNT`
contract (6 decimals), then drives `src/lib/*` — the same modules the UI imports:

```
  ✓  1. port 8602 is free
  ✓  2. anvil up on :8602 (chain-id 3961)
  ✓  3. connectRpc skipped the dead endpoint and health-probed the live one
  ✓  4. src/config.ts ships with factory/router/WFMX/locker all set to well-formed addresses
  ✓  5. deployed WFMX 0x5FbDB231… factory 0xe7f1725E… router 0x9fE46736… locker 0xCf7Ed3Ac…
  ✓  6. deployed SEED (18 decimals) and AZNT (6 decimals) and minted the deployer a balance
  ✓  7. token metadata read through the app cache: SEED (18) and AZNT (6)
  ✓  8. seeded SEED/FMX (10,000 SEED + 5,000 FMX) and AZNT/FMX (20,000 AZNT + 10,000 FMX) via lib/liquidity.ts
  ✓  9. loadAllPairs read 2 pools with reserves, LP supply and both tokens' metadata
  ✓ 10. quoted 5 FMX → 9.96 SEED, impact 0.39%, min 9.9102 (router-verified)
  ✓ 11. 256 randomised cases: lib/math.ts getAmountOut / getAmountIn / quote equal the contract's, to the wei
  ✓ 12. swapped 10 FMX → 19.900318 SEED (exactly the quote, native path)
  ✓ 13. two-hop swap 10 SEED → WFMX → 9.964903 AZNT after an exact-amount approval
  ✓ 14. sold 5 SEED for 2.496219 native FMX (unwrapped by the router)
  ✓ 15. router enforced amountOutMin and the deadline — both reverted as designed
  ✓ 16. impact thresholds: 1 FMX = 0.31% (ok), 200 FMX = 4.12% (warn), 1200 FMX = 19.54% (severe)
  ✓ 17. added 100 SEED + 50.049564 FMX at the pool ratio; minted exactly the quoted 70.745345 LP
  ✓ 18. positions: 99.999% of the SEED/FMX pool = 5,052.5534 WFMX + 10,095.0996 SEED
  ✓ 19. removed 50%: received 5,047.54984 SEED + 2,526.276704 native FMX, both exactly as quoted
  ✓ 20. locker badge: 60.9% of LP supply locked, earliest unlock in 1h, 2 locks listed
  ✓ 21. after the short lock matured: held 2,178.253 LP but only 2,142.5439 still locked — the badge reports the honest number
  ✓ 22. created a new SEED/AZNT pool as first depositor and set the opening price to 1 SEED = 4 AZNT
  ✓ 23. route selection switched to the new direct pool: 1 SEED → 3.984027 AZNT in one hop
  ✓ 24. wrapped 3 FMX → WFMX and unwrapped it back, 1:1 both ways
  ✓ 25. price impact recomputed from the router's own output matches the local computation
  ✓ 26. anvil stopped; port 8602 is free again

E2E: all checks passed.
```

Step 11 is the important one for the quoting math: 256 randomised
`(amountIn, reserveIn, reserveOut)` triples are pushed through
`lib/math.ts` **and** through `FerminuxRouter.getAmountOut` / `getAmountIn` /
`quote` on chain, and asserted equal to the wei — not approximately, exactly.

Steps 12, 13, 14, 17 and 19 assert that the amount actually received equals the
amount quoted, so the UI cannot be quoting one number and settling another.

The e2e deploys from `../contracts/out/*` with ethers rather than running
`forge script`, deliberately: a broadcast run would rewrite
`../contracts/broadcast/…/3961/run-latest.json`, and that project is not this
component's to modify.

### `npm run ui` — 19 browser assertions, all passing

Builds the real bundle against a devnet (two pools seeded, 60% of one pool's LP
locked for a year), serves it, and drives it in headless Chromium with a
minimal injected EIP-1193 provider that forwards to anvil's unlocked accounts —
so the page really signs and really mines.

```
  ✓  1. anvil up on :8602
  ✓  2. devnet ready: 2 pools seeded, 60% of the SEED/FMX LP locked for a year
  ✓  3. built the production bundle against the devnet addresses
  ✓  4. shell rendered; footer reports a live block height from the devnet
  ✓  5. Bridge tab mounts across the @bridge alias, shows Ferminux → BSC, gates on a wallet and on relayer liveness
  ✓  6. Pools: 2 pools, LOCKED badge with share + unlock date, lock breakdown expanded
  ✓  7. Swap: 5 FMX quoted live through the router → 9.96006981 SEED, impact 0.39%
  ✓  8. Swap settings: slippage presets and the deadline update the quote and the header
  ✓  9. a 200 FMX trade raises the >3% price-impact warning
  ✓ 10. a 1200 FMX trade raises the >10% danger notice
  ✓ 11. connected the injected wallet; the header shows the account
  ✓ 12. the >10% confirmation modal really blocks until "I understand" is typed
  ✓ 13. token selector filtered to AZNT and switched the output token
  ✓ 14. swapped 5 FMX in the browser: +9.960069 SEED confirmed on chain
  ✓ 15. Liquidity: 2 positions with share of pool, remove-slider quote, and the locked-LP list
  ✓ 16. picking a pair with no pool shows the first-depositor explanation and the acknowledgement
  ✓ 17. at 390px wide the page does not scroll horizontally
  ✓ 18. no console errors or unhandled page exceptions during the whole run
  ✓ 19. a build with blanked addresses renders the "Not configured" screen naming all four
```

Screenshots are written to a temp directory and the path is printed. The script
**skips cleanly (exit 0)** when `anvil`, `playwright-core` or a Chromium build is
missing; point it at yours with `PLAYWRIGHT_DIR=` and `CHROME_PATH=`.

## How the numbers on the screen are produced

**Quoting is done twice.** The reserves already loaded for the Pools tab choose
the route locally; then `FerminuxRouter.getAmountsOut(amountIn, path)` is called
and *that* result is what gets displayed and what the slippage bound is derived
from. If the two disagree (reserves moved mid-quote) the quote says so instead
of showing a stale price confidently.

**Price impact** is `(midOutput − amountOut) / midOutput`, where `midOutput` is
what the route would pay at the current ratio with no fee and no depth effect.
It therefore **includes the 0.30% fee per hop** — the same "total cost vs mid"
the contracts README tabulates — so a dust trade through one pool floors at
~30 bps rather than at zero. Thresholds: a warning at **3%**, and above **10%** a
modal that requires typing *I understand* before the swap can be sent.

**Slippage** presets are 0.1% / 0.5% / 1.0% plus a custom box; the resulting
`amountOutMin` is shown as "Minimum received" and is exactly what the router
receives. Zero tolerance and anything above 5% are both called out.

**Deadline** is minutes from signing, sent as a unix timestamp; the router
refuses the transaction afterwards rather than execute it at a price that has
moved on.

**Approvals** are for the exact input amount, not unbounded: one approval per
trade, and the router can never move more than the trade that was signed for.

**Routing** considers the direct pool and every two-hop route through a base
token (WFMX, then the preloaded list), picks the best output and shows the path.
It does **not** search three or more hops and does **not** split an order across
pools — `MAX_HOPS` in `src/lib/route.ts` is the knob if that changes.

**The LOCKED badge** reports `LiquidityLocker.totalLockedForTokenAt(pair, now)`
as a share of LP supply — i.e. LP whose unlock time is *still in the future* —
with the earliest unlock date attached. `totalLockedForToken` (everything the
locker holds, matured locks included) is shown separately, and when the two
differ the pool detail says so in as many words: **a matured lock is not a
lock.** "Now" is the chain's block timestamp, never the browser clock. A pool
with no locks is labelled **NOT LOCKED — liquidity can be pulled**.

**FMX vs WFMX.** Native FMX is modelled as a token whose address is WFMX, with
`kind: 'native'`, so routing treats them alike while the swap code picks the
payable router entry point. Selecting FMX against WFMX is detected as a wrap or
unwrap and executed against the wrapper at 1:1 — no pool, no fee, no slippage.

## States that are handled

Connecting / connected / RPC unreachable (with auto-retry); addresses not
configured; no wallet extension; wallet on the wrong chain; no pools at all; a
pool that exists but was never seeded; a token whose `symbol`/`decimals` cannot
be read (shown as a placeholder and flagged, never silently priced); no route
between two tokens; an amount larger than the balance; more decimals than the
token can hold; insufficient allowance; signing / pending / confirmed / rejected
/ reverted (the contract's own `require` string is surfaced); empty positions;
empty lock list; `localStorage` unavailable (imported tokens degrade to
session-only).

## Not done / known limits

- **One live pool.** On chain 3961 the factory holds a single pair, WFMX/AZNT
  (`0xbab1…6845`): 138,767.18 WFMX against 45,100 AZNT on 2026-09-26, 0.3250
  AZNT per FMX, eight swaps since 2026-08-20, all from one address the
  deployer funded with AZNT, the last on 2026-08-27. There is no WFMX/USDF pool. The numbers under **Results**
  come from a local anvil; the live pool was exercised on an anvil fork of
  chain 3961 (both swap directions, signed in the page).
- The pool list loads **every** pair and then one lock summary per pair on each
  refresh (3 calls per pool). That is fine for tens of pools; a few hundred
  would want incremental loading and a multicall.
- Exact-output swaps ("I want exactly N of token B") are not offered; the router
  supports them and `lib/math.ts` implements `getAmountIn`/`getAmountsIn`, but
  the UI only quotes exact-input.
- Fee-on-transfer tokens are not routed through the router's
  `SupportingFeeOnTransferTokens` paths, so a swap involving one will fail
  loudly (`PAIR: K`) rather than settle wrongly. The plain paths are the safe
  default; adding the supporting paths needs a per-token opt-in in the UI.
  For ADD LIQUIDITY specifically this is deliberate policy, not a gap: the
  supporting add paths take a mandatory `maxFeeBps` (the token's declared
  transfer tax, hard-capped at 20% by the contract) and that declared fee is
  the most a hostile token can cost the depositor. A UI that guessed the fee,
  or passed `minLiquidity = 0`, would be volunteering its users' downside —
  so the add-liquidity flow calls only the plain paths, which enforce the full
  proportional floor.
- **Router checks protect the deposit, not the token.** Adding liquidity
  against a token you do not trust is dangerous no matter what the router
  enforces: the token contract controls its own side of the pool permanently
  and can mint, tax, blacklist or freeze after the deposit settles. The
  add-liquidity screen warns for any token the TokenFactory registry does not
  vouch for; the warning is honest — there is no contract-level cure.
- Removing liquidity uses `approve` + `removeLiquidity`, not the EIP-2612
  `removeLiquidityWithPermit` single-transaction variant.
- Locking LP is **read-only** here: the app shows locks but has no "lock my LP"
  flow. That belongs with the launchpad, and `LOCKER_ABI` deliberately carries
  no write methods.
- The token list is not curated. Anything in a pool appears; the selector says
  plainly that anyone can deploy a token with any name.
