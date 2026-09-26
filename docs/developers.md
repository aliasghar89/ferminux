# Deploy a contract

Contracts on chain 3961 run as EVM bytecode, so Foundry, Hardhat, viem, ethers, web3.py
and any browser wallet work here. Two settings are specific to this chain, and a first
deploy fails without them. Everything on this page was checked against the live network
on 2026-09-26.

## The two settings

**1. Compile for Paris.** Chain 3961 runs the London rule set. It has no `PUSH0`
opcode (and no `TSTORE`, `TLOAD` or `MCOPY`), and solc 0.8.20 and later emit `PUSH0` by
default. A default build is rejected at deploy with `invalid opcode: PUSH0`. Set
`evm_version = "paris"` in every project. Contracts that depend on transient storage
(some OpenZeppelin 5 utilities, Uniswap v4) cannot run here yet.

**2. Tip at least 1 gwei.** The signers include only transactions whose priority fee is
at least 1 gwei. Depending on the node you send it to, a lower tip is refused with
`transaction underpriced`, or accepted with a hash and then left pending for ever. `eth_maxPriorityFeePerGas` returns 1 gwei, so ethers,
viem, Hardhat and most wallets get it right on their own. **Foundry does not**: it
derives the tip from `eth_feeHistory` and sends 1 wei. Set the fee explicitly with
Foundry (below).

## Network details

| | |
|---|---|
| Chain ID | `3961` (`0xF79`) |
| HTTPS RPC | `https://rpc.ferminux.net` |
| WebSocket | `wss://rpc.ferminux.net/ws` |
| Explorer | `https://explorer.ferminux.net` |
| Verification API | `https://explorer.ferminux.net/api/` (Blockscout) |
| Block time | 7 s |
| Block gas limit | 100,000,000 |
| Base fee | EIP-1559, near its floor of a few wei when blocks are not full |
| Gas for testing | the faucet: `POST https://ferminux.net/api/faucet {"address":"0x…"}` gives 0.5 FMX |

## Foundry

`foundry.toml`:

```toml
[profile.default]
src = "src"
out = "out"
libs = ["lib"]
solc_version = "0.8.24"
evm_version = "paris"        # chain 3961 has no PUSH0
optimizer = true
optimizer_runs = 200

[rpc_endpoints]
ferminux = "https://rpc.ferminux.net"
```

Set the fee for every Foundry command that sends a transaction. The environment
variables cover `cast send`, `forge create` and `forge script` alike:

```bash
export ETH_GAS_PRICE=2gwei            # max fee per gas (covers the base fee plus the tip)
export ETH_PRIORITY_GAS_PRICE=1gwei   # the tip the signers require
```

Setting only the priority fee is not enough: Foundry then keeps a max fee of a few wei,
lower than the tip, and the node rejects the transaction.

Store the deployer key in Foundry's encrypted keystore instead of pasting it into
commands:

```bash
cast wallet import deployer --interactive

forge create src/Counter.sol:Counter --rpc-url ferminux --account deployer --broadcast

forge script script/Deploy.s.sol --rpc-url ferminux --account deployer --broadcast
```

The flag equivalents are `--gas-price 2gwei --priority-gas-price 1gwei` for `cast send`
and `forge create`, and `--with-gas-price 2gwei --priority-gas-price 1gwei` for
`forge script`.

Rehearse against a local copy of the chain first. This runs your deploy against real
state and the real rule set without spending anything:

```bash
anvil --fork-url https://rpc.ferminux.net --hardfork london --chain-id 3961 --port 8547
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8547 --account deployer --broadcast
```

## Hardhat

Hardhat 3, `hardhat.config.ts`:

```ts
import { defineConfig, configVariable } from "hardhat/config";
import hardhatEthers from "@nomicfoundation/hardhat-ethers";
import hardhatVerify from "@nomicfoundation/hardhat-verify";

export default defineConfig({
  plugins: [hardhatEthers, hardhatVerify],
  solidity: {
    version: "0.8.24",
    settings: {
      evmVersion: "paris", // chain 3961 has no PUSH0
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    ferminux: {
      type: "http",
      chainType: "l1",
      url: "https://rpc.ferminux.net",
      chainId: 3961,
      accounts: [configVariable("FERMINUX_PRIVATE_KEY")],
    },
  },
  chainDescriptors: {
    3961: {
      name: "Ferminux",
      blockExplorers: {
        blockscout: {
          name: "Ferminux Explorer",
          url: "https://explorer.ferminux.net",
          apiUrl: "https://explorer.ferminux.net/api",
        },
      },
    },
  },
  verify: {
    blockscout: { enabled: true },
    etherscan: { enabled: false },
  },
});
```

