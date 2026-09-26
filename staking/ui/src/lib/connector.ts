// Staking's wallet choice: Ferminux Wallet (the web wallet, no extension)
// first, then every injected wallet, then WalletConnect only when the build
// has VITE_WC_PROJECT_ID — without it the package is not bundled at all and
// scripts/check-dist.mjs keeps the page self-hosted. The session-key import
// (ConnectModal) stays alongside for people who hold a keystore file.

import { createWalletConnector } from '../../../../shared/fxwallet/connector.ts';
import { RPC_URLS } from '../config.ts';

const WC_PROJECT_ID: string = import.meta.env.VITE_WC_PROJECT_ID ?? '';

export const connector = createWalletConnector({
  appName: 'Ferminux Staking',
  // Override only to test against a local wallet build.
  walletUrl: import.meta.env.VITE_FXWALLET_URL || undefined,
  rpcUrls: { 3961: RPC_URLS },
  theme: 'dark',
  walletConnect: WC_PROJECT_ID
    ? {
        projectId: WC_PROJECT_ID,
        load: () => import('@walletconnect/ethereum-provider'),
        rpcMap: { 3961: RPC_URLS[0]! },
        metadata: {
          name: 'Ferminux Staking',
          description: 'Stake FMX on Ferminux Network',
          url: window.location.origin,
          icons: [],
        },
      }
    : null,
});
