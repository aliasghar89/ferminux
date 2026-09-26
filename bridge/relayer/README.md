# Ferminux Bridge — Relayer

The off-chain half of the bridge: the piece that actually moves transfers between
chains, and the piece whose compromise steals everything. One binary, two roles,
no shared trust.

| Role | Holds | Can do | Cannot do |
|---|---|---|---|
| **validator** | a key in the bridge's validator set | attest to transfers it observed **itself** | change config, pause, move funds, sign anything it did not see on chain |
| **submitter** | a key that pays gas | collect signatures and relay `execute()` | attest to anything — `execute()` is permissionless, so this key is replaceable |

They are separate processes because they are separate trust domains. In a real
deployment the three validators run on **three machines under three custodians**;
that separation *is* the M-of-N, and no amount of software can substitute for it.

**Language:** TypeScript on Node 24+, run directly from source (Node's type
stripping) — no build step, no transpile artifacts to diverge from the code you
audited. One runtime dependency: `ethers@6`, the same version the rest of
`ferminux-network` uses. State goes in `node:sqlite`, built into Node, so there is
no native module to compile and no extra supply-chain surface next to a signing key.

---

## Contents

- [The rule everything rests on](#the-rule-everything-rests-on)
- [Quick start](#quick-start)
- [Roles and flags](#roles-and-flags)
- [Configuration](#configuration)
- [Reorg budgets — why each chain waits as long as it does](#reorg-budgets)
- [Finality modes — work-and-time, pace, checkpoints](#finality-modes)
- [What a validator checks before it signs](#what-a-validator-checks-before-it-signs)
- [The endpoints are a quorum, not a failover list](#the-endpoints-are-a-quorum-not-a-failover-list)
- [How the submitter cannot double-submit](#how-the-submitter-cannot-double-submit)
- [Signature transport](#signature-transport)
- [Durable state](#durable-state)
- [HTTP API](#http-api)
- [Metrics and alerts](#metrics-and-alerts)
- [Key management](#key-management)
- [Deployment — Docker](#deployment--docker)
- [Deployment — systemd](#deployment--systemd)
- [Tests, and what they actually prove](#tests-and-what-they-actually-prove)
- [Run it yourself on two anvils](#run-it-yourself-on-two-anvils)
- [Runbooks](#runbooks)
- [Known limitations](#known-limitations)

---

## The rule everything rests on

> A validator attests **only** to what it has itself observed, on a chain it is
> configured for, at a depth it considers settled, against a bridge address whose
> EIP-712 domain it has verified — and it computes the digest it signs **locally**,
> from the transfer fields, never by asking anyone what to sign.

Every design decision below follows from that sentence:

- There is **no POST route**. The validator's HTTP surface is read-only. A
  submitter "requesting" a signature is a `GET`; if the validator has not
  independently confirmed that transfer, the answer is 404, and asking again does
  not change it.
- `src/transfer.ts` recomputes `transferId` and the EIP-712 digest from first
  principles and the contract's values are used only to **check** that
  computation. A relayer that derives its digest by calling the contract can be
  pointed at a malicious contract; one that derives it locally and compares cannot.
- Multiple RPC endpoints per chain are a **quorum, not a failover list**. Reads
  that merely inform may come from one node. Reads that lead to a signature may
  not: at least `minAgreeingEndpoints` of them must show the same log at the same
  block hash, and a validator that is below that floor **refuses and retries**
  rather than believing whichever endpoint is still answering. Config will not
  start an enabled chain with fewer than **three endpoints from three
  independent providers**, and "independent" is checked rather than assumed —
  loopback aliases and shared registrable domains are one provider at parse
  time, and `--role check` resolves every name so two brands on one machine
  cannot pass as two witnesses.
- Caps are enforced **twice**: by the contract, and again here from the validator's
  own config. Raising the contract's cap needs the owner multisig and a 48h
  timelock; raising this one needs access to the validator host. Two different
  keys have to agree before the blast radius grows.

---

## Quick start

```sh
cd <repo>/bridge/relayer
npm install

# 1. Copy the example and fill in bridgeAddress per chain, then set enabled: true
cp config/chains.example.json config/chains.json
$EDITOR config/chains.json

# 2. Verify everything WITHOUT touching a key. Do this before every deploy.
node src/index.ts --role check --config config/chains.json

# 3. Create an encrypted keystore (prints only the address)
umask 077
head -c 32 /dev/urandom | base64 > /etc/ferminux-relayer/validator.password
chmod 400 /etc/ferminux-relayer/validator.password
FMX_RELAYER_PASSWORD_FILE=/etc/ferminux-relayer/validator.password \
  node src/index.ts --role keygen --out /etc/ferminux-relayer/validator.keystore.json

# 4. Add that address to the bridge validator set (owner multisig, 48h timelock),
#    then run
node src/index.ts --role validator --config config/chains.json
```

`--role check` is the gate. It **resolves every RPC hostname and groups the
endpoints by the operator actually behind them**, probes each one, compares the
live `DOMAIN_SEPARATOR()` on every bridge against a local derivation, reads each
threshold and validator set, and runs the divergence detector across every
endpoint pair. It exits non-zero on any failure and it never loads a key, so it is
safe to run against production config from a laptop.

```
ERROR rpc providers are NOT independent chain=ethereum chainId=1
  providers=["publicnode.com [104.20.24.117, 172.66.150.162]: https://ethereum-rpc.publicnode.com",
             "ankr.com + polygon-rpc.com [152.236.9.75]: https://rpc.ankr.com/eth, https://polygon-rpc.com"]
  problems=["... provider ankr.com + polygon-rpc.com [152.236.9.75] alone holds 2 endpoint(s),
             which meets minAgreeingEndpoints (2) on its own ..."]
```

Two vendors, two brands, two registrable domains, one machine. Nothing short of
resolving the names would have caught it. The same check runs again at
validator/submitter startup, so a config edited after the preflight cannot bring
a node up on one witness.

---

## Roles and flags

```
node src/index.ts --role <validator|submitter|check|keygen> [options]

  --role <r>       validator | submitter | check | keygen   (or FMX_RELAYER_ROLE)
  --config <path>  default config/chains.json               (or FMX_RELAYER_CONFIG)
  --once           one poll/tick pass, then exit (cron, debugging, tests)
  --out <path>     keygen: where to write the encrypted keystore
  --version, --help
```

Environment overrides (all optional; they win over the config file):

| Variable | Purpose |
|---|---|
| `FMX_RELAYER_CONFIG` | config file path |
| `FMX_RELAYER_KEYSTORE` | encrypted V3 keystore path |
| `FMX_RELAYER_PASSWORD_FILE` | file holding the keystore password (must be mode 0400). The **only** way to supply it. |
| `FMX_RELAYER_PASSWORD` | **refused.** Setting it — or the retired `FMX_RELAYER_ALLOW_ENV_PASSWORD` — makes every role exit 2 before the config is read. An environment variable cannot be mode 0400: it is readable through `/proc/<pid>/environ` by anything running as this user, it lands in core dumps and crash reports, `ps e` prints it, and every child inherits it. If you hit this, unset it, treat that password as disclosed and rotate it. |
| `FMX_RELAYER_ADDRESS` | expected key address; startup **fails** if the keystore differs |
| `FMX_RELAYER_PRIVATE_KEY` | plaintext key, local tests only; also needs `FMX_RELAYER_ALLOW_PLAINTEXT_KEY=1` |
| `FMX_RELAYER_HTTP_HOST` / `_PORT` | bind address for `/health`, `/metrics`, `/signatures` |
| `FMX_RELAYER_API_TOKEN` | bearer token for everything except `/health`. **Required** for any bind that is not loopback — startup fails without it. `openssl rand -hex 32` |
| `FMX_RELAYER_STATE` | durable state path |
| `FMX_RELAYER_SHARED_DIR` | shared-directory transport root |
| `FMX_RELAYER_PEERS` | comma-separated validator base URLs (submitter) |
| `FMX_RELAYER_ALERT_WEBHOOK` | webhook URL for alerts |
| `FMX_RELAYER_RPC_<chainId>` | comma-separated RPC URLs for one chain |
| `FMX_RELAYER_BRIDGE_<chainId>` | bridge address for one chain |
| `FMX_RELAYER_LOG_LEVEL` / `_FORMAT` | `debug\|info\|warn\|error`, `json\|text` |

---

## Configuration

`config/chains.example.json` ships all eleven chains — Ferminux plus Ethereum,
BSC, Polygon, Arbitrum, Base and their testnets — with the confirmation counts and
gas ceilings already reasoned out. Everything but `bridgeAddress` is filled in;
disabled chains may hold an empty address as a placeholder, and enabling one
without filling it in is a startup failure.

**Unknown keys are a hard error.** `confirmation` instead of `confirmations` will
not start the service, because a bridge relayer that boots with a half-understood
config signs something nobody intended. Keys beginning with `_` or `$` are
comments and ignored, which is how the example carries its own documentation.

Per chain:

```jsonc
{
  "name": "ferminux",
  "chainId": 3961,
  "rpcUrls": ["https://rpc.ferminux.net", "https://ferminux.net/rpc"],  // a QUORUM
  "minAgreeingEndpoints": 2,     // optional; default = majority, never below 2
  "rpcProbeTimeoutMs": 5000,     // per-cycle eth_chainId liveness probe budget
  "bridgeAddress": "0x…",
  "domainSeparator": "0x…",      // optional pin; checked against the live value
  "confirmations": 64,
  "finalityTag": null,            // "finalized" | "safe" | null
  "pollIntervalMs": 7000,
  "startBlock": 0,                // 0 = start at head; set it to the deploy block
  "maxBlockRange": 2000,          // eth_getLogs chunk
  "enabled": true,
  "gas": {
    "maxFeePerGasGwei": 50,       // absolute ceiling; no retry may exceed it
    "priorityFeeGwei": 1,         // floor; the node's suggestion wins if higher
    "baseFeeMultiplier": 2,
    "gasLimitMultiplier": 1.3,
    "gasLimitCap": 1500000,
    "escalationPct": 25,          // per retry, compounding; >= 10 or nodes reject it
    "maxAttempts": 4,
    "receiptTimeoutMs": 120000,
    "txType": 2                   // 0 for a chain without EIP-1559
  },
  "limits": {
    "default": { "maxPerTransfer": "…", "dailyCap": "…" },
    "tokens": { "0x0000…0000": { "maxPerTransfer": "…", "dailyCap": "…" } }
  }
}
```

Amounts are decimal strings in the token's smallest unit. A number above 2^53 is
rejected rather than silently rounded. `dailyCap < maxPerTransfer` is rejected as a
contradiction. A token with no limit configured is **refused by default** — the
absence of a cap never means "unlimited".

---

## Reorg budgets

> Wait long enough that reversing the source block costs more than the transfer
> is worth.

That is the whole rule. It is an economic question, not a latency one, and the
answer is different on every chain. `confirmations` is a floor; `finalityTag`, where
the chain offers one, is the real line and the relayer waits for **both**.

| Chain | id | block time | confirmations | finality tag | wall clock | why |
|---|---:|---:|---:|---|---:|---|
| **Ferminux** | 3961 | ~7 s | **64** | — | ~7.5 min | Clique proof-of-authority (an authorised signer set) with **no finality gadget**. A reorg costs no work at any depth — it takes a signer majority — and a node whose head is an authority block refuses one deeper than 64 blocks. 64 is that cap: a transfer settled under it cannot be rewritten underneath the validators' own nodes. Do not lower it because the chain feels fast. |
| Ethereum | 1 | 12 s | 32 | `finalized` | ~13 min | PoS finality is real: reverting a finalized block burns a third of the staked supply. Prefer the tag; the count is only the floor while a node cannot serve it. |
| BSC | 56 | 3 s | 20 | `finalized` | ~60 s | 21 validators, BEP-126 fast finality (~2–3 blocks after 2/3 vote). Multi-block reorgs happened *before* fast finality, which is why the floor is 20 and not 3. |
| Polygon | 137 | 2 s | **128** | `finalized` | ~4.5 min | Bor blocks are not final until Heimdall milestones them, and Bor reorgs of **well over 100 blocks** have happened in production. This is the chain where a shallow confirmation count has actually cost bridges money. |
| Arbitrum | 42161 | 0.25 s | 300 | `finalized` | ~75 s floor | An L2 block count measures almost nothing — the sequencer does not reorg, but an **L1 reorg** can rewrite the batch that contained the block. `finalized` tracks L1 (~15 min) and is the real answer. |
| Base | 8453 | 2 s | 180 | `finalized` | ~6 min floor | OP-stack, same L1-derived argument as Arbitrum. |

Testnets mirror their mainnet settings. Treat testnet confirmations as advisory:
the mechanics are the same, the economic weight behind them is not.

Two things follow that are easy to get backwards:

- **Ferminux waits longest.** It is "our" chain and the fast one, and it is also
  the one with no finality gadget. Familiarity is not finality.
- **L2 block counts are theatre on their own.** 300 Arbitrum blocks is 75 seconds
  and proves nothing about L1. Use the tag.

---

<a id="finality-modes"></a>
## Finality modes — work-and-time, pace, checkpoints

`confirmations` is a block COUNT, and on a chain without a finality gadget a
count is the wrong primitive twice over. On PoW the block time is not a
constant: during the 2026-08-21 Ferminux stall the bridge sat on "Confirming
12/64" for hours, telling nobody anything. And after the Clique fork a reorg
costs no work at any depth — it is the founders' keys — so there is no count
that prices one. Three reviewers independently called this the highest-risk
item in every migration path.

So every chain now names its finality rule in `finality.mode`
(`src/finality.ts`, `config/chains.example.json` for the commented defaults).
`confirmations` stays as a floor under all of them and is never lowered.

| mode | rule | for |
|---|---|---|
| `count` | `confirmations` + `finalityTag`, as before | chains with a real finality tag: BSC, Ethereum, the L2s |
| `work-and-time` | accumulated difficulty above the source block ≥ `workThreshold` **and** wall clock since the block ≥ `timeFloorMs` | a proof-of-work source — Ferminux before the authority fork at block 160,000 |
| `checkpoint` | the source block is at or below the latest multisig-attested checkpoint | Ferminux since the Clique fork at block 160,000, where difficulty is 1 or 2 and work means nothing |

**Pace.** Under `work-and-time` and `checkpoint` the monitor measures the median
of the last `pace.window` inter-block gaps and the age of the head. Median above
`degradedFactor × targetBlockTimeMs`, or no block for `stallAfterMs`, and the
chain is **DEGRADED**: the validator refuses to sign (`pace_degraded`), pages
`chain_degraded`, and `/status` says *"producing blocks slowly; transfers are
paused until it recovers"* with the measured gap — never a progress bar that
does not move. Cannot measure at all (`pace_unknown`): same refusal.

**Checkpoints.** `finality.checkpoint` names a `CheckpointRegistry`
(`bridge/contracts/src/CheckpointRegistry.sol`) on the destination chain,
which has real finality — BSC, owned by the BSC multisig. It is enforced in
**every** mode once configured. The validator reads `latest()` through the
registry chain's 3-provider quorum (byte-for-byte agreement, any
disagreement is a refusal), then reads the block at that height on Ferminux
through Ferminux's quorum and requires the hash to match. Then:

- source block above the checkpoint → `checkpoint_behind`, wait for the next one
- hash differs → `checkpoint_mismatch`, **critical** alert: the chain was rewritten across the checkpoint
- older than `maxAgeMs` → `checkpoint_stale`; a registry nobody feeds stops the bridge the same day, which is the intended failure
- empty, unreadable, or registry endpoints disagree → `checkpoint_missing` / `checkpoint_unavailable`

Operators publish with `bridge/ops/checkpoint.sh`, which reads the height
from all three Ferminux RPCs and refuses unless all three agree, then goes
through `msig.sh`.

**Every read feeds a signature, so every read is a quorum read.** Headers are
accepted when `minAgreeingEndpoints` endpoints return the same
(number, hash, parentHash, timestamp, difficulty); they are cached by **hash**,
which is immutable, so the cache can never serve a reorged-away block. The work
sum walks `parentHash` links from head down to the source block, so it is the
work on top of the block this node actually confirmed — a head that does not
descend from it is `src_block_reorged`, critical.

All finality refusals are retryable: the transfer stays `confirmed` and
unsigned until blocks arrive, pace recovers, or a checkpoint is published.
Nothing is discarded on the word of a chain view that may itself be the anomaly.

---

## What a validator checks before it signs

In order, in `src/verify.ts`. Every one is a refusal, not a warning.

1. **Confirmed** — the transfer survived `confirmations` (and the finality tag) and
   was re-read afterwards, by **at least `minAgreeingEndpoints` independent RPC
   endpoints that all showed the same log**. See the watcher below, and
   "endpoints are a quorum" underneath it.
2. **Both chains configured** — a transfer whose source or destination this node is
   not configured for is refused outright.
3. **The id is ours** — `transferId` recomputed locally from the fields must equal
   the one the contract indexed. A mismatch is a critical alert.
3b. **Final by the source chain's own rule** — on a chain configured for
   `work-and-time` or `checkpoint` finality (or with a checkpoint registry in
   any mode) the finality monitor has the last word: pace not degraded, work and
   time floor met, checkpoint fresh, hash-verified and above the source block.
   A chain that requires the check but has no monitor is refused
   (`finality_unverifiable`) — the absence of the check is not the passing of it.
   See [Finality modes](#finality-modes).
4. **Age** — optional `maxTransferAgeMs` ceiling.
5. **The destination bridge is the one we think it is** — the live
   `DOMAIN_SEPARATOR()` must equal a local derivation from `(chainId, bridgeAddress)`
   and the optional pin in config. This is the anti-phishing check: a validator that
   skips it can be talked into signing for an attacker's deployment.
6. **Destination state** — not already `processed`, bridge not paused, `dstToken`
   registered and unpaused, and the registry's `remoteChainId`/`remoteToken` must
   mirror the transfer exactly. Amount within the contract's `maxPerTransfer`.
7. **The digest** — computed locally, then cross-checked against
   `hashTransfer()` on the destination. A difference means ABI drift or an impostor
   bridge; critical alert, no signature.
8. **Our own caps** — per-transfer and a rolling 24h bucket, on **both** the source
   (outbound) and destination (inbound) side, using the same continuously-draining
   window as the contract: `used − used × elapsed / 24h`. No calendar boundary to
   sit on, so no way to spend the cap twice in a few minutes.

Then, and only then, it signs — and immediately verifies that its own signature
recovers to its own address before publishing it. If that self-check fails, or
the digest moved between verification and signing, or anything at all throws
after step 8, the 24h capacity consumed in step 8 is **released** before the
transfer is marked rejected: consuming before signing is deliberate (a crash in
between must cost capacity, never safety), but a validator that never hands it
back ratchets its own budget down and eventually refuses legitimate transfers.

**Retryable vs final.** `rpc_error`, `bridge_paused`, `dst_token_paused`,
`over_local_daily_cap` and `not_confirmed` leave the transfer pending and are retried
(the 24h bucket drains, a pause is lifted). Everything else marks the transfer
`rejected` permanently and alerts. A rejected transfer is never retried by software.

### The watcher, and why the scan window is re-derived every poll

```
persisted cursor  = last SETTLED block fully processed   (survives restart)
scanned each poll = [cursor + 1 .. head]
```

The last `confirmations` blocks are re-read on **every** poll. There is no cached
"pending" list to go stale: if a reorg replaces those blocks, the next poll simply
sees the new truth. A transfer that vanishes is caught by the confirmation re-read
rather than being signed.

The re-read is done across **every healthy endpoint**, and the four outcomes are
kept distinct because the right response to each is different:

| outcome | meaning | action |
|---|---|---|
| `ok` | every endpoint shows the same log | promote to `confirmed`, sign |
| `vanished` | every endpoint agrees it is gone | mark `orphaned`, **reorg** alert |
| `quorum_failed` | endpoints **disagree** | never sign, **rpc_divergence** alert, stay pending |
| `unavailable` | an endpoint errored | decide nothing, retry |

Collapsing `quorum_failed` into `vanished` would let one lying endpoint make an
honest validator discard real transfers — a denial of service with extra steps.

---

### The endpoints are a quorum, not a failover list

`rpcUrls` is the single most misread setting in this file. It is not "try the
next one if the first is slow". Every entry is an independent witness, and a
validator only attests to what enough of them agree on.

#### What counts as one provider

Not a hostname. `127.0.0.1` and `localhost` are two strings and one node, and
that is the shape the rule used to accept. Endpoints are grouped by *operator*
(`src/independence.ts`):

| grouped as one provider | why |
| --- | --- |
| every loopback spelling — `127.0.0.0/8`, `::1`, `localhost`, `*.localhost`, `0.0.0.0` | it is this machine, however it is written |
| two names under one registrable domain — `rpc.example.com` + `backup.example.com` | one operator, one contract, one outage, one abuse desk |
| two names that RESOLVE to a common address | the DNS half, checked by `--role check` and again at startup |
| tenants of a sub-delegated suffix — `a.vercel.app` + `b.vercel.app` | different customers, one piece of infrastructure; the conservative reading is the safe one |

Multi-label public suffixes are handled, so `rpc.a.co.uk` and `rpc.b.co.uk` are
two registrants and not one `co.uk`.

That the DNS half is worth having is not theoretical. Two endpoints this file
used to ship — `https://rpc.ankr.com/eth` and `https://polygon-rpc.com` — are
different companies, different brands, different registrable domains, and both
answer from **152.236.9.75**. And `rpc.ferminux.net` and `ferminux.net` are one
box (<node-host>), which is why only one of them is in the shipped Ferminux
row.

#### The two rules

**`minAgreeingEndpoints`** (default: a majority of the configured *providers*,
never below 2) is how many endpoints must independently show the same `Sent`
log, at the same block hash, before this node signs. Below that floor the answer
is always "refuse and retry later" — never "trust whichever endpoint is still
answering". An attacker who controls one of your configured endpoints and can
DoS the rest gets a stalled validator, not a signature on a lock that never
happened.

**SAFETY — no single provider may reach the floor on its own.** Config refuses
any set where one operator holds `minAgreeingEndpoints` endpoints or more.
Because `agreed >= floor > largest provider`, a set of endpoints big enough to
authorise a signature necessarily spans at least two operators. The check is
arithmetic at config time, so the signing path does not have to trust anything
at runtime.

**AVAILABILITY — losing one provider must leave the floor reachable.** Config
refuses any set where `endpoints - largest provider < minAgreeingEndpoints`.
This is what makes **three endpoints per chain, not two**, a rule rather than
advice: with two the floor is also 2, so killing ONE public provider stops that
validator signing — permanently, silently, and against the default
configuration. With three the floor is still 2, one provider can be down, and
the node degrades instead of halting.

Both rules apply to *enabled* chains only, so the shipped example can hold slots
for chains the bridge is not deployed on yet.

**Liveness is a real probe.** Each poll issues an `eth_chainId` round trip per
endpoint under `rpcProbeTimeoutMs`, and marks the endpoint unhealthy on a
timeout, an error, or the wrong chain id. This cannot be `getNetwork()`: every
provider is built with ethers' `staticNetwork` (correct, because the chain id a
signature is bound to must never be swapped underneath it), and `staticNetwork`
makes `getNetwork()` answer from a local constant without dialling — so a
provider pointed at a closed port reports the right chain id, forever. Endpoints
that fail a real data call (`eth_getLogs`, `eth_blockNumber`) are demoted the
moment they throw, and any endpoint is promoted back automatically the first
time it answers a probe correctly.

`/health` returns 503 while a chain is below its floor, because a node that
cannot confirm anything should not look fine.

**`insecure`** is the way out of any of this, and it is deliberately awkward:

```jsonc
"insecure": {
  "acknowledgement": "I understand this disables eclipse protection",
  "allowSingleRpcEndpoint": true,       // devnets: one anvil per chain. Turns off
                                        // EVERY independence rule and the DNS
                                        // check with them
  "allowPartialEndpointAgreement": true, // permits validator.requireRpcQuorum = false
  "allowCountFinalityWithoutGadget": true // devnets: lets an ENABLED chain with
                                          // finalityTag null run in plain `count`
                                          // mode. A real config must name
                                          // finality.mode = work-and-time or
                                          // checkpoint for such a chain (the
                                          // ferminux row of chains.example.json)
                                          // or it is refused at startup
}
```

A bare boolean is what gets flipped by someone who does not know what it does,
so each switch is ignored — and refused at startup — unless the acknowledgement
sentence is spelled out exactly. `config/chains.devnet.example.json` carries it;
`config/chains.example.json` does not, and a mainnet config never should.

---

## How the submitter cannot double-submit

1. **Ask the chain first.** `processed(transferId)` on the destination. True →
   record and stop. This alone handles "somebody else already relayed it".
2. **Simulate.** `execute()` is `staticCall`ed from the submitter's own address. A
   revert is a real finding — signatures, caps or registry are not what we think —
   so it alerts and never broadcasts.
3. **One nonce per transfer, persisted before the broadcast.** The transaction is
   signed offline, its hash and raw bytes and account nonce are written to durable
   state **and fsync'd**, and only then is it broadcast. Every retry re-signs at the
   **same nonce** with a higher fee, so the mempool holds a set of mutually exclusive
   transactions and at most one can ever be mined.
4. **A crash between signing and broadcasting is recoverable.** The attempt is on
   disk. The next start looks it up by hash and either finds it mined or
   re-broadcasts the identical bytes.
5. **The contract is the backstop.** `processed[transferId]` is set before any
   token moves, so even a submitter that ignored all of the above could at worst
   waste gas on a reverting transaction.

Escalation compounds `escalationPct` from the un-escalated first-attempt fee and is
hard-clamped by `maxFeePerGasGwei`. At the ceiling it stops and alerts instead of
burning more gas. A mined-and-reverted attempt is the one case that consumes the
nonce, so the next attempt allocates a fresh one — and that path alerts, because it
should not happen after a clean simulation.

Nonce allocation cannot collide with the submitter's own in-flight work:
`max(getTransactionCount(pending), 1 + highest nonce among pending submissions)`.

### Validator rotation is not a stranded transfer

`_verifySignatures()` requires `isValidator[signer]` for **every** signature in the
bundle and reverts the whole call on the first one that fails. A single attestation
from a validator who has since been rotated out therefore takes an otherwise
perfect quorum down with it.

So the bundle is never collected once and replayed:

* the destination's `getValidators()` and `threshold()` are re-read on **every**
  pass, and signatures from addresses that are no longer in the set are dropped —
  named in the log, not silently skipped
* exactly `threshold` signatures go out, ordered by numeric address, so a retry
  rebuilds identical calldata
* the signers of each broadcast attempt are recorded, so a rotation that lands
  while a transaction is in the mempool is spotted **immediately**: that
  transaction can now only revert, and it is replaced at the same nonce rather
  than left to burn the receipt timeout and an attempt from the budget
* if the rotation takes the quorum with it, the submitter **waits**. The transfer
  is still valid and can still be signed by whoever is in the set now;
  `signatureWaitMs` and the `transfer_stuck` alert cover the case where nobody does

---

## Signature transport

Deliberately boring. A signature is either valid against a locally computed digest
or it is garbage, and no transport can change that — so the transport's only job is
to be trivially auditable and to run without a broker.

**`http`** — each validator serves `GET /signatures?transferId=…` on its own host,
under its own control. The submitter polls the validators it is configured for. This
is the multi-party mode.

**`shared-dir`** — each validator writes `<dir>/<transferId>/<signer>.json`
(temp file + atomic rename). Fine for a single-operator deployment and for local
tests.

> **`shared-dir` is convenience, not M-of-N.** If one operator can write every file
> in that directory, the threshold is decorative. Use it when a single operator
> already controls all three keys and you want the ceremony to be honest about that;
> use `http` across separate machines when the threshold is meant to mean something.

Whatever the mode, the submitter re-derives the digest and recovers the signer
itself. The `signer` field in a payload is a hint for logging, never an authority —
`test/transport.test.mjs` includes an attacker signing with the wrong key and
claiming to be a validator.

---

## Durable state

`node:sqlite` by default (`state.driver: "auto"`), falling back to an append-only
NDJSON journal if the Node build has no SQLite. `"journal"` can be chosen outright
by anyone who would rather have a file they can `tail`. Both back the same
interface and `test/db.test.mjs` runs the whole suite against both.

| table | holds | why it must survive a restart |
|---|---|---|
| `cursors` | last settled block per chain | resume without re-scanning or skipping |
| `transfers` | every transfer seen, its status and reason | no duplicate signatures, an audit trail for refusals |
| `signatures` | one row per (transfer, signer) | a repeated signer never occupies two slots |
| `submissions` | account nonce + every signed attempt's raw bytes | the no-double-submit guarantee |
| `windows` | rolling 24h buckets | a validator cannot reset its own cap by restarting |

bigints are stored as decimal TEXT. Never REAL, never INTEGER.

---

## HTTP API

Read-only. There are no mutating routes at all.

| route | auth | purpose |
|---|---|---|
| `GET /health` | none | 200 when this node can do its job, 503 when it cannot. A health check that needs a secret is one nobody wires up. |
| `GET /metrics` | bearer | Prometheus text |
| `GET /status` | bearer | chains, endpoints, cursors, watcher stats, store counts |
| `GET /signatures?transferId=0x…` | bearer | validator only: this node's attestation, or 404 |
| `GET /transfers?status=&limit=` | bearer | listing for debugging and runbooks |

Put TLS in front of it. In a multi-party deployment the submitter reaches each
validator over the internet; the bearer token is transport auth only — a
signature is verified against a locally computed digest regardless of who
delivered it, so the token protects the *listing*, not the protocol.

**An empty `apiToken` means no authentication.** `/status` and `/transfers`
describe every transfer in flight — sender, recipient, amount, route, status —
so the relayer **refuses to start** with an empty token on any bind that is not
loopback. Generate one per host with `openssl rand -hex 32`; anything shorter
than 16 characters is rejected.

Every route, `/health` included, goes through a per-client-IP token bucket
before it is routed — an anonymous caller must not be able to spend a
validator's CPU and sockets and keep it from serving signatures to the
submitter, and a flood of wrong tokens must be throttled rather than answered
with `401` as fast as it can arrive. There are two buckets: `http.rateLimit`
(60 burst, 10/s sustained by default) for anonymous callers, and **10x that**
for callers presenting the bearer token, because the submitter legitimately
polls every validator for every in-flight transfer on every tick and throttling
*it* would stall the bridge. With no `apiToken` configured every caller counts
as authorised — which is only reachable on a loopback bind. Over-budget callers
get `429` with `Retry-After`, and the submitter treats that as "try the next
tick" rather than as a dead peer. The request line is
capped at 2 KB, the header block at 8 KB, concurrent connections at
`http.maxConnections` (256), and any request carrying a body is answered `413`
and disconnected — there is nothing here that reads one.

---

## Metrics and alerts

`/metrics` exposes `relayer_up`, `relayer_transfers_total{status}`,
`relayer_submissions_total{status}`, `relayer_signatures_total{chain}`,
`relayer_refusals_total{reason}`, `relayer_signatures_collected_total{peer}`,
`relayer_signatures_rejected_total{peer}`, `relayer_chain_head{chain}`,
`relayer_chain_settled{chain}`, `relayer_chain_cursor{chain}`,
`relayer_rpc_healthy{chain}`, `relayer_rpc_configured{chain}`,
`relayer_rpc_required{chain}`, `relayer_http_requests_total{route,outcome}` and
`relayer_alerts_total{kind}`. Finality (chains with a monitor):
`relayer_pace_degraded{chain}` (1 while refusing), `relayer_pace_median_gap_ms`,
`relayer_head_age_ms`, `relayer_checkpoint_ok`, `relayer_checkpoint_number`,
`relayer_checkpoint_lag_blocks`, `relayer_checkpoint_age_ms`. `/status` carries
the same under each chain's `finality` object, including `signing.reason`, the
one sentence a UI should show while a transfer waits. New alert kinds:
`chain_degraded` and `checkpoint`.

**The alert worth wiring first** is `relayer_rpc_healthy < relayer_rpc_required`:
below that floor the node confirms nothing and signs nothing, and apart from a
per-transfer `confirmation deferred` line it does so quietly. `/health` returns
503 in the same condition, so a load balancer sees it too.

Alerts POST JSON to `alerts.webhookUrl`, de-duplicated by key. The taxonomy is
small on purpose — if an alert fires and the correct response is "ignore it", the
alert is a bug.

| kind | severity | what it means |
|---|---|---|
| `rpc_divergence` | critical | **two endpoints for the same chain disagree.** Chain split or eclipse attempt. Stop and investigate before trusting anything from that chain. |
| `signature_mismatch` | critical | a signature did not recover to a known validator, a peer's transfer did not match ours, or a digest differed from the contract's |
| `domain_mismatch` | critical | a bridge's live `DOMAIN_SEPARATOR()` is not what we derive. Wrong address, wrong chain, or an impostor contract |
| `reorg` | critical | a confirmed transfer vanished past the confirmation depth |
| `cap_breach` | warn/critical | a transfer exceeded a configured cap; the validator refused to sign |
| `submission_failed` | critical | `execute()` reverted in simulation, reverted on chain, or every attempt failed |
| `transfer_stuck` | critical | no validator quorum within `signatureWaitMs` |
| `unknown_transfer` | critical | a peer offered a signature for a transfer this node has never seen on chain |
| `bridge_paused` | warn | the destination bridge reports itself paused |
| `rpc_unhealthy` | warn/critical | an endpoint is unreachable, timing out, or failing its data calls (warn); answering with the **wrong chain id** (critical); or the chain has dropped below `minAgreeingEndpoints`, meaning this node can no longer confirm anything (critical) |
| `lifecycle` | info | start, stop, no gas, not in the validator set |

The alert to wire straight to a pager is **`rpc_divergence`**, together with the
contract-side monitor from `../contracts/README.md`: *any `Executed` without a
matching `Sent` on the other side*. That pair is what a compromise looks like.

---

## Key management

- **Encrypted V3 keystore + a password file, both mode 0400.** The loader refuses
  a keystore or password file readable by group or other, and says which `chmod` to
  run. Verified: [Tests](#tests-and-what-they-actually-prove).
- **`--role keygen`** generates the key and writes the keystore at 0400. The
  private key never touches stdout, a log line or an environment variable.
- **`keystore.expectedAddress`** (or `FMX_RELAYER_ADDRESS`) pins the identity. A
  swapped keystore file becomes a startup failure, not a silent identity change.
- **`FMX_RELAYER_PRIVATE_KEY` refuses to load** unless
  `FMX_RELAYER_ALLOW_PLAINTEXT_KEY=1` is also set. You cannot reach for it by accident.
- **There is no environment path for the keystore password.** `FMX_RELAYER_PASSWORD`
  is not an option with a warning attached, it is a refusal: every role — including
  `check` and `keygen` — exits 2 before the config is read if it, or the retired
  `FMX_RELAYER_ALLOW_ENV_PASSWORD`, is set. The file check exists because a file can
  be mode 0400 and a variable cannot, and an opt-in flag only moved that decision to
  whoever wrote the unit file. If the process refuses, the password has already been
  through `/proc/<pid>/environ` and every child: unset it, rotate it, and point
  `FMX_RELAYER_PASSWORD_FILE` at a 0400 file.
- **systemd credentials** (`LoadCredential=`) keep the keystore root-owned on disk
  and hand it to the unit through a per-unit tmpfs at 0400 — never in the
  environment, never in the process list. The shipped unit does this.
- **Three validators, three machines, three custodians.** Not three keys on one
  host, not three containers on one docker daemon, not three files in one S3 bucket.
  Everything else in this document is a detail next to that sentence.
- **The submitter's key is not a validator key.** It pays gas. Give it gas and
  nothing else; if it leaks, you lose gas.
- Logs redact anything keyed `password`, `passphrase`, `pwd`, `privateKey`,
  `secret`, `mnemonic`, `keystore`, `apiToken`, `peerToken`, `bearer` or
  `authorization` — at any nesting depth, case-insensitively. A key named
  `token` is deliberately NOT redacted: it carries a token *address* in most
  alert payloads, and blanking those would blind an operator mid-incident.
  There is a test that asserts both halves of that sentence.

---

## Deployment — Docker

```sh
docker build -t ferminux/bridge-relayer:1.0.0 .

docker run -d --name fmx-validator \
  --restart unless-stopped \
  --read-only --cap-drop=ALL --security-opt no-new-privileges \
  -v /etc/ferminux-relayer/chains.json:/etc/ferminux-relayer/chains.json:ro \
  -v /etc/ferminux-relayer/validator.keystore.json:/run/secrets/keystore:ro \
  -v /etc/ferminux-relayer/validator.password:/run/secrets/password:ro \
  -v fmx-relayer-state:/var/lib/ferminux-relayer \
  -e FMX_RELAYER_KEYSTORE=/run/secrets/keystore \
  -e FMX_RELAYER_PASSWORD_FILE=/run/secrets/password \
  -e FMX_RELAYER_ADDRESS=0xYourValidatorAddress \
  -e FMX_RELAYER_API_TOKEN="$(openssl rand -hex 32)" \
  -e FMX_RELAYER_ALERT_WEBHOOK=https://… \
  -p 127.0.0.1:8564:8564 \
  ferminux/bridge-relayer:1.0.0 --role validator
```

The image carries no key material and no config; both are mounted. It runs as
`node` (uid 1000), needs no capabilities, and works `--read-only` as long as the
state volume is writable. `tini` forwards `SIGTERM`, so `docker stop` is a clean
shutdown that closes the store rather than killing it mid-write. The healthcheck
hits `/health`, which needs no secret.

The mounted files must still satisfy the permission check — `chmod 400` them on the
host before mounting.

Note the two container-specific traps. `http.host` inside a container is usually
`0.0.0.0`, which is a network-reachable bind as far as the config parser is
concerned (it has no way to know a container namespace is around it), so an
`apiToken` is mandatory there even when the port is published only to
`127.0.0.1` — that is what the `-e FMX_RELAYER_API_TOKEN` line above is for. And
`FMX_RELAYER_PASSWORD` in a `-e` flag is refused outright — the container exits
2 — because it would sit in the process environment, in `docker inspect`, and in
every child process. Mount the password file and point
`FMX_RELAYER_PASSWORD_FILE` at it, as above.

---

## Deployment — systemd

`deploy/ferminux-relayer@.service` is a templated unit; `%i` is the role.

```sh
useradd --system --home /var/lib/ferminux-relayer --shell /usr/sbin/nologin ferminux-relayer
install -d -o ferminux-relayer -g ferminux-relayer -m 0750 /var/lib/ferminux-relayer
install -d -o root -g ferminux-relayer -m 0750 /etc/ferminux-relayer
rsync -a --exclude node_modules --exclude state ./ /opt/ferminux-relayer/
(cd /opt/ferminux-relayer && npm ci --omit=dev)

cp config/chains.example.json /etc/ferminux-relayer/chains.json && $EDITOR $_
cp deploy/validator.env.example /etc/ferminux-relayer/validator.env && $EDITOR $_
install -o root -g ferminux-relayer -m 0640 validator.keystore.json /etc/ferminux-relayer/
install -o root -g ferminux-relayer -m 0640 validator.password     /etc/ferminux-relayer/

install -m 0644 deploy/ferminux-relayer@.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now ferminux-relayer@validator
journalctl -u ferminux-relayer@validator -f
```

`ExecStartPre` runs `--role check`, so a unit with a broken config or an
unreachable chain fails to start instead of running blind. The unit ships with
`ProtectSystem=strict`, an empty capability bounding set, `SystemCallFilter=@system-service`
and exactly one writable path. `MemoryDenyWriteExecute` is deliberately **not** set —
V8's JIT needs W+X and the unit would fail to start with it on.

---

## Tests, and what they actually prove

```sh
npm test            # 173 unit tests, ~3s
npm run e2e         # the full two-anvil end-to-end, ~2 min, 68 assertions
npm run docker-check # the built image against live local chains
npm run typecheck   # tsc --noEmit, strict
```

Everything below was **executed on this machine**; the transcript is the real output.

### Unit — 173 tests, all green

- `finality.test.mjs` — 37 tests over hand-built header chains served by two fake
  endpoints per chain with an injected clock: the explicit mode config rules;
  pace OK / degraded by median gap / degraded by stalled head / unknown when
  headers cannot be read / recovery announced; work below threshold, work met but
  time floor not, head not above the block; a reorged source block and a head
  that does not descend from it (by-number lookup still agreeing); a broken walk;
  a lying header body; checkpoint ok with lag in `/status`, behind, missing,
  stale, mismatch (critical), mismatch beating stale, registry endpoints
  disagreeing, registry unreadable, checkpointed block unreadable, pace gating
  checkpoint mode, a registry honoured in work-and-time mode; and the
  `verifyForSigning` integration, including "no monitor is a refusal".
- `protocol.test.mjs` — the pinned vectors are **not** self-generated. `transferId`
  came from the contract's own indexed event topic, the digest was cross-checked
  against `hashTransfer()` on chain before a validator signed it, and both domain
  separators were compared to the live `DOMAIN_SEPARATOR()`. Also: every field
  change alters the id; a signature is worthless on another chain or another
  deployment; malleable (high-s) signatures are rejected with our own error message.
- `config.test.mjs` — the shipped example parses; unknown keys are fatal; an
  enabled chain must have a real bridge address; zero confirmations without a
  finality tag is refused; `escalationPct < 10` is refused; env overrides work.
- `limits.test.mjs` — the decay curve matches `FerminuxBridge._usage()` at the
  half, quarter and edge of the window, and **capacity never jumps**: sampled 240
  times across 24h, no step releases more than 0.5% of the bucket.
- `transport.test.mjs` — seven attempts to get something past `verifyPayload`, all
  refused: forged signer field, wrong transfer id, one altered field, a signature for
  another chain, a signature for another bridge, a lying digest, junk shapes.
- `rotation.test.mjs` — real signatures from real keys, against a validator set
  that changes underneath them: the removed validator is dropped and named, the
  surviving quorum still ships, a validator added after signing is usable at once,
  a rotation that costs the quorum produces a short bundle rather than a doomed
  one, ordering is numeric (not the host's collation), and the last test moves the
  set on a fake destination node between two reads of the same `ChainClient` to
  prove the set is re-read rather than cached.
- `tokenconfig.test.mjs` — the registry layout is checked **against
  `contracts/src/FerminuxBridge.sol` itself**, so a hand-written ABI cannot drift
  from the struct; the read is driven by the return data, so the retired
  seven-field shape (the one that carried `lossy`) still decodes and anything else
  is named instead of mis-read into a plausible wrong answer.
- `db.test.mjs` — the whole suite runs against **both** backends: cursors, bigint
  round-trip, status transitions, signature dedupe, and a submission surviving a
  simulated `kill -9` with its nonce and raw bytes intact.
- `gas.test.mjs` — escalation compounds, every attempt is a valid ≥10% mempool
  replacement of the last, the ceiling clamps and reports itself. This suite caught
  a real double-escalation bug in the legacy (type-0) path, now fixed.
- `hardening.test.mjs` — one test per off-chain finding of the 2026-08-20 red
  team, each written so it fails against the code as it was audited. It stands
  up hand-written JSON-RPC endpoints (no anvil, so it can serve deliberately
  wrong answers) on 8592-8595 and proves: a dead endpoint is demoted even though
  `getNetwork()` still answers for it; a wrong-chain endpoint is rejected and
  fires the alert that used to be unreachable dead code; an endpoint that comes
  back is promoted again with no operator; one healthy survivor out of two
  cannot confirm a transfer, with or without `requireRpcQuorum`; two of three
  can; a single-endpoint chain does not parse; the insecure switches need their
  sentence; an unauthenticated call is refused and a flood is throttled;
  a keystore password in the environment stops the PROCESS starting, in every
  role, with or without the retired opt-in flag; a bundle is re-sliced against
  the destination's live validator set, so a rotation mid-flight drops the stale
  signature instead of stranding a transfer that has a quorum; secrets are
  redacted from logs and token addresses are not; and consumed 24h capacity is
  returned on every reject path — 40 rejections in a row cost the validator
  nothing.

### End-to-end — two anvils, real contracts, real processes

`test/e2e.mjs` starts anvil on **8562** (chain 3961) and **8563** (chain 56) — the
only fixed ports; every other listener binds port 0 — deploys the real
`FerminuxBridge` and `BridgeToken` from `../contracts` (compiled into `./artifacts`,
so the contracts directory is only ever **read**), records the counterpart bridge on each
chain and pins the wrapper bytecode, registers the token pair — all four through
the real 1h timelock — and then runs the actual `src/index.ts` binaries as separate
child processes.

Two of those steps are new here, and the reason is worth stating: `registerCanonical`
and `registerWrapped` refuse to run until `remoteBridge[chain]` is set and the
wrapper codehash is pinned, so a harness that skipped them could not stand a route
up at all. This suite had been passing against a **stale `artifacts/` directory**
built before those preconditions existed — a rebuild is what surfaced it. `npm run
e2e` now fails loudly if the artifacts are stale, because the contract it deploys is
the contract in `../contracts/src`.

Actual output of a clean run (68 assertions, 17 phases):

```
== 5. HAPPY PATH — lock 10 FMX on A, quorum signs, submitter executes on B
   transferId 0xe68c83e60233111e9eb70f8c32630bec2ebe43abe4d1e278faeb6106f9274b5b
   net 9.99 FMX (fee 0.01)
   PASS recipient wFMX balance (9990000000000000000)
   PASS collateral locked on chain A backs the supply exactly (9990000000000000000)
   PASS exactly one Executed event on chain B (1)
   PASS submitter collected exactly the threshold of signatures (2)

== 6. FAILURE MODE — insufficient signatures (threshold 2, only 1 validator up)
   PASS NOT executed with only 1 of 2 required signatures (0)
   PASS submitter is holding exactly one signature and waiting (1)
   PASS validator2 came back on :62695 and resumed from its persisted cursor
   PASS executed exactly once after the second signature arrived (1)

== 7. FAILURE MODE — replay: re-submitting an executed transfer must be refused
   PASS on-chain replay refused: execution reverted: "BRIDGE: already processed"
   PASS submitter never re-submits an executed transfer (1)

== 8. FAILURE MODE — cap breach: above the validator cap, below the contract cap
   PASS validator1 refused: over_local_per_transfer_cap: amount 49950000000000000000
        exceeds the local source per-transfer cap 20000000000000000000
   PASS the over-cap transfer never reached chain B (0)
   49.95 FMX is now locked on A with nothing minted on B — stranded until an operator acts

== 9. FAILURE MODE — reorg: a Sent that vanishes after being seen must never be signed
   PASS validator1 has it as "seen" — shallow, unsigned
   reverted chain A to block 22 — the Sent log no longer exists
   PASS validator1 orphaned the transfer: log absent at block 23
   PASS validator1 produced NO signature for the reorged-away transfer (404)

== 10. FAILURE MODE — RPC divergence detected by --role check
   lying endpoint: honest chain id, honest head, WRONG block hashes
   PASS the divergence detector fired
   PASS --role check exits non-zero when endpoints disagree (1)

== 11. FAILURE MODE — an eclipsing endpoint hides a log: the validator must refuse to sign
   PASS transfer held at "seen" — never promoted, never signed
   PASS an rpc_divergence alert named the exact transfer
   PASS the eclipse degraded one validator, it did not stop or lose the transfer
   PASS validator3 confirmed only once BOTH endpoints showed the log (2/2)

== 12. FAILURE MODE — a DEAD RPC endpoint: it must not stall a validator, and it
       must not leave one endpoint deciding alone
   dead endpoint http://127.0.0.1:54915 (nothing is listening there)
   PASS the dead endpoint is demoted out of the healthy set, the two live ones stay in (2)
   PASS a majority of three endpoints must agree before this node signs (2)
   PASS it confirmed on the two endpoints that answered, and counted only those (2/2)
   PASS one dead endpoint out of three degrades nothing — the validator signs normally
   one of its two endpoints just went away — it is now down to a single source of truth
   PASS transfer held at "seen" — an eclipse that kills the honest endpoints gets a
        refusal, not a signature
   PASS no signature was produced from the lone survivor (404)
   PASS and it reports itself UNHEALTHY rather than looking fine (503)
   PASS a validator that cannot reach its agreement floor refuses to start (1)

== 13. RESILIENCE — kill the submitter mid-flight and confirm it resumes exactly once
   chain B automine OFF — the execute() tx will sit unmined
   broadcast 0x6a5e87c6c4619af03949683ed1de187e46c9ee94daeaadcf4f91dc1386299be4
   submitter SIGKILLed while the transaction was still in the mempool
   chain B mined the pending transaction while the submitter was down
   PASS it recognised its OWN pre-crash transaction, no new one
   PASS exactly one Executed event — no double submit (1)

== 14. ROUND TRIP — burn wFMX on B, release the locked FMX on A
   PASS user received exactly the signed net amount back (4995000000000000000)
   PASS lockedBalance on A == wFMX supply on B + the refused (stranded) transfer

== 15. alerting and metrics
   {"lifecycle":9,"cap_breach":10,"reorg":3,"rpc_divergence":2,"rpc_unhealthy":3,"transfer_stuck":2}
   relayer_transfers_total{status="executed"} 6
   relayer_transfers_total{status="orphaned"} 1
   relayer_transfers_total{status="rejected"} 1

E2E PASSED — all phases green
```

Four of those deserve a second look:

- **Phase 11** is the eclipse test. A proxy sits between the validator and the
  chain: honest `eth_chainId`, honest head, and it silently hides `eth_getLogs`
  results. The validator holds the transfer at `seen`, alerts `rpc_divergence` naming
  the exact transfer, and never signs. Meanwhile the two un-eclipsed validators
  complete the transfer normally — an eclipse degrades one node, not the bridge —
  and when the proxy stops lying, the eclipsed validator confirms with `2/2`
  agreement and correctly declines to sign something already executed.
- **Phase 12** is the dead-endpoint test, and it is two opposite claims in one
  phase. With three endpoints and one of them pointed at a closed port, the
  validator signs normally — the dead endpoint is demoted by a real probe, and
  the two that answered are a quorum. With two endpoints and one of them killed
  mid-flight, the same validator refuses: one surviving endpoint is not
  corroboration, it is what an eclipse leaves you with. And a validator that is
  already below its floor at startup does not start at all. Before the fix the
  first case hung forever (the dead endpoint stayed "healthy" and the strict
  quorum path deferred every poll) and the third started degraded and silent.
- **Phase 13** proves the durable-state design end to end. Mining is disabled on the
  destination so the `execute()` transaction sits in the mempool; the submitter is
  `SIGKILL`ed; the chain then mines it while the process is dead; the restarted
  submitter recognises **its own** pre-crash transaction hash rather than sending a
  new one. Exactly one `Executed` event, before and after.
- **Phase 8** ends with a note rather than a cheer, because a refusal is not free:
  `send()` had already locked the collateral. See the runbook below.

### Container

`test/docker-check.mjs` boots the same two anvils, deploys the bridges, and runs
`--role check` **inside the built image** over `host.docker.internal` — proving the
image's runtime, networking and entrypoint, not just its config parser:

```
docker build -t ferminux/bridge-relayer:1.0.0 .
node test/docker-check.mjs
  → chain OK  ferminux-local 3961  domainVerified: true  threshold: 2  paused: false
  → chain OK  remote-local     56  domainVerified: true  threshold: 2  paused: false
  → preflight passed  failures: 0
```

Image: 289 MB, runs as uid 1000, no capabilities.

### What is *not* covered

- No mainnet or public-testnet deployment was performed. Nothing here has touched
  chain 3961 or any public RPC.
- The `shared-dir` transport has unit coverage but is not exercised by the e2e,
  which runs the `http` path.
- The `finalityTag` path is exercised by config parsing only; anvil serves no
  `finalized` tag, so the tag-vs-count interaction is untested against a real chain.
- Gas escalation is unit-tested but never fired in the e2e — anvil mines instantly,
  so no attempt ever timed out. The retry code path has not run against a congested
  chain.
- The systemd unit has not been installed on a live host (no systemd on this
  machine); it is written against systemd 250+ semantics and reviewed, not executed.
- The HTTP rate limiter is exercised by `hardening.test.mjs` against a real
  server and socket, but only from a single client address. Per-client fairness
  under a distributed flood is reasoned about (one bucket per source address,
  table bounded by `maxClients`), not measured.
- The RPC quorum tests use hand-written JSON-RPC endpoints on loopback. They can
  produce a dead endpoint, a wrong-chain endpoint, a broken endpoint and a lying
  endpoint precisely, which anvil cannot — but they are not a real node, and the
  probe has not been measured against a rate-limited or partially-degraded public
  provider.

---

## Run it yourself on two anvils

`npm run e2e` does all of this. To drive it by hand:

```sh
# terminal A — stands in for Ferminux
anvil --port 8562 --chain-id 3961

# terminal B — stands in for a remote EVM
anvil --port 8563 --chain-id 56

# terminal C — compile the contracts into THIS component's artifact dir
cd <repo>/bridge/relayer
forge build --root ../contracts --out ./artifacts --cache-path ./.forge-cache

# deploy both bridges, the wrapper, and register the pair through the timelock
node test/e2e.mjs           # or lift the phases you want from it

# run a validator against the devnet config
FMX_RELAYER_PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d \
FMX_RELAYER_ALLOW_PLAINTEXT_KEY=1 \
  node src/index.ts --role validator --config config/chains.devnet.example.json

# and a submitter, pointed at the validators' printed ports
FMX_RELAYER_PRIVATE_KEY=0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356 \
FMX_RELAYER_ALLOW_PLAINTEXT_KEY=1 \
FMX_RELAYER_PEERS=http://127.0.0.1:<v1port>,http://127.0.0.1:<v2port> \
  node src/index.ts --role submitter --config config/chains.devnet.example.json
```

Stop the anvils when you are done: `pkill -f "anvil --port 856"`.

Those private keys are anvil's published dev accounts. They are in this file on
purpose, and `FMX_RELAYER_ALLOW_PLAINTEXT_KEY=1` exists so that using them requires
saying so out loud.

---

## Runbooks

### A validator key is compromised — the next 10 minutes

The single most important thing to understand first: **containment does not wait
for key rotation.** Removing a validator is timelocked at 48h by design. Pausing is
one transaction. Do not spend the first ten minutes trying to rotate.

**Minute 0–1 — PAUSE. Both chains.**

```sh
cast send $BRIDGE_A 'pause()' --private-key $PAUSER_KEY --rpc-url $RPC_A
cast send $BRIDGE_B 'pause()' --private-key $PAUSER_KEY --rpc-url $RPC_B
cast call  $BRIDGE_A 'paused()(bool)' --rpc-url $RPC_A   # must be true
cast call  $BRIDGE_B 'paused()(bool)' --rpc-url $RPC_B   # must be true
```

The pauser is a hot key held for exactly this. It cannot un-pause — only the owner
multisig can — so using it is never the wrong call. **If in doubt, pause.** A paused
bridge is an availability incident; an un-paused compromised bridge is an
insolvency.

**Minute 1–2 — stop the compromised validator process.**

```sh
systemctl stop ferminux-relayer@validator     # or: docker stop fmx-validator
```

Do not wipe the host. It is evidence, and you will want to know how the key left.

**Minute 2–4 — establish what one key can and cannot have done.**

With threshold 2-of-3, one key is **one vote and cannot execute anything**. The
contract counts *distinct* recovered signers, so the same signature submitted fifty
times still counts as one, and flipping `s` to `n−s` to manufacture a "second"
signature is rejected as malleable. So the question is not "what did they sign" but
**"did a second validator sign the same fraudulent transfer"**.

```sh
# every Executed on the destination in the incident window
cast logs --from-block <n> --address $BRIDGE_B \
  'Executed(bytes32,uint64,address,address,address,uint256,uint256)' --rpc-url $RPC_B
```

For each one, confirm a matching `Sent` exists on the source chain with the same
`transferId`. **An `Executed` with no matching `Sent` is the compromise signal** —
that is a quorum breach, not a single-key incident, and the response is the full
insolvency path, not this runbook.

Your own nodes make this quick:

```sh
curl -s -H "Authorization: Bearer $TOKEN" localhost:8564/transfers?limit=200 | jq '.transfers[] | select(.status=="executed")'
```

**Minute 4–6 — bound the exposure.**

Even a full quorum compromise is bounded by `dailyCap` per token per rolling 24h.
Tighten the caps to zero — this is **immediate**, no timelock, because tightening is
always safe:

```sh
cast send $BRIDGE_A 'decreaseTokenLimits(address,uint256,uint256)' $TOKEN 0 0 \
  --private-key $OWNER_KEY --rpc-url $RPC_A
```

**Minute 6–8 — tell the other custodians, out of band.**

The other two validators must know that one key is hostile before they are asked to
sign anything. Use the channel you wrote down when you deployed, not the one the
attacker might also be in. If a second validator has been compromised the
containment picture changes completely.

**Minute 8–10 — start the clock on rotation.**

```sh
# generate a replacement on a NEW host
FMX_RELAYER_PASSWORD_FILE=/etc/ferminux-relayer/validator.password \
  node src/index.ts --role keygen --out /etc/ferminux-relayer/validator.keystore.json

# queue both changes through the owner multisig — 48h each, and they run in parallel
cast send $BRIDGE_A 'queue(bytes)' $(cast calldata 'removeValidator(address)' $OLD) …
cast send $BRIDGE_A 'queue(bytes)' $(cast calldata 'addValidator(address)'    $NEW) …
# same on chain B
```

Publish the queued action ids and calldata. The 48h window is a feature: it lets
users and the other custodians audit what is about to change.

**Only then** consider un-pausing, and only from the owner multisig, and only once
the removal has executed and you know how the key leaked.

**Afterwards, in writing:** how the key left, whether `expectedAddress` and the
keystore permission checks were in place, whether the alert that should have fired
did, and whether the pauser key was reachable at 03:00 by the person who needed it.

### `rpc_divergence` fired

Two endpoints for one chain disagree at a settled height. **Treat that chain as
untrusted until resolved.** In order:

1. `node src/index.ts --role check --config …` — it prints the conflicting block
   hashes and which endpoint reported each.
2. Compare both against a third, independent source (a public explorer, a
   different provider). The odd one out is your answer.
3. If your own node is the odd one out, it is behind, forked, or compromised: pull
   it from `rpcUrls` and restart. If a *provider* is the odd one out, the same, and
   tell them. **Replace it, do not just delete it** — an enabled chain needs
   three endpoints from three independent providers, so deleting one is a
   startup failure by design. That is the point of the third: you can pull the
   liar and keep signing while you find a replacement.
4. If you cannot tell which is right, `pause()`. A validator that cannot establish
   what happened on a chain must not be attesting to what happened on that chain.

The validator has already refused to sign anything it could not confirm across all
endpoints, so nothing is lost by taking the time. Note the difference between the
two refusals you may see in the log: `endpoints disagree` is this case, a split
or an eclipse, and it pages you. `only N endpoint(s) confirmed, M required` is
the quieter one — nobody contradicted anything, there simply were not enough
witnesses left to decide, which is what a DoS against your providers looks like
from the inside.

### A transfer is stuck (`transfer_stuck`)

1. `GET /transfers?limit=200` on each validator. The `status` and `reason` say who
   refused and why.
2. `rejected` with `over_local_*_cap` — a validator's config is tighter than the
   contract's. Intended, if the amount is genuinely above policy.
3. `orphaned` — the source log vanished. The user's funds were never locked on the
   canonical side (the block was reverted); nothing to do.
4. `confirmed` on some, missing on others — a validator is behind. Check
   `relayer_chain_cursor` and `relayer_rpc_healthy` for that node.
5. `signed` everywhere but never executed — the **submitter** is the problem, not
   the validators. Check `submissions` in `/status`, the gas balance, and
   `submission_failed` alerts. Anyone can run a second submitter; `execute()` is
   permissionless, and the signatures are already published.

### Funds stranded by a refusal

When a validator refuses, `send()` has **already locked the collateral** on the
source chain. Nothing is stolen and nothing is minted, but that user's funds are
sitting in the bridge with no path forward. The e2e demonstrates this deliberately.

There is **no automatic remedy and no refund path in the contract** — `rescue()`
cannot touch `lockedBalance`, by design. Options, in preference order:

1. If the refusal was a policy cap that is legitimately too tight, raise the
   validator's config cap (no timelock, it is off-chain), restart, and the transfer
   completes normally on the next tick — the transfer is `rejected` locally, so it
   must be re-driven; the simplest route is a fresh `send()` after the operator has
   made the user whole off-chain.
2. If the refusal was correct and the transfer must not complete, the user is made
   whole off-chain by the operator, and the locked amount becomes permanent
   over-collateralisation. It is not lost; it is just not theirs any more.
3. Do **not** attempt to "fix" it by getting validators to sign something they
   refused. That is the one thing this entire component exists to prevent.

Monitor for it: `lockedBalance(token)` on the canonical side should equal the
wrapper's `totalSupply()` on the other. A growing gap is stranded value, and the
`cap_breach` alerts tell you how it got there.

---

## Known limitations

- **Header contents are trusted at quorum, not re-hashed.** The monitor requires
  `minAgreeingEndpoints` endpoints to return identical header fields for a hash,
  but does not RLP-encode and keccak the header itself. Two colluding providers
  could inflate `difficulty`; they could already collude on a log, which is the
  same trust boundary.
- **`workThreshold` is a number the operator derives from live difficulty** and
  has to re-derive when hashrate moves materially. It applies only to
  `work-and-time`, i.e. a proof-of-work source. Too low and the time floor is
  doing all the work; too high and the bridge waits longer than intended. The
  shipped example value is a placeholder and says so.
- **`shared-dir` is not M-of-N.** Documented above; repeated here because it is the
  easiest thing in this component to deploy and get wrong.
- **A validator's caps are per-node.** Three validators can be configured with three
  different caps. That is deliberate (a conservative custodian can be stricter than
  the group) but it means the effective policy is the *second-strictest* of the
  three at threshold 2, and nothing enforces that they agree.
- **The rolling window is the validator's own, not the chain's.** It counts what
  this node signed, not what executed on chain, so the two drift when a node is
  restarted from an empty state or when transfers are signed but never relayed.
  It is a fence, not an accounting record.
- **Refusals strand funds.** See the runbook. This is a property of the contract's
  lock-then-attest design, not of the relayer, but the relayer is what triggers it.
- **`unknown_transfer` fires on a narrow path only.** The submitter only ever asks
  peers about transfers it has already observed itself, so the only way to trigger it
  is a peer answering with a *different* transfer id than the one requested. That is
  covered. A push-based transport, where a peer could volunteer a transfer unprompted,
  does not exist — and the alert is not exercised by the e2e, only by construction.
- **One submitter is a single point of availability** (not of safety). If it stops,
  transfers stall with signatures already published, and anyone — including a user —
  can relay them. Running two submitters is safe: they share no state, and the
  `processed` check plus the on-chain replay guard makes the loser waste gas at worst.
- **A DoS against your RPC providers stops this validator signing.** That is the
  intended trade and it is worth stating plainly: below `minAgreeingEndpoints`
  the node refuses rather than trusting whoever is still answering, so an
  attacker who can knock over enough of your providers can halt *your* node.
  They cannot make it sign anything. The mitigation is endpoint diversity —
  three providers who do not share infrastructure — not a lower floor.
- **Independence is checked as far as DNS can see it, and no further.**
  Loopback aliases, shared registrable domains and shared A/AAAA records are all
  caught, at parse time or by `--role check`. What is still invisible: two
  vendors reselling one upstream node, and — the common case — providers that
  resolve to different addresses inside the same CDN. Six of the endpoints
  shipped in `chains.example.json` answer from Cloudflare ranges
  (104.18.x, 104.20.x, 172.66.x) on different addresses; the checker reads them
  as independent and a Cloudflare-wide outage would not. Choose operators that
  fail independently, and run one node yourself where you can.
- **The DNS check can also be wrong in the safe direction.** Two genuinely
  separate vendors that happen to land on one anycast address are grouped, and
  the node refuses to start. That is the intended bias — the failure is loud, at
  startup, with both URLs named — and the fix is one of the two the message
  offers: swap the endpoint, or raise `minAgreeingEndpoints` above the size of
  the group. Addresses move, so re-run `--role check` after any provider change
  rather than only at install time.
- **No mainnet deployment has been performed** from this component, and no key in
  this repository has ever been used on chain 3961.
