# Ferminux Bridge — Security model

Written for someone deciding whether to put their own money through this bridge,
or whether to operate it. It states the trust assumptions in full, bounds the
loss for each realistic compromise, and names the weaknesses that have no fix in
this design.

Everything here is checked against the contracts in
[`../contracts/src`](../contracts/src) as shipped. Function names, revert strings
and defaults are quoted verbatim from the code.

---

## 1. Trust assumptions, stated in full

You are trusting, in descending order of how much damage a breach does:

| # | You trust | If it fails | Time to loss |
|---|---|---|---|
| 1 | The **owner multisig** (2-of-3 `MinimalMultisig` on Ferminux, an equivalent on each remote chain) | total loss of everything bridgeable, by appointing hostile validators and raising caps | **~48 h**, publicly announced by `ActionQueued` |
| 2 | **M of N validators** do not collude and are not simultaneously compromised (default **2 of 3**) | fraudulent mints and releases, bounded by the caps and by locked collateral | **minutes**, bounded per token per day |
| 3 | The **contracts** are correct | anything up to total loss, depending on the bug | immediate |
| 4 | The **source chain** does not reorganise deeper than the confirmation policy | wrapped supply exceeds collateral; wrapped holders eat the shortfall | one reorg |
| 5 | Somebody is **watching and reachable** to pull `pause()` | the bounded bleed keeps bleeding, one cap per day, indefinitely | hours to days |
| 6 | The **registered token contracts** behave like plain ERC-20s | that route's collateral accounting breaks | varies |
| 7 | The **pauser** hot key is available | the fast brake is missing when you need it | availability only |

Assumption 1 dominates. No amount of validator decentralization matters if the
owner multisig can replace the validator set — it can, on 48 hours' notice.
**The timelock does not remove that power; it makes the power observable before
it is used.** That is worth a great deal, and it is not the same thing as
safety.

---

## 2. What ONE compromised validator can do

**Nothing.** Not "little" — nothing at all, under the default 2-of-3.

A validator's only capability is to produce an EIP-712 signature over a transfer
struct. It has no admin function, no pause power, no ability to move funds
outside a transfer that a quorum signed. Specifically it cannot:

| Attempt | Blocked by |
|---|---|
| execute with its single signature | `BRIDGE: not enough signatures` (`sigs.length >= threshold`) and `BRIDGE: below threshold` (distinct recovered signers) |
| submit its own signature twice to fake a quorum | `BRIDGE: duplicate signer` — `_verifySignatures` de-duplicates recovered addresses |
| flip `s` → `n − s` to manufacture a second, different-looking signature from the same key | `BRIDGE: malleable signature` — `_recover` rejects `s > HALF_CURVE_ORDER` |
| reuse a signature it made for another chain | the EIP-712 domain binds `chainId` of the **destination**, so the signature recovers to a stranger, is not counted, and the bundle falls `BRIDGE: below threshold` |
| reuse a signature on a different deployment of the same bridge | the domain binds `verifyingContract = address(this)` |
| replay a transfer that already landed | `BRIDGE: already processed` — set **before** any value moves |
| change any configuration | validators are not `owner`, not `onlySelf`, not `isPauser`. There is no validator-callable admin path at all |
| pause or unpause anything | `BRIDGE: not pauser` |

Proven in `test_Sig_DuplicateSignerCannotReachThreshold`,
`test_Sig_MalleableTwinOfTheSameSignerIsRejected`,
`test_Sig_RejectsSignatureFromAnotherChainId`,
`test_Sig_RejectsSignatureForAnotherBridgeAddress`,
`test_Sig_RejectsBelowThreshold` and `test_TwoChain_ReplayOnTheCorrectChainStillFails`.

