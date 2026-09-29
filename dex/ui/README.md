# Ferminux DEX: web app

The trading front end for the Ferminux AMM (`../contracts`) on the Ferminux
Network, chain **3961**, native coin **FMX**.

Vite + React 18 + TypeScript + ethers v6, in the ferminux.net dark design
system (`.ui-craft/brief.md`, `tokens.md`; the Ferminux Wallet is the reference
for app screens), phone first. Fonts included, no CDNs, no
analytics, no backend of its own: every pool number on the page is read from
the chain over JSON-RPC (`rpc.ferminux.net`), buying with coins on other
networks goes through the project's pay-in (`ferminux.net/api/payin`), and the
build fails if an unexpected external URL gets into `dist/`. `base` is `./`, so the same `dist/` serves from
`https://dex.ferminux.net` and from `https://ferminux.net/dex/`.

**The first screen loads only Swap.** Pools (list and pool page), Liquidity,
Charts and Analytics, Activity (and `lib/history.ts`), the pay-in card, the
FMX price chart beside the swap card, the Bridge panel and the phone hand-off
QR are each their own chunk, imported when first shown
(`src/components/Lazy.tsx`) and fetched while the browser is idle after the
first screen, so a tab switch does not wait. WalletConnect's provider loads only
when WalletConnect is chosen, or a remembered WalletConnect session is resumed
(`lib/connector.ts`). A chunk that fails to load (offline, or a tab left open
across a deploy) shows a notice with a reload. `scripts/check-dist.mjs` fails
the build if any of those parts is reachable from the entry chunk's static
imports, or if the first screen passes 230 kB gzip.

## Pages

| Page | What it does |
|---|---|
| **Swap** | Best-route search over every pool, up to three pools per route; live quote re-read every block; price impact with a warning at 3% and a typed confirmation above 10%; minimum received; the route drawn pool by pool; slippage, deadline, route length and approval size in settings; a token picker with balances, USD values and search, plus import by address; FMX ⇄ WFMX as a 1:1 wrap; approve-then-swap (exact amount by default, unlimited only when chosen, with the warning); a review step before signing. Beside it: the FMX price chart and FMX's markets |
| **Pools** | Every pool with TVL, 24 h volume, 24 h fees, 7-day fee APR, your share and the LOCKED badge, sortable. Each pool has a page: its price over time (in the paired token or in USD, with the official $0.52 line for FMX), reserves and how their value splits, recent trades, and every lock |
| **Liquidity** | Add at the pool's ratio (the second amount is derived, never typed), or open a pool as the first depositor after an explanation; your positions with value and share; remove with a percentage slider and presets, optionally unwrapping to native FMX; your LiquidityLocker locks |
| **Charts** | *FMX price*: FMX in USD as each pool against a pegged token prices it, against the official $0.52. *Analytics*: TVL, volume and fees (24 h, 7 d, all time), TVL over time, volume by day, the pool table and recent trades across all pools |
| **Activity** | The connected account's swaps, deposits, withdrawals, wraps and approvals, read from the chain and grouped by day |
| **Swap: other networks** | The "You pay" picker also lists USDT, USDC and the network's own coin on BNB Smart Chain, Base, Arbitrum One, Polygon, Optimism, Avalanche C-Chain and Ethereum, with the wallet's balance on each. Picking one turns Swap into "Buy FMX with <coin> on <network>" through the pay-in (below). FMX pool swaps are unchanged |

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
**Every transaction asks for a quarter more gas than the node estimates**
(`withGasHeadroom`, `src/lib/wallet.ts`): a node estimates on its latest block,
and a pool that already traded in that block's second skips its
price-accumulator writes in the estimate but makes them when the transaction
lands, so a bare estimate can run out of gas inside the pair and revert with
the fee spent. Unused gas is not charged.
Tokens off the Ferminux list are named, with their address, in the review.
**The LOCKED badge** is
`LiquidityLocker.totalLockedForTokenAt(pair, now)` as a share of LP supply,
"now" being the chain's block time; a matured lock is not a lock, and the pool
page says so when the locker holds more than is still locked.

## Pay with any coin (`src/lib/payin.ts`, `payWallet.ts`, `views/PayCard.tsx`)

The pools hold FMX, USDF and AZNT only, so "swap USDT for FMX" is not a pool
trade. It is the pay-in behind ferminux.net/buy-fmx: a quote at the official
$0.52 plus a 2% spread ($1 to $10,000, valid 15 minutes), a transfer of
**exactly** the quoted amount to the pay-in's deposit address on the paying
network, and FMX sent to the quote's recipient on Ferminux once that network
has confirmed it (6 to 60 confirmations). One way only: selling FMX into those
coins is not offered, and the card says so.