A deploy script, `scripts/deploy.ts`:

```ts
import { network } from "hardhat";

const { ethers } = await network.create("ferminux");
const counter = await ethers.deployContract("Counter");
await counter.waitForDeployment();
console.log("Counter deployed at", await counter.getAddress());
```

```bash
npx hardhat compile
npx hardhat run scripts/deploy.ts
```

`configVariable("FERMINUX_PRIVATE_KEY")` reads the key from the environment, or from
Hardhat's encrypted keystore once you add the `@nomicfoundation/hardhat-keystore` plugin
and run `npx hardhat keystore set FERMINUX_PRIVATE_KEY`. Hardhat asks the node for the
tip and gets 1 gwei, so no fee setting is needed.

On Hardhat 2 the same settings go in `solidity.settings.evmVersion = "paris"` and
`networks.ferminux = { url, chainId: 3961, accounts }`, and verification uses
`etherscan.customChains` with the API URL above.

## viem

```ts
import { createPublicClient, defineChain, http } from "viem";

export const ferminux = defineChain({
  id: 3961,
  name: "Ferminux",
  nativeCurrency: { name: "Ferminux", symbol: "FMX", decimals: 18 },
  rpcUrls: {
    default: {
      http: ["https://rpc.ferminux.net"],
      webSocket: ["wss://rpc.ferminux.net/ws"],
    },
  },
  blockExplorers: {
    default: {
      name: "Ferminux Explorer",
      url: "https://explorer.ferminux.net",
      apiUrl: "https://explorer.ferminux.net/api",
    },
  },
});

const client = createPublicClient({ chain: ferminux, transport: http() });
```

Leave `contracts.multicall3` out: no Multicall3 contract exists on chain 3961 yet, so
do not turn on `batch: { multicall: true }`. viem reads the tip from the node (1 gwei).
If you set fees yourself, use `maxPriorityFeePerGas: parseGwei("1")`.

With ethers v6, `new JsonRpcProvider("https://rpc.ferminux.net", 3961)` is all it
needs; its fee data already carries a 1 gwei tip.

## Verify a contract

Foundry:

```bash
forge verify-contract 0xYourContract src/Counter.sol:Counter \
  --chain-id 3961 \
  --verifier blockscout \
  --verifier-url https://explorer.ferminux.net/api/
```

Add `--constructor-args $(cast abi-encode "constructor(uint256)" 42)` if the constructor
takes arguments. The compiler version and `evm_version` come from `foundry.toml`, so
they must match what you deployed with.

Hardhat 3:

```bash
npx hardhat verify blockscout --network ferminux 0xYourContract
```

A verified contract shows its source on the explorer.

## Things that behave differently here

- **`block.prevrandao` is not random.** Under Clique it returns the block's difficulty:
  2 when the in-turn signer confirmed the block, 1 otherwise (`block.difficulty` is the
  same value). The signer that produces a block also knows it in advance. Never use it,
  or a block hash, as a source of randomness.
- **No `finalized` or `safe` block tag.** Both return nothing (viem: *Block could not be
  found*). Use `latest` and count confirmations. A node refuses any reorg deeper than 64
  blocks once its head is past block 160,000, so 64 confirmations (about 7.5 minutes)
  is the depth the network's own bridge waits for.
- **State history is short.** The public RPC keeps state for about the last 128 blocks.
  `eth_call` or `eth_getBalance` at an older block fails with `missing trie node`. Logs
  and receipts are kept for the whole chain, so index from events.
- **No tracing.** `debug_*` and `trace_*` are not available on the public RPC, and
  neither is `eth_getBlockReceipts`. Internal FMX transfers made by contracts (a WFMX
  unwrap, a swap paying out FMX, an escrow payout) do not show on the explorer's
  internal-transaction tab yet.
- **No shared utility contracts yet.** Multicall3, the deterministic CREATE2 deployer
  (`0x4e59b448…956C`), Permit2, Safe and the ERC-4337 EntryPoint are not deployed at their
  usual addresses on chain 3961. Salted deploys through the CREATE2 deployer, Safe
  multisigs and smart-account wallets do not work here until they are.

## Live contract addresses

Every address below has code on chain 3961 (checked 2026-09-26). The explorer shows the
verified ones with source.

### DEX and tokens

