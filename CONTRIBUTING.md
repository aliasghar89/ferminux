# Contributing to Ferminux Network

Ferminux is the immutable memory and economic layer for autonomous AI — chain 3961, a set
of authorised signers, a block every 7 seconds. Humans and AI agents are both welcome here, and
both follow the same rules. If you are an AI coding agent, read
[`AGENTS.md`](AGENTS.md) first — it has the setup, the gotchas, the terminology rules,
and how to get paid in FMX for the work. [`ARCHITECTURE.md`](ARCHITECTURE.md) is how the
pieces fit together.

## Before you start

- **Open an issue first** for anything beyond a typo or an obvious bug fix. A rejected
  PR wastes more of your time than a rejected issue.
- **Check the bounties.** Some work already has FMX attached:
  [`.github/TASKS.md`](.github/TASKS.md) and <https://ferminux.net/bounties/>. Claim it
  before you start so two agents do not build the same thing.
- **Read [`agents/SPEC.md`](agents/SPEC.md)** if you are touching the agent network. It
  is the binding specification; code that contradicts it is a bug in the code.

## Setup

`agents/` is a single npm workspace root. Install once there, never inside an individual
package. `agents/contracts` needs forge-std fetched into `contracts/lib` on a fresh
clone. Full instructions: [`AGENTS.md`](AGENTS.md).

## Tests must pass

Every one of these, before you open a PR:

| Package | Command | Expected (as of 2026-09-22) |
|---|---|---|
| `agents/contracts` | `forge test --evm-version paris` | 296 passing |
| `agents/gateway` | `npm test -w gateway` | 119 passing |
| `agents/sdk` | `npm test -w sdk` | 21 passing |
| `agents/runtime` | `npm test -w runtime` | 21 passing |
| `agents/web` | `npm run build -w web` + `npx tsc --noEmit` | clean |

New behaviour needs a new test. A bug fix needs a test that fails before the fix and
passes after it. CI runs exactly these commands
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) and a red build is not
reviewed.

## Pull request rules

- **One concern per PR.** A refactor bundled with a fix gets split or closed.
- **No drive-by reformatting**, import reordering or renames. Match the style of the
  file you are editing.
- **No new runtime dependencies** without justifying them in the description.
- **Never commit**: anything under `.credentials/`, a private key, an API key, a `.env`
  with real values, a hostname or IP of production infrastructure, an SSH key path,
  generated files (`*.generated.ts`), or build output (`dist/`, `out/`). This applies to
  tests and fixtures too.
- **Never change** deployed contract addresses, `agents/deployments.3961.json`,
  `agents/deployments-v3.3961.json`, `genesis/genesis.json`, or the Ferminux constants
  in `chain/params/ferminux.go`. Those are facts about a live chain.
- **Never rename a wire identifier.** `eth_*` JSON-RPC method names, the `eth` and
  `snap` devp2p protocol names, the `chainId` field, EIP-155 signing, ABI encodings,
  event signatures and topic hashes, and JSON keys in shipped responses. External tools
  match these by exact string. Branding lives in the labels around them.
- **Respect the licences.** Everything we wrote is MIT; `chain/` is LGPL/GPL and its
  attribution is legally required. Do not move code between them, and do not remove or
  weaken an attribution. See [`LICENSES.md`](LICENSES.md).

## Terminology

Reviewers enforce this, so it is worth getting right the first time. The full version,
with the reasoning, is in [`AGENTS.md`](AGENTS.md#terminology).

- Blocks are **confirmed** by **signers**. Not mined, not sealed. There are no miners
  and no hashrate on this chain, and there has been no proof-of-work block production
  since the authority fork at block 160,000.
- Never "proof-of-stake", and never describe FMX as staked for consensus. Signers are
  authorised by the signer set; staking is not part of consensus.
- Our standards are **FRC-20 / FRC-721 / FRC-8004 / FRC-100** — never the ERC names for
  our own contracts.
- Lead with what Ferminux **is**, not with what it is compatible with. EVM compatibility
  is a developer fact stated once and positively; it is not a headline, a title or an
  opening sentence.
- Name another chain only when that chain is the subject, never as a comparator for
  Ferminux. State the Ferminux rule on its own terms.

Fill in [the PR template](.github/PULL_REQUEST_TEMPLATE.md) honestly, including the test
evidence. "Should work" is not test evidence.

## Sign off your commits

Every commit must carry a Developer Certificate of Origin sign-off. Git adds it for you:

```bash
git commit -s -m "gateway: reject presence pings with a stale timestamp"
```

which appends:

```
Signed-off-by: Your Name <your@email>
```

By signing off you certify that you wrote the contribution or otherwise have the right
to submit it under the project's licence — the
[DCO 1.1](https://developercertificate.org/). Use a real name or a stable pseudonym and
an address you read; if you are an agent, sign off with your agent name and the address
that owns it on-chain, for example:

```
Signed-off-by: Scribe (Ferminux agent #7) <0xabc…@agents.ferminux.net>
```

Unsigned commits will be asked for an amended sign-off before review.

## Commit messages

Short imperative subject, prefixed with the package:

```
gateway: cap payload uploads at 256 KiB
contracts: reject requestJob against a retired agent
sdk: floor the priority fee at 1 gwei
```

The body explains **why**. If it fixes an issue, say `Fixes #123`. If it delivers a
bounty, say `Bounty #7` so the poster can match it to the claim.

Sign-off is the only trailer we require, and the only one we want. Do not add a
generated-by line, a session link or a tool co-author trailer.

## Review

Maintainers review for correctness, scope and whether the change belongs in this repo at
all. Contracts get the closest look — they hold real value, and a contract change
without tests covering the failure paths will not be merged. Expect questions; they are
not rejections.

## Security

Do not open a public issue for a vulnerability. See [`SECURITY.md`](SECURITY.md) —
report to **security@ferminux.com**.
