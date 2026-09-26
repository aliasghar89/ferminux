# Ferminux DEX: web app

The trading front end for the Ferminux AMM (`../contracts`) on the Ferminux
Network, chain **3961**, native coin **FMX**.

Vite + React 18 + TypeScript + ethers v6, in the ferminux.net dark design
system (`.ui-craft/brief.md`, `tokens.md`; the Ferminux Wallet is the reference
for app screens), phone first. One bundle, fonts included, no CDNs, no
analytics, no backend: every number on the page is read from the chain over
JSON-RPC (`rpc.ferminux.net`), and the build fails if an unexpected external
URL gets into `dist/`. `base` is `./`, so the same `dist/` serves from
`https://dex.ferminux.net` and from `https://ferminux.net/dex/`.

## Pages

| Page | What it does |
|---|---|
| **Swap** | Best-route search over every pool, up to three pools per route; live quote re-read every block; price impact with a warning at 3% and a typed confirmation above 10%; minimum received; the route drawn pool by pool; slippage, deadline, route length and approval size in settings; a token picker with balances, USD values and search, plus import by address; FMX ⇄ WFMX as a 1:1 wrap; approve-then-swap (exact amount by default, unlimited only when chosen, with the warning); a review step before signing. Beside it: the FMX price chart and FMX's markets |
| **Pools** | Every pool with TVL, 24 h volume, 24 h fees, 7-day fee APR, your share and the LOCKED badge, sortable. Each pool has a page: its price over time (in the paired token or in USD, with the official $0.52 line for FMX), reserves and how their value splits, recent trades, and every lock |
| **Liquidity** | Add at the pool's ratio (the second amount is derived, never typed), or open a pool as the first depositor after an explanation; your positions with value and share; remove with a percentage slider and presets, optionally unwrapping to native FMX; your LiquidityLocker locks |
| **Charts** | *FMX price*: FMX in USD as each pool against a pegged token prices it, against the official $0.52. *Analytics*: TVL, volume and fees (24 h, 7 d, all time), TVL over time, volume by day, the pool table and recent trades across all pools |
| **Activity** | The connected account's swaps, deposits, withdrawals, wraps and approvals, read from the chain and grouped by day |

On a phone the five pages are a bottom tab bar; from 900 px they are a
one-bar header with the ferminux.net green dot under the active page. The
wallet chooser is unchanged: Ferminux Wallet first, then every injected
wallet, then WalletConnect when the build has a project id, and the phone
hand-off (MetaMask deep link or QR) when the browser has no wallet.

**Deep links** use the parameter names every V2-style front end uses:

```
https://dex.ferminux.net/?inputCurrency=0xFc81ad7c145B868ef0CEC8D7Ec881Ac93f724178&outputCurrency=FMX
https://dex.ferminux.net/?outputCurrency=FMX          # FMX's counterpart in, FMX out
https://dex.ferminux.net/?tab=pools&pool=0xbab12e7B817F0686e11949eC06697235DC146845
https://dex.ferminux.net/?tab=liquidity&a=FMX&b=0xCd032A609e34121D1881E8DE7355b2c2c7092363
https://dex.ferminux.net/?tab=charts                  # or analytics, activity
```

A value is an address or a symbol (`FMX`/`native`, `WFMX`, or a first-party
symbol). A link can only select a token the app already lists and never
imports one; a symbol only ever selects a first-party token, so a copied name
cannot land a buyer on an impostor.

## How the numbers are produced

**Routing.** Every seeded pool is an edge between its two tokens. The router
module (`src/lib/route.ts`) enumerates every simple path from the token sold
to the token bought, up to `MAX_HOPS` = 3 pools (breadth first, capped at 400
candidates), and prices each with integer math that mirrors
`FerminuxLibrary` to the wei. The best three are then priced again by the
router itself (`getAmountsOut`, in parallel), and the route **the router**
says pays most is the one shown and signed for. Ties go to the shorter path.
If the reserves moved between the pool read and the quote, the router's
numbers win and the quote says so. Nothing is split across routes: one order,
one path, which is what the router's `swapExact…` calls execute.

