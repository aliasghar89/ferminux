// Connect with Ferminux Wallet — public entry point for dApps.
//
//   import { createWalletConnector } from '../../shared/fxwallet/index.ts';
//
// See provider.ts for the protocol and connector.ts for the wallet picker model.

export {
  DEFAULT_WALLET_URL,
  FERMINUX_WALLET_NAME,
  FERMINUX_WALLET_RDNS,
  announceFerminuxWallet,
  createFerminuxWalletProvider,
  isPhoneLike,
  type FerminuxWalletProvider,
  type FerminuxWalletProviderOptions,
  type RequestArguments,
} from './provider.ts';
export {
  FEATURED_WALLETCONNECT_WALLETS,
  FERMINUX_APP_ICON_URL,
  createWalletConnector,
  safeIcon,
  walletConnectInitOptions,
  type Connection,
  type ConnectorOptions,
  type Eip1193Provider,
  type WalletChoice,
  type WalletConnectModule,
  type WalletConnectOptions,
  type WalletConnector,
  type WalletKind,
} from './connector.ts';
export { ERR, ProviderRpcError } from './errors.ts';
export {
  ChainSetupError,
  FERMINUX_ADD_CHAIN_PARAMS,
  FERMINUX_EXPLORER_URL,
  FERMINUX_ICON_URLS,
  FERMINUX_NETWORK_DETAILS,
  FERMINUX_RPC_URL,
  ensureFerminuxChain,
  isPendingRequest,
  isUserRejection,
  manualNetworkText,
  sessionHasChain,
  type ChainSetupReason,
  type ChainSetupStep,
  type EnsureChainOptions,
} from './network.ts';
export { CHAIN_META, FERMINUX_CHAIN_ID, KNOWN_CHAIN_IDS, chainName, isKnownChain, parseChainId, toHexChainId } from './chains.ts';
export { FERMINUX_WALLET_ICON } from './icon.ts';
