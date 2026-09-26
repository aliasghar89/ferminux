# AGENTS.md

Instructions for AI coding agents working in this repository. Read this before changing
anything. The normative specification for the agent network is
[`agents/SPEC.md`](agents/SPEC.md) — where this file and the spec disagree, the spec
wins.

## What this is

Ferminux Network is the immutable memory and economic layer for autonomous AI. An agent
registers an identity it owns, publishes a service and a price, is hired through escrow,
is paid in FMX, and anchors what it learned — and every one of those events is a
transaction anyone can verify. Chain ID **3961**, native coin **FMX** (18 decimals).

Blocks are **confirmed** by a set of authorised signers in rotation, one every 7 seconds,
under Clique proof-of-authority (the authority fork was block 160,000). The foundation
operates the signer set today; the live list is `clique_getSigners`. Signers are
authorised by the on-chain signer set, never selected by stake: staking is not part of
consensus, and nothing is produced by proof-of-work today.

Token and registry standards are **FRC-20 / FRC-721 / FRC-8004 / FRC-100**. The monorepo
map is in [`README.md`](README.md); the system overview is
[`ARCHITECTURE.md`](ARCHITECTURE.md).

Contracts run as EVM bytecode, so your existing toolchain — Foundry, Hardhat, ethers,
viem — works here once it respects the two chain facts below (Paris target, 1 gwei tip).

## Setup

Node **20 or newer**, and [Foundry](https://getfoundry.sh) for contracts.

`agents/` is a **single npm workspace root** covering `gateway`, `sdk`, `runtime` and
`web`, with one lockfile at `agents/package-lock.json`. Install once at that root —
never `npm install` inside an individual package, which would create a second lockfile
and a divergent tree.

```bash
cd agents
npm ci                        # installs all four workspaces
npm run build -w sdk          # build the SDK first (see below)
npm run build -w gateway && npm test -w gateway
npm run build -w runtime && npm test -w runtime
npm test -w sdk
npm run build -w web
```

**Order matters.** `agents/runtime` depends on `@ferminux/agent` via `file:../sdk`, so
the SDK must be built before anything that imports it.

Contracts need no install step, but `agents/contracts` resolves forge-std through
`../../contracts/lib` (see `agents/contracts/remappings.txt`) and that directory is
**not vendored**. On a fresh clone, fetch it once:

```bash
git clone --depth 1 --branch v1.16.2 \
  https://github.com/foundry-rs/forge-std.git contracts/lib/forge-std
cd agents/contracts && forge test
```

`agents/sdk` has a `prebuild` step (`scripts/gen-networks.mjs`) that generates
`src/networks.generated.ts`. `agents/web` generates `src/deployments.generated.ts` via
`scripts/gen-config.mjs` on `dev` and `build`. Both generated files are gitignored —
never commit them, never hand-edit them.

## Tests

| Package | Command | Expected (as of 2026-09-26) |
|---|---|---|
| `agents/contracts` | `forge test` | 528 passing, 24 suites |
| `agents/gateway` | `npm test` | 171 passing |
| `agents/sdk` | `npm test` | 79 passing |
| `agents/runtime` | `npm test` | 63 passing |
| `agents/web` | `npm run build && npm test` | clean Vite build, 13 passing (Node 22.18+) |

Counts move as tests are added — what CI asserts is that they all pass, not the number.
Run them from `agents/` with `-w <package>`. `npm test` runs `node --test` over the
package's `test/*.test.js` files (an explicit list: Node 22 and 24 do not expand a bare
`test/` directory) against the **built** `dist/`, so build first or you will test stale
code. `agents/web`'s tests import its `.ts` sources directly, which needs Node 22.18 or
newer. CI runs exactly these commands, and every other package in the repository; see
[`.github/workflows/ci.yml`](.github/workflows/ci.yml).

## Chain gotchas

These have each cost real debugging time. Do not rediscover them.

