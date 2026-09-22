# Ferminux DEX — AMM Contracts

Constant-product automated market maker for the Ferminux Network (chain id
**3961**, native coin **FMX**). A Solidity-0.8.24 port of the proven Uniswap-v2
mechanics — same math, same invariants, rewritten in the Ferminux house style:
self-contained, no OpenZeppelin, explicit `require` strings, NatSpec, an event on
every state change.

| Contract | File | Purpose |
|---|---|---|
| `FerminuxFactory` | `src/FerminuxFactory.sol` | Deploys pairs with CREATE2, indexes them both ways, owns the protocol-fee switch (**off** by default) |
| `FerminuxPair` / `FerminuxLP` | `src/FerminuxPair.sol` | The pool: `x * y >= k`, 0.30% fee, TWAP accumulators, `skim`/`sync`, reentrancy lock. `FerminuxLP` is its ERC-20 share token with EIP-2612 `permit` |
| `FerminuxRouter` | `src/FerminuxRouter.sol` | The user-facing contract: add/remove liquidity, swaps, native-FMX wrapping, deadlines and slippage bounds on every path |
| `WFMX` | `src/WFMX.sol` | Wrapped native FMX (WETH9-equivalent), 18 decimals |
| `LiquidityLocker` | `src/LiquidityLocker.sol` | Time-locks LP tokens and publishes proof. Extendable, never shortenable, no admin |
| `FerminuxLibrary` | `src/libraries/FerminuxLibrary.sol` | Pricing math as pure functions: `quote`, `getAmountOut/In`, `getAmountsOut/In` |
| `FerminuxMath` / `UQ112x112` | `src/libraries/FerminuxMath.sol` | `sqrt`/`min` and the 112.112 fixed-point format used by the oracle |
| `TransferHelper` | `src/libraries/TransferHelper.sol` | ERC-20 calls that tolerate no-return-value tokens and reject `false` |

## Layout

```
dex/contracts/
├── foundry.toml            solc 0.8.24, optimizer on, evm_version = paris, no metadata
├── src/                    the five deployable contracts + three libraries
│   ├── interfaces/         every external ABI in one file
│   └── libraries/          pricing math, sqrt/fixed point, transfer helper
├── test/                   195 tests (unit, fuzz, stateful invariant)
│   └── mocks/              hostile tokens: fee-on-transfer, no-return, returns-false,
│                           reentrant, flash-swap attacker, FMX rejector
├── script/
│   ├── DeployDex.s.sol     factory + WFMX + router + locker
│   ├── SeedPool.s.sol      create a pair, set the opening price, print the depth
│   └── check-push0.sh      disassembly proof that no contract contains PUSH0
└── lib/forge-std/          test framework only (v1.16.2) — no runtime dependencies
```

## Build, test, verify

Every command below was run in this project and is reproduced verbatim.

```sh
cd <repo>/dex/contracts

forge build --sizes     # all five contracts under the 24,576 B limit
forge test              # 195 passed, 0 failed
forge fmt --check       # clean
./script/check-push0.sh # PASS: zero PUSH0 opcodes
```

Result of the last full run:

| Contract | Runtime (B) | Initcode (B) | Runtime margin (B) |
|---|---:|---:|---:|
| `FerminuxRouter` | 20,442 | 21,203 | 4,134 |
| `FerminuxFactory` | 11,850 | 12,129 | 12,726 |
| `FerminuxPair` | 8,738 | 9,045 | 15,838 |
| `LiquidityLocker` | 7,321 | 7,358 | 17,255 |
| `WFMX` | 1,969 | 2,001 | 22,607 |

The libraries are `internal` and inline into their callers (32 B stubs), so
there is nothing to link at deploy time.

### Test coverage — 195 tests

| Suite | Tests | What it pins down |
|---|---:|---|
| `test/FerminuxPair.t.sol` | 56 | MINIMUM_LIQUIDITY burn, fee-adjusted k check to the wei, first-depositor donation attack, protocol-fee formula, TWAP accumulation + uint32 and uint256 wrap, reentrancy via token callback and flash callee, flash-swap repayment, non-standard ERC-20s, LP `permit`, k-preservation fuzz |
| `test/FerminuxRouter.t.sol` | 69 | Every add/remove/swap path, deadline and slippage bound on each, native FMX in/out, dust refunds, `permit` variants, fee-on-transfer through the supporting variants **and** correct failure through the plain ones, the add-liquidity theft closed on the plain **and** the supporting paths (hostile token as either side, `minLiquidity = 0`), honest 5% fee-token deposits through the supporting paths, the declared-fee hard cap, pricing views |
| `test/LiquidityLocker.t.sol` | 31 | Cannot shorten, cannot withdraw early, cannot withdraw twice, ownership transfer + index integrity, per-token listing accuracy, reentrancy on `lock` and `withdraw`, fuzzed monotonicity |
| `test/FerminuxFactory.t.sol` | 23 | CREATE2 determinism, init code hash matches the compiled artifact, both-direction registry, fee switch permissions |
| `test/WFMX.t.sol` | 12 | 1:1 collateralisation, deposit/withdraw/`receive`, allowance semantics |
| `test/FerminuxDexInvariant.t.sol` | 4 | Stateful: 64 runs × 64 calls of random swaps, deposits, withdrawals, donations, skims and time jumps |

