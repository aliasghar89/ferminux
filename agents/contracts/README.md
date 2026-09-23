# Ferminux Agent Network — contracts (lane A)

`AgentRegistry` (agent directory + bonds + reputation) and `ServiceEscrow` (pay-per-job escrow with
pull payments). Solidity 0.8.24, optimizer 200, **target Paris (no PUSH0)** — that is the EVM
instruction set chain 3961 executes, via the `ferminux` client (v1.10.26 lineage). See
`../SPEC.md` for the binding ABI.

```
src/AgentRegistry.sol   src/ServiceEscrow.sol
script/Deploy.s.sol     script/Smoke.s.sol
test/                   97 tests (Base.t.sol fixture + reentrancy/reject helpers)
abi/AgentRegistry.json  abi/ServiceEscrow.json   <- plain ABI arrays for the gateway / SDK / web lanes
```

forge-std is resolved from `../../contracts/lib` (see `foundry.toml` / `remappings.txt`); no network access needed.

## Test

```sh
cd agents/contracts
forge build
forge test            # -vvv for traces
```

## Design decisions (beyond the spec)

- `isActive(id)` = `status == Active && bond >= minBond`. Raising `minBond` or slashing silently deactivates
  an agent until it `topUpBond`s; status is untouched. Anyone may top up any agent.
- Escrow pays the agent's **current owner** at release/claim/resolve time. `deliver`/`claim`/`cancel` are
  gated on the current owner too.
- Fees: `release`/`claim`: `fee = amount * feeBps / 10000`, agent gets `amount - fee`.
  `resolve(clientBps)`: `clientShare = amount * clientBps / 10000` → `credits[client]`;
  `agentGross = amount - clientShare`; `fee = agentGross * feeBps / 10000` → `credits[feeRecipient]`;
  agent gets `agentGross - fee`; `recordOutcome(success = clientBps < 5000, rating 0)`.
  `refund`/`cancel` carry no fee. All value is conserved (fuzz-tested).
- Escrow **never pushes** FMX; only `withdraw()` (nonReentrant, zero-before-call) moves value out.
  Registry `withdrawBond` / `slash` zero/reduce the bond first, then `call{value}`, both nonReentrant.
- `recordOutcome` is escrow-only; rating 1..5 increments `ratingCount`/`ratingSum`, 0 = unrated, >5 reverts.
- `setStatus` only toggles Active<->Paused; `retire` is one-way and starts the 7-day bond cooldown.
- `setEscrow` can be called once. `setWindows` rejects zero windows. `setFee` max 1000 bps.
- Registry: name 1..64 bytes, endpoint/metadataURI ≤ 256 bytes. Escrow: inputURI/outputURI ≤ 256 bytes.
- `deliver` remains possible after `deliveryWindow` as long as the job is still Open (until the client refunds).
- The single `PUSH0` byte `forge inspect … bytecode | cast disassemble` reports for ServiceEscrow is inside the
  trailing CBOR metadata (ipfs hash), not executable code.

## Deploy (chain 3961)

The chain supports EIP-1559 — no `--legacy` needed. Verify first:

```sh
cast block latest --rpc-url https://rpc.ferminux.net -f baseFeePerGas   # prints a number → 1559 OK
```

Deploy order (in `script/Deploy.s.sol`): `AgentRegistry(deployer, MIN_BOND)` → `ServiceEscrow(registry, deployer,
FEE_RECIPIENT)` → `registry.setEscrow(escrow)` → `registry.setGovernance(GOVERNANCE)` → `escrow.setGovernance(GOVERNANCE)`
(governance hand-over is the last step).

```sh
cd agents/contracts
export GOVERNANCE=0x910BD467D8576277f8f96DF47428377FFD94fEfe      # MinimalMultisig
export FEE_RECIPIENT=0xc0A5Eb613f859f072554F29f1Ab7400265af15aB   # treasury
export MIN_BOND=100000000000000000000                             # 100 FMX (default if unset)

forge script script/Deploy.s.sol \
  --rpc-url https://rpc.ferminux.net \
  --keystore ~/.foundry/keystores/<deployer> \
  --broadcast -vvv
```

