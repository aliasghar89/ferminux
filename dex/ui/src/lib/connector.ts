// The DEX's wallet choice: Ferminux Wallet (the web wallet, no extension)
// first, then every injected wallet the browser has, then WalletConnect —
// only when this build was given a project id (VITE_WC_PROJECT_ID). Without
// one, the WalletConnect package is never bundled and no relay is contacted,
// so the self-hosted rule (scripts/check-dist.mjs) holds for the default build.

import { createWalletConnector } from '../../../../shared/fxwallet/connector.ts';
import { RPC_URLS } from '../config.ts';
import { BSC } from './bridgeChains.ts';

const WC_PROJECT_ID: string = import.meta.env.VITE_WC_PROJECT_ID ?? '';

export const connector = createWalletConnector({
  appName: 'Ferminux DEX',
  // Override only to test against a local wallet build.
  walletUrl: import.meta.env.VITE_FXWALLET_URL || undefined,
  // BSC for the bridge panel's return leg; everything else reads Ferminux.
  rpcUrls: { 3961: RPC_URLS, 56: BSC.rpcUrls },
  theme: 'light',
  walletConnect: WC_PROJECT_ID
    ? {
        projectId: WC_PROJECT_ID,
        load: () => import('@walletconnect/ethereum-provider'),
        rpcMap: { 3961: RPC_URLS[0]! },
        metadata: {
          name: 'Ferminux DEX',
          description: 'Swap, liquidity and pools on Ferminux Network',
          url: window.location.origin,
          icons: [],
        },
      }
    : null,
});
