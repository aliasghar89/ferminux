# Ferminux Web Wallet

Official self-hosted web wallet for the **Ferminux Network** — the settlement and
record layer for autonomous AI agents, chain id **3961** (`0xF79`), native coin
**FMX** (18 decimals), EIP-1559 from genesis.

Vite + React + TypeScript. `ethers` v6 bundled from npm — the shipped page makes
**no external requests** other than the configured RPC endpoints (Ferminux and
the seven other supported networks), the explorer API, NFT metadata on
ferminux.net and — only once the user pairs a site — the WalletConnect relay.
No CDN scripts, no external fonts, no analytics. QR codes are rendered
locally with the `qrcode` package and decoded locally with `jsqr` (pure JS, no
native deps, no WASM) — both are compiled into the bundle, never fetched.

## Networks

One key, one address, eight networks. Ferminux (3961, FMX) is the home chain;
the other seven are exactly the chains the network accepts pay-ins on
(`agents/gateway/src/v3/payin.ts`), and `tests/chains.test.mjs` fails if the
two lists drift apart.

| Network | Chain id | Native | Tokens listed | RPCs (ordered fallback) | Multicall3 |
| --- | --- | --- | --- | --- | --- |
| Ferminux | 3961 | FMX | USDF, AZNT, WFMX (`shared/tokens.ts`) | rpc.ferminux.net, ferminux.net/rpc | no (checked 2026-09-25) |
| Ethereum | 1 | ETH | USDC, USDT | ethereum-rpc.publicnode.com, eth.drpc.org | yes |
| BNB Smart Chain | 56 | BNB | USDC, USDT (18 decimals) | bsc-rpc.publicnode.com, bsc-dataseed.bnbchain.org | yes |
| Base | 8453 | ETH | USDC, USDT | base-rpc.publicnode.com, mainnet.base.org | yes |
| Arbitrum One | 42161 | ETH | USDC, USDT | arbitrum-one-rpc.publicnode.com, arb1.arbitrum.io | yes |
| Polygon | 137 | POL | USDC, USDT | polygon-bor-rpc.publicnode.com, polygon.drpc.org | yes |
| Optimism | 10 | ETH | USDC, USDT | optimism-rpc.publicnode.com, mainnet.optimism.io | yes |
| Avalanche C-Chain | 43114 | AVAX | USDC, USDT | avalanche-c-chain-rpc.publicnode.com, api.avax.network | yes |

Every RPC is public, keyless and CORS-enabled. Users can add any token by
contract address on any of these networks (metadata is read from the
contract; only chain id, address and that metadata are stored).

- **Balances** (`src/lib/portfolio.ts`): one HTTP request per network — an
  `aggregate3` call on Multicall3 where it exists, a JSON-RPC batch of
  `eth_getBalance` + `balanceOf` calls on Ferminux — with `eth_chainId` in the
  same request so an endpoint answering for the wrong network is refused.
  Each network has its own 8 s timeout, endpoint fallback, error state and
  Retry; a failed refresh keeps the last reading on screen, flagged. Ferminux
  refreshes every 10 s, the others every 30 s. Zero balances are hidden by
  default (toggle), with a network filter. No fiat values: there is no price
  service.
- **Send** on any network: native coin or token, EIP-1559 wherever the chain
  has a base fee (legacy type 0 otherwise). Ferminux keeps its 1 gwei tip floor
  (signers drop lower tips); other chains take the node's tip as it is (Arbitrum
  suggests 0). On Base and Optimism the L1 data fee upper bound from the
  GasPriceOracle is added to the worst-case fee. Fees are shown and checked in
  the network's own coin, a "no BNB for fees" style warning appears before
  review, and the confirm screen opens with the network. The chain id signed is
  the wallet's own, never the RPC's.
- **Receive**: the QR is an EIP-681 URI for the chosen network (Ferminux by
  default); the modal lists every network the address works on.
- **Activity**: Ferminux history from its explorer as before. For the other
  networks (whose explorers need API keys for history) the wallet records what
  it sent from this device — hash, recipient, asset, amount, status — with a
  "View on BscScan ↗" style link. Pending rows are settled from their receipt
  on the next visit.
- **NFTs** (`src/lib/nft.ts`): FRC-721 tokens on Ferminux. The Ferminux Agents
  collection (`0x84FE…6ddd`, ids 1–41, not enumerable) is scanned on-chain with
  one batch of `ownerOf` calls; other collections come from the explorer and
  are re-checked with `ownerOf` before they are shown. Metadata comes from
  `tokenURI` (data: URIs decoded locally; https fetched; the explorer's indexed
  copy when the metadata host refuses this origin). Images load on their own
  only from ferminux.net or data: URIs — any other host waits for a click.
  Send uses `safeTransferFrom`.
- **Mint** (NFTs → Mint, `src/lib/nftMint.ts`, `src/views/NftMint.tsx`): both
  Ferminux collections, browsable and mintable from the active account without
  leaving the wallet — no WalletConnect, no browser. Ferminux Citizens
  (`0x5672…4252`, ids 1–`totalIds()`, priced by tier: Common 50, Rare 100, Epic
  250, Legendary 500 FMX, read live) and Ferminux Agents (`0x84FE…6ddd`, ids
  1–41, one `price()`). The gallery reads `collection.json` from ferminux.net and
  the sale from the chain in one JSON-RPC batch (Citizens: `tokensInfo` for every
  id; Agents: `ownerOf` 1–41); filters by availability and tier; artwork loads
  lazily as AVIF/WebP at 256/512 px (the canonical file only as a fallback).
  Mint builds `mint(id)` with exactly `price(id)` (Citizens) / `price()` (Agents)
  as value on chain 3961 and goes through the wallet's own prepare → confirm →
  sign pipeline. The confirm screen names the contract, the method, the value,
  the worst-case fee and what was checked. One batch — sale flag, id exists,
  not minted (and by whom), exact price, the account's balance — runs before the
  confirm screen and again right before signing, so a mint that would revert is
  never signed: a short balance is refused with an **Add FMX** path to Receive,
  an id another wallet took says so, a changed price asks for a new review, and
  a mint that loses the race inside a block is reported as reverted with only
  the fee spent. `npm run mint-smoke` drives all of it on an anvil fork.
