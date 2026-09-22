# The Ethereum route

Status: **built and proven locally, not deployed.** Two things are missing:
gas on Ethereum (about $4 of it — see costs), and a second relayer instance,
because one relayer cannot watch two bridges on the same chain. Both are
described below; everything else is mechanical.

## Why it is a second bridge, not a change to the live one

`FerminuxBridge.send()` enforces `dstChainId == cfg.remoteChainId`: a local
token bridges with exactly **one** remote chain. Native FMX on the live
Ferminux bridge (`0xe162eeDa683f067d4Ebf61060Fa322332a779EF4`) is bound to BSC.
Rebinding it would tear down a working route and move real collateral. A second
instance costs a deployment and touches nothing that already works.

So Ferminux ends up running two bridges side by side:

| Route | Ferminux side | Remote side | Remote asset |
|---|---|---|---|
| BSC (live) | `0xe162eeDa…779EF4` | `0xe43951a0…8a70ff` on 56 | wFMX `0x73e64635…F51BD0` |
| Ethereum (new) | *deploy* | *deploy* on 1 | wFMX *deploy* |

## The risk that creates, and why it is not a risk

Two bridges on one chain, holding the same asset, trusting the same three
validators. If the signed digest did not bind the bridge address, a 2-of-3
signature set for the Ethereum route would also execute on the BSC route and
drain its collateral.

It does bind it: the EIP-712 domain separator includes `address(this)`, so the
same transfer hashes to a different digest at each instance.
`script/eth-route-e2e.sh` proves this rather than asserting it — it takes a
genuine signature set for an inbound Ethereum transfer, replays it against the
BSC-route bridge, and shows the refusal with the BSC collateral unchanged to
the wei. It also proves separate nonce spaces, that the Ethereum bridge does
not know chain 56 at all, and that pausing one route leaves the other open.

Run it any time (three local anvils, no funding, nothing real touched):

```
anvil --port 8560 --chain-id 3961 &   # Ferminux, runs BOTH bridges
anvil --port 8561 --chain-id 56   &   # BSC
anvil --port 8562 --chain-id 1    &   # Ethereum
bash bridge/contracts/script/eth-route-e2e.sh
```

## What it costs

Measured gas from the rehearsal, priced at the gas price observed on
2026-08-22 (0.17 gwei — unusually cheap):

**Corrected 2026-08-23 from a real deployment — the first table was wrong.**
The bridge is roughly twice the size I estimated, and a multisig is needed too:

