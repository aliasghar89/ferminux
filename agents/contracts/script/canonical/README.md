# Standard shared contracts on chain 3961

Wallets, SDKs and deploy tools expect a handful of contracts to exist at the
same address on every chain. None of them exist on chain 3961 today
(`eth_getCode` returns `0x` at every address below), so viem/wagmi batching,
salted Foundry deploys, Safe multisigs and smart-account wallets all fail or
fall back. This directory puts them there, at their canonical addresses, with
their canonical bytecode.

**Status: rehearsed, not broadcast.** Nothing here has been sent to mainnet.
The mainnet run needs the owner's go-ahead and a funded gas account.

| Contract | Address | Route | Gas used |
|---|---|---|---:|
| Deterministic CREATE2 deployer | `0x4e59b44847b379578588920cA78FbF26c0B4956C` | presigned keyless tx | 68,131 |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` | presigned keyless tx | 872,776 |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | CREATE2 deployer | 2,025,144 |
| Safe 1.3.0 singleton | `0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552` | CREATE2 deployer | 5,017,833 |
| Safe 1.3.0 L2 singleton | `0x3E5c63644E683549055b9Be8653de26E0B4CD36E` | CREATE2 deployer | 5,200,241 |
| Safe 1.3.0 proxy factory | `0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2` | CREATE2 deployer | 867,594 |
| Safe 1.3.0 compatibility fallback handler | `0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4` | CREATE2 deployer | 1,238,095 |
| Safe 1.3.0 MultiSend | `0xA238CBeb142c10Ef7Ad8442C6D1f9E89e07e7761` | CREATE2 deployer | 190,004 |
| Safe 1.3.0 MultiSendCallOnly | `0x40A2aCCbd92BCA938b02010E17A5b8929b49130D` | CREATE2 deployer | 142,122 |
| Safe 1.3.0 CreateCall | `0x7cbB62EaA69F79e6873cD1ecB2392971036cFAa4` | CREATE2 deployer | 294,718 |
| Safe 1.3.0 SignMessageLib | `0xA65387F16B013cf2Af4605Ad8aA5ec25a2cbA3a2` | CREATE2 deployer | 262,353 |
| Safe 1.3.0 SimulateTxAccessor | `0x59AD6735bCd8152B84860Cb256dD9e96b85F69Da` | CREATE2 deployer | 237,871 |
| ERC-4337 EntryPoint v0.6 | `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789` | CREATE2 deployer | 5,316,874 |
| ERC-4337 EntryPoint v0.7 | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` | CREATE2 deployer | 3,649,137 |

The Safe set is the full 1.3.0 "canonical" set that Safe's SDKs look up, not
only the five core contracts: MultiSendCallOnly, CreateCall, SignMessageLib and
SimulateTxAccessor cost under 0.001 FMX together.

## Files

| File | What it is |
|---|---|
| `deploy.sh` | The deployment script. `plan` is read-only; `apply` deploys whatever is missing and skips whatever is already there. |
| `verify.sh` | Read-only checklist: code hash, opcode scan and a behaviour read for every contract. |
| `rehearse.sh` | Full rehearsal on an anvil fork of the live chain (London rule set). |
| `relay-rehearsal.sh` | Rehearsal of the keyless broadcast on two local nodes built from `chain/`. |
| `CanonicalSmoke.s.sol` | Functional smoke test run by `rehearse.sh` (fork only, never mainnet). |
| `opscan.py` | Opcode scanner: fails on PUSH0, TLOAD, TSTORE, MCOPY, BLOBHASH or BLOBBASEFEE in code. |
| `manifest.json` | Addresses, salts, initcode hashes, expected runtime code hashes, gas limits, rehearsed gas. |
| `artifacts/` | The two presigned raw transactions and the twelve initcodes, byte for byte. |

## Where the bytes come from

Nothing here is compiled locally. Every byte is copied from the original
deployments, so the addresses and code hashes are the ones every tool already
knows.

- **Presigned transactions.** The CREATE2 deployer's raw transaction is the one
  at `0xeddf9e61…3d26` on Ethereum mainnet (`cast tx --raw`). Multicall3's is
  the one published in the Multicall3 README, and it is byte-identical to the
  transaction `0x07471adf…4ed1` on Base. Both recover to their keyless
  signers (`0x3fAB1846…5362` and `0x05f32B3c…63F2`), nonce 0, no chain id.
  Multicall3's initcode inside it equals its Ethereum mainnet creation input.