**USD values** (`src/lib/prices.ts`). FMX and WFMX at the **official FMX price,
$0.52** (`FMX_USD_E18` in `src/config.ts`): the price the pay-in at
ferminux.net/buy-fmx sells at, set by the operator, not read from a pool.
USDF and AZNT at their pegs exactly as the gateway's market logic defines
them (`agents/gateway/src/constants.ts`, `DEX_QUOTE_TOKENS`): 1 USDF = $1;
1 AZNT = 1 AZN and 1 USD = 1.70 AZN. A unit test imports the gateway file and
fails if the two ever disagree. Any other token gets a *derived* value from
its deepest pool against a valued token.

**TVL** values each side of a pool at its own basis and adds them, so a pool
whose price differs from $0.52 shows it as a lopsided pair of sides (the pool
page draws the split). With only one side valued, the other is taken as equal
and the figure is marked "est.".

**Volume, fees, APR, charts** (`src/lib/events.ts`, `src/lib/market.ts`). The
pools' Swap, Mint, Burn and Sync logs are read with `eth_getLogs` from the
factory's deploy block (13,420); each event is paired with the Sync the pool
emitted just before it, so every trade carries the reserves after it. Block
times come from the blocks themselves (batched, cached; interpolated only past
800 blocks per refresh). A trade's USD size is the flow on its most directly
valued side (a pegged token, then FMX). Fees are 0.30% of volume; the fee APR
annualises the last 7 days' (or 24 h's) fees against today's TVL, not
compounded. Price lines step at every reserve change. The record is kept in
this browser between visits (a cache only: it is rebuilt from the chain when
missing) and each new block scans only what is new, re-reading the last six
blocks in case of a reorg. A `getLogs` range the node refuses is split in half
until it answers.

**Activity** (`src/lib/history.ts`). Pool logs say where output went, not who
signed, so candidate transactions are collected (logs paying the account, its
own WFMX and approval logs, and pool logs paying the router, which is how a
sale into native FMX settles) and each is read once to keep the ones the
account signed. Native FMX in is recognised from the value sent, native FMX
out from the router being paid.

**Price impact** is `(midOutput − amountOut) / midOutput` along the route,
**including** the 0.30% fee per pool, so a dust trade through one pool floors
at about 30 bps. **Approvals** are for the exact trade amount unless unlimited
approvals are switched on in settings. **Before any transaction** the page
asks the wallet for its chain (`ferminuxSigner`, `src/lib/wallet.ts`) and
refuses unless it is 3961: `eth_sendTransaction` carries no chain id, and a
wallet switched mid-review would otherwise sign the call on another network.
The review closes when the wallet leaves Ferminux, and a re-quote that pays
less than the figure reviewed has to be accepted before it can be signed.
Tokens off the Ferminux list are named, with their address, in the review.
**The LOCKED badge** is
`LiquidityLocker.totalLockedForTokenAt(pair, now)` as a share of LP supply,
"now" being the chain's block time; a matured lock is not a lock, and the pool
page says so when the locker holds more than is still locked.

## Why FMX trades here first, and PancakeSwap second

FMX is the native coin of chain 3961, and this DEX runs on chain 3961. A swap
here settles native FMX into the buyer's own address in one 7-second block,
with no bridge and no wrapped IOU in between, against a pool whose LP is locked
in `LiquidityLocker` until 2027-08-20 (lock #0: all of the WFMX/AZNT LP but
the 1,000-wei minimum). It has been live since 2026-08-20.

PancakeSwap only ever traded **wFMX**, the bridge's IOU on BNB Chain. It is
thinner, and while the bridge validators are not signing, wFMX cannot become
native FMX at all. So every Ferminux surface quotes this DEX as FMX's market,
and mentions PancakeSwap only as "also traded on BNB Chain". DexScreener and
CoinGecko read BNB Chain pools and not chain 3961 (see
`infra/listings/README.md`).