| Step | Gas | measured? |
|---|---|---|
| MinimalMultisig on Ethereum | 1.09 M | **measured** (deployed, cost 0.000122 ETH at 0.11 gwei) |
| FerminuxBridge on Ethereum | 7.26 M | **measured** (forge's own gasLimit; my estimate said 3.4 M) |
| wFMX (BridgeToken) | 1.2 M | estimated |
| pin + remote bridge + registration, queued | 0.6 M | estimated |
| the same, executed after the 48 h timelock | 0.8 M | estimated |
| a test transfer each way | 0.4 M | estimated |
| **total** | **11.3 M** | |

What that costs depends entirely on gas, and Ethereum gas on the day of writing
was extraordinarily low:

| gas price | total |
|---|---|
| 0.2 gwei (2026-08-23, unusual) | 0.0023 ETH |
| 1 gwei | 0.011 ETH |
| 5 gwei (ordinary) | 0.056 ETH |
| 20 gwei (busy) | 0.226 ETH |

**Fund 0.05 ETH**, not the 0.03 first written here and certainly not less. Two
reasons beyond the table: forge reserves `gasLimit × maxFeePerGas` up front, so
it refuses to broadcast unless the balance covers the *worst case* even when the
real cost is a tenth of it; and the submitter pays gas for every transfer
afterwards, so a balance sized exactly for deployment leaves the route unable to
operate.

Send it to `0xAB90b05F633b1f9C2aC64aCa06cebb6d2128D4f2` **on Ethereum mainnet**.
Do not send much more than 0.05; the deployer is a hot key.

Gas is the only blocker for the CONTRACTS. The off-chain side needs one more
thing, described next.

## The relayer cannot watch two bridges on one chain — plan for that

**This was claimed as working and is not.** A single relayer process keys its
chains by chain id: `config.ts` fails validation with `duplicate chainId 3961`,
and the runtime holds `Map<number, ChainClient>` and `Map<number,
FinalityMonitor>`. The watcher has the same shape. So the live relayer, which
already watches Ferminux for the BSC-route bridge, **cannot also watch the
second Ferminux bridge** — adding chain 1 to its config gets the Ethereum side
watched and silently leaves the Ferminux side of the new route unwatched, which
means outbound transfers to Ethereum would never be signed.

Two ways out:

1. **A second relayer instance per validator host** (recommended). Its own
   config listing exactly two chains — the Ferminux ETH-route bridge and
   Ethereum — its own database, its own systemd unit
   (`ferminux-validator-eth.service`), the same three validator keys. No code
   change, the live BSC relayer is never touched, and a fault in one route
   cannot stop the other. Costs three more processes and a second watcher
   instance with its own `watcher.config.json`.
2. **Key the relayer by (chainId, bridgeAddress)** instead of chainId. Cleaner
   long-term and the right answer once there are three or four routes, but it
   touches the maps, the watchers, the finality monitors and the on-disk cursor
   schema of a service that is currently moving real money. Not something to do
   in the same change as a new route.

Take option 1 for Ethereum. Revisit option 2 before a third route.

Everything else — contracts, deployment scripts, the rehearsal, the finality
decision below — exists.

## Order of work, once funded

1. **A separate multisig on Ethereum.** Each chain needs its own; reusing an
   address across chains has already bricked a deployment here once. Deploy
   `MinimalMultisig` with the same three owners, and make it the bridge owner.
2. Deploy the Ethereum bridge and wFMX (`DeployBridge.s.sol`,
   `DeployWrappedToken.s.sol`).
3. Deploy the second Ferminux bridge (same script, `--rpc-url` Ferminux).
4. Queue on both sides: wrapper bytecode pin (Ethereum), each side's view of
   the other's bridge address, then the token registrations. **Register at
   SMOKE caps — 100 FMX per transfer, 500 per day** — not the eventual figures.
   Raising caps later is one timelocked action; discovering a bug at full size
   is not recoverable.
5. Wait out the 48 h timelock, execute, and verify each side's view of the
   other with `remoteBridge(uint64)`.
6. Stand up the SECOND relayer instance on all three validator hosts (see the
   section above — the existing one cannot take this route). Its config lists
   only the Ferminux ETH-route bridge and Ethereum, with its own DB path and
   unit name. **Rsync `bridge/relayer/` before writing any config** — pushing a
   new config to old source crash-looped all four validators once.
7. Give the watcher a SECOND config (same duplicate-chainId constraint) so
   reconciliation covers the route from its first transfer.
8. Cross a single 1 FMX transfer each way and reconcile before announcing
   anything.

## Finality on Ethereum — decided, not left open

Ethereum is not BSC and it is not Ferminux. It has a real finality gadget, so
the answer is the one BSC already uses: **`count` mode with
`finalityTag: "finalized"`**, and a confirmation count as the fallback floor.

`Chain.settledHeight()` takes the **minimum** of `head - confirmations` and the
finalized block, so when both readings succeed both floors apply: the tag is the
real safety line and the count sits under it.

**But it fails OPEN, and that qualifies the sentence above.** If the tag cannot
be read from any endpoint, `settledHeight()` silently returns
`head - confirmations` — the safety line drops from finality to 32 confirmations
on Ethereum, and to 20 (~60 s) on the live BSC route. Until 2026-08-23 this was
also invisible: the failure logged at debug level, and a provider answering with
*no block* for the tag logged nothing at all. It is now a WARN naming the
degradation and is exposed as `finalityTagDegraded` in the relayer's status.

The behaviour was deliberately left as fail-open in that change, because making
it fail closed halts transfers when a public endpoint has a bad minute, and
that is an operator's call rather than a logging fix. **The decision is still
open**, and it should be taken before the Ethereum route carries value:

- *Fail closed* — refuse to sign while the tag is unreadable. Correct for a
  bridge whose stated posture is fail-closed; costs availability on flaky RPC.
- *Fail closed after a grace period* — tolerate a few minutes, then refuse.
  Probably the right answer; needs a threshold nobody has picked yet.
- *Stay open, alert loudly* — today's behaviour. Acceptable only while someone
  is watching the alerts. The config validator
refuses `count` mode on an enabled chain that has no finality tag at all
(`allowCountFinalityWithoutGadget`), which is why Ferminux itself waits 64
blocks instead — it has no gadget to ask.

Ethereum finalises every two epochs, about 13 minutes. Use **32 confirmations**
(~6.4 min) as the floor: shorter than finality, so it never becomes the binding
constraint in normal operation, and deep enough to be meaningful if the tag is
briefly unavailable.

This belongs in the SECOND relayer instance's config on all three validator
hosts — **not** in the live `/etc/ferminux-relayer/chains.json`, which already
holds chain 3961 for the BSC route (fill the two addresses from step 2, and
note the deliberate absence of `checkpoint` — the registry exists for chains
with no finality gadget):

```json
{
  "name": "ethereum",
  "chainId": 1,
  "_notes": "PoS with real finality: `finalized` is the safety line and is authoritative. 32 confirmations (~6.4 min) is the fallback floor for the minutes when the tag cannot be served — deliberately shorter than the ~13 min finality so it never binds first. settledHeight() takes the MINIMUM of the two, so both hold.",
  "bridgeAddress": "0xTHE_ETHEREUM_BRIDGE",
  "domainSeparator": "0xREAD_IT_FROM_THE_DEPLOYED_CONTRACT",
  "confirmations": 32,
  "finalityTag": "finalized",
  "pollIntervalMs": 12000,
  "startBlock": 0,
  "maxBlockRange": 2000,
  "enabled": true,
  "rpcUrls": ["...three independent providers, no two owned by the same operator..."],
  "gas": {
    "maxFeePerGasGwei": 40,
    "priorityFeeGwei": 1,
    "baseFeeMultiplier": 2,
    "gasLimitMultiplier": 1.3,
    "gasLimitCap": 1500000,
    "escalationPct": 25,
    "maxAttempts": 4,
    "receiptTimeoutMs": 180000,
    "txType": 2
  },
  "limits": { "default": { "maxPerTransfer": "100000000000000000000", "dailyCap": "500000000000000000000" } }
}
```

Read `domainSeparator` off the deployed contract (`cast call $BRIDGE
'DOMAIN_SEPARATOR()(bytes32)'`) rather than computing it — the relayer compares
what it signs against this value, and the whole point of the two-bridge safety
argument is that this number differs per deployment.

`receiptTimeoutMs` is higher than BSC's because a 12-second block with a
one-gwei tip can genuinely take minutes to land; `maxFeePerGasGwei: 40` is a
ceiling, not a target, and at the gas prices seen while writing this (0.17
gwei) it will never be approached.
