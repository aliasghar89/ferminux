// ---------------------------------------------------------------------------
// Ferminux DEX web app configuration.
//
// Every value can be overridden at build time with a VITE_* environment
// variable (or a .env file) before `npm run build`.
//
// This module must stay importable under plain Node — no browser globals — so
// the e2e suite can import it directly.
// ---------------------------------------------------------------------------

import { FIRST_PARTY_ADDRESSES, isFirstParty, preloadTokens } from '../../../shared/tokens.ts';

// Vite injects import.meta.env at build time; the fallback keeps this module
// loadable outside Vite (plain node, the e2e runner) without crashing.
const env: Record<string, string | undefined> =
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

function list(raw: string | undefined, fallback: string[]): string[] {
  if (!raw) return fallback;
  const items = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return items.length > 0 ? items : fallback;
}

/** Ordered RPC fallback list — each is health-probed before use. */
export const RPC_URLS: string[] = list(env.VITE_RPC_URLS, [
  'https://rpc.ferminux.net',
  'https://ferminux.net/rpc',
]);

/** Ferminux Network chain id (0xF79). */
export const CHAIN_ID: number = Number(env.VITE_CHAIN_ID ?? 3961);
export const CHAIN_ID_HEX = '0xf79';

/** Blockscout v9 instance; REST API under /api/v2. */
export const EXPLORER_URL: string = (env.VITE_EXPLORER_URL ?? 'https://explorer.ferminux.net').replace(/\/+$/, '');

/** Native coin metadata. */
export const NATIVE_SYMBOL = 'FMX';
export const NATIVE_NAME = 'Ferminux';
export const NATIVE_DECIMALS = 18;

export interface DexAddresses {
  /** FerminuxFactory — the pair registry. */
  factory: string;
  /** FerminuxRouter — every swap and liquidity action goes through it. */
  router: string;
  /** WFMX — wrapped native FMX, the token the pools actually hold. */
  wfmx: string;
  /** LiquidityLocker — read-only here; the source of the LOCKED badge. */
  locker: string;
}

// ---------------------------------------------------------------------------
// DEPLOYMENT ADDRESSES — SET AFTER DEPLOYMENT.
//
// These ship EMPTY on purpose. The Ferminux AMM has not been deployed to
// chain 3961: `dex/contracts` has only ever been deployed to a local anvil
// devnet. Filling in a guessed address would point real users at a phantom
// contract, so the app shows a plain "not configured" screen instead.
//
// After the mainnet deployment, either edit the four defaults below or build
// with:
//   VITE_FACTORY_ADDRESS=0x… VITE_ROUTER_ADDRESS=0x… \
//   VITE_WFMX_ADDRESS=0x…    VITE_LOCKER_ADDRESS=0x… npm run build
// ---------------------------------------------------------------------------
export const DEX_ADDRESSES: DexAddresses = {
  factory: env.VITE_FACTORY_ADDRESS ?? '0x2034a8366fCdbfFCf4517D297f702aDDdba37040', // Ferminux mainnet, deployed 2026-08-20
  router: env.VITE_ROUTER_ADDRESS ?? '0x018C0Efca293F7a74D2f53ce738BA5e2f412BA9f', // Ferminux mainnet, deployed 2026-08-20
  wfmx: env.VITE_WFMX_ADDRESS ?? '0x8a9Ae4D652cEba09Db8Ebf48D28C943b41B377Ae', // Ferminux mainnet, deployed 2026-08-20
  locker: env.VITE_LOCKER_ADDRESS ?? '0xe588c594388B978E64B69E2Dd91CC7E302763951', // Ferminux mainnet, deployed 2026-08-20
};

/** Which of the four addresses are still unset. Empty array = ready to use. */
export function missingAddresses(a: DexAddresses = DEX_ADDRESSES): string[] {
  const labels: Array<[keyof DexAddresses, string]> = [
    ['factory', 'FerminuxFactory (VITE_FACTORY_ADDRESS)'],
    ['router', 'FerminuxRouter (VITE_ROUTER_ADDRESS)'],
    ['wfmx', 'WFMX (VITE_WFMX_ADDRESS)'],
    ['locker', 'LiquidityLocker (VITE_LOCKER_ADDRESS)'],
  ];
  return labels.filter(([k]) => !/^0x[0-9a-fA-F]{40}$/.test(a[k])).map(([, label]) => label);
}

