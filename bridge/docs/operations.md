# Ferminux Bridge — Operations runbook

Everything required to launch, run, watch and rescue the bridge. Written to be
followed at 03:00 by someone who did not build it.

Read [security-model.md](security-model.md) first. This document assumes you
have accepted those trust assumptions and are now responsible for keeping the
loss inside the bounds it describes.

**Command conventions.** `$BRIDGE_A` / `$BRIDGE_B` are the bridge addresses on
the two chains, `$RPC_A` / `$RPC_B` their endpoints, `$MSIG` the owner multisig
on that chain. Ferminux public RPC is `https://rpc.ferminux.net`, explorer
`https://explorer.ferminux.net`. Every command below is `cast` / `forge` against
the contracts as shipped; nothing requires a private API.

---

## 1. Roles and custody

Six roles. **They must be six different key holders.** Collapsing any two of
them collapses a control.

| Role | Key type | Powers | Must be |
|---|---|---|---|
| **Owner** | multisig (2-of-3 minimum) | everything privileged: `queue`/`executeAction`/`cancelAction`, `unpause`, `unpauseToken`, `decreaseTokenLimits`, `setPauser`, `rescue`, `cancelOwnershipTransfer`, `adoptWrapper`. `transferOwnership` is timelocked like every other enlarging change | **A multisig. Never an EOA.** On Ferminux: `MinimalMultisig 0x910BD467D8576277f8f96DF47428377FFD94fEfe` |
| **Validator 1..N** | EOA, hot signing key | attest to transfers. **No admin powers whatsoever** | Separate machine, separate custodian, separate everything |
| **Pauser** | EOA, hot | `pause()`, `pauseToken()` and nothing else | A machine monitored 24/7, reachable in under 5 minutes |
| **Submitter (relayer)** | EOA, hot, gas-funded | calls `execute()` — permissionless, holds no privilege | Can be anyone; run your own so users are not hostage to one |
| **Fee collector** | multisig | receives `withdrawFees()` | Treasury multisig, not an EOA |
| **Deployer** | EOA, one-shot | deploys contracts, then has no role | Burn after use; it is *not* the owner |

**The pauser key is not a security key, it is a safety key.** Losing it is an
availability incident. It cannot steal, cannot unpause, cannot change config.
Give it to more than one person (`setPauser` is instant and takes any number of
addresses) rather than risk nobody being awake.

Record, in a place that is not this repository:

