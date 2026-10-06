# Ferminux Staking UI

The staking & node-participation web app for chain 3961. Vite + React + TS +
ethers v6, `base: './'` so one dist serves from both `stake.ferminux.net` and
`https://ferminux.net/stake/`. Follows the wallet-web house style: institutional
dark, single amber accent `#e2a437`, 6px radius, system fonts, tabular
numerals, no CDNs (enforced by `scripts/check-dist.mjs`), every
loading/empty/error state handled.

## What it shows — and the honesty rules it is built around

- **Stats strip** (total staked, positions, bonded nodes, reward pool): real
  contract reads or a dash. Never an estimate. The vault keeps no staker
  count, so none is shown — "positions" is labelled as positions opened, not
  distinct stakers. The reward pool is `rewardPool()` settled to the head block
  with the vault's own accrual arithmetic (`settledRewardPool` in
  `lib/staking.ts`, equal to the wei to what the next transaction leaves
  behind), and always carries the projected runway at the current stake.
- **Stake**: four tiers with the *live effective APY* (cap scaled down once the
  1.2M FMX/yr drip cap binds — computed by `lib/math.ts`, which is unit-tested
  against the worked numbers in `../DESIGN.md`). Every tier number — weight,
  lock, lock block, minimum — is read from the vault; the validator track
  shows its 2.0× base and its 3.0× uptime-boosted cap, and its lock is a block
  height (`VALIDATOR_LOCK_BLOCK`), shown with a 7 s-cadence estimate.
  Projections are labelled as projections, include the user's own dilution,
  and the screen warns when the pool cannot fund the tier's whole lock period.
  When the owner pauses deposits, the screen says so and only deposits stop.
  FMX is the native coin, so there is no ERC-20 approval step; the "approve"
  step is the explicit review screen.
- **Positions**: principal, accrued rewards, unlock countdown, claim /
  cooldown / withdraw, and emergency exit behind a modal that itemises exactly
  what is forfeited (all unclaimed rewards + 5% of principal, into the pool).
  `withdraw()` returns principal only, so a withdrawn position stays listed
  with a Claim action while it still holds banked rewards.
- **Nodes**: the live registry roster (`listActiveNodes`: bond, uptime, boost,
  last seen) with the bonded-nodes ≠ distinct-operators caveat stated in the
  UI, the register-a-node flow, and deregistration for your own nodes —
  including those the roster leaves out because their bond exited or fell
  below the minimum, found through your positions (`nodeIdByPosition`), since
  they still hold their node key and consensus address. Registering takes the position, the consensus address and the enode URL (its
  64-byte public key is the node identity), plus a signature by the node's own
  key over `registrationDigest` — a raw 32-byte hash, no message prefix. The
  form shows the digest and a `cast wallet sign --no-hash` example, and checks
  that the pasted signature recovers to the node before sending anything; the
  node key never enters the page.
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

## Contracts and ABIs

The app talks to `FMXStaking` and `NodeRegistry` in `../contracts/src`.
`src/lib/abi.ts` carries human-readable fragments for exactly the functions the
app calls, and three checks keep every copy in line with the source:

- `tests/abi.test.mjs` compares each fragment (selector, outputs, payability)
  with the compiled ABI checked in at `../contracts/abi/*.json`;
- `npm run e2e` builds `../contracts`, fails if those JSON files differ from
  the fresh artifacts (regenerate with
  `forge inspect <Name> abi --json > abi/<Name>.json` in `../contracts`), and
  deploys the real contracts to anvil;
- `tests/tiers.test.mjs` asserts `src/lib/tiers.ts` — the tier enum order and
  which constant defines each lock and minimum, the one thing an ABI cannot
  carry — against `FMXStaking.sol`.

## Scripts

| command       | what it does |
|---------------|--------------|
| `npm run dev` | vite dev server |
| `npm run build` | `tsc --noEmit` + vite build + no-external-URL guard |
| `npm test` | unit tests: APY/reward/runway/countdown math, the settled-pool and lock mirrors, formatting, enode → node address, registration digest + possession signature, validation, ABI fragments vs `../contracts/abi`, tier shape vs `FMXStaking.sol` |
| `npm run e2e` | anvil on **port 8612** (chain-id 3961): builds and deploys the real `FMXStaking` + `NodeRegistry`, stakes, advances time, claims, cooldown/withdraw/claim-after-withdraw, emergency exit, node registration with a node-key signature, watchtower epoch → dispute window → boost, deregistration (also after the bond exited), drip-cap scaling, fail-closed pool depletion, paused deposits — all through `src/lib/*`. Needs `forge` and `anvil` |
| `npm run ui` | headless-Chromium check on ports **8612/8613**: real bundle against the real contracts on a seeded anvil — stats, connect, full stake flow, positions, roster, node registration with a node-key signature, deregistering a node whose bond exited, explainer. Skips cleanly without `anvil`/`playwright-core` (`PLAYWRIGHT_DIR`, `CHROME_PATH`) |

Ports 8612/8613 only (assigned range); nothing here touches mainnet.

## Gas-limit note

Every write in `lib/staking.ts` / `lib/nodes.ts` pins an explicit generous
`gasLimit` instead of trusting a bare estimate: the vault's accrual updates a
timestamp on every call, so an estimate made in one second undershoots
execution in the next by a few thousand gas — an exact-limit transaction then
reverts out-of-gas. Unused gas is refunded, so the ceilings cost nothing.