- **CREATE2 deployments.** Each initcode and salt is the input of the original
  creation transaction on Ethereum mainnet (tx hashes in `manifest.json`), all
  of which went through `0x4e59…956C`. `cast create2` over each salt and
  initcode reproduces the canonical address, so the address itself commits to
  the exact initcode.
- **Code hashes.** The runtime code hash of every contract is identical on
  Ethereum mainnet and BNB Chain. The nine Safe hashes also match the `canonical`
  entries in the `safe-global/safe-deployments` registry.
- **Permit2 is the one chain-specific code.** It stores the chain id and its
  EIP-712 domain separator as immutables (bytes 6945–6976 and 6983–7014 of the
  runtime code). The expected hash for 3961 is the mainnet code with those two
  words set to 3961 and `0x4ef26026…8052`; the rehearsals produced exactly that
  hash (`0x1eaf0149…5b21`), and `verify.sh` also checks `DOMAIN_SEPARATOR()`.
- **EntryPoints** each create a SenderCreator in their constructor
  (`0x7fc98430…8348` for v0.6, `0xEFC2c144…167C` for v0.7); their code hashes
  match mainnet too.

## London-safe

Chain 3961 runs the London rule set: no PUSH0, no transient storage, no MCOPY.
Three independent checks:

1. **Opcode scan** (`opscan.py`) of every initcode and every runtime code:
   clean. The scan walks the code as the EVM decodes it, skipping PUSH
   immediates, metadata and unreachable data. It finds one `0x49` byte in the
   Safe proxy factory, and that byte is part of the revert string "Invalid
   singleton address provided", not code. As a check that the scan catches
   real cases, it flags EntryPoint v0.8 (PUSH0 ×131, TSTORE ×2, TLOAD, MCOPY)
   and Seaport 1.6 (PUSH0 ×275, TLOAD ×10, TSTORE ×8).
2. **Compilers.** solc 0.7.6 (Safe), 0.8.12 (Multicall3) and 0.8.17 (Permit2,
   EntryPoint v0.6) predate PUSH0. EntryPoint v0.7 is solc 0.8.23 built for
   Paris, and the scan confirms it has no PUSH0.
3. **Execution.** Both rehearsals deploy and run everything under London: the
   anvil fork with `--hardfork london`, and our own `ferminux` node
   (v1.10.26 line), which has no later opcodes at all.

Not included, and why:

- **EntryPoint v0.8** needs PUSH0, TSTORE and MCOPY, so it cannot run here until
  the contract-engine upgrade.
- **Safe 1.4.1** is deployed through Safe's own singleton factory
  (`0x914d…43d7`), which Safe places per chain on request. The 1.3.0 set does
  not need it, because on Ethereum mainnet it went through `0x4e59…956C` with
  salt 0.
- **CreateX and ERC-1820** also use presigned transactions but were not asked
  for. CreateX's transaction would need 0.3 FMX of funding at its keyless
  signer.

## Broadcasting the keyless transactions

The CREATE2 deployer and Multicall3 transactions are signed without a chain id
(the pre-EIP-155 format), which is what lets the same transaction land on
every chain.

**Our nodes refuse them over RPC.** `chain/internal/fmxapi/api.go:1659`
(`SubmitTransaction`) returns `only replay-protected (EIP-155) transactions
allowed over RPC` unless the node was started with
`--rpc.allow-unprotected-txs`, which defaults to false. No node definition in
this repo sets it: `infra/compose/*.yml`, `infra/k8s/rpc/deployment.yaml`,
`infra/ops/*.sh` and `scripts/*.sh` all leave it off. The public RPC was **not**
probed, because that would mean sending a transaction to mainnet. `deploy.sh`
makes that probe itself when the owner runs it, and the probe costs nothing
(see below).

**The rest of the node accepts them.** The flag gates only RPC submission. The
transaction pool, p2p propagation and block building take unprotected
transactions like any other. EIP-155 adds chain-id signing but does not forbid
transactions without one, so the protocol treats them as valid. The signers
need no change. One
short-lived relay node that has the flag is enough. `relay-rehearsal.sh`
proves this on two local nodes built from `chain/`:

