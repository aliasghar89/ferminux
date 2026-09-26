// The networks this wallet holds assets on.
// No browser globals — runs under Node for the unit/e2e suites.
//
// Ferminux (3961) is the home chain. The seven others are exactly the EVM
// chains the network already accepts pay-ins on: the chain ids, explorers,
// native coins and USDC/USDT contracts below are the ones declared in
// agents/gateway/src/v3/payin.ts (PAYIN_CHAINS), and tests/chains.test.mjs
// reads that file and fails if the two lists ever disagree. They are restated
// here rather than imported because the gateway module pulls in server-only
// code (fastify, node:crypto, its database).
//
// One key, one address: an account derived at m/44'/60'/0'/0/N (or imported)
// is the same 0x… address on every chain listed here.
//
// RPC endpoints are public, keyless and CORS-enabled (checked 2026-09-25);
// each chain has an ordered fallback and every URL can be overridden at build
// time with VITE_RPC_<KEY> (comma-separated), which is how the test build
// points a chain at a local anvil fork.

import { CHAIN_ID, DEFAULT_TOKENS, EXPLORER_URL, NATIVE_DECIMALS, NATIVE_SYMBOL, RPC_URLS } from '../config.ts';

const env: Record<string, string | undefined> =
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

/** Canonical Multicall3 deployment (same address on every chain that has it). */
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

export interface ChainToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
}

export interface ChainDef {
  id: number;
  /** Short stable key; matches the pay-in slugs (eth, bsc, …) for the foreign chains. */
  key: string;
  name: string;
  /** Compact label for badges and narrow layouts. */
  short: string;
  native: { symbol: string; name: string; decimals: number };
  /** Ordered fallback list. */
  rpcUrls: string[];
  explorer: { url: string; name: string };
  /** Multicall3 is deployed at MULTICALL3_ADDRESS (it is NOT on Ferminux). */
  multicall3: boolean;
  /**
   * OP-stack chain: every transaction also pays an L1 data fee on top of
   * gas × price, read from the GasPriceOracle predeploy.
   */
  opStackL1Fee: boolean;
  /**
   * The least tip worth signing here: a node that suggests less (Ethereum's
   * often says 0) is raised to it, so the transaction is picked up instead of
   * sitting in the mempool. Absent = take the node's answer as it is.
   */
  minTipWei?: bigint;
  /** Tokens shown on this chain out of the box. */
  tokens: ChainToken[];
}

function list(raw: string | undefined, fallback: string[]): string[] {
  if (!raw) return fallback;
  const items = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return items.length > 0 ? items : fallback;
}

function stables(usdc: string, usdt: string, decimals: number): ChainToken[] {
  return [
    { address: usdc, symbol: 'USDC', name: 'USD Coin', decimals },
    { address: usdt, symbol: 'USDT', name: 'Tether USD', decimals },
  ];
}

export const FERMINUX_CHAIN: ChainDef = {
  id: CHAIN_ID,
  key: 'ferminux',
  name: 'Ferminux',
  short: 'FMX',
  native: { symbol: NATIVE_SYMBOL, name: 'Ferminux', decimals: NATIVE_DECIMALS },
  rpcUrls: RPC_URLS,
  explorer: { url: EXPLORER_URL, name: 'Ferminux Explorer' },
  multicall3: false,
  opStackL1Fee: false,
  tokens: DEFAULT_TOKENS.map((t) => ({ ...t })),
};