- who holds each key, their phone number, and their backup person
- who is authorised to pull `pause()` without asking anyone (answer: everyone
  with the key, always, no approval needed — see [§7](#7-pauseunpause-decision-tree))
- where each multisig signer's hardware wallet physically is

---

## 2. Pre-launch checklist

Work top to bottom. Do not skip the dry runs — every line here exists because
skipping it has cost somebody a bridge.

### Code

- [ ] `forge test` is **289/289 green** on the exact commit being deployed
      (`cd bridge/contracts && forge test`)
- [ ] `forge build --sizes` shows `FerminuxBridge` at **21,346 B runtime**,
      inside the 24,576 B limit (margin 3,230 B) and `BridgeToken` at 3,864 B
- [ ] `foundry.toml` still says `evm_version = "paris"` and `solc = "0.8.24"`.
      **Ferminux-geth forks geth v1.10.26 and has no `PUSH0`** — Shanghai
      bytecode bricks on chain 3961
- [ ] `bash script/devnet-e2e.sh` passes against two local anvils, with the
      **real remote chain id** substituted for `CHAIN_B`
- [ ] The relayer's own tests pass (`cd bridge/relayer && npm test`), and its
      `check` role reports a healthy config against both RPCs
      (`npm run check`) — see `bridge/relayer/README.md` for its flags

### Keys and parameters (these are constructor arguments — decide first)

- [ ] `BRIDGE_OWNER` is a deployed, tested multisig **on each chain**. Prove it
      by executing one harmless transaction through it before it owns anything
- [ ] Three validator addresses from the ceremony in [§3](#3-validator-key-generation-ceremony)
- [ ] `BRIDGE_THRESHOLD=2` (of 3). Higher if you have more validators ready
- [ ] `BRIDGE_PAUSER` set, on a monitored host, key not shared with a validator
- [ ] `FEE_COLLECTOR` = treasury multisig
- [ ] `FEE_BPS=10` (0.10 %). Ceiling is `MAX_FEE_BPS = 100`
- [ ] `TIMELOCK_DELAY=172800` (48 h). Anything shorter needs a written reason
      and a named person who signed off. Contract minimum is 1 h, maximum 30 d

### Operational readiness

- [ ] Monitoring is live **before** the first token is registered ([§6](#6-monitoring-what-actually-matters))
- [ ] Alert routing tested end to end — someone's phone actually rang
- [ ] Incident playbooks in [§8](#8-incident-response) have been read aloud by
      whoever is on call
- [ ] Confirmation depths configured per chain and written down
      ([security-model.md §5](security-model.md#5-reorg-risk-per-chain))
- [ ] The Ferminux hashrate-vs-cap inequality has been computed with today's
      hashrate and today's FMX price, and the cap satisfies it
- [ ] A status page or channel exists where a pause can be announced within
      minutes

---

## 3. Validator key generation ceremony

The single most consequential hour of the launch. Ronin lost $624 M because the
validator keys were not actually independent. **Do not compress this.**

### Non-negotiable rules, stated plainly

1. **Three separate people.** Not three keys held by one person. Not three keys
   in one password manager. Three humans who can each refuse to sign.
2. **Three separate machines.** Not three VMs on one host. Not three containers.
   Not three cloud instances in one account — one compromised cloud credential
   is one compromised validator set.
3. **Three separate networks and providers.** Different hosting providers,
   different regions, ideally different countries.
4. **No shared backup.** No shared secret store, no shared 1Password vault, no
   shared S3 bucket, no shared operator laptop.
5. **The key never leaves the machine that generated it.** Not once, not to
   copy it "somewhere safe", not over Signal.

If any of these is violated, write it down as an accepted risk and describe the
bridge accordingly. A 2-of-3 where one person holds all three keys is a 1-of-1
multisig with extra steps, and users deserve to be told.

### Per validator, on the validator's own machine

```sh
# 1. offline / freshly-provisioned host, no clipboard managers, no screen share
cast wallet new
# -> Address:     0x....
# -> Private key: 0x....
```

```sh
# 2. store the key where only the daemon can read it
umask 077
printf '%s' "0x<privkey>" > /etc/ferminux-bridge/validator.key
chown bridge:bridge /etc/ferminux-bridge/validator.key
chmod 400 /etc/ferminux-bridge/validator.key
```

```sh
# 3. prove the key controls the address, on this machine only
cast wallet address --private-key "$(cat /etc/ferminux-bridge/validator.key)"
```

```sh
# 4. sign a ceremony attestation and publish ONLY the signature and address
cast wallet sign "ferminux-bridge validator ceremony 2026-08-20 host=<hostname>" \
  --private-key "$(cat /etc/ferminux-bridge/validator.key)"
```

Each validator sends the coordinator **only** the address and that signature.
The coordinator verifies each with `cast wallet verify` and records:

| Field | Example |
|---|---|
| Validator address | `0x…` |
| Custodian (person) | full name, contact, backup contact |
| Host | provider, region, hostname |
| Generated | date, by whom, on what machine |
| Attestation signature | `0x…` |
| Backup method | e.g. metal seed plate in bank box #, **not** shared with any other validator |

Keep that record off-repo, with the multisig signer register.

### Hardening the validator host

- No inbound ports except SSH from a bastion; the daemon only makes **outbound**
  RPC calls
- The daemon runs as an unprivileged user with the key file `400`
- The daemon pins the bridge **address and `DOMAIN_SEPARATOR()` on both chains
  in config**. A validator that will sign against an unpinned bridge address can
  be phished into signing for an attacker's deployment
- It recomputes `transferId` and the EIP-712 digest **locally** from the `Sent`
  log and compares against the chain — never signs a digest handed to it by a
  relayer
- It refuses to sign anything before the configured confirmation depth
- It refuses to sign any source event **older than the migration block**, if the
  bridge has ever been migrated
  ([security-model.md §6](security-model.md#6-contract-level-risk))
- Log every signature produced, with `transferId`, to an append-only log

### Rehearse the loss of one key before launch

Generate a **fourth** key, run the whole "rotate a validator" procedure from
[§9](#9-validator-rotation) against a devnet, and time it. If it takes longer
than 48 h + your own coordination time, fix that now, not during an incident.

---

## 4. Deployment order and registering token pairs

Order matters. Deploy both sides before registering anything, because
registration names the other side.

### 4.1 Deploy the bridge on each chain

```sh
cd <repo>/bridge/contracts

DEPLOYER_KEY=0x…            \
BRIDGE_OWNER=0x…            \
FEE_COLLECTOR=0x…           \
BRIDGE_VALIDATOR1=0x…       \
BRIDGE_VALIDATOR2=0x…       \
BRIDGE_VALIDATOR3=0x…       \
BRIDGE_THRESHOLD=2          \
FEE_BPS=10                  \
TIMELOCK_DELAY=172800       \
BRIDGE_PAUSER=0x…           \
  forge script script/DeployBridge.s.sol --rpc-url $RPC_A --broadcast
```

Repeat with `--rpc-url $RPC_B`. The script prints every parameter plus
`DOMAIN_SEPARATOR()` — **record both addresses and both domain separators**;
the validators must pin them.

Verify the deployment before going further:

```sh
cast call $BRIDGE_A "owner()(address)"          --rpc-url $RPC_A
cast call $BRIDGE_A "threshold()(uint256)"      --rpc-url $RPC_A
cast call $BRIDGE_A "getValidators()(address[])" --rpc-url $RPC_A
cast call $BRIDGE_A "timelockDelay()(uint64)"   --rpc-url $RPC_A
cast call $BRIDGE_A "feeBps()(uint256)"         --rpc-url $RPC_A
cast call $BRIDGE_A "feeCollector()(address)"   --rpc-url $RPC_A
cast call $BRIDGE_A "isPauser(address)(bool)" $PAUSER --rpc-url $RPC_A
cast call $BRIDGE_A "paused()(bool)"            --rpc-url $RPC_A
```

Every one of those must match what you intended. A wrong `owner` is
unrecoverable in practice — redeploy rather than live with it.

### 4.2 Deploy the wrapper for each asset canonical on the other side

```sh
DEPLOYER_KEY=0x… BRIDGE=$BRIDGE_B \
WRAPPED_NAME="Wrapped FMX" WRAPPED_SYMBOL=wFMX WRAPPED_DECIMALS=18 \
ORIGIN_CHAIN_ID=3961 ORIGIN_TOKEN=0x0000000000000000000000000000000000000000 \
  forge script script/DeployWrappedToken.s.sol --rpc-url $RPC_B --broadcast
```

**`WRAPPED_DECIMALS` must mirror the origin asset exactly.** FMX is 18. **AZNT
is 6** — a wrapper deployed at 18 for AZNT mis-prices every transfer by a factor
of 10¹². `BridgeToken` refuses anything above 18 (`WTOKEN: decimals`); an origin
asset with more decimals than that simply cannot be bridged by this design.

Check the wrapper before registering it:

```sh
cast call $WFMX "bridge()(address)"        --rpc-url $RPC_B   # == $BRIDGE_B
cast call $WFMX "originChainId()(uint64)"  --rpc-url $RPC_B   # == 3961
cast call $WFMX "originToken()(address)"   --rpc-url $RPC_B
cast call $WFMX "decimals()(uint8)"        --rpc-url $RPC_B
cast call $WFMX "totalSupply()(uint256)"   --rpc-url $RPC_B   # == 0
```

### 4.3 Register the pair — the mirror must be exact

For every route, the two registrations are mirror images:

| | chain A (home) | chain B (away) |
|---|---|---|
| `localToken` | `X` (`0x0` for the native coin) | `wX` |
| kind | `CANONICAL` | `WRAPPED` |
| `remoteChainId` | B | A |
| `remoteToken` | `wX` | `X` |
| `maxPerTransfer` | see [§5](#5-setting-caps-for-a-launch) | same value |
| `dailyCap` | see [§5](#5-setting-caps-for-a-launch) | same value |

If they do not mirror, the route is simply dead: `execute()` reverts with
`BRIDGE: token mismatch` or `BRIDGE: bad src chain`. Funds are not at risk, but
transfers strand. **Registration is once-only** (`BRIDGE: already registered`) —
a mis-registered token is handled with `pauseToken()`, never by retargeting.

Registration is timelocked, so it is always two transactions 48 h apart.

**Before the first WRAPPED registration on a chain, pin the wrapper bytecode.**
`registerWrapped` fails closed with `BRIDGE: wrapper pin unset` until
`bridgeTokenCodehash` is set, and then accepts only wrappers whose runtime code
hashes to it. Every `BridgeToken` deployment shares that codehash (the contract
has no immutables), so one pin covers every wrapper on the chain:

```sh
BRIDGE=$BRIDGE TOKEN_KIND=pin forge script script/RegisterToken.s.sol \
  --rpc-url $RPC   # queue; execute 48 h later with ACTION=execute ACTION_ID=<id>
```

Changing the pin later is itself timelocked, so adopting a different wrapper
implementation costs its own public 48 h announcement.

**Queue** (prints the calldata for the multisig):

```sh
BRIDGE=$BRIDGE_A ACTION=queue TOKEN_KIND=canonical \
LOCAL_TOKEN=0x0000000000000000000000000000000000000000 \
REMOTE_CHAIN_ID=56 REMOTE_TOKEN=$WFMX \
MAX_PER_TRANSFER=5000000000000000000000 \
DAILY_CAP=25000000000000000000000 \
  forge script script/RegisterToken.s.sol --rpc-url $RPC_A
```

With no `OWNER_KEY` the script broadcasts nothing and prints the calldata for
`bridge.queue(bytes)`. Drive the multisig with it:

```sh
# propose (auto-confirms the proposer)
cast send $MSIG "submit(address,uint256,bytes)" $BRIDGE_A 0 <queue-calldata> \
  --private-key $SIGNER1_KEY --rpc-url $RPC_A

# second signer confirms, then anyone with an owner key executes
cast send $MSIG "confirm(uint256)" $TXID --private-key $SIGNER2_KEY --rpc-url $RPC_A
cast send $MSIG "execute(uint256)" $TXID --private-key $SIGNER2_KEY --rpc-url $RPC_A
```

Find the action id (the return value is not visible through the multisig):

```sh
cast call $BRIDGE_A "actionCount()(uint256)" --rpc-url $RPC_A     # id = count - 1
cast call $BRIDGE_A "getAction(uint256)(bytes,uint64,bool,bool)" $ACTION_ID --rpc-url $RPC_A
```

**Use the 48 hours.** Publish the action id, the decoded calldata and the eta so
users and validators can audit what is about to change. A timelock nobody reads
is just a delay.

**Execute**, after the eta:

```sh
BRIDGE=$BRIDGE_A ACTION=execute ACTION_ID=$ACTION_ID \
  forge script script/RegisterToken.s.sol --rpc-url $RPC_A
# then submit the printed executeAction calldata through the multisig
```

Reverts to expect: `BRIDGE: timelock not elapsed` (too early),
`BRIDGE: action stale` (more than `GRACE_PERIOD = 72 hours` past the eta —
re-queue it), `BRIDGE: action canceled`.

Mirror the whole procedure on chain B with `TOKEN_KIND=wrapped` and
`LOCAL_TOKEN=$WFMX`.

### 4.4 Confirm the route before announcing it

```sh
cast call $BRIDGE_A "tokenConfig(address)((uint8,bool,uint64,address,uint256,uint256))" \
  0x0000000000000000000000000000000000000000 --rpc-url $RPC_A
cast call $BRIDGE_B "tokenConfig(address)((uint8,bool,uint64,address,uint256,uint256))" \
  $WFMX --rpc-url $RPC_B
```

`kind` is `1 = CANONICAL`, `2 = WRAPPED` (`0 = UNREGISTERED`). Check the mirror
by eye, field by field, both directions.

---

## 5. Setting caps for a launch

### The rule

> **A cap is a statement about what you can afford to lose in a day. Size it
> against 2 × the number, because the first 24 hours from an empty bucket allow
> 2 × `dailyCap`** ([security-model.md §3](security-model.md#3-what-m-colluding-validators-can-do)).

And on the Ferminux side, the cap must additionally satisfy the reorg
inequality: `2 × dailyCap` in USD must be clearly **less** than the cost of
renting enough Ethash hashrate to reorg your confirmation depth.

Cap increases take **48 h**. Cap decreases are **instant**. Erring small is
free; erring large is not. Plan the ramp before launch so the 48 h waits are
already in the calendar.

### Recommended opening numbers

FMX reference price $0.53; AZNT is 1:1 with AZN (~$0.59) and has **6 decimals**.

| Phase | Gate to advance | `maxPerTransfer` | `dailyCap` | Day-1 exposure (2× both sides) |
|---|---|---|---|---|
| **Day 0 — smoke** | you have not moved anything yet | 100 FMX (`100e18`) | 500 FMX (`500e18`) | ~$1.1 k |
| **Week 1 — launch** | smoke passed both directions, monitoring firing correctly, pause drill done on mainnet | **5,000 FMX** (`5000e18`) | **25,000 FMX** (`25000e18`) | ~$53 k |
| **Week 2–4** | two clean weeks, zero unexplained events, fee sweep exercised | 10,000 FMX | 50,000 FMX | ~$106 k |
| **Month 2+** | one clean month, validator rotation rehearsed on mainnet | 25,000 FMX | 150,000 FMX | ~$318 k |
| **Beyond** | **external audit complete AND validator set at 3-of-5** | by treasury decision | by treasury decision | — |

Stablecoin route (AZNT, 6 decimals — note the unit sizes):

| Phase | `maxPerTransfer` | `dailyCap` |
|---|---|---|
| Day 0 — smoke | 100 AZNT (`100000000`) | 500 AZNT (`500000000`) |
| Week 1 | 5,000 AZNT (`5000000000`) | 25,000 AZNT (`25000000000`) |
| Week 2–4 | 10,000 AZNT (`10000000000`) | 50,000 AZNT (`50000000000`) |

**Do not advance a phase because volume demands it. Advance because the gate is
met.** Demand for a higher cap is the same signal an attacker would send.

### The other number to weigh: what it costs to deny the route

Both 24 h buckets are shared, first-come, and not per-sender. One actor can hold
**both** of them at the cap by round-tripping their own capital — the outbound
leg on chain A is exactly what fills the inbound bucket on chain A when the same
value comes home. The route is then shut in both directions for everyone else.

> **cost to deny a route for a day = 2 × `feeBps` × `dailyCap`**
> capital required = one `dailyCap`, fully recoverable.

At the default 10 bps that is **0.2 % of one `dailyCap` per day**:

| Phase | `dailyCap` | Capital tied up | Cost per day of lockout |
|---|---|---|---|
| Day 0 — smoke | 500 FMX | ~$265 | ~$0.53 |
| Week 1 — launch | 25,000 FMX | ~$13,250 | ~$26 |
| Week 2–4 | 50,000 FMX | ~$26,500 | ~$53 |
| Month 2+ | 150,000 FMX | ~$79,500 | ~$159 |

Note the shape: the attack is **cheapest when the route is newest**, because the
cost scales with the cap. Weigh this alongside the reorg inequality and the 2×
loss budget when sizing — a cap small enough to be safe is also a cap cheap
enough to block.

There is no clean on-chain fix (per-sender buckets are sybil-farmable; a priority
queue is not something to invent inside a bridge), so treat it as an operating
parameter:

1. size caps knowing the number above;
2. alert on the signature — both buckets > 80 % with one dominant counterparty
   (see [§6](#6-monitoring-what-actually-matters));
3. the response lever is `setFeeBps` toward `MAX_FEE_BPS = 100`, which multiplies
   the griefer's cost tenfold. It is **global, not per-token, and timelocked 48 h**,
   so it is a deterrent to pre-position, *not* an incident response. `pauseToken`
   does not help: it closes the route rather than reopening it.

### Raising a cap

```sh
cast calldata "setTokenLimits(address,uint256,uint256)" $TOKEN $NEW_MAX $NEW_DAILY
# wrap it: cast calldata "queue(bytes)" <that>, submit through the multisig,
# wait 48 h, then executeAction through the multisig
```

Raise **both sides of a route together**, and land them within the same hour —
asymmetric caps mean transfers that leave successfully and cannot arrive.

### Lowering a cap (instant, no timelock)

```sh
cast calldata "decreaseTokenLimits(address,uint256,uint256)" $TOKEN $NEW_MAX $NEW_DAILY
# submit through the multisig — takes effect immediately
```

Both values must be **less than or equal** to the current ones or it reverts
with `BRIDGE: not a decrease`. Remember: undoing a decrease is a 48 h
`setTokenLimits`. If you want a brake you can release quickly, use
`pauseToken()` instead.

---

## 6. Monitoring what actually matters

Ronin's loss was not caused by weak monitoring alone, but six days of silence
turned a breach into a catastrophe. **The alerts below are the product.**

### The one alert that matters most

> **An `Executed` event on one chain with no matching `Sent` on the other.**

That is a fraudulent transfer, by definition — a quorum signed something that
never happened, or a verification bug was exploited. There is no benign
explanation. **Page immediately, and pause first, investigate second.**

Reconciliation loop, run continuously: for every `Executed(transferId, …)` on
chain B, a `Sent` with the same `transferId` must exist on chain A at a block
older than the confirmation depth. Any exception is a P1.

### Alert table

| Signal | Severity | Threshold | Action |
|---|---|---|---|
| `Executed` with no matching `Sent` | **P1** | any | `pause()` both chains now |
| `lockedBalance(token)` < wrapped `totalSupply()` | **P1** | any | `pause()` — undercollateralized |
| Source-chain reorg deeper than the confirmation depth | **P1** | any | see [§8.3](#83-chain-reorg-beyond-the-confirmation-depth) |
| `ActionQueued` you did not schedule | **P1** | any | governance compromise; you have until the eta |
| `ValidatorAdded` / `ThresholdChanged` / `Rescued` / `OwnershipTransferStarted` | **P1** | any | verify against your own change log |
| `ActionExecuted` / `ActionCanceled` you did not trigger | **P1** | any | `ActionQueued` fires once, 48 h earlier; these are the only other moments a queued action moves |
| `BridgeTokenCodehashChanged` / `WrapperBridgeRotationProposed` / `WrapperAdopted` | **P1** | any | someone is changing which bytecode may mint. Verify against your change log |
| `ShortDeliveryAllowed` you did not schedule | **P1** | any | somebody is authorising a transfer to pay its recipient less than it owes. It fires 48 h before the transfer can settle short, and `cancelShortDelivery()` revokes it instantly and for free. If it is not yours, revoke it and treat it as a governance compromise |
| `ShortDelivery` | **P1** | any | a transfer settled short. The event carries `owed`, `paid` and `delivered` — reconcile all three against the `Executed` for the same `transferId`, and expect `surplusOf(token)` to have risen by `owed − paid` |
| **Matured but unexecuted action** — `!executed && !canceled && now >= eta` | **P1** | any, standing check | a loaded gun. See the standing query below; it must be visible for as long as it is loaded, not only at the two instants it moves |
| Both buckets > 80 % of `dailyCap` **and** one counterparty is > half of each | P2 | per token | the signature of route griefing (see [security-model §8](security-model.md)) — a single actor round-tripping their own capital to hold the route shut in both directions |
| Inbound or outbound usage > 50 % of `dailyCap` | P2 | per token | look at who and why |
| Usage > 80 % of `dailyCap` | P2 | per token | decide: legitimate demand, or drain in progress |
| `Sent` with no `Executed` after 3× expected latency | P2 | per transfer | [§8.4](#84-relayer-stuck-or-transfers-not-arriving) |
| `Paused` / `TokenPaused` you did not trigger | P2 | any | pauser key may be compromised — availability, not theft |
| Validator daemon silent | P2 | > 10 min | one down is survivable at 2-of-3; two is an outage |
| Submitter balance low on gas | P3 | < 2 days runway | top up |
| `accruedFees` growing unswept | P3 | monthly | `withdrawFees` |

### The standing check for loaded actions

`ActionQueued` fires **once**, at queue time. Between an action's eta and its
execution it is a loaded gun that emits nothing, so poll for it rather than
waiting for an event. `GRACE_PERIOD` is 72 h, which bounds how long that window
can last before the action goes stale and must be re-queued — but 72 h of silence
is still 72 h.

```sh
# every action that is matured, live, and could fire in the next block
N=$(cast call $BRIDGE "actionCount()(uint256)" --rpc-url $RPC)
for i in $(seq 0 $((N-1))); do
  cast call $BRIDGE "getAction(uint256)(bytes,uint64,bool,bool)" $i --rpc-url $RPC
done
# alert on any row where executed=false, canceled=false and eta <= now
```

### Watching from the shell

```sh
# every Sent / Executed in the last 5,000 blocks
cast logs --from-block $((`cast block-number --rpc-url $RPC_A` - 5000)) \
  --address $BRIDGE_A \
  0x9683d1edf94e3d62fc7868a59d93c9fa65c1d45e23f6ca8f6aef8216f41a5911 \
  --rpc-url $RPC_A                        # Sent

cast logs --address $BRIDGE_B \
  0xa23569a3553285022f57074470de5df6ee7cdf80048088466b28142ae62581a1 \
  --rpc-url $RPC_B                        # Executed
```

Topic-0 hashes, taken from `forge inspect FerminuxBridge events`:

| Event | topic0 |
|---|---|
| `Sent` | `0x9683d1edf94e3d62fc7868a59d93c9fa65c1d45e23f6ca8f6aef8216f41a5911` |
| `Executed` | `0xa23569a3553285022f57074470de5df6ee7cdf80048088466b28142ae62581a1` |
| `ActionQueued` | `0x8326e6f492c06c0125d063d9c07410c2bdf792f7376d46b6415db9909505eb33` |
| `ActionExecuted` | `0x619482f2181eeee731fea5b2a12fd4f6e17c07fd6579048f39fc6da730d39bd2` |
| `ValidatorAdded` | `0xe366c1c0452ed8eec96861e9e54141ebff23c9ec89fe27b996b45f5ec3884987` |
| `ValidatorRemoved` | `0xe1434e25d6611e0db941968fdc97811c982ac1602e951637d206f5fdda9dd8f1` |
| `ThresholdChanged` | `0x6c4ce60fd690e1216286a10b875c5662555f10774484e58142cedd7a90781baa` |
| `TokenRegistered` | `0xe0fb6b1459a50e4626b32cebff89f3abff70788fa3e50ff48eff1dbc4cf2801c` |
| `TokenLimitsChanged` | `0x33f2012367300c6035eb9e7439af1d60d31f98b145d3d77a126daae145bcf7ab` |
| `Paused` | `0x62e78cea01bee320cd4e420270b5ea74000d11b0c9f74754ebdbfc544b05a258` |
| `Unpaused` | `0x5db9ee0a495bf2e6ff9c91a7834c1ba4fdd244a5e8aa4e537bd38aeae4b073aa` |
| `TokenPaused` | `0x3049c79d2929992d0f7fdd893166d6b11cc50f9c20d83ba5ea22091b7f1276d5` |
| `PauserSet` | `0xa11b5803b8a35081b8f993e0dee5bc30301a3d83f644e5ab2ff39f972f0a807f` |
| `Rescued` | `0x3af790fafda720819b2fc6e15090606e81154e0ac9a92d38ecad006d99d20ecc` |
| `ShortDeliveryAllowed` | `0xbfd7a4504aa7d79232e3ee3fa1592da44cf46542cb5ad7e805d7677c6cf86580` |
| `ShortDelivery` | `0xc723243c4507f9e278b1567c9be28f0890974f8a93b9ebdc276df3ef2d854514` |
| `ShortDeliveryRevoked` | `0xb49521d4d2dd47017549fd765f4258716122c755ece29c66ff0f390eef142110` |
| `FeesWithdrawn` | `0x5e110f8bc8a20b65dcc87f224bdf1cc039346e267118bae2739847f07321ffa8` |
| `OwnershipTransferStarted` | `0xd9be0e8e07417e00f2521db636cb53e316fd288f5051f16d2aa2bf0c3938a876` |

### The collateral check, on a schedule

```sh
LOCKED=$(cast call $BRIDGE_A "lockedBalance(address)(uint256)" \
  0x0000000000000000000000000000000000000000 --rpc-url $RPC_A)
SUPPLY=$(cast call $WFMX "totalSupply()(uint256)" --rpc-url $RPC_B)
echo "locked=$LOCKED  wrapped=$SUPPLY"
```

`SUPPLY` must never exceed `LOCKED`. It is legitimately **lower** while a
homeward transfer is signed but not yet executed, and while fees sit accrued on
the wrapped side. It being **higher** is a P1.

---

## 7. Pause/unpause decision tree

**Pausing is always safe. Nobody needs approval to pause. The only wrong move
is hesitating.** Unpausing needs the multisig, which is the deliberate
asymmetry: fast to stop, slow to restart.

```
Something looks wrong
│
├─ Executed without a matching Sent?  ──────────────▶ pause() BOTH chains. NOW.
│                                                     Then investigate.
│
├─ Wrapped supply > locked collateral? ─────────────▶ pause() BOTH chains. NOW.
│
├─ Two or more validator keys suspect? ─────────────▶ pause() BOTH chains. NOW.
│
├─ Exactly ONE validator key suspect (2-of-3)?
│     │   the key alone can do nothing
│     ├─ can you rotate within 48 h with confidence? ─▶ decreaseTokenLimits() to
│     │                                                 ~10 % on every token,
│     │                                                 keep running, rotate (§9)
│     └─ any doubt at all? ─────────────────────────▶ pause()
│
├─ One token misbehaving (bad registration, token
│  contract compromised, issuer froze the bridge)? ─▶ pauseToken(thatToken)
│                                                     leave the rest running
│
├─ Source chain reorged past the confirmation depth?▶ pause() the chain that
│                                                     RECEIVES from it (§8.3)
│
├─ Relayer down / transfers late, everything else
│  reconciles cleanly? ─────────────────────────────▶ DO NOT pause.
│                                                     Fix the relayer (§8.4)
│
└─ Cap exhausted, users complaining? ───────────────▶ DO NOT pause.
                                                      Working as designed.
```

### Pausing

```sh
cast send $BRIDGE_A "pause()" --private-key $PAUSER_KEY --rpc-url $RPC_A
cast send $BRIDGE_B "pause()" --private-key $PAUSER_KEY --rpc-url $RPC_B
cast call $BRIDGE_A "paused()(bool)" --rpc-url $RPC_A     # verify: true
```

Per token:

```sh
cast send $BRIDGE_A "pauseToken(address)" $TOKEN --private-key $PAUSER_KEY --rpc-url $RPC_A
```

`pause()` halts **both** `send()` and `execute()` — no value moves in either
direction. In-flight transfers are not lost; their signatures remain valid and
they resume after `unpause()`, provided the signing validators are still
validators (`test_TwoChain_InFlightTransferSurvivesAPauseAndResumes`).

Pausing one chain does **not** pause the other
(`test_TwoChain_PauseOnOneSideDoesNotPauseTheOther`). For a suspected
compromise, pause both.

### Unpausing — the checklist that must be complete first

Only the owner multisig can unpause. Before proposing it:

- [ ] Root cause is **understood**, not merely "it stopped happening"
- [ ] Reconciliation is clean: every `Executed` has a `Sent`, and
      `lockedBalance ≥` wrapped supply on every route
- [ ] Any compromised key is **out of the validator set** (48 h) or the
      threshold has been raised so it cannot contribute to a quorum
- [ ] Caps have been **lowered** to a level appropriate to reduced confidence
      (instant; raising them back is the 48 h path — accept that)
- [ ] Monitoring has been improved so the same event is caught faster
- [ ] Users have been told what happened, in writing, with numbers

```sh
cast calldata "unpause()"                 # submit through the multisig
cast calldata "unpauseToken(address)" $TOKEN
```

---

## 8. Incident response

For every incident: **pause first if in doubt, then preserve evidence, then
communicate.** Record block numbers and transaction hashes before anything is
restarted; RPC providers prune.

### 8.1 Validator key compromise

**One key of three (threshold 2)** — the key alone can do nothing.

1. Do **not** panic-pause automatically; decide with the tree in [§7](#7-pauseunpause-decision-tree).
2. Stop that validator's daemon and revoke its host access immediately.
3. `decreaseTokenLimits()` on every token to ~10 % of current, on both chains.
   Instant, multisig, no timelock. This shrinks the blast radius while you work.
4. Generate a replacement key with the full ceremony ([§3](#3-validator-key-generation-ceremony)).
5. Queue `addValidator(new)` **and** `removeValidator(old)` at the same time so
   the 48 h runs once. Execute `addValidator` first — `removeValidator` reverts
   with `BRIDGE: threshold unreachable` if it would drop the set below
   `threshold`.
6. Drain the in-flight signature queue before the removal lands: signatures from
   a removed validator stop counting the moment it is removed
   (`test_Sig_RemovedValidatorNoLongerCounts`), stranding partially-signed
   transfers.
7. Restore caps only after a clean week — another 48 h.

**Two or more keys** — this is a quorum.

1. `pause()` on **both** chains, immediately, from the pauser key. No approval,
   no meeting.
2. Assume every signature that key set could produce is hostile. Reconcile every
   `Executed` since the earliest possible compromise.
3. Rotate **all** validators, not just the known-bad ones.
4. Publish the incident with numbers before anyone asks.

### 8.2 Bridge exploit in progress

Symptoms: unexplained `Executed`, wrapped supply above locked collateral,
inbound usage climbing toward the cap with no matching outbound elsewhere.

**Minute 0–2**

```sh
cast send $BRIDGE_A "pause()" --private-key $PAUSER_KEY --rpc-url $RPC_A
cast send $BRIDGE_B "pause()" --private-key $PAUSER_KEY --rpc-url $RPC_B
```

Both chains. Every chain in the topology if there are more than two. Verify
`paused() == true` on each. **Do not wait to understand it first** — the caps
are bleeding at up to one `dailyCap` per token per day while you read logs.

**Minute 2–15**

- Snapshot: block numbers on both chains, every `Executed` in the window, the
  recipient addresses, `lockedBalance` and wrapped `totalSupply` per route.
- Post a holding statement: "bridge paused, funds locked, investigating."
  Silence is what turns an incident into a scandal.

**Hour 1+**

- Determine whether it was a **key** compromise (fraudulent transfers, contract
  behaving correctly) or a **contract** compromise (contract did something the
  code should not permit).
- Key compromise → [§8.1](#81-validator-key-compromise), two-key branch.
- Contract compromise → **the bridge does not unpause.** There is no upgrade
  path. Plan a migration: new deployment, users bring wrapped assets home under
  a controlled unpause of the homeward direction only (`unpauseToken` per token,
  one route at a time, caps tiny), then re-register on the new bridge.
- The owner multisig cannot recover collateral directly — `rescue()` is capped
  at `surplusOf(token)` and reverts with `BRIDGE: exceeds surplus`. For a
  **registered** token it is also timelocked (`BRIDGE: timelocked` on a direct
  call; queue it like any other privileged action), so even the surplus takes
  48 h and a public `ActionQueued`. Any release of collateral requires
  validator-signed transfers. Decide who authorises that and write it down
  **before** you need it.

### 8.3 Chain reorg beyond the confirmation depth

The dangerous case is a **source** reorg after the destination has credited: the
lock is erased, the wrapped asset is not.

1. `pause()` the chain that **receives** from the reorged chain (and both, if
   unsure).
2. Identify every transfer signed on the reorged range: `Sent` events between
   the common ancestor and the old head.
3. For each, check `processed(transferId)` on the destination.
   - not executed → simply drop it; instruct validators never to sign it again
   - **executed → this is a real shortfall.** Quantify it exactly:
     `wrapped totalSupply − lockedBalance` for that route.
4. The shortfall must be covered from the treasury or disclosed. There is no
   contract mechanism to claw back a completed `execute()`.
5. Before unpausing: **increase the confirmation depth** for that chain, and
   lower its caps. If it is Ferminux and the reorg was hostile, treat it as a
   hashrate-security event for the whole network, not just the bridge
   ([security-model.md §5](security-model.md#5-reorg-risk-per-chain)).

### 8.4 Relayer stuck, or transfers not arriving

Almost always availability, not theft. **Do not pause for this** — pausing makes
it worse.

Diagnose in order:

```sh
# 1. is the destination even accepting?
cast call $BRIDGE_B "paused()(bool)" --rpc-url $RPC_B
cast call $BRIDGE_B "tokenConfig(address)((uint8,bool,uint64,address,uint256,uint256))" \
  $DST_TOKEN --rpc-url $RPC_B          # field 2 = per-token paused

# 2. is the inbound cap full?
cast call $BRIDGE_B "inboundUsage(address)(uint256)" $DST_TOKEN --rpc-url $RPC_B

# 3. did it already land?
cast call $BRIDGE_B "processed(bytes32)(bool)" $TRANSFER_ID --rpc-url $RPC_B

# 4. can the submitter pay for gas?
cast balance $SUBMITTER --rpc-url $RPC_B
```

| Finding | Cause | Fix |
|---|---|---|
| destination `paused` | somebody paused | resolve the pause; transfers resume |
| token `paused` | route halted | `unpauseToken` when safe |
| `inboundUsage` at the cap | cap exhausted | **wait** — capacity returns continuously; ~4 %/hour |
| `processed == true` | it already arrived | check the `Executed` log; the user is looking in the wrong place |
| submitter out of gas | operational | top up; consider a second submitter |
| validators not signing | daemon down, RPC down, or depth not reached | restart; check each validator's last-signed height |
| signatures exist but nothing submits | submitter down | **anyone can relay.** Publish the transfer and its signatures; any user can call `execute()` themselves |

The last row is the reason to keep signature dissemination public: `execute()`
is permissionless, so a stuck relayer is never a stuck transfer for long — as
long as the signatures are available to somebody.

### 8.5 A canonical token starts taxing its transfers (a stranded route)

Signature: every release of one canonical token reverts with
`BRIDGE: inexact transfer`, and its deposits revert with the same string. The
token settled exactly when its collateral went in and does not any more. The
collateral is safe and fully accounted, but it cannot come out.

1. **Pause the token on BOTH chains, by hand.** `pauseToken(localToken)` here and
   `pauseToken(wrapper)` on the counterpart. This is the step people skip: the
   far side cannot see this token, so it will keep accepting burns of the wrapper
   and keep emitting `Sent` events this chain can no longer fill. Deposits fail
   closed on ONE chain, not both.
2. Quantify: `lockedBalance(token)` here versus `totalSupply()` of the wrapper
   there. Every unit of that supply is a claim that now needs a short delivery.
3. Talk to the token's issuer. A tax switched on by mistake can be switched off,
   and that is the only outcome in which nobody loses money.
4. If it cannot be switched off, the exit is `allowShortDelivery`, one transfer
   at a time. For each stranded transfer, queue
   `allowShortDelivery(<the full BridgeTransfer>)` — `RegisterToken.s.sol` with
   `TOKEN_KIND=shortdelivery` builds the calldata and prints the `transferId`.
   All of them can be queued at once; they mature together.
5. **Publish, during the 48 h window:** the `transferId`, the recipient, the
   amount owed and the amount they will actually receive. `ShortDeliveryAllowed`
   carries the first three on-chain. Somebody is about to be paid less than they
   were promised — they should hear it from you, before it happens, not from a
   block explorer afterwards.
6. Unpause the token, arm one authorisation (`executeAction`), relay that
   transfer, confirm `ShortDelivery(transferId, owed, paid, delivered)`, then arm
   the next. Only one is armed at a time; `cancelShortDelivery()` revokes the
   armed one instantly if anything looks wrong.
7. Under the reflection shape the write-down exceeds what the bridge paid, so
   `surplusOf(token)` grows. That residue belongs to the users who were short
   paid; it is NOT operator revenue. Moving it needs its own timelocked
   `rescue`, which is a second public announcement — decide who it goes to
   before you queue it.
8. Afterwards the route is dead. Leave it paused, and do not re-register the
   token (registration is once-only anyway).

### 8.6 Owner multisig compromise

The worst case. Signals: `ActionQueued` you did not schedule, an unexpected
`OwnershipTransferStarted`, `PauserSet`, or `Rescued`.

You have until the eta — up to 48 h — and the honest options are poor:

1. `cancelAction(actionId)` if you still control the multisig quorum. Cancel is
   `onlyOwner`, so this works only if the attacker does not have the quorum.
2. `pause()` from the pauser key — the attacker cannot unpause without the
   multisig quorum they may or may not have. This buys time and stops user
   funds entering.
3. Tell users to bridge out immediately, in public, and be specific about the
   deadline (the eta of the queued action).
4. If the attacker holds the quorum, the bridge is lost at the eta. Plan for
   getting users out, not for winning.

**This is why owner multisig key custody is the most important control in the
system.** Hardware wallets, geographically separated signers, no signer who also
holds a validator key or the pauser key.

---

## 9. Validator rotation

Rotation is routine hygiene — do it on a schedule, not only after an incident,
so that the procedure is boring by the time you need it.

**Both `addValidator` and `removeValidator` are timelocked 48 h.** Queue them
together so the wait runs once.

1. Generate the new key with the full ceremony ([§3](#3-validator-key-generation-ceremony)).
2. Queue both actions through the multisig:
   ```sh
   cast calldata "addValidator(address)"    $NEW_VALIDATOR
   cast calldata "removeValidator(address)" $OLD_VALIDATOR
   # wrap each with: cast calldata "queue(bytes)" <inner>
   ```
   Do this **on every chain** — validator sets are per-deployment.
3. Wait 48 h. Announce the pending change.
4. **Quiesce the in-flight queue first.** Signatures from a removed validator
   stop counting immediately. Either wait for the queue to drain, or briefly
   `pause()` so nothing new is signed while the change lands.
5. `executeAction` the **add** first, then the **remove**.
   `removeValidator` reverts with `BRIDGE: threshold unreachable` if it would
   leave fewer validators than `threshold`.
6. Verify:
   ```sh
   cast call $BRIDGE "getValidators()(address[])" --rpc-url $RPC
   cast call $BRIDGE "isValidator(address)(bool)" $OLD_VALIDATOR --rpc-url $RPC  # false
   cast call $BRIDGE "threshold()(uint256)" --rpc-url $RPC
   ```
7. Unpause if you paused. Move a dust transfer end to end to prove the new set
   signs correctly.

**Growing to 3-of-5** (the recommended posture once TVL is material): queue two
`addValidator` calls, execute, then queue `setThreshold(3)` and execute — a
second 48 h. Raising the threshold invalidates any in-flight signature set that
had only two signers (`test_Sig_RaisedThresholdInvalidatesOldQuorum`), so
quiesce first.

---

## 10. Routine operations

| Cadence | Task |
|---|---|
| Continuous | reconciliation loop (`Executed` ⇄ `Sent`), collateral check, validator liveness |
| Daily | review usage vs caps per token; submitter gas balances; validator log review |
| Weekly | `withdrawFees(token)` sweep per token per chain; confirm the fee collector received it |
| Weekly | confirm each validator host is patched and its key file is still `400` |
| Monthly | re-derive the Ferminux hashrate-vs-cap inequality with current hashrate and price |
| Monthly | pause drill on **mainnet**: pause, verify reverts, unpause through the multisig. A circuit breaker nobody has pulled is not a circuit breaker |
| Quarterly | validator rotation rehearsal; multisig signer contact list verification |
| Before any redeploy | `forge test` 289/289, `forge build --sizes`, devnet e2e |

Fee sweep:

```sh
cast send $BRIDGE "withdrawFees(address)" $TOKEN --private-key $COLLECTOR_KEY --rpc-url $RPC
# or through the owner multisig; the destination is always the current feeCollector
```

Fees collected on a **wrapped** side are denominated in the wrapped asset.
Turning them into the real asset means bridging them home and paying that leg's
fee. Budget for it; do not be surprised by it.

---

## 11. Never do this

- Never deploy with an **EOA** as `BRIDGE_OWNER`.
- Never let one person or one company hold more than one validator key. If that
  is unavoidable today, **say so publicly** and describe the bridge as what it
  actually is.
- Never run validators on one cloud account, one provider, or one region.
- Never let the pauser key double as a validator key or a multisig signer.
- Never register a **rebasing** token as canonical.
- Never register a wrapper whose `decimals()` does not exactly mirror the origin.
- Never raise a cap on one side of a route without raising the other.
- Never `unpause()` before the root cause is understood.
- Never use the deployment scripts' **anvil default keys** on any public chain —
  they are hard-coded dev accounts and are checked into the repository.
- Never point `script/devnet-e2e.sh` at a public RPC; it uses anvil-only cheat
  methods and well-known keys.
- Never redeploy without a green `forge test` on the exact commit.
- Never treat "the timelock will protect us" as a plan. The timelock only
  protects you if somebody is **watching** `ActionQueued`.

---

## See also

| Doc | For |
|---|---|
| [how-it-works.md](how-it-works.md) | how transfers work, fees, caps, timings |
| [security-model.md](security-model.md) | threat model, loss bounds, historical failures |
| [deploy-remote-chain.md](deploy-remote-chain.md) | adding a new EVM chain |
| [`../contracts/README.md`](../contracts/README.md) | contract detail, tests, devnet proof |
| `../relayer/README.md` | validator and submitter daemon: flags, config, deployment |
