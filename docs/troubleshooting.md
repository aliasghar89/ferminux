# Troubleshooting

Real errors and what fixes them. Most error strings are quoted as the software prints
them, so you can search this page for yours.

## My transaction stays pending

The tip was below 1 gwei. Chain 3961's signers include only transactions whose priority
fee is at least 1 gwei. A node that accepts a lower tip hands back a hash, so the
transaction looks sent and then never confirms. A node set to refuse it answers
`transaction underpriced` instead (next section).

- **Foundry** sends a 1 wei tip here by default. Export
  `ETH_GAS_PRICE=2gwei ETH_PRIORITY_GAS_PRICE=1gwei` before `cast send`, `forge create`
  or `forge script` (details in [Deploy a contract](developers.md#foundry)).
- **A wallet**: if you edited the fee, set the priority fee to 1 gwei and use the
  wallet's speed-up or replace button. The replacement must use the same nonce and a
  higher fee.
- **Your own code**: set `maxPriorityFeePerGas` to at least `1000000000` wei and
  `maxFeePerGas` above it. ethers, viem and Hardhat do this on their own.

To clear a stuck nonce by hand, send a 0 FMX transfer to yourself with the same nonce
and a 1 gwei tip:

```bash
cast send 0xYourAddress --value 0 --nonce <stuck nonce> \
  --gas-price 2gwei --priority-gas-price 1gwei \
  --rpc-url https://rpc.ferminux.net --account <your keystore name>
```

## `transaction underpriced`

The node refused a tip below 1 gwei up front, which is better than accepting it and
leaving it pending. The fixes are the same as above: 1 gwei tip, and with Foundry export
`ETH_GAS_PRICE=2gwei ETH_PRIORITY_GAS_PRICE=1gwei`.

## `max priority fee per gas higher than max fee per gas`

Foundry was given a tip (`--priority-gas-price 1gwei`) but kept its own max fee of a few
wei. Also pass `--gas-price 2gwei` (`--with-gas-price 2gwei` for `forge script`), or
export both `ETH_GAS_PRICE` and `ETH_PRIORITY_GAS_PRICE`.

## `invalid opcode: PUSH0`

The contract was compiled for a newer rule set than chain 3961 runs. Compile with
`evm_version = "paris"` (Foundry), `evmVersion: "paris"` (Hardhat) or
`--evm-version paris` (solc), then deploy again. Libraries you import compile with your
setting, so one line fixes the whole build. Contracts that need transient storage
(`TSTORE`/`TLOAD`) or `MCOPY` cannot run here yet.

## `missing trie node`

You asked for state (a balance, storage, an `eth_call`) at a block more than about 128
blocks old. The public RPC keeps recent state only. Query `latest`, or rebuild history
from event logs, which are kept for the whole chain.

## A `finalized` or `safe` block query returns nothing

Those tags are not supported yet. Use `latest` and wait for confirmations: a node refuses
any reorg deeper than 64 blocks, so 64 confirmations (about 7.5 minutes) is final in
practice.

## `the method … does not exist/is not available`

The public RPC serves `eth`, `net`, `web3`, `txpool` and `clique`. `debug_*`, `trace_*`
and `eth_getBlockReceipts` are not available; fetch receipts one transaction at a time.

## My node stopped at block 159,999

It is a binary from before release A, and it cannot follow the authority fork at block
160,000. Install the current release and restart; the existing data directory is fine:

```bash
curl -fsSL https://ferminux.net/install.sh | bash
ferminux version | head -3
```

The Windows ZIP on the download server is such a pre-fork binary. On Windows, run the
Linux build under WSL2, or use Docker, until a current Windows build is published.

## The start-up banner names another network

Release A prints a few start-up lines inherited from the upstream client. One names the
upstream client's default network (on this binary the default network is chain 3961),
and the `Consensus:` line names the engine of blocks 0 to 159,999. Both are cosmetic.
The lines that matter are:

```
INFO Chain ID:  3961 (ferminux)
INFO  - Ferminux PoSA (Clique authority from this block): 160000
INFO Ferminux proof-of-authority engine armed ...
```

The `WARN Ferminux PoSA checkpoint hash is unset` line is expected on release A.

## The node was killed for running out of memory

Without `--cache`, the client reserves 4 GB of cache because it treats chain 3961 as its
main network. On a small server pass `--cache 256` or `--cache 512`. If it was killed in
the middle of its first sync, delete `<datadir>/ferminux-geth` and start again: a
database written during a crash can fail later with errors about receipts.

## Peers stay at 0

```bash
ferminux attach --exec 'net.peerCount'
```

1. **Outbound traffic blocked.** The node needs outbound TCP and UDP on port 30303 to
   reach the built-in bootnode and other nodes.
2. **Inbound blocked.** Not required, but opening `30303/tcp` and `30303/udp` lets other
   nodes find you and makes your peer count steadier.
3. **A network preset flag.** Do not pass `--mainnet`, `--sepolia` or similar; run with
   no network flag, since chain 3961 is the default.
4. **A pre-fork binary.** A node older than release A may have peers and still stop at
   159,999 (above).

## `Fatal: invalid command-line: too many arguments`

This client wants flags **before** positional arguments.

```bash
# wrong
ferminux attach ~/.ferminux/geth.ipc --exec 'eth.blockNumber'
# right
ferminux attach --exec 'eth.blockNumber' ~/.ferminux/geth.ipc
```

## `attach` cannot find the socket

```
Fatal: Unable to attach to remote geth: dial unix ...: connect: no such file or directory
```

The socket is `geth.ipc` at the top of the data directory: `~/.ferminux/geth.ipc` on
Linux, `~/Library/Ferminux/geth.ipc` on macOS, `<datadir>/geth.ipc` with `--datadir`.
`ferminux attach` with no argument finds the default one. If the node runs with
`--ipcdisable`, attach over HTTP instead: `ferminux attach http://127.0.0.1:8545`.

## The node logs that it is NOT a signer

Release A logs an error that the node "is NOT a PoSA signer: it will never produce a
block at or after PosaBlock" (newer builds say "is NOT a Ferminux signer"). The node
was started with block production switched on, but its key is not in the authorised
set. Remove the block-production flag that the log line's hint names: an ordinary node
does not need it. Signers are added by a vote of the current signers (see
[Run a node](run-a-node.md#signers-and-ordinary-nodes)).

## Signatures are rejected, or a transaction lands on the wrong chain

A signer that defaults to chain ID 1 produces signatures for another network.
Transactions on chain 3961 must carry its chain ID (EIP-155), and the RPC refuses
unprotected ones. Give every tool chain ID 3961; clef needs `--chainid 3961`.

## RPC works on the server but not from another machine

That is the safe default: `--http.addr` is `127.0.0.1`. Do not change it to `0.0.0.0` on
an internet-facing machine. Put a reverse proxy with TLS and rate limits in front, and
see [Run a node](run-a-node.md#json-rpc-and-how-not-to-get-drained).

## Backup tools cannot find the chain data

It is in `<datadir>/ferminux-geth/chaindata`, not `geth/chaindata`. The folder keeps the
name `ferminux-geth` whatever the binary is called. The keystore is at
`<datadir>/keystore`.
