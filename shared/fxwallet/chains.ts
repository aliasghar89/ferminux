// The chains Ferminux Wallet can sign for: Ferminux Network (3961) and the
// seven EVM chains the pay-in desk accepts (agents/gateway/src/v3/payin.ts).
//
// Two exports on purpose. CHAIN_META carries no URLs, so a dApp that imports
// the provider ships only the chain ids and names; CHAIN_RPC_URLS is imported
// by the wallet page itself (it must reach every chain it signs for) and by a
// dApp that reads a foreign chain on purpose (the pay-in page). Rollup drops
// the unused export, so the DEX, staking and launchpad bundles never carry a
// foreign RPC host.
//
// Pure data: no browser globals, importable from Node tests.

export const FERMINUX_CHAIN_ID = 3961;

export interface ChainMeta {
  chainId: number;
  name: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
}

export const CHAIN_META: Readonly<Record<number, ChainMeta>> = {
  3961: { chainId: 3961, name: 'Ferminux Network', nativeCurrency: { name: 'Ferminux', symbol: 'FMX', decimals: 18 } },
  1: { chainId: 1, name: 'Ethereum', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } },
  56: { chainId: 56, name: 'BNB Smart Chain', nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 } },
  8453: { chainId: 8453, name: 'Base', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } },
  42161: { chainId: 42161, name: 'Arbitrum One', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } },
  137: { chainId: 137, name: 'Polygon', nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 } },
  10: { chainId: 10, name: 'Optimism', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } },
  43114: { chainId: 43114, name: 'Avalanche C-Chain', nativeCurrency: { name: 'Avalanche', symbol: 'AVAX', decimals: 18 } },
};

/** Every chain id the wallet will switch to or sign for, Ferminux first. */
export const KNOWN_CHAIN_IDS: readonly number[] = [3961, 1, 56, 8453, 42161, 137, 10, 43114];

/**
 * Public JSON-RPC endpoints, in order of preference. Each was checked on
 * 2026-09-25 to answer eth_chainId with the right id and to send CORS headers
 * a browser page can use. Two endpoints the pay-in page used to list no longer
 * answer (eth.llamarpc.com returns 525, polygon-rpc.com returns "tenant
 * disabled"), so neither is here.
 */
export const CHAIN_RPC_URLS: Readonly<Record<number, readonly string[]>> = {
  3961: ['https://rpc.ferminux.net', 'https://ferminux.net/rpc'],
  1: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'],
  56: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-rpc.publicnode.com'],
  8453: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
  42161: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'],
  137: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.drpc.org'],
  10: ['https://mainnet.optimism.io', 'https://optimism-rpc.publicnode.com'],
  43114: ['https://api.avax.network/ext/bc/C/rpc', 'https://avalanche-c-chain-rpc.publicnode.com'],
};

export function isKnownChain(chainId: number): boolean {
  return KNOWN_CHAIN_IDS.includes(chainId);
}

export function chainName(chainId: number): string {
  return CHAIN_META[chainId]?.name ?? `Chain ${chainId}`;
}

export function nativeSymbol(chainId: number): string {
  return CHAIN_META[chainId]?.nativeCurrency.symbol ?? 'native coin';
}

export function toHexChainId(chainId: number): string {
  return '0x' + chainId.toString(16);
}

/**
 * Parse a chain id as wallets receive it: EIP-695 says a 0x-hex string, but
 * dApps also send decimal strings and plain numbers. Returns null for anything
 * that is not a positive safe integer.
 */
export function parseChainId(value: unknown): number | null {
  let n: number;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value.trim())) n = Number.parseInt(value.trim(), 16);
  else if (typeof value === 'string' && /^\d+$/.test(value.trim())) n = Number(value.trim());
  else return null;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