**But:** with 2-of-3, one compromised key means you are **one key away from
total quorum**. Treat a single validator compromise as a red alert, not a
shrug — see the decision tree in [operations.md](operations.md#7-pauseunpause-decision-tree).

---

## 3. What M colluding validators can do

This is the real threat and the reason the caps exist. A quorum can sign a
transfer that never happened, because **`execute()` cannot check the source
chain.** It verifies signatures, the registry, the caps and the replay set —
nothing else.

### The two branches are bounded differently, and the difference matters

| Destination token kind | Fraud path | Hard ceiling |
|---|---|---|
| `CANONICAL` | release collateral to themselves | `min(caps, lockedBalance[token])` — `lockedBalance -= amount` underflows and reverts past that. **They cannot take more than the bridge ever held.** |
| `WRAPPED` | mint IOUs out of nothing | **the caps only.** There is no supply ceiling on the mint branch |

That asymmetry is important and under-appreciated: a colluding quorum minting
`wFMX` on a remote chain is not limited by how much FMX is locked on Ferminux.
They mint up to the cap and sell into whatever liquidity exists. **The damage
to a DEX pool can exceed the bridge's own collateral**, and the people harmed
are wrapped-token holders and liquidity providers, not just the bridge.

### How much, exactly

Per token, per direction, the throughput ceiling is:

```
first 24 h from an empty bucket :  2 × dailyCap
every 24 h after that           :  1 × dailyCap
single transaction              :  maxPerTransfer
```

The 2× is not a typo and not a bug — it is what the draining-bucket arithmetic
gives. `_consume` decays the running total to zero over 24 h; an attacker fills
the bucket once, then tops it up as fast as it drains. Simulated against the
contract's exact integer arithmetic with 7-second top-ups: **2.0000 × in hours
0–24, 1.0000 × in hours 24–48.** Size caps against 2×.

Total first-day exposure to a validator quorum compromise:

```
LOSS_day1  ≈  Σ over registered tokens on that chain of
                 min( 2 × dailyCap_token , releasable_or_mintable_token )
```

Worked example — the recommended opening posture from
[operations.md](operations.md#5-setting-caps-for-a-launch), FMX at the $0.53
launch reference:

| Token | Side | `dailyCap` | 2× | Exposure |
|---|---|---|---|---|
| FMX (canonical, Ferminux) | release | 25,000 FMX | 50,000 FMX | ≤ locked, ≤ ~$26.5 k |
| wFMX (wrapped, remote) | mint | 25,000 FMX | 50,000 FMX | ~$26.5 k of unbacked IOUs |
| **Total, day one, one route** | | | | **~$53 k** |

Then ~$26.5 k per side per day until someone pauses. That is the number to
compare against "how fast can we be woken up at 03:00" — not a theoretical
maximum, an operating budget.

### What the quorum still cannot do

- touch a token that is **paused** — `pauseToken()` is one transaction from a
  hot key with no delay
- raise a cap, add a validator, lower the threshold or list a new token — all
  fifteen privileged entry points are `onlySelf` (or, for `rescue`, self-only for
  a registered token), reachable only through `queue()` + 48 h +
  `executeAction()`, and only from the owner
- release a canonical asset past `lockedBalance`
- take `accruedFees` — fees are never collateral and are never released
- change the fee, the collector, the timelock or the owner

### The honest containment story

Containment is **`pause()`, immediately** — not validator removal.
`removeValidator` is timelocked at 48 h **by design**, so a known-compromised
key remains a valid signer for two days. The fast levers, in order of
reversibility:

| Lever | Speed | Who | Reversible by |
|---|---|---|---|
| `pauseToken(token)` | instant | pauser or owner | `unpauseToken()`, owner, **instant** |
| `pause()` | instant | pauser or owner | `unpause()`, owner multisig, **instant** |
| `decreaseTokenLimits(token, small, small)` | instant | owner | only `setTokenLimits`, which is **timelocked 48 h** |

**Read that last row twice.** Cutting a cap is instant; putting it back is not.
`decreaseTokenLimits(token, 0, 0)` is effectively a 48-hour freeze of that
route with no fast undo. When you want a reversible brake, use `pauseToken`.
Use cap cuts when you intend to stay small for days.

---

## 4. What a compromised owner multisig can do

Everything, eventually — with 48 hours of public warning.

**Instantly** (no timelock):

| Function | Damage |
|---|---|
| `pause()` / `pauseToken()` | denial of service. Funds safe, bridge dead |
| `decreaseTokenLimits()` | denial of service for 48 h (restoring is timelocked) |
| `setPauser(attacker, true)` | more hands on the DoS switch |
| `rescue(token, to, amount)` — **UNREGISTERED tokens only** | an asset this bridge does not route: no collateral is denominated in it, so its whole balance is surplus and there is nothing to protect. For a **registered** token `rescue` is timelocked (`BRIDGE: timelocked`) and appears in the 48 h list below |
| `withdrawFees(token)` | fees only, and only while solvent — `BRIDGE: impairs collateral` refuses the sweep once `balance < lockedBalance + fees`. `setFeeCollector` is timelocked and cannot be the bridge itself, so the destination is the *current* collector and fees can never be laundered into rescuable surplus |
| `cancelOwnershipTransfer()` | revokes a pending handover. A *safety* power, deliberately instant |
| `cancelWrapperBridgeRotation(token)` | revokes a pending wrapper-minter handover. Same reasoning. Calls into an address the owner names, so it is `nonReentrant` |
| `adoptWrapper(token)` | takes up minter rights a previous bridge offered. Inert on its own: nothing mints or burns an unregistered token, and `registerWrapped` is timelocked. `nonReentrant`, and gated on the codehash pin so the callee is audited `BridgeToken` code rather than an arbitrary address |

**After 48 hours** (queue → wait → `executeAction`):

0. `transferOwnership(attacker)` — the handover is itself timelocked, so it
   announces itself like everything else, and `acceptOwnership()` from the
   attacker is still required afterwards
1. `addValidator` × as many as needed, and/or `setThreshold(1)`
2. then sign anything, and drain every route up to the caps
3. `setTokenLimits` to raise those caps as high as `type(uint128).max`
4. `allowShortDelivery(transfer)` — authorises **one named inbound transfer**
   to settle short. It is the narrowest privileged action in the contract and it
   moves nothing by itself: the value only moves when that exact transfer is
   executed through the ordinary `execute()`, which still demands a full
   validator quorum over its EIP-712 digest. The owner cannot mint a transfer,
   cannot redirect one (the `transferId` commits to token, recipient, amount,
   both chain ids and the nonce), cannot pay out more than that transfer's own
   amount (`paid <= amount`), cannot deliver *nothing* (both balance deltas must
   be strictly positive), and cannot leave the authorisation standing (it is
   single-use, one at a time, and `cancelShortDelivery()` revokes it instantly).
   Worst case with a compromised multisig AND a compromised quorum: one already
   signed recipient receives less than they were promised, on a token that is
   short-changing transfers anyway. Wrapped and native targets are refused
   outright
4b. `rescue(token, to, amount)` for a **registered** token — still capped at
   `surplusOf(token)`, but now behind the timelock, because the surplus of a
   routed asset is a derived figure and an instant exit is what would turn any
   accounting defect into a withdrawal
5. `setRemoteBridge(chain, wrong address)` — re-opens the origin-side
   bad-recipient guard by pointing it somewhere harmless. It cannot *create* a
   loss on its own: `execute()` on the destination still refuses to pay the
   destination bridge, so the outcome is a stranded transfer, not a theft
6. `setFeeBps(100)` — 1.00 % is the ceiling, `MAX_FEE_BPS` is a `constant`, not
   governance-settable
7. `setTimelockDelay(3600)` — the minimum is `MIN_TIMELOCK_DELAY = 1 hours`, and
   shortening the delay must itself serve the *current* delay

What bounds this is entirely procedural:

- every queued action emits `ActionQueued(actionId, selector, data, eta)`
  **48 hours before it can fire** — monitor it, because it is the single
  highest-value alert in the system
- `queue()` accepts **only fifteen whitelisted selectors**
  (`registerCanonical`, `registerWrapped`, `setTokenLimits`, `addValidator`,
  `removeValidator`, `setThreshold`, `setFeeBps`, `setFeeCollector`,
  `setTimelockDelay`, `transferOwnership`, `proposeWrapperBridge`,
  `setBridgeTokenCodehash`, `setRemoteBridge`, `allowShortDelivery`,
  `rescue`). Queuing `send`, `withdrawFees`, `pause` or an arbitrary call
  reverts with `BRIDGE: not timelockable`. The timelock is not an arbitrary-call
  machine, which is exactly what made several historical bridge governance
  compromises instant. `rescue` is on the list because a **registered** token's
  surplus may only leave that way; it is still capped at `surplusOf(token)` when
  it fires, so the delay is a second lock and never a replacement for the first
- a queued action goes stale `GRACE_PERIOD = 72 hours` after its eta
  (`BRIDGE: action stale`). Deliberately short: `ActionQueued` fires **once**, at
  queue time, so a long grace period would let a matured action be held until that
  alert had aged out of everyone's attention and then fired with no fresh warning.
  72 h keeps a loaded action inside the same operational window as its own
  announcement — holding it longer forces a re-queue, which re-announces
- `pendingOwner` expires `OWNERSHIP_ACCEPT_WINDOW = 14 days` after the handover
  lands (`BRIDGE: offer expired`), and `cancelOwnershipTransfer()` revokes it at
  any time. An abandoned handover is no longer a standing takeover key
- users who see a hostile `ActionQueued` have 48 hours to bridge out, **if they
  are watching**, and if the bridge has not also been paused

**The honest summary: the owner multisig is the single point of total failure.
Its key custody is the most important control in this entire system — more
important than the validator set.**

---

## 5. Reorg risk per chain

A reorg is dangerous in exactly one direction: **the source chain dropping a
lock from its history after the destination has already credited it.** The
destination reorging is not a loss — the `execute()` transaction simply is not
in the surviving history and can be re-submitted with the same signatures.

There is no on-chain protection. Confirmation depth is a **validator policy**,
enforced by the validator daemon, not by `FerminuxBridge.sol`. A validator that
signs too early is the vulnerability.

| Chain | Finality | Recommended wait | Residual risk |
|---|---|---|---|
| **Ferminux (3961)** | Clique proof-of-authority, no finality gadget | **64 blocks (~7.5 min)**, the same depth as every node's reorg cap | **the weakest link** — signer-majority collusion or key compromise, see below |
| Ethereum (1) | Casper FFG, ~2 epochs | the `finalized` tag (~13–19 min) | economically final; reverting it costs a third of staked ETH |
| BSC (56) | fast finality (BEP-126) | the `finalized` tag; ~15 blocks as a fallback | small validator set, but attacks are on-record-slashable |
| Polygon PoS (137) | Heimdall milestones | the `finalized` tag (~1–3 min) | block-count waiting alone has historically been unreliable |
| Base / OP-stack | L1-derived | the `finalized` tag (~15–20 min) | soft-confirmed blocks are trivially reorged; a single sequencer can also censor |

### Ferminux is the weakest link, and pretending otherwise would be dishonest

Ferminux blocks are confirmed by an authorised signer set in rotation (Clique
proof-of-authority, since block 160,000; below that the chain was
proof-of-work). There is no finality gadget, and a reorg costs no work at any
depth: rewriting history takes a majority of the signers (3 of the 4 in the set on
2026-09-26) confirming a
competing branch, whether they collude or an attacker holds their keys. All
of them are operated by one party. A network partition does not get there on its
own: a signer may confirm at most one block in any run of three, so a side
holding two signers or fewer stalls within two blocks, and the reorg when the
partition heals is that shallow.

The attack against this bridge does **not** require any validator collusion:

1. lock FMX on Ferminux, wait out the confirmations
2. receive wFMX on the remote chain, sell it
3. reorg Ferminux to erase the lock, recovering the FMX

On Ferminux step 3 needs a signer majority. What stands between that and
unbacked wFMX is not work:

- **The node's reorg cap.** A node whose head is an authority block refuses a
  reorg deeper than 64 blocks (`FerminuxMaxReorgDepth`, lifted only by
  `--ferminux.allowdeepreorg`). A lock counts as settled once 64 blocks sit on
  top of it, so erasing a lock the validators have signed for means dropping
  more than 64 blocks — a rewrite the validators' own nodes refuse to follow.
- **Checkpoints.** With a `CheckpointRegistry` configured, a validator will not
  sign above the latest multisig-attested Ferminux block, and a different hash
  at that height is a critical alert
  ([relayer finality modes](../relayer/README.md#finality-modes)).
- **The cap.** Whatever gets past both is bounded by it:

```
value_extractable  =  2 × dailyCap_FMX  (the first-day ceiling)
must stay below
the loss the bridge can absorb if a signer majority acts against it
```

Concrete policy, and the one non-negotiable rule of operating this bridge:

- **Set the Ferminux-side `dailyCap` low enough that 2 × its market value is a
  loss the bridge can absorb if a signer majority rewrites Ferminux history.**
  No confirmation count prices that case; the cap is what bounds it. Re-check
  this every time the FMX price moves materially.
- Increase the confirmation depth, not the cap, when in doubt. Depth costs users
  minutes; cap costs the treasury money.
- Never register a route whose expected volume forces a cap that breaks the
  inequality above. Some assets should simply not bridge yet.

---

## 6. Contract-level risk

| Risk | Status | Mitigation, honestly |
|---|---|---|
| **Not independently audited** | no external firm, but two independent adversarial reviews on 2026-08-20 whose findings are all remediated and regression-tested | 289 tests (unit, fuzz, two-chain simulation, stateful invariants, red-team regressions), a recorded two-anvil end-to-end run, and small caps at launch. Tests are evidence, not proof. Budget for an audit before caps grow |
| **No upgrade path** | deliberate | no proxy, no `delegatecall`, no admin storage slot — the entire class of Nomad/Wormhole-style initialization and upgrade bugs is absent. **The cost: a bug cannot be patched.** The response to a contract bug is `pause()` and migrate. The *wrapped* side of a migration is supported: `proposeWrapperBridge` (timelocked here) plus `BridgeToken.ROTATION_DELAY = 48 h` plus `adoptWrapper` on the new bridge hands the minter seat over, so a v2 can register the existing wrappers and holders keep an exit that does not run through the abandoned contract. Without that rotation the wrapped supply would be permanently unredeemable the moment v1 was paused |
| **Migration is not a function** | true | collateral is `lockedBalance` and `rescue()` cannot touch it. Migrating a bridge that holds collateral means draining it by user action (everyone bridges home) or discretionary quorum-signed compensating transfers. Plan the migration path before you need it |
| **`transferId` does not bind the bridge address** | true | the *signing digest* does (EIP-712 `verifyingContract`), so signatures are not portable. But `processed[]` is per-deployment: after a migration, old `Sent` events from bridge v1 could be re-signed for bridge v2 and would execute. **Off-chain rule: after any migration, validators must refuse to sign any source event older than the migration block.** Write it into the validator config, not into a wiki |
| **Signatures never expire** | true | there is no `deadline` in `BridgeTransfer`. A signed-but-unrelayed transfer stays executable indefinitely, provided its signers are still validators and `threshold` has not risen |
| **Validator rotation can invalidate in-flight signatures** | partly | `isValidator[signer]` and `threshold` are read at execution time. A removed validator's signature stops **counting**, but it no longer poisons the bundle it sits in: extra signatures from non-validators are ignored and a bundle carrying a valid quorum still executes (`test_L2_StaleSignatureIsIgnoredAndTheQuorumInsideStillExecutes`). A bundle that only reached `threshold` **because** of the departed signer is stranded until re-signed (`test_Sig_RemovedValidatorNoLongerCounts`), and raising `threshold` still invalidates old quorums (`test_Sig_RaisedThresholdInvalidatesOldQuorum`). Drain the queue before rotating |
| **A verification bug would be fatal** | true | this is exactly how Wormhole lost $326 M. The mitigation here is not "we have no bugs" — it is that caps bound even a total verification failure to `2 × dailyCap` per token per day, and `pause()` stops it |
| **`chainid` is truncated to `uint64`** | true | no real chain id approaches 2⁶⁴; noted for completeness |
| **Native transfer uses a full-gas `call`** | true | reentrancy is blocked by `nonReentrant` and by `processed[transferId] = true` being set before the transfer |

---

## 7. Token-level risk

The registry is a trust boundary: registering a token is trusting its code.
Blast radius is contained to that token's route (accounting is per token), but
within that route it is total.

### 7.1 One settlement rule

There is exactly **one** supported token behaviour, and no switch anywhere that
relaxes it for an asset. Every value movement is measured on both sides:

```
paid      = how much the bridge's own balance fell
delivered = how much the recipient's balance rose
```

| Leg | Requirement | Otherwise |
|---|---|---|
| deposit (`send`, canonical ERC-20) | the bridge's balance rises by **exactly** `amount` | `BRIDGE: inexact transfer`, the whole deposit reverts, the depositor keeps their money |
| release (`execute`, canonical) | `paid == amount` **and** `delivered == amount` | `BRIDGE: inexact transfer` — the `transferId` is **not** consumed, `lockedBalance` is not written down, the 24 h cap is not spent |
| any payout that moved nothing, or delivered nothing | refused | `BRIDGE: transfer not settled` |
| any payout where `paid > amount` | refused | `BRIDGE: inexact transfer` |
| mint (`execute`, wrapped) | the recipient's balance rises by exactly `amount` | `BRIDGE: mint not settled` |
| burn (`send`, wrapped) | supply falls by exactly `net` | `BRIDGE: burn not settled` |

**There is no LOSSY class.** v1 briefly had one — a per-token, timelocked flag
that let a route settle for less. It was removed because its **deposit** half was
a fund-theft path, not a convenience: a reflection token can settle pooled
accrual into the bridge during `transferFrom`, the metered receipt is then larger
than the deposit, and crediting the measurement handed a depositor 200× what they
sent — against collateral belonging to other users on the counterpart chain.
A token class is also a standing permission granted on a one-time reading of code
that can change afterwards. Both problems are gone with the class.

### 7.2 When a route strands, and the one escape

A token that settled exactly while its collateral went in can start taxing its
transfers afterwards. From that instant:

* new **deposits** are refused (`BRIDGE: inexact transfer`), so the exposure stops
  growing — but note this is *unilateral*, not bilateral. Deposits on the OTHER
  chain (burning the wrapper to come home) are not affected, because the far side
  cannot see this token at all. If the far side is minting a wrapper against this
  collateral, `pauseToken` **both** sides, on both chains, or people will keep
  buying claims on a route that cannot pay;
* **releases** revert, retryably — nothing is silently short-paid, and no
  `transferId` is burned — but retrying forever is still a strand.

The escape is `allowShortDelivery(transfer)`: one named transfer, timelocked,
single-use, revocable, and loud at both ends. `ShortDeliveryAllowed` announces the
`transferId`, the token, the recipient and what is **owed** 48 h ahead;
`ShortDelivery` records `owed`, `paid` and `delivered` at settlement. It relaxes
only the two equalities — moved-nothing, delivered-nothing and `paid > amount`
are still refused — and it cannot move value on its own, because the transfer it
names still needs its validator quorum. Under the reflection shape the write-down
exceeds what the bridge parted with, so the residue becomes surplus; that residue
is reachable only through a **second** timelocked `rescue`.

Using it means a real user receives less than the amount they were signed for.
Publish the transferId and the arithmetic during the 48 h window. It is the last
resort, after `pauseToken` and after talking to the token's issuer.

| Token property | Consequence | Rule |
|---|---|---|
| **Rebasing / elastic supply** | balances change under the bridge with no transfer at all; `lockedBalance` is a raw-unit counter and drifts away from reality in both directions | **never register a rebasing token as canonical.** No settlement rule can repair this, so there is no class that makes it safe and nothing in the contract can detect it for you |
| **Blacklist / freeze (USDT, USDC)** | if the bridge address is blacklisted, every release reverts (`BRIDGE: transfer failed`) and the collateral is frozen indefinitely | accept it knowingly for stablecoin routes; keep caps small; know the issuer's process |
| **Fee-on-transfer / reflection / any tax** | **not supported. Refused on BOTH legs**, at the first transfer, with `BRIDGE: inexact transfer` — a revert, so nothing is consumed and nothing is silently short-paid | **do not register one.** There is no class or flag that makes it work; the round-2 attempt at one is documented above as a fund-theft path. If a token you already route turns hostile, see §7.2 |
| **Fee charged ON TOP of the amount** | each release would draw down the pool by more than it accounted for | **refused everywhere**, including inside the short-delivery escape: `_settle` requires `paid <= amount`. Do not register one |
| **Debits the payer, credits nobody** (100% burn-on-transfer, a blacklist that swallows instead of reverting) | the bridge-side balance read alone reads this as a successful delivery | **refused everywhere**, including inside the short-delivery escape: the recipient's balance delta is measured too, and must be strictly positive |
| **Recipient-side transfer hooks that forward the funds onward in the same call** (ERC-777 shape) | `delivered` is measured immediately after the call, so a hook that moves the funds on reads as "delivered nothing" | **refused.** Do not register one |
| **Cannot answer `balanceOf()`** | the whole settlement metering is built on that call | **refused at registration**: `registerCanonical` probes it |
| **More than 18 decimals** | cannot be mirrored — `BridgeToken` reverts with `WTOKEN: decimals` | route unsupported; do not improvise a scaling factor |
| **Decimals mismatch between sides** | silently mis-prices every transfer by orders of magnitude | verify `decimals()` on both sides before registering. AZNT is **6** decimals, not 18 |
| **Malicious / upgradeable token** | its author controls that route's collateral entirely | do not register tokens you cannot read the source of; prefer non-upgradeable |
| **Wrapper not controlled by the bridge** | would make inbound unfillable, and a wrapper that *lies* about minting would let the counterpart chain release real collateral against a burn that never happened | blocked in three places. (1) `registerWrapped` pins the wrapper's runtime bytecode to `bridgeTokenCodehash` — a `bridge()` view returning the right address proves nothing, since any contract can return anything and a proxy can pass on Monday and defect on Tuesday. The pin rejects every proxy, is unset (and therefore fails closed, `BRIDGE: wrapper pin unset`) on a fresh deployment, and changing it is itself timelocked. (2) that pinned code must still name this bridge as minter, or `BRIDGE: not the minter`. (3) at call time, `send`/`execute` verify mint and burn by **measured supply/balance delta** — `BRIDGE: burn not settled` / `BRIDGE: mint not settled` — so a wrapper that returns success without acting reverts instead of silently consuming a transferId. (4) the minter seat can only be rotated to a **contract that answers `BRIDGE_INTERFACE_ID()` with `keccak256("FerminuxBridge.v1")`**, so the owner cannot point a live wrapper's minter at a bare key; and `adoptWrapper` / `cancelWrapperBridgeRotation`, which call into an address the owner names, are both `nonReentrant`, with `adoptWrapper` additionally gated on the codehash pin |

---

## 8. Availability and griefing (funds safe, service not)

| Vector | Effect | Notes |
|---|---|---|
| Pauser key stolen | attacker pauses at will; only the owner multisig can `unpause()` | availability incident, not a security one. Rotate with `setPauser` (instant) |
| Relayer/submitter down | transfers sit signed but unrelayed | `execute()` is permissionless — anyone with the signatures can submit. Publish signatures so users are not hostage to one relayer |
| Validator daemons down | nothing gets signed; the bridge stalls | under 2-of-3, one down is survivable; two down is an outage |
| **Cap griefing** | an attacker fills a token's inbound or outbound 24 h bucket with their own transfers, blocking everyone else. One actor can hold **both** buckets at once by round-tripping their own capital — the outbound leg is what fills the inbound bucket when the value comes home — so the route shuts in both directions | priced, not hand-waved: **cost to deny a route for a day = 2 × `feeBps` × `dailyCap`**, i.e. 0.2 % of one `dailyCap` per day at the default 10 bps, with capital equal to one `dailyCap` and fully recoverable. Cheapest when the route is newest, because the cost scales with the cap. No clean on-chain fix exists — per-sender buckets are sybil-farmable — so it is handled as a cap-sizing input, a monitoring signature (both buckets > 80 % with one dominant counterparty) and a `setFeeBps` deterrent. See [operations §5](operations.md) for the table and §6 for the alert |
| Destination token paused mid-flight | transfers strand until unpaused | in-flight transfers survive a pause and resume (`test_TwoChain_InFlightTransferSurvivesAPauseAndResumes`) |
| Recipient contract rejects native coin | `BRIDGE: native transfer failed` forever for that transfer | requires a discretionary compensating transfer |
| **No refund path** | value that leaves via `send()` returns only via a quorum-signed `execute()` | the mechanism that rescues a stuck transfer is the same one a colluding quorum abuses. It cannot be removed without removing recovery |
| Validators have **no bond** | no slashing, no economic penalty for misbehaviour | reputational and legal only. This is a real gap versus staked-validator designs |

---

## 9. Historical bridge failures, and what this design does about each

Figures are the widely reported ones, rounded. The point is the root cause, not
the number.

| Incident | Date | Loss | Root cause | What this design does |
|---|---|---|---|---|
| **Ronin** | Mar 2022 | ≈$624 M | 5 of 9 validator keys obtained — 4 from one operator's own infrastructure, plus a third-party validator that had been allow-listed to sign on that operator's behalf and never revoked. **Unnoticed for six days.** | Validators must run on **separate machines under separate custodians** ([operations.md §3](operations.md#3-validator-key-generation-ceremony)) — key concentration is the failure, not key count. Per-token `maxPerTransfer` and rolling `dailyCap` would have bounded the drain instead of allowing it in two transactions. Mandatory alert on **`Executed` with no matching `Sent`** — the six-day silence is the part that turned a breach into a catastrophe. No delegated or standing signing authority exists in this design |
| **Wormhole** | Feb 2022 | ≈$326 M | Signature verification could be bypassed: the Solana contract failed to validate the sysvar account passed to `load_instruction_at`, so a spoofed "verified guardian signatures" instruction was accepted and 120,000 wETH was minted with no deposit | Honestly: **a verification bug here would be just as fatal.** The mitigations are bounding and stopping, not immunity — caps limit a total verification failure to `2 × dailyCap` per token per day, `pause()` is instant, and the signature path is deliberately tiny (`ecrecover`, malleability rejection, distinct-signer counting) with 46 dedicated tests in `BridgeExecute.t.sol`. Also: the mint branch is reached only for tokens registered `WRAPPED` through a 48 h timelock |
| **Nomad** | Aug 2022 | ≈$190 M | A routine upgrade re-initialized the trusted root to `0x00`, making every message "already proven". The drain was permissionless copy-paste — hundreds of addresses joined | **No proxy, no upgrade path, no initializer, no trusted-root storage slot.** Constructor-only configuration, `immutable` where possible. The entire bug class is structurally absent. Registration is once-only (`BRIDGE: already registered`) and timelocked |
| **Harmony Horizon** | Jun 2022 | ≈$100 M | A **2-of-5** multisig guarded the bridge; two hot keys were compromised at once | Same shape as the default 2-of-3 here — **this design is not immune, it is smaller and more honest about it.** Mitigations: caps bound the per-day loss (Harmony had none), the owner multisig cannot be reached by validators, and the documented policy is to raise to **3-of-5 as TVL grows** (`addValidator` × 2 then `setThreshold(3)`, 48 h each). Until then, treat caps as the real control |
| **BNB Chain Token Hub** | Oct 2022 | ≈$570 M authorised, ≈$110 M extracted before the chain was halted | Forged IAVL Merkle proof accepted by a light-client verifier | This design has **no proof verifier** — a smaller attack surface, bought by accepting explicit validator trust instead. The tradeoff is stated in [how-it-works.md §5](how-it-works.md#5-what-validator-secured-honestly-means), not hidden. Note the other lesson: the loss stopped only because a chain could be halted. A bridge that cannot halt its own chain needs its own halt — that is `pause()` |
| **Multichain** | Jul 2023 | ≈$126 M | "MPC" key shares were effectively under one person's control; funds moved after that person was detained. Operational centralization dressed as cryptographic decentralization | Validator identity and custody separation are an **operational requirement with a written ceremony record** ([operations.md §3](operations.md#3-validator-key-generation-ceremony)), not a marketing claim. If all three validators are ultimately controlled by one person or one company, this bridge is a 1-of-1 multisig with extra steps — and it should be described that way |

The pattern across all six: **the contract logic was rarely the whole story.
Key custody, monitoring latency, and upgrade machinery were.** That is why
[operations.md](operations.md) is longer than this document.

---

## 10. What this design explicitly does NOT protect against

Stated plainly so nobody discovers it later:

1. **Collusion of M validators.** Bounded by caps, not prevented. No slashing,
   no bond, no fraud proof, no challenge window.
2. **Compromise of the owner multisig.** Total loss on a 48 h delay.
3. **A bug in `FerminuxBridge.sol` or `BridgeToken.sol`.** Unaudited.
4. **A deep reorg of the source chain past the confirmation policy**, which on
   Ferminux is a question of whether a signer majority acts against the bridge,
   not a cryptographic one.
5. **A malicious or broken registered token.** Contained to its route, total
   within it.
6. **Loss of a wrapped asset's market.** A wrapper with no liquidity is a claim
   you can only realise by bridging home.
7. **User error.** A wrong `recipient` is signed into the transfer and is final.
8. **Censorship.** Validators can simply decline to sign. There is no forced
   inclusion and no permissionless exit for a locked asset.
9. **Regulatory or issuer action** against a canonical asset (blacklisting the
   bridge address freezes that route's collateral).
10. **Correlated infrastructure failure** — three validators on one cloud
    provider, one region, or one operator's laptops are one validator.

---

## 11. Residual risk, in one paragraph

With the default 2-of-3, a 48 h timelock, the recommended opening caps and a
monitored pauser key, the realistic worst case that does not involve the owner
multisig is: **two validator keys compromised simultaneously, roughly 2 ×
`dailyCap` per token drained in the first 24 hours and 1 × `dailyCap` per day
thereafter until a human pauses the bridge.** With the recommended launch caps
that is on the order of tens of thousands of dollars per route per day, not
millions — which is the entire point of launching small. The worst case that
does involve the owner multisig is total loss with 48 hours of on-chain warning.
Everything in [operations.md](operations.md) exists to make those 48 hours, and
those first hours after an alert, actually count.

---

## See also

| Doc | For |
|---|---|
| [how-it-works.md](how-it-works.md) | the user-facing explanation, fees, caps and timings |
| [operations.md](operations.md) | key ceremony, caps, monitoring, incident response |
| [deploy-remote-chain.md](deploy-remote-chain.md) | adding a new EVM chain safely |
| [`../contracts/README.md`](../contracts/README.md) | contract-level detail and the test inventory |
