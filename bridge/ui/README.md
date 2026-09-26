# Ferminux Bridge — Web App

Browser front end for the [Ferminux Bridge contracts](../contracts/README.md):
a symmetric **lock-and-mint / burn-and-release** bridge where the *same*
`FerminuxBridge` contract runs on every chain, including Ferminux itself
(chain **3961**, native coin **FMX**).

Vite + React + TypeScript + `ethers` v6, bundled from npm. `base: './'`, so one
`dist/` serves from **bridge.ferminux.net** *and* from
**https://ferminux.net/bridge/** without a rebuild. No CDN scripts, no external
fonts, no analytics — the only hosts the page ever dials are the RPC endpoints
and explorers listed in [`src/config.ts`](src/config.ts), and the build fails if
that ever stops being true.

---

## What it does

**Nothing about the assets is hardcoded.** The token list, the fee, the caps,
the pause flags, the validator quorum and the timelock delay are all read from
the bridge contract over RPC, on both the source and the destination chain. A
registry change made by the owner multisig shows up here without a redeploy of
this app.

| | |
|---|---|
| **Route selector** | From / To with a swap button, driven by the `CHAINS` registry: Ferminux 3961, Ethereum 1, BSC 56, Polygon 137, Arbitrum One 42161, Base 8453. Chains with no configured bridge address are listed but disabled as *coming soon* and cannot be selected. |
| **Asset selector** | Read from `registeredTokens()` / `tokenConfig()` on the **source** bridge, filtered to the selected destination. Each asset says whether it is **canonical here** (locked when it leaves) or **wrapped here** (burned when it leaves), and exactly what you receive on the far side — the destination symbol comes from the destination bridge's own registry. If the two registrations do not mirror each other, the route is flagged as unusable *before* the user pays. |
| **Transfer flow** | Amount with **Max** (tightest of balance, per-transfer cap and remaining 24 h capacity; reserves gas for the native coin), live **fee** from `feeBps()`, the **exact amount that will arrive**, the **per-transfer cap** and the **remaining rolling-24 h capacity** — all shown before committing. ERC-20 assets get an allowance check and a single **Approve & Bridge** button with a step-by-step progress list; the native coin is a payable `send()`. |
| **Status tracking** | After sending: transfer id, source tx link, then **Pending → Confirming n/N → Executing → Complete**, where *Complete* means the **destination** bridge reports `processed(transferId) == true` — not that the source confirmed. An honest "typically about X minutes" is derived from the chain configs, and a transfer that overruns it several times over says so plainly. In-flight transfers are persisted in `localStorage`, so a refresh loses nothing, and settled ones stay in a History panel. |
| **Wallet** | Injected EIP-1193 provider, auto-reconnect to an already-authorised account, `wallet_switchEthereumChain` with a `wallet_addEthereumChain` fallback (Ferminux = `0xf79` / FMX / rpc.ferminux.net / explorer.ferminux.net). |
| **Risk notice** | Always visible, never behind a toggle: what "validator-secured" means, the live quorum, the caps in force on the selected asset, the fee, and that delivery is neither instant nor reversible. |

### Every state is handled

Loading (skeletons, never a wrong number), RPC unreachable (with retry),
bridge paused globally or per token, destination paused, no assets registered
for a route, a broken (non-mirrored) registration, wallet absent / locked /
on the wrong chain, user rejection, reverted approval, reverted send, a receipt
with no `Sent` event, a destination RPC outage mid-flight, `localStorage`
unavailable, and a corrupt stored history.

---

## Layout

