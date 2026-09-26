# Ferminux Network — Core Contracts

Foundry project for the core contracts of the Ferminux Network
(chain id **3961**, native coin **FMX**, 18 decimals). The table below covers the five
that `DeployCore.s.sol` deploys; `USDF`, `FMXRewardSink` and `FoundationLock` live in
`src/` too. Live addresses are in the table at <https://docs.ferminux.net/developers>.

| Contract | File | Purpose |
|---|---|---|
| `AZNT` | `src/AZNT.sol` | AZN-backed stablecoin, 6 decimals, USDC-style roles, pause, blacklist, EIP-2612 permit |
| `FMXVesting` | `src/FMXVesting.sol` | Irrevocable linear vesting of native FMX (team allocation) |
| `Faucet` | `src/Faucet.sol` | Rate-limited native FMX drip for new users |
| `TokenFactory` / `FerminuxToken` | `src/TokenFactory.sol` | One-click FRC-20 launcher with a launch fee and an on-chain registry. The deployed factory (`0x62BC…01D4`) charges **10,000 FMX** and its fee collector is `0x…dEaD`, so every fee is burned and, because only the collector can call `setFee`, the fee can no longer change |
| `MinimalMultisig` | `src/MinimalMultisig.sol` | Small M-of-N owner multisig (deployed 2-of-3 at `0x910B…fEfe`). Admin of AZNT and USDF |

## Layout

```
contracts/
├── foundry.toml          solc 0.8.24 pinned, optimizer on, evm_version = paris
├── src/                  the five contracts (the four pre-existing ones moved
│                         here byte-for-byte — SHA-256 verified, logic untouched)
├── test/                 forge-std test suite — 166 tests, all green
├── script/
│   └── DeployCore.s.sol  full-stack deployment
└── lib/forge-std/        test framework only (v1.16.2) — no runtime dependencies
```

Two build notes that matter:

- **`evm_version = "paris"`** — the `ferminux` node client (v1.10.26 lineage)
  pre-dates Shanghai: `PUSH0` is not a valid opcode on chain 3961, so bytecode
  must target Paris. Do not raise this without upgrading the chain client.
- **solc pinned to 0.8.24** — matches the `pragma ^0.8.24` in every contract.

## Build & test

```sh
cd <repo>/contracts
forge build
forge test          # 166 tests: AZNT 47, TokenFactory 42, MinimalMultisig 38,
                    #            FMXVesting 20, Faucet 19
forge test -vvv     # verbose traces on failure
```

Fresh checkout only needs forge-std: `forge install foundry-rs/forge-std`.

## MinimalMultisig in one minute

M-of-N owner multisig, fixed owner set and threshold (constructor-only), plain
`CALL` — no delegatecall, no upgradeability, no owner rotation. Receives native
FMX via `receive()`.

- `submit(to, value, data) -> txId` — owner proposes a call; **auto-confirms for
  the proposer** (so a 2-of-3 needs only one more `confirm`).
- `confirm(txId)` / `revoke(txId)` — add/withdraw an owner's confirmation while
  the tx is pending.
- `execute(txId)` — any owner, once confirmations ≥ threshold. The `executed`
  flag is set before the external call (no re-execution/reentrancy). If the
  call fails everything reverts and the tx stays pending and retryable.

## Deployment

`script/DeployCore.s.sol` deploys, in order:

1. `MinimalMultisig` — 2-of-3
2. `AZNT` — admin = multisig
3. `TokenFactory` — feeCollector = multisig
4. `Faucet` — owner = deployer (hand to the multisig later with
   `transferOwnership`)
5. `FMXVesting` — beneficiary, start = deploy time, cliff 180 days (~6 months),
   duration 1080 days (~36 months)

