# Connect with Ferminux Wallet

`shared/fxwallet` makes the Ferminux web wallet (`wallet.ferminux.net`) a wallet any dApp can
connect to, with nothing to install. It is framework-free TypeScript with no dependencies.

```ts
import { createWalletConnector } from '../../shared/fxwallet/index.ts';

const connector = createWalletConnector({
  appName: 'My dApp',
  rpcUrls: { 3961: ['https://rpc.ferminux.net'] },
  walletConnect: import.meta.env.VITE_WC_PROJECT_ID
    ? { projectId: import.meta.env.VITE_WC_PROJECT_ID, load: () => import('@walletconnect/ethereum-provider') }
    : null,
});

connector.choices();          // Ferminux Wallet, then injected wallets (EIP-6963), then WalletConnect
await connector.connect(id);  // call it from the click: the wallet window must open inside it
await connector.restore();    // on load: reconnect to the remembered wallet without a prompt
```

A dApp that only wants the provider uses `createFerminuxWalletProvider()` (EIP-1193, with
`isFerminuxWallet: true`) and `announceFerminuxWallet(provider)` (EIP-6963, rdns
`net.ferminux.wallet`).

A dApp outside this repo needs no build step: `<script src="https://wallet.ferminux.net/fxwallet.js" async></script>`
announces the same provider under EIP-6963, so wagmi, RainbowKit, AppKit and other EIP-6963
pickers list Ferminux Wallet. `embed.ts` is its source; `node shared/fxwallet/build-embed.mjs`
rebuilds `wallet-web/public/fxwallet.js`, and `wallet-web/scripts/embed-check.mjs` tests it on a
page of another origin.

## How it works

| Request | Where it goes |
|---|---|
| `eth_requestAccounts`, `personal_sign`, `eth_signTypedData_v4`, `eth_sendTransaction`, `wallet_watchAsset` | the wallet window (`connect.html`): a popup, a new tab on phones |
| `eth_accounts`, `eth_chainId`, `wallet_switchEthereumChain`, `wallet_addEthereumChain` | answered by the provider from the remembered session; switching is limited to 3961 and the seven pay-in chains |
| `eth_call`, `eth_getBalance`, `eth_estimateGas`, `eth_getLogs`, … | straight to the chain's RPC (`rpcUrls`), never the window |
| anything else | `4200` |

- **Origins.** The window is opened with the dApp's origin in its hash, says `ready` to its
  opener with that origin as `targetOrigin` (the browser drops it otherwise), and accepts
  requests only from `window.opener` with `event.origin` equal to it. It answers with the
  requester's exact origin as `targetOrigin`. The dApp accepts messages only from the wallet
  origin and the window it opened.
- **Approval.** Connecting stores the site in the wallet's *Connected sites* list; every other
  request from a site that is not on it, or for an account it was not given, gets `4100`.
- **Chains.** The chain travels with every request, is shown in the window, and is signed into
  the transaction; the wallet uses its own RPCs for it, never the dApp's.
- **Keys.** The vault is decrypted in the window's memory only when a request needs a key; the
  window closes itself two seconds after its last answer (a follow-up request in that time
  reuses it).
- **Blocked pop-up.** The page shows "Open Ferminux Wallet"; that click opens the window and the
  request continues. Cancel is `4001`, as is closing the window.
- **Reconnect and revoke.** The session is remembered in the dApp's `localStorage`. A dApp on
  the wallet's own site (every `*.ferminux.net` app) also keeps a hidden status frame of
  `connect.html#fxw-frame`: a revoke in the wallet disconnects it at once, and "Disconnect" in
  the dApp removes it from the wallet through the frame. Elsewhere the frame cannot see the
  wallet's storage (browsers partition it) and the wallet's CSP (`frame-ancestors`) refuses to be
  framed there, so a revoke shows up as `4100` on the next request, and "Disconnect" sends
  `wallet_revokePermissions` through the wallet window instead: it
  removes the requesting origin (never anything named in a parameter), answers and closes.
  `disconnect()` opens that window synchronously, so call it from the click.