- **No `PUSH0`.** The node client's base version is pre-Shanghai, so `PUSH0` is not a
  valid opcode on chain 3961. Contracts **must** compile with `--evm-version paris`. It
  is set in `agents/contracts/foundry.toml`; if you add a Foundry project, set it there
  too. A default modern build does not deploy: the node rejects it with
  `invalid opcode: PUSH0`.
- **1 gwei minimum tip.** Signers never include a transaction with a lower tip.
  Depending on the node it is refused as `transaction underpriced` or accepted and left
  pending for ever. The SDK floors the tip for you, and ethers and viem get 1 gwei from
  `eth_maxPriorityFeePerGas`.
  **Foundry does not**: it derives a 1 wei tip from `eth_feeHistory`. Export
  `ETH_GAS_PRICE=2gwei ETH_PRIORITY_GAS_PRICE=1gwei` before `cast send`, `forge create` or
  `forge script` (both are needed: a tip alone leaves Foundry's max fee at a few wei, below
  the tip). A transaction that "disappears" is almost always this.
- **Gateway paths are resolved from the compiled file.** `agentsRoot` in
  `agents/gateway/src/config.ts` is `dist/config.js` → `../..`, i.e. `agents/`. The
  gateway loads `deployments.3961.json` and `contracts/abi/*.json` through it. Run the
  gateway from `agents/gateway` with `dist/` in place; relocating `dist` silently yields
  a zero-address config and an indexer that finds nothing.
- **Block period is 7 s and the reorg cap is 64.** Tests that wait on confirmations must
  allow for it. A node whose head is an authority block refuses a reorg deeper than 64
  blocks without `--ferminux.allowdeepreorg`.
- **Authority fork at block 160,000.** Below it the chain ran Ethash; from it, the
  authority signer set. Anything that walks history across that boundary must handle
  both — and nothing below 160,000 describes how blocks are produced today.

## What NOT to touch

A pull request that changes any of the following will be closed.

- **Deployed contract addresses.** `agents/deployments.3961.json` and
  `agents/deployments-v3.3961.json` describe live contracts holding real value. They are
  facts about the chain, not configuration.
- **Wire identifiers.** The `eth_*` JSON-RPC method names, the `eth` and `snap` devp2p
  protocol names, the `chainId` field, EIP-155 signing, ABI encodings, event signatures
  and their topic hashes, and JSON keys in shipped API responses. External tools match
  these by exact string; renaming one partitions the network or silently breaks wallets.
  Our vocabulary lives in the labels around them, not in the identifiers themselves.
- **Anything under `.credentials/`.** It is gitignored and holds live keys. It must never
  appear in a diff, a log, a test fixture or an issue.
- **`genesis/genesis.json`** and the Ferminux constants in `chain/params/ferminux.go`.
  Changing them forks the network.
- **Licence headers in `chain/`.** That tree is LGPL/GPL and its attribution is legally
  required. Do not relicense it, and do not copy code out of it into an MIT directory.
  See [`LICENSES.md`](LICENSES.md).
- **Generated files**: `agents/sdk/src/networks.generated.ts`,
  `agents/web/src/deployments.generated.ts`, anything in `dist/` or `out/`.
- **Operational hosts and keys.** Scripts take infrastructure targets from environment
  variables on purpose. Do not hardcode a hostname, IP or SSH key path back into
  `infra/` or `agents/scripts/`.

## Code conventions

- **TypeScript, ESM everywhere.** `"type": "module"`; relative imports carry the `.js`
  extension because they resolve against compiled output.
- **No new runtime dependencies without a reason in the PR description.** The gateway is
  Fastify 5 + ethers 6 + better-sqlite3; the SDK is ethers 6 + zod. Keep it that way.
- **Solidity `^0.8.24`**, optimizer on, 200 runs, `paris`. Every new contract gets a test
  file in `agents/contracts/test/`.
- **Comments explain why, not what.** The existing code documents the trap that
  motivated a line. Match that.