```
bridge/ui/
├── index.html
├── vite.config.ts            base './'
├── src/
│   ├── config.ts             CHAINS registry + every VITE_ override
│   ├── styles.css            institutional dark, 6px radius, one amber accent
│   ├── App.tsx               shell, route state, panels
│   ├── lib/                  NO browser globals — imported directly by the tests
│   │   ├── abi.ts            the exact fragments used, and the EIP-712 type
│   │   ├── rpc.ts            per-chain provider, ordered fallback + health probe
│   │   ├── bridge.ts         registry, rails, tx building, transferId, digest
│   │   ├── amounts.ts        fee / cap / Max math + address validation (pure)
│   │   ├── status.ts         the transfer status machine + ETA (pure)
│   │   ├── liveness.ts       block pace / DEGRADED / checkpoint lag from the relayer's /status (pure)
│   │   └── transfers.ts      persistence with an INJECTED storage backend (pure)
│   ├── state/                React hooks; wallet.ts is the only browser-only module
│   ├── views/                RouteSelector, TransferForm, TransferPanels
│   └── components/           RiskNotice + small UI primitives
├── scripts/
│   ├── devnet.mjs            two anvils + real contracts, for local development
│   ├── e2e.mjs               the data-layer end-to-end suite (two anvils)
│   └── check-dist.mjs        external-URL guard, allowlist derived from config.ts
└── tests/                    node:test unit suites (96 tests)
```

The split matters: **`src/lib/*` never touches `window`**, so the unit tests and
the e2e drive the *same* modules the components import, rather than a
re-implementation of them.

---

## Development

```sh
npm install
npm run dev        # vite dev server
npm test           # 96 unit tests (amount/fee/cap math, addresses, status, liveness/checkpoints, storage, registry layout)
npm run e2e        # two-anvil data-layer end-to-end (ports 8564 / 8565)
npm run build      # tsc --noEmit + vite build + external-URL guard on dist/
npm run preview    # serve the production build
```

Node ≥ 23 is required for `test` / `e2e`: they import the app's `.ts` modules
via native type stripping. `e2e` also needs `anvil` (Foundry) on `PATH` and the
compiled contract artifacts in `../contracts/out` (`cd ../contracts && forge build`).

### Local two-chain devnet

```sh
node scripts/devnet.mjs
```

Starts anvil on **8564** (chain 3961, Ferminux stand-in) and **8565**
(chain 56, BSC stand-in), deploys the real `FerminuxBridge` to both, deploys a
mock ERC-20 plus its `BridgeToken` wrappers, registers both routes through the
timelock, and prints the environment to run the UI against it. Ctrl-C stops both
anvils. It never touches a public RPC.

Actual output:

```
  bridge on 3961   0x5FbDB2315678afecb367f032d93F642f64180aa3
  bridge on 56     0x5FbDB2315678afecb367f032d93F642f64180aa3
  AZNT on 3961     0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
  wFMX on 56       0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
  wAZNT on 56      0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0
  funded user      0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc  (anvil #5)
```

Then, in a second terminal:

```sh
VITE_RPC_FERMINUX=http://127.0.0.1:8564 \
VITE_RPC_BSC=http://127.0.0.1:8565 \
VITE_BRIDGE_FERMINUX=0x5FbDB2315678afecb367f032d93F642f64180aa3 \
VITE_BRIDGE_BSC=0x5FbDB2315678afecb367f032d93F642f64180aa3 \
npm run dev
```

Import anvil account #5 into your wallet (private key
`0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba`, a public
test key) — it holds FMX on 3961 and 25 000 mock AZNT.

---

## Configuration

Defaults live in [`src/config.ts`](src/config.ts). **Every bridge address ships
empty**; with fewer than two chains configured the app renders an honest
"bridge deployments" table instead of a form that could not submit.

