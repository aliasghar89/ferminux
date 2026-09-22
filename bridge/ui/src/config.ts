// Ferminux Bridge — chain registry and app configuration.
//
// Every value can be overridden at build time with VITE_* environment
// variables (see README). This module must stay importable under plain Node
// (no browser globals): the unit tests, the e2e suite and scripts/check-dist.mjs
// all import it directly, so the allowlist of external hosts can never drift
// from what the app actually dials.

const env: Record<string, string | undefined> =
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

function list(raw: string | undefined, fallback: string[]): string[] {
  if (!raw) return fallback;
  const items = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return items.length > 0 ? items : fallback;
}

/**
 * VITE_BRIDGE_<KEY>, then VITE_BRIDGE_<CHAINID>, then the deployed address for
 * that chain.
 *
 * THE DEFAULT USED TO BE '' AND THAT SHIPPED A DEAD APP. `.env.*` is gitignored,
 * so the only place these addresses could live was an untracked file on whoever
 * built last. The bundle served at ferminux.net/bridge/ contained no address
 * literal at all: isChainLive() failed for every chain, liveChains() came back
 * empty, defaultRoute() returned null below two chains, and the page rendered an
 * empty shell — silently, because a chain with no address is indistinguishable
 * from one that is not deployed yet.
 *
 * A deployed address is public information and belongs in tracked source, where
 * a build cannot lose it and a reviewer can see it change. Env still wins, for
 * devnets and rehearsals. Chains with no deployment keep '' and stay dark, which
 * is now a statement rather than an accident.
 */
const DEPLOYED: Record<string, string> = {
  ferminux: '0xe162eeDa683f067d4Ebf61060Fa322332a779EF4',
  bsc: '0xe43951a0E421A6B3Cb9C6ae66273dc0D3c8a70ff',
  // ethereum / polygon / arbitrum / base: not deployed. See bridge/docs/ETH-ROUTE.md.
};

function envBridge(key: string, chainId: number): string {
  return (
    env[`VITE_BRIDGE_${key.toUpperCase()}`] ??
    env[`VITE_BRIDGE_${chainId}`] ??
    DEPLOYED[key] ??
    ''
  ).trim();
}

/**
 * Source confirmations each chain must accumulate before a validator will sign.
 *
 * These are the relayer's numbers, not the UI's: they are copied from
 * relayer/config/chains.example.json, and the relayer is authoritative — it
 * re-reads the log at its own configured depth and will not attest a moment
 * sooner, whatever this app displays. Keeping the table here, in one place,
 * means the app cannot quietly tell a user their transfer is "executing" while
 * every validator is still waiting.
 *
 * Ferminux is the deepest wait in the set and that is deliberate: Ethash PoW,
 * ~7s blocks, no finality gadget, and small hashrate. 64 blocks is ~7.5 min.
 * It was 12 here, which told users their transfer had settled roughly six times
 * sooner than any validator would sign it.
 */
export const RELAYER_CONFIRMATIONS: Record<string, number> = {
  ferminux: 64,
  ethereum: 32,
  bsc: 20,
  polygon: 128,
  arbitrum: 300,
  base: 180,
};

/**
 * Used when a transfer record names a chain this build does not know about —
 * an old localStorage entry, or a chain that was removed. Deliberately the
 * deepest value in the table: guessing LOW would understate reorg risk, which
 * is the exact failure being fixed here.
 */
export const FALLBACK_CONFIRMATIONS = Math.max(...Object.values(RELAYER_CONFIRMATIONS));

function confirmations(key: string): number {
  const override = env[`VITE_CONFIRMATIONS_${key.toUpperCase()}`];
  const parsed = override === undefined ? Number.NaN : Number(override);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : (RELAYER_CONFIRMATIONS[key] ?? FALLBACK_CONFIRMATIONS);
}

export interface NativeCurrency {
  name: string;
  symbol: string;
  decimals: number;
}