On chain 3961 on 2026-09-26 the factory holds one pool, WFMX/AZNT
(`0xbab1…6845`: about 138,767 WFMX and 45,100 AZNT, 0.325 AZNT per FMX,
which is $0.19 per FMX at 1.70 AZN per USD, against the official $0.52). There
is no WFMX/USDF pool yet; the app lists "FMX / USDF: no pool yet" until one is
seeded, and shows it, routes through it and charts it from the block it
appears. The fork tests below build exactly that market at $0.52.

## Layout

```
dex/ui/
├── index.html
├── src/
│   ├── config.ts             chain-3961 addresses, RPC, explorer, FMX_USD_E18 ($0.52), MAX_HOPS, DEX_START_BLOCK
│   ├── App.tsx               pages, wallet chooser, phone hand-off
│   ├── styles.css            the ferminux.net dark system: tokens, self-hosted fonts, components
│   ├── assets/               fonts (from wallet-web), the mark, token logos (byte copies of site/assets/brand)
│   ├── lib/                  the data layer: NO browser globals except wallet.ts / connector.ts
│   │   ├── route.ts          every path over every pool, ranked; router-checked in swap.ts
│   │   ├── swap.ts           quoting (router re-prices the best 3) + execution, wrap/unwrap
│   │   ├── prices.ts         USD bases, pool value, fee APR, USD formatting
│   │   ├── events.ts         Swap/Sync/Mint/Burn decoding, adaptive eth_getLogs, block clock
│   │   ├── market.ts         the incremental event record, trades, stats, price/TVL/volume series
│   │   ├── history.ts        one account's transactions
│   │   ├── tokenlist.ts      the picker's list from shared/tokens.ts, logos, search, order
│   │   ├── math.ts           the AMM math, mirroring FerminuxLibrary exactly
│   │   ├── pairs.ts, liquidity.ts, locker.ts, tokens.ts, amounts.ts, format.ts, gas.ts
│   │   └── rpc.ts, deeplink.ts, handoff.ts, registry.ts, bridge*.ts, wallet.ts, connector.ts
│   ├── state/                hooks: chain, wallet, pools, market, positions, activity, route, settings
│   ├── components/           Shell, Chart (SVG line/bar), TradeParts, TokenLogo, icons, ui, ConnectChooser, MobileHandoff
│   └── views/                SwapView, PoolsView, LiquidityView, ChartsView, ActivityView, TokenPicker, SettingsModal, …
├── tests/                    102 unit tests (node:test, no chain)
└── scripts/
    ├── check-dist.mjs        build guard: no unexpected external URL in dist/
    ├── e2e.mjs               fresh AMM on a local anvil, driven through src/lib
    ├── fork.mjs              anvil fork of chain 3961 + the $0.52 market, by impersonation
    ├── e2e-fork.mjs          the live contracts on a fork, driven through src/lib
    └── ui-check.mjs          the built page in Chrome against the fork, 320 / 390 / 1440 px
```

## Configure

`src/config.ts` defaults to the Ferminux AMM on chain 3961. A devnet build
overrides the four addresses; an override set to an empty string blanks it and
the app renders a "Not configured" screen naming what is missing.

| Variable | Meaning |
|---|---|
| `VITE_FACTORY_ADDRESS`, `VITE_ROUTER_ADDRESS`, `VITE_WFMX_ADDRESS`, `VITE_LOCKER_ADDRESS` | the AMM |
| `VITE_RPC_URLS` | comma-separated fallback list (default `https://rpc.ferminux.net,https://ferminux.net/rpc`) |
| `VITE_EXPLORER_URL` | default `https://explorer.ferminux.net` |
| `VITE_FMX_USD` | the official FMX price in USD (default `0.52`) |
| `VITE_DEX_START_BLOCK` | first block scanned for pool events (default 13420; `0` on a devnet) |
| `VITE_WC_PROJECT_ID` | adds WalletConnect to the wallet choice; unset = not bundled |
| `VITE_ENABLE_BRIDGE` | adds the Bridge page (off by default) |

## Commands

```sh
cd <repo>/dex/ui
npm install
npm run dev          # http://127.0.0.1:8602
npm run build        # tsc --noEmit && vite build && node scripts/check-dist.mjs
npm test             # 102 unit tests, no chain
npm run e2e          # fresh AMM on anvil :8602
npm run e2e:fork     # anvil FORK of chain 3961 on :8602 (reads rpc.ferminux.net)
npm run ui           # the built page in Chrome against the fork; PLAYWRIGHT_MODULE=…/playwright/index.mjs
```