| Variable | Default | Notes |
|---|---|---|
| `VITE_BRIDGE_FERMINUX` | *(empty)* | `FerminuxBridge` on 3961. `VITE_BRIDGE_3961` also works. |
| `VITE_BRIDGE_ETHEREUM` | *(empty)* | …and `_BSC`, `_POLYGON`, `_ARBITRUM`, `_BASE` (or `VITE_BRIDGE_<chainId>`) |
| `VITE_RPC_FERMINUX` | `https://rpc.ferminux.net,https://ferminux.net/rpc` | comma-separated, ordered fallback, each health-probed with `eth_chainId` |
| `VITE_RPC_ETHEREUM` | `https://ethereum-rpc.publicnode.com,https://eth.drpc.org,https://cloudflare-eth.com` | |
| `VITE_RPC_BSC` | `https://bsc-rpc.publicnode.com,https://bsc-dataseed.bnbchain.org,https://1rpc.io/bnb` | |
| `VITE_RPC_POLYGON` | `https://polygon-bor-rpc.publicnode.com,https://polygon.drpc.org,https://1rpc.io/matic` | |
| `VITE_RPC_ARBITRUM` | `https://arbitrum-one-rpc.publicnode.com,https://arb1.arbitrum.io/rpc,https://arbitrum.drpc.org` | |
| `VITE_RPC_BASE` | `https://base-rpc.publicnode.com,https://mainnet.base.org,https://base.drpc.org` | |
| `VITE_EXPLORER_FERMINUX` | `https://explorer.ferminux.net` | …and `_ETHEREUM`, `_BSC`, `_POLYGON`, `_ARBITRUM`, `_BASE` |
| `VITE_CONFIRMATIONS_FERMINUX` | `64` | source confirmations before validators attest; per chain. Defaults come from `RELAYER_CONFIRMATIONS` in `src/config.ts`, which mirrors `relayer/config/chains.example.json` — `_ETHEREUM` 32, `_BSC` 20, `_POLYGON` 128, `_ARBITRUM` 300, `_BASE` 180. Setting one BELOW the relayer's value makes this app claim a transfer is executing before any validator will sign it. |
| `VITE_RELAY_OVERHEAD_SECONDS` | `90` | validator + relayer latency assumed in the ETA |
| `VITE_POLL_MS` | `12000` | chain-state refresh cadence |
| `VITE_DOCS_URL` | `https://ferminux.net/bridge/docs` | target of the risk-notice link |
| `VITE_CHAIN_ID_FERMINUX` | `3961` | only for local devnets |

`scripts/check-dist.mjs` **derives** its allowlist of permitted hosts from this
same file, so adding a chain automatically allows its endpoints and a stray CDN
still fails the build.

---

## Tests

### Unit — `npm test`

72 tests over the pure modules, run with the Node test runner against the same
`.ts` files the UI imports:

- **fee math** — `fee = amount * feeBps / 10000` checked against the contract's
  own integer expression, including flooring to zero on dust and the hard
  1.00 % ceiling
- **cap math** — the continuously-draining 24 h bucket reproduced exactly
  (`used − used·elapsed/WINDOW`), an untouched bucket, a skewed clock, and
  "when does this fit again"
- **quoting** — over the per-transfer cap, over the remaining capacity, over
  balance, native gas headroom, a paused bridge, a paused token, a fee that
  would eat the whole amount, and an unknown balance never blocking
- **Max** — always the tightest of the three limits, never negative, and the
  result always passes its own quote
- **addresses** — EIP-55 checksum enforcement, case normalisation, and the zero
  address refused as a bridge recipient (it could never be delivered)
- **status machine** — every transition, progress monotonicity, a destination
  RPC outage never reading as Complete, and rehydration from storage
- **storage** — corrupt JSON, a non-array, malformed records, a hostile
  `localStorage` that throws, case-insensitive hash matching, the history cap,
  and a no-op patch returning the same array (so React does not re-render)
- **registry layout** — the `TokenConfig` shape this app decodes is checked
  against `contracts/src/FerminuxBridge.sol` itself, so the hand-written ABI
  cannot drift from the struct. The read is driven by the return data rather
  than the fragment, because a struct that changes arity makes
  `contract.tokenConfig()` throw a buffer overrun *inside* the `Promise.all` in
  `readRegistry` — one changed field, and the whole asset list is a blank screen
  instead of one odd row

```
ℹ tests 72
ℹ pass 72
ℹ fail 0
```

### End-to-end — `npm run e2e`