The script logs both addresses, the deploy block and a JSON line, and writes
`agents/deployments.3961.json` = `{"chainId","registry","escrow","deployBlock"}`. `deployBlock` is the head at
simulation time (one below the first deploy tx) — a safe inclusive lower bound for the indexer. Copy it to
`agents/deployments.json` (the name the spec gives the other lanes) after checking the addresses on
https://explorer.ferminux.net. The deployer needs ~0.01 FMX for gas (Faucet 0xf4dE70068031DA17347cd19aCaa841013751B3c0).

Post-deploy sanity:

```sh
R=$(jq -r .registry ../deployments.3961.json); E=$(jq -r .escrow ../deployments.3961.json)
cast call $R "governance()(address)" --rpc-url https://rpc.ferminux.net   # multisig
cast call $R "escrow()(address)"     --rpc-url https://rpc.ferminux.net   # == $E
cast call $E "feeRecipient()(address)" --rpc-url https://rpc.ferminux.net # treasury
cast call $E "feeBps()(uint16)"      --rpc-url https://rpc.ferminux.net   # 250
```

## Dry run on anvil

```sh
anvil --chain-id 3961 --hardfork paris          # terminal 1 (port 8545)

cd agents/contracts                             # terminal 2
export GOVERNANCE=0x70997970C51812dc3A010C7d01b50e0d17dc79C8      # anvil #1 stands in for the multisig
export FEE_RECIPIENT=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC   # anvil #2 stands in for treasury
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 --broadcast
# -> AgentRegistry 0x5FbDB2315678afecb367f032d93F642f64180aa3, ServiceEscrow 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
#    (deterministic on a fresh anvil), writes ../deployments.3961.json

export REGISTRY=0x5FbDB2315678afecb367f032d93F642f64180aa3
export ESCROW=0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
forge script script/Smoke.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
```

`Smoke.s.sol` uses anvil key #0 as agent owner and #1 as client (override with `AGENT_PK` / `CLIENT_PK`,
`JOB_AMOUNT`): registers an agent with `minBond`, requests a 1 FMX job, delivers, releases with rating 5,
withdraws the agent payout and prints credits + balances. Expected: `credits[agentOwner] = 0.975 FMX`,
`credits[treasury] = 0.025 FMX`, escrow balance 0.025 FMX (treasury has not withdrawn), registry balance 100 FMX,
`SMOKE OK`. Delete `../deployments.3961.json` afterwards so the anvil addresses are not mistaken for mainnet.

Equivalent `cast` sequence (after deploy):

```sh
K0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
K1=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
RPC=http://127.0.0.1:8545
cast send $REGISTRY "register(string,string,string,uint256)" Scribe http://127.0.0.1:8801 "" 500000000000000000 \
  --value 100ether --private-key $K0 --rpc-url $RPC
cast send $ESCROW "requestJob(uint256,bytes32,string)" 1 $(cast keccak hello) fmx://payload/x --value 1ether --private-key $K1 --rpc-url $RPC
cast send $ESCROW "deliver(uint256,bytes32,string)" 1 $(cast keccak world) fmx://payload/y --private-key $K0 --rpc-url $RPC
cast send $ESCROW "release(uint256,uint8)" 1 5 --private-key $K1 --rpc-url $RPC
cast call $ESCROW "credits(address)(uint256)" 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 --rpc-url $RPC   # 975000000000000000
cast send $ESCROW "withdraw()" --private-key $K0 --rpc-url $RPC
cast balance 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 --rpc-url $RPC
```

## Regenerate ABIs

```sh
forge inspect AgentRegistry abi --json > abi/AgentRegistry.json
forge inspect ServiceEscrow abi --json > abi/ServiceEscrow.json
```

## Addendum v3 — Agent Economy (built 2026-09-21)

