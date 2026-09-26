# Ferminux Genesis

**ChainID:** 3961 (0xF79)  |  **Consensus:** Ethash PoW  |  **EIP-1559:** on from block 0

`extraData` decodes to: `Made with love by Wizrd - FMX`

## PREMINE — FINAL ADDRESSES (genesis ceremony 2026-08-20)

| Address | Allocation | FMX |
|---|---|---|
| 0xc0A5Eb613f859f072554F29f1Ab7400265af15aB | Treasury | 12,000,000 |
| 0xEeDd7368290a17aB2Aa3F298Ff24BB99D581E787 | Ecosystem / listings | 6,000,000 |
| &nbsp;&nbsp;&nbsp;└ of which | Developer grants (per shipped dApp/tool) | 3,000,000 |
| &nbsp;&nbsp;&nbsp;└ of which | Exchange listings + market making | 2,000,000 |
| &nbsp;&nbsp;&nbsp;└ of which | Hackathons, bounties, integrations | 1,000,000 |
| 0x86e286684Ae5899A941142D143949C444F9Fe831 | Team (sent to FMXVesting) | 5,000,000 |
| 0x040F1E90EF72b364141D91c3C0314ac3b5eCD0AE | AZNT liquidity + market ops | 4,000,000 |
| 0x34f5366014EF292fd5ff9FFDE81d47819EF65cFC | Community / faucet / airdrops | 3,000,000 |

Owner keys are encrypted keystores held offline by the founder (never on any
server). Genesis hash: `0x1b62e052ee210c433440b9cd21b93b3e6cdc813fe63674c842bca3967d92fadf`.

Founder/developer share: Team 5M (vested) + Treasury 12M (multisig) = **17% under founder control** —
within the healthy 15–25% industry norm. Ecosystem sub-buckets are managed from the 0x...0002 wallet
(one genesis address; splits are operational, not separate genesis allocations).

Total premine: **30,000,000 FMX**. Remaining **70,000,000** emitted via mining (6 FMX/block,
halving every 4,500,000 blocks) then staking rewards after the PoS fork.

Generate real addresses on an OFFLINE machine (hardware wallet or `geth account new` on an
air-gapped box). Treasury/ops should be multisigs. Never reuse these placeholders.

## Params
- `difficulty: 0x80000` — low start so the chain mines instantly on day one
- `gasLimit: 0x1C9C380` — 30M
- `baseFeePerGas: 1 gwei` — decays toward the floor with empty blocks; fees are fractions of a cent
- Block time: stock geth Ethash targets ~13s. The custom fork (Claude Code task) retunes the
  difficulty algorithm to a 7s target and sets the 6 FMX reward + halving table.