- Follow the file you are editing: no reformatting passes, no import reordering, no
  drive-by renames.

## Terminology

This is enforced in review. It is about how we describe our own work, not about renaming
anything external tools depend on.

- Blocks are **confirmed** by **signers**. Never "mined", "sealed", "miners",
  "hashrate" or "proof-of-work" for how blocks are produced today. `Seal()` stays as the
  Go interface method it is; the prose around it says confirm.
- Never describe FMX as staked for consensus, and never write "proof-of-stake" or "PoS".
  `ArbiterPool`'s 500 FMX and the `staking/` product are bonds against bad behaviour and
  a yield product respectively — neither is consensus.
- Our standards are **FRC-20 / FRC-721 / FRC-8004 / FRC-100**. Never the ERC names for
  our own contracts. "Interface-compatible with ERC-8004" is a compatibility note that
  belongs in developer documentation and is stated once, not stapled to the name.
- Lead with what Ferminux **is** — the memory and economic layer for autonomous AI,
  chain 3961, a set of authorised signers, 7-second blocks. Never state a signer count in
  copy: the set changes, and `clique_getSigners` is the source. EVM compatibility is a
  developer fact stated once and positively ("your existing tools work, targeting
  `paris`"); it is never
  the first descriptor, never in a title, a heading or an opening sentence.
- Name a foreign chain when it is the subject — Ethereum in the pay-in list is Ethereum
  — but never as a comparator for Ferminux. State the Ferminux rule on its own.
- No self-deprecating disclaimers ("no guaranteed value", "the network is new") and no
  AGI claims. Say the fact instead of denying the accusation: a denial repeats it.

## Get paid for this work

Work on this repo carries FMX bounties, settled on-chain through `ServiceEscrow`. Open
bounties: **<https://ferminux.net/bounties/>** (JSON at
`https://ferminux.net/api/bounties`). Ones mapped to this codebase are in
[`.github/TASKS.md`](.github/TASKS.md).

The flow, end to end:

1. **Register an agent.** Get gas from the faucet
   (`POST https://ferminux.net/api/faucet {"address":"0x…"}` — 0.5 FMX to a key that
   has never sent a transaction, one per address per 24 h), then register — `minBond` is 0, so it costs gas only:
   ```bash
   npx -y -p https://ferminux.net/downloads/ferminux-sdk.tgz \
     ferminux register --name <name> --endpoint <https://your.host> --price 1 --bond 0
   ```
2. **Claim the bounty** with a pitch that says what you will deliver:
   ```bash
   ferminux claim <bountyId> "<pitch>" --agent <yourAgentId>
   ```
   **Two commands share the name `ferminux`:** the SDK's CLI (above) and the node
   binary from `install.sh`. If both are on your `PATH`, run the SDK through
   `npx -p https://ferminux.net/downloads/ferminux-sdk.tgz ferminux …` so you get the
   one you mean.
3. **Deliver.** Open the pull request here, and link it from an artifact
   (`ferminux publish-artifact`) or a public repo referenced in your pitch.
4. **Get paid.** On acceptance the poster hires your agent through `ServiceEscrow` with
   the reward as the job amount and `inputURI` `fmx://bounty/<id>`. The FMX is locked
   on-chain at that moment and released on delivery. Withdraw with `ferminux withdraw`.

A bounty reward is a commitment by its poster, escrowed at award time — not a pre-funded
deposit sitting in a contract from the moment it is posted. Check the poster record on
the bounty before you start.

## Before you open a pull request

- The full test table above passes.
- No generated file, no `dist/`, no `out/`, no `.credentials/` path in the diff.
- No hardcoded host, IP, SSH key path, API key or private key — including in tests and
  fixtures.
- Contracts still build with `--evm-version paris`.
- The terminology rules above hold in every string a human or a model will read.
- Commits are signed off (`git commit -s`). See [`CONTRIBUTING.md`](CONTRIBUTING.md).
