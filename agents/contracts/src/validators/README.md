# Validator hub (Step 1: validator nodes)

Contracts for Ferminux validator seats: anyone deposits 2,000 FMX per seat, runs a validator node
on a Windows PC or a Linux server, and signs a checkpoint statement every 200 blocks. When enough
seats sign the same block, the checkpoint is **certified**.

Ferminux uses proof-of-authority consensus. Step 1 changes nothing in consensus: blocks are still
confirmed by the foundation signers. Validator seats check blocks and sign checkpoints; they do
not produce or order blocks. The source of truth for every rule below is the owner-approved plan
(`PLAN.md`, "Ferminux open validators"); section numbers refer to it.

| File | What it is |
|---|---|
| `ValidatorHub.sol` | Seats, deposits, keys, attestations, certification, rewards, jail, exit, slashing, the Step 2 storage slots. Holds all the FMX. |
| `SinkRouter.sol` | Takes ownership of FMXRewardSink and forwards 40% of its inflow to the hub (plan 5.2). |
| `ValidatorHubLens.sol` | Read-only views decoded from the hub's storage (seat, slash, enode, totals, Step 2 slots, election preview, runway). Holds nothing; nothing trusts it. |
| `HeaderRLP.sol` | `HeaderRLP` (reads parentHash and number from a header RLP) and `SealEvidence`, a stateless checker the hub deploys in its own constructor. |

All four are solc 0.8.24, `evm_version = paris` (no PUSH0), optimizer 200, no OpenZeppelin, no
upgradeability, no delegatecall, no selfdestruct (plan 5).

## Parameters

Durations are in blocks at the chain's 7-second period: 12,343 blocks = 24 h, 86,400 blocks =
7 days. The signers never confirm blocks faster than the period, so a block window is never
shorter in wall time than the days it stands for, and it cannot run out while the chain is
halted (a veto window, for example, does not expire during an outage).

| Parameter | Value | Enforced by | Plan |
|---|---|---|---|
| Seat deposit | exactly 2,000 FMX (`msg.value == 2000 ether`) | `openSeat` | 3.1 |
| Seats at launch | `maxSeats = 100` | constructor | 3.1, 13.4 |
| Seats cap during the first 30 days | at most 100 until deploy + 370,286 blocks | `queueParam`/`applyParam` | 3.1 ("300 after 30 clean days") |
| Seats after that | raised by timelock (300 planned); never below seats in use | timelock | 3.1 |
| Hard ceiling | 1,000 seats | timelock | 3.1 |
| Activations per day | 10 (day = 12,343 blocks), raisable by timelock to 50 | activation queue | 3.1 |
| Activation | 24 h (12,343 blocks) after deposit, in the next day bucket with room | `openSeat` | 3.1 |
| Counts for certification | 7 days (86,400 blocks) after activation | eligibility cursor | 3.1 |
| Checkpoint | every height h with h % 200 == 0 | `attest` | 3.2 |
| Inclusion window | `block.number` in [h+64, h+250], and `blockhash(h) == blockHash` | `attest` | 3.2 |
| Certified | at least 30 eligible seats **and** count >= max(20, ceil(2/3 x eligible)); eligible is snapshotted at the first accepted attestation | `certifies`, `attest` | 3.2 |
| Reward | 0.025 FMX per accepted attestation | `rewardPerAttest` | 3.2, 8, 13.3 |
| Reward ceiling | 0.05 FMX | timelock | 5.1 |
| Halving | reward and budget halve at block 4,500,000 or at V, whichever comes first (0.025 -> 0.0125) | `currentRewardPerAttest` | 4.6, 13.3 |
| Budget guard | maxSeats x rewardPerAttest <= 7.5 FMX per checkpoint (3.75 after the halving) | timelock and every payout | 5.1, 8 |
| Empty pool | a reward moves to a seat only if the pool covers all of it; otherwise the attestation counts and earns 0 | `attest` | 5.1 |
| Starting tranche | 20,000 FMX from FMXRewardSink (a multisig transaction, not a contract rule) | operator | 5.2, 13.3 |
| Router share | 40% of sink inflow to the hub, the rest to the multisig reserve; timelocked; hard cap 50% | `SinkRouter` | 5.2, 13.3 |
| Pool trim | unallocated FMX beyond 180 days of maximum spend (11,109 checkpoints) goes back to the sink | `returnExcess` | 5.1 |
| Jail | fewer than 50% of the last 124 closed checkpoints attested, with the seat on duty for the whole window | `jail` (permissionless) | 3.3 |
| Unjail | by the seat owner, 24 h (12,343 blocks) after jailing; participation is measured afresh | `unjail` | 3.3 |
| Downtime | never costs deposit | no code path | 3.3 |
| Unbonding | 14 days (172,800 blocks) | `requestExit`, `withdraw` | 3.3 |
| Slash | 10% of the deposit (200 FMX) for a double attestation; one slash per seat | `proveDoubleAttestation` | 3.4 |
| Slash split | 10% of the slash (20 FMX) to the reporter, the rest (180 FMX) to 0x000000000000000000000000000000000000dEaD | `executeSlash` | 3.4 |
| Slash window | 48 h (24,686 blocks) before `executeSlash` (permissionless) | `executeSlash` | 3.4 |
| Replaced key as evidence | 14 days (172,800 blocks) after it is replaced (attester rotation applied or superseded, signing key replaced); a key taken out by exit or slash is bounded by the seat's own unbond | `proveDoubleAttestation`, `proveDoubleSeal` | 3.3, 3.4 |
| Veto | multisig only, only inside the window, never starts or enlarges a slash | `veto` | 3.4 |
| Veto sunset | deploy + 180 days (2,221,715 blocks), fixed at deploy as `vetoSunsetBlock`; for Step 2 header evidence, V + 180 days | `veto` | 3.4, 4.7 |
| Timelock | 48 h (24,686 blocks) on every parameter | `queueParam`/`applyParam` | 5 |
| Owner | the foundation multisig 0x910BD467D8576277f8f96DF47428377FFD94fEfe, pinned and re-checked by the mainnet script | constructor | 5 |
| Deny list | the five genesis premine wallets, the multisig and the sink (mainnet script); changes by timelock | `openSeat` | 3.1 |
| Participation ring | 512 checkpoints per seat | `attest` | 3.3 |
| Step 2 qualify | 30 days active (370,286 blocks), >= 90% of the last 432 checkpoints, not jailed or exiting, no slash, a signing key set | `qualify` | 5.1 |
| Step 2 disqualify | below 50% over 124 checkpoints (anyone, not while attestations are paused), or the owner at will; exit, jail and slash do it automatically | `disqualify` | 5.1 |
| Step 2 candidates | at most 1,000 signing keys in slot 0 | `qualify` | 4.4, 5.1 |
| V (`openSeatsBlock`) | set once by timelock, a multiple of 30,000 in the future | timelock | 4.7, 6.2 |
| Community-seat switch | clearing is instant; setting needs the 48 h timelock | `closeCommunitySeats`, timelock | 4.7, 5.1 |

