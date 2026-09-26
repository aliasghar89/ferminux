# Validator devnet: the Step 1 checklist on real binaries

A private network, chain id **39619** (never 3961), that runs the PLAN section 10.1 Step 1
checklist end to end with the real programs: the `ferminux` node built from `chain/` at HEAD,
the `fmx-validator` sidecar built from `validator/` at HEAD (Linux builds, in containers), and
the ValidatorHub, lens and router deployed by `agents/contracts/script/DeployValidatorsTestnet.s.sol`.
Every check, with the transaction hashes and on-chain reads behind it, is in `evidence/`.

Ferminux uses proof-of-authority consensus. Validator seats check blocks and sign checkpoint
statements; they do not produce blocks. Nothing here changes consensus.

## What runs

| Container | What it is |
|---|---|
| `fmxd-sig1..3` | the three signers: `ferminux` with the mainnet signer unit's flags (IPC only, `--mine`, `--miner.gaslimit 100000000`, etherbase = own key) |
| `fmxd-rpc` | a node with HTTP (archive), published on this Mac at `127.0.0.1:39545` only; the scripts, the deploy and the explorer use it |
| `fmxd-v01..v12` | twelve validator machines, each `fmx-validator run` **supervising its own node**, as the Linux package installs it |
| `fmxd-h1`, `fmxd-h2` | two multi-seat hosts: one `ferminux` node and 11 / 13 `fmx-validator` instances attached to it over IPC (`init --node-ipc`), each with its own key, protection database and dashboard |

36 `fmx-validator` instances and 36 seats in all. Every sidecar runs with the mainnet readiness
floor of 3 peers (`minPeers: 3`; the devnet preset alone would allow 0).

## Choices, and why

- **Chain id 39619, own keys.** One devnet mnemonic (`keys.sh`, in `.run/`, gitignored) derives
  the signers, the multisig owners, the deployer, the funder, the reporter and 40 seat owners.
  Attester keys are made by each sidecar with `fmx-validator keys new`, as an operator would.
- **The node is HEAD with devnet parameters only** (`patch-devnet-params.py`, diff in
  `evidence/00-build.log`): the signer list, the break-glass owners, the reward sink address and
  the block period. The genesis (chain id 39619, `posaBlock: 1`) arms the Ferminux engine from
  block 1. Everything else (the engine, the reward split, the 64-block reorg cap, fork choice)
  is the release source.
- **1-second blocks.** The hub counts every duration in blocks at 7 s (24 h = 12,343 blocks,
  7 days = 86,400, 14 days = 172,800) and has **no devnet parameter**, so nothing in it was
  shortened: checkpoints are every 200 blocks and certification needs 30 eligible seats. The
  node's smallest period is 1 s (`consensus/posa.New` refuses 0), so the devnet runs at about
  one block a second and the whole checklist takes about 50 hours of wall time. The hub itself
  is byte for byte the source in `agents/contracts/src/validators/`.
- **Enough seats, not a devnet parameter, for certification.** 36 seats: 10 in the first day
  bucket (the 10-a-day churn limit), then the multisig raises activations to 50 a day by the
  48 h timelock and 16 + 10 more seats open about 1,200 blocks apart, so the chain passes
  through "22 eligible" (not certifiable however many attest) before "32 eligible".
- **The owner is a 2-of-3 MinimalMultisig** (`contracts/src/MinimalMultisig.sol`), deployed at
  deployer nonce 0, and the FMXRewardSink at nonce 1, the address compiled into the devnet node,
  so the engine pays 50% of every block reward into the real sink contract from block 1.
- **Memory.** A sidecar opens its scrypt keystore once at start (256 MiB for N = 2^18) and
  the Go runtime returns that memory at its first forced GC, about two minutes later (then it
  runs at about 17 MB). The machines therefore start 20 s apart, and the multi-seat hosts cap
  each attached sidecar's heap with `GOMEMLIMIT=96MiB` (the node there is a separate process
  and is not affected). The supervised machines run unmodified.

## Run it

```sh
cd validator/devnet
./run.sh                      # keys (once), build, network up, then driver.sh detached (~50 h)
tail -f .run/driver.out       # progress; evidence/*.log fill in as each step finishes
./net.sh ps | heads           # containers, signer and rpc heads
node hub.mjs seats            # every seat, from the chain
./explorer.sh <dir> /validators /validators/2    # the explorer's pages against the devnet
./net.sh wipe                 # remove everything (containers, volumes, state; the keys stay)
```

Docker runs in its own colima profile (`colima start --profile fmxdev --cpu 6 --memory 8`,
context `colima-fmxdev`); the scripts set `DOCKER_CONTEXT` themselves and never touch the
default context.

## Evidence

| File | PLAN 10.1 / task item |
|---|---|
| `00-build.log` | binaries: HEAD, the params diff, toolchain, sha256, genesis hash |
| `01-network.log` | signers, rpc, 14 validator machines, peers, engine armed, blocks every second |
| `02-deploy.log`, `deployments-validators.39619.json` | multisig, sink, hub, lens, router; owner, deny list, PUSH0-free |
| `03-timelock.log` | activations per day 10 -> 50 by the 48 h timelock; early apply refused |
| `04-seats.log` | seats opened with `seat-proof` calldata; deny list, wrong deposit, reused key refused |
| `05-activation.log` | seats wait 12,343 blocks, then attest |
| `06-empty-pool.log` | empty pool: attestations count and earn 0; partial funding pays only whole rewards; the 20,000 FMX tranche |
| `07-rewards-claim.log` | 0.025 FMX per accepted attestation; claim; claimToAttester |
| `08-restart-no-double.log` | SIGKILL of a whole machine right after it submitted, and a clean restart inside the window: one attestation each |
| `09-second-machine.log` | the same attester key on a second machine refuses to sign |
| `10-bad-attestations.log` | wrong hash, closed window, not a checkpoint, another chain id, another hub, a future checkpoint: all revert |
| `11-slash-veto.log` | a manual double attestation: 10% slash after the 48 h window, 20 FMX to the reporter, 180 FMX burned; a second one vetoed by the multisig inside the window; a late veto refused |
| `12-jail-unjail.log` | a machine switched off: jailed after 124 checkpoints under 50%, unjailed after 24 h, attests again |
| `13-exit-unbond.log` | exit, 14-day unbond, withdraw of the full 2,000 FMX; rewards stop at exit |
| `14-certification.log` | eligible 6 and 22: never certified; 32 eligible: certified |
| `15-signer-halt.log` | all signers stopped: no blocks, no certificate, sidecars not ready; resume |
| `16-final-state.log` | every attestation inside [h+64, h+250], none twice; reward and deposit conservation; every protection database against the chain |
| `explorer-*/` | the explorer built with `VITE_RPC` = the devnet, `/validators` and seat pages at desktop and phone width |
| `18-forge-tests.log`, `19-sidecar-tests.log` | the contract suite (gas at 1,000 seats, slot pin, invariants) and the sidecar suites |

The Windows half of the checklist cannot run here; `../packaging/WINDOWS-TEST.md` is the script
for a real Windows 10/11 PC.
