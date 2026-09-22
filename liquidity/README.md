# Ferminux Remote Liquidity

Tooling and playbook for creating a market for **wrapped FMX (wFMX)** on other
chains, so outside buyers can buy it with money that already lives there.

Scope: everything **after** the Ferminux bridge (at `../bridge`, owned by
another team, still in security review) has minted wFMX on a remote chain.
This package creates the Uniswap-v2-compatible pool, seeds it at a chosen
opening price, locks the LP so the market can verify it cannot be rugged, and
tells you — with real numbers — what the pool can and cannot absorb.

**Nothing here broadcasts by default.** Every state-changing script is a dry
run unless you pass `--broadcast` **and** `--yes` **and** provide
`PRIVATE_KEY` in the environment. This is enforced in code
(`lib/common.mjs: broadcastGate`) and proven by the rehearsal logs.

```
liquidity/
├── chains.json                verified router/factory/wrapped-native per chain, with sources
├── lib/common.mjs             shared plumbing (chain config, broadcast gate, ABIs)
├── scripts/
│   ├── create-pool.mjs        create pair + add initial liquidity at a chosen price
│   ├── pool-state.mjs         read-only pool state printer
│   ├── lock-lp.mjs            deploy LiquidityLocker + lock LP + print public proof
│   ├── plan-pool.mjs          pool-planning calculator (pure math, no network)
│   └── fork-rehearsal.mjs     full end-to-end rehearsal against a local anvil fork
├── artifacts/                 LiquidityLocker + MockERC20 (compiled in ../dex/contracts:
│                              solc 0.8.24, evm_version=paris, optimizer 200, no CBOR metadata)
├── rehearsal-logs/            transcripts of the fork rehearsals (real gas receipts)
├── LOCKING.md                 LP-locking path per chain, and how a buyer verifies it
└── RUNBOOK.md                 go-live runbook: costs, order of operations, discovery, risks
```

## Verified DEX addresses

| Chain (chainId) | DEX | Router | Factory | Fee |
|---|---|---|---|---|
| BNB Smart Chain (56) | PancakeSwap v2 | `0x10ED43C718714eb63d5aA57B78B54704E256024E` | `0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73` | 0.25% |
| Ethereum (1) | Uniswap v2 | `0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D` | `0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f` | 0.30% |
| Base (8453) | Uniswap v2 | `0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24` | `0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6` | 0.30% |
| Arbitrum One (42161) | Uniswap v2 | `0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24` | `0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9` | 0.30% |
| Polygon PoS (137) | QuickSwap v2 | `0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff` | `0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32` | 0.30% |

### How these addresses were verified (2026-08-20)

Each entry was checked against **at least two independent sources**, recorded
per-chain in `chains.json` under `sources`:

1. **Official documentation / explorer labels.** Uniswap's deployments page
   (developers.uniswap.org → protocols → v2 → deployments) for Ethereum, Base
   and Arbitrum; PancakeSwap's developer docs and the BscScan labels
   "PancakeSwap: Router v2" / "PancakeSwap: Factory v2"; QuickSwap's docs
   (docs.quickswap.exchange → contracts-and-addresses) and the PolygonScan
   label "QuickSwap V2: Router".
2. **Live on-chain reads** (read-only `eth_call` via public RPCs — three
   independent RPCs for Ethereum and Polygon): `router.factory()` must return
   the documented factory and `router.WETH()` the canonical wrapped native.
   Reproduce any row:

   ```sh
   cast call <router> "factory()(address)" --rpc-url <public rpc>
   cast call <router> "WETH()(address)"    --rpc-url <public rpc>
   ```

   For Ethereum we additionally confirmed `factory.allPairsLength()` (519,170
   pairs) and `factory.getPair(USDC, WETH)` returning the canonical
   `0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc` pair.

`create-pool.mjs` re-runs the `router.factory()` cross-check at execution time
and aborts on mismatch, so a corrupted `chains.json` or a lying RPC cannot
route funds to the wrong contract.

> **Lookalike warning, learned the hard way while building this:** the widely
> mis-quoted address `0x5C69…CB9cc8aa6f` (one hex digit off the real Uniswap
> v2 factory `0x5C69…CB9cc5aA6f`) has **no code** on Ethereum mainnet. Never
> copy a contract address from memory, a blog post, or a chat message. Docs +
> on-chain cross-check, every time.

## Pool-planning calculator

```sh
node scripts/plan-pool.mjs --capital 50000 --price 0.52 --emission 12000 --fee-bps 25
node scripts/plan-pool.mjs --compare 5000,25000,50000,100000 --price 0.52 --emission 12000 --fee-bps 25 --markdown
```

### Real output (run 2026-08-20)

Assumptions behind this table — change any of them and re-run before spending
money:

- **Opening price $0.52/FMX** — the platform's reference price for FMX
  (100M cap). It is a chosen number, not a market price; there is no outside
  market yet.
- **Emission 12,000 FMX/day** — the chain's real schedule: 1 FMX/block from
  the Emission fork at block 20,000 (`chain/consensus/ethash/ferminux.go`),
  ~7.2s target → ~12,000 blocks/day. The live chain was at block 7,344 on
  2026-08-20, still paying 6 FMX/block (72,000 FMX/day) until the fork block;
  do not list before emission drops, the launch-rate column would be 6× worse.
  The model assumes **all** of it is sold into this one pool daily — the
  honest worst case for a miner-fed market, since miners sell to pay power.
- **Fee 0.25%** (PancakeSwap v2). Uniswap/QuickSwap are 0.30% — differences
  are in the second decimal.
- Quote is a USD stable; "Sell $X" means FMX valued at the opening price.