Maximum value held: 200,000 FMX at 100 seats, 600,000 at 300, 2,000,000 at the 1,000 ceiling
(plan 5.1).

## Attestations: signature-based, anyone submits

`attest(h, blockHash, sig)` and `attestBatch(h, blockHash, sigs)` take a typed structured-data
signature (the EIP-712 encoding) of `Attestation(uint64 height, bytes32 blockHash)` in the domain
`{"Ferminux Validator Hub", "1", chainId, hub}` (plan 3.2). Anyone may submit it: the node itself,
the free gateway relay, or anyone else.

This is the safer design than a `msg.sender`-based `attest(h, hash)`:

- **One statement type.** The exact object that counts toward certification is the exact object
  that is slashable. Double-attestation evidence is two of these signatures, checked on-chain.
  With `msg.sender` attestations, evidence would have to include raw signed transactions (RLP
  parsing, fee fields, per-type encodings) or a second message format.
- **The hot key holds no FMX.** The attester key on the PC never has to send a transaction, so a
  stolen PC loses no gas money, and there is no gas balance to watch. `claimToAttester` still
  exists for owners who prefer self-submission.
- **Batching.** One relay transaction per checkpoint carries every seat: the checkpoint check,
  the eligibility sync, the reward rate and the checkpoint write are paid once, not per seat.
  Steady state costs about 24,800 gas per attestation in a batch. `ecrecover` is about 3,000 of
  that; a `msg.sender` design would save only that and lose the batching.
