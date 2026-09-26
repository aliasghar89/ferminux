# Ferminux Staking UI

The staking & node-participation web app for chain 3961. Vite + React + TS +
ethers v6, `base: './'` so one dist serves from both `stake.ferminux.net` and
`https://ferminux.net/stake/`. Follows the wallet-web house style: institutional
dark, single amber accent `#e2a437`, 6px radius, system fonts, tabular
numerals, no CDNs (enforced by `scripts/check-dist.mjs`), every
loading/empty/error state handled.

## What it shows — and the honesty rules it is built around

- **Stats strip** (total staked, stakers, bonded nodes, reward pool): real
  contract reads or a dash. Never an estimate. The pool line always carries the
  projected runway at the current stake.
- **Stake**: four tiers with the *live effective APY* (cap scaled down once the
  1.2M FMX/yr drip cap binds — computed by `lib/math.ts`, which is unit-tested
  against the worked numbers in `../DESIGN.md`). Projections are labelled as
  projections, include the user's own dilution, and the screen warns when the
  pool cannot fund the tier's whole lock period. FMX is the native coin, so
  there is no ERC-20 approval step; the "approve" step is the explicit review
  screen.
- **Positions**: principal, accrued rewards, unlock countdown, claim /
  cooldown / withdraw, and emergency exit behind a modal that itemises exactly
  what is forfeited (all unclaimed rewards + 5% of principal, into the pool).
- **Nodes**: the registry roster (bond, uptime, last seen) with the
  bonded-nodes ≠ distinct-operators caveat stated in the UI, plus the
  register-a-node flow (position + consensus address + enode URL → keccak id).
- **How it works**: says outright that staking does not secure the chain
  (Ferminux uses authority consensus: Clique proof-of-authority, a set of
  authorised signers), where rewards come from, and which components are
  trusted (watchtower oracle, founder-held supply).

## Contract addresses

`src/config.ts` ships with EMPTY vault/registry addresses on purpose — the app
renders its "not live yet" state until the audited contracts are deployed.
Configure at build time:

```
VITE_STAKING_VAULT=0x… VITE_NODE_REGISTRY=0x… npm run build
```

`VITE_RPC_URLS` / `VITE_EXPLORER_URL` / `VITE_CHAIN_ID` override the defaults.
`VITE_WC_PROJECT_ID` adds WalletConnect to the wallet choice (Ferminux Wallet and
injected wallets are always offered; see `shared/fxwallet/README.md`).

## ABI status (important)

The production contracts in `/staking/contracts` had not landed when this app
was built. `src/lib/staking.ts` / `src/lib/nodes.ts` code the ABI from
`../DESIGN.md` §8, and `fixtures/` contains DESIGN-faithful fixture contracts
(solc 0.8.24, `evm_version = paris`, zero PUSH0 — verified by
`cast disassemble`) that the e2e deploys to anvil. **When the real contracts
land, reconcile the ABIs and re-run `npm run e2e`** — it drives the UI's own
lib modules against a deployed vault/registry and will catch drift.

## Scripts

| command       | what it does |
|---------------|--------------|
| `npm run dev` | vite dev server |
| `npm run build` | `tsc --noEmit` + vite build + no-external-URL guard |
| `npm test` | unit tests: APY/reward/runway/countdown math, formatting, enode parsing, validation |
| `npm run e2e` | anvil on **port 8612** (chain-id 3961): deploys the fixtures, stakes, advances time, claims, cooldown/withdraw, emergency exit, node registration + watchtower attestation, drip-cap scaling, fail-closed pool depletion — all through `src/lib/*` |
| `npm run ui` | headless-Chromium check on ports **8612/8613**: real bundle against a seeded anvil — stats, connect, full stake flow, positions, roster, explainer. Skips cleanly without `anvil`/`playwright-core` (`PLAYWRIGHT_DIR`, `CHROME_PATH`) |

Ports 8612/8613 only (assigned range); nothing here touches mainnet.

## Gas-limit note

Every write in `lib/staking.ts` / `lib/nodes.ts` pins an explicit generous
`gasLimit` instead of trusting a bare estimate: the vault's accrual updates a
timestamp on every call, so an estimate made in one second undershoots
execution in the next by a few thousand gas — an exact-limit transaction then
reverts out-of-gas. Unused gas is refunded, so the ceilings cost nothing.