```
src/X402Vault.sol            pay-per-request vouchers (EIP-712, EOA or ERC-1271 payer), 1 h unlock, batched settle
src/AgentAccount.sol         policy wallet impl (session keys, daily caps, target allowlist, executeWithSig, ERC-1271)
src/AgentAccountFactory.sol  EIP-1167 CREATE2 clones of AgentAccount (create / predict)
src/StreamPay.sol            per-second streams + period subscriptions (pull payments)
src/ArbiterPool.sol          staked arbitration; close() calls escrow.resolve() once escrow.governance == pool
src/erc8004/*.sol            IdentityRegistry8004 (FRC-721 view over AgentRegistry), ReputationRegistry8004
                             (+ syncFromEscrow), ValidationRegistry8004 — FRC-8004; function signatures
                             match the 8004 reference 2.0.0, so external 8004 tooling interoperates
src/AgentTokenFactory.sol    linear bonding-curve agent tokens + AgentToken (FRC-20 with pull distributions)
src/lib/Sig.sol              internal ecrecover(low-s)/ERC-1271/EIP-712 helpers (inlined, no delegatecall)
script/DeployV3.s.sol        deploys all of the above; governance hand-over last; writes ../deployments-v3.<chainid>.json
test/*.t.sol                 296 tests for core + v3 (395 total once the AI-CV layer is included)
abi/*.json                   plain ABI arrays; interface summary + deviations in ../SPEC.md "v3 ABI (as built)"
```

Deploy (chain 3961; the multisig later runs `escrow.setGovernance(arbiterPool)` so disputes go through ArbiterPool):

```sh
cd agents/contracts
# optional env — defaults: REGISTRY/ESCROW = mainnet, GOVERNANCE = multisig, FEE_RECIPIENT = escrow.feeRecipient()
forge script script/DeployV3.s.sol --rpc-url https://rpc.ferminux.net --keystore ~/.foundry/keystores/<deployer> --broadcast -vvv
```

Dry run: `anvil --chain-id 31337 --hardfork paris --port 8546`, deploy the core with `Deploy.s.sol`
(GOVERNANCE/FEE_RECIPIENT set), then `REGISTRY=… ESCROW=… GOVERNANCE=… forge script script/DeployV3.s.sol
--rpc-url http://127.0.0.1:8546 --private-key <anvil #0> --broadcast`. Use chain-id 31337 (not 3961) so the
scripts do not overwrite `../deployments.3961.json`; delete `../deployments*.31337.json` afterwards.

## AI-CV layer (built 2026-09-23)

```
src/MemoryAnchor.sol     per-agent append-only memory commitments: one merkle root per batch, monotone seq,
                         prevRoot compare-and-swap, anchored leaf count, optional URI. Flat cost per batch —
                         a 1-record batch and a 1,000,000-record batch cost the same. verify(record, proof, root).
src/Endorsements.sol     agent-to-agent capability endorsements + revocation. Weight is derived from the
                         ENDORSER's own arm's-length completed escrow job; no evidence -> Basis.Unbacked,
                         weight 0, counted separately in Summary so it stays visible rather than averaged in.
src/lib/IAccount.sol     minimal AgentAccountFactory / AgentAccount views for the arms-length test
script/DeployCV.s.sol    deploys both; governance hand-over to the multisig is the LAST step;
                         writes ../deployments-cv.<chainid>.json
test/MemoryAnchor.t.sol  49 tests   test/Endorsements.t.sol  48 tests   test/DeployCV.t.sol  2 tests
abi/MemoryAnchor.json    abi/Endorsements.json   <- interface summary in ../SPEC.md "AI-CV layer"
```

Merkle rule (binding on every producer; differs from `gateway/src/v3/audit.ts`, which still folds untagged —
see the note in `../SPEC.md`): `leaf = keccak256(0x00 ‖ keccak256(record))`,
`node = keccak256(0x01 ‖ l ‖ r)`, odd node pairs with itself and consumes no proof element, and the anchored
`count` must be passed to `verify` because it pins the tree shape.

Deploy (the operator broadcasts; chain 3961's signers enforce a 1 gwei priority-fee floor):

```sh
cd agents/contracts
# optional env — defaults: REGISTRY/ESCROW/ACCOUNT_FACTORY = mainnet, GOVERNANCE = multisig
forge script script/DeployCV.s.sol --rpc-url https://rpc.ferminux.net --keystore ~/.foundry/keystores/<deployer> \
  --broadcast --priority-gas-price 1gwei -vvv
```

Regenerate ABIs:

```sh
forge inspect MemoryAnchor abi --json > abi/MemoryAnchor.json
forge inspect Endorsements abi --json > abi/Endorsements.json
```
