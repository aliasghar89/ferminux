# ferminux-geth

The Ferminux Network node — a minimal, surgical fork of
[go-ethereum v1.10.26](https://github.com/ethereum/go-ethereum/tree/v1.10.26)
(the last PoW-capable geth: Ethash + London/EIP-1559). Upstream's original
readme is preserved as [README.upstream.md](README.upstream.md).

**ferminux-geth is a dedicated client.** Its consensus rules apply from
genesis to every chain it runs: it cannot validate Ethereum, and vanilla geth
cannot validate Ferminux. Every Ferminux node and miner runs this binary.

## Network parameters

| Item | Value |
|---|---|
| ChainID / NetworkID | 3961 (0xF79) — the built-in default |
| Consensus | Ethash PoW (standard DAG/epochs — every Ethash GPU miner works) |
| Block target | ~7 s (EIP-100 adjustment retuned: divisor 5, no difficulty bomb) |
| Block reward | 6 FMX, halving every 4,500,000 blocks |
| PoS transition | block 4,500,000 (first halving) — **hooks only**; engine swap comes later behind the `consensus.Engine` interface |
| Genesis | baked in — hash `0x1b62e052ee210c433440b9cd21b93b3e6cdc813fe63674c842bca3967d92fadf`, identical to `../genesis/genesis.json` |
| Fees | EIP-1559 from block 0, 1 gwei initial base fee |
| Emission | 30M premine + base PoW emission converging to 54M (+ uncle rewards) — inside the 100M hard cap even if PoS never ships |

## What was changed vs upstream

New files (all Ferminux logic is isolated here):

- `consensus/ethash/ferminux.go` — 7s difficulty rule + 6 FMX halving reward
- `consensus/ethash/ferminux_test.go` — reward table, difficulty vectors, emission cap, convergence simulation
- `params/ferminux.go` — `FerminuxChainConfig`, `FerminuxGenesisHash`, `FerminuxBootnodes`
- `core/genesis_ferminux.go` (+ test) — built-in genesis, byte-identical to `genesis/genesis.json`

Minimal edits to upstream:

- `consensus/ethash/consensus.go` — `CalcDifficulty` and `accumulateRewards` delegate to `ferminux.go` (upstream Ethereum difficulty *tests* are expected to fail; run the `TestFerminux*` suites)
- `core/genesis.go` — Ferminux is the default/known network (zero-config startup, config recovery)
- `eth/ethconfig/config.go` — default NetworkId 3961
- `cmd/utils/flags.go` — default bootnodes → `FerminuxBootnodes`
- `eth/backend.go` — mined blocks stamp "ferminux" in extra-data
- `node/defaults.go` — default datadir `~/.ferminux` (mac: `~/Library/Ferminux`)
- `cmd/geth/main.go` — client advertises as `ferminux-geth/v…`; the IPC socket stays `geth.ipc` for tooling compatibility
- `Makefile`, `Dockerfile`, `.github/workflows/release.yml` — `ferminux-geth` binary + native release builds (linux amd64/arm64, windows amd64, macos arm64)

## Build

```bash
# Native (Go 1.18–1.20; on newer Go use: GOTOOLCHAIN=go1.20.14 make ferminux-geth)
make ferminux-geth            # → build/bin/ferminux-geth

# Docker
docker build -t ferminux/geth:dev .
```

## Run

```bash
# Zero config: empty datadir joins the Ferminux Network (ChainID 3961)
ferminux-geth

# Mine
ferminux-geth --mine --miner.threads 4 --miner.etherbase 0xYourAddress

# The genesis is baked in, so `init` is unnecessary — but still works and
# produces the identical chain (flags BEFORE the file on this geth line):
ferminux-geth init --datadir ~/.ferminux ../genesis/genesis.json
```

## Test

```bash
go test ./consensus/ethash/ -run 'TestFerminux' -v
go test ./core/ -run 'TestDefaultFerminuxGenesis' -v
```

The convergence test simulates 60k blocks under constant hashrate and asserts
the average block time lands in 6.0–8.5s (analytic equilibrium: 5/ln 2 ≈ 7.2s).

## Known sharp edges (reviewed, deliberate)

- **`--mainnet` / `--ropsten` / `--sepolia` / `--goerli` / `--rinkeby` still parse**
  but are non-functional: the unconditional Ferminux consensus rules reject
  Ethereum blocks past genesis. Don't use them. Likewise
  `--override.terminaltotaldifficulty` can arm the dormant merge path on your
  own node — never pass it.
- **Upstream tests that assert Ethereum economics/defaults were updated**
  (`core`: TestSetupGenesis default-network case, TestEIP1559Transition,
  ExampleGenerateChain). The upstream ethash difficulty reference tests
  (`TestCalcDifficulty`, `tests/TestDifficulty`) fail by design if the
  ethereum/tests submodule is checked out. `cmd/geth` console welcome tests
  are cosmetically stale (banner now says Ferminux-Geth).
- **Chain data lives in `<datadir>/ferminux-geth/`** (instance dir follows the
  client name); keystore stays at `<datadir>/keystore`. Update any backup
  tooling that assumed `geth/chaindata`.
- **Windows named pipe is `\\.\pipe\geth.ipc`** (datadir-independent): on a
  machine also running vanilla geth, `attach` can hit the wrong client. Unix
  is unaffected (socket lives inside the per-network datadir).
- **The 100M cap is economic, not consensus-enforced**: base emission tops out
  at 54M + 30M premine = 84M, and standard Ethash uncle rewards add on top.
  The 16M headroom holds while the lifetime uncle rate stays under ~1 uncle
  per 3 blocks — monitor the uncle rate once mainnet hashrate is real.
- **Building on modern Go (1.21+)**: the v1.10.26 line needs
  `GOTOOLCHAIN=go1.20.14` (or `-ldflags=-checklinkname=0` for the memsize
  linkname). CI pins compatible toolchains.
- **`cmd/clef` defaults to chain-id 1** — clef users must pass
  `--chainid 3961` or signatures will be invalid on Ferminux.

## Bootnodes — ceremony placeholder

`params/ferminux.go` ships with an **empty** `FerminuxBootnodes` list. The
production keys are generated on the bootnode hosts
(`boot1/boot2/boot3.ferminux.net`) at the mainnet infrastructure ceremony
and the enode URLs filled in before the first public release. Until then pass
`--bootnodes` explicitly (the devnet overlay bakes its own).
