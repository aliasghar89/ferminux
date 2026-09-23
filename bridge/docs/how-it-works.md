# How the Ferminux Bridge works

This explains what actually happens when you move an asset between the Ferminux
Network (ChainID **3961**, native coin **FMX**) and another EVM chain, what it
costs, how long it takes, what the limits are, and — the part most bridge
documentation skips — **who you are trusting and what happens if they betray you.**

Read [security-model.md](security-model.md) before moving an amount you would
mind losing.

---

## 1. The one idea: an asset never actually moves

Nothing is teleported. A chain cannot see another chain. What a bridge does is
**freeze value on one side and issue a claim on the other**, then reverse that
when you come home.

Every token the bridge knows about is registered as exactly one of two kinds on
each chain, and that registration decides everything:

| Kind | Means | Leaving this chain | Arriving on this chain |
|---|---|---|---|
| `CANONICAL` | the real asset lives **here** | **LOCK** it in the bridge | **RELEASE** it from the bridge |
| `WRAPPED` | this is an **IOU** for an asset that is canonical elsewhere | **BURN** it | **MINT** it |

`address(0)` is the chain's native coin — FMX on Ferminux, ETH on Ethereum, BNB
on BSC — and is always canonical on its own chain.

So a round trip of FMX to BSC is:

```
   FERMINUX (3961)                                   BSC (56)
   ──────────────                                    ────────
1. you send 10 FMX  ──▶  LOCKED in the bridge
                              │
                              │  validators attest
                              ▼
2.                                          MINT 9.99 wFMX to you   ← an IOU
                                                    │
3. you use / trade / hold wFMX on BSC               │
                                                    │
4.                                          BURN your wFMX  ◀───────┘
                              │
                              │  validators attest
                              ▼
5. RELEASE FMX from the bridge  ──▶  back in your Ferminux wallet
```

The invariant the whole design exists to protect:

> **wFMX in circulation on BSC ≤ FMX locked on Ferminux.** Always.

You can check it yourself at any time, with no permission and no API:

```sh
# what the bridge on Ferminux owes
cast call $BRIDGE_FERMINUX "lockedBalance(address)(uint256)" \
  0x0000000000000000000000000000000000000000 --rpc-url https://rpc.ferminux.net

# what exists on the other side
cast call $WFMX "totalSupply()(uint256)" --rpc-url $RPC_BSC
```

If the second number is ever bigger than the first, the bridge is
undercollateralized and something has gone badly wrong. Say so loudly.

### The wrapped token is not the real asset

`wFMX` on BSC is an ERC-20 (`BridgeToken`) whose supply is controlled entirely by
the bridge contract on BSC. It has no owner, no owner-mint, no pause and no
upgrade path — only the bridge can `mint` or `burn`, and `burn` moves nothing you
have not approved it to spend: it debits your allowance exactly as `transferFrom`
would. That constraint lives in the token, not in the bridge's good manners, so
you can verify it without reading the bridge and without trusting that the bridge
is never replaced. A hostile bridge — including one installed by a rotation —
cannot burn tokens nobody approved it to spend. It
mirrors the origin asset's `name`, `symbol` and `decimals`, and it records
`originChainId()` and `originToken()` on-chain so a wallet can prove which asset
it claims to represent.

But it is still a claim. **Its value is entirely the promise that the collateral
on the origin chain is still there and still releasable.** If the bridge on
Ferminux is drained, wFMX is worth zero no matter how healthy BSC is.

---

## 2. The journey of one transfer, step by step

### Step 1 — you call `send()` on the source chain

```solidity
send(address localToken, uint256 amount, uint64 dstChainId, address recipient)
  returns (bytes32 transferId)
```

- Native coin: `localToken = address(0)` and `msg.value = amount`
  (mismatch reverts with `BRIDGE: bad msg.value`).
- ERC-20, canonical or wrapped: `approve()` the bridge first, then call with
  `msg.value = 0` (sending value reverts with `BRIDGE: unexpected value`). A
  canonical token is pulled with `transferFrom`; a wrapped one is burned against
  the same allowance. Either way, without the approval you get
  `WTOKEN: burn exceeds allowance` or an ERC-20 allowance failure. **There is no
  permit-based one-transaction path — any token send is two transactions.**
- `dstChainId` must be the one chain that token is registered against, or
  `BRIDGE: bad dst chain`.