Starts **two** anvils (8564 = chain 3961, 8565 = chain 56), deploys the real
contracts from `../contracts`, stands both routes up through the timelock —
counterpart bridge recorded, wrapper bytecode pinned, native route and ERC-20
route registered — and then drives the app's own `src/lib/*.ts` modules through a
complete round trip. Never touches a public RPC and never deploys anywhere else.

The first two of those are preconditions the contract enforces: `_register`
refuses a route to a chain whose bridge address is unknown, and `registerWrapped`
refuses a wrapper whose bytecode is not the pinned one. The bridges are also
deployed at deliberately different addresses, because `setRemoteBridge` refuses a
counterpart equal to itself — which is why phase 9 now proves the EIP-712 domain
binds the chain id by holding the address fixed and changing the chain, rather
than by leaning on two fresh anvils happening to collide.

```
== 0. the shipped chain registry
  ✓  1. config lists 6 chains; Ferminux = 3961 / 0xf79 / FMX
== 1. two throwaway anvils
  ✓  2. ports 8564 and 8565 are free
  ✓  3. anvil up on :8564 (chain 3961) and :8565 (chain 56)
  ✓  4. connectRpc skipped a dead endpoint and health-probed both chains
== 2. deploy the real bridge contracts on both chains
  ✓  5. FerminuxBridge deployed: A 0x5FbD… B 0xe7f1…
  ✓  6. each chain records the counterpart bridge, through the timelock
  ✓  7. readBridgeConfig: fee 10 bps, quorum 2-of-3, not paused
== 3. assets and registration through the timelock
  ✓  8. assets: AZNT on A; wFMX and wAZNT on B
  ✓  9. chain B pins the wrapper bytecode it will accept
  ✓ 10. a queued registration cannot execute before its eta, and executes after it
  ✓ 11. both sides of both routes registered through the timelock
== 4. the app reads the registry from chain
  ✓ 12. readRegistry: A = [FMX,AZNT], B = [wFMX,wAZNT]
  ✓ 13. wrapper provenance: wFMX mirrors the native coin of chain 3961
== 5. route mirroring
  ✓ 14. routeMirrors accepts the mirrored pair and rejects a mismatched one
== 6. the quote the user sees, before committing
  ✓ 15. quote: send 10 FMX, fee 0.01, arrives 9.99 wFMX
== 7. native leg: lock on A
  ✓ 16. locked 10 FMX; transferId 0x6482d9d5a9a7f1b1… verified three ways
== 8. status machine while it is in flight
  ✓ 17. status: Pending → Confirming 1/3 → Executing (destination says processed=false)
  ✓ 18. honest estimate for this route: about 2 min
== 9. the signature domain binds the destination chain and bridge
  ✓ 19. EIP-712 digest matches hashTransfer() and changes with chain id or bridge address
== 10. a real 2-of-3 relay lands it
  ✓ 20. relayed with 2 of 3 signatures; recipient holds 9.99 wFMX, fully collateralised
  ✓ 21. the destination processed flag flipped and the status machine reached Complete
== 11. replay protection
  ✓ 22. the same transfer cannot be executed twice
== 12. ERC-20 leg: allowance, approve, send
  ✓ 23. approve → bridge: 500 AZNT locked, 499.5 wAZNT owed on the far side
  ✓ 24. the ERC-20 leg landed too: wAZNT minted to the recipient
== 13. the return leg: burn on B, release on A
  ✓ 25. returned 3.996 FMX; collateral still equals wrapped supply
== 14. the rails refuse the same things in the UI and on chain
  ✓ 26. caps: UI and chain both refuse >100 FMX per transfer; 240 FMX of daily capacity left
  ✓ 27. the 24 h bucket decays locally as it does on chain: exact at t, within 0 wei (< 347222222222220) at t+12 h
  ✓ 28. Max computed 100 FMX and the chain accepted it
== 15. persistence: a refresh must not lose a transfer
  ✓ 29. a real transfer round-tripped storage and moved from in-flight to settled
== 16. pause is immediate
  ✓ 30. the pauser key stopped the bridge instantly; the UI quote refused; the owner reopened it
  ✓ 31. the shared per-chain connection cache de-duplicates and can be dropped
== 17. teardown
  ✓ 32. anvils stopped; ports 8564 and 8565 are free again

E2E: all checks passed.
```

