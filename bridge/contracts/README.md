# Ferminux Bridge — Contracts

Symmetric lock-and-mint / burn-and-release bridge for Ferminux Network
(chain id **3961**, native coin **FMX**). One contract, the same bytecode,
deployed on **every** chain — including Ferminux itself.

| Contract | File | Purpose |
|---|---|---|
| `FerminuxBridge` | `src/FerminuxBridge.sol` | The bridge. Registry, `send`, `execute`, M-of-N EIP-712 verification, caps, pause, timelock, fees, rescue |
| `BridgeToken` | `src/BridgeToken.sol` | Wrapped ERC-20 minted by the bridge for an asset canonical on another chain. EIP-2612 permit, no owner mint |

**335 tests, all green.**

---

## Architecture

```
              CHAIN A  (e.g. Ferminux, id 3961)             CHAIN B  (e.g. BSC, id 56)
        ┌───────────────────────────────────────┐   ┌───────────────────────────────────────┐
        │            FerminuxBridge             │   │            FerminuxBridge             │
        │                                       │   │                                       │
 user   │  registry:                            │   │  registry:                            │
  ──────┼─▶ 0x0  CANONICAL ──▶ (56,  wFMX)      │   │   wFMX  WRAPPED   ──▶ (3961, 0x0)     │
 send() │   USDX CANONICAL ──▶ (56,  wUSDX)     │   │   wUSDX WRAPPED   ──▶ (3961, USDX)    │
        │   wBNB WRAPPED   ──▶ (56,  0x0)       │   │   0x0   CANONICAL ──▶ (3961, wBNB)    │
        │                                       │   │                                       │
        │  lockedBalance[0x0] += net  ── LOCK   │   │                                       │
        │  emit Sent(transferId, …)             │   │                                       │
        └──────────────────┬────────────────────┘   └───────────────────▲───────────────────┘
                           │                                            │
                           │  off-chain validators watch Sent           │  anyone relays
                           ▼                                            │
                  ┌──────────────────┐                      ┌───────────┴──────────┐
                  │  validator 1..N  │  EIP-712 sign the    │  execute(transfer,   │
                  │  (M of N needed) │ ─── transfer ───────▶│      signatures[])   │
                  └──────────────────┘  domain = (chainId   └──────────────────────┘
                                          of DESTINATION,              │
                                          bridge address)              ▼
                                                              MINT wFMX to recipient
                                                              (or RELEASE if canonical)

  Coming home is the mirror image: burn wFMX on B  ──▶  release locked FMX on A.

  transferId = keccak256(srcChainId, dstChainId, nonce,
                         srcToken, dstToken, sender, recipient, amount)
```

### The one invariant everything serves

> **wrapped supply on B  ≤  collateral locked on A**, always, in any order.

Exactly:

```
lockedBalance_A  ==  totalSupply_B  +  (A→B transfers not yet minted)
                                    +  (B→A burns not yet released)
```

Both are asserted continuously in `test/BridgeInvariant.t.sol` over random
sequences of sends, relays and time skips across two chain ids.

---

## Security model, in plain words

### What a compromised validator can do

**Nothing, alone.** A single validator's signature is one vote. With the default
2-of-3 it cannot execute anything: `execute()` counts *distinct* recovered
signers, so submitting one validator's signature two, three or fifty times still
counts as one (`BRIDGE: duplicate signer`). Flipping `s` to `N−s` to manufacture
a "second" signature from the same key is rejected as malleable before it is even
counted.

A validator also cannot:

- change any configuration — validators have **no** admin powers whatsoever
- pause or unpause
- move funds outside a transfer that a quorum signed
- reuse a signature on another chain: the EIP-712 domain binds the **destination
  chain id** and **this exact bridge address**, so a signature valid on chain B
  is worthless on chain A and worthless on a redeployment
- replay a transfer: `transferId` is marked processed before any token moves
- mint a canonical asset or release a wrapped one — the registry `kind` decides
  the branch and there is no path from one to the other
- release more of a token than was ever locked: `lockedBalance[token] -= amount`
  underflows and reverts

### What a compromised **quorum** (M validators) can do

This is the real threat, and the caps exist to bound it:

- they can sign fraudulent inbound transfers, so they can **drain up to
  `maxPerTransfer` per transfer and up to `dailyCap` per token per rolling 24
  hours** — nothing more, no matter how many transfers they sign
- they **cannot** touch a token that is paused, and pausing is one transaction
  from a hot key
- they **cannot** raise the caps, add validators or register a new token: every
  one of those is behind the 48h timelock and the owner multisig

So the blast radius of a full validator compromise is bounded by
`dailyCap × (hours until a human notices) / 24` per token — and the honest
response is `pause()`, which is instant. Removing the compromised validator takes
48h; **containment does not wait for it.**

### Fast vs slow — the whole design in one table

