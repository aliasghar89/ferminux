# Ferminux Wallet in the WalletConnect Explorer

A wallet listed in the WalletConnect Explorer (shown publicly as WalletGuide) appears inside
other dApps' WalletConnect modals: Reown AppKit's "All wallets", and every picker that reads the
Explorer. This page is the submission, ready to paste. The owner submits it from the Reown
account that owns the wallet's project, at [dashboard.reown.com](https://dashboard.reown.com)
(cloud.reown.com redirects there).

Machine-readable copy of the same fields, in the Explorer's own schema:
[`walletconnect-listing/listing.json`](walletconnect-listing/listing.json). Icons are in
[`walletconnect-listing/`](walletconnect-listing/).

## What already works without the listing

Ferminux Wallet already connects to any WalletConnect dApp: on the site choose **WalletConnect**,
copy its code (or scan its QR), and paste it in the wallet's **Connect** tab. Tested on
2026-09-26 against PancakeSwap (session on BNB Chain) and Uniswap (session on Ethereum), with
the WalletConnect Verify service reporting both domains as verified
(`scripts/wc-thirdparty.mjs`). The listing adds the one-tap path: the wallet shows up in the
site's list, and choosing it opens the wallet with the code already filled in.

## Before submitting

1. **Chain 3961 must be in the Explorer's chain registry.** The Explorer only accepts chains
   it has registered, and on 2026-09-26 `eip155:3961` was not among them
   (`GET https://explorer-api.walletconnect.com/v3/chains?projectId=…&namespaces=eip155`).
   Its eip155 entries match ethereum-lists/chains (same names and RPC lists), so first submit
   [`infra/listings/eip155-3961.json`](../../infra/listings/eip155-3961.json) there (steps in
   [`infra/listings/README.md`](../../infra/listings/README.md)). If 3961 still does not appear
   in the Explorer after that PR is merged, open the "Add Chain" issue linked from the Chains
   section of [docs.reown.com/cloud/explorer](https://docs.reown.com/cloud/explorer). Until
   then, submit with the seven other chains and add `eip155:3961` in an edit.
   - Match the network name first: the chain registry entry says `"name": "Ferminux Network"`,
     while every dApp's `wallet_addEthereumChain` now sends `chainName: "Ferminux"`
     (`shared/fxwallet/network.ts`). Wallets that compare the two may warn. Pick one and
     change the other (one line either way) before the ethereum-lists PR.
2. **The project.** The wallet build uses the Reown project `4b4fa03649fd748d2c3902a13df3fefd`
   (`VITE_WC_PROJECT_ID`). Submit the listing from that project so the listing and the
   sessions it creates belong together. If the project has an origin allowlist, it must hold
   `https://wallet.ferminux.net` and `https://ferminux.net` (the same build is served at both).
3. **Deploy the current wallet build** to both origins. It carries `fxwallet.js` (below) and
   the `/wc?uri=` pairing link that the listing's links rely on.
4. **Try it the way the reviewers will**: open [appkit-lab.reown.com](https://appkit-lab.reown.com),
   choose WalletConnect, copy the link, paste it into the wallet, approve, then send a
   `personal_sign` from the lab and approve it in the wallet.

## The fields

| Field | Value |
|---|---|
| Name | `Ferminux Wallet` |
| Short name | `Ferminux` |
| Type | Wallet |
| Category | Web App Wallets (add Mobile Wallets once the app is in the stores) |
| Description | Self-custody wallet for Ferminux (chain 3961) and seven more networks: Ethereum, BNB Chain, Base, Arbitrum, Polygon, Optimism and Avalanche. Keys stay encrypted on your device. Nothing to install. |
| Homepage | `https://wallet.ferminux.net` |
| Logo | `walletconnect-listing/ferminux-wallet-512.png` (512×512, square, opaque) |
| Chains (CAIP-2) | `eip155:3961`, `eip155:1`, `eip155:56`, `eip155:8453`, `eip155:42161`, `eip155:137`, `eip155:10`, `eip155:43114` |
| WalletConnect version / SDK | v2, Sign API through Reown WalletKit (`sign_v2`) |
| Standards | EIP-155, EIP-191, EIP-712, EIP-1193, EIP-1559, EIP-3085, EIP-3326, EIP-6963 |
| Methods | `eth_sendTransaction`, `personal_sign`, `eth_signTypedData_v4`, `eth_sign`, `wallet_switchEthereumChain`, `wallet_addEthereumChain` |
| Events | `chainChanged`, `accountsChanged` |
| Web app link | `https://wallet.ferminux.net` |
| Mobile — universal link | `https://wallet.ferminux.net` |
| Mobile — native link | leave empty until the app is in the stores, then `ferminuxwallet://` |
| Desktop — universal link | `https://wallet.ferminux.net` |
| Desktop — native link | none |
| App Store / Play Store | none yet (add the store URLs when the app is published) |
| Browser extension | none |
| Injected | namespace `eip155`, injected id `isFerminuxWallet` |
| RDNS (EIP-6963) | `net.ferminux.wallet` |
| Primary / secondary colour | `#05EE93` / `#000000` |
| Support contact, X, GitHub | the owner's (not recorded here) |

Why the mobile native link stays empty for now: a WalletConnect modal on a phone opens the
native link first. With no app installed to answer `ferminuxwallet://`, the tap would do
nothing. With only the universal link, the tap opens `https://wallet.ferminux.net/wc?uri=…`:
the web wallet today. Once the app claims `wallet.ferminux.net/wc` as an app link (the app
lane's `ios/App/App/App.entitlements` and Android intent filter), the same link opens the app
when it is installed.

## How each link reaches the wallet

A WalletConnect modal turns the listing's links into these URLs. The first row was tested end
to end against the current build; the app row is the app's own handler and needs the app.

| Where the user taps | URL the modal opens | What the wallet does |
|---|---|---|
| Phone or desktop, wallet listed with a web app / universal link | `https://wallet.ferminux.net/wc?uri=wc%3A…` | Both production hosts answer `/wc` with the wallet page (checked 2026-09-26: `https://wallet.ferminux.net/wc` and `https://ferminux.net/wallet/wc`, 200). The page takes the code out of the address bar (it carries the pairing key), and after unlock the connection request appears as if pasted. `scripts/wc-thirdparty.mjs --via-link pancakeswap` covers this path end to end. |
| Phone, app installed (later) | `ferminuxwallet://wc?uri=wc%3A…`, or the universal link above caught as an app link | The app's deep-link handler (`src/platform/deeplink.ts`) pairs the same way. |
| Any page that includes `fxwallet.js` | EIP-6963 announcement | See below. |

After a connection, a dApp that asks for a signature opens nothing by itself. The request
waits in the wallet (also while it is locked) and appears when the wallet is open and unlocked.

## EIP-6963: the wallet on any dApp, with one script tag

Browser wallet pickers built on EIP-6963 (wagmi, RainbowKit, Reown AppKit, ConnectKit,
Web3-Onboard) list every wallet that announces itself on the page. Ferminux Wallet has no
extension to do that. Instead, a dApp can include:

```html
<script src="https://wallet.ferminux.net/fxwallet.js" async></script>
```

The script announces `Ferminux Wallet` under rdns `net.ferminux.wallet`, with the brand mark
inline and a fresh uuid per page. Choosing the wallet opens it in a window (a tab on phones)
through the same connect protocol as the Ferminux dApps, and every signature is confirmed there
against the page's origin. The script leaves `window.ethereum` alone. The wallet it opens is the
one that served the script, so the official copy opens `wallet.ferminux.net`, and the window
moves to `ferminux.net/wallet/` when that is where the person's wallet was created. With the
Explorer listing in place, AppKit matches the announced rdns to the listing and shows the wallet
as available on the page.

- Source: `shared/fxwallet/embed.ts`. Build: `node shared/fxwallet/build-embed.mjs` writes
  `wallet-web/public/fxwallet.js`, which is served at both wallet origins.
- Check: `scripts/embed-check.mjs` loads it on a page of another origin, checks the
  announcement (name, rdns, icon, uuid, re-announcement on `eip6963:requestProvider`), and
  connects through the wallet window.
- Every Ferminux dApp already announces the same provider through `shared/fxwallet`.

## Icons

| File | Size | Use |
|---|---|---|
| `ferminux-wallet-512.png` | 512×512, opaque | The listing logo (upload this one) |
| `ferminux-wallet-1024.png` | 1024×1024, opaque | If the form asks for a larger one |
| `ferminux-wallet-256.png`, `-128.png`, `-64.png` | opaque | Smaller copies |
| `ferminux-wallet.svg` | vector, square | Vector upload, if accepted |
| `ferminux-wallet-rounded.svg`, `-rounded-512.png` | rounded corners, transparent outside | Where a pre-rounded icon is wanted |

All are the brand mark from `brand/dist/favicon.svg` on black. The square ones are full-bleed
because wallet pickers apply their own corner mask. They were rendered from the SVG in Chrome,
so they are pixel-exact at each size.

## After approval

- Find the listing id: `GET https://explorer-api.walletconnect.com/v3/wallets?projectId=<id>&search=Ferminux`.
- Put that id first in `FEATURED_WALLETCONNECT_WALLETS` (`shared/fxwallet/connector.ts`). The
  Ferminux dApps' WalletConnect modal then shows the wallet first, next to the Ferminux Wallet
  row that already heads their own chooser.
- Other dApps can feature it the same way (`featuredWalletIds` in AppKit).
