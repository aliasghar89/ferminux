# Licensing, per directory

Ferminux is a monorepo with two licence regimes. Everything the Ferminux authors wrote
is **MIT**. `chain/` stays under the GNU licences it arrived with. Nothing we did
relicenses upstream code, and nothing here removes an attribution that upstream's
licence requires.

## What the GNU licences require

`chain/` is a derived work under LGPL-3.0 and GPL-3.0. Those licences require its licence
headers, the `COPYING` and `COPYING.LESSER` texts and the `AUTHORS` list to stay intact inside
`chain/`, and they do. Do not remove or alter them. The command is `ferminux`; `ferminux-geth`
and `geth` are kept as compatibility names for the same binary.

## MIT — everything we wrote

The root [`LICENSE`](LICENSE) (MIT) governs:

| Directory | What it is |
|---|---|
| `agents/` | The agent network: contracts, gateway, SDK, runtime, web, marketing, spec |
| `bridge/` | FMX bridge contracts, relayer, watcher, UI |
| `contracts/` | Core Ferminux contracts |
| `dex/` | Native DEX contracts and UI |
| `explorer/` | Blockscout deployment config (Blockscout itself is upstream, GPL-3.0) |
| `infra/` | Compose, Kubernetes, ops scripts, release engineering |
| `launchpad/` | Token launchpad |
| `liquidity/` | Liquidity locker contracts |
| `staking/` | The FMX staking product — a yield product, not consensus |
| `miner-app/`, `proxy/`, `windows/` | Pre-authority-fork tooling; see the note below |
| `shared/`, `card/`, `site/`, `tools/`, `wallet/`, `wallet-web/` | Apps, site and tooling |
| `docs/`, `genesis/`, `devnet/`, `scripts/` | Docs, genesis spec, dev tooling |

Not every directory in this table is present on every branch — the published tree is a
subset of the working repository. The licence applies to each directory wherever it
appears.

## GPL / LGPL — `chain/`

`chain/` is the Ferminux node client. Its codebase descends from
[go-ethereum](https://github.com/ethereum/go-ethereum) v1.10.26 and keeps go-ethereum's
licensing unchanged:

- Library code (most of the tree) — **LGPL-3.0-or-later**, see
  [`chain/COPYING.LESSER`](chain/COPYING.LESSER)
- The `cmd/` binaries — **GPL-3.0-or-later**, see [`chain/COPYING`](chain/COPYING)

The upstream contributor list is preserved at [`chain/AUTHORS`](chain/AUTHORS). The
original upstream readme is not carried in this tree; read it at
[go-ethereum v1.10.26](https://github.com/ethereum/go-ethereum/tree/v1.10.26).

Verified at the time of publication: 920 `.go` files carry the LGPL header and 88 carry
the GPL header, and both `COPYING` files are present and unmodified. Ferminux's own
additions inside `chain/` (`params/ferminux.go`, `consensus/posa/`, the Ferminux clauses
in `core/forkchoice.go` and the retuned emission schedule) are contributions **to that
LGPL/GPL work** and are licensed the same way — not MIT. If you take code out of
`chain/`, you take the GNU terms with it.

## Pre-authority-fork directories

`proxy/`, `miner-app/` and `windows/` are from before the authority fork at block
160,000, when the chain ran an Ethash engine. They are retained for historical nodes and
for anyone replaying that early history. They are not used by Ferminux today and have
produced nothing since block 160,000. They are MIT like the rest of our own code; the
label is about what they are for, not about their licence.

## Vendored dependencies

`*/contracts/lib/` holds vendored Foundry dependencies (forge-std and friends) under
their own upstream licences, typically MIT or Apache-2.0. `explorer/` deploys upstream
Blockscout images, which are GPL-3.0. Node dependencies carry their own licences; see
each `package.json` and its lockfile.