- **The deposit is matched by its exact amount and sender.** The wallet is
  only ever asked to send `sendExactly` (which may be a few units under what was
  typed), from the account that asked for the quote: a token `transfer(deposit,
  sendExactly)` sent to the pinned contract, or `sendExactly` of the native
  coin as value. Never the typed amount, never twice for one quote.
- **Everything the wallet acts on is pinned.** Chain ids, token contracts and
  decimals (BNB Smart Chain's USDT and USDC have 18, everywhere else 6) are in
  `lib/payin.ts`; `tests/payin.test.mjs` reads `agents/gateway/src/v3/payin.ts`
  and fails if the two differ. The deposit address is `PAYIN_DEPOSIT_ADDRESS`
  in `config.ts`. A quote naming anything else, or whose FMX does not recompute
  to the wei from its own USD value, price and spread, is refused; so is a
  network the asset list shows differently.
- **The wallet is put on the paying network** (`wallet_switchEthereumChain`,
  then `wallet_addEthereumChain` when it does not know it), and **asked again
  right before sending** which chain and account it is on: a wallet that moved
  is refused before anything is signed. After paying, the card offers the
  switch back to Ferminux.
- **Refused before the wallet is asked:** under a minute left on the quote
  (get a new one), a network the pay-in has paused, an amount outside $1 to
  $10,000, not enough of the coin, or not enough of the network's coin for the
  fee. The fee is read from the paying network's public endpoints for
  **exactly the quote's transfer** (`readPayFee`, `payPrecheck`):
  `eth_estimateGas` for that transfer from the paying account, at
  `eth_gasPrice`; on Base and Optimism plus the L1 data fee, which the gas
  estimate leaves out, from the GasPriceOracle predeploy
  (`0x4200…000F`, `getL1Fee(bytes)` of the unsigned EIP-1559 transfer, as
  viem's `estimateL1Fee` does) and the operator fee (`getOperatorFee` at the
  padded gas limit; 0 on both networks today, read rather than assumed); on
  Arbitrum the estimate already carries the L1 part as extra gas. The budget
  is the estimate +20% at the price +25%, plus twice the L1 fee, plus the
  operator fee. **It fails safe:** a balance, estimate, gas price, L1 fee or
  operator fee that cannot be read stops the send with a message saying which, and
  "Max" on a network's own coin (which leaves two fee budgets) is not filled in
  without a fee read.
- **The pay-in is asked again right before the wallet is.** A fresh
  `GET /assets` must still show the network taking payments (a payment made
  while its deposit scanner is behind can outlive the quote and land
  unmatched), and a fresh `GET /{quoteId}` must show the quote still open for
  exactly the stored amount, recipient, payer, contract and deposit address. A
  quote a reload brought back from storage, or one another tab or device has
  replaced, is never paid from this page's copy alone.
- **A re-quote never reuses an amount.** The pay-in matches a deposit to the
  oldest open *or replaced* quote with that amount and sender, for ten minutes
  after it closes, and its unique-amount rule only steps around open quotes.
  So a new quote asks for one unit under the lowest amount this wallet's
  recent quotes for that coin still hold, and its payment can only match it.
- **The tracker survives a reload.** Open quotes are kept in this browser
  (`ferminux-dex.payin.v1`) and followed at `GET /api/payin/{id}`: sent, seen
  on the network, confirmations, FMX delivered, with explorer links on both
  sides. A send that started and never reported back (the page closed in the
  wallet dialog) is flagged, and a second send asks you to check the wallet's
  activity first. "Your FMX purchases" under the card lists them.
- The "Do not send from an exchange" note is on the form and the review: the
  deposit must come from this wallet, and the FMX goes to the recipient, not
  the sender. The recipient is the connected address; another one takes a
  warning and a confirmation.

## Why FMX trades here first, and PancakeSwap second

FMX is the native coin of chain 3961, and this DEX runs on chain 3961. A swap
here settles native FMX into the buyer's own address in one 7-second block,
with no bridge and no wrapped IOU in between, against pools whose LP is locked
in `LiquidityLocker`: WFMX/AZNT until 2027-08-20 (lock #0) and WFMX/USDF until
2027-09-26 (lock #1), each holding all of its pool's LP but the 1,000-wei
minimum. The DEX has been live since 2026-08-20.

PancakeSwap only ever traded **wFMX**, the bridge's IOU on BNB Chain. It is
thinner, and while the bridge validators are not signing, wFMX cannot become
native FMX at all. So every Ferminux surface quotes this DEX as FMX's market,
and mentions PancakeSwap only as "also traded on BNB Chain". DexScreener and
CoinGecko read BNB Chain pools and not chain 3961 (see
`infra/listings/README.md`).

On chain 3961 on 2026-09-27 the factory holds two pools, both pricing FMX at
the official $0.52: WFMX/USDF (`0x04B2…86f9`: 480,769 WFMX and 250,000 USDF,
seeded on 2026-09-26) and WFMX/AZNT (`0xbab1…6845`: about 84,190 WFMX and
74,424 AZNT, 0.884 AZNT per FMX, which is $0.52 at 1.70 AZN per USD). AZNT and
USDF trade with each other through FMX. The fork checks below run against
exactly this market and read every figure they expect from it.

## Layout

```
dex/ui/
├── index.html
├── src/
│   ├── config.ts             chain-3961 addresses, RPC, explorer, FMX_USD_E18 ($0.52), MAX_HOPS, DEX_START_BLOCK
│   ├── App.tsx               pages (Swap in the entry chunk, the rest on demand), wallet chooser, phone hand-off
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
│   │   ├── pairs.ts, liquidity.ts, locker.ts, tokens.ts, amounts.ts, format.ts, gas.ts, ranges.ts
│   │   └── rpc.ts, deeplink.ts, handoff.ts, registry.ts, bridge*.ts, wallet.ts, connector.ts
│   ├── state/                hooks: chain, wallet, pools, market, positions, activity, route, settings
│   ├── components/           Shell, Lazy (on-demand chunks), Chart (SVG line/bar), TradeParts, TokenLogo, LockBadge, icons, ui, ConnectChooser, MobileHandoff
│   └── views/                SwapView, PoolsView, LiquidityView, ChartsView, ActivityView, TokenPicker, SettingsModal, …
├── tests/                    136 unit tests (node:test, no chain)
└── scripts/
    ├── check-dist.mjs        build guard: no unexpected external URL in dist/; the first screen stays Swap only
    ├── e2e.mjs               fresh AMM on a local anvil, driven through src/lib
    ├── fork.mjs              anvil fork of chain 3961 and its live $0.52 market, by impersonation
    ├── e2e-fork.mjs          the live contracts on a fork, driven through src/lib
    ├── ui-check.mjs          the built page in Chrome against the fork, 320 / 390 / 1440 px
    └── payin-check.mjs       pay with any coin in Chrome, everything mocked
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
| `VITE_PAYIN` | `0` builds without "Other networks" (on by default) |
| `VITE_PAYIN_API_URL` | default `https://ferminux.net/api/payin` |
| `VITE_PAYIN_DEPOSIT_ADDRESS` | the pay-in's deposit address the app will pay (default the live one, `0xc2a7…05Fa`) |
| `VITE_PAYIN_POLL_MS` | how often an open quote is re-read (default 8000) |

## Commands

```sh
cd <repo>/dex/ui
npm install
npm run dev          # http://127.0.0.1:8602
npm run build        # tsc --noEmit && vite build && node scripts/check-dist.mjs
npm test             # 136 unit tests, no chain
npm run e2e          # fresh AMM on anvil :8602
npm run e2e:fork     # anvil FORK of chain 3961 on :8602 (reads rpc.ferminux.net)
npm run ui           # the built page in Chrome against the fork; PLAYWRIGHT_MODULE=…/playwright/index.mjs
npm run ui:payin     # pay with any coin in Chrome: mocked pay-in, networks and wallet; no anvil
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

**The fork is the live market** (`scripts/fork.mjs`). `npm run ui` changes
nothing before it starts: it first reads, with the app's own lib, every pool,
its TVL at the $0.52 basis, its LOCKED share and locks, the router's quote for
100 FMX and for 500 AZNT (which routes through FMX), and the add-liquidity
ratio, and expects the page to show exactly those. It also pins what the
market is: the WFMX/USDF pool is `0x04B2…86f9`, both FMX pools are at least
99.9% locked by locks #1 and #0, and both price FMX within 2% of $0.52; if the
live market moves past that, the check says so. `npm run e2e:fork` adds a thin
AZNT/USDF pool at the peg that chain 3961 does not have, so the router has two
routes to weigh (small AZNT → USDF direct, larger through FMX). The page's
transactions carry the quarter of gas headroom described above, and so do
the fork scripts' own (`forkProvider`): without it an exact estimate ran out
of gas in the pair whenever the pool had moved in the same second, which was
the "unexplained fork flake" at "Remove 50%"; `npm run ui` checks that every
transaction the page sends carries its own limit.

## Results (2026-09-27)

### `npm run build`: the first screen, before and after the split

```
before  dist/assets/index-*.js   821.2 kB │ gzip: 275.0 kB   (everything, one chunk)
after   dist/assets/index-*.js   595.1 kB │ gzip: 205.7 kB   (the first Swap screen: -28% raw, -25% gzip)
        on demand (gzip): PoolsView 4.7 · LiquidityView 6.5 · ChartsView 3.6 · TradesTable 3.7 (shared)
                          ActivityView 1.8 + history 1.7 · PayCard 8.8 · MobileHandoff (QR) 11.2 · BridgePanel 8.9
        dist/assets/index-*.css   55.7 kB │ gzip:  11.1 kB
fonts: Inter 48 kB, JetBrains Mono 31 kB, Sora 15 kB (woff2, self-hosted)
check-dist: no unexpected external URLs in dist/.
check-dist: first screen index-*.js = 595.1 kB (205.5 kB gzip, budget 230); 8 parts load on demand.
```

BridgePanel was 35.4 kB gzip while the bridge app's lib pulled in its own copy of
ethers from `bridge/ui/node_modules`; `resolve.dedupe` (vite.config.ts) and a
`paths` entry (tsconfig.json) now resolve it from this app's install, so there
is one ethers, and `npm ci && npm run build` works where only `dex/ui` is
installed (CI, a deploy box).

What is left in the first screen is mostly ethers (provider, contract, ABI,
transaction; ENS and secp256k1 come with its provider) and react-dom. With
`VITE_WC_PROJECT_ID` set the entry grows by 2 kB and WalletConnect's provider
and modal (about 1.5 MB in several chunks) load only when it is chosen.

### `npm run ui:payin`: 13 browser checks, all passing

Nothing real is touched: the pay-in API is a mock that quotes, supersedes and
attributes like the gateway; the seven networks answer from fixed balances and
fees (a token transfer estimates at 52,000 gas, 150,000 more on Arbitrum; Base
and Optimism answer getL1Fee and getOperatorFee); the wallet is a scripted injected provider that
records what it is asked to send.

```
  ✓  1. built the production bundle (shipped pay-in URL and network endpoints, local chain 3961)
  ✓  2. picker: "Other networks" lists USDT / USDC / native on 7 networks with the wallet’s balances; Polygon paused and not pickable; search filters
  ✓  3. pay mode: FMX locked on the output, one-line "not offered yet", rate $0.5306 with the 2%, $1–$10,000, 12 confirmations; bounds and balance refused before any quote
  ✓  4. review: exactly 9.999999999999999997 USDT (18 decimals, 3 units of dust), deposit address, BNB Smart Chain · 56, recipient, 15-minute clock, exchange warning
  ✓  5. sent: switched the wallet to 56, then transfer(deposit, 9999999999999999997) to BSC USDT from the quoting account, attributed by amount
  ✓  6. tracker: seen → confirmed → paid, BscScan and explorer.ferminux.net links; "Switch back to Ferminux" put the wallet home
  ✓  7. reload kept the open Base quote; with the L1 fee unreadable the send was refused; then the wallet (which did not know Base) added chain 8453 and sent exactly 24.999997 USDC, fee priced with estimateGas + getL1Fee + getOperatorFee
  ✓  8. native: 0.499999999999999997 AVAX as value straight to the deposit address on 43114, no data
  ✓  9. a quote with under a minute left cannot be sent; "Get a new quote" replaced it, one unit under the old amount so the payment can only match the new one
  ✓ 10. a wallet that reported BNB Smart Chain and then moved to chain 1 before the send was refused: nothing signed
  ✓ 11. a network paused after the quote was issued: the pre-send check with the pay-in refused, nothing signed
  ✓ 12. after the drift, a retry sent exactly 4.999999999999999996 USDT, credited to the new quote; USDC with a zero balance is refused before quoting
  ✓ 13. back to the pool swap card unchanged; 4 payments, all matched; no horizontal scroll at 320/390/1440 px; no console errors
```

### `npm test`: 136 tests, 0 failures

Pay with any coin (`payin.test.mjs`, 33): the networks, contracts, decimals and
confirmations equal the gateway's table; exact units at 6 and 18 decimals;
FMX out equal to the gateway's to the wei; every field of a quote checked;
the transfer built from `sendExactly` only; the network fee per chain with
each network's RPC mocked (Ethereum, BNB Smart Chain, Polygon and Avalanche:
`eth_estimateGas` for the exact transfer at `eth_gasPrice`; Base and
Optimism: plus `getL1Fee` of the unsigned EIP-1559 transfer, decoded back and
checked field by field, and `getOperatorFee` at the padded limit; Arbitrum: its larger estimate, no oracle read), the
cases the old flat 21k/90k budget let through now refused, and every
unreadable balance, estimate, price, L1 fee or operator fee refusing the send with a message
saying which; "Max" leaving two fee budgets; the tracker never going backwards
or paying twice; re-quotes that cannot collide; the stored quotes surviving a
reload and dropping anything tampered; the pay-in's live record of the quote
confirmed before the send; the wallet switched, added, and checked again
before the send. Gas headroom (`wallet.test.mjs`): the page's limit is the
estimate plus a quarter, a caller's own limit untouched.

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
  ✓  2. live pools: WFMX/AZNT LOCKED 99.999% until 2027-08-20 (lock #0); WFMX/USDF LOCKED 99.999% until 2027-09-26 (lock #1)
  ✓  3. market at $0.52: WFMX/USDF live at $0.5200; WFMX/AZNT 0.8840 AZNT/FMX ($0.5200); thin AZNT/USDF at 1.70 (fork only)
  ✓  4. TVL at the $0.52 basis: WFMX/USDF 499,999.99 USD (both sides valued), WFMX/AZNT 87,557.97 USD
  ✓  5. 100 FMX → 51.833251 USDF direct (2 paths priced, router-verified), impact 0.32%
  ✓  6. 20.0 AZNT → 11.68569 USDF multi-hop AZNT → FMX → USDF (beat the direct pool by 0.092263 USDF)
  ✓  7. FMX → SEED via 2 pools executed as quoted; AZNT → SEED candidates up to 3 pools; "direct only" correctly finds none
  ✓  8. 40 random trades over FMX/USDF/AZNT/SEED: 71 paths, local amounts equal getAmountsOut to the wei, best route agreed
  ✓  9. approvals: exact amount, then unlimited, then revoked to 0, each read back
  ✓ 10. added 1,000 FMX + 519.19624 USDF at the pool ratio: 0.00072 LP, 0.207% of the pool
  ✓ 11. removed 50% (499.999999261218900499 FMX native + 259.598119 USDF, as quoted), then the rest as WFMX + USDF
  ✓ 12. market record: 42 logs, 9 live + 5 fork trades; WFMX/USDF 24h volume $192.99, fees $0.57, APR 0.04%; TVL $591,337
  ✓ 13. incremental refresh added exactly the one new swap
  ✓ 14. history: 19 items (4 swap, 1 unwrap, 1 wrap, 2 remove, 9 approve, 2 add); the multi-hop swap reads AZNT → WFMX → USDF
  ✓ 15. anvil fork stopped; port 8602 free again
```

### `npm run ui`: 19 browser assertions, all passing

```
  ✓  1. fork of chain 3961 on :8602, the live market: FMX / AZNT $0.5200 lock #0 99.9%; FMX / USDF $0.5200 lock #1 99.9%
  ✓  2. built the production bundle against the fork (shipped contract addresses, local RPC)
  ✓  3. shell: one-bar header with the five pages, live block height in the footer
  ✓  4. Pools: 2 pools as the chain has them: FMX / USDF $499K Locked 99.9%; FMX / AZNT $87.5K Locked 99.9%
  ✓  5. pool detail: price chart from the pool’s Sync history with the official $0.52 line, reserves, trades, lock #1
  ✓  6. Charts: official $0.5200 with 2 pool lines; Analytics: TVL $587,557.9722, TVL and volume charts
  ✓  7. Swap: 100 FMX quoted live → 51.833251 USDF direct; slippage setting moves the minimum received
  ✓  8. 500 AZNT routes AZNT → FMX → USDF for 290.073433 USDF, as the router prices it best
  ✓  9. token picker: search filters, selection switches the output token
  ✓ 10. connected through the chooser (Ferminux Wallet listed first, the injected wallet used)
  ✓ 11. swapped 100 FMX in the page: +51.833251 USDF on chain
  ✓ 12. a wallet that left Ferminux while the review was open is refused before anything is signed
  ✓ 13. USDF → FMX: approve exactly 20 USDF, then swap; native FMX received, allowance back to 0
  ✓ 14. Liquidity: 50 FMX + 25.993356 USDF added at the ratio, position listed, 50% removed; each of the 4 transactions carried the page's gas limit
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

- **Pay with any coin is one way.** FMX cannot be sold into USDT, USDC or
  another network's coin here. A wallet that cannot switch networks from a
  page is pointed to ferminux.net/buy-fmx, where the transfer can be made by
  hand.

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
- The token list is the repo registry plus whatever is in a pool; anything
  outside the registry is marked **unlisted**, and imported tokens carry a
  warning.
