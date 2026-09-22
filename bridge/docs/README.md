# Ferminux Bridge — Documentation

User and operator documentation for the **Ferminux Bridge**: a symmetric
lock-and-mint / burn-and-release bridge between the [Ferminux
Network](../../docs/README.md) (ChainID **3961**, native coin **FMX**) and other
EVM chains. One contract, the same bytecode, deployed on **every** chain
including Ferminux itself.

These documents describe the contracts in [`../contracts`](../contracts) as
shipped. Every function name, parameter, default and revert string quoted here
was checked against the source.

## Guides

| Doc | For | Covers |
|---|---|---|
| [how-it-works.md](how-it-works.md) | anyone about to move money | lock/mint vs burn/release in plain language, the journey of a transfer with real timings, fees with worked numbers, the caps, and what "validator-secured" honestly means |
| [security-model.md](security-model.md) | anyone deciding how much to risk | the threat model without euphemism: what one compromised validator can do (nothing), what a colluding quorum can do, what the timelock and caps bound the loss to, reorg risk per chain, and the Ronin / Wormhole / Nomad / Harmony post-mortems mapped to specific mitigations here |
| [operations.md](operations.md) | whoever is on call | pre-launch checklist, validator key ceremony, deployment order, registering pairs, launch caps, monitoring, incident response, and the pause/unpause decision tree |
| [deploy-remote-chain.md](deploy-remote-chain.md) | whoever adds the next chain | copy-paste bring-up for a new EVM chain: prerequisites, real gas costs in USD, deploy, verify, register, relayer config, mainnet smoke test, cap ramp |

## The design in one table

| | |
|---|---|
| Model | symmetric lock-and-mint / burn-and-release; one `FerminuxBridge` per chain per route |
| Token kinds | `CANONICAL` (the real asset lives here — lock on exit, release on arrival) and `WRAPPED` (an IOU — burn on exit, mint on arrival) |
| Native coin | `address(0)`, always canonical on its own chain, locked via a payable `send()` |
| Attestation | M-of-N validator EIP-712 signatures, default **2-of-3** |
| Signature binding | destination `chainId` + destination bridge address + `transferId` + every transfer field |
| Replay protection | `processed[transferId]`, set before any value moves |
| Per-transfer limit | `maxPerTransfer`, per token, both directions |
| Volume limit | `dailyCap` over a rolling, continuously-draining 24 h window; **separate buckets** for inbound and outbound |
| Fee | 10 bps default, taken at the origin of each leg; hard ceiling `MAX_FEE_BPS = 100` (1.00 %) |
| Fast (no delay) | `pause`, `pauseToken`, `unpause`, `unpauseToken`, `decreaseTokenLimits`, `setPauser`, `rescue` (surplus only), `withdrawFees` |
| Slow (48 h timelock) | token registration, cap **increases**, validator add/remove, threshold, fee, fee collector, timelock delay, ownership handover, wrapper-minter handover, wrapper bytecode pin — twelve whitelisted selectors, nothing else |
| Wrapped assets | `BridgeToken`: no owner, no owner-mint, no pause, no upgrade path, EIP-2612 permit; only the bridge can mint or burn. The minter seat is rotatable **only by the current bridge**, two-step with a 48 h delay, so a migration can carry the wrapped supply with it |
| Tests | 289, all green: unit, fuzz, two-chain simulation, stateful invariants, and a red-team regression suite covering every finding of the 2026-08-20 review |

## What you are trusting

Stated once, here, so nobody has to hunt for it:

> The destination chain cannot verify that anything happened on the source
> chain. It verifies **signatures**. If 2 of the 3 named validators collude,
> they can mint or release assets nobody ever locked — up to the caps — and no
> code in this repository can prevent it. The caps, the 48 h timelock and the
> instant pause bound the loss and buy warning time. They do not remove the
> trust.

The full version, including what a compromised owner multisig can do and why
Ferminux's proof-of-work hashrate is the weakest link in the whole design, is in
[security-model.md](security-model.md).

## Repo map

- [`../contracts/`](../contracts/README.md) — `FerminuxBridge.sol`,
  `BridgeToken.sol`, 289 tests, deploy scripts, the recorded two-anvil
  end-to-end proof
- [`../relayer/`](../relayer) — validator and submitter daemon (one binary,
  roles `validator`, `submitter`, `check`)
- [`../ui/`](../ui) — the bridge web interface
- [`../../docs/`](../../docs/README.md) — Ferminux Network documentation: run a
  node, mining, wallet setup, FAQ
- [`../../contracts/`](../../contracts) — the mainnet contracts the bridge
  interoperates with (`MinimalMultisig`, `AZNT`, `TokenFactory`, `Faucet`)

## Live references

| | |
|---|---|
| Ferminux ChainID | 3961 (`0xF79`) |
| Public RPC | https://rpc.ferminux.net (also https://ferminux.net/rpc) |
| Explorer | https://explorer.ferminux.net (Blockscout v2 API at `/api/v2`) |
| Owner multisig on Ferminux | `MinimalMultisig` 2-of-3 at `0x910BD467D8576277f8f96DF47428377FFD94fEfe` |
| AZNT (6 decimals) | `0xFc81ad7c145B868ef0CEC8D7Ec881Ac93f724178` |
| Build settings | solc **0.8.24**, optimizer 200 runs, `evm_version = "paris"` — ferminux-geth forks geth v1.10.26 and has **no `PUSH0`** |
