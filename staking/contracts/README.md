# Ferminux Staking Contracts

> **Status, 2026-09-26: not deployed on chain 3961, and the hand-off they were built for
> was dropped.** Chain 3961 runs Clique proof-of-authority (a set of authorised signers,
> operated by the foundation today); no stake-based engine is planned at block 4,500,000
> and no client reads `getValidators()`. `FORK_BLOCK`, the validator-track tier and the
> slashing hooks are inert design leftovers. The validator programme being built now is a
> separate contract set in `agents/contracts/src/validators/`. See the status note at the
> top of `staking/DESIGN.md`.

Implements `staking/DESIGN.md`: a four-tier weighted FMX staking vault with a
prefunded fail-closed reward pool, and a stake-gated node registry whose
`getValidators()` view was meant as the hand-off surface for a stake-based engine at block
4,500,000 (dropped; see above).

Self-contained Foundry project. solc 0.8.24 pinned, optimizer on,
`evm_version = paris` — ferminux-geth (geth v1.10.26 fork) has **no PUSH0**;
both contracts disassemble to zero PUSH0 opcodes (creation and runtime).

## Contracts

| Contract | Runtime size | Purpose |
|---|---:|---|
| `src/FMXStaking.sol` | 14,945 B | Native FMX staking: Flexible 1.0x/10%, Locked-90 1.5x/15%, Locked-180 2.0x/20%, Validator-track 2.0→3.0x/20–30% (uptime-boosted). Continuous accumulator (no snapshot to snipe), 1.2M FMX/yr drip hard cap, fail-closed pool, 7-day cooldown, emergency exit (forfeit rewards; +5% penalty only on an unexpired lock), pausable deposits (never withdrawals), premine deny list, 48h-timelocked parameters, owner = MinimalMultisig. |
| `src/NodeRegistry.sol` | 15,059 B | Node registration (64-byte devp2p pubkey + consensus address + possession signature) bonded by one ≥25,000 FMX validator-track position. Watchtower epoch attestations (1-day epochs, 7-day dispute window, multisig void) whose only power is the 2.0↔3.0x boost. Post-fork slashing hook (inert until block 4,500,000; max 5%). No per-node rewards, by design — that is the Sybil defence. |

## PoS migration surface (read by the future PoSA client)

```solidity
// NodeRegistry — the fixed ABI from DESIGN.md section 5:
function getValidators() external view
    returns (address[] memory consensusAddrs, uint256[] memory bonds);
// top-21 by bond; qualifying = active node + Active position >= 25k FMX
// + >=95% mean attested uptime over the trailing 90 finalized epochs.
// Deterministic (ties -> lower node id): every client derives the same set.

// Supporting views: uptimeOver90Epochs(id), isQualified(id), getNode(id),
// getNodePubkey(id), listActiveNodes(), and FMXStaking.getPosition(id).
// Constants: FORK_BLOCK = 4_500_000, VALIDATOR_LOCK_BLOCK = 4_680_000,
// MIN_VALIDATOR_STAKE = 25_000 ether.
```

## Scripts

```sh
# local devnet on the assigned port (NEVER the live chain)
anvil --port 8610 --chain-id 3961

forge script script/DeployStaking.s.sol --rpc-url http://127.0.0.1:8610 --broadcast
# env: DEPLOYER_KEY, OWNER (mainnet: the multisig), WATCHTOWER

STAKING=0x... AMOUNT_FMX=1500000 \
forge script script/FundRewards.s.sol --rpc-url http://127.0.0.1:8610 --broadcast
# env: STAKING, AMOUNT_FMX or AMOUNT_WEI, FUNDER_KEY
```

Mainnet deployment (when approved): deploy with `OWNER` = MinimalMultisig
`0x910BD467D8576277f8f96DF47428377FFD94fEfe`; the script prints the
`initNodeRegistry` calldata for the multisig to submit. Funding the 1.5M FMX
pool is a plain `fundRewards()` call with value from the ecosystem wallet.

## Tests

`forge test` — 133 tests: 58 vault unit tests, 26 reward-math tests
(including the DESIGN.md runway table, drip-cap pro-rata, pool exhaustion,
deposit-snipe attacks), 43 registry tests, 4 invariants + 2 fuzz suites
(solvency, unit/principal bookkeeping, exact FMX conservation,
payouts ≤ funding + recycled penalties, fair-share bounds, rounding drift).

PUSH0 gate: `cast disassemble $(forge inspect <C> deployedBytecode) | grep -c PUSH0` → 0.