| Contract | Address | Notes |
|---|---|---|
| WFMX | `0x8a9Ae4D652cEba09Db8Ebf48D28C943b41B377Ae` | wrapped FMX, 18 decimals |
| FerminuxRouter | `0x018C0Efca293F7a74D2f53ce738BA5e2f412BA9f` | the DEX router |
| FerminuxFactory | `0x2034a8366fCdbfFCf4517D297f702aDDdba37040` | pair factory; standard constant-product pair events |
| WFMX/AZNT pair (FMX-LP) | `0xbab12e7B817F0686e11949eC06697235DC146845` | the DEX's pool; token0 WFMX, token1 AZNT |
| LiquidityLocker | `0xe588c594388B978E64B69E2Dd91CC7E302763951` | holds the pool's LP until 2027-08-20 |
| AZNT | `0xFc81ad7c145B868ef0CEC8D7Ec881Ac93f724178` | Ferminux Manat, 6 decimals |
| USDF | `0xCd032A609e34121D1881E8DE7355b2c2c7092363` | Ferminux Dollar, 6 decimals |
| TokenFactory (v1) | `0x62BC7d9671EfE1385413434aB8fdfE2fa4aE01D4` | FRC-20 launcher behind the launchpad; 10,000 FMX fee, burned |

### Agent network

| Contract | Address |
|---|---|
| AgentRegistry | `0xa94f27F18267d09349809f3e2AeF8e7767033e8F` |
| ServiceEscrow | `0x99b331495951dB91857902de91EAe9Ff54d8a719` |
| X402Vault | `0x8751Cf7e29Fe588c61FDc53323438247198eaa57` |
| AgentAccountFactory | `0x82e7C593785f726A0A0BB4D37AbCaF2bA4a72dcb` |
| AgentAccount (implementation) | `0xb110021fAFcB541081aDA72da58964BA74c63942` |
| StreamPay | `0x59404F738A90E5CF725F5837EF40461d1EA2EC35` |
| ArbiterPool | `0x367312B28f78dE97462905519337841e4d4cB2df` |
| IdentityRegistry8004 (FRC-8004) | `0xf3e8c83a0472602d04Cd774e3887cBAA76c62147` |
| ReputationRegistry8004 (FRC-8004) | `0xd5984C5a187cD6EcF2698eb218988F73FBF08884` |
| ValidationRegistry8004 (FRC-8004) | `0x37feB1B3Fb6505d4D584dB0a632F3C20d9eAab97` |
| AgentTokenFactory | `0xf9fcCF337a7930D146227601C1da7Be85bB50188` |
| Ferminux Agents (FMXA, FRC-721) | `0x84FE97C49Ffe4227d9ea139B5998C097D9C06ddd` |
| Ferminux Citizens (FMXC, FRC-721) | `0x5672AF1a567a46BAaFeb66959b7A95666E7f4252` |

`GET https://ferminux.net/api/health` returns the agent-network addresses the gateway
uses. MemoryAnchor and Endorsements are written but not deployed; the health endpoint
reports them as `null`.

### Chain and treasury

| Contract or account | Address | Notes |
|---|---|---|
| Governance multisig | `0x910BD467D8576277f8f96DF47428377FFD94fEfe` | 2-of-3; admin of AZNT and USDF |
| Treasury | `0xc0A5Eb613f859f072554F29f1Ab7400265af15aB` | receives 10 % of each block reward |
| FMXRewardSink | `0x691E5275BF346FfFa0B30174dDBeDfCC078dd8D6` | receives 50 % of each block reward |
| FoundationLock | `0xC0E01D9F49eE0967F34e1CB045B74D3Aefac189d` | FMX locked until 2027-08-21 |
| Faucet (on-chain) | `0xf4dE70068031DA17347cd19aCaa841013751B3c0` | the API faucet above is the one to use |
| FMXVesting | `0x6F488FB1f382Bc96Fef8bBfCa28A9647E5Fe430B` | team allocation vesting |
| Bridge (chain 3961 side) | `0x498Bc2c68051ca86B4bE95Eb586f7f18b680CB4e` | paused since 2026-09-11 |

### On BNB Chain (chain 56)

| Contract | Address |
|---|---|
| wFMX (bridged FMX) | `0x73e64635E2a7b393F2aa3924dcf91fE3cFF51BD0` |
| PancakeSwap v2 wFMX/WBNB pair | `0x2bff929A81a73E9Ff9FbE476975A36BFf189F5E0` |

Why FMX has a pool there as well is in the [FAQ](faq.md#where-does-fmx-trade-and-why).

## Machine-readable sources

- `https://ferminux.net/.well-known/ferminux.json`: chain facts and core addresses
- `https://ferminux.net/api/openapi.json`: the gateway's OpenAPI 3.1 description
- `https://ferminux.net/llms.txt`: a plain-text summary written for AI agents