Port 8602 is this component's and is shared by the dev server and the three
anvil-based checks, so one at a time; `DEX_TEST_PORT` moves it. `e2e`,
`e2e:fork` and `ui` need `anvil` and a `forge build` in `../contracts`; `ui`
also needs Playwright (`PLAYWRIGHT_MODULE` or `PLAYWRIGHT_DIR`) and Chrome
(`channel: 'chrome'`, or `CHROME_PATH`), and skips cleanly without them.

**The fork tests never broadcast.** anvil copies chain 3961's state on demand
and confirms every transaction locally; the treasury and the AZNT ops wallet are
**impersonated** (`anvil_impersonateAccount`), so no key is read or needed.
`scripts/fork.mjs` refuses any RPC that is not `127.0.0.1`.

## Results (2026-09-26)

### `npm run build`

```
dist/assets/index-*.css    48.8 kB │ gzip:  10.0 kB
dist/assets/index-*.js    757.6 kB │ gzip: 254.4 kB    (670 kB before the redesign)
fonts: Inter 48 kB, JetBrains Mono 31 kB, Sora 15 kB (woff2, self-hosted)
check-dist: no unexpected external URLs in dist/.
```

### `npm test`: 102 tests, 0 failures

Routing (`route.test.mjs`): paths over every pool, not a base list; three-pool
routes found and chosen when they pay more; no cycles; the candidate cap keeps
the shortest; ties to the shorter path. Prices (`prices.test.mjs`): $0.52, the
pegs equal to the gateway's to the wei, side-by-side TVL ($98,688.25 for the
live pool's reserves), derived values, APR, formatting that never rounds up.
Events (`events.test.mjs`): the pair's event signatures, decoding, Sync
pairing, range splitting, the block clock, the incremental record, trades,
volume, fees and the price/TVL series. History (`history.test.mjs`): which
transactions are the account's and how each reads. Token list
(`tokenlist.test.mjs`): logos byte-identical to `site/assets/brand`, order,
search. Plus the math, amounts, deep link, hand-off and bridge-gate suites.

### `npm run e2e:fork`: 15 steps, all passing

```
  ✓  1. anvil forked chain 3961 on 127.0.0.1:8602
  ✓  2. live WFMX/AZNT pool: LOCKED 99.999% of LP until 2027-08-20 (lock #0)
  ✓  3. market at $0.52: WFMX/USDF created at $0.5200; WFMX/AZNT moved 0.3250 → 0.8850 AZNT/FMX ($0.5206); AZNT/USDF at 1.70
  ✓  4. TVL at the $0.52 basis: WFMX/USDF 52,000 USD (both sides valued), WFMX/AZNT 87,558.03 USD
  ✓  5. 100 FMX → 51.740828 USDF direct (2 paths priced, router-verified), impact 0.49%
  ✓  6. 2000.0 FMX → 1000.914378 USDF multi-hop FMX → AZNT → USDF (beat direct by 7.693877 USDF)
  ✓  7. FMX → SEED via 2 pools executed as quoted; AZNT → SEED candidates up to 3 pools; "direct only" correctly finds none
  ✓  8. 40 random trades over FMX/USDF/AZNT/SEED: 71 paths, local amounts equal getAmountsOut to the wei, best route agreed
  ✓  9. approvals: exact amount, then unlimited, then revoked to 0, each read back
  ✓ 10. added 1,000 FMX + 512.806442 USDF at the pool ratio: 0.000716 LP, 1.947% of the pool
  ✓ 11. removed 50% (499.99999995545958334 FMX native + 256.40322 USDF, as quoted), then the rest as WFMX + USDF
  ✓ 12. market record: 42 logs, 8 live + 6 fork trades; WFMX/USDF 24h volume $180.19, fees $0.54, APR 0.38%; TVL $341,372
  ✓ 13. incremental refresh added exactly the one new swap
  ✓ 14. history: 18 items (4 swap, 1 unwrap, 1 wrap, 2 remove, 8 approve, 2 add); the multi-hop swap reads FMX → AZNT → USDF
  ✓ 15. anvil fork stopped; port 8602 free again
```