- **Replay-safe.** The chain id and hub address are in every digest, so a signature for the public
  testnet or another hub never counts here. The lab runs a copy of mainnet with the same chain id
  (3961, network id 39610), so only the hub address keeps lab signatures apart: the testnet
  script creates the lab hub from inside `LabHubDeployer`, whose address can never equal a hub
  created directly from a key, as the mainnet script does (a lab rehearsal from the mainnet
  deployer key at the same nonce would otherwise land on the mainnet hub's address). Never run
  the mainnet script on the lab.

A bad, unknown, inactive or duplicate signature inside a batch is skipped (so a front-run
duplicate cannot sink a relay's batch); a wrong block hash or a height outside the window reverts
the whole call.

## Keys and the messages they sign

Each seat has an owner (the cold wallet that deposited: only it can claim, exit, withdraw, unjail
or change keys) and hot keys that are bound to that one seat for ever and never reused, so old
evidence always finds its seat. A replaced key stays evidence for 14 days after it is replaced
(the same exposure as an exit), then it is retired: an old key left on a sold or decommissioned
PC can no longer slash the seat (`ValidatorHubLens.keyRetiredAt`). Every message below carries the chain id and the hub address, so
a signature made for one network or hub never counts on another; the node software keeps one key
set per network.

| Key | Signs | Digest |
|---|---|---|
| Attester | checkpoints | typed data `Attestation(uint64 height,bytes32 blockHash)` |
| Attester (registration) | proof of possession, at `openSeat` and `rotateAttester` | typed data `AttesterKey(address owner,address attester)` |
| Node (devp2p) key | proof of possession of the 64-byte enode public key | `keccak256("FMX_VALIDATOR_NODE_V1", chainid, hub, owner, attester)` (the NodeRegistry pattern) |
| Step 2 signing key | proof of possession | `keccak256("FERMINUX-SIGNKEY-V1", chainid, hub, seatId, key, owner)` (plan 5.1) |

A queued attester rotation takes effect after 24 h (`applyAttesterRotation`, permissionless); the
old key keeps attesting until then. Block headers carry no chain id, so for the Step 2 signing
key "one key per network" is enforced by the node software, not by this contract.

## Money

- **Deposits** leave the hub only through `withdraw` (the seat owner, once, after the 14-day
  unbond, never while a slash is pending) or through an executed slash. The owner has no
  function that touches a deposit.
- **Rewards** come only from `fund()` / plain transfers (the sink tranche, SinkRouter). A reward
  moves to a seat only if the pool covers it. `claim` and `claimToAttester` pay out.
- **Slashes** credit 10% to the reporter (`withdrawCredit`) and send the rest to 0x...dEaD. If
  that transfer ever failed, the amount is parked in `pendingBurn` and `flushBurn()` retries.

Conservation, checked by the invariant tests on every randomised run:

```
totalDeposited = sum of seat deposits + totalSlashed + totalWithdrawn
hub balance    = bondedTotal + rewardPool + totalClaimable + totalCredits + pendingBurn
totalFunded    = rewardPool + totalClaimable + totalClaimed + totalReturned    (allocated <= funded)
totalSlashed   = reporter credits (paid or not) + totalBurned + pendingBurn
```

## What the owner (the multisig) can and cannot do

Can, at once: pause new seats (`setSeatsPaused`); pause attestations in an emergency
(`setAttestationsPaused`: nobody can be jailed, or disqualified by anyone but its owner, while paused, and participation is measured afresh
from the next checkpoint for every seat on resume); clear the community-seat switch; veto a slash
inside its window until the sunset. Can, by 48 h timelock and within the hard caps: maxSeats,
rewardPerAttest, activations per day, the deny list, V (once), setting the community-seat switch.

Cannot: move or freeze a deposit, pause exits, withdrawals, claims, evidence or slash execution,
start or enlarge a slash, change the slash size, the unbond or any window, or upgrade the code.

## Step 2 storage (read by the node engine from block V)

Declared first, never packed, pinned by `vm.load` in `ValidatorHubStep2.t.sol` (plan 5.1). They
are live and written from day one; the engine ignores them before V.

| Slot | Variable | Meaning |
|---|---|---|
| 0 | `address[] _signingKeys` | signing keys of qualified seats (<= 1,000, swap-and-pop) |
| 1 | `mapping(address => uint256) _countedBond` | 2,000e18 while qualified and bonded, else 0 |
| 2 | `mapping(address => uint256) _qualifiedAt` | block when qualified |
| 3 | `mapping(address => address) _rewardTo` | payee for signing rewards (the owner unless set) |
| 4 | `mapping(address => uint256) _jail` | engine-owned: jailedUntil (bits 0-63), offences (64-95), lastOffence (96-159); never written here |
| 5 | `uint256 _flags` | bit 0 = communitySeatsOpen |

`proveDoubleSeal(preimageA, sigA, preimageB, sigB)` (the name follows the Clique `Seal()` method)
is the Step 2 double-sign evidence: two different headers with the same number and parent,
signed by one registered signing key. It is inert until V is set, and only accepts headers at or
above V. `electablePreview(n)` in the lens mirrors the engine's `Elect` (plan 4.4) except the
"key not in F" rule, which needs the header chain.

## Choices made where the plan left room

1. **Location.** The plan names `staking/contracts/src/`; this lane builds in
   `agents/contracts/src/validators/` with the other Ferminux Foundry contracts and CI.
2. **24 KB.** With every Step 1 and Step 2 function the hub came to 30 KB. Rather than the plan's
   fallback of moving the attestation book and rewards into a separate CheckpointBook (which
   would split money logic across two contracts and put a cross-contract call in the
   attestation loop), the read-only views moved to `ValidatorHubLens` (through a raw
   `extsload`) and the RLP parser to `SealEvidence`, which the hub deploys itself. All FMX and all
   state-changing logic stay in one 23,673-byte contract.
3. **Halving is automatic.** The plan says the rate "drops by timelock" at V or 4.5M; the hub
   halves the effective rate and the budget itself at that block, so nobody has to remember. The
   owner can still lower the base rate by timelock.
4. **Pauses are instant**, since a timelocked emergency pause is no pause. Besides pausing new
   seats (plan 5.1) the owner can pause attestations; nobody can be jailed meanwhile and duty
   restarts for everyone on resume. Exits, withdrawals, claims, evidence and slash execution can
   never be paused.
5. **The 30-day launch cap is on-chain**: `maxSeats` cannot exceed 100 before deploy + 30 days.
6. **Evidence is limited to checkpoint heights** (h % 200 == 0), the only heights the node signs.
7. **A vetoed slash does not reinstate the seat**: the seat stays in its unbond and its keys stay
   banned; the owner withdraws the full deposit and may open a new seat.
8. **One slash per seat.** After an executed slash the seat is out; further evidence against it is
   refused. After a veto, different evidence can start a new slash.
9. **Replaced keys retire after one unbond.** A signature can name any height, so bounding old
   evidence by height would not help; bounding it in time does. Rotation is therefore a real
   remedy for a leaked key once 14 days have passed, as exiting is.

## Gas at 1,000 seats (`ValidatorHubGas.t.sol`, cold storage)

| Operation | Gas |
|---|---:|
| `attestBatch`, 1,000 attestations in one transaction (steady state) | 24,786,645 |
| per attestation in a batch | ~24,800 |
| `attestBatch`, 10 transactions of 100 (sum; largest 2,534,198) | 25,259,881 |
| every seat's first-ever attestation at once (one-time: each ring word goes from zero to non-zero, about 17k more per seat) | 41,707,507 |
| average per block over the 187-block inclusion window | 132,548 (0.13% of the 100M block gas limit) |
| `attest()` alone: first of a checkpoint / later | 127,039 / 83,868 |
| `openSeat` | ~197,000 |
| `jail` | ~25,000 |
| `sync` of 1,000 newly eligible seats in one call | 7,690,895 |
| lens `electablePreview` with 1,000 candidates (eth_call) | 14,819,879 |

## Build, test, check

```sh
cd agents/contracts
forge build --sizes                  # ValidatorHub 23,673 B, lens 7,062, router 3,732, SealEvidence 1,601
forge test --match-path "test/validators/*"
forge test --match-path "test/validators/ValidatorHubGas.t.sol" -vv    # prints the gas table

# no PUSH0 anywhere in the runtime code (also asserted in ValidatorBytecode.t.sol)
forge inspect ValidatorHub deployedBytecode | cast disassemble | grep -c PUSH0   # 0
```

`test/validators/utils/FMXRewardSink.sol` is a symlink to `contracts/src/FMXRewardSink.sol`, so
the tests and the testnet script run against the real sink.

## Deploy

- **Devnet, lab, public testnet**: `script/DeployValidatorsTestnet.s.sol`. It deploys a fresh
  FMXRewardSink unless `SINK` is given, then the hub, lens and router. It refuses chain id 3961
  unless `LAB=true` and `OWNER` is a lab key (the lab shares mainnet's chain id); on the lab it
  creates the hub through `LabHubDeployer` (see "Replay-safe" above) and writes
  `deployments-validators.lab.json`, never a 3961 file.
- **Mainnet**: `script/DeployValidatorsMainnet.s.sol`, run by the operator by hand only (never by
  CI, tooling or an agent), after the plan 9 gates: phase 0 exit criteria, the 10.1 lab checklist,
  the testnet run, the external audit and the 7-day notice. It needs `CONFIRM_MAINNET`, deploys
  the hub with the multisig as owner, FMXRewardSink as sink and the deny list, then prints the
  multisig's next step (`sink.withdraw(hub, 20000 ether)` after checking the sink balance). After
  30 clean days, `ROUTER=true HUB=<hub>` deploys SinkRouter; the multisig then calls
  `sink.transferOwnership(router)` and `router.acceptSinkOwnership()`.
