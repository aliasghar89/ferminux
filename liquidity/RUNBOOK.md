# GO-LIVE RUNBOOK — putting real money into a wFMX pool

For the person about to spend real capital. Read the whole thing once before
step 1. Every number in here is either measured (fork rehearsals,
`rehearsal-logs/`) or computed by `scripts/plan-pool.mjs` — nothing is
invented; where a number will have moved by the time you execute, it says so.

## 0. Hard preconditions — do not pass go

1. **The bridge security review is complete and signed off.** wFMX is a
   bridge IOU. If the bridge can be exploited, an attacker mints unlimited
   wFMX and drains the pool's quote side to zero. Listing before the review
   closes gambles the entire seed capital on an unaudited contract.
2. **Emission fork has activated** (block 20,000; chain was at 7,344 on
   2026-08-20). Before it, emission is 72,000 FMX/day — six times the number
   the planning table already calls unsustainable.
3. **Supply monitoring exists**: an alert when wFMX `totalSupply` on the
   remote chain diverges from FMX locked in the bridge.
4. A rehearsal of the exact sequence has **PASSED on a fork of the target
   chain** (`scripts/fork-rehearsal.mjs`). All five chains passed 2026-08-20.
5. Legal review of offering a premined token to retail in your target
   jurisdictions. A 30M premine sold to the public is, in many places, a
   securities offering. This runbook is operations, not legal advice.

## 1. Gas cost per chain (measured gas × observed prices, 2026-08-20)

Measured gas is the full sequence (wrap + createPair + 2 approvals +
addLiquidity + locker deploy + approve + lock) from the fork rehearsals.
Prices: cast gas-price + CoinGecko, 2026-08-20 (BNB $642, ETH $2,277,
POL $0.082). **Gas prices move constantly — re-run the dry run for a live
estimate before broadcasting.**

| Chain | Measured gas | Observed gas price | Cost at observed | Typical range |
|---|---|---|---|---|
| BSC | 5,557,135 | 0.05 gwei | ~$0.18 | ~$0.20–$5 (0.05–1 gwei) |
| Ethereum | 4,812,023 | 0.446 gwei | ~$4.90 | **$5–$330** (0.4–30 gwei — check first) |
| Base | 4,811,525 | 0.006 gwei | ~$0.07 (+ cents of L1 data fee) | <$1 |
| Arbitrum | 4,842,794 | 0.02 gwei | ~$0.22 | <$1 |
| Polygon | 4,812,175 | 277 gwei | ~$0.11 | <$1 |

Gas is noise next to the liquidity itself on every chain except Ethereum
during congestion. Chain choice should be driven by where buyers are (BSC =
retail, Base/Arbitrum = active DEX crowd) and where the bridge will support —
not by these cents.

## 2. Order of operations (verify between every step)

Use a **fresh wallet** funded with exactly: gas native + the quote capital +
the wFMX side. Never the treasury key. LP custody target should be a
multisig.

| # | Action | Verify before the next step |
|---|---|---|
| 1 | Choose chain + quote token. Verify the quote address two ways (issuer docs + explorer label) — this repo deliberately does not pin USDT/USDC addresses | `cast call <quote> "symbol()(string)"` and decimals match expectations (USDT is 6 decimals on Ethereum/Arbitrum/Polygon, **18 on BSC**) |
| 2 | Fork rehearsal on the target chain: `node scripts/fork-rehearsal.mjs --chain <c> --port 860X` | log ends `REHEARSAL PASSED`; keep the log |
| 3 | Dry run against the real chain (no `--broadcast`): `node scripts/create-pool.mjs --chain <c> --token <wfmx> --quote <q> --quote-amount <Q> --price <P>` | plan matches intent: price, amounts, router/factory check line, balances OK |
| 4 | **Canary**: broadcast with a small `--quote-amount` (e.g. 200) | pair address equals the simulated one; `pool-state.mjs` shows the intended price |
| 5 | Round-trip test from a **second** wallet: buy ~$10 of wFMX on the DEX UI, then sell it back | both directions succeed → wFMX transfers cleanly, no honeypot/fee surprise from the bridge token |
| 6 | Add the remaining capital (same command, remainder amount). The pool already has a price now — the script follows the pool ratio and aborts if your `--price` drifted >1% from it | `pool-state.mjs`: reserves = full size, price still right, your LP % ≈ 100 |
| 7 | Lock ALL LP: `lock-lp.mjs --amount all --unlock <+12 months>` (see `LOCKING.md` for the per-chain locker choice) | proof block prints; `balanceOf(locker)` equals your former LP balance; wallet LP = 0 |
| 8 | Optional but recommended: `transferLock` to a multisig on that chain | `getLock(id).owner` is the multisig |
| 9 | Verify contract source on the explorer: the locker (command in `LOCKING.md`); wFMX verification belongs to the bridge team | explorer read-tab works for `locksForToken` |
| 10 | Publish (next section) and switch on monitoring (section 4) | — |

