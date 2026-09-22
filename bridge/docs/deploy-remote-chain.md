# Adding a new EVM chain to the Ferminux Bridge

A copy-paste guide for standing up a route between Ferminux (ChainID **3961**)
and another EVM chain. Follow it in order. Nothing here should be improvised.

Assumes you have read [operations.md](operations.md) — the key ceremony, cap
policy and monitoring requirements in that document are prerequisites, not
optional extras.

---

## 0. Read this before you start

### One bridge deployment per remote chain

The registry maps `localToken → {kind, remoteChainId, remoteToken}` — **one
remote chain per local token, permanently.** `address(0)` (FMX) can therefore be
registered against exactly one remote chain per bridge deployment, and
registration is once-only (`BRIDGE: already registered`).

**Consequence: bridging FMX to a second remote chain requires a second
`FerminuxBridge` deployment on Ferminux.** There is no hub-and-spoke mode.

| | Cost | Benefit |
|---|---|---|
| One deployment per route | N deployments, N registries, N pausers to hold, N monitors to run, N sets of caps to review | **blast radius is isolated per route.** A compromise on the BSC route cannot touch the Ethereum route's collateral, because they are different contracts holding different balances |

Budget the operational cost honestly before adding a third chain. Two routes is
two of everything.

### What the remote chain must provide