- node A is a signer with stock flags. `deploy.sh` pointed at A stops with
  "refuses pre-EIP-155 transactions" and spends nothing;
- node B is a relay with the flag. Pointed at B, both presigned transactions
  travel to A over p2p, and A seals them.

**Recommended route: a temporary local relay.** Run a throwaway full node on
the ops machine: RPC on 127.0.0.1 only, the flag on, deleted afterwards. No
production node changes, and nothing public ever accepts unprotected
transactions.

**Why not turn the flag on for the public RPC.** An endpoint that accepts
unprotected transactions lets anyone replay any pre-EIP-155 transaction ever
signed on any chain. If the key behind it holds FMX at the matching nonce,
that FMX moves. Geth turned the flag off by default for this reason, and it
should stay off on `rpc.ferminux.net`.

A fallback when a fresh node cannot sync: add the flag to one existing
**non-signer** node whose RPC is bound to localhost, reach it over an SSH
tunnel, deploy, then remove the flag and restart the node. This changes
production, so it needs the node owner.

## Cost

Both rehearsals gave identical figures, at the live base fee of 7 wei and a
1 gwei tip:

| Item | FMX |
|---|---:|
| Fund CREATE2 deployer's keyless signer (100,000 gas × 100 gwei) | 0.010000 |
| Fund Multicall3's keyless signer (1,000,000 gas × 100 gwei) | 0.100000 |
| Two funding transfers (42,000 gas) | 0.000042 |
| Twelve CREATE2 deployments (24,441,986 gas) | 0.024442 |
| **Total spent by the gas account** | **0.134484** |

- The exact figure was 0.134483986171387902 FMX.
- The gas account must hold **0.172164 FMX up front**: `deploy.sh` sends every
  transaction with its gas limit at a 2 gwei maximum fee, and the unused part
  stays in the account. Fund it with 0.18 FMX.
- The two presigned transactions pay a fixed 100 gwei. Of the 0.11 FMX that
  funds their signers, 0.094091 FMX pays their gas and 0.015909 FMX stays at the
  two keyless addresses for good, because nobody holds their keys.
- `deploy.sh plan` recomputes all of this from live state before anything is
  sent.

## Deploy steps (mainnet, after the go-ahead)

Run everything from the repo checkout on the ops machine. The gas account's key
stays in a Foundry keystore or on a Ledger; nothing here reads key files.

```sh
cd agents/contracts/script/canonical

# 0. Gas account: import once, then fund it with 0.18 FMX.
cast wallet import ops-deployer --interactive
export DEPLOYER=0x...        # its address

# 1. Plan (read-only). Expect "missing: 14" and "must hold up front: 0.172164".
./deploy.sh plan

# 2. Temporary relay (second terminal). RPC is localhost only, datadir is throwaway.
../../../../chain/build/bin/ferminux --datadir /tmp/fmx-relay --syncmode snap \
  --http --http.addr 127.0.0.1 --http.port 8645 --http.api eth,net,web3,txpool \
  --authrpc.addr 127.0.0.1 --authrpc.port 8651 --ipcdisable \
  --rpc.allow-unprotected-txs
#    Wait until it is at the tip and has peers:
cast block-number --rpc-url http://127.0.0.1:8645   # equals the next line
cast block-number --rpc-url https://rpc.ferminux.net
cast rpc net_peerCount --rpc-url http://127.0.0.1:8645   # not "0x0"

# 3. Deploy (16 transactions in sequence, about 2-3 minutes at 7 s blocks).
SIGNER="--account ops-deployer" CONFIRM=deploy-canonical-3961 \
  UNPROTECTED_RPC_URL=http://127.0.0.1:8645 ./deploy.sh apply

# 4. Verify, then stop the relay (Ctrl-C) and delete its data.
./verify.sh                  # expect "44 passed, 0 failed"
rm -rf /tmp/fmx-relay
```

Notes:

- `SIGNER` takes any `cast` wallet options. `--account` asks for the keystore
  password each time the key is used: once to confirm the address, then once
  for each of 14 transactions. Add `--password-file <file>` to avoid that, or
  use `--ledger`.