| Metric | $5,000 | $25,000 | $50,000 | $100,000 |
|---|---|---|---|---|
| Pool depth (quote + FMX) | $5,000 + 9,615 FMX | $25,000 + 48,077 FMX | $50,000 + 96,154 FMX | $100,000 + 192,308 FMX |
| Buy $100 — slippage | 2.25% | 0.65% | 0.45% | 0.35% |
| Buy $1,000 — slippage | 20.25% | 4.25% | 2.25% | 1.25% |
| Buy $10,000 — slippage | 200.25% | 40.25% | 20.25% | 10.25% |
| Sell $100 — slippage | 2.20% | 0.65% | 0.45% | 0.35% |
| Sell $1,000 — slippage | 16.84% | 4.08% | 2.20% | 1.24% |
| Sell $10,000 — slippage | 66.69% | 28.70% | 16.84% | 9.30% |
| Spot after $1,000 sold | $0.3613 (-30.5%) | $0.4808 (-7.5%) | $0.4998 (-3.9%) | $0.5098 (-2.0%) |
| Spot after $5,000 sold | $0.1302 (-75.0%) | $0.3613 (-30.5%) | $0.4298 (-17.3%) | $0.4717 (-9.3%) |
| Spot after $10,000 sold | $0.05787 (-88.9%) | $0.2655 (-48.9%) | $0.3613 (-30.5%) | $0.4298 (-17.3%) |
| Spot after $25,000 sold | $0.01447 (-97.2%) | $0.1302 (-75.0%) | $0.2313 (-55.5%) | $0.3330 (-36.0%) |
| Days of emission to halve price | 0.4 | 1.7 | 3.4 | 6.7 |
| Quote extracted by then | $1,662 | $7,432 | $14,865 | $29,421 |
| IL if FMX -50% | -5.72% | -5.72% | -5.72% | -5.72% |
| IL if FMX +100% | -5.72% | -5.72% | -5.72% | -5.72% |

Read the halving row before anything else: **even a $100,000 pool holds the
opening price for less than a week if daily emission is sold into it.** A
listing is only sustainable if miners hold, buy-side demand exists, or the
pool is continuously topped up. The runbook says this again, in bold.

## Creating a pool (dry run first — always)

```sh
# plan (nothing sent, no key needed):
node scripts/create-pool.mjs --chain bsc --token 0xWFMX --quote 0xQUOTE \
     --quote-amount 50000 --price 0.52

# rehearse the exact broadcast on a local fork (see below), then:
PRIVATE_KEY=0x... node scripts/create-pool.mjs --chain bsc --token 0xWFMX --quote 0xQUOTE \
     --quote-amount 50000 --price 0.52 --broadcast --yes

# inspect any time:
node scripts/pool-state.mjs --chain bsc --token 0xWFMX --quote 0xQUOTE --holder 0xYOU

# lock the LP (LOCKING.md explains the per-chain choice):
PRIVATE_KEY=0x... node scripts/lock-lp.mjs --chain bsc --pair 0xPAIR --amount all \
     --unlock 2027-09-01 --broadcast --yes
```

Safety properties, all enforced in code: chainId must match the chain key
(forks pass, wrong chains don't); Ferminux mainnet (3961) is always refused;
`router.factory()` is re-verified; a funded pair at a different price aborts
with an explanation (adding liquidity does not set a price — arbitrage eats
the difference); balances and allowances are pre-checked; `addLiquidity` is
`staticCall`-simulated before the real send.

## Fork rehearsal (what was actually tested)

```sh
node scripts/fork-rehearsal.mjs --chain bsc  --port 8603
node scripts/fork-rehearsal.mjs --chain base --port 8604
```

Spawns `anvil --fork-url <public rpc>` locally, deploys a stand-in wFMX
(MockERC20 — the real one will be the bridge mint), then drives the **real
scripts** end to end: proves the broadcast gate refuses without `--yes`,
creates the pair on the forked DEX, adds liquidity, reads the pool back,
deploys LiquidityLocker, locks all LP, and proves `withdraw` before maturity
reverts with `LOCKER: still locked`.

**Results 2026-08-20 — all five chains PASSED** (transcripts with tx hashes
and gas receipts in `rehearsal-logs/`):

| Chain | Forked from | Total gas, full sequence |
|---|---|---|
| BSC | bsc-dataseed.bnbchain.org (block 117,059,487) | 5,557,135 |
| Base | mainnet.base.org | 4,811,525 |
| Ethereum | ethereum-rpc.publicnode.com | 4,812,023 |
| Arbitrum | arb1.arbitrum.io/rpc | 4,842,794 |
| Polygon | polygon-bor-rpc.publicnode.com | 4,812,175 |

Full sequence = wrap + createPair + 2 approvals + addLiquidity + locker
deploy + approve + lock. BSC is higher because PancakeSwap's pair init code
is larger (createPair 3.25M vs ~2.5M). USD ballparks in `RUNBOOK.md`.

## What was NOT done (honesty section)

- **No mainnet transaction was sent anywhere** — not on Ferminux, not on any
  remote chain. Everything state-changing ran on local anvil forks only.
- **wFMX does not exist yet** on any remote chain; the bridge is in security
  review. Rehearsals used a stand-in MockERC20.
- **Quote-token addresses (USDT/USDC per chain) are deliberately not pinned**
  in `chains.json` — they were not part of this verification pass. Verify at
  execution time against the issuer's official docs + explorer label, the
  same two-source discipline used for the routers.
- Third-party locker addresses (UNCX/Team Finance) are likewise not pinned —
  see `LOCKING.md` for how to obtain them safely if that path is chosen.
