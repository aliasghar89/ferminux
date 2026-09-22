# Ferminux Network

A sovereign, EVM-compatible Layer-1 blockchain. **Ethash proof-of-work anyone can mine
from day one**, ~7-second blocks, EIP-1559 fees measured in fractions of a cent, and a
full self-hosted stack — node, explorer, wallet, mining pool and token launchpad — with
no dependency on Infura, Alchemy or any third-party chain service.

**Live:** [ferminux.net](https://ferminux.net) · [explorer](https://explorer.ferminux.net) ·
[wallet](https://wallet.ferminux.net) · [launchpad](https://launchpad.ferminux.net) ·
RPC `https://rpc.ferminux.net`

```bash
# Run a node in one line (Linux / macOS)
curl -fsSL https://ferminux.net/install.sh | bash
ferminux-geth                                    # zero config — joins ChainID 3961

# Mine FMX
ferminux-geth --mine --miner.threads 2 --miner.etherbase 0xYourAddress
```

## Network parameters

| | |
|---|---|
| Chain name | Ferminux Network |
| ChainID / NetworkID | **3961** (0xF79) |
| Native coin | **FMX**, 18 decimals, 100,000,000 hard cap |
| Consensus | Ethash PoW — standard DAG and epochs, every Ethash GPU miner works |
| Block target | ~7 s (EIP-100 difficulty retuned, no difficulty bomb) |
| Block reward | 6 FMX, halving every 4,500,000 blocks |
| Fees | EIP-1559 from genesis, 1 gwei initial base fee |
| Block gas limit | 30,000,000 |
| Genesis hash | `0x1b62e052ee210c433440b9cd21b93b3e6cdc813fe63674c842bca3967d92fadf` |
| Genesis inscription | *"Made with love by Wizrd - FMX"* |

Supply: 30M premine (treasury, ecosystem, team-vested, stablecoin ops, community) +
mining emission converging to 54M. See [`docs/faq.md`](docs/faq.md) for the full
breakdown, the halving table, and an honest note on why the 100M cap is economic rather
than consensus-enforced.

## Repository layout

| Path | What it is |
|---|---|
| [`chain/`](chain) | **ferminux-geth** — the Ferminux node. Its codebase descends from the go-ethereum client (as BNB Chain, Polygon and Avalanche C-Chain do); it runs the Ferminux chain only: chain ID 3961, Clique signers, FMX, our genesis and bootnodes. It does not connect to Ethereum |
| [`genesis/`](genesis) | Genesis block definition and the premine allocation table |
| [`contracts/`](contracts) | Foundry project: AZNT stablecoin, FMXVesting, Faucet, TokenFactory, MinimalMultisig — 166 tests |
| [`proxy/`](proxy) | `fmx-stratum-proxy` — ethash stratum proxy so lolMiner/GMiner/SRBMiner GPUs mine out of the box |
| [`wallet-web/`](wallet-web) | Self-custody web wallet — keys never leave the page |
| [`launchpad/`](launchpad) | One-click ERC-20 launcher on top of TokenFactory |
| [`explorer/`](explorer) | Blockscout deployment configured for Ferminux, incl. a PoW reward seeder |
| [`infra/`](infra) | Production deployment: single-server compose, Kubernetes manifests, nginx, Cloudflare runbook |
| [`site/`](site) | ferminux.net static site and the one-line installer |
| [`docs/`](docs) | Run a node, mine (CPU + GPU), add the network, FAQ, troubleshooting |
| [`miner-app/`](miner-app) | Flutter desktop app: node supervisor, mining dashboard, keystore wallet |
| [`devnet/`](devnet) | Local multi-node devnet for development |

## Build from source

```bash
# Node client (Go 1.18–1.20; on newer toolchains use GOTOOLCHAIN=go1.20.14)
cd chain && make ferminux-geth        # -> build/bin/ferminux-geth

# Contracts (Foundry)
cd contracts && forge install foundry-rs/forge-std && forge build && forge test

# Stratum proxy
cd proxy && go build ./...
```

Every component has its own README with exact, tested commands.

## Security

Chain data and node operation are documented in [`docs/`](docs). If you find a
vulnerability in the client, the contracts, or the infrastructure, please report it
privately rather than opening a public issue.

Never share a recovery phrase or private key with anyone, including people claiming to
represent Ferminux. Nobody legitimate will ever ask for one.

## License

Everything the Ferminux authors wrote is **MIT**. `chain/` descends from the
go-ethereum codebase, whose licence travels with the code, so that directory stays
**LGPL-3.0** (`chain/COPYING.LESSER`) with the upstream readme preserved at
`chain/README.upstream.md`. Shared lineage, separate network: Ferminux is its own
chain with its own signers, genesis and coin.