- **Swap** (Home → Swap, or Swap on a Ferminux asset; `src/lib/swap.ts`,
  `src/views/SwapPanel.tsx`): any two tokens on the Ferminux Network through the
  Ferminux DEX (factory `0x2034…7040`, router `0x018C…BA9f`, WFMX `0x8a9A…77Ae`,
  checked against the deployment record in `tests/swap.test.mjs`), from the
  active account, on chain 3961 only — the screen says so, and no swap is
  offered on the other seven networks. What the wallet does:
  - **Tokens**: FMX, WFMX, USDF and AZNT always, plus any FRC-20 the user added
    under Assets once it sits in a pool with liquidity. FMX trades as WFMX
    inside the pools; FMX ⇄ WFMX is a 1 : 1 wrap/unwrap on WFMX
    (`deposit()` / `withdraw(amount)`), never a trade.
  - **Route**: the pools between those tokens are read in two JSON-RPC batches
    (`getPair` from the factory registry, then `getReserves`); every path of up
    to three pools is priced locally with the pool's own math
    (`FerminuxLibrary.sol` in bigint, same rounding) and the one that pays the
    most wins, a tie going to the shorter. Only WFMX and the first-party tokens
    (`shared/tokens.ts`) may sit in the middle of a route, so an arbitrary
    token's code never runs as a hop.
  - **Quote**: as the user types, from pools read at most a few seconds before;
    at Review, from the router's own `getAmountsOut` on the chosen path — the
    number on the confirm screen and the one the minimum is taken from. Price
    impact is shown apart from the 0.30%-per-pool fee: a warning from 3%, and
    from 10% Review stays locked until the user ticks that they accept it.
  - **Bounds**: minimum received = quote × (1 − slippage), rounded down;
    slippage 0.1 / 0.5 (default) / 1% or custom up to 50%, with a caution
    outside 0.05–5%; the deadline (20 min by default) is counted from the
    chain's latest block, not the phone's clock. The router enforces both. The
    recipient is always the signing account.
  - **Approval**: a token sold for the first time is approved to the router
    first, as its own step on the wallet's confirm screen — **exactly the
    swap's amount by default** (unlimited only when chosen in the swap settings,
    with a danger notice). The swap itself is prepared once the approval is in
    a block.
  - **Confirm screen**: the same one as Send and Mint — network banner,
    contract, method signature, amounts in and out, minimum, route, price
    impact, pool fees, deadline, worst-case network fee, what was checked, and
    the nonce, gas, fee fields, path and calldata under Transaction details.
  - **Before signing**: balances, allowance, the router's quote and the
    deadline are read once more in one batch; a swap that would now pay less
    than its minimum, or could not pay its fee, is refused with nothing signed
    ("The price moved: …"). After it: the amount received is read from the last
    pool's `Swap` event; a revert says only the fee was spent.
  - Settings (slippage, deadline, approval mode) are the only thing stored:
    `ferminux.wallet.swap.v1`, no address, no amount.
  `npm run swap-smoke` drives it on an anvil fork (below).

## WalletConnect

Wallet side of WalletConnect v2 with Reown WalletKit (`@reown/walletkit` +
`@walletconnect/core`). Needs a Reown project id at build time:

```sh
VITE_WC_PROJECT_ID=<id> npm run build
```

Without it, the Connect tab says WalletConnect isn't set up on this build and
everything else works. The SDK is a lazily loaded chunk (`check-dist` fails the
build if a WalletConnect host appears in an entry script or a chunk it
modulepreloads, in `dist/` and in the app's `dist-app/`), fetched only when
the user pairs a site or unlocks a device that already has sessions; telemetry
is disabled.

- **Pair** by pasting the site's `wc:` code or scanning its QR (same scanner,
  camera / image / paste). v1 codes and expired codes are refused with a reason.
- **Proposal**: the dApp's name, URL, icon and the WalletConnect Verify result
  (verified / not verified / domain mismatch / known scam) and the requested
  networks this wallet supports (plus any required one it does not; optional
  networks it does not use are counted, not listed — PancakeSwap and Uniswap
  name twenty-odd). Approval grants the **active account only**, on the
  requested networks this wallet supports, in the dApp's order; an unsupported
  *required* network or namespace blocks approval.