Env vars (all optional; defaults are anvil's dev accounts — **devnet only**):
`DEPLOYER_KEY`, `MSIG_OWNER1..3`, `VESTING_BENEFICIARY` (default: owner 1).

### Demo run (executed & verified on this machine)

Terminal A — throwaway local node (**never** the live docker devnet on 8545):

```sh
anvil --port 8547 --chain-id 3961
```

Terminal B:

```sh
cd <repo>/contracts
forge script script/DeployCore.s.sol --rpc-url http://127.0.0.1:8547 --broadcast
```

Deployed addresses from that run (deterministic on a fresh anvil — deployer is
anvil account #0 starting at nonce 0):

| Contract | Address |
|---|---|
| MinimalMultisig (2-of-3) | `0x5FbDB2315678afecb367f032d93F642f64180aa3` |
| AZNT (admin = multisig) | `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512` |
| TokenFactory (collector = multisig) | `0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0` |
| Faucet (owner = deployer) | `0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9` |
| FMXVesting | `0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9` |

Multisig owners in the demo = anvil accounts #0–#2:
`0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`,
`0x70997970C51812dc3A010C7d01b50e0d17dc79C8`,
`0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC`.

For a real deployment, set the env vars to hardware-wallet owner addresses and
a funded deployer key, point `--rpc-url` at `https://rpc.ferminux.net`, and
fund the Faucet and FMXVesting contracts with plain FMX transfers afterwards.

## Multisig walkthrough — grant AZNT MINTER through the 2-of-3

These exact commands were run against the anvil deployment above (all
succeeded, `status 1`). `KEY1`/`KEY2` are anvil keys #0/#1 — i.e. multisig
owners 1 and 2. The grantee is anvil account #3.

```sh
export RPC=http://127.0.0.1:8547
export MSIG=0x5FbDB2315678afecb367f032d93F642f64180aa3
export AZNT=0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
export KEY1=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
export KEY2=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
export MINTER_ADDR=0x90F79bf6EB2c4f870365E785982E1f101E93b906

# 1. the role id and the call we want the multisig to make
ROLE=$(cast keccak "MINTER")
# -> 0xf0887ba65ee2024ea881d91b74c2450ef19e1557f03bed3ea9f16b037cbe2dc9
DATA=$(cast calldata "grantRole(bytes32,address)" $ROLE $MINTER_ADDR)

# 2. owner 1 submits (auto-confirms; this became txId 0)
cast send $MSIG "submit(address,uint256,bytes)" $AZNT 0 $DATA \
  --private-key $KEY1 --rpc-url $RPC

# 3. owner 2 confirms — reaches the 2-of-3 threshold
cast send $MSIG "confirm(uint256)" 0 --private-key $KEY2 --rpc-url $RPC

# (optional) inspect the pending tx: to, value, data, executed, confirmations
cast call $MSIG "getTransaction(uint256)(address,uint256,bytes,bool,uint256)" 0 \
  --rpc-url $RPC
# -> ..., false, 2

# 4. any owner executes
cast send $MSIG "execute(uint256)" 0 --private-key $KEY1 --rpc-url $RPC

# 5. verify
cast call $AZNT "hasRole(bytes32,address)(bool)" $ROLE $MINTER_ADDR --rpc-url $RPC
# -> true
```

Proof the role works — the new minter mints 1,000 AZNT (6 decimals) to itself
(key #3 belongs to `$MINTER_ADDR`):

```sh
cast send $AZNT "mint(address,uint256)" $MINTER_ADDR 1000000000 \
  --private-key 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6 \
  --rpc-url $RPC
cast call $AZNT "balanceOf(address)(uint256)" $MINTER_ADDR --rpc-url $RPC
# -> 1000000000  (= 1,000 AZNT)
```

An owner who changes their mind before execution calls
`cast send $MSIG "revoke(uint256)" <txId>`; once confirmations drop below the
threshold, `execute` reverts with `MSIG: below threshold`.

The same pattern drives every privileged action: `TokenFactory.setFee`,
`TokenFactory.setFeeCollector`, `AZNT.grantRole/revokeRole/transferAdmin`, and
accepting an admin handover (`submit` a call to `acceptAdmin()` on AZNT after
the old admin ran `transferAdmin(msig)`).

## Test coverage map

- **AZNT (47)** — roles grant/revoke + onlyAdmin, two-step admin transfer
  (overwrite/cancel/lockout), mint/burn/destroyBlackFunds incl. paused &
  blacklisted paths, pause/unpause gating, blacklist on every transfer leg
  (sender/recipient/from/spender), transfer/transferFrom/approve incl.
  max-allowance and arithmetic underflows, EIP-2612 permit with real
  `vm.sign` signatures (valid, spendable, wrong signer, expired, replay,
  tampered value, chain-id fork of the domain separator), fuzz on mint,
  transfers and permit.
- **FMXVesting (20)** — constructor validation, funding events, cliff/linear/
  full vest math over `vm.warp`, incremental releases, mid-stream top-ups,
  beneficiary-only payout, zero-releasable revert, rejecting beneficiary,
  fuzz invariants (vested ≤ allocation, monotone bounds, accounting).
- **Faucet (19)** — drip payout/cooldown boundary/per-address isolation/empty/
  rejecting receiver (cooldown not burned), setConfig, withdraw incl. failure
  paths, ownership transfer, config fuzz.
- **TokenFactory + FerminuxToken (42)** — fee enforcement/forwarding/overpay/
  rejecting collector/zero fee, name/symbol/decimals/zero-supply validation at
  the exact boundaries, registry + `tokensOf` + `isFactoryToken`, `tokensPage`
  pagination edges (never reverts, fuzzed), setFee/setFeeCollector, launched
  token FRC-20 surface, mint cap edge, mintable gate, burn, renounce/transfer
  ownership, fuzz on fees and cap minting.
- **MinimalMultisig (38)** — constructor validation (owners, threshold, zero,
  duplicates, fuzzed threshold), deposits, full submit/confirm/revoke/execute
  lifecycle, every revert path (non-owner, unknown tx, double confirm/execute,
  below threshold, failed call, value > balance), failed-call retryability,
  1-of-1 and N-of-N edges, value fuzz, and integration: multisig as AZNT admin
  (grantRole), as TokenFactory collector (fee receipt + setFee), and accepting
  a two-step AZNT admin handover.