Three of those deserve emphasis:

- **the transferId is verified three ways** — parsed from the `Sent` event,
  recomputed locally by `computeTransferId()`, and asked of the contract's
  `transferIdOf()`. All three must agree, or the app would be tracking a
  transfer that does not exist.
- **the EIP-712 digest is verified against the destination contract.** Both
  anvils are fresh, so the deployer produced the *same bridge address* on both
  chains — which is exactly why the domain must also bind the destination chain
  id. The suite asserts the two `DOMAIN_SEPARATOR()`s differ.
- **the cap model is checked against the chain twice**, at *t* and at *t + 12 h*,
  because a UI that shows a stale bucket would let a user sign a transfer the
  contract will reject. The local model is **exact at the moment of the read**
  and an estimate when extrapolated: the contract decays the raw stored `used`
  from an `updatedAt` it does not expose, so the app re-decays the value the view
  function gave it, and the base timestamp can be one block out because nodes
  evaluate `eth_call` against the pending block. The suite asserts the drift
  stays inside a few seconds of drain — parts per million over a 12 s poll — and
  the contract remains the authority in every case.

### Browser verification (manual, reproducible)

The React layer was additionally driven in headless Chromium against the local
devnet with an injected EIP-1193 provider backed by anvil's unlocked account,
which exercised the actual components end to end:

```
FORM_RENDERED / RISK_NOTICE_VISIBLE / AUTO_RECONNECTED
BALANCE: 9,949.999394 FMX · Max reserves 0.000292 FMX for gas
QUOTE_FEE: 0.0125 FMX      QUOTE_RECEIVE: 12.4875 wFMX
CAPS: 200.029797 / 250 FMX          (the bucket draining between runs)
CAP_REFUSAL_SHOWN / BUTTON_DISABLED_OVER_CAP: true
BRIDGE_CLICKED → IN_FLIGHT_PANEL → CONFIRMING 1/12, transferId 0x48a8a441…
ASSET_SWITCHED: AZNT — Ferminux Manat   AZNT_BALANCE: 24,900 AZNT
APPROVE_AND_BRIDGE_OFFERED → AZNT_QUOTE: 99.9 wAZNT → 1 new transfer card
```

That run caught (and fixed) a real defect: switching assets briefly showed the
previous asset's balance formatted with the *new* asset's decimals. `useRail`
now stores each reading together with the asset it belongs to and renders
skeletons until the new one lands.

---

## Build & deploy

```sh
VITE_BRIDGE_FERMINUX=0x… VITE_BRIDGE_BSC=0x… npm run build
```

`npm run build` is `tsc --noEmit` → `vite build` → `check-dist.mjs`. The guard
prints the hosts it allows and rejects anything else:

```
check-dist: allowed hosts from src/config.ts → 1rpc.io, arb1.arbitrum.io,
  arbiscan.io, arbitrum-one-rpc.publicnode.com, arbitrum.drpc.org,
  base-rpc.publicnode.com, base.drpc.org, basescan.org,
  bsc-dataseed.bnbchain.org, bsc-rpc.publicnode.com, bscscan.com,
  cloudflare-eth.com, eth.drpc.org, ethereum-rpc.publicnode.com, etherscan.io,
  explorer.ferminux.net, ferminux.net, mainnet.base.org,
  polygon-bor-rpc.publicnode.com, polygon.drpc.org, polygonscan.com,
  rpc.ferminux.net
  (inert)   reactjs.org / www.w3.org / gateway.ipfs.io / github.com / … (js)
check-dist: no unexpected external URLs in dist/.
```

