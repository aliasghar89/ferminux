/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_REGISTRY?: string;
  readonly VITE_ESCROW?: string;
  readonly VITE_NFT?: string;
  readonly VITE_CITIZENS?: string;
  readonly VITE_GATEWAY?: string;
  readonly VITE_RPC?: string;
  readonly VITE_MOCK?: string;
  /** WalletConnect project id; the WalletConnect option exists only when set. */
  readonly VITE_WC_PROJECT_ID?: string;
  /** Test builds only: the Ferminux Wallet connect page to open instead of wallet.ferminux.net. */
  readonly VITE_FXWALLET_URL?: string;
}
interface Window { ethereum?: any }
