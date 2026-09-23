# ferminux

The Ferminux Network node client. It descends from
[go-ethereum v1.10.26](https://github.com/ethereum/go-ethereum/tree/v1.10.26), the
last go-ethereum release with a proof-of-work engine (Ethash + London/EIP-1559), and
keeps its licensing: see [`../LICENSES.md`](../LICENSES.md). The upstream licence
headers, [`AUTHORS`](AUTHORS), [`COPYING`](COPYING) and
[`COPYING.LESSER`](COPYING.LESSER) are kept in this tree; upstream's original readme
is at the go-ethereum v1.10.26 link above.

**ferminux is a dedicated client.** Its consensus rules apply from genesis to every
chain it runs: it cannot validate other networks, and an unmodified go-ethereum node
cannot validate Ferminux. Every Ferminux node and every authorised signer runs this
binary.

## Network parameters

| Item | Value |
|---|---|
| ChainID / NetworkID | 3961 (0xF79) — the built-in default |
| Coin | FMX |
| Consensus | Clique proof-of-authority from block 160,000 (`PosaBlock`): five bonded signers confirm blocks in rotation (`consensus/posa`). Blocks below 160,000 are the chain's proof-of-work history (Powhash), which the client still validates. |
| Block period | 7 s (`FerminuxPosaPeriod`); epoch 30,000 blocks |
| Block reward | 6 FMX below block 20,000, then 1 FMX halving every 4,500,000 blocks (`consensus/powhash/ferminux.go`). From block 160,000 the reward is a quarter of that schedule (0.25 FMX today): 50% to the reward sink contract, 10% to the treasury, the rest to the signer |
| Genesis | baked in — hash `0x1b62e052ee210c433440b9cd21b93b3e6cdc813fe63674c842bca3967d92fadf`, identical to `../genesis/genesis.json` |
| Fees | EIP-1559 from block 0, 1 gwei initial base fee |
| Premine | 30M FMX in genesis, inside the 100M cap |

## What was changed vs upstream

Ferminux files:

- `params/ferminux.go` — `FerminuxChainConfig` (with `PosaBlock`), `FerminuxGenesisHash`, `FerminuxBootnodes`, the authority parameters, initial signer set, treasury, reward sink and break-glass owners
- `consensus/posa/` — the authority engine: a wrapper that dispatches to Powhash below `PosaBlock` and to Clique from it, and pays the block reward split
- `consensus/clique/ferminux.go` (+ test) — signer-set bootstrap at `PosaBlock` and the multisig break-glass override
- `core/forkchoice.go` — an authority head is never abandoned for a proof-of-work head
- `core/blockchain.go` — while the head is an authority block, reorgs deeper than `FerminuxMaxReorgDepth` (64, `params/ferminux.go`) are refused unless `--ferminux.allowdeepreorg` is set
- `consensus/powhash/ferminux.go` (+ test) — the emission schedule and the pre-authority 7 s difficulty rule
- `core/genesis_ferminux.go` (+ test) — built-in genesis, byte-identical to `genesis/genesis.json`

Edits to upstream code:

- `consensus/powhash/consensus.go` — `CalcDifficulty` and `accumulateRewards` delegate to `ferminux.go` (upstream Ethereum difficulty *tests* are expected to fail; run the `TestFerminux*` suites)
- `core/genesis.go` — Ferminux is the default/known network (zero-config startup, config recovery)
- `fmx/fmxconfig/config.go` — default NetworkId 3961; wraps the engine in `consensus/posa`
- `cmd/utils/flags.go` — default bootnodes → `FerminuxBootnodes`
- `fmx/backend.go` — default block extra-data carries "ferminux"
- `node/defaults.go` — default datadir `~/.ferminux` (mac: `~/Library/Ferminux`)
- `cmd/ferminux/main.go` — client identifier `ferminux` (advertised as `Ferminux/v…`); the datadir instance directory stays `ferminux-geth` and the IPC socket stays `geth.ipc` for compatibility
- `Makefile`, `Dockerfile`, `.github/workflows/release.yml` — `ferminux` binary with `ferminux-geth` and `geth` compatibility names, and native release builds (linux amd64/arm64, windows amd64, macos arm64) published as `ferminux-geth` archives

The Go module is `github.com/aliasghar89/ferminux/chain`. Upstream packages were
renamed: `eth` → `fmx`, `eth/ethconfig` → `fmx/fmxconfig`, `ethclient` → `fmxclient`,
`ethdb` → `fmxdb`, `internal/ethapi` → `internal/fmxapi`, `consensus/ethash` →
`consensus/powhash`, `cmd/geth` → `cmd/ferminux`, `cmd/ethkey` → `cmd/fmxkey`. Wire
names such as the `eth_*` JSON-RPC methods and the `eth` devp2p protocol are unchanged.

## Build

```bash
# Native (Go 1.18–1.20; on newer Go the toolchain pin below is required)
GOTOOLCHAIN=go1.20.14 make ferminux
# → build/bin/ferminux, plus the compatibility symlinks
#   build/bin/ferminux-geth and build/bin/geth

# Docker (the image also carries the ferminux-geth and geth names)
docker build -t ferminux:dev .
```

## Run

```bash
# Zero config: an empty datadir joins the Ferminux Network (ChainID 3961)
ferminux

# The genesis is baked in, so `init` is unnecessary — but it still works and
# produces the identical chain (flags BEFORE the file):
ferminux init --datadir ~/.ferminux ../genesis/genesis.json
```

`ferminux-geth` and `geth` run the same binary. Only the authorised signers seal
blocks; any other node validates and serves the chain.

## Test

```bash
GOTOOLCHAIN=go1.20.14 go test ./consensus/posa/ ./consensus/clique/ -v
GOTOOLCHAIN=go1.20.14 go test ./consensus/powhash/ -run 'TestFerminux' -v
GOTOOLCHAIN=go1.20.14 go test ./core/ -run 'TestDefaultFerminuxGenesis|TestFerminuxForkChoice' -v
```

The Powhash convergence test simulates 60k pre-authority blocks under constant hashrate
and asserts the average block time lands in 6.0–8.5s (analytic equilibrium:
5/ln 2 ≈ 7.2s).

## Known sharp edges (reviewed, deliberate)

- **`--mainnet` / `--ropsten` / `--sepolia` / `--goerli` / `--rinkeby` still parse**
  but are non-functional: the unconditional Ferminux consensus rules reject those
  networks' blocks past genesis. Don't use them. Likewise
  `--override.terminaltotaldifficulty` can arm the dormant merge path on your
  own node — never pass it.
- **Upstream tests that assert Ethereum economics/defaults were updated**
  (`core`: TestSetupGenesis default-network case, TestEIP1559Transition,
  ExampleGenerateChain). The upstream Powhash difficulty reference tests
  (`TestCalcDifficulty`, `tests/TestDifficulty`) fail by design if the
  ethereum/tests submodule is checked out.
- **Chain data lives in `<datadir>/ferminux-geth/`** (a fixed instance directory,
  independent of the binary name; see `datadirInstanceName` in
  `cmd/ferminux/main.go`). The keystore stays at `<datadir>/keystore`. Backup
  tooling should target `ferminux-geth/chaindata`.
- **Windows named pipe is `\\.\pipe\geth.ipc`** (independent of the datadir): on a
  machine that also runs go-ethereum, `attach` can hit the wrong client. Unix is
  unaffected (the socket lives inside the per-network datadir).
- **The 100M cap is economic, not consensus-enforced**: the emission schedule in
  `consensus/powhash/ferminux.go` stays far inside the 70M non-premine share.
- **Building on modern Go (1.21+)**: the v1.10.26 line needs
  `GOTOOLCHAIN=go1.20.14` (or `-ldflags=-checklinkname=0` for the memsize
  linkname). CI pins compatible toolchains.
- **`cmd/clef` defaults to chain-id 1** — clef users must pass
  `--chainid 3961` or signatures will be invalid on Ferminux.

## Bootnodes

`params/ferminux.go` ships `FerminuxBootnodes` with the boot1.ferminux.net enode, so
a zero-config node finds peers on its own. boot2 and boot3 are added there as their
hosts come online. Pass `--bootnodes` to override the list.