The four invariants (4,096 calls each, 0 reverts):

- `invariant_ReservesEqualBalances` — the recorded reserves are exactly the token
  balances the pool holds, after every settled action.
- `invariant_LpValueNeverFalls` — `sqrt(k) / totalSupply`, the redeemable value
  of one LP token, never decreases. This is the strong form of "k never
  decreases outside burns": a withdrawal *does* lower k, but it lowers supply in
  the same proportion, so LP value is flat. The handler additionally asserts
  `k` non-decreasing on every individual swap, deposit, donation and skim.
- `invariant_PoolNeverFullyDrains` — total supply stays at or above
  MINIMUM_LIQUIDITY and neither reserve can reach zero.
- `invariant_ReservesFitUint112` — the packed reserve encoding never overflows.

### Paris / no PUSH0

ferminux-geth forks go-ethereum v1.10.26, which pre-dates Shanghai: `PUSH0`
(0x5f) is an invalid opcode on chain 3961 and any contract containing one is
bricked on deployment or on first call. `foundry.toml` pins
`evm_version = "paris"`, and `script/check-push0.sh` **proves** it by
disassembling both the creation and the deployed bytecode of all five contracts
with `cast disassemble` — not by grepping for a byte, which would false-positive
on 0x5f appearing as PUSH data.

```
Disassembling Ferminux DEX bytecode (evm_version = paris, no metadata)
CONTRACT           ARTIFACT       BYTES    OPCODES   PUSH0
FerminuxFactory    creation       12129       7534   none  -- ok
FerminuxFactory    deployed       11850       7379   none  -- ok
FerminuxPair       creation        9045       5637   none  -- ok
FerminuxPair       deployed        8738       5484   none  -- ok
FerminuxRouter     creation       21203      12937   none  -- ok
FerminuxRouter     deployed       20442      12431   none  -- ok
WFMX               creation        2001       1238   none  -- ok
WFMX               deployed        1969       1217   none  -- ok
LiquidityLocker    creation        7358       4976   none  -- ok
LiquidityLocker    deployed        7321       4952   none  -- ok
PASS: zero PUSH0 opcodes in any Ferminux DEX contract.
```

### Init code hash

```
INIT_CODE_PAIR_HASH = 0x53c974ba85f7f41b91b2d8ebcc43c9a7be77206235339c2f3e78dce304c32153
```

A pair's address is `CREATE2(factory, keccak256(token0 ‖ token1), INIT_CODE_PAIR_HASH)`
with `token0 < token1` by address, so any wallet, explorer or backend can derive
a pool address with no RPC call. `FerminuxFactory.predictPairAddress()` does the
same on-chain.

The constant is asserted against the compiled artifact by
`test_InitCodeHash_MatchesCompiledPairBytecode`, and
`test_CreatePair_AddressIsDeterministic` asserts that the address CREATE2
actually produced matches the formula. If `FerminuxPair.sol` or the compiler
settings ever change, those tests fail; regenerate with:

```sh
cast keccak $(forge inspect FerminuxPair bytecode)
```

`foundry.toml` sets `bytecode_hash = "none"` and `cbor_metadata = false`, so the
hash depends only on the compiled code — a comment or a moved file no longer
shifts every pool address on the network.

## Deploying

### Local devnet (the only place these were deployed)

```sh
anvil --port 8600 --chain-id 3961 --silent &

forge script script/DeployDex.s.sol --rpc-url http://127.0.0.1:8600 --broadcast

ROUTER=<router address printed above> \
  forge script script/SeedPool.s.sol --tc SeedPool \
  --rpc-url http://127.0.0.1:8600 --broadcast
```

`--tc SeedPool` is required because that file also carries a devnet-only demo
token contract.

`DeployDex` deploys WFMX → factory → router → locker and re-asserts the init
code hash before returning. Env overrides, all optional:

| Var | Default | Meaning |
|---|---|---|
| `DEPLOYER_KEY` | anvil account #0 | broadcasting key |
| `FEE_TO_SETTER` | anvil account #0 | owner of the protocol-fee switch — use the treasury multisig in production |
| `WFMX_ADDRESS` | deploy a new one | reuse an existing wrapper |