| Requirement | Why | How to check |
|---|---|---|
| EVM at Paris or later | the artifact is built `evm_version = "paris"`; every modern chain accepts it. A pre-Paris fork does not | deploy to a fork of it first |
| Contract size limit ≥ 24,576 B | `FerminuxBridge` runtime is **21,346 B**, initcode **23,488 B** | `forge build --sizes` |
| Reliable `eth_getLogs` over a usable block range | validators and the reconciler scan `Sent` / `Executed` | test against your actual endpoint, not a public one |
| A `finalized` block tag, or a documented finality rule | confirmation policy ([security-model.md §5](security-model.md#5-reorg-risk-per-chain)) | `cast block finalized --rpc-url $RPC` |
| Chain id non-zero, ≠ 3961, < 2⁶⁴ | `BRIDGE: zero remote chain`, `BRIDGE: remote is local`; the struct field is `uint64` | `cast chain-id --rpc-url $RPC` |
| A deployed, tested **multisig** to own the bridge on that chain | an EOA owner is a single point of total failure | execute one harmless tx through it first |

### Prerequisites checklist

- [ ] Owner multisig deployed **on the remote chain** and exercised once
- [ ] Validator addresses from the ceremony ([operations.md §3](operations.md#3-validator-key-generation-ceremony))
      — the **same validator set** as the Ferminux side, or a deliberate,
      documented different one
- [ ] Pauser key, fee collector multisig, funded deployer EOA
- [ ] Private RPC endpoint for both chains (public endpoints rate-limit
      validators at exactly the wrong moment)
- [ ] `forge test` 289/289 green on the commit being shipped
- [ ] `bash script/devnet-e2e.sh` re-run locally with `CHAIN_B` set to the
      **real** remote chain id
- [ ] Monitoring configured for the new chain before the first registration

---

## 1. What it costs

Measured gas, from the Foundry gas report and the recorded broadcast artifacts
in `bridge/contracts/broadcast/`:

| Operation | Gas | Notes |
|---|---|---|
| Deploy `FerminuxBridge` | **5,022,256** | one per chain |
| Deploy `BridgeToken` wrapper | **961,748** | one per wrapped asset |
| `queue(...)` a registration | ~215,700 (max 232,759) | one per registration |
| `executeAction(...)` | ~151,000 (max 168,569) | one per registration |
| `send()` | median 112,214, max 150,621 | paid by the user |
| `execute()` | median 124,602, max 160,845 | paid by the relayer |
| `pause()` | 29,834 | cheap on purpose |
| **Full one-route bring-up** | **≈ 7.5 M** | bridge + 1 wrapper + 2 registrations + multisig overhead |

Convert with:

```
USD  =  gas × gasPrice_gwei × 1e-9 × nativeTokenPriceUSD
```

**Ballpark bring-up cost. Prices assumed as of 2026-08-20 — recompute with the
formula above before you budget anything, these move by an order of magnitude.**
Assumptions: ETH $3,500, BNB $600, POL $0.25, FMX $0.53.

| Chain | Gas price assumed | Deploy bridge (5.02 M) | Deploy wrapper (0.96 M) | Full route (~7.5 M) |
|---|---|---|---|---|
| **Ethereum (1)** | 8 gwei (quiet) | ~$141 | ~$27 | **~$210** |
| **Ethereum (1)** | 30 gwei (busy) | ~$527 | ~$101 | **~$790** |
| **BSC (56)** | 0.1 gwei | ~$0.30 | ~$0.06 | **~$0.45** |
| **BSC (56)** | 1 gwei | ~$3.00 | ~$0.58 | **~$4.50** |
| **Polygon PoS (137)** | 30 gwei | ~$0.04 | ~$0.01 | **~$0.06** |
| **Polygon PoS (137)** | 100 gwei | ~$0.13 | ~$0.02 | **~$0.19** |
| **Base (8453)** | ~0.01 gwei L2 + L1 data | ~$0.20 + data | ~$0.04 + data | **~$1–3** (dominated by the L1 data component) |
| **Ferminux (3961)** | 1 gwei | ~$0.003 | ~$0.0005 | **~$0.004** |

Fund the deployer for **~8 M gas plus 50 % margin**: roughly 0.25 ETH on
Ethereum at busy prices, 0.05 BNB, 10 POL, 0.01 ETH on Base.

### The part that decides whether the route is economic

The relayer pays `execute()` gas on the destination and is compensated only by
the **10 bps fee taken at origin**. Break-even transfer size, at the default
10 bps:

```
break-even  =  execute_gas × gasPrice × nativePrice / 0.0010
```

| Destination | Gas price | `execute()` cost | Break-even transfer at 10 bps |
|---|---|---|---|
| Ethereum | 8 gwei | ~$3.50 | **~$3,500** |
| Ethereum | 30 gwei | ~$13.10 | **~$13,100** |
| BSC | 0.1 gwei | ~$0.008 | ~$8 |
| BSC | 1 gwei | ~$0.075 | ~$75 |
| Polygon PoS | 30 gwei | ~$0.001 | ~$1 |
| Base | typical | ~$0.02 | ~$20 |
| Ferminux | 1 gwei | ~$0.00007 | ~$0.07 |

**On Ethereum, the default fee does not pay for the relay of a small transfer.**
The contract has **no minimum-transfer parameter** — `maxPerTransfer` is a
ceiling, not a floor — so the only levers are:

1. accept the subsidy and treat small Ethereum transfers as a cost of service;
2. raise `setFeeBps` toward the `MAX_FEE_BPS = 100` ceiling for that deployment
   (1.00 % moves Ethereum's break-even to ~$350 at 8 gwei) — 48 h timelock, and
   it applies to that whole bridge deployment, not per token;
3. publish a recommended minimum transfer size in the UI and let users decide.

Decide which before launch, and say so publicly. Do not discover it in month two.

---

## 2. Deploy the bridge on the remote chain

```sh
cd <repo>/bridge/contracts

export RPC_B=https://<your-private-endpoint>

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
  forge script script/DeployBridge.s.sol --rpc-url $RPC_B --broadcast
```

The script prints every constructor parameter and the `DOMAIN_SEPARATOR()`.
**Record the address and the domain separator.** Validators pin both.

If Ferminux does not yet have a bridge for this route (remember: one deployment
per remote chain), deploy it the same way against `https://rpc.ferminux.net`.

Verify before proceeding — a wrong constructor argument is not fixable:

```sh
export BRIDGE_B=0x…
cast call $BRIDGE_B "owner()(address)"           --rpc-url $RPC_B
cast call $BRIDGE_B "getValidators()(address[])" --rpc-url $RPC_B
cast call $BRIDGE_B "threshold()(uint256)"       --rpc-url $RPC_B
cast call $BRIDGE_B "timelockDelay()(uint64)"    --rpc-url $RPC_B   # 172800
cast call $BRIDGE_B "feeBps()(uint256)"          --rpc-url $RPC_B   # 10
cast call $BRIDGE_B "feeCollector()(address)"    --rpc-url $RPC_B
cast call $BRIDGE_B "isPauser(address)(bool)" $PAUSER --rpc-url $RPC_B
cast call $BRIDGE_B "DOMAIN_SEPARATOR()(bytes32)" --rpc-url $RPC_B
```

---

## 3. Verify the source on the explorer

Publish source on both chains. An unverified bridge is one users cannot audit,
and auditability is most of what they have.

```sh
# constructor args, in the constructor's order
cast abi-encode \
  "constructor(address,address[],uint256,address,uint256,uint64,address)" \
  $OWNER "[$V1,$V2,$V3]" 2 $FEE_COLLECTOR 10 172800 $PAUSER
```

Etherscan-family explorer (Ethereum, BSC, Polygon, Base):

```sh
forge verify-contract $BRIDGE_B src/FerminuxBridge.sol:FerminuxBridge \
  --chain-id <CHAIN_ID> \
  --compiler-version 0.8.24 \
  --num-of-optimizations 200 \
  --constructor-args <hex-from-above> \
  --etherscan-api-key $EXPLORER_API_KEY \
  --watch
```

Blockscout (Ferminux):

```sh
forge verify-contract $BRIDGE_A src/FerminuxBridge.sol:FerminuxBridge \
  --chain-id 3961 \
  --compiler-version 0.8.24 \
  --num-of-optimizations 200 \
  --constructor-args <hex-from-above> \
  --verifier blockscout \
  --verifier-url https://explorer.ferminux.net/api \
  --watch
```

Verify the wrapper too, once it exists:

```sh
cast abi-encode "constructor(string,string,uint8,address,uint64,address)" \
  "Wrapped FMX" "wFMX" 18 $BRIDGE_B 3961 0x0000000000000000000000000000000000000000
```

The optimizer settings must match `foundry.toml` exactly: `optimizer = true`,
`optimizer_runs = 200`, `evm_version = "paris"`, `solc = 0.8.24`. A mismatch
means the verification fails with a bytecode difference and tells you nothing
useful about why.

---

## 4. Deploy the wrappers

One `BridgeToken` per asset that is canonical on the **other** side.

```sh
DEPLOYER_KEY=0x… BRIDGE=$BRIDGE_B \
WRAPPED_NAME="Wrapped FMX" WRAPPED_SYMBOL=wFMX WRAPPED_DECIMALS=18 \
ORIGIN_CHAIN_ID=3961 ORIGIN_TOKEN=0x0000000000000000000000000000000000000000 \
  forge script script/DeployWrappedToken.s.sol --rpc-url $RPC_B --broadcast
```

And, on Ferminux, a wrapper for the remote chain's native coin if that route is
wanted:

```sh
DEPLOYER_KEY=0x… BRIDGE=$BRIDGE_A \
WRAPPED_NAME="Wrapped BNB" WRAPPED_SYMBOL=wBNB WRAPPED_DECIMALS=18 \
ORIGIN_CHAIN_ID=56 ORIGIN_TOKEN=0x0000000000000000000000000000000000000000 \
  forge script script/DeployWrappedToken.s.sol --rpc-url https://rpc.ferminux.net --broadcast
```

**`WRAPPED_DECIMALS` must mirror the origin asset exactly.** Read it off-chain
first — `cast call $ORIGIN_TOKEN "decimals()(uint8)"` — and put that number in.
AZNT is **6**. FMX, ETH and BNB are 18. `BridgeToken` rejects anything above 18
with `WTOKEN: decimals`, and an origin asset with more decimals than that cannot
be bridged by this design at all.

Check every wrapper before registering it:

```sh
cast call $WFMX "bridge()(address)"       --rpc-url $RPC_B   # == $BRIDGE_B, exactly
cast call $WFMX "originChainId()(uint64)" --rpc-url $RPC_B   # == 3961
cast call $WFMX "originToken()(address)"  --rpc-url $RPC_B
cast call $WFMX "decimals()(uint8)"       --rpc-url $RPC_B
cast call $WFMX "totalSupply()(uint256)"  --rpc-url $RPC_B   # == 0
```

`registerWrapped` will refuse a wrapper whose `bridge()` is not the registering
bridge (`BRIDGE: not the minter`), which catches the common copy-paste error,
and that its runtime bytecode matches the chain's `bridgeTokenCodehash` pin
(`BRIDGE: wrapper not pinned`; `BRIDGE: wrapper pin unset` if you have not run
`RegisterToken TOKEN_KIND=pin` yet),
but not a decimals mistake. Nothing catches a decimals mistake. Check it twice.

---

## 5. Register the pairs

### 5.0 First, tell each bridge the other one's address

**Nothing can be registered for a chain until that chain's counterpart bridge
address has been recorded.** `_register` refuses with
`BRIDGE: remote bridge unset`, and that is deliberate.

`send()` refuses to let a user name the DESTINATION bridge as their recipient.
That is the recipient that actually destroys the money: over there `execute()`
rejects it, but only after this side has already taken the funds and emitted a
`Sent` that nobody can ever fill. A chain cannot derive another chain's
deployment address, and **this project does not use a deterministic /
address-identical deployment scheme** — the two sides are ordinary `CREATE`
deployments from different nonces on different chains and their addresses
differ. So the address is recorded per route, by the same governance that
registers the route, and is timelocked like everything else that widens the
blast radius:

```sh
# on Ferminux: the counterpart is the bridge you just deployed on chain 56
BRIDGE=$BRIDGE_A ACTION=queue TOKEN_KIND=remotebridge \
REMOTE_CHAIN_ID=56 REMOTE_BRIDGE=$BRIDGE_B \
  forge script script/RegisterToken.s.sol --rpc-url https://rpc.ferminux.net

# on the remote chain: the counterpart is Ferminux's bridge
BRIDGE=$BRIDGE_B ACTION=queue TOKEN_KIND=remotebridge \
REMOTE_CHAIN_ID=3961 REMOTE_BRIDGE=$BRIDGE_A \
  forge script script/RegisterToken.s.sol --rpc-url $RPC_B
```

Submit, wait the 48 h, execute — the same multisig loop as every other queued
action below. Then confirm before you go any further:

```sh
cast call $BRIDGE_A "remoteBridge(uint64)(address)" 56   --rpc-url https://rpc.ferminux.net  # -> $BRIDGE_B
cast call $BRIDGE_B "remoteBridge(uint64)(address)" 3961 --rpc-url $RPC_B                    # -> $BRIDGE_A
```

Get this wrong and the guard still fires — just on the wrong address, leaving
the real counterpart bridge reachable as a recipient. **Read both values back
before registering anything.** If the counterpart is ever redeployed, re-queue
`setRemoteBridge` for that chain; it is re-settable for exactly that reason.

### 5.1 The pair itself

The two registrations must be exact mirror images:

| | Ferminux (3961) | remote chain (e.g. 56) |
|---|---|---|
| `localToken` | `0x0` (FMX) | `$WFMX` |
| kind | `CANONICAL` | `WRAPPED` |
| `remoteChainId` | 56 | 3961 |
| `remoteToken` | `$WFMX` | `0x0` |
| `maxPerTransfer` | 100 FMX (`100e18`) — smoke phase | identical |
| `dailyCap` | 500 FMX (`500e18`) — smoke phase | identical |

**Start at the smoke-test caps, not the launch caps.** You will raise them in
[§8](#8-raise-the-caps-gradually) after the route is proven with real money.

Queue on Ferminux (prints calldata; no `OWNER_KEY` means nothing is broadcast):

```sh
BRIDGE=$BRIDGE_A ACTION=queue TOKEN_KIND=canonical \
LOCAL_TOKEN=0x0000000000000000000000000000000000000000 \
REMOTE_CHAIN_ID=56 REMOTE_TOKEN=$WFMX \
MAX_PER_TRANSFER=100000000000000000000 \
DAILY_CAP=500000000000000000000 \
  forge script script/RegisterToken.s.sol --rpc-url https://rpc.ferminux.net
```

Queue on the remote chain:

```sh
BRIDGE=$BRIDGE_B ACTION=queue TOKEN_KIND=wrapped \
LOCAL_TOKEN=$WFMX \
REMOTE_CHAIN_ID=3961 REMOTE_TOKEN=0x0000000000000000000000000000000000000000 \
MAX_PER_TRANSFER=100000000000000000000 \
DAILY_CAP=500000000000000000000 \
  forge script script/RegisterToken.s.sol --rpc-url $RPC_B
```

Submit each printed `queue(bytes)` calldata through that chain's multisig:

```sh
cast send $MSIG "submit(address,uint256,bytes)" $BRIDGE 0 <queue-calldata> \
  --private-key $SIGNER1_KEY --rpc-url $RPC
cast send $MSIG "confirm(uint256)" $TXID --private-key $SIGNER2_KEY --rpc-url $RPC
cast send $MSIG "execute(uint256)" $TXID --private-key $SIGNER2_KEY --rpc-url $RPC
```

Then find the action id and publish it:

```sh
cast call $BRIDGE "actionCount()(uint256)" --rpc-url $RPC        # id = count - 1
cast call $BRIDGE "getAction(uint256)(bytes,uint64,bool,bool)" $ID --rpc-url $RPC
```

**Wait the full 48 h on both chains.** Use the window: publish the action ids,
the decoded calldata and the etas so anyone can check what is about to be listed.

Execute after the eta, again through each multisig:

```sh
BRIDGE=$BRIDGE_A ACTION=execute ACTION_ID=$ID \
  forge script script/RegisterToken.s.sol --rpc-url https://rpc.ferminux.net
# submit the printed executeAction calldata through the multisig
```

Confirm the mirror, field by field, on both sides:

```sh
cast call $BRIDGE_A "tokenConfig(address)((uint8,bool,uint64,address,uint256,uint256))" \
  0x0000000000000000000000000000000000000000 --rpc-url https://rpc.ferminux.net
cast call $BRIDGE_B "tokenConfig(address)((uint8,bool,uint64,address,uint256,uint256))" \
  $WFMX --rpc-url $RPC_B
```

Fields, in order: `kind`, `paused`, `remoteChainId`, `remoteToken`,
`maxPerTransfer`, `dailyCap`.
`kind`: `0 = UNREGISTERED`, `1 = CANONICAL`, `2 = WRAPPED`.
There is no token-class field: the struct carried a `lossy` bool during
development and v1 does not have it.

### 5.2 Read the canonical token's transfer path BEFORE you register it

Settlement is unconditional and there is exactly one supported behaviour: the
bridge must part with exactly `amount`, the recipient must receive exactly
`amount`, and a deposit must credit exactly what was sent — or the call reverts.
See [contracts/README.md §Settlement](../contracts/README.md#settlement) for the
full rule and the table of which shapes are refused where.

Registration is once-only, so answer these three before you queue it:

1. Does the amount credited to `to` ever differ from the amount passed in?
2. Does the payer's balance ever fall by more than the amount passed in?
3. Can any balance change with no transfer at all (a rebase, an index, an
   `airdrop`/`reflect` entry point)?

**No, no, no → register it. Any yes → do not.** Same answer if you cannot read
the source at all. There is no setting that makes a taxed token work: a
fee-on-transfer or reflection token is refused on its first deposit and on its
first release, and a rebasing token is not detectable by the contract at all.

A release failing with `BRIDGE: inexact transfer` on a token you believed was
plain means the token's behaviour changed under you. Investigate first. Deposits
are failing closed on the same rule **on this chain**, but the counterpart chain
cannot see this token, so it will keep accepting burns of the wrapper — pause the
token on **both** deployments while you look. If the collateral has to come out
of a token that will never settle exactly again, the last resort is
`allowShortDelivery`, one announced transfer at a time; read
[contracts/README.md §When a route strands](../contracts/README.md#when-a-route-strands)
first, because it makes a real user receive less than they were promised.

---

## 6. Configure the relayer and validators

The validator/submitter daemon lives in
[`../relayer`](../relayer) — one binary, three roles:

```sh
cd <repo>/bridge/relayer
npm run check        # config + connectivity sanity check, signs nothing
npm run validator    # watches Sent, waits confirmations, signs
npm run submitter    # collects signatures, calls execute()
```

**`../relayer/README.md` is the authority on its flags, environment variables
and config file format** — it was being written in parallel with this guide, so
read it rather than guessing from the script names above.

Whatever the config format, these properties are non-negotiable and are the
things to verify by inspection before the daemon signs anything real:

| Property | Why |
|---|---|
| Bridge **addresses pinned** for both chains | a validator that will sign against an unpinned address can be phished into signing for an attacker's deployment |
| `DOMAIN_SEPARATOR()` **checked against the pinned address at startup** | catches a wrong address, a wrong chain id, and a wrong contract in one check |
| `transferId` and the EIP-712 digest **recomputed locally** from the `Sent` log and compared with the chain | never sign a digest handed over by a relayer |
| Confirmation depth per source chain, per [security-model.md §5](security-model.md#5-reorg-risk-per-chain) | the only defence against reorg-based theft |
| Refuses to sign source events **older than the migration block**, if any | `processed[]` is per-deployment; old events could otherwise be replayed onto a new bridge |
| Validator key file `400`, owned by the daemon user, on a machine no other validator shares | [operations.md §3](operations.md#3-validator-key-generation-ceremony) |
| Submitter gas balance alarms | the relay stops when it runs dry |
| Append-only log of every signature produced, keyed by `transferId` | the only forensic record you will have |

Run `npm run check` against both chains and read its output line by line before
starting a validator.

---

## 7. Smoke test with a tiny amount

**Do this on mainnet, with the real validator set, before announcing anything.**
Use an amount you would shrug at losing. With the smoke caps above,
`maxPerTransfer` is 100 FMX, so nothing larger is possible anyway.

### 7.1 Ferminux → remote

```sh
export FMX_RPC=https://rpc.ferminux.net
export AMOUNT=1000000000000000000        # 1 FMX

cast send $BRIDGE_A "send(address,uint256,uint64,address)" \
  0x0000000000000000000000000000000000000000 $AMOUNT 56 $RECIPIENT \
  --value $AMOUNT --private-key $USER_KEY --rpc-url $FMX_RPC
```

Read the `Sent` log from the receipt. With `feeBps = 10`, the net is
`0.999 FMX = 999000000000000000` and the nonce is in the log.

Let the validators do their job. If you need to verify the digest by hand, ask
the **destination** bridge — and recompute it independently rather than trusting
one source:

```sh
T="(3961,56,$NONCE,0x0000000000000000000000000000000000000000,$WFMX,$SENDER,$RECIPIENT,999000000000000000)"

cast call $BRIDGE_B \
  'hashTransfer((uint64,uint64,uint64,address,address,address,address,uint256))(bytes32)' \
  "$T" --rpc-url $RPC_B

cast call $BRIDGE_B \
  'transferIdOf((uint64,uint64,uint64,address,address,address,address,uint256))(bytes32)' \
  "$T" --rpc-url $RPC_B
```

Then confirm arrival:

```sh
cast call $BRIDGE_B "processed(bytes32)(bool)" $TRANSFER_ID --rpc-url $RPC_B   # true
cast call $WFMX "balanceOf(address)(uint256)" $RECIPIENT --rpc-url $RPC_B      # 999000000000000000
cast call $WFMX "totalSupply()(uint256)" --rpc-url $RPC_B
cast call $BRIDGE_A "lockedBalance(address)(uint256)" \
  0x0000000000000000000000000000000000000000 --rpc-url $FMX_RPC
```

**`totalSupply` must equal `lockedBalance`.** If it does not, stop and
reconcile before anything else happens.

### 7.2 Remote → Ferminux

```sh
cast send $BRIDGE_B "send(address,uint256,uint64,address)" \
  $WFMX 999000000000000000 3961 $FMX_RECIPIENT \
  --private-key $USER_KEY --rpc-url $RPC_B
```

Wrapped sends burn — no `approve` is needed because the bridge burns
`msg.sender`'s own balance. (A **canonical ERC-20** send does need an `approve`
first.) Expect back `0.998001 FMX`: 10 bps taken on each leg.

Confirm the accounting closes:

```sh
cast call $WFMX "totalSupply()(uint256)" --rpc-url $RPC_B     # only the fee remains
cast call $BRIDGE_A "lockedBalance(address)(uint256)" \
  0x0000000000000000000000000000000000000000 --rpc-url $FMX_RPC   # equals it exactly
```

### 7.3 Test the brakes, on mainnet

A circuit breaker nobody has ever pulled is not a circuit breaker.

```sh
cast send $BRIDGE_B "pause()" --private-key $PAUSER_KEY --rpc-url $RPC_B
cast call $BRIDGE_B "paused()(bool)" --rpc-url $RPC_B                      # true

# a send must now revert with "BRIDGE: paused"
cast send $BRIDGE_B "send(address,uint256,uint64,address)" \
  $WFMX 1000 3961 $FMX_RECIPIENT --private-key $USER_KEY --rpc-url $RPC_B  # expect revert

# unpause: owner multisig only
cast calldata "unpause()"        # submit through $MSIG, confirm, execute
cast call $BRIDGE_B "paused()(bool)" --rpc-url $RPC_B                      # false
```

Do the same on the Ferminux side. Time it. Write the elapsed time in the runbook.

### 7.4 Smoke-test sign-off

- [ ] Round trip completed in both directions with real validators
- [ ] `lockedBalance` == wrapped `totalSupply` at rest
- [ ] Fees landed in `accruedFees` and a `withdrawFees` sweep worked
- [ ] `pause()` / `unpause()` exercised on both chains, timed
- [ ] Every monitoring alert fired at least once in a controlled test —
      including the `Sent`-without-`Executed` alarm (pause the destination
      briefly and confirm it pages)
- [ ] Explorer verification live on both chains
- [ ] The relayer survived a restart mid-transfer without double-submitting or
      losing the transfer

---

## 8. Raise the caps gradually

Only now do you move to the launch caps. The ramp, the gates and the concrete
numbers are in [operations.md §5](operations.md#5-setting-caps-for-a-launch).

The mechanics, per step:

```sh
cast calldata "setTokenLimits(address,uint256,uint256)" $TOKEN $NEW_MAX $NEW_DAILY
cast calldata "queue(bytes)" <that-calldata>
# submit through the multisig -> wait 48 h -> executeAction through the multisig
```

Three rules, learned the expensive way by other people:

1. **Raise both sides of a route together**, landing within the same hour.
   Asymmetric caps produce transfers that leave successfully and cannot arrive.
2. **Advance a phase because a gate was met, not because volume demands it.**
   Pressure for a higher cap is precisely the signal an attacker would generate.
3. **Re-check the Ferminux reorg inequality at every step**
   ([security-model.md §5](security-model.md#5-reorg-risk-per-chain)): `2 ×
   dailyCap` in USD must stay clearly below the cost of renting enough Ethash
   hashrate to reorg your confirmation depth. If raising the cap breaks it,
   raise the confirmation depth instead, or do not raise the cap.

Lowering is instant if you need to reverse:

```sh
cast calldata "decreaseTokenLimits(address,uint256,uint256)" $TOKEN $LOWER_MAX $LOWER_DAILY
```

Both values must be ≤ the current ones (`BRIDGE: not a decrease`), and restoring
them afterwards is a 48 h `setTokenLimits`.

---

## 9. If it goes wrong before launch

| When | What you can do |
|---|---|
| Wrong constructor arg, **nothing registered yet** | abandon the deployment and deploy again. Nothing is at risk; only gas is lost. Do **not** live with a wrong `owner` |
| Wrong wrapper decimals, **not yet registered** | deploy a new wrapper and register that one. The bad wrapper is inert |
| Wrong registration **already queued** | `cancelAction(actionId)` through the multisig, before the eta |
| Wrong registration **already executed** | it cannot be undone — `BRIDGE: already registered` is permanent. `pauseToken()` it immediately and route around it with a different token/wrapper. **Never** try to reuse a mis-registered token address |
| Route dead: `execute()` reverts `BRIDGE: token mismatch` / `BRIDGE: bad src chain` | the registrations do not mirror. Funds are not at risk but transfers strand. `pauseToken()` on both sides, then decide: if one side is wrong and not yet registered, fix that side; if both are registered wrongly, the route needs a fresh wrapper on the wrapped side and a fresh bridge deployment on the canonical side |
| Collateral already locked on a broken route | there is no refund function. Recovery requires validator-quorum-signed compensating transfers — a discretionary act. Decide **now** who authorises it and record the decision |

---

## 10. Record what you deployed

Keep this per route, off-repo, with the key register:

```
Route:                 Ferminux (3961)  <->  <chain name> (<id>)
Deployed:              <date>, commit <sha>, forge <version>, solc 0.8.24, evm paris

Bridge on 3961:        0x…
  DOMAIN_SEPARATOR:    0x…
  owner (multisig):    0x…
  validators:          0x…, 0x…, 0x…    threshold 2
  pauser:              0x…
  fee collector:       0x…    feeBps 10    timelockDelay 172800

Bridge on <id>:        0x…
  DOMAIN_SEPARATOR:    0x…
  (same fields)

Wrappers:              wFMX on <id> = 0x…  (decimals 18, origin 3961/0x0)
                       wBNB on 3961 = 0x…  (decimals 18, origin <id>/0x0)

Registrations:         action ids + etas + the block each executed in
Caps at launch:        maxPerTransfer / dailyCap per token, per chain
Confirmation depth:    3961 = 64 blocks;  <id> = <policy>
Migration block:       n/a  (fill in if this deployment ever replaces another)
Explorer verified:     <links>
```

---

## See also

| Doc | For |
|---|---|
| [how-it-works.md](how-it-works.md) | how transfers work, fees, caps, timings |
| [security-model.md](security-model.md) | threat model, loss bounds, reorg policy |
| [operations.md](operations.md) | key ceremony, cap ramp, monitoring, incident response |
| [`../contracts/README.md`](../contracts/README.md) | contracts, tests, the two-anvil devnet proof |
| `../relayer/README.md` | validator and submitter daemon |
