import { deployments } from "./deployments.generated";

const ZERO = "0x0000000000000000000000000000000000000000";
const isAddr = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const env = import.meta.env;

export const config = {
  chainId: 3961,
  chainIdHex: "0xf79",
  chainName: "Ferminux Network",
  rpc: env.VITE_RPC || "https://rpc.ferminux.net",
  ws: "wss://rpc.ferminux.net/ws",
  explorer: "https://explorer.ferminux.net",
  gateway: (env.VITE_GATEWAY || "/api").replace(/\/$/, ""),
  registry: isAddr(env.VITE_REGISTRY) ? env.VITE_REGISTRY : deployments.registry,
  escrow: isAddr(env.VITE_ESCROW) ? env.VITE_ESCROW : deployments.escrow,
  deployBlock: deployments.deployBlock,
  // Ferminux Agents (FRC-721, symbol FMXA): 41 one-of-one ids, mint(tokenId) payable at exactly price().
  nft: isAddr(env.VITE_NFT) ? env.VITE_NFT : deployments.nft,
  nftDeployBlock: deployments.nftDeployBlock,
  v3DeployBlock: deployments.v3DeployBlock,
  nftBase: "https://ferminux.net/nft/agents",
  nftSupply: 41,
  faucet: "0xf4dE70068031DA17347cd19aCaa841013751B3c0",
  governance: "0x910BD467D8576277f8f96DF47428377FFD94fEfe",
  treasury: "0xc0A5Eb613f859f072554F29f1Ab7400265af15aB",
  feeBps: 250,
  deliveryWindowSec: 86400,
  reviewWindowSec: 86400,
  bondCooldownSec: 7 * 86400,
  mock: env.VITE_MOCK === "1",

  // Addendum v3 — Agent Economy. Zero address until the contracts lane deploys (deployments.3961.json).
  x402Vault: isAddr(env.VITE_X402_VAULT) ? env.VITE_X402_VAULT : deployments.x402Vault,
  accountFactory: isAddr(env.VITE_ACCOUNT_FACTORY) ? env.VITE_ACCOUNT_FACTORY : deployments.accountFactory,
  accountImpl: isAddr(env.VITE_ACCOUNT_IMPL) ? env.VITE_ACCOUNT_IMPL : deployments.accountImpl,
  streamPay: isAddr(env.VITE_STREAM_PAY) ? env.VITE_STREAM_PAY : deployments.streamPay,
  arbiterPool: isAddr(env.VITE_ARBITER_POOL) ? env.VITE_ARBITER_POOL : deployments.arbiterPool,
  identity8004: isAddr(env.VITE_IDENTITY_8004) ? env.VITE_IDENTITY_8004 : deployments.identity8004,
  reputation8004: isAddr(env.VITE_REPUTATION_8004) ? env.VITE_REPUTATION_8004 : deployments.reputation8004,
  validation8004: isAddr(env.VITE_VALIDATION_8004) ? env.VITE_VALIDATION_8004 : deployments.validation8004,
  tokenFactory: isAddr(env.VITE_TOKEN_FACTORY) ? env.VITE_TOKEN_FACTORY : deployments.tokenFactory,
  x402FeeBps: 100,
  streamFeeBps: 100,
  x402UnlockSec: 3600,
  memoryFreeQuotaBytes: 5 * 1024 * 1024,
  minArbiterStake: "500000000000000000000", // 500 FMX
  arbiterVotingWindowSec: 3 * 86400,
} as const;

export const contractsDeployed = config.registry !== ZERO && config.escrow !== ZERO;
export const nftDeployed = config.nft !== ZERO;
export const vaultDeployed = config.x402Vault !== ZERO;
export const accountsDeployed = config.accountFactory !== ZERO;
export const streamsDeployed = config.streamPay !== ZERO;
export const arbiterDeployed = config.arbiterPool !== ZERO;
export const identity8004Deployed = config.identity8004 !== ZERO;
export const reputation8004Deployed = config.reputation8004 !== ZERO;
export const validation8004Deployed = config.validation8004 !== ZERO;
export const tokenFactoryDeployed = config.tokenFactory !== ZERO;

export const CHAIN_PARAMS = {
  chainId: config.chainIdHex,
  chainName: config.chainName,
  rpcUrls: ["https://rpc.ferminux.net"],
  nativeCurrency: { name: "FMX", symbol: "FMX", decimals: 18 },
  blockExplorerUrls: [config.explorer],
};

/** EIP-3085 params for the 7 pay-in chains (wallet_addEthereumChain fallback when the wallet does not know them). */
export interface AddChainParams { chainId: string; chainName: string; rpcUrls: string[]; nativeCurrency: { name: string; symbol: string; decimals: number }; blockExplorerUrls: string[] }
export const PAYIN_CHAIN_PARAMS: Record<number, AddChainParams> = {
  1: { chainId: "0x1", chainName: "Ethereum", rpcUrls: ["https://eth.llamarpc.com"], nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, blockExplorerUrls: ["https://etherscan.io"] },
  56: { chainId: "0x38", chainName: "BNB Smart Chain", rpcUrls: ["https://bsc-dataseed.binance.org"], nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 }, blockExplorerUrls: ["https://bscscan.com"] },
  8453: { chainId: "0x2105", chainName: "Base", rpcUrls: ["https://mainnet.base.org"], nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, blockExplorerUrls: ["https://basescan.org"] },
  42161: { chainId: "0xa4b1", chainName: "Arbitrum One", rpcUrls: ["https://arb1.arbitrum.io/rpc"], nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, blockExplorerUrls: ["https://arbiscan.io"] },
  137: { chainId: "0x89", chainName: "Polygon", rpcUrls: ["https://polygon-rpc.com"], nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 }, blockExplorerUrls: ["https://polygonscan.com"] },
  10: { chainId: "0xa", chainName: "Optimism", rpcUrls: ["https://mainnet.optimism.io"], nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, blockExplorerUrls: ["https://optimistic.etherscan.io"] },
  43114: { chainId: "0xa86a", chainName: "Avalanche C-Chain", rpcUrls: ["https://api.avax.network/ext/bc/C/rpc"], nativeCurrency: { name: "Avalanche", symbol: "AVAX", decimals: 18 }, blockExplorerUrls: ["https://snowtrace.io"] },
};

export const explorerTx = (hash: string) => `${config.explorer}/tx/${hash}`;
export const explorerAddr = (addr: string) => `${config.explorer}/address/${addr}`;
