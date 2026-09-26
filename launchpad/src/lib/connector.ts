// The launchpad's wallet choice: Ferminux Wallet (the web wallet, no
// extension) first, then every injected wallet, then WalletConnect only when
// the build has VITE_WC_PROJECT_ID — without it the package is not bundled
// and nothing contacts the WalletConnect relay.

import { createWalletConnector } from "../../../shared/fxwallet/connector.ts";
import { RPC_URLS } from "../config.ts";

const WC_PROJECT_ID: string = import.meta.env.VITE_WC_PROJECT_ID ?? "";

export const connector = createWalletConnector({
  appName: "Ferminux Launchpad",
  // Override only to test against a local wallet build.
  walletUrl: import.meta.env.VITE_FXWALLET_URL || undefined,
  rpcUrls: { 3961: RPC_URLS },
  theme: "light",
  walletConnect: WC_PROJECT_ID
    ? {
        projectId: WC_PROJECT_ID,
        load: () => import("@walletconnect/ethereum-provider"),
        rpcMap: { 3961: RPC_URLS[0]! },
        metadata: {
          name: "Ferminux Launchpad",
          description: "Launch an FRC-20 token on Ferminux Network",
          url: window.location.origin,
          icons: [],
        },
      }
    : null,
});