/** The seven pay-in chains, in the order payin.ts declares them. */
export const FOREIGN_CHAINS: ChainDef[] = [
  {
    id: 1,
    key: 'eth',
    name: 'Ethereum',
    short: 'ETH',
    native: { symbol: 'ETH', name: 'Ether', decimals: 18 },
    rpcUrls: list(env.VITE_RPC_ETH, ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org']),
    explorer: { url: 'https://etherscan.io', name: 'Etherscan' },
    multicall3: true,
    opStackL1Fee: false,
    // 0.05 gwei: a zero tip on mainnet is rarely included; this adds ~0.000001 ETH to a transfer
    minTipWei: 50_000_000n,
    tokens: stables('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', '0xdAC17F958D2ee523a2206206994597C13D831ec7', 6),
  },
  {
    id: 56,
    key: 'bsc',
    name: 'BNB Smart Chain',
    short: 'BSC',
    native: { symbol: 'BNB', name: 'BNB', decimals: 18 },
    rpcUrls: list(env.VITE_RPC_BSC, ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org']),
    explorer: { url: 'https://bscscan.com', name: 'BscScan' },
    multicall3: true,
    opStackL1Fee: false,
    // BSC's pegged stablecoins use 18 decimals, not 6.
    tokens: stables('0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', '0x55d398326f99059fF775485246999027B3197955', 18),
  },
  {
    id: 8453,
    key: 'base',
    name: 'Base',
    short: 'BASE',
    native: { symbol: 'ETH', name: 'Ether', decimals: 18 },
    rpcUrls: list(env.VITE_RPC_BASE, ['https://base-rpc.publicnode.com', 'https://mainnet.base.org']),
    explorer: { url: 'https://basescan.org', name: 'BaseScan' },
    multicall3: true,
    opStackL1Fee: true,
    tokens: stables('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', 6),
  },
  {
    id: 42161,
    key: 'arbitrum',
    name: 'Arbitrum One',
    short: 'ARB',
    native: { symbol: 'ETH', name: 'Ether', decimals: 18 },
    rpcUrls: list(env.VITE_RPC_ARBITRUM, ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc']),
    explorer: { url: 'https://arbiscan.io', name: 'Arbiscan' },
    multicall3: true,
    opStackL1Fee: false,
    tokens: stables('0xaf88d065e77c8cC2239327C5EDb3A432268e5831', '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', 6),
  },
  {
    id: 137,
    key: 'polygon',
    name: 'Polygon',
    short: 'POL',
    native: { symbol: 'POL', name: 'Polygon', decimals: 18 },
    rpcUrls: list(env.VITE_RPC_POLYGON, ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.drpc.org']),
    explorer: { url: 'https://polygonscan.com', name: 'PolygonScan' },
    multicall3: true,
    opStackL1Fee: false,
    tokens: stables('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', 6),
  },
  {
    id: 10,
    key: 'optimism',
    name: 'Optimism',
    short: 'OP',
    native: { symbol: 'ETH', name: 'Ether', decimals: 18 },
    rpcUrls: list(env.VITE_RPC_OPTIMISM, ['https://optimism-rpc.publicnode.com', 'https://mainnet.optimism.io']),
    explorer: { url: 'https://optimistic.etherscan.io', name: 'OP Etherscan' },
    multicall3: true,
    opStackL1Fee: true,
    tokens: stables('0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', 6),
  },
  {
    id: 43114,
    key: 'avalanche',
    name: 'Avalanche C-Chain',
    short: 'AVAX',
    native: { symbol: 'AVAX', name: 'Avalanche', decimals: 18 },
    rpcUrls: list(env.VITE_RPC_AVALANCHE, [
      'https://avalanche-c-chain-rpc.publicnode.com',
      'https://api.avax.network/ext/bc/C/rpc',
    ]),
    explorer: { url: 'https://snowtrace.io', name: 'Snowtrace' },
    multicall3: true,
    opStackL1Fee: false,
    tokens: stables('0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', 6),
  },
];

/** Every supported chain, home chain first. */
export const CHAINS: ChainDef[] = [FERMINUX_CHAIN, ...FOREIGN_CHAINS];

export function chainById(id: number): ChainDef | undefined {
  return CHAINS.find((c) => c.id === id);
}

export function isSupportedChain(id: number): boolean {
  return chainById(id) !== undefined;
}

/** "BNB Smart Chain (56)" — for confirm screens and errors. */
export function chainLabel(id: number): string {
  const c = chainById(id);
  return c ? `${c.name} (${c.id})` : `chain ${id}`;
}

/** Human list: "Ferminux, Ethereum, …, Optimism and Avalanche C-Chain". */
export function chainNamesSentence(chains: ChainDef[] = CHAINS): string {
  const names = chains.map((c) => c.name);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function explorerTxUrl(chain: ChainDef, hash: string): string {
  return `${chain.explorer.url}/tx/${hash}`;
}

export function explorerAddressUrl(chain: ChainDef, address: string): string {
  return `${chain.explorer.url}/address/${address}`;
}

export function explorerTokenUrl(chain: ChainDef, address: string): string {
  return `${chain.explorer.url}/token/${address}`;
}

/** CAIP-2 id used by WalletConnect: eip155:<chainId>. */
export function caip2(id: number): string {
  return `eip155:${id}`;
}

/** Parse "eip155:56" → 56; anything else → null. */
export function parseCaip2(value: string): number | null {
  const m = /^eip155:(\d{1,12})$/.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
