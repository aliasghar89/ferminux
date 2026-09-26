// Ferminux Wallet for any dApp, with one script tag:
//
//   <script src="https://wallet.ferminux.net/fxwallet.js" async></script>
//
// It announces the wallet under EIP-6963 (name "Ferminux Wallet", rdns
// net.ferminux.wallet, the brand mark inline), so the wallet pickers built on
// EIP-6963 — wagmi, RainbowKit, Reown AppKit, ConnectKit, Web3-Onboard — list
// it beside the installed extensions, and choosing it connects through the
// wallet window: nothing to install. It never touches window.ethereum.
//
// The wallet is the one that served this file: connect.html next to it (the
// official copy also brings the wallet's other official origin). Reads go to
// the public RPCs of the eight chains the wallet signs for; every signature
// and transaction is confirmed in the wallet window, which shows this page's
// verified origin.
//
// Built into wallet-web/public/fxwallet.js by build-embed.mjs.

import { CHAIN_RPC_URLS } from './chains.ts';
import { announceFerminuxWallet, createFerminuxWalletProvider } from './provider.ts';

/** connect.html beside this script, or undefined (the official origins) when it cannot be told. */
function walletUrlFromScript(): string | undefined {
  const script = document.currentScript as HTMLScriptElement | null;
  if (!script?.src) return undefined;
  try {
    const u = new URL('connect.html', script.src);
    return u.protocol === 'https:' || u.hostname === 'localhost' || u.hostname === '127.0.0.1' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

const w = window as unknown as { ferminuxWallet?: unknown };
if (!w.ferminuxWallet) {
  const provider = createFerminuxWalletProvider({
    walletUrl: walletUrlFromScript(),
    rpcUrls: CHAIN_RPC_URLS,
    appName: (document.title || location.host).slice(0, 60),
    theme: typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  });
  // One provider per page, reachable for dApps that do not use EIP-6963.
  Object.defineProperty(window, 'ferminuxWallet', { value: provider, enumerable: false, configurable: false, writable: false });
  announceFerminuxWallet(provider);
}