export function isConfigured(a: DexAddresses = DEX_ADDRESSES): boolean {
  return missingAddresses(a).length === 0;
}

export interface PreloadedToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
}

/**
 * Tokens offered in the selector before any pool has been read.
 *
 * Sourced from the shared registry (shared/tokens.ts) rather than restated
 * here. WFMX is added at runtime from DEX_ADDRESSES.wfmx, so the registry marks
 * it preload:false and it does not appear twice.
 */
export const PRELOADED_TOKENS: PreloadedToken[] = preloadTokens().map((t) => ({
  address: t.address,
  symbol: t.symbol,
  name: t.name,
  decimals: t.decimals,
}));

/**
 * First-party tokens: deployed by Ferminux itself, administered by the project
 * multisig, and vouched for by the registry's `firstParty` flag.
 *
 * These predate the launchpad or were never meant to go through it, so
 * `isFactoryToken` returns false for them — correctly, since they genuinely did
 * not come from the factory. Treating that as "not an official token" was a
 * false positive that told users their own chain's stablecoin was untrusted.
 *
 * Address-keyed, never symbol-keyed: a symbol can be impersonated by anyone, an
 * address cannot. Every entry is a claim that this project stands behind that
 * token's behaviour, which is why the registry spells it as a deliberate flag
 * rather than inferring it from mere presence in the list.
 */
export const CANONICAL_TOKENS: readonly string[] = FIRST_PARTY_ADDRESSES;

/** Whether an address is a first-party Ferminux token. Case-insensitive. */
export const isCanonicalToken = isFirstParty;

/**
 * The launchpad TokenFactory registry on chain 3961. Its `isFactoryToken`
 * view tells the add-liquidity screen whether a token came from the official
 * factory; anything that is neither factory-minted nor first-party is a
 * bring-your-own contract that can behave however its author wrote it —
 * including skimming the asset you pair against it — so the UI warns before you
 * add liquidity to it. Overridable for a devnet.
 */
export const TOKEN_REGISTRY_ADDRESS: string =
  env.VITE_TOKEN_REGISTRY_ADDRESS ?? '0x62BC7d9671EfE1385413434aB8fdfE2fa4aE01D4';

/** Slippage presets offered in the swap settings, in basis points. */
export const SLIPPAGE_PRESETS_BPS = [10, 50, 100] as const;
export const DEFAULT_SLIPPAGE_BPS = 50;
/** Above this, a custom slippage setting is called out as dangerous. */
export const SLIPPAGE_WARN_BPS = 500;
export const MAX_SLIPPAGE_BPS = 5000;

/** Transaction deadline, in minutes from signing. */
export const DEFAULT_DEADLINE_MINUTES = 20;
export const MAX_DEADLINE_MINUTES = 180;

/** Price-impact thresholds (basis points): warn at 3%, hard confirm at 10%. */
export const PRICE_IMPACT_WARN_BPS = 300;
export const PRICE_IMPACT_CONFIRM_BPS = 1000;

/** Pool list page size (FerminuxFactory.pairsPage). */
export const PAIRS_PAGE_SIZE = 25;

/** Poll cadence for reserves/quotes. */
export const REFRESH_MS = 12_000;

/** Params for wallet_addEthereumChain — always the public endpoints. */
export const ADD_CHAIN_PARAMS = {
  chainId: CHAIN_ID_HEX,
  chainName: 'Ferminux Network',
  nativeCurrency: { name: NATIVE_NAME, symbol: NATIVE_SYMBOL, decimals: NATIVE_DECIMALS },
  rpcUrls: ['https://rpc.ferminux.net'],
  blockExplorerUrls: ['https://explorer.ferminux.net'],
} as const;

export function explorerAddressUrl(address: string): string {
  return `${EXPLORER_URL}/address/${address}`;
}

export function explorerTxUrl(hash: string): string {
  return `${EXPLORER_URL}/tx/${hash}`;
}