- **One wallet, two origins.** The same build is served at `https://wallet.ferminux.net` and
  `https://ferminux.net/wallet/`, and a browser keeps a vault at the origin where it was
  created. The provider accepts the window from both (exact origins, and only the window it
  opened). A window with no vault offers "My wallet is at …", which moves that same window to
  the other origin's `connect.html` with the same parameters; it says `ready` from there and the
  provider re-sends its queue to that origin only. The origin that connected is remembered in
  the dApp's `localStorage` (`ferminux.fxwallet.wallet.v1|…`) and opens first next time. The
  session key is unchanged, so a dApp connected before keeps its session.

## WalletConnect and wallets that do not know Ferminux

MetaMask Mobile, Trust, OKX, Bitget, SafePal, Coinbase Wallet, Rainbow, Zerion and most other
phone wallets do not ship chain 3961. A wallet refuses a WalletConnect session outright when a
**required** chain is one it does not know, so the connector (`walletConnectInitOptions`) makes
every chain **optional** — 3961 first, then the seven pay-in chains — with an RPC for each in
`rpcMap`. The wallet approves the chains it has, and `ensureFerminuxChain` (`network.ts`) then:

1. asks it to switch to 3961 (`wallet_switchEthereumChain`);
2. on 4902, `-32603 Unrecognized chain`, "not approved" or no switch method at all, adds the
   network (`wallet_addEthereumChain` with `FERMINUX_ADD_CHAIN_PARAMS`: chainName `Ferminux`,
   FMX 18 decimals, `https://rpc.ferminux.net`, `https://explorer.ferminux.net`, the brand icon
   on ferminux.net) and asks to switch again if the wallet added without switching;
3. over WalletConnect, waits until the session names 3961 (the wallet's `session_update`): the
   WalletConnect client refuses a request on a chain the session does not name, so "switched"
   alone is not enough. If it never does, the provider is put back on a session chain.

Every other ending is a `ChainSetupError` whose message says what to do — `rejected` and
`unsupported` carry the network details to add by hand (`manualNetworkText()`), `session`
says to reconnect (the wallet now knows Ferminux and includes it). The DEX, launchpad and
staking run it right after a WalletConnect connection; ferminux.net runs it in `connect()`.

The connector also ignores the transient `accountsChanged([])` and `chainChanged` that the
WalletConnect provider emits while its chain has no account in the session yet; a real end of
the session arrives as `disconnect`.

The WalletConnect modal opens with MetaMask, Trust, OKX, Binance, Bitget, SafePal, Coinbase,
Rainbow and Zerion first (`FEATURED_WALLETCONNECT_WALLETS`, Explorer ids); on a phone it is
full screen and each row deep-links into the app (`metamask://wc?uri=…`, `trust://wc?uri=…`).
In the dApps' own chooser Ferminux Wallet is first and marked `featured`.

`wallet-web/scripts/wc-dapp-wallets.mjs` drives a dApp build against scripted WalletKit wallets
over the real relay: one that must add the network, one whose `chainChanged` arrives before its
session update, one that already has Ferminux, one that never updates the session, one that
cannot add networks, and one whose user declines.

## Build settings in the dApps

| Variable | Effect |
|---|---|
| `VITE_WC_PROJECT_ID` | Adds WalletConnect to the choice. Without it the package is not bundled and no relay is contacted; `scripts/check-dist.mjs` allows the WalletConnect hosts only when it is set. |
| `VITE_FXWALLET_URL` | The wallet's `connect.html`, for test builds against a local wallet; comma-separate two to test the two-origin hand-off (the wallet build then needs the same pair in `VITE_WALLET_CONNECT_URLS`). Defaults to both official origins, `https://wallet.ferminux.net/connect.html` first. |

## Tests

```bash
node --test shared/fxwallet/test/*.test.mjs   # provider, protocol, chains, icon, network (add/switch)
cd wallet-web && npm test               # includes tests/connect.test.mjs (the wallet side)
```

`icon.ts` is generated from `brand/dist/favicon.svg` by `node shared/fxwallet/gen-icon.mjs`.