| Action | Who | Delay | Why |
|---|---|---|---|
| `pause()` / `pauseToken()` | PAUSER key or owner | none | stopping is always safe |
| `decreaseTokenLimits()` | owner | none | tightening is always safe |
| `unpause()` / `unpauseToken()` | owner multisig only | none | a single hot key must not reopen what it closed |
| `rescue()` — **unregistered** token | owner | none | nobody's collateral is denominated in an asset the bridge does not route |
| `withdrawFees()` | collector or owner | none | fees are never collateral |
| `setPauser()` | owner | none | a pauser can only stop things |
| `cancelOwnershipTransfer` / `cancelWrapperBridgeRotation` | owner | none | revoking a handover is a safety action |
| `adoptWrapper` | owner | none | inert until the timelocked `registerWrapped` lands |
| `transferOwnership` (then `acceptOwnership`) | owner via timelock, then new owner | **48h** + 2-step | the ownership seat is the largest blast radius in the system; a pending offer expires after 14 days |
| `proposeWrapperBridge` | owner via timelock | **48h** + 48h | hands the minter seat to a new bridge; `BridgeToken` adds its own `ROTATION_DELAY` on top |
| `setBridgeTokenCodehash` | owner via timelock | **48h** | pins which bytecode may be registered as a wrapper |
| `setRemoteBridge` | owner via timelock | **48h** | it is the address `send()` refuses to pay; pointing it wrong re-opens the guard |
| `cancelShortDelivery()` | owner | none | revoking a permission is a safety action |
| `allowShortDelivery(transfer)` | owner via timelock | **48h** | lets ONE named transfer settle short — the strand escape, see [Settlement](#settlement) |
| `rescue()` — **registered** token | owner via timelock | **48h** | a routed asset's surplus is a derived figure; an instant exit is what makes any accounting defect exploitable |
| `registerCanonical` / `registerWrapped` | owner via timelock | **48h** | a new asset is new attack surface |
| `setTokenLimits` (incl. increases) | owner via timelock | **48h** | raising a cap raises the blast radius |
| `addValidator` / `removeValidator` / `setThreshold` | owner via timelock | **48h** | the signer set is the trust root |
| `setFeeBps` / `setFeeCollector` | owner via timelock | **48h** | economic parameters, users deserve notice |
| `setTimelockDelay` | owner via timelock | **48h** | shortening the delay must serve the current delay |

The timelock is not an arbitrary-call machine: `queue()` accepts **only** the
fifteen whitelisted selectors above. Queuing `send()`, `withdrawFees()` or
`pause()` reverts with `BRIDGE: not timelockable`. `rescue()` **is** on the list,
because that is the only way a registered token's surplus can leave — and it is
still capped at `surplusOf(token)` when it fires, so the delay is a second lock,
never a replacement for the first. A queued action also goes stale
`GRACE_PERIOD = 72 hours` after its eta — short on purpose, because `ActionQueued`
fires only once and a matured action that can be held for a fortnight is one that
fires with no fresh warning.

### Caps: a draining bucket, not a calendar day

A naive `if (today != lastDay) used = 0` cap can be gamed by sitting on the
boundary and spending 2× the cap in a few minutes. Here, `used` decays **linearly
and continuously** toward zero over 24h:

```
used_now = used − used × (now − updatedAt) / 24h        (0 once 24h have passed)
```

Half an hour after filling the bucket you have ~2% of it back; twelve hours
later, exactly half. There is no instant at which capacity jumps. Outbound and
inbound have **separate** buckets per token, so draining the exit does not
also drain the entrance.

### Fees

Taken at the **origin** of each leg, in basis points, hard-capped at
`MAX_FEE_BPS = 100` (1.00%) in code — governance cannot exceed it, only the
compiler can. Default 10 bps.

- canonical send: `lockedBalance += net`, `accruedFees += fee`. The fee is
  explicitly **not** collateral, so it can never be released to an inbound
  transfer, and an inbound transfer can never eat it.
- wrapped send: the full amount is burned and the fee is re-minted to the bridge,
  so supply falls by exactly `net` — exactly what will be released at home — and
  the operator's fee stays backed by real collateral on the origin chain.
- `execute()` charges nothing: the recipient receives exactly the signed amount.
  A round trip therefore pays twice, once per leg, at the chain each leg left.

### Rescue can never steal

`rescue()` is capped at `surplusOf(token)` on every call:

```
surplus = balance − lockedBalance[token] − accruedFees[token]
```

An airdrop, a mistaken direct transfer or dust is recoverable; one wei of
collateral is not. Fuzz-tested in `testFuzz_RescueNeverEatsIntoLockedOrFees`.

It runs at **two speeds**, and the split is the point:

| Token | Speed | Why |
|---|---|---|
| **unregistered** | instant, owner | no collateral is denominated in an asset this bridge does not route, so the surplus is the whole balance and there is nothing to protect. Making the junk drawer wait 48 h buys no safety |
| **registered** (including the native coin) | **timelocked** | for a routed asset "surplus" is *derived*: `balance − lockedBalance − accruedFees`. Any defect that overstates it turns an instant rescue into the exit that makes the defect payable — which is exactly what the round-2 verifier flagged. Behind the timelock the same withdrawal costs a public `ActionQueued` and 48 h in which anyone reconciling the books can `pause()` |

One consequence, stated plainly: because settlement is strict everywhere,
**an airdropped fee-on-transfer token cannot be rescued at all.** It sits in the
contract as inert, unclaimable surplus. That is the trade — this contract has one
settlement rule, and a cleanup convenience is not worth a second one.

### Settlement

There is exactly **one** supported token behaviour, and nothing anywhere — no
class, no per-token flag, no governance switch — that relaxes it for an asset.
Every value movement is verified by **measured effect** on **both sides**:

```
paid      = how much the bridge's own balance fell
delivered = how much the recipient's balance rose
```

| Leg | Rule | On anything else |
|---|---|---|
| deposit — `send`, canonical ERC-20 | the bridge's balance rises by **exactly** `amount` | `BRIDGE: inexact transfer`; the whole deposit reverts and the depositor keeps their money |
| release — `execute`, canonical | `paid == amount` **and** `delivered == amount` | `BRIDGE: inexact transfer` |
| mint — `execute`, wrapped | the recipient's balance rises by exactly `amount` | `BRIDGE: mint not settled` |
| burn — `send`, wrapped | total supply falls by exactly `net` | `BRIDGE: burn not settled` |
| moved nothing / delivered nothing | refused **everywhere**, no exception | `BRIDGE: transfer not settled` |
| `paid > amount` | refused **everywhere**, no exception | `BRIDGE: inexact transfer` |

`paid > 0` is what rejects a dead proxy or a silent no-op: a call that moved
nothing can never pass, whatever it returned. `delivered > 0` is what rejects the
shape the bridge-side read alone is blind to — a token that debits the bridge and
credits nobody (burn-on-transfer, a blacklist that swallows instead of reverting).
`paid <= amount` is the solvency rail: one payout can never eat another user's
collateral. Those three hold for **every** payout the contract can make,
including the escape hatch below.

Every refusal above **reverts**, so the `transferId` is not consumed, the
collateral is not written down and the 24h cap is not spent. Nothing in this
contract may consume a transfer while delivering nothing.

#### There is no LOSSY class

v1 briefly shipped one: a timelocked per-token flag that let a route settle for
less. It was removed in round 3, and not for tidiness.

* Its **deposit** half was a fund-theft path. `send()` metered what arrived and
  credited the measurement. A reflection token can settle pooled accrual into the
  bridge *during* `transferFrom`, so the measurement is **larger** than the
  deposit: 1.0 token in, 200.799 credited, and the counterpart chain releases real
  collateral belonging to other users against the difference.
* Its **release** half had no delivery floor: one wei satisfied `delivered > 0`
  while the `transferId` was consumed and `lockedBalance` written down in full —
  final and unretryable.
* And a class is a *standing* permission granted on a one-time reading of code
  that can change the next day. Nothing on-chain can re-check it.

Nobody has asked to bridge a taxed token. The project brief says add complexity
only when demand requires it. v1 supports strict settlement only.

#### What is supported, and where each shape is refused

| Token shape | Verdict | Refused where |
|---|---|---|
| Plain ERC-20, including USDT-shaped (no return value) | **supported** | — |
| Clawback / blacklist-with-burn (USDT/USDC shape) | **supported, with eyes open** | transfers settle exactly, so the rule is met — but the issuer can make the bridge insolvent at will. `withdrawFees` and `rescue` both fail closed once the bridge is short; releases revert on `lockedBalance` underflow. See [Known limitations](#known-deliberate-limitations) |
| Any token that cannot answer `balanceOf()` | **refused at REGISTRATION** | `registerCanonical` probes it: `BRIDGE: token not a contract`, or the probe call itself reverts |
| An address with no code | **refused at REGISTRATION** | `registerCanonical`: `BRIDGE: token not a contract` |
| A wrapper that is not exactly the audited `BridgeToken` bytecode | **refused at REGISTRATION** | `registerWrapped`: `BRIDGE: wrapper not pinned` / `BRIDGE: wrapper pin unset` |
| A second local token claiming a remote asset already routed | **refused at REGISTRATION** | `_register`: `BRIDGE: remote already routed` |
| Fee-on-transfer — fee taken **out of** the amount | **refused at FIRST TRANSFER, both legs** | `send`: `BRIDGE: inexact transfer`. `execute`: `BRIDGE: inexact transfer` |
| Reflection / redistributing — tax spread to holders, bridge included | **refused at FIRST TRANSFER, both legs** | same; on deposit the measured arrival differs from `amount` in *either* direction, and both are refused |
| Fee charged **on top of** the amount | **refused at FIRST TRANSFER** | `_settle`: `paid <= amount` fails, `BRIDGE: inexact transfer` |
| Debits the payer and credits nobody (100% burn-on-transfer, swallowing blacklist) | **refused at FIRST TRANSFER** | `_settle`: `BRIDGE: transfer not settled` |
| A token that has gone dark (dead proxy, zeroed implementation) | **refused at FIRST TRANSFER** | `_settle`: `BRIDGE: token has no code` or `BRIDGE: transfer not settled` |
| Recipient-side hooks that forward the funds onward in the same call (ERC-777 shape) | **refused at FIRST TRANSFER** | `delivered` is measured immediately after the call, so a hook that moves the funds on reads as "delivered nothing" |
| Rebasing / elastic supply (balances change with no transfer) | **NOT DETECTABLE — do not register one** | nothing refuses it. `lockedBalance` is a raw-unit counter and drifts away from reality in both directions; no settlement check can see a balance that changed without a transfer |
| A token whose transfer path you cannot read (unverified, or a proxy you cannot follow) | **do not register one** | nothing refuses it either. There is no safe default for an unknown transfer path |

The registry enforces what is checkable at registration time — code exists,
`balanceOf()` answers, the wrapper bytecode is pinned, the remote pair is
unclaimed — and refuses everything else at the first transfer, where it is
observable. The last two rows are the honest gap: **the contract cannot detect
them, and does not pretend to.** They are an operator judgement made before
registering, and registration is once-only.

#### When a route strands

A token that settled exactly while its collateral went in can start taxing its
transfers afterwards. From that instant:

* **deposits** refuse, so the exposure stops growing — on *this* chain. This is
  where the round-2 README claimed "failing closed is bilateral", and that claim
  was **false and is deleted**. The far side cannot see this token at all: it will
  keep accepting burns of the wrapper and keep emitting `Sent` events that this
  chain can no longer fill. If a route strands, `pauseToken` **both sides, on both
  chains**, or users will keep buying claims on collateral that cannot come out;
* **releases** revert, retryably. Nothing is short-paid, no `transferId` is
  burned, no cap is spent — but retrying forever is still a strand.

`allowShortDelivery(transfer)` is the way out, and it is deliberately narrow:

| Property | How |
|---|---|
| one transfer at a time | the authorisation is a single `bytes32` slot, `shortDeliveryArmed`. Arming a second replaces the first |
| welded to that transfer | the `transferId` commits to token, recipient, amount, both chain ids and the nonce. A different amount or recipient is a different id the authorisation does not cover |
| moves nothing itself | it writes one word. The value moves only when that transfer is executed through the ordinary `execute()`, which still demands a full validator quorum |
| cannot exceed the transfer | `paid <= amount` still holds, and `lockedBalance[token] -= amount` still underflows past the collateral the route actually has |
| cannot deliver nothing | `paid > 0` and `delivered > 0` still hold |
| single-use | `execute()` clears the slot before it calls out |
| announced | `ShortDeliveryAllowed(transferId, token, recipient, owed)` fires 48h ahead, with the whole transfer visible in the queued calldata |
| accounted | `ShortDelivery(transferId, owed, paid, delivered)` records what was promised, what the bridge parted with and what actually landed |
| revocable, instantly | `cancelShortDelivery()`, owner, no delay — same rule as every other revocation here |
| not usable on wrapped or native | `BRIDGE: not canonical`. A mint cannot under-deliver; a value-bearing call either sends `msg.value` or reverts |

Under the reflection shape the write-down exceeds what the bridge parted with, so
the residue lands in **surplus** — never in a shortfall. That residue is reachable
only through a *second* timelocked `rescue`, which is why `rescue` of a registered
token is timelocked at all.

**Using this means a real person receives less than the amount they were signed
for.** It is the last resort, after `pauseToken` and after talking to the token's
issuer. Publish the transferId and the arithmetic during the 48h window. The whole
suite is `test/BridgeShortDelivery.t.sol`.

### Wrapped tokens

`BridgeToken` has no owner, no owner mint, no pause and no upgrade path. Only the
current bridge can mint or burn, and `burn` consumes the holder's allowance
exactly as `transferFrom` would — so a wrapped `send()` is approve-then-send, and
no bridge can move a balance nobody granted it. That guarantee used to rest on the
bridge only ever calling `burn(msg.sender)`, which is true of the deployed bridge
and unverifiable to a holder who would have to trust it is never rotated; token
scanners read the old signature as "owner can change balance", correctly.
`registerWrapped` pins the wrapper's exact runtime
bytecode (`bridgeTokenCodehash`) and then verifies
`BridgeToken.bridge() == address(this)`, so a bridge can never be pointed at a
wrapper it does not control, and no proxy can pass the check on Monday and defect
on Tuesday.

The minter seat **is** rotatable — a migration would otherwise strand every
wrapped holder — but only along a path with four locks on it:

1. `proposeWrapperBridge` is timelocked (48h), and `BridgeToken` adds its own
   `ROTATION_DELAY` (48h) before the offer can be taken up.
2. The rotation target must be a **contract**, and must answer
   `BRIDGE_INTERFACE_ID()` with `keccak256("FerminuxBridge.v1")`. An EOA has no
   code and cannot answer at all, so the owner cannot point a live wrapper's
   minter at a bare key — which would be a licence to mint unbacked wrapped
   supply against the counterpart chain's collateral.
3. `adoptWrapper` on the receiving side is gated on that bridge's own codehash
   pin, so the seat it takes is one holding audited `BridgeToken` code.
4. `adoptWrapper` and `cancelWrapperBridgeRotation` both call into an address the
   owner names, so both are `nonReentrant`.

An owner determined to abuse this must deploy a lying bridge contract, in public,
48h before the handover lands. That is the difference between a mistake and a
conspiracy — and it is the most this design can constrain a compromised owner
multisig, which remains the system's single point of total failure.

### Known, deliberate limitations

- **One remote chain per local token.** The registry maps `localToken →
  {kind, remoteChainId, remoteToken}`. A hub-and-spoke topology needs one
  wrapper (and one registry entry) per route. This keeps `execute()`'s
  source validation exact and unambiguous.
- **Registration is once-only.** `registerCanonical` / `registerWrapped` revert
  with `BRIDGE: already registered` on a second attempt; a mis-registered token
  is handled with `pauseToken()`, not by retargeting a live asset.
- **Fee-on-transfer, reflection and any other taxed canonical token is NOT
  supported.** Refused on both legs at the first transfer, loudly and retryably —
  see [Settlement](#settlement). There is no class, flag or declaration that
  changes this. `Sent.amount` is therefore always the net of exactly what the
  caller asked for, so a relayer reading the calldata and a relayer reading the
  event agree by construction.
- **A route can strand, and unstranding it costs a user money.** If a supported
  token starts taxing its transfers after collateral is locked behind it, the
  only exit is `allowShortDelivery` — one timelocked, announced transfer at a
  time, each of which delivers its recipient less than they were promised. There
  is no version of this that is free; the alternative designs are silent
  short-pay (round 1's bug) and a standing licence that can be turned into a
  drain (round 2's bug).
- **Deposits fail closed on ONE chain, not on both.** The far side of a route
  cannot observe this chain's token, so it keeps accepting burns after this side
  has stopped accepting deposits. Stranding a route means pausing the token on
  **both** deployments, by hand. The contract cannot do it for you.
- **Rebasing tokens and unreadable tokens are refused by operator judgement, not
  by code.** Nothing in the contract detects either, and registration is
  once-only. This is the gap in the registry's guarantees and it is stated as one.
- **The volume buckets are exhaustible by anyone, including an attacker.** One
  actor can hold a token's outbound bucket on one chain and its inbound bucket on
  the other by round-tripping their own capital, shutting the route for everyone
  else. Priced: **2 × `feeBps` × `dailyCap` per day** — 0.2 % of one `dailyCap`
  daily at the default 10 bps, with capital equal to one `dailyCap` and fully
  recoverable. No clean on-chain fix exists: a cap is by definition an
  exhaustible shared resource, and a per-sender split is defeated by a fresh
  address per transaction. It is handled as a cap-sizing input, a monitoring
  signature (both buckets above 80 % with one dominant counterparty) and a
  `setFeeBps` deterrent — see [docs/operations.md](../docs/operations.md) §5.
- **The counterpart bridge address is configuration, not a derivation.** There is
  no deterministic / address-identical deployment scheme in this project, and
  `send()` does not assume one. Each chain records the other side's deployment
  with the timelocked `setRemoteBridge`, and no route may be registered for a
  chain whose bridge is unrecorded (`BRIDGE: remote bridge unset`). `send()` then
  refuses that address as a recipient at ORIGIN, where the user still has their
  money; `execute()` refuses the local bridge at DESTINATION as the last line.
  Point `setRemoteBridge` at the wrong address and the guard still fires — just
  on the wrong address — so read it back after every change.
- **`BRIDGE: amount too small`** in `send()` is unreachable while
  `feeBps ≤ MAX_FEE_BPS` (the fee can never be the whole amount). It is kept as a
  defensive assertion.
- **Validator removal is timelocked** by design, per the spec. The fast path for
  a compromised key is `pause()`.
- **Signatures never expire, and a bundle is judged only on the quorum inside
  it.** `_verifySignatures` ignores signatures that do not recover to a *current*
  validator instead of rejecting the whole bundle for carrying one — a relayer
  that collects every signature it can get is doing the right thing, and a
  rotation must not kill its in-flight work. Duplicates of a current validator
  remain fatal (`BRIDGE: duplicate signer`), malleable `s` values remain fatal
  (`BRIDGE: malleable signature`), and the count is still of DISTINCT current
  validators, so ignoring extras cannot substitute for a quorum. The arity bound
  is the constant `MAX_VALIDATORS = 32`, which caps the O(n²) duplicate scan.

---

## Layout

```
bridge/contracts/
├── foundry.toml               solc 0.8.24 pinned, optimizer on, via_ir on, evm_version = paris
├── src/
│   ├── FerminuxBridge.sol     the bridge (runtime 23,965 B — 611 B under the 24,576 B limit)
│   └── BridgeToken.sol        wrapped ERC-20 (runtime 4,465 B, no immutables so every
│                              deployment shares one codehash — that is what the
│                              registerWrapped pin checks against)
├── test/                      335 tests
│   ├── utils/                 shared fixture + mocks (fee-on-transfer and reflection,
│   │                          both switchable so a fixture can lock collateral through
│   │                          a token that only turns hostile later; burn-on-transfer,
│   │                          surcharge, no-return, false-return, silent-noop,
│   │                          dead-proxy, lying + reentrant wrappers)
│   ├── BridgeAdmin.t.sol      66  constructor, timelock, registry, validators, fees, ownership
│   ├── BridgeExecute.t.sol    48  EIP-712 M-of-N, replay, inbound caps, release/mint split
│   ├── BridgeSend.t.sol       40  lock/burn, fee math, outbound caps, cap decrease vs raise
│   ├── BridgeRedTeam.t.sol    39  regressions for every 2026-08-20 red-team finding
│   ├── BridgeToken.t.sol      31  wrapper ERC-20 + permit
│   ├── BridgeAccounting.t.sol 28  lockedBalance, fee withdrawal, the rescue surplus rule
│   │                              and its two speeds
│   ├── BridgePause.t.sol      23  global + per-token pause, pauser role
│   ├── BridgeVerifier.t.sol   22  regressions for the round-2 verifier report:
│   │                              settlement, wrapper-rotation identity,
│   │                              rotation reentrancy, the remote-bridge guard
│   ├── BridgeShortDelivery.t.sol 19 the round-3 strand escape: the strand itself, the
│   │                              announcement, the settlement, and every way it is
│   │                              NOT a withdrawal
│   ├── BridgeTwoChain.t.sol   13  full two-chain simulation, conservation
│   └── BridgeInvariant.t.sol   6  stateful invariants over two chains
├── script/
│   ├── DeployBridge.s.sol       one bridge per chain, env-driven
│   ├── DeployWrappedToken.s.sol a BridgeToken wrapper
│   ├── RegisterToken.s.sol      queue / execute / cancel a timelocked registration
│   └── devnet-e2e.sh            two-anvil end-to-end proof (ports 8560/8561,
│                                overridable with RPC_A / RPC_B)
└── lib/forge-std/               test framework only (v1.16.2) — no runtime dependencies
```

Two build notes that matter:

- **`evm_version = "paris"`** — ferminux-geth forks geth v1.10.26, which pre-dates
  Shanghai. `PUSH0` is not a valid opcode on chain 3961. Paris bytecode is also
  valid on every modern remote chain, so one artifact serves all of them. Do not
  raise this without upgrading the chain client.
- **solc pinned to 0.8.24** — matches the `pragma ^0.8.24` in both contracts and
  the rest of `ferminux-network/contracts`.

---

## Build & test

```sh
cd <repo>/bridge/contracts
forge build
forge test              # 335 tests
forge test -vvv         # verbose traces
forge build --sizes     # runtime bytecode sizes vs the 24,576 B limit
```

Selected slices:

```sh
forge test --match-path test/BridgeExecute.t.sol      # signature security
forge test --match-path test/BridgeTwoChain.t.sol     # two-chain simulation
forge test --match-path test/BridgeInvariant.t.sol    # invariants
forge test --match-path test/BridgeVerifier.t.sol      # round-2 verifier regressions
forge test --match-path test/BridgeShortDelivery.t.sol # the strand escape
forge test --match-test  Duplicate -vvv               # the duplicate-signer proof
```

Fresh checkout only needs forge-std:

```sh
forge install foundry-rs/forge-std@v1.16.2
```

---

## Two-chain devnet proof (executed on this machine)

Two throwaway anvils — **never** the live devnet on 8545, never a public RPC.

Terminal A:

```sh
anvil --port 8560 --chain-id 3961     # stands in for Ferminux
```

Terminal B:

```sh
anvil --port 8561 --chain-id 56       # stands in for a remote EVM
```

Terminal C:

```sh
cd <repo>/bridge/contracts
bash script/devnet-e2e.sh
```

The script deploys a bridge on each side, deploys `wFMX` on chain B, registers
both sides through the timelock, then moves 10 FMX A→B→A with **real** EIP-712
signatures made by `cast wallet sign --no-hash`. Actual output of a clean run:

```
== 7. registration is timelocked - executing early must fail
early execute exit code: 1 (non-zero = correctly refused)

== 8. wait out the timelock, then execute (pin and remote bridge first)
chain A knows B as:    0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
chain B knows A as:    0x5FbDB2315678afecb367f032d93F642f64180aa3
chain A native config: (1, false, 56, 0x9fE4...a6e0, 100000000000000000000, 500000000000000000000)
chain B wFMX config:   (2, false, 3961, 0x0000...0000, 100000000000000000000, 500000000000000000000)

== 8b. a send naming the DESTINATION bridge as recipient must be refused at origin
send-to-remote-bridge exit code: 1 (non-zero = correctly refused at ORIGIN)

== 9. user locks 10 FMX on chain A
locked=9990000000000000000 fee=10000000000000000 nonce=1

== 10. validators sign the transfer for chain B and anyone relays it
eip712 digest = 0xcd549492d60ebbdcc3165eb439aa870520fb879c1d570a7d14be9d2b08fcd18a
-- a single signature must be refused (threshold is 2)      exit code: 1
-- the same validator twice must be refused                 exit code: 1
-- two distinct validators: accepted
wFMX balance of recipient: 9990000000000000000
wFMX total supply:         9990000000000000000
locked on chain A:         9990000000000000000   <- must equal the supply above

== 11. replay of the same transfer must fail                exit code: 1

== 12. send it all back: burn on B, release on A
user received back: 9980010000000000000 wei (expected 9980010000000000000)
wFMX supply now:    9990000000000000   <- the fee taken on B
locked on A now:    9990000000000000   <- still exactly backs it

== 13. rescue of a REGISTERED asset is timelocked, and still cannot touch collateral
instant rescue of the native (registered) asset exit code: 1
timelocked rescue of collateral       exit code: 1 (surplus is 0)
== 14. pause is immediate
send while paused exit code: 1
```

Addresses on a fresh pair of anvils:

| | Address |
|---|---|
| bridge on 3961 (:8560) | `0x5FbDB2315678afecb367f032d93F642f64180aa3` |
| bridge on 56 (:8561) | `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512` |
| wFMX on 56 | `0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0` |

**The two bridges are deliberately at different addresses.** The script burns one
nonce on chain B before deploying, because two fresh anvils would otherwise put
both bridges at the same address — a coincidence of matching nonces that real
chains do not reproduce and that nothing in this design may lean on. Step 8b
proves the bad-recipient guard fires on the address chain A was *told* chain B's
bridge lives at, not on its own.

Stop the anvils when you are done: `pkill -f "anvil --port 856"`.

### Doing it by hand

```sh
export RPC_A=http://127.0.0.1:8560
export RPC_B=http://127.0.0.1:8561
export KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80  # anvil #0

# 1. a bridge on each chain
BRIDGE_OWNER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 TIMELOCK_DELAY=3600 \
  forge script script/DeployBridge.s.sol --rpc-url $RPC_A --broadcast
BRIDGE_OWNER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 TIMELOCK_DELAY=3600 \
  forge script script/DeployBridge.s.sol --rpc-url $RPC_B --broadcast

# 2. the wrapper for chain A's native coin, on chain B
BRIDGE=$BRIDGE_B ORIGIN_CHAIN_ID=3961 ORIGIN_TOKEN=0x0 \
WRAPPED_NAME="Wrapped FMX" WRAPPED_SYMBOL=wFMX \
  forge script script/DeployWrappedToken.s.sol --rpc-url $RPC_B --broadcast

# 3. tell each side the OTHER side's bridge address. Mandatory: without it every
#    registration reverts with "BRIDGE: remote bridge unset".
BRIDGE=$BRIDGE_A OWNER_KEY=$KEY ACTION=queue TOKEN_KIND=remotebridge \
REMOTE_CHAIN_ID=56 REMOTE_BRIDGE=$BRIDGE_B \
  forge script script/RegisterToken.s.sol --rpc-url $RPC_A --broadcast

# 4. register both sides (queue, wait, execute)
BRIDGE=$BRIDGE_A OWNER_KEY=$KEY ACTION=queue TOKEN_KIND=canonical \
LOCAL_TOKEN=0x0000000000000000000000000000000000000000 \
REMOTE_CHAIN_ID=56 REMOTE_TOKEN=$WFMX \
MAX_PER_TRANSFER=100000000000000000000 DAILY_CAP=500000000000000000000 \
  forge script script/RegisterToken.s.sol --rpc-url $RPC_A --broadcast

cast rpc evm_increaseTime 3660 --rpc-url $RPC_A && cast rpc evm_mine --rpc-url $RPC_A

BRIDGE=$BRIDGE_A OWNER_KEY=$KEY ACTION=execute ACTION_ID=0 \
  forge script script/RegisterToken.s.sol --rpc-url $RPC_A --broadcast   # setRemoteBridge
BRIDGE=$BRIDGE_A OWNER_KEY=$KEY ACTION=execute ACTION_ID=1 \
  forge script script/RegisterToken.s.sol --rpc-url $RPC_A --broadcast   # registerCanonical

# 5. lock 10 FMX
cast send $BRIDGE_A 'send(address,uint256,uint64,address)' \
  0x0000000000000000000000000000000000000000 10000000000000000000 56 $RECIPIENT \
  --value 10000000000000000000 --private-key $USER_KEY --rpc-url $RPC_A

# 6. what the validators sign (ask the DESTINATION bridge for the digest)
T="(3961,56,1,0x0000000000000000000000000000000000000000,$WFMX,$USER,$RECIPIENT,9990000000000000000)"
DIGEST=$(cast call $BRIDGE_B \
  'hashTransfer((uint64,uint64,uint64,address,address,address,address,uint256))(bytes32)' \
  "$T" --rpc-url $RPC_B)
cast wallet sign --no-hash $DIGEST --private-key $VALIDATOR1_KEY   # -> 65-byte sig, split into (v,r,s)

# 7. anyone relays it
cast send $BRIDGE_B \
  'execute((uint64,uint64,uint64,address,address,address,address,uint256),(uint8,bytes32,bytes32)[])' \
  "$T" "[(27,0x..,0x..),(28,0x..,0x..)]" --private-key $ANY_KEY --rpc-url $RPC_B
```

---

## Deployment checklist — going live on a remote chain

Work top to bottom. Do not skip the dry run.

**Before you touch a public RPC**

1. `forge test` is 335/335 green on the exact commit you are shipping.
2. `forge build --sizes` shows `FerminuxBridge` under 24,576 B on that commit.
3. Confirm the target chain accepts Paris bytecode (every mainnet does; a fork
   older than Paris does not — check before, not after).
4. Run `bash script/devnet-e2e.sh` against the target chain id: edit `CHAIN_B`
   and `--chain-id` on the second anvil to the real remote chain id, and confirm
   the full A→B→A round trip passes locally first.

**Keys and roles — decide these before deploying, they are constructor args**

5. `BRIDGE_OWNER` is a **multisig**, on both chains. On Ferminux this is
   `MinimalMultisig` (2-of-3) at `0x910BD467D8576277f8f96DF47428377FFD94fEfe`;
   on the remote chain deploy or reuse an equivalent. An EOA owner is a single
   point of total failure — do not ship one.
6. Three validator addresses, on **three separate machines**, with **three
   separate key custodians**. Validators must not share a host, a cloud account
   or a backup. `BRIDGE_THRESHOLD=2`.
7. A `BRIDGE_PAUSER` hot key on a machine that is monitored 24/7, separate from
   the validators. This key's only power is to stop the bridge — treat losing it
   as an availability incident, not a security one.
8. `FEE_COLLECTOR` — the treasury multisig, not an EOA.
9. `TIMELOCK_DELAY=172800` (48h) for production. Anything shorter needs a written
   reason.

**Deploy**

10. Deploy the bridge on **both** chains before registering anything:
    ```sh
    DEPLOYER_KEY=… BRIDGE_OWNER=… FEE_COLLECTOR=… \
    BRIDGE_VALIDATOR1=… BRIDGE_VALIDATOR2=… BRIDGE_VALIDATOR3=… \
    BRIDGE_THRESHOLD=2 FEE_BPS=10 TIMELOCK_DELAY=172800 BRIDGE_PAUSER=… \
      forge script script/DeployBridge.s.sol --rpc-url <RPC> --broadcast
    ```
11. Record both addresses and both `DOMAIN_SEPARATOR()` values. The validator
    software must pin them; a validator that signs against an unpinned bridge
    address is a validator that can be phished into signing for an attacker's
    deployment.
12. Verify the source on both explorers (Blockscout on Ferminux:
    `https://explorer.ferminux.net`).

**Wrappers**

13. Deploy one `BridgeToken` per asset that is canonical on the *other* side,
    mirroring `name` / `symbol` / `decimals` **exactly** — a decimals mismatch
    silently mis-prices every transfer.
14. Check `BridgeToken.bridge()` equals the bridge on that chain, and
    `originChainId` / `originToken` point at the real canonical asset.

**Registration — the mirror must be exact**

15. **First**, on each chain, queue `setRemoteBridge(<other chain id>, <other
    bridge address>)` and let it mature. Nothing can be registered for a chain
    whose counterpart bridge is unrecorded — registration reverts with
    `BRIDGE: remote bridge unset`, on purpose, because `send()`'s bad-recipient
    guard is built on that value. Read both back with
    `remoteBridge(uint64)` before going further; the two bridges are ordinary
    `CREATE` deployments and their addresses are **not** the same.
16. For each route, the two registrations must be mirror images:

    | | chain A | chain B |
    |---|---|---|
    | localToken | `X` | `wX` |
    | kind | CANONICAL | WRAPPED |
    | remoteChainId | B | A |
    | remoteToken | `wX` | `X` |

    If they do not mirror, `execute()` reverts with `BRIDGE: token mismatch` or
    `BRIDGE: bad src chain` and the route is simply dead — funds are not at risk,
    but transfers will strand until it is fixed.
17. Read each CANONICAL token's `transfer` / `transferFrom` path before you
    register it, and answer three questions:
    1. Does the amount credited to `to` ever differ from the amount passed in?
    2. Does the payer's balance ever fall by more than the amount passed in?
    3. Can any balance change with no transfer at all (a rebase, an index, an
       `airdrop`/`reflect` entry point)?

    **No, no, no → register it. Any yes → do not.** There is no class, flag or
    setting that makes a taxed or rebasing token work here — see
    [Settlement](#settlement). If you cannot read the source at all (unverified
    contract, a proxy you cannot follow) the answer is also do not register it:
    the contract cannot detect either shape for you, and registration is
    once-only.
18. Start with **small caps**. A sane opening posture is `maxPerTransfer` ≈ one
    day of expected volume and `dailyCap` ≈ 3–5× that. Remember cap *increases*
    take 48h, so plan the ramp; cap *decreases* are instant, so erring small is
    free.
19. Queue every registration, wait the full 48h, then execute. Use the window:
    publish the queued action id and the calldata so users and validators can
    audit what is about to change.

**Before announcing**

20. Move a dust amount end to end, both directions, with the real validator set.
21. Confirm `lockedBalance(token)` on the canonical side equals
    `totalSupply()` of the wrapper on the other side.
22. Deliberately test the brakes on mainnet: `pause()` from the pauser key,
    confirm `send`/`execute` revert, `unpause()` from the multisig. A circuit
    breaker nobody has ever pulled is not a circuit breaker.
23. Set up monitoring that alerts on: any `Sent` without a matching `Executed`
    within N minutes, any `Executed` without a matching `Sent` on the other side
    (**this is the compromise signal — page immediately**), inbound volume above
    50% of `dailyCap`, and any `ActionQueued`.
24. Write down who is allowed to pull `pause()` and how they are reachable at
    03:00. Put it somewhere that is not this repository.

**After launch**

25. Fees accrue in the bridge until `withdrawFees(token)` is called. Sweep on a
    schedule; unswept fees are just idle balance, not at risk.
26. Rotate validators through the timelock, one at a time, never dropping the
    honest set below `threshold`.
27. Re-run `forge test` before any redeploy. A bridge is not a place to ship an
    untested diff.