If any verification fails: **stop**. Nothing in this sequence is time-critical;
every failure mode gets worse with more money in it.

## 3. Being found — token address publication

People will search the symbol and find scams unless the canonical address is
everywhere first. Publish the same tuple (chain, wFMX address, pair address,
locker address + lock id) in all of:

1. **ferminux.com and app.ferminux.org** — a canonical "Contracts" page,
   linked from the site footer. This page is what everything else cites.
2. **Explorer token info** — BscScan/Etherscan/Basescan/Arbiscan/Polygonscan
   all have a "Token Info Update" form: requires verified contract source and
   a signed message from the deployer/owner address proving control. Adds
   logo, website, socials to the token page. Free, takes days.
3. **Token lists** — the Uniswap token-list standard (tokenlists.org): host a
   `wfmx.tokenlist.json` on ferminux.com, users/import UIs add it by URL.
   For PancakeSwap's default list, PR to the `pancakeswap/token-list` GitHub
   repo (community review, no guarantee). Until merged, buyers paste the
   address manually — one more reason the canonical page matters.
4. **DEX screeners** — DexScreener, DEXTools and GeckoTerminal index new
   pairs on these DEXes **automatically** within minutes; nothing to submit.
   They will show whatever lock badge they recognize (see `LOCKING.md`) and
   they will show the holder chart — including the premine — to everyone.
5. **CoinGecko** — manual application (their listing request form): requires
   a working website, block explorer link, live trading with non-trivial
   volume/liquidity on a venue they track (these DEXes qualify), project
   socials, and verifiable supply data (circulating vs total — the 30M
   premine must be declared). Free; review takes days to weeks; wash-traded
   volume is grounds for rejection/delisting. GeckoTerminal pair data appears
   automatically long before the full CoinGecko listing.
6. **CoinMarketCap** — same shape: request form, working explorer, verifiable
   supply, live trading on tracked venues; their DEXScan surfaces the pair
   automatically, the full listing is a manual review with the same
   supply-transparency expectations.

Requirements above are as published at the time of writing — re-check the
live forms when applying.

## 4. Monitoring (from minute one)

- wFMX `totalSupply` on the remote chain vs FMX locked in the bridge (mint
  parity — the bridge-exploit tripwire).
- Pool spot price vs the Ferminux-side price; persistent divergence = the
  bridge path is too slow/expensive for arb, spreads will be quoted against you.
- Pair `Sync` events / reserves; alert on any single-tx drain >X%.
- LP holder list of the pair (should be: locker ≈ 100%, dust otherwise).

## 5. The risks, stated plainly

- **Thin liquidity is thin.** See the README table before choosing a size: in
  a $50k pool, a single $10k sell moves the price -30.5%; a $1,000 buy
  already pays 2.25% slippage. Anyone with $25k can crash the price 55% at
  will, and the table is public math — assume sophisticated actors know it.
- **The quote asset is what buyers take away.** The stables/ETH/BNB you seed
  are the only real money in the system. Every net seller walks out with a
  piece of it. The seeded capital is, functionally, the exit liquidity for
  whoever sells first — including your own miners: at the post-fork 12,000
  FMX/day fully sold, a $50k pool's price halves in ~3.4 days and ~$15k of
  the quote is gone (README table). A listing without organic buy-side demand
  is a slow transfer of the seed capital to sellers.
- **The treasury overhang is ~300× the pool.** 30,000,000 FMX premine
  (verified against `genesis/genesis.json`, sum of the 5 alloc accounts) vs
  96,154 FMX in a $50k pool. At the opening price the premine is nominally
  $15.6M against $50k of real quote — that valuation is arithmetic fiction,
  and any buyer who checks the holder chart (DexScreener shows it
  automatically) will see it. Announce the premine, its purpose, and any
  treasury lock/vesting yourself; discovered overhangs read as exit setups.
- **LP in a personal wallet reads as rug risk — because it is.** Whoever
  holds the LP can withdraw both sides at any time. Lock all of it, 12
  months minimum, prove it publicly (`LOCKING.md`), custody the lock in a
  multisig. Expect zero serious buyers before the lock proof is published.
- **A lock is not a halo.** "Liquidity locked" while the treasury holds 30M
  unlocked FMX stops LP withdrawal only — it does not stop the treasury from
  selling FMX into the pool. Claiming safety on the lock alone is misleading
  and will be called out.
- **Bridge risk concentrates here.** A wFMX infinite-mint drains the pool
  completely. Precondition 0.1 is not bureaucracy.
- **Multi-chain listings fragment and diverge.** Two pools = half the depth
  each and an arb spread between them limited by bridge speed/cost. Launch on
  ONE chain first.
- **No wash trading, ever.** Faking volume for CG/CMC listing is market
  manipulation, their detection is good, and delisting is public and
  permanent. The same goes for undisclosed "market making" that is just the
  treasury trading against retail.