export interface ChainConfig {
  /** Stable key — used in VITE_ overrides and in persisted transfer records. */
  key: string;
  chainId: number;
  /** 0x-prefixed chain id for wallet_switchEthereumChain / wallet_addEthereumChain. */
  chainIdHex: string;
  name: string;
  short: string;
  native: NativeCurrency;
  /** Ordered RPC fallback list; each is health-probed with eth_chainId before use. */
  rpcUrls: string[];
  explorerUrl: string;
  /**
   * FerminuxBridge deployment on this chain.
   * SHIPS EMPTY — set after deployment (VITE_BRIDGE_<KEY>). A chain with no
   * bridge address is rendered as "coming soon" and cannot be selected.
   */
  bridgeAddress: string;
  /** Confirmations a relayer waits on this chain before attesting a Sent event. */
  confirmations: number;
  /** Nominal block time in seconds — used only for the honest ETA estimate. */
  blockSeconds: number;
}

/**
 * Every chain the bridge can be deployed to. ONE FerminuxBridge contract, the
 * same bytecode, on each of them — the only per-chain difference is the token
 * registry, which this app reads from the chain rather than hardcoding.
 *
 * `rpcUrls` here IS an ordered failover list, and that is the difference between
 * this app and a validator: the app only reads, so the first endpoint that
 * answers `eth_chainId` with the right id wins (lib/rpc.ts). A validator's list
 * is a quorum instead — it re-reads every log from every provider and refuses to
 * sign unless enough independent ones agree — which is why the relayer rejects
 * an endpoint set this app is perfectly happy with.
 *
 * Every endpoint below answered with the expected chain id on 2026-08-20. Two
 * that used to be listed did not, and are gone: eth.llamarpc.com (HTTP 521) and
 * polygon-rpc.com (403, "API key disabled, tenant disabled"). A dead endpoint in
 * a failover list costs a probe timeout per page load; the same endpoint in the
 * relayer's list costs a witness.
 */