`SeedPool` creates a TOKEN/FMX pool, sets the opening price and prints the
depth. Env: `ROUTER` (required), `TOKEN` (defaults to deploying a demo token),
`AMOUNT_TOKEN` (default `10_000e18`), `PRICE_FMX_PER_TOKEN` (default `0.5e18`).

### Production checklist

1. Deploy with `FEE_TO_SETTER` set to the treasury multisig
   (`MinimalMultisig` at `0x910BD467D8576277f8f96DF47428377FFD94fEfe` is the
   existing 2-of-3).
2. Leave `feeTo` at `address(0)` — the protocol fee starts off and 100% of the
   0.30% goes to liquidity providers.
3. Publish `INIT_CODE_PAIR_HASH`, the factory, router, WFMX and locker addresses
   to the wallet/launchpad config.
4. Re-run `./script/check-push0.sh` against the exact artifacts being deployed.

## How the price works — in plain words

**The pool ratio is the price.** A pool holding 10,000 SEED and 5,000 FMX is
quoting 0.5 FMX per SEED, because that is the ratio of what it holds. Nothing
else sets it: there is no order book and no oracle. The first person to deposit
picks the ratio and therefore picks the opening price; everyone after that is
constrained to deposit at the current ratio (the router quotes it for you and
refunds whatever does not fit).

**Trading moves the ratio.** The pool will trade with anyone as long as the
product of its two balances does not fall: `x * y >= k`. Buy SEED and you hand
over FMX and take SEED out, so FMX goes up, SEED goes down, and the next buyer
pays more. That is not a fee — it is the price genuinely moving because the pool
now holds less of what you bought.

**Slippage is how far you move it.** The bigger your trade relative to the
pool's depth, the worse your average fill compared to the price you saw before
you traded. Depth is the only thing that decides this. From the seeded 10,000
SEED / 5,000 FMX pool (mid price: 2 SEED per FMX):

| Trade size | FMX in | SEED out | Total cost vs mid |
|---|---:|---:|---:|
| 0.1% of the FMX reserve | 5 | 9.9601 | 39 bps |
| 1% of the FMX reserve | 50 | 98.7158 | 128 bps |
| 5% of the FMX reserve | 250 | 474.8297 | 503 bps |

Every row includes the flat 0.30% (30 bps) swap fee; the rest is price impact.
At 0.1% of depth you pay roughly the fee and little else. At 5% of depth the
impact is bigger than the fee. Ten times the liquidity means one tenth the
impact for the same trade size — this is why a shallow pool is expensive to
trade even when the quoted price looks fine.

**What the slippage bound is for.** Between the moment you sign and the moment
you land in a block, someone else can trade the same pool and move the price
against you. `amountOutMin` (or `amountInMax`) is the worst fill you are willing
to accept; the router reverts rather than settle outside it. `deadline` covers
the other half: a transaction that sat in the mempool through a price move
cannot be executed later at the stale price. Every router entry point takes both.

## Fees

- **0.30% on every swap**, charged on the input and left in the reserves. It is
  not sent anywhere — it makes the pool slightly richer, so every LP token
  becomes redeemable for slightly more. `test_Swap_FeeAccruesToLiquidityProviders`
  measures this end to end.
- **Protocol fee: off.** When `feeToSetter` sets a `feeTo`, the pool mints LP
  tokens worth 1/6 of the growth in `sqrt(k)` since the last liquidity event to
  that address — i.e. one sixth of the trading fees, leaving five sixths with
  LPs. `test_ProtocolFee_MintsOneSixthOfGrowth` checks the closed formula
  exactly; `test_ProtocolFee_OffByDefault` checks that nothing is minted while
  the switch is off.
- **Multi-hop costs the fee per hop.** A → B → C is two pools and therefore
  ~0.60%, plus impact in both.

## The liquidity locker

The commercial point: a project can add liquidity and remove it a minute later.
Locking the LP tokens makes that impossible until the unlock date, and anyone
can verify it.

```solidity
lock(token, amount, unlockAt) -> id   // pulls LP in, records what arrived
extend(id, newUnlockAt)               // strictly later, never earlier
withdraw(id, to)                      // only at/after unlockAt, only once
transferLock(id, newOwner)            // a locked position can still be sold
```

Views for proving it: `locksForToken(pair)` returns every lock ever created for
that pool including withdrawn ones (the history cannot be erased),
`totalLockedForToken(pair)` is what the contract still holds, and
`totalLockedForTokenAt(pair, timestamp)` is the honest "still time-locked right
now" number, since it excludes locks that have already matured.

There is no owner, no pause, no admin key and no upgrade path — nothing in the
contract can shorten a lock or move someone else's tokens.

## Deliberate deviations from the original

The math and mechanics are ported unchanged. Four implementation choices differ,
each for a stated reason:

