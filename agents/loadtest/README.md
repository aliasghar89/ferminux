# Wizrd load test (`agents/loadtest`)

A labelled, disclosed network load test run by Wizrd (agent #12). Up to 100,000 wallets make small FMX
transfers on chain 3961 and sweep every coin back to Wizrd's main address. It is not organic usage:
every one of its transactions carries a marker, the explorer labels them, and the public usage numbers
leave them out.

- Manifest: `https://ferminux.net/.well-known/wizrd-loadtest.json` (gateway `GET /api/loadtest/manifest`)
- Counters: `GET https://ferminux.net/api/loadtest/stats`
- Membership: `GET https://ferminux.net/api/loadtest/address/<address>`

## What it does

Wallets come from one dedicated BIP-39 seed at `m/44'/60'/7'/0/i`:

| Index | Role |
|---|---|
| 0 | the float: the owner (or Wizrd) funds it, it funds every other wallet and receives every sweep |
| 1 … N − 1 | load-test wallets (N = `WALLETS`, 100,000 by default), activated in waves |

The runner generates the seed on first start into `DATA_DIR/seed.txt` (24 words, mode 0600, directory
0700) when the file is absent. The seed is never logged, printed or published. The account-level xpub is
published in the stats and the manifest, so anyone can derive every load-test address; it cannot spend.

A pass walks indices 1 … N − 1 in waves of `WAVE_SIZE` wallets (up to `MAX_ACTIVE_WAVES` at once):

1. **fund**: the float sends each wallet a random amount: 95 % uniform in 0.01–1 FMX, 5 % in 1–20 FMX
   (0.0001 FMX grid), capped so the FMX out of the float never exceeds `MAX_FLOAT_IN_FLIGHT_FMX`;
2. **transfer**: each wallet sends 1–3 amounts (5–50 % of what is left of its budget) to other wallets
   of the same wave; the budget keeps twice today's gas for every send and the sweep;
3. **sweep**: each wallet sends its whole balance minus the exact gas back to the float;
4. **verify**: balances are read again and anything that can still pay its own gas is swept again.

Every `SINK_SWEEP_INTERVAL_S` (1 h) the float sends what it holds above `FLOAT_RESERVE_FMX` to `SINK`
(Wizrd, `0xD7175A244a3Eab83f574135318d037Fb6221C358`). At the end of a pass, and on DRAIN, a final
sweep pass reads the balance of every wallet ever activated and sweeps any that can pay its gas. Then the
float sends everything (DRAIN, or `LOOP=false`) or everything above its reserve (the next pass) to the
sink. What stays in a wallet is dust smaller than one transfer's gas; in practice it is zero (below).

## Every transaction

- Type 2, `data = 0x46584c5401`: the marker `FXLT` (`0x46584c54`) and version byte `01`.
- Gas limit = the exact intrinsic gas: 21,000 + 16 per non-zero data byte = **21,080** on 3961 today. At
  start the runner asks the node (`eth_estimateGas` on a marked transfer) and accepts only 21,080 (london)
  or 21,200 (the EIP-7623 floor); anything else and it sends nothing.
- `maxPriorityFeePerGas` = 1 gwei (the signers' minimum), `maxFeePerGas` = next base fee + tip, so the
  effective price is exactly the max fee and a sweep of `balance − 21,080 × maxFee` leaves 0 wei.
- Written with its raw signed bytes to `DATA_DIR/state.json` (temp file, fsync, rename) BEFORE it is
  broadcast. One unaccepted transaction per sender at a time; nonces are tracked per wallet.
- Retries: transport errors back off exponentially; a transaction without a block after
  `RECEIPT_TIMEOUT_S` is rebroadcast as-is; after `STUCK_AFTER_S` it is replaced with fees +25 % (a sweep
  recomputes its value so it still empties the wallet). Each nonce is counted once, from its receipt.

## Safety

Checked every `GUARD_INTERVAL_S` (10 s). Any failure pauses the runner (nothing signed or sent) and logs
why; two healthy checks in a row resume it. A guard it cannot read counts as failed.

| Guard | Pauses when | Source |
|---|---|---|
| head | the head block is older than `MAX_HEAD_AGE_S` (30 s) | `eth_getBlockByNumber` |
| signers | fewer than `MIN_SIGNERS` (3) signers confirmed a block in the last 64 | `clique_status`, else the gateway's `/api/status` |
| pool | more than `MAX_TXPOOL_PENDING` (2,000) transactions pending | `txpool_status` |
| explorer | the explorer index is more than `MAX_EXPLORER_LAG_BLOCKS` (100) behind | `EXPLORER_API/main-page/blocks` |
| float | the float is below `FLOAT_MIN_FMX` and nothing is out to come back | `eth_getBalance` |

Stops:

- **Dry-run is the default.** Without `LOADTEST_ENABLED=true` the runner generates the seed, publishes
  the stats (`mode: "dry-run"`), checks the guards and logs the waves it would run. It signs nothing,
  sends nothing and writes no progress.
- `touch HALT` in `DATA_DIR`: stops sending while the file exists (receipts are still read).
- `touch DRAIN` in `DATA_DIR` (or `LOADTEST_DRAIN=true`): no new waves; finishes the ones in flight,
  sweeps every activated wallet, sends the whole float to the sink and stops (`mode: "drained"`).
  Removing it carries on where it stopped.
- The rate is 2 tx/s by default; above 10 tx/s needs `LOADTEST_ALLOW_HIGH_RATE=1` (test chains).
- **Ending the test for good is DRAIN, not dry-run.** `LOADTEST_ENABLED=false` (or HALT) mid-run leaves the
  coins of the waves in flight in their wallets until the runner is enabled again. In dry-run it still reads
  the receipts of what it already sent, so the public counters stay right, and it logs a warning while
  coins are out.

## Files

| Where | What | Who reads it |
|---|---|---|
| `DATA_DIR/seed.txt` | the seed (0600) | the runner only |
| `DATA_DIR/state.json` | progress, nonces, signed transactions in flight, counters | the runner only |
| `PUBLIC_DIR/stats.json` | counters, mode, pause reason, float, sink, marker, xpub, organic counts, index snapshots | the gateway (read-only mount) |
| `PUBLIC_DIR/addresses.bin` | 20 bytes per wallet, indices 0 … highest activated | the gateway (membership) |

## Configuration

| Env | Default | |
|---|---|---|
| `LOADTEST_ENABLED` | `false` | `true` to send |
| `RPC_URL` | `http://rpc1:8545` | |
| `SINK` | Wizrd `0xD717…C358` | must be a plain account outside the branch |
| `WALLETS` | `100000` | N, float included |
| `RATE_TX_PER_S` | `2` | token bucket over every send |
| `WAVE_SIZE` / `MAX_ACTIVE_WAVES` | `25` / `4` | |
| `MAX_FLOAT_IN_FLIGHT_FMX` | `50` | cap on FMX out of the float at once |
| `FLOAT_RESERVE_FMX` | `60` | the float keeps this; the rest goes to the sink hourly |
| `FLOAT_MIN_FMX` | `1` | float guard |
| `SINK_SWEEP_INTERVAL_S` / `SINK_SWEEP_MIN_FMX` | `3600` / `1` | |
| `LOOP` | `true` | start a new pass after the final sweep |
| `TIP_GWEI` | `1` | |
| `STATUS_URL` | `http://agents:8790/api/status` | signer fallback |
| `EXPLORER_API` | `https://explorer.ferminux.net/api/v2` | `off` disables the explorer guard and the index snapshots |
| `INDEX_READ_INTERVAL_S` | `5` | how often the index's totals are read (index snapshots) |
| `ORGANIC_WALK` / `ORGANIC_CONFIRMATIONS` | `true` / `12` | the chain walk that counts organic transactions |
| `GUARD_INTERVAL_S`, `MAX_HEAD_AGE_S`, `MIN_SIGNERS`, `MAX_TXPOOL_PENDING`, `MAX_EXPLORER_LAG_BLOCKS` | 10, 30, 3, 2000, 100 | |
| `AMOUNT_SMALL_MIN_FMX` … `AMOUNT_LARGE_MAX_FMX`, `AMOUNT_LARGE_SHARE` | 0.01, 1, 1, 20, 0.05 | |
| `DATA_DIR` / `PUBLIC_DIR` | `/data` / `/public` | |

## Tests

Its only dependency is ethers 6 (typescript and @types/node to build), all already in the `agents/`
workspace install, so it builds from there without a second lockfile:

```sh
cd agents && npm ci          # once, at the workspace root
cd loadtest
npm run build
npm test                    # 25 tests: marker, gas, amounts, derivation, seed file, and the runner on an
                            # in-memory chain (full pass, random restarts, every guard, dry-run, HALT/DRAIN,
                            # fee bump, LOOP into a second pass)
npm run test:integration    # anvil fork of 3961 (london), 1,000 wallets at 60 tx/s, a SIGKILL + restart,
                            # a signer-guard pause and a HALT; audits every block afterwards
```

The integration run never touches mainnet: the runner's RPC is the fork on 127.0.0.1 (the script refuses
anything else) and the fork is thrown away. Result on 2026-09-25 (fork of block 400,214):
4,012 load-test transactions in 157 blocks, all marked, all 21,080 gas; counters equal to the blocks
(transactions, per kind, per day, volume, gas, 1,000 addresses); a SIGKILL with 57 transactions in flight
lost and double-counted nothing; 0 marked transactions landed while paused or halted; every wallet ended
at 0 wei and the sink received 250 FMX in minus exactly the 0.0846 FMX of gas.

## Organic figures: the chain walk and the index snapshots

The explorer shows the network's totals without the load test. Two sources, in this order:

**The chain walk** (`src/organic.ts`, `stats.json` → `organic`). The runner counts every transaction on chain
that is not the load test's, straight from the blocks, up to `ORGANIC_CONFIRMATIONS` (12) below the head:
old blocks by `eth_getBlockTransactionCountByNumber` (500 a step), the last ~58 h by
`eth_getBlockByNumber(n, false)` (the count and the block time, for the rolling 24 h), and every block
from the first one that can hold a load-test transaction (`ltFromBlock`: the head when the runner first
went live) with its transactions, where one is the load test's when its input starts with the FXLT marker
AND its sender is a load-test wallet (the explorer's labelling rule). The first start walks the whole
chain: a few hundred batched calls, one step every half second, after which it takes one step per new
block. Until it has caught up once, `organic` is `{ ready: false }` and the explorer does not use it.
Published: `transactions` (organic, all time, through `throughBlock`), `last24h` (organic, by block time),
`loadtest` (ours found by the walk: equals `counters.transactions` once every receipt is in), `at`.
This is exact at any load-test rate; subtracting our count from the index's figure is not, because the
index counts on a timer and a few seconds of doubt about when is a hundred transactions at 20 tx/s, more
than the network's organic traffic in a day.

**Index snapshots** (addresses, and the fallback). The explorer's index caches its network totals and
recounts them on a timer (every 5 min on explorer.ferminux.net, `explorer/envs/backend.env`; Blockscout's
defaults are 2 h, 30 min and 1 h). Every `INDEX_READ_INTERVAL_S` (5 s) the runner reads
`EXPLORER_API/stats` and `/transactions/stats`; when a figure changes it records it with our counts at the
previous read (`lo`) and at this one (`hi`): the recount happened in between, so the figure holds `lo … hi`
of ours, and `lt` is the middle (`stats.json` → `indexSnapshot`, the last 24 per figure; `indexRead` is the
last read). The last read is kept in `state.json`, so a recount while the runner was down is bracketed too.
A figure read before anything was sent holds none of ours (`lo = hi = 0`); one with no earlier read has
`lo: null` and the explorer does not subtract it. For addresses our count is the wallets funded at least
once plus the float (`counters.addressesOnChain`), which is what the index can have seen.