export const CHAINS: ChainConfig[] = [
  {
    key: 'ferminux',
    chainId: Number(env.VITE_CHAIN_ID_FERMINUX ?? 3961),
    chainIdHex: '0xf79',
    name: 'Ferminux Network',
    short: 'Ferminux',
    native: { name: 'Ferminux', symbol: 'FMX', decimals: 18 },
    rpcUrls: list(env.VITE_RPC_FERMINUX, ['https://rpc.ferminux.net', 'https://ferminux.net/rpc']),
    explorerUrl: (env.VITE_EXPLORER_FERMINUX ?? 'https://explorer.ferminux.net').replace(/\/+$/, ''),
    bridgeAddress: envBridge('ferminux', 3961),
    confirmations: confirmations('ferminux'),
    blockSeconds: 7,
  },
  {
    key: 'ethereum',
    chainId: 1,
    chainIdHex: '0x1',
    name: 'Ethereum',
    short: 'Ethereum',
    native: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: list(env.VITE_RPC_ETHEREUM, ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://cloudflare-eth.com']),
    explorerUrl: (env.VITE_EXPLORER_ETHEREUM ?? 'https://etherscan.io').replace(/\/+$/, ''),
    bridgeAddress: envBridge('ethereum', 1),
    confirmations: confirmations('ethereum'),
    blockSeconds: 12,
  },
  {
    key: 'bsc',
    chainId: 56,
    chainIdHex: '0x38',
    name: 'BNB Smart Chain',
    short: 'BSC',
    native: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    rpcUrls: list(env.VITE_RPC_BSC, ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org', 'https://1rpc.io/bnb']),
    explorerUrl: (env.VITE_EXPLORER_BSC ?? 'https://bscscan.com').replace(/\/+$/, ''),
    bridgeAddress: envBridge('bsc', 56),
    confirmations: confirmations('bsc'),
    blockSeconds: 3,
  },
  {
    key: 'polygon',
    chainId: 137,
    chainIdHex: '0x89',
    name: 'Polygon PoS',
    short: 'Polygon',
    native: { name: 'POL', symbol: 'POL', decimals: 18 },
    rpcUrls: list(env.VITE_RPC_POLYGON, ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.drpc.org', 'https://1rpc.io/matic']),
    explorerUrl: (env.VITE_EXPLORER_POLYGON ?? 'https://polygonscan.com').replace(/\/+$/, ''),
    bridgeAddress: envBridge('polygon', 137),
    confirmations: confirmations('polygon'),
    blockSeconds: 2,
  },
  {
    key: 'arbitrum',
    chainId: 42161,
    chainIdHex: '0xa4b1',
    name: 'Arbitrum One',
    short: 'Arbitrum',
    native: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: list(env.VITE_RPC_ARBITRUM, ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc', 'https://arbitrum.drpc.org']),
    explorerUrl: (env.VITE_EXPLORER_ARBITRUM ?? 'https://arbiscan.io').replace(/\/+$/, ''),
    bridgeAddress: envBridge('arbitrum', 42161),
    confirmations: confirmations('arbitrum'),
    blockSeconds: 1,
  },
  {
    key: 'base',
    chainId: 8453,
    chainIdHex: '0x2105',
    name: 'Base',
    short: 'Base',
    native: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: list(env.VITE_RPC_BASE, ['https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://base.drpc.org']),
    explorerUrl: (env.VITE_EXPLORER_BASE ?? 'https://basescan.org').replace(/\/+$/, ''),
    bridgeAddress: envBridge('base', 8453),
    confirmations: confirmations('base'),
    blockSeconds: 2,
  },
];

/** The chain this app is "about" — the default From side and the home network. */
export const HOME_CHAIN_KEY = 'ferminux';

export function chainByKey(key: string): ChainConfig | undefined {
  return CHAINS.find((c) => c.key === key);
}

export function chainById(chainId: number | bigint): ChainConfig | undefined {
  const id = Number(chainId);
  return CHAINS.find((c) => c.chainId === id);
}

/** A chain is live only once its bridge deployment address is configured. */
export function isChainLive(c: ChainConfig): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(c.bridgeAddress);
}

export function liveChains(): ChainConfig[] {
  return CHAINS.filter(isChainLive);
}

/** Seconds of validator + relayer latency assumed on top of block confirmations. */
export const RELAY_OVERHEAD_SECONDS = Number(env.VITE_RELAY_OVERHEAD_SECONDS ?? 90);

/** How often the app re-polls chain state (balances, caps, transfer status). */
export const POLL_MS = Number(env.VITE_POLL_MS ?? 12_000);

/**
 * Where this app reads the relayer's liveness report (block pace, DEGRADED
 * flag, checkpoint lag per chain) — the JSON shape of the relayer's GET /status.
 *
 * The relayer's /status is bearer-token protected and a browser page cannot
 * hold that secret, so the default is a SAME-ORIGIN relative path that the
 * operator serves next to the bundle: either an nginx `proxy_pass` to a
 * validator's /status with the token injected server-side, or a file refreshed
 * by cron. Relative by design: it adds no host, so scripts/check-dist.mjs has
 * nothing new to allow. An absolute override is allowed automatically, like an
 * RPC. When the document is unreachable, stale or malformed the app falls
 * back to the plain confirmation count — it never invents a reassurance.
 */
export const RELAYER_STATUS_URL = (env.VITE_RELAYER_STATUS_URL ?? './status.json').trim();

/** How often the liveness report is re-read. */
export const STATUS_POLL_MS = Number(env.VITE_STATUS_POLL_MS ?? 15_000);

/** localStorage key holding in-flight + historical transfers. */
export const STORAGE_KEY = 'ferminux.bridge.transfers.v1';

/** Where the risk notice sends people for the full security model. */
export const DOCS_URL = (env.VITE_DOCS_URL ?? 'https://ferminux.net/bridge/docs').replace(/\/+$/, '');

/** The bridge's hard-coded fee ceiling (MAX_FEE_BPS in FerminuxBridge.sol). */
export const MAX_FEE_BPS = 100;

/** Rolling volume window enforced by the contract (WINDOW = 24 hours). */
export const CAP_WINDOW_SECONDS = 24 * 60 * 60;

export function explorerTxUrl(chain: ChainConfig, hash: string): string {
  return `${chain.explorerUrl}/tx/${hash}`;
}

export function explorerAddressUrl(chain: ChainConfig, address: string): string {
  return `${chain.explorerUrl}/address/${address}`;
}

/** Params for wallet_addEthereumChain when a wallet does not know a chain yet. */
export function addChainParams(c: ChainConfig) {
  return {
    chainId: c.chainIdHex,
    chainName: c.name,
    nativeCurrency: c.native,
    rpcUrls: [c.rpcUrls[0]],
    blockExplorerUrls: [c.explorerUrl],
  };
}