1. **`FerminuxLibrary.pairFor` reads the factory registry** instead of deriving
   the address from a hard-coded init code hash. It costs one extra call per hop
   and in exchange the router can never be pointed at a phantom address by a
   stale constant. The pure CREATE2 derivation is still available as
   `pairForDeterministic` / `FerminuxFactory.predictPairAddress` for off-chain use.
2. **`WFMX.withdraw` pays out with a full-gas `call`**, not WETH9's 2300-gas
   `transfer`, so contracts with real `receive()` handlers can unwrap. Safe by
   checks-effects-interactions: the balance is debited before the call.
3. **No CBOR metadata trailer** (`bytecode_hash = "none"`), so pair addresses do
   not move when a comment changes, and the PUSH0 disassembly proof is exact
   rather than heuristic.
4. **Solidity 0.8 checked arithmetic everywhere except two documented places.**
   `unchecked` appears only where the original relied on wrapping, each with a
   comment saying so:
   - the uint32 oracle timestamp subtraction, which must wrap in 2106 for
     elapsed time to stay correct across the rollover;
   - the `price0/1CumulativeLast` accumulators, which are allowed to overflow
     uint256 because consumers only ever read the difference between two
     observations and modular subtraction recovers it.
   `test_TWAP_TimestampWrapsAtUint32` and `test_TWAP_AccumulatorWrapsAtUint256`
   drive both wraps and assert the recovered values.

## Security notes

- The pair is deliberately dumb: it trusts whatever balance it finds and
  enforces only `k`. All accounting, quoting and slippage protection lives in
  the router. Calling the pair directly is supported but you must send the
  tokens first and compute the amounts yourself.
- Every state-changing entry point on the pair (`mint`, `burn`, `swap`, `skim`,
  `sync`) is behind a reentrancy lock. This is load-bearing because `swap` hands
  control to an arbitrary contract for flash swaps — proven by
  `test_Reentrancy_FlashCallbackCannotMintBurnOrSwap`.
- The first-depositor inflation attack is covered by MINIMUM_LIQUIDITY and is
  measured, not assumed: in `test_Attack_FirstDepositorDonation_IsUnprofitable`
  the attacker loses more than 99% of the donation and the victim keeps more
  than 99.9% of their deposit. The rounding-to-zero variant reverts instead of
  silently confiscating the deposit.
- **The add-liquidity theft is closed on every LP-minting entry point.** A
  hostile token that is one side of a pair can credit the pool 2 wei of dust
  while the depositor's counter-asset is fully deposited — vanilla Uniswap-v2
  mints dust LP and the attacker withdraws the counter-asset. The router closes
  it in layers, none of which trusts a value the pair or the token returns:
  the caller's `minLiquidity` floor, enforced on the recipient's LP balance
  delta across the mint; a proportional floor on the plain paths, computed
  from the honest pre-transfer reserves and supply; and on the
  `SupportingFeeOnTransferTokens` add paths — where a sent-amount floor would
  reject honest taxed deposits — a **measured** protection: a mandatory
  `maxFeeBps` declaring the largest transfer tax the caller accepts
  (hard-capped at 20% in the contract), a per-side check that the pool's
  balance actually grew by at least (1 − maxFeeBps) of what was sent, the
  counter-asset leg re-quoted from the first token's measured arrival so it
  can never be donated against tokens that were not credited, and a
  proportional floor computed from the measured arrivals. Worst case by
  construction, even with every other parameter at 0: a hostile token can cost
  the depositor at most the declared fee — never the counter-asset. All of it
  is measured in tests, with the hostile token as either side.
- Fee-on-transfer tokens must use the `SupportingFeeOnTransferTokens` router
  paths, declaring their real tax as `maxFeeBps`. The plain paths fail loudly
  (`ROUTER: liquidity below pool ratio` on deposit, `PAIR: K` on swap,
  `TH: transfer failed` on removal) rather than settling a wrong amount — both
  directions are tested. A pair of two fee-on-transfer tokens works only if
  both fees fit inside the declared allowance.
- **What no router check can do: make an untrusted token safe to pair
  against.** The token contract controls its own side of the pool permanently.
  It can mint itself into the pool and drain the counter-asset by swapping, tax
  or blacklist transfers later, or brick `balanceOf` so the pool is
  untradeable — all AFTER an honest-looking deposit settled. This is a
  property of AMMs, not a bug in this one: the router polices the deposit
  transaction, nothing polices the token's future. Do not pair real value
  against a token you would not trust holding outright; the UI warns for every
  token the TokenFactory registry does not vouch for.
- Rebasing tokens are **not** supported; the reserves are a snapshot, and a
  negative rebase leaves the pool quoting a price it cannot honour until
  someone calls `sync()`.
- These contracts have not been externally audited. They were deployed and
  exercised on a local anvil devnet only — nothing here has touched Ferminux
  mainnet.
