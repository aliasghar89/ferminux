# Licensing, per directory

Ferminux is a monorepo with two licence regimes. Everything the Ferminux
authors wrote is **MIT**. `chain/` is a fork of go-ethereum and stays under the
GNU licences it arrived with. Nothing we did relicenses upstream code.

## MIT — everything we wrote

The root [`LICENSE`](LICENSE) (MIT) governs:

| Directory | What it is |
|---|---|
| `agents/` | Agent network: contracts, gateway, SDK, runtime, web, spec |
| `bridge/` | FMX bridge contracts, relayer, watcher, UI |
| `contracts/` | Core Ferminux contracts |
| `dex/` | Native DEX contracts and UI |
| `explorer/` | Blockscout deployment config (Blockscout itself is upstream, GPL-3.0) |
| `infra/` | Compose, Kubernetes, ops scripts, release engineering |
| `launchpad/` | Token launchpad |
| `liquidity/` | Liquidity locker contracts |
| `miner-app/` | Flutter node app (pre-authority-fork; see note below) |
| `proxy/` | Stratum proxy (pre-authority-fork; see note below) |
| `shared/`, `card/`, `site/`, `staking/`, `tools/`, `wallet/`, `wallet-web/`, `windows/` | Apps, site and tooling |
| `docs/`, `genesis/`, `devnet/`, `scripts/` | Docs, genesis spec, dev tooling |

## GPL / LGPL — `chain/`

`chain/` is **ferminux-geth**, a fork of
[go-ethereum](https://github.com/ethereum/go-ethereum) v1.10.26. It keeps
go-ethereum's licensing unchanged:

- Library code (most of the tree) — **LGPL-3.0-or-later**, see
  [`chain/COPYING.LESSER`](chain/COPYING.LESSER)
- The `cmd/` binaries — **GPL-3.0-or-later**, see [`chain/COPYING`](chain/COPYING)

Verified at the time of publication: 920 `.go` files carry the LGPL header and
108 carry the GPL header, and both `COPYING` files are present and unmodified.
Ferminux's own additions inside `chain/` (`params/ferminux.go`,
`consensus/posa/`, the Ferminux clauses in `core/forkchoice.go` and the Ethash
retune) are contributions **to that LGPL/GPL work** and are licensed the same
way — not MIT. If you take code out of `chain/`, you take the GNU terms with
it.

## Vendored dependencies

`*/contracts/lib/` holds vendored Foundry dependencies (forge-std and friends)
under their own upstream licences, typically MIT or Apache-2.0. `explorer/`
deploys upstream Blockscout images, which are GPL-3.0. Node dependencies carry
their own licences; see each `package.json` and its lockfile.