Each chain now lists three endpoints, and every one of them answered with the
right chain id on 2026-08-20. Two that did not are gone: `eth.llamarpc.com`
(HTTP 521) and `polygon-rpc.com` (403, "API key disabled"). Here they only cost
a probe timeout per page load — this list is an ordered fallback, not a quorum —
but the relayer shipped the same dead endpoints in a list where they *were*
counted as witnesses, which is what `relayer/README.md` now spends a section on.

The "inert" hosts are string constants inside React and ethers (error-doc links,
XML namespaces, an ENS gateway and a Polygon gas-station plugin registered for
chain ids this app never dials). They are allowlisted explicitly so that
anything *new* fails the build and gets reviewed.

Serve `dist/` statically. Because `base` is `./`, the same directory works at a
subdomain root and under a `/bridge/` path:

```nginx
location /bridge/ {
    alias /var/www/ferminux-bridge/;
    try_files $uri $uri/ /bridge/index.html;
}
```

---

## Honest limitations

- **This app does not relay.** It reads both chains and reports what they say.
  If validators never sign, a transfer stays in *Executing* forever and the UI
  says so — including a plain statement, past ~4× the normal window, that the
  funds are locked on the source chain and the operators need the transfer id.
- **History is per browser.** Transfers are kept in `localStorage`, capped at 60,
  and are not recoverable from another device. The transfer id is copyable
  precisely because that is the thing worth keeping.
- **One remote chain per local token**, inherited from the contract registry:
  the asset selector can only offer routes the source bridge actually declares.
- **The ETA is an estimate, never a deadline** — source confirmations × block
  time + relay overhead + one destination block. It is presented as "typically
  about X" and is never used to infer that a transfer succeeded.
- **The confirmation counts are the relayer's, not the app's.** They live in one
  table (`RELAYER_CONFIRMATIONS`, `src/config.ts`) copied from the relayer's own
  config, because the relayer is authoritative: it re-reads the source log at
  its configured depth and will not attest a moment sooner. Ferminux is the
  deepest wait in the set — 64 blocks, ~7.5 minutes — because it is Clique
  proof-of-authority with no finality gadget (64 is also the deepest reorg a node accepts), so a shallower number here would understate reorg
  risk and show "executing" long before a validator has signed anything.
- **The remaining-capacity figure is advisory.** It is read from the chain each
  poll and drained locally in between, exactly as described above; the contract
  is what actually enforces the cap. A transfer sized to the last few wei of
  capacity can still revert.
- **Public RPCs are best-effort.** Each chain has an ordered fallback list and a
  chain-id health probe; an endpoint that fails the probe is skipped, and a
  destination RPC outage keeps a transfer in *Executing* rather than guessing.
- **`window.ethereum` only.** No WalletConnect, no hardware-wallet integration
  beyond what the injected provider offers.

## Liveness report (`status.json`)

The fixed "Confirming n/64" is gone. Each in-flight card, the arrival estimate
and a health strip above the form are driven by the relayer's `GET /status`
(per chain: `finalityMode`, `pace.{targetSeconds,medianGapSeconds,sampleBlocks}`,
`degraded`, `checkpoint.{blockNumber,lagBlocks,attestedAt,maxAgeSeconds,stale,verified}`;
fixture in `tests/fixtures/relayer-status.json`). The relayer's endpoint is
bearer-protected, so the app reads `VITE_RELAYER_STATUS_URL` (default
`./status.json`, same origin): serve it with an nginx `proxy_pass` that injects
the token, or a cron-written file. Relative by default, so `check-dist.mjs` has
no new host to allow. Unreachable, stale (> 5 min) or malformed → the app falls
back to the plain confirmation count; it never invents an all-clear.

- DEGRADED / stale checkpoint / hash mismatch → card reads **Paused** with the
  measured pace and the reason; never a count.
- checkpoint mode → **Awaiting checkpoint**, blocks above the attested block
  shown as the real wait.
- work mode → count is kept, but remaining time is priced at the measured pace.