- `deploy.sh apply` checks the relay before it spends anything. It submits the
  CREATE2 deployer's presigned transaction while that signer holds 0 FMX. A
  relay that accepts unprotected transactions answers "insufficient funds", so
  nothing enters the pool. A relay that refuses them makes the script stop with
  nothing spent.
- A run that stops partway is safe to repeat. Deployed contracts are skipped,
  keyless signers are topped up only by the difference, and a presigned
  transaction still pending is recognised ("already known"). `apply` refuses
  to start while the gas account still has a transaction pending, so a re-run
  after a receipt timeout cannot send a second top-up.
- If the relay finds no peers, add `--bootnodes <enode>`, using the bootnode
  list the operators already use.

## Verification checklist

After step 3:

1. `./verify.sh` prints `44 passed, 0 failed`. That covers, for all 14 contracts
   and both SenderCreators: the code hash matches, the opcode scan is clean,
   the CREATE2 deployer predicts the right address, Multicall3 returns chain id
   3961, Permit2's domain separator matches, both Safe singletons are locked at
   version 1.3.0, the fallback handler answers ERC-165, the proxy factory's
   proxy code hash is `0xb89c1b3b…b000`, and both EntryPoints serve
   `getNonce`.
2. `cast nonce 0x3fAB184622Dc19b6109349B94811493BF2a45362` and
   `cast nonce 0x05f32B3cC3888453ff71B01135B34FF8e41263F2` both return 1.
3. On explorer.ferminux.net, both presigned transactions show under their usual
   hashes: `0xeddf9e61fb9d8f5111840daef55e5fde0041f5702856532cdbb5a02998033d26`
   and `0x07471adfe8f4ec553c1199f495be97fc8be8e0626ae307281c22534460184ed1`.
4. The gas account's balance fell by about 0.1345 FMX (`deploy.sh` prints the
   exact amount).
5. Follow-ups in other lanes, now unblocked:
   - set `multicall3` in `wallet-web/src/lib/chains.ts` (wallet lane);
   - batch the per-id reads in `agents/web/src/nft.ts` (`statuses`) through
     Multicall3;
   - update the "no multicall contract" note on
     `FerminuxCitizens.tokensInfo`;
   - add chain 3961 to Multicall3's `deployments.json` and to
     `safe-global/safe-deployments` (these PRs need a GitHub login).

## Conflicts

`deploy.sh` stops before sending anything if an address already holds
different code (`CONFLICT`), or if a keyless signer's nonce is above 0 while
its contract is missing (`BURNED`). Neither can happen through these
transactions: a CREATE2 address commits to the initcode, and a keyless nonce
can be used only by its one presigned transaction. If either shows up, find
out how before doing anything else. A burned keyless nonce means that contract
can never reach its canonical address on this chain.

## Rehearsal record

Run on 2026-09-26:

- `rehearse.sh` forked block 413398 of the live chain on anvil with
  `--hardfork london` and no built-in CREATE2 deployer. It gave a fresh gas
  account exactly 0.172164 FMX. Results:
  - `apply` deployed all 14 and spent 0.134483986171387902 FMX;
  - a second `apply` changed nothing;
  - `verify.sh` passed 44 checks with 0 failures;
  - `CanonicalSmoke.s.sol` sent 19 transactions and all succeeded. They
    covered the CREATE2 deployer, Multicall3 `aggregate3`, Permit2 allowance
    and signature transfers of WFMX, a Safe on the L2 singleton running an
    owner-signed MultiSendCallOnly batch with the fallback handler, a Safe on
    the plain singleton, and one signed user operation through each
    EntryPoint. Each user operation created its account through initCode and
    paid FMX out.
- `relay-rehearsal.sh` ran two local `ferminux` 1.10.26 nodes with the London
  rule set. Results:
  - through the signer (stock flags), the probe was refused with "only
    replay-protected (EIP-155) transactions allowed over RPC" and nothing was
    spent;
  - through the relay, all 14 deployed. The presigned transactions were sealed
    by the signer node in blocks 9 and 14, and the spend was the same
    0.134483986171387902 FMX;
  - `verify.sh` passed 44 checks with 0 failures.
