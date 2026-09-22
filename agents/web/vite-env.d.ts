/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_REGISTRY?: string;
  readonly VITE_ESCROW?: string;
  readonly VITE_NFT?: string;
  readonly VITE_GATEWAY?: string;
  readonly VITE_RPC?: string;
  readonly VITE_MOCK?: string;
}
interface Window { ethereum?: any }