The bridge locks (canonical) or burns (wrapped), takes the fee, and emits:

```
Sent(transferId, dstChainId, localToken, srcChainId, nonce,
     remoteToken, sender, recipient, amount, fee)
```

`amount` in the event is the **net** amount that will arrive. `fee` is what was
kept. Both are in the source token's units.

Your `transferId` is
`keccak256(abi.encode(srcChainId, dstChainId, nonce, srcToken, dstToken, sender, recipient, amount))`
— globally unique, because both chain ids and the source bridge's nonce are
inside it. Write it down; it is how you track the transfer.

**From this moment your value has left. There is no cancel and no refund
function.** See [§7](#7-what-can-go-wrong).

### Step 2 — validators wait for confirmations

Each validator independently watches the source chain for `Sent` events and
**waits a fixed number of block confirmations before signing anything.** This
wait exists for one reason: if the source chain reorganises and drops your
lock from its history after the destination has already minted, the bridge
becomes undercollateralized and everyone holding the wrapped asset eats the
loss.

Confirmation depth is a validator **policy** setting, not a contract rule. The
recommended policy:

| Source chain | Wait for | Wall clock | Why |
|---|---|---|---|
| Ferminux (3961) | 64 blocks | ~7.5 min | Clique proof-of-authority (five bonded signers), no finality gadget; 64 is the same depth at which every node refuses a reorg — this is the deepest wait for a reason, see [security-model.md](security-model.md#5-reorg-risk-per-chain) |
| Ethereum (1) | the `finalized` tag | ~13–19 min | two epochs; economically final, not probabilistic |
| BSC (56) | the `finalized` tag (fast finality) | ~45–75 s | falls back to ~15 blocks if the endpoint does not serve `finalized` |
| Polygon PoS (137) | the `finalized` tag (Heimdall milestones) | ~1–3 min | block-count waiting alone has been unreliable historically |
| Base / OP-stack (8453, 10) | the `finalized` tag | ~15–20 min | soft-confirmed L2 blocks are cheap to reorg until the L1 batch finalizes |

Anyone running a lower depth than this is trading your safety for a nicer
latency number on a landing page.

### Step 3 — validators sign, independently

Each validator recomputes the transfer from the `Sent` log — it does **not**
trust a relayer's version of it — and signs an EIP-712 digest:

- domain `name` = `"FerminuxBridge"`, `version` = `"1"`
- domain `chainId` = the **destination** chain
- domain `verifyingContract` = the **destination bridge address**
- struct = `TRANSFER_TYPEHASH` over `transferId` plus all eight transfer fields

That binding is the point: a signature made for BSC is worthless on Ferminux,
and a signature made for one bridge deployment is worthless for another. It is
proven in `test_Sig_RejectsSignatureFromAnotherChainId`,
`test_Sig_RejectsSignatureForAnotherBridgeAddress` and
`test_TwoChain_SignatureForBIsWorthlessOnA`.

### Step 4 — anyone relays it

```solidity
execute(BridgeTransfer calldata t, Signature[] calldata sigs)
```

`execute()` is **permissionless**. The bridge operators run a submitter so you
do not have to, but if every relayer in the world disappeared and you had the
signatures, you could submit the transaction yourself and pay the gas. The
signatures are the asset; the relayer is a convenience.

The destination bridge then, in this order:

1. rejects if the bridge is globally paused (`BRIDGE: paused`)
2. rejects if `t.dstChainId` is not this chain (`BRIDGE: wrong dst chain`)
3. rejects a replay (`BRIDGE: already processed`)
4. looks the destination token up in the registry and rejects if it is
   unregistered (`BRIDGE: token not registered`), paused
   (`BRIDGE: token paused`), or does not mirror the source exactly
   (`BRIDGE: bad src chain`, `BRIDGE: token mismatch`)
5. checks the caps — `BRIDGE: over per-transfer cap`, `BRIDGE: over 24h cap`
6. verifies the signatures — `BRIDGE: not enough signatures`,
   `BRIDGE: duplicate signer`, `BRIDGE: malleable signature`,
   `BRIDGE: below threshold`. A signature that does not recover to a *current*
   validator is ignored rather than fatal, so a bundle carrying a valid quorum
   plus one signature from a rotated-out validator still executes; the count is
   of DISTINCT current validators, so extras can never substitute for a quorum
7. marks the transfer processed **before** moving any value
8. releases (canonical) or mints (wrapped) to `recipient`

and emits `Executed(transferId, srcChainId, localToken, remoteToken, recipient, amount, signatureCount)`.

### Step 5 — done

Total wall clock, end to end, for a healthy bridge:

| Route | Confirmations | Signing + relay | Realistic total |
|---|---|---|---|
| Ferminux → BSC | ~7.5 min | ~10–30 s | **~8 min** |
| BSC → Ferminux | ~45–75 s | ~10–30 s | **~1.5–2 min** |
| Ferminux → Ethereum | ~7.5 min | ~15–60 s (gas-dependent) | **~9 min** |
| Ethereum → Ferminux | ~13–19 min | ~10–30 s | **~15–20 min** |

A transfer that has not arrived in **3× the number above** is not "slow", it is
**stuck**, and you should follow [§7](#7-what-can-go-wrong).

---

## 3. Fees

| | |
|---|---|
| Default fee | **10 basis points = 0.10 %** |
| Hard ceiling in code | `MAX_FEE_BPS = 100` = **1.00 %** — governance cannot exceed it, only a redeploy could |
| Charged | at the **origin** of each leg, deducted from the amount you send |
| Charged on arrival | **nothing** — `execute()` credits exactly the signed amount |
| Changing the fee | timelocked 48 h (`setFeeBps` behind `queue()`) — you always get notice |
| Gas | separate, paid by you on the source chain and by the relayer on the destination |

A **round trip pays the fee twice**, once per leg, each on the chain that leg
left from. Actual numbers from the recorded two-chain devnet run
(`bridge/contracts/script/devnet-e2e.sh`, 10 FMX at 10 bps):

| Step | Amount |
|---|---|
| you send | 10.000000000000000000 FMX |
| fee kept on Ferminux | 0.010000000000000000 FMX |
| wFMX minted on the far side | 9.990000000000000000 |
| you send all of it back | 9.990000000000000000 wFMX |
| fee kept on the far side | 0.009990000000000000 wFMX |
| FMX released back to you | **9.980010000000000000 FMX** |

Round-trip cost: 0.019990 FMX, i.e. **0.1999 %** — 10 bps each way, plus gas.

Two things worth understanding about where the fee lives:

- On a **canonical** send only the net amount becomes collateral
  (`lockedBalance += net`); the fee is booked separately in
  `accruedFees[token]` and can never be released to an inbound transfer.
- On a **wrapped** send the full amount is burned and the fee is re-minted to
  the bridge, so wrapped supply falls by exactly the net — which is exactly what
  gets released at home. The fee collected on the wrapped side is denominated in
  the **wrapped** asset; turning it into the real asset means bridging it home
  and paying a fee on that leg too.

Fees sit in the bridge until `withdrawFees(token)` is called by the fee
collector or the owner. Unswept fees are idle balance, not user collateral, and
`rescue()` cannot touch them either.

---

## 4. Limits

Two limits per token, per chain, enforced **on both directions**:

| Limit | Meaning | Revert if exceeded |
|---|---|---|
| `maxPerTransfer` | biggest single transfer | `BRIDGE: over per-transfer cap` |
| `dailyCap` | rolling-24 h volume, **separately** for outbound and inbound | `BRIDGE: over 24h cap` |

Read them live:

```sh
cast call $BRIDGE "tokenConfig(address)((uint8,bool,uint64,address,uint256,uint256))" $TOKEN --rpc-url $RPC
# -> (kind, paused, remoteChainId, remoteToken, maxPerTransfer, dailyCap)

cast call $BRIDGE "outboundUsage(address)(uint256)" $TOKEN --rpc-url $RPC
cast call $BRIDGE "inboundUsage(address)(uint256)"  $TOKEN --rpc-url $RPC
```

### The cap is a draining bucket, not a calendar day

A naive "reset at midnight" cap can be gamed by sitting on the boundary and
spending twice the cap in two minutes. Here the counter decays **linearly and
continuously** back to zero over `WINDOW = 24 hours`:

```
used_now = used − used × (now − updatedAt) / 24h        (exactly 0 after 24h)
```

| Time since the bucket was filled | Capacity available again |
|---|---|
| 30 min | ~2 % |
| 1 h | ~4 % |
| 6 h | 25 % |
| 12 h | 50 % |
| 24 h | 100 % |

There is no instant at which capacity jumps, so there is no boundary to camp on.

**Honest fine print on what the cap actually bounds.** It bounds the *sustained
rate* at one `dailyCap` per 24 h. It does **not** bound the first 24 hours at
one `dailyCap`: starting from an empty bucket you can fill it once and then keep
topping it up as it drains, which moves **up to 2 × `dailyCap` within the first
24 hours**, and 1 × `dailyCap` per 24 h thereafter. (Simulated directly against
the contract's arithmetic — 7-second top-ups give 2.0000 × in hours 0–24 and
1.0000 × in hours 24–48.) When you size a cap against "what could be stolen in a
day", size it against **2 ×** the number you write down. This is still strictly
better than a calendar reset, where the second cap becomes available in a single
instant rather than bleeding out over a day.

Outbound and inbound have **separate** buckets per token, so draining the exit
does not also drain the entrance.

---

## 5. What "validator-secured" honestly means

This is a **validator-secured** bridge, also called an externally-verified or
multisig bridge. Say it plainly:

> **The destination chain has no way to check that anything happened on the
> source chain. It only checks signatures. If 2 of the 3 named validators
> collude, they can mint or release assets that nobody ever locked, up to the
> caps, and no code in this repository can stop them.**

`execute()` does not — and cannot — verify that a matching `Sent` event exists.
It verifies signatures, the registry, the caps and the replay set. That is the
whole security surface.

### Compared with the alternatives

| Design | What the destination verifies | Trust | Cost / practicality |
|---|---|---|---|
| **This bridge (validator-secured)** | M-of-N signatures over the transfer | M named parties do not collude, and their keys are not stolen | works between any two EVM chains today; cheap; ~124k gas to execute |
| Light-client / ZK bridge | a proof of the source chain's consensus, on-chain | the source chain's own consensus, plus the proof system's soundness | needs a verifier for the source consensus on the destination chain; for Ferminux that means checking Clique signer signatures over its headers (~545k gas for a 5-header finality proof) |
| Optimistic bridge | a claim that nobody disproved within a challenge window | at least one honest watcher, and the window being long enough | adds a 30 min – several hour delay to every transfer |
| Liquidity network (no minting) | nothing; a market maker fronts the asset on the far side | the market maker's solvency, per transfer | no wrapped supply and no honeypot, but capital-limited and no new-asset issuance |

A light-client bridge to Ferminux would mean verifying Clique signer
signatures over Ferminux headers inside the destination EVM. That light client
is built and tested but not deployed ([PROOF-BRIDGE.md](PROOF-BRIDGE.md)), so
the live bridge accepts external verification and spends its effort on
**bounding the damage** instead of pretending the trust is not there.

### What you are actually trusting

1. That at least **N − M + 1** of the N validators (with the default 2-of-3:
   **2 of the 3**) stay honest and keep their keys safe.
2. That the **owner multisig** (2-of-3 on Ferminux,
   `MinimalMultisig 0x910BD467D8576277f8f96DF47428377FFD94fEfe`) is not
   compromised — it can, over 48 hours of public notice, appoint validators of
   its choosing.
3. That somebody is **watching**, because the caps only limit the bleed rate;
   stopping it requires a human to call `pause()`.
4. That the contracts do what this document says. They are covered by 289 tests
   including two-chain and invariant suites, and they are **not** independently
   audited at the time of writing.

Everything the caps, the timelock and the pause button buy you is a **bound on
the loss and a warning period**, not prevention. That is the honest ceiling of
this design.

---

## 6. What the bridge cannot do to you

Worth knowing, because it is the other half of an honest picture:

- **Nobody can burn your wrapped tokens but you.** `BridgeToken.burn` is
  callable only by the bridge, and the only bridge path that burns is inside
  `send()`, which always burns `msg.sender`. There is no confiscation entry
  point and no blacklist.
- **The wrapped token cannot be paused, upgraded or owner-minted.** It has no
  owner and no proxy.
- **The bridge cannot release more of an asset than it locked.** The release
  path does `lockedBalance[token] -= amount`, which reverts on underflow.
- **The operator cannot withdraw your collateral.** `rescue()` is capped at
  `surplusOf(token) = balance − lockedBalance − accruedFees` on every call, and
  reverts with `BRIDGE: exceeds surplus`. For a token the bridge actually routes
  it is timelocked as well, so even the surplus takes a public 48 h.
- **You are paid exactly the amount that was signed, or the release reverts.**
  Settlement is measured on both sides — the bridge's balance must fall by
  exactly the amount and yours must rise by exactly the amount. There is no token
  class or setting that relaxes it. The single exception is a per-transfer,
  timelocked, publicly announced `allowShortDelivery`, which exists only to free
  collateral trapped behind a token that started taxing its own transfers, and
  which names the exact transfer 48 h in advance.
- **A single validator can do nothing.** Submitting one validator's signature
  many times is rejected (`BRIDGE: duplicate signer`), and flipping `s` to
  produce a "different" signature from the same key is rejected as malleable.
- **Config cannot change without notice.** Caps up, validators, threshold, fee
  and new token listings are all behind a 48 h timelock and emit `ActionQueued`
  when scheduled.

---

## 7. What can go wrong

| Symptom | What it means | What to do |
|---|---|---|
| `send()` reverts `BRIDGE: over per-transfer cap` | your amount exceeds `maxPerTransfer` | split it, or wait for the cap to be raised (48 h notice) |
| `send()` reverts `BRIDGE: over 24h cap` | the rolling bucket is full | wait — capacity comes back continuously (see the table above) |
| `send()` reverts `BRIDGE: paused` / `BRIDGE: token paused` | the bridge or that token is halted | do not retry in a loop; check the operator's status channel |
| Sent but nothing arrived, under 3× the expected time | normal latency, or the relayer is behind | wait; verify with the checks below |
| Sent but nothing arrived, over 3× | **stuck.** The destination may be paused, cap-full, or the relayer is down | contact the operators with your `transferId` |
| You sent to a wrong `recipient` | the recipient is signed into the transfer and is final | **unrecoverable by contract.** Only a validator-quorum-signed compensating transfer could fix it, and that is a manual, discretionary act |
| The recipient is a contract that rejects native coin | `execute()` reverts `BRIDGE: native transfer failed` forever | the funds stay locked on the source side until the operators arrange a compensating transfer |

**There is no refund path in the contract.** Once `send()` succeeds, the only
way value comes back is a validator-signed `execute()` — on the destination for
the intended transfer, or on the source chain as a compensating transfer that a
quorum chooses to sign. That discretionary power is the same power a colluding
quorum would abuse; it cannot be removed without also removing the ability to
rescue a genuinely stuck transfer. Know that it exists.

### Checking a transfer yourself

```sh
# 1. Did the source chain accept it? (transferId is in the Sent log, topic 1)
cast receipt $TX_HASH --rpc-url $RPC_SRC

# 2. Has the destination executed it?
cast call $BRIDGE_DST "processed(bytes32)(bool)" $TRANSFER_ID --rpc-url $RPC_DST

# 3. Is the destination able to execute it right now?
cast call $BRIDGE_DST "paused()(bool)" --rpc-url $RPC_DST
cast call $BRIDGE_DST "inboundUsage(address)(uint256)" $DST_TOKEN --rpc-url $RPC_DST
cast call $BRIDGE_DST "tokenConfig(address)((uint8,bool,uint64,address,uint256,uint256))" \
  $DST_TOKEN --rpc-url $RPC_DST
```

`processed == true` means it arrived; look for the `Executed` log with your
`transferId` as topic 1 to see the recipient and amount.

---

## 8. Things this document does not promise

- That the contracts are bug-free. They are unaudited at the time of writing.
- That validators will not collude. Nothing on-chain prevents it above the
  threshold; the caps only bound it.
- That a transfer will complete in a given time. Liveness depends on validators
  and relayers being up, and on the destination not being paused or cap-full.
- That the Ferminux side cannot reorg. Ferminux blocks are confirmed by five
  bonded signers (Clique proof-of-authority) with no finality gadget; how deep a
  reorg can go, and why the relayer waits 64 blocks, is in
  [security-model.md](security-model.md#5-reorg-risk-per-chain).
- That wrapped assets have a market. A wrapper is only liquid if somebody makes
  it liquid.

---

## See also

| Doc | For |
|---|---|
| [security-model.md](security-model.md) | the full threat model, loss bounds and historical failures |
| [operations.md](operations.md) | running the thing: keys, caps, monitoring, incident response |
| [deploy-remote-chain.md](deploy-remote-chain.md) | adding a new EVM chain |
| [`../contracts/README.md`](../contracts/README.md) | the contracts, tests and the devnet proof |