### `npm run ui`: 19 browser assertions, all passing

```
  ✓  1. fork of chain 3961 on :8602 with the $0.52 market (WFMX/USDF, WFMX/AZNT moved to $0.52, AZNT/USDF)
  ✓  2. built the production bundle against the fork (shipped contract addresses, local RPC)
  ✓  3. shell: one-bar header with the five pages, live block height in the footer
  ✓  4. Pools: 3 pools, TVL at the $0.52 basis ($52.0K for WFMX/USDF), LOCKED 99.9% on the live pool
  ✓  5. pool detail: price chart from the pool’s Sync history with the official $0.52 line, reserves, trades, locks
  ✓  6. Charts: official $0.5200 with 2 pool lines; Analytics: TVL, TVL and volume charts
  ✓  7. Swap: 100 FMX quoted live → 51.740828 USDF direct; slippage setting moves the minimum received
  ✓  8. a 3,000 FMX order routes FMX → AZNT → USDF, as the router prices it best
  ✓  9. token picker: search filters, selection switches the output token
  ✓ 10. connected through the chooser (Ferminux Wallet listed first, the injected wallet used)
  ✓ 11. swapped 100 FMX in the page: +51.740828 USDF on chain
  ✓ 12. a wallet that left Ferminux while the review was open is refused before anything is signed
  ✓ 13. USDF → FMX: approve exactly 20 USDF, then swap; native FMX received, allowance back to 0
  ✓ 14. Liquidity: 50 FMX + 25.936341 USDF added at the ratio, position listed, 50% removed
  ✓ 15. Activity: both swaps, the deposit, the withdrawal and the approvals, read from the chain
  ✓ 16. Bridge tab (VITE_ENABLE_BRIDGE=1) mounts and gates on the relayer report
  ✓ 17. no horizontal scroll on 7 pages × 320/390/1440 px
  ✓ 18. no console errors or page exceptions
  ✓ 19. a build with blanked addresses says "Not configured" and names all four
```

`npm run e2e` (fresh AMM on anvil: 26 steps, including 256 randomised
`getAmountOut`/`getAmountIn`/`quote` cases equal to the contract's to the wei)
passes unchanged apart from the routing options.

## Not done / known limits

- **Split orders.** One order takes one path. Splitting a large order across
  two routes would fill better on shallow pools; the router has no entry point
  for it, so it would be two transactions.
- **Exact-output swaps** ("I want exactly N of token B") are not offered;
  `lib/math.ts` implements `getAmountIn`/`getAmountsIn` for when they are.
- **Fee-on-transfer tokens** are not routed through the router's
  `SupportingFeeOnTransferTokens` paths, so a swap involving one fails loudly
  rather than settle wrongly; the add-liquidity flow calls only the plain
  paths, deliberately (see `src/lib/liquidity.ts`).
- **The market record lives per browser.** A first visit scans the pools'
  history from block 13,420; with thousands of trades that is a few more
  `eth_getLogs` pages and block reads, after which only new blocks are read.
  A shared indexer would make first loads instant; none is used.
- **Volume counts per pool.** A two-pool trade counts in both pools, as every
  AMM analytics page does.
- **Locking LP is read-only** here: the app shows locks but has no "lock my LP"
  flow. `LOCKER_ABI` carries no write methods.
- Removing liquidity uses `approve` + `removeLiquidity`, not the permit
  variant.
- **One unexplained fork flake.** In development, 2 of the first 9 `npm run ui`
  runs failed at the "Remove 50%" step: the transaction passed gas estimation
  and then reverted on the anvil fork. It did not reproduce in the runs after
  (including a script replaying the same sequence). The page now replays any
  reverted transaction to show the contract's reason, and the check prints the
  trace of every reverted fork transaction when it fails.
- The token list is the repo registry plus whatever is in a pool; anything
  outside the registry is marked **unlisted**, and imported tokens carry a
  warning.