- **Requests**, one confirm modal each, with the verified origin and the
  network stated first: `personal_sign` (text, or hex with a warning;
  sign-in messages for another domain flagged), `eth_sign` (a strong warning and
  an explicit acknowledgement before Sign enables), `eth_signTypedData_v4`
  (domain and every field decoded; chain mismatch blocked; permits warned),
  `eth_sendTransaction` (prepared with the wallet's own nonce/gas/fees, calldata
  decoded for transfers, approvals — unlimited ones warned — and NFT
  operator grants; insufficient native balance blocks it),
  `wallet_switchEthereumChain` and `wallet_addEthereumChain` (built-in networks
  only; the site's RPC URLs are ignored). Anything else is answered
  "unsupported". A request from a signer that is not the active account is
  refused.
- **Sessions** persist in WalletConnect's own IndexedDB store, are listed on the
  Connect tab and can be disconnected. Switching the active account moves every
  session to it (`accountsChanged`). While locked nothing is answered; requests
  wait and are shown after unlocking.

The decision logic (`src/lib/walletconnect.ts`, `src/lib/wcController.ts`)
imports no SDK and is unit-tested with a fake WalletKit
(`tests/walletconnect.test.mjs`); `npm run smoke` drives the real modals in a
browser with a scripted stand-in (test builds only, `VITE_WC_TEST_KIT=1`).

Against real dApps over the real relay (network needed; nothing is signed —
every request is rejected):

```sh
VITE_WC_PROJECT_ID=<id> npx vite build
WALLET_DIST=dist PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
  node scripts/wc-thirdparty.mjs pancakeswap uniswap
```

creates a throwaway wallet, takes each dApp's own WalletConnect "Copy link",
pairs, checks Verify vouches for the origin, approves, and waits for the dApp to
show the address (PancakeSwap on BNB Chain, Uniswap on Ethereum).
`scripts/wc-dapp-wallets.mjs` is the other direction: a Ferminux dApp build
against scripted WalletKit wallets that do not know chain 3961 (see
`shared/fxwallet/README.md`).

To appear in other dApps' WalletConnect modals, the wallet is listed in the
WalletConnect Explorer: [`docs/WALLETCONNECT-LISTING.md`](docs/WALLETCONNECT-LISTING.md)
is the submission, with its icons in `docs/walletconnect-listing/`.

## Features

- **Multi-account** — one session holds as many accounts as you need: HD
  accounts derived from a single recovery phrase at `m/44'/60'/0'/0/N`, and
  standalone imported keys living beside them. Account switcher in the header,
  an Accounts panel to add / import / rename / export / remove, and a total
  balance across the whole set. See *Multi-account model* below.
- **Create wallet** — fresh 12-word mnemonic (shown once, save-confirmation gate),
  account 1 at `m/44'/60'/0'/0/0`, mandatory password + automatic download of the
  scrypt-encrypted keystore JSON before the wallet opens. The downloaded file
  carries the phrase, so it restores the whole HD wallet, not one address.
- **Import** — mnemonic phrase, raw private key, or keystore JSON file + password.
- **Session model** — keys live in page memory only; explicit Lock button and a
  15-minute idle auto-lock. Optional *remember on this device* stores an
  **encrypted** keystore per account in `localStorage`; unlocking decrypts the
  whole set with one password. Default off.
- **Dashboard** — live FMX balance for the active account (~10 s refresh, every
  account in one batched request), total across all accounts, copyable address,
  QR receive modal, explorer link, block height + base fee in the status footer.
- **Send FMX** — EIP-55 recipient validation, a **My accounts** picker that fills
  the recipient with another of your own accounts in one click, Max button
  (reserves worst-case gas), EIP-1559 fee estimate in FMX, explicit confirm
  screen showing the exact signed values (**from account**, amount, fee, chain id
  3961, nonce, gas limit), pending/confirmed states with explorer link.
- **Scan to pay** — a **Scan** button beside the recipient field opens a camera
  scanner (rear camera via `facingMode: 'environment'`, decoded on a canvas with
  jsQR in a ~10 fps `requestAnimationFrame` loop). See *QR scanning* below.
- **Receive** — the QR encodes an **EIP-681** URI (`ethereum:0x…@3961` by
  default, or `@<id>` for another chosen network), so a wallet scanning it
  learns the chain; an optional *request a specific amount* toggle appends
  `?value=<wei>` so the amount travels with the code. The plain address stays
  one click away for anything that only understands `0x…`. The modal lists the
  networks the address works on.
- **Assets** — every balance on all eight networks in one list (see
  *Networks* above); add any token by contract address on any network
  (symbol/name/decimals read over that network's RPC), `transfer()` send flow,
  remove. A pre-multi-chain token list (`ferminux.wallet.tokens.v1`, bare
  Ferminux addresses) is resolved into the new list on first load.
- **NFTs** and **Connect** (WalletConnect) — see the sections above.
- **Swap** — the Ferminux DEX from Home, chain 3961 only, with the wallet's own
  approval and confirm steps — see *Swap* above.
- **Activity** — for Ferminux, one chronological feed merging **Sent**,
  **Received** and **Signed** block-reward rows from the Blockscout v2 API, with
  a graceful "history unavailable" fallback; the wallet is fully functional
  RPC-only. See *Block rewards* below. For the other networks, the transactions
  this wallet sent from this device, each with an explorer link.

## Multi-account model

### Two kinds of account

| Kind | Where the key comes from | What is stored | Backup |
| --- | --- | --- | --- |
| **HD** | Derived from the session mnemonic at `m/44'/60'/0'/0/N` | **only the integer N** | The recovery phrase |
| **Imported** | A raw private key or a keystore file | Its own scrypt-encrypted V3 keystore | That keystore file |

*Add account* takes the **smallest unused index**, so the allocation is
deterministic and gap-filling: removing account 3 and adding again gives account
3 back rather than drifting upward. Because nothing but the index is stored, the
same phrase always regenerates exactly the same set — restoring the phrase on
another device and adding accounts up to N reproduces every HD address.

`deriveHdAccount` is asserted against two published BIP-39 vectors in
`tests/accounts.test.mjs` (exact addresses at indices 0–3) and, in `npm run e2e`,
against the local node's **own** `m/44'/60'/0'/0/N` accounts.

### What "remember on this device" writes

One key, `ferminux.wallet.vault.v2`:

```jsonc
{
  "version": 2,
  "seed": "{…V3 keystore: account 0's key AND the BIP-39 entropy, both encrypted…}",
  "accounts": [
    { "id": "…", "kind": "hd",       "index": 0, "address": "0x…", "label": "Account 1" },
    { "id": "…", "kind": "hd",       "index": 1, "address": "0x…", "label": "Payroll"   },
    { "id": "…", "kind": "imported", "address": "0x…", "label": "Cold storage",
      "keystore": "{…V3 keystore…}", "origin": "privateKey", "exported": false }
  ],
  "activeId": "…"
}
```

- **Encrypted:** the phrase (once, inside `seed`) and every imported private key
  (one standard keystore each). All under the same password.
- **Plain text:** addresses, labels, HD indices, which account was active. These
  are public data and are what makes the set reappear intact after a lock.
- **Never written:** a private key, the mnemonic, or the password.

That last claim is executable, not prose: `findPlaintextSecrets()` scans a
serialized vault for each private key (with and without `0x`, both hex cases),
the phrase, every individual word of the phrase, and the password.
`tests/vault.test.mjs` runs it against a real encrypted vault, asserts it comes
back empty, **and** asserts the scanner is not vacuous by planting a leak in a
fake blob and catching it. `npm run e2e` repeats the scan on the anvil run, and
`npm run ui` repeats it against the browser's actual `localStorage`.

### The password is never held in memory

Only key material lives in the page — the password is used and dropped. So:

| Action | Cost |
| --- | --- |
| Add HD account | **no password, no cryptography** — only an index is stored |
| Rename / switch / remove | no password (public metadata) |
| Import a key while remembered | asks for the device password, **verifies it against the stored vault first**, then encrypts (2 scrypt runs) |
| Export a keystore | asks for a *file* password, independent of the device one |
| Turn on "remember" later | one scrypt for the seed + one per imported key |
| Unlock | one scrypt for the seed + one per imported key |

Verifying before encrypting matters: writing a new keystore under the wrong
password would silently make the whole set un-unlockable.

### Removal warnings

Removing an account tells you what you would actually lose:

| Backup state | Warning |
| --- | --- |
| Derived from the phrase | Restoring the phrase and adding accounts up to index N brings it back. |
| Imported from / exported to a file | Keep that file and its password — it is the only way back. |
| Raw key, never exported | **Danger**, plus a mandatory acknowledgement checkbox before the button enables. |

The last account cannot be removed — lock or *Forget this device* instead.

### Total balance

Every account is read in **one** JSON-RPC batch: a single HTTP POST whose body
is an array of `eth_getBalance` calls, all at the same block tag. N accounts
cost one round trip, not N, and the total is a sum of readings taken at one
moment rather than N readings drifting across N requests. Replies are matched
back **by id** (out-of-order answers are legal), a per-account error does not
poison the others, and the total is labelled `≥` whenever any account failed to
read, so a partial sum is never presented as a complete one.
`tests/balances.test.mjs` asserts the round-trip count with a spy transport;
`npm run e2e` cross-checks every batched value against `eth_getBalance` and the
total against their sum on a live chain.

If the RPC rejects array bodies, the code falls back to per-account
`provider.getBalance` calls (which ethers also coalesces) and only reports the
balance stale when everything fails.

### Migration from the single-account wallet

A v1 install has one bare keystore string under
`ferminux.wallet.keystore.v1`. On first load it is upgraded **in place, without
a password** — the encrypted bytes are carried over verbatim, so the user's
existing password keeps working:

- a keystore carrying a mnemonic (`x-ethers.mnemonicCiphertext`, detectable
  without decrypting) becomes the HD **seed** plus account 1, and the upgraded
  wallet can immediately add more accounts;
- one without a mnemonic becomes a standalone imported account.

The v1 key is deleted only after the v2 blob has been written **and read back
and re-parsed**; if the write fails (quota, private mode) the old key is left
untouched and the session still opens from the in-memory upgrade.

This is tested three ways: as a pure function, through a stubbed `localStorage`
including the failed-write path (`tests/vault.test.mjs`), on a live chain
(`npm run e2e`), and in a real browser — `npm run ui` seeds a genuine v1 keystore
into `localStorage`, reloads the page, asserts the account appears on the unlock
screen, unlocks it with the **original** password, and then adds a second HD
account to prove the phrase survived.

### Identicons

`src/lib/identicon.ts` turns an address into a 5×5 mirrored block identicon with
a seeded xorshift PRNG and a muted 12-colour palette. Pure, deterministic,
case-insensitive, and computed locally — no avatar service ever learns an
address, and it renders offline. The generator guarantees a readable figure (a
blank or fully filled grid is repaired) and gives each account a second spot
colour.

## QR scanning

`src/lib/qr.ts` is the parser: a pure module (no browser globals, no network)
shared by the UI, the unit tests and the live check. It accepts

| Payload | Result |
| --- | --- |
| `0xABC…` | `{ kind: 'address', address }` — EIP-55 checksum enforced |
| `ethereum:0xABC…` | `{ kind: 'address', address }` |
| `ethereum:pay-0xABC…@3961` | …with `chainId: 3961` |
| `ethereum:0xABC…@3961?value=2.014e18` | …with `amount: 2014000000000000000n` |
| `ethereum:0xABC…@3961?value=1e18&gas=21000` | extra parameters are ignored, not fatal |
| `ethereum:0xTOKEN@3961/transfer?address=0xABC…&uint256=…` | `{ kind: 'erc20-transfer', address, tokenAddress, amount }` |

EIP-681 `value` is parsed in **integer arithmetic only** — `2.014e18` becomes
exactly `2014000000000000000` wei, never a float. A value that is not a whole
number of base units (`1.5`, `1e-3`) is refused rather than silently truncated.

Everything else is rejected with a typed error and an explanation the user can
act on: a **wrong chain id** names the chain the code was for ("That code is for
Ethereum mainnet (chain 1)…"), a bad checksum, an unsupported scheme
(`bitcoin:`, `wc:`), an unsupported function (`approve()`), an empty payload, a
malformed URI.

The scanner UI (`src/views/ScannerModal.tsx`) handles every failure honestly and
**always** offers a way through without a camera:

| Situation | What the user sees |
| --- | --- |
| Permission denied | How to re-enable it (padlock → Site settings → Camera; iOS Settings → Safari) + *Try the camera again* |
| No camera present | "Use *Scan from image* — works on desktops with no camera at all" |
| Insecure context (plain `http://`) | "Browsers only expose the camera over HTTPS (or localhost)" |
| Camera busy / unknown failure | The browser's own reason, plus retry |
| No `mediaDevices` API | Named, with both fallbacks offered |
| 20 s with no decode | An unprompted hint pointing at the fallbacks |

Fallbacks, present in every state: **Scan from image** (decodes an uploaded
screenshot or photo through the same jsQR path, `attemptBoth` inversion) and a
**manual paste** box that accepts the same payloads as the camera.

Every camera track is stopped on close, on unmount, on a successful decode and
on the StrictMode double-mount — the `rAF` loop is cancelled first, then
`track.stop()` runs for every track and `video.srcObject` is cleared. No camera
light is left on. This is asserted in the browser check (`stop()` call count,
`readyState === 'ended'`, and zero further decode passes after close).

## Block rewards

Ferminux blocks are confirmed by signers, and **a block reward is not a transaction** — the
signer's balance is credited directly in state. An active signer address
therefore had an *empty* Activity tab while earning a reward on every block it confirmed. `src/lib/rewards.ts`
fixes that by merging two more Blockscout endpoints into the feed:

- `GET /api/v2/addresses/{addr}/coin-balance-history` — per-block balance deltas
- `GET /api/v2/addresses/{addr}/blocks-validated` — blocks this address signed

Attribution is deliberately conservative — a phantom "+0.1 FMX signed" row would be
worse than no row at all:

1. `/blocks-validated` is authoritative for **which** blocks were signed and for
   the reward figure when it has one. Blockscout indexes a block before it
   computes its reward, so the newest blocks come back with `rewards: []`; that
   block's own unattributed balance credit is used instead and the row is
   marked *inferred from balance change*. With neither, the reward shows as `—`
   ("reward not yet indexed") and is excluded from the total rather than guessed.
2. A balance delta becomes a signed-block row of its own only when nothing else
   explains it: positive, attributed to no transaction, not already covered by
   (1), and **no transaction of ours in that block** — that last condition is the
   dedup for a reward and a transfer sharing a block.
3. Transactions are deduped by hash.

Signed-block rows are visually distinct (amber `SIGNED` badge, amber value, a subtle
amber left rule) and link to the **block**, not a transaction. A **Block rewards**
summary card appears *only* when the address has signed something, and is explicit
that it covers the fetched window: *"Covers blocks 1,722–1,771 only — the
explorer holds more history than one page, so this is not an all-time total."*

If the explorer is unreachable the wallet stays fully functional on RPC alone and
the Activity panel says so; if only the transactions endpoint fails, signed-block rows
still render with a note.

## Development

```sh
npm install
npm run dev          # local dev server
npm test             # unit tests (accounts, vault, balances, validation, QR, activity)
npm run e2e          # full data-layer e2e against a local anvil (see below)
npm run ui           # headless-browser check of the multi-account UI (see below)
npm run smoke        # multi-chain browser smoke on anvil forks of 3961 + BSC (see below)
npm run mint-smoke   # NFTs → Mint at 390 and 1440 px on an anvil fork of 3961 (both collections, races, short balance)
npm run swap-smoke   # Home → Swap at 390 and 1440 px on an anvil fork of 3961 (approvals, multi-pool routes, price moves)
npm run live         # READ-ONLY check against the real chain-3961 explorer
npm run build        # tsc --noEmit + vite build + external-URL guard on dist/
npm run preview      # serve the production build locally
```

Node ≥ 23 is required for `test`/`e2e` (they import the app's `.ts` modules via
native type stripping — the exact same code the UI runs).

## Configuration

Defaults live in [`src/config.ts`](src/config.ts); every value can be overridden
at build time with environment variables:

| Variable | Default |
| --- | --- |
| `VITE_RPC_URLS` | `https://rpc.ferminux.net,https://ferminux.net/rpc` (ordered fallback, each health-probed with `eth_chainId`) |
| `VITE_CHAIN_ID` | `3961` |
| `VITE_EXPLORER_URL` | `https://explorer.ferminux.net` |
| `VITE_RPC_ETH`, `VITE_RPC_BSC`, `VITE_RPC_BASE`, `VITE_RPC_ARBITRUM`, `VITE_RPC_POLYGON`, `VITE_RPC_OPTIMISM`, `VITE_RPC_AVALANCHE` | the public RPCs in *Networks* (comma-separated ordered fallback) |
| `VITE_WC_PROJECT_ID` | empty — WalletConnect off (see *WalletConnect*) |
| `VITE_WC_TEST_KIT` | unset. `1` only in `npm run smoke`'s test build; never for a deployed build |

`DEFAULT_TOKENS` comes from the shared registry `shared/tokens.ts`; the other
networks' USDC/USDT are in `src/lib/chains.ts`. Any new RPC host must also be
added to `scripts/check-dist.mjs`, or the build fails.

## Deploy

`vite.config.ts` uses `base: './'`, so one `dist/` serves from **both**
`wallet.ferminux.net` and `https://ferminux.net/wallet/` — copy `dist/` to the
web root (or the `/wallet/` subpath) behind nginx. No server-side code.

**Security headers.** Both origins get the same headers from
`infra/compose/nginx/nginx.conf` (values in the `$fxw_*` maps of the http
block, the `add_header` lines in the `wallet.ferminux.net` server and in
`location ^~ /wallet/` of `ferminux.net`; `add_header` in a location replaces
the inherited set, so every location that sets its own repeats them):

```
default-src 'none'; script-src 'self'; style-src 'self';
img-src 'self' data: blob: https:; font-src 'self';
connect-src 'self' https://rpc.ferminux.net https://ferminux.net https://explorer.ferminux.net
  https://ethereum-rpc.publicnode.com https://eth.drpc.org
  https://bsc-rpc.publicnode.com https://bsc-dataseed.bnbchain.org
  https://base-rpc.publicnode.com https://mainnet.base.org
  https://arbitrum-one-rpc.publicnode.com https://arb1.arbitrum.io
  https://polygon-bor-rpc.publicnode.com https://polygon.drpc.org
  https://optimism-rpc.publicnode.com https://mainnet.optimism.io
  https://avalanche-c-chain-rpc.publicnode.com https://api.avax.network
  wss://relay.walletconnect.org https://verify.walletconnect.org https://verify.walletconnect.com;
frame-src https://verify.walletconnect.org https://verify.walletconnect.com;
frame-ancestors 'none';            (connect.html: https://ferminux.net https://*.ferminux.net)
base-uri 'none'; form-action 'none'; object-src 'none'; upgrade-insecure-requests
```

plus `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`,
`Strict-Transport-Security: max-age=31536000`, `Permissions-Policy` with
everything off except `camera=(self)` on the wallet page (the QR scanner), and,
on every page except `connect.html`, `X-Frame-Options: DENY` and
`Cross-Origin-Opener-Policy: same-origin-allow-popups`. `connect.html` gets
neither: it answers the dApp that opened it through `window.opener`, and the
wallet's own site (`*.ferminux.net`) embeds it as the invisible status frame
(`src/connect/frame.ts`). A dApp on any other site cannot frame it; its frame
could never read the wallet's storage anyway, and the provider drops a frame
that does not answer.

There is no inline script or style anywhere (React sets styles through the
CSSOM, which CSP does not govern), so no `'unsafe-inline'`, hashes or nonces.
`img-src https:` is for NFT images and WalletConnect dApp icons (a dApp's icon
is its own URL; NFT images from hosts other than ferminux.net only load after a
click). WalletConnect telemetry stays out: `telemetryEnabled: false`, and the
one INIT event WalletKit posts to `pulse.walletconnect.org` regardless is
skipped in `src/state/useWalletConnect.ts`.

**A new endpoint in the code needs its host in three places**: the code,
`scripts/check-dist.mjs` (or the build fails) and `connect-src` in nginx.conf
(or browsers block it in production). `tests/csp.test.mjs` fails when
nginx.conf is missing an RPC, explorer or WalletConnect host the code uses.

Two things the **QR scanner** needs from the deployment:

- **HTTPS.** `getUserMedia` is unavailable on a plain-`http://` origin, and the
  scanner says so explicitly rather than failing silently — but the camera will
  simply not work there. `wallet.ferminux.net` and `ferminux.net/wallet/` are
  both TLS, so this only bites on ad-hoc HTTP mirrors.
- **`Permissions-Policy: camera=(self)`** (or no `camera` directive at all). A
  restrictive `camera=()` header blocks the prompt entirely; the wallet then
  says the address has the camera turned off, and the image/paste fallbacks
  still work. Both wallet origins send `camera=(self)` (ferminux.net's own
  `camera=()` does not reach `/wallet/`, whose location sets its own headers).

The camera preview is a `MediaStream` on the video element (`srcObject`), which
CSP does not govern, so no `media-src` is needed. The uploaded picture is
decoded with `createImageBitmap`, which needs no URL at all; `blob:` in
`img-src` is only for the legacy object-URL fallback.

## Testing

- `npm run e2e` (`scripts/e2e.mjs`) boots **anvil on port 8547 with
  `--chain-id 3961`**, then drives the app's own modules (`src/lib/*`,
  `src/config.ts` — kept free of browser globals):
  wallet creation from a fresh mnemonic; keystore encrypt→decrypt roundtrip and
  wrong-password rejection; funding; an EIP-1559 FMX transfer with the recipient
  balance and **chainId 3961 asserted inside the raw signed transaction**; the
  Max fee-headroom math draining an account exactly; **HD accounts 0–2 derived
  from one phrase and checked against the node's own `m/44'/60'/0'/0/N`
  accounts**; **the whole account set fetched in ONE batched request**, every
  value cross-checked against `eth_getBalance` and the total against their sum;
  **a transfer between two of the user's own accounts**; **a 3-account vault
  encrypted under one password, serialized, reloaded from the string, unlocked,
  scanned for plaintext secrets, and used to sign a real transaction**; **a v1
  single-account keystore migrated and unlocked with its original password**;
  deployment of the real AZNT forge artifact from `../contracts/out` and the
  token module's metadata read, balance and transfer. Anvil is killed afterwards
  and the script verifies port 8547 is free again.
- `npm test` (`tests/*.test.mjs`, 201 tests) covers EIP-55 address
  validation, 18-decimal amount parsing edge cases, fee math (`maxSendable`,
  worst-case fee), display formatting, the Blockscout activity parser, and:

  ```sh
  node --test tests/accounts.test.mjs  # HD derivation, index allocation, labels, identicons
  node --test tests/vault.test.mjs     # multi-account storage, migration, plaintext scan
  node --test tests/balances.test.mjs  # batching: one round trip, id matching, totals
  node --test tests/qr.test.mjs        # QR: every parse + rejection case (+ multi-chain codes)
  node --test tests/rewards.test.mjs   # Activity: merge, dedup, block-reward summary
  node --test tests/chains.test.mjs    # the 8 networks; parity with the gateway's pay-in chains
  node --test tests/portfolio.test.mjs # per-chain reads: Multicall3 / batch, chain-id check, fallback, timeouts
  node --test tests/fees.test.mjs      # tip floor vs zero tips, legacy chains, OP-stack L1 fee
  node --test tests/nft.test.mjs       # ownerOf scan, tokenURI metadata, explorer parse, image policy
  node --test tests/storage-lists.test.mjs # added tokens, sent-tx log, text hygiene
  node --test tests/walletconnect.test.mjs # pairing codes, proposals, every request, fake-WalletKit controller
  node --test tests/swap.test.mjs      # DEX math vs Solidity, routes (1–3 pools), impact, calls, pre-check, settings
  ```
- `npm run swap-smoke` (`scripts/swap-smoke.mjs`) forks **Ferminux (3961)** into
  a local anvil (port 28591) and, on the fork only, seeds a WFMX/USDF pool at the
  official **$0.52 per FMX** from the treasury (impersonated) unless the chain
  already has one. At **390×844 touch**: FMX → USDF, USDF → AZNT (exact
  approval as step 1, then the route through WFMX) and AZNT → FMX (Max), each
  quote checked against the router's `getAmountsOut`, each confirm screen
  (contract, method, amounts), each receipt, balance and allowance on the fork;
  then a 20,000 FMX trade lands between the confirm screen and Sign and the
  swap is refused with nothing broadcast; no sideways scroll at 320–430 px. It
  then seeds a USDF/AZNT pool at the gateway's basis (1 USD = 1.70 AZN) and at
  **1440×900**: FMX → AZNT takes the best of every candidate route on the
  router, a 100,000 FMX trade is flagged as severe impact and Review waits for
  the acknowledgement, FMX → WFMX is `deposit()`, and an asset's Swap button
  starts the form from that asset (none on another network).
  `PLAYWRIGHT_MODULE=…/playwright/index.mjs npm run swap-smoke`.
- `npm run smoke` (`scripts/multichain-smoke.mjs`) forks **Ferminux (3961)** and
  **BSC (56)** into two local anvils (ports 8561/8562), builds the bundle with
  those two networks pointed at the forks (the other six keep their public RPCs,
  read-only), and at **390×844 touch and 1440×900**: creates a wallet, funds it
  on the forks only, checks the Assets tab reads all eight networks, sends FMX,
  USDF, BNB and USDT through the UI and checks each recipient balance on the
  fork, moves Ferminux Agents #41 into the wallet on the fork and sends it on
  from the NFTs tab (image from its tokenURI metadata, `ownerOf` checked),
  checks the BSC activity rows and BscScan links, then drives the
  WalletConnect proposal, `personal_sign` (signature recovered),
  `eth_sendTransaction` (mined on the BSC fork), `wallet_switchEthereumChain` and
  `eth_sign` modals with a scripted WalletKit stand-in, and checks there is no
  horizontal scroll from 320 to 430 px. Skips without anvil or Playwright
  (`PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs`).

  `tests/accounts.test.mjs` asserts the **exact published addresses** for two
  BIP-39 vectors at indices 0–3, that index 0 still equals the original
  single-account path, that batch derivation matches one-at-a-time, that phrase
  normalization does not move an address, `nextHdIndex` gap-filling, label
  normalization (whitespace, control characters, zero-width/bidi marks, length
  cap, fallbacks, case-insensitive de-duplication), and identicon determinism,
  mirroring, palette membership and non-degeneracy.

  `tests/vault.test.mjs` covers the encrypt→serialize→parse→decrypt round trip
  for a mixed HD + imported set, wrong-password rejection (including the
  imported-only case), one account encrypted under a different password *not*
  locking out the rest, the plaintext-secret scan (plus a positive control that
  proves the scanner works, plus a false-positive guard for `salt` — both a
  kdfparams field and a BIP-39 word), parser hardening, password-free metadata
  edits, adding an HD account writing only an index, and the v1 migration as a
  pure function, through a stubbed `localStorage`, and through a *failing*
  `localStorage` write.

  `tests/balances.test.mjs` asserts that N addresses cost exactly one transport
  call, that an empty set makes none, batch well-formedness (unique ids, one
  block tag), de-duplication, id-based reply matching, per-account failures,
  256-bit exactness, totals and lower-bound detection, and the HTTP transport
  posting a single array body.

  `tests/qr.test.mjs` covers plain addresses (checksummed / lowercase /
  uppercase / bad checksum), every EIP-681 form above, `value` in exponent form
  (`2.014e18`, `1.234567890123456789e18` — asserted exact, no float rounding),
  the FRC-20 token `transfer` form, wrong chain ids (named), unsupported schemes and
  functions, empty and junk input, structurally broken URIs, `buildEip681Uri`
  round-tripping back through the parser, and jsQR image decoding — QR codes are
  rendered to raw RGBA in-test with the `qrcode` package and decoded back,
  including the inverted-image path and blank/malformed buffers.

  `tests/rewards.test.mjs` covers the balance-history and blocks-validated
  parsers against real chain-3961 response shapes, feed ordering (pending first,
  then block number descending), dedup of duplicate transactions and duplicate
  blocks, **a reward and a transfer in the same block**, the `rewards: []`
  fallback to a balance credit, negative/attributed deltas being ignored, empty
  states, and the block-reward summary's totals, window bounds and honesty flags.

- `npm run live` (`scripts/live-activity.mjs`) runs the wallet's **own**
  activity + rewards modules against the real `explorer.ferminux.net` and prints
  the feed the Activity tab would render, then asserts signed-block rows are present,
  the feed is newest-first, there are no duplicates and the 6 FMX block reward
  shows up. Read-only: it only GETs the REST API — nothing is signed or
  broadcast. Pass an address to check a different one:

  ```sh
  npm run live                                              # default: a pre-fork block producer
  npm run live -- 0x7F16433359E4eF704E90cE08460c6238E45130f7
  ```

- `npm run ui` (`scripts/ui-check.mjs`) drives the **real UI** in headless
  Chromium against a local anvil, on ports 8571 (static server) and 8547 (anvil).
  It builds the actual bundle with `VITE_RPC_URLS=http://127.0.0.1:8547` and a
  deliberately dead explorer, then: seeds a genuine **v1** keystore into
  `localStorage` and asserts the migration + unlock + growth; forgets the device;
  creates a wallet (phrase gate, password, keystore download, *remember on this
  device*); funds account 1 on chain and waits for the balance to appear without
  a reload; adds two HD accounts; imports a raw private key as a fourth; renames
  one; checks the total against the chain sum; scans the browser's own
  `localStorage` for the private key, every mnemonic word and the password;
  switches accounts from the header; fills a recipient from **My accounts**;
  locks and unlocks the whole set with one password (labels and total intact);
  checks that Tokens, Activity and Receive follow the active account and that the
  Activity tab degrades to *History unavailable*; checks the QR scanner still opens with its
  no-camera fallbacks; asserts that at **390 px wide** the header, the switcher
  menu and the Accounts panel all fit with no horizontal page scroll and the
  modal's Close button stays on screen; walks the no-backup removal gate; and
  rejects a wrong password. Screenshots (desktop and mobile) are written to a
  temp directory whose path is printed at the end.

  It **skips cleanly** (exit 0) when anvil, `playwright-core` or a Chromium build
  is missing:

  ```sh
  npm run ui                                             # skips if unavailable
  PLAYWRIGHT_DIR=/path/with/node_modules/playwright-core \
  CHROME_PATH="$HOME/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" \
    npm run ui
  ```

- `npm run build` fails if `dist/` contains any unexpected external URL
  (`scripts/check-dist.mjs`; inert library string constants are allowlisted
  explicitly with justification). This is what proves `jsqr` is **bundled** and
  not fetched from a CDN.

## Security model

| What | Where | Notes |
| --- | --- | --- |
| Private keys / mnemonic | Page memory only | Every account's key, and the phrase used to derive more, live in React state and nowhere else. Wiped on Lock, idle auto-lock (15 min), or tab close. Never transmitted, never written to disk by the app. |
| Keystore JSON (scrypt-encrypted) | Downloaded file; optionally `localStorage` | One per non-derived account (the HD seed + each imported key), all under one password. Only with the explicit *remember on this device* opt-in. Useless without the password. |
| Account addresses, labels, HD indices | `localStorage`, **only when remembered** | Public data, and what makes the set reappear intact after a lock. Nothing address-shaped is written when *remember* is off. |
| Added tokens | `localStorage` (`ferminux.wallet.tokens.v2`) | Chain id, contract address and the metadata the contract reported — public data. |
| Sent-transaction log (non-Ferminux networks) | `localStorage` (`ferminux.wallet.activity.v1`), **only when remembered** | Hashes, addresses, amounts — public on-chain data, but it names this wallet's address, so without *remember* it lives in page memory only, and forgetting the device removes it. |
| WalletConnect sessions | WalletConnect's IndexedDB store | Session metadata, the connected account's address and per-session relay encryption keys. Never a wallet key. Kept until the site is disconnected, **also when *remember* is off** — disconnect sites before leaving a shared device. |
| View preferences | `localStorage` | Hide-zero toggle, network filter. |
| Password | Nowhere | Used transiently for scrypt — including for an import into a remembered vault, where it is verified against the stored set, used once and dropped. There is no recovery. |

- Transactions are signed **offline** with an explicit chain id taken from the
  wallet's own network list (3961 on Ferminux) — never from the RPC — so a
  malicious endpoint cannot cross-chain-replay a signature.
- The confirm screen opens with the **network** (name and chain id) and renders
  the exact values being signed (recipient, amount, worst-case fee in that
  network's coin, chain id, nonce, gas limit, fee type).
- RPC endpoints are health-probed (`eth_chainId` must return the network's id)
  before use, and every balance read carries `eth_chainId` in the same request;
  the provider's response cache is disabled so balances are never stale after a
  confirmed transaction.
- Runtime network traffic is limited to the configured RPC endpoints, the
  explorer API, NFT metadata/images on ferminux.net (other image hosts only on
  click) and, once a site is paired, the WalletConnect relay and Verify API.
- Every WalletConnect signature and transaction has its own confirm modal
  naming the requesting origin as WalletConnect Verify saw it; nothing is
  answered while the wallet is locked.
- **Camera frames never leave the device.** jsQR is compiled into the bundle and
  decodes on the page's own canvas; no frame, image or decoded payload is
  uploaded anywhere. The stream is released the moment the scanner closes.
- Only the **active** account can sign. Every panel names the account it is
  acting for (Send shows the sender, Receive/Tokens/Activity show the holder),
  and the confirm screen carries a **From** row, so a multi-account session
  cannot quietly sign from the wrong address. Switching accounts resets the Send
  form rather than carrying a half-filled transfer to a different sender.
- Adding an account never re-encrypts existing ones, and importing into a
  remembered vault verifies the password against the stored set **before**
  writing — a mistyped password is refused instead of silently producing a
  keystore the set cannot open.
- A scanned code can only *fill in the Send form* — it never signs or sends. The
  same confirm screen still shows the exact values before anything is signed,
  and a code carrying an **unsupported chain id is refused outright**; a code for
  another supported network switches the form to that network (and says so)
  rather than paying the address on the wrong one.

## Mobile app (Android / iOS)

The same code base ships as **Ferminux Wallet** (`net.ferminux.wallet`), a
Capacitor 8 app: `android/`, `ios/`, `capacitor.config.ts`. The web wallet is
unchanged by it — the native code is a separate chunk that only an app build
(`VITE_APP_NATIVE=1`) emits, and `src/platform/` answers every call with the
web behaviour otherwise.

```sh
set -a; . ../.credentials/walletconnect.env; set +a      # VITE_WC_PROJECT_ID
node scripts/app-build.mjs android                       # signed release APK + AAB -> ~/Android/apk
node scripts/app-build.mjs android --devnet --rpc http://10.0.2.2:8545   # anvil test build
node scripts/app-build.mjs ios                           # Release build for the iOS simulator
node scripts/app-assets.mjs                              # icons + splash from brand/dist
```

Needs JDK 21 (Homebrew `openjdk@21` is found on its own) and the Android SDK
(`ANDROID_HOME`, or `~/Android/sdk`). Release builds are signed with the upload
key in `../.credentials/wallet-app/` (`keystore.properties` names the keystore
and its passwords; `FXW_KEYSTORE_PROPERTIES` points elsewhere). That key is the
Play **upload** key: with Play App Signing, add Google's app-signing
certificate fingerprint to `public/.well-known/assetlinks.json` too.

| | Android | iOS |
| --- | --- | --- |
| Stored vault | the same scrypt-encrypted vault, kept in the plugin's Keystore-backed store (AES-GCM, Android Keystore key), not in WebView storage | Keychain |
| Biometric unlock | the vault password behind a Keystore key that needs a BiometricPrompt `CryptoObject` (strong biometrics; invalidated when fingerprints change) | Keychain item with `.biometryCurrentSet` |
| Secret screens | `FLAG_SECURE` while the recovery phrase (`.mnemonic-grid`) or any `[data-secure-screen]` element is on screen | screenshot shield on the same screens |
| QR scanner | `@capacitor/barcode-scanner` (CameraX + ML Kit, no Play services needed), in-page scanner as fallback | same plugin (AVFoundation) |
| Deep links | `wc:`, `ferminuxwallet://wc?uri=…`, app links `https://wallet.ferminux.net/wc?uri=…` and `https://ferminux.net/wallet/wc?uri=…` | URL schemes `wc`, `ferminuxwallet`; universal links need `apple-app-site-association` with the Team ID |
| Other | back button closes the top dialog, then follows the screen's own Back (`.back-btn` / `[data-back]`), then backgrounds the app; `allowBackup` off, cloud/device-transfer backup excluded; HTTPS only with system CAs; no WebView debugging in release builds | no WebView inspection in release |

Plugins: `@capgo/capacitor-native-biometric` (secure storage + biometrics),
`@capacitor/barcode-scanner`, `@capacitor-community/privacy-screen`,
`@capacitor/app`, `browser`, `filesystem`, `share`, `splash-screen`.

The app serves its own files as `https://wallet.ferminux.net` (Capacitor
`server.hostname`), so WalletConnect dApps show the wallet's real URL, and its
WalletConnect metadata carries `redirect.native = ferminuxwallet://` and
`redirect.universal = https://wallet.ferminux.net/wc`. The keystore "download"
opens the share sheet (Save to Files / Drive); a sheet closed without saving is
reported as "not saved" with a way to save again, and an exported account keeps
its NO BACKUP flag until a file has actually been handed over. Every sentence
that names where keys live or how a file leaves says "this phone" and "share
sheet" in the app and "this browser" and "download" on the web
(`src/platform/words.ts`, read through `isNativeApp()`). The `devnet` flavour
(`net.ferminux.wallet.devnet`) is for anvil tests only: it is the one build that
may speak plain http, and only to the emulator host.

For the UI: `src/platform/index.ts` (bridge), `src/platform/react.ts` (hooks:
`useSecureScreen`, `useBackButton`, `useDeepLinks`, `useBiometric`,
`useWalletConnectLinks`), `src/platform/ui.tsx` (`<BiometricUnlock>`,
`<BiometricSetting>`). In the app `<html>` carries `class="fxw-app"` and
`data-platform="android|ios"`; every dialog must close on Escape (the back
button sends it).
