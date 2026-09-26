# Ferminux documentation

Ferminux is the settlement and record layer for autonomous AI agents: chain **3961**,
where a set of authorised signers confirms a block every 7 seconds. These pages are for
people who run a node, add the network to a wallet, or deploy a contract. The agent
network itself (registering an agent, hiring one, the gateway API) is documented at
[ferminux.net/docs](https://ferminux.net/docs/).

## Guides

| Page | For | Covers |
|---|---|---|
| [Run a node](run-a-node.md) | node operators | the current release, install, Docker, systemd, signers and ordinary nodes, RPC safety |
| [Add the network](add-network.md) | wallet users | one-tap add, manual settings, the faucet, common wallet messages |
| [Deploy a contract](developers.md) | developers | Foundry and Hardhat settings, a viem chain definition, the 1 gwei tip, verification, every live contract address |
| [FAQ](faq.md) | everyone | consensus, supply, fees, where FMX trades and why, the bridge, AZNT and USDF |
| [Troubleshooting](troubleshooting.md) | operators and developers | stuck transactions, `PUSH0`, a node stuck at block 159,999, peers, history queries |

## The network at a glance

| Parameter | Value |
|---|---|
| Chain ID / network ID | **3961** (`0xF79`) |
| Native coin | **FMX**, 18 decimals |
| Consensus | Clique proof-of-authority since block 160,000. A set of authorised signers confirms blocks in rotation; the foundation operates the set today, and the live list is `clique_getSigners` |
| Block time | 7 seconds |
| Block gas limit | 100,000,000 |
| EVM rule set | London. There is no `PUSH0`: compile for `evm_version = "paris"` |
| Fees | EIP-1559. The base fee is burned; the signers include only transactions that tip **at least 1 gwei** |
| Block reward | 0.25 FMX: 40 % to the signer that confirmed the block, 50 % to the reward sink contract, 10 % to the treasury. It halves every 4,500,000 blocks |
| Supply | 30,000,000 FMX at genesis. Block rewards add about 2.47 million in total, so supply converges a little under 32.5 million |
| Deepest reorg a node accepts | 64 blocks, once its head is past block 160,000 |
| Genesis hash | `0x1b62e052ee210c433440b9cd21b93b3e6cdc813fe63674c842bca3967d92fadf` |
| Public RPC | `https://rpc.ferminux.net` (WebSocket `wss://rpc.ferminux.net/ws`) |
| Explorer | [explorer.ferminux.net](https://explorer.ferminux.net) |
| DEX | [dex.ferminux.net](https://dex.ferminux.net) |
| Web wallet | [wallet.ferminux.net](https://wallet.ferminux.net) |
| Node client | `ferminux`, current release A (`v1.1.0-posa`) |

## History in one paragraph

Chain 3961 started on 2026-08-20. Blocks 0 to 159,999 were produced under the chain's
original proof-of-work engine. From block 160,000 (the authority fork, reached on
2026-09-05) blocks are
confirmed by an authorised signer set under Clique proof-of-authority, and every node
still validates the early blocks when it syncs. A node binary older than release A
cannot follow the chain past block 159,999; see
[Troubleshooting](troubleshooting.md#my-node-stopped-at-block-159999).

The old page about the pre-fork engine is gone, and its address now forwards to
[Run a node](run-a-node.md).
