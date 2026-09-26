// Ferminux Network configuration.
// Every value can be overridden at build time with VITE_* environment variables.
// This module must stay importable under plain Node (no browser globals) — the
// e2e suite imports it directly.

import { walletTokens } from '../../shared/tokens.ts';

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

/** Ferminux Network chain id (0xF79). Every signature must carry it. */
export const CHAIN_ID: number = Number(env.VITE_CHAIN_ID ?? 3961);

/** Blockscout v9 instance; REST API under /api/v2. */
export const EXPLORER_URL: string = (env.VITE_EXPLORER_URL ?? 'https://explorer.ferminux.net').replace(/\/+$/, '');

/** Native coin metadata. */
export const NATIVE_SYMBOL = 'FMX';
export const NATIVE_DECIMALS = 18;

export interface DefaultToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
}

/**
 * Tokens shown to every user out of the box.
 *
 * Sourced from the shared registry rather than restated here. This list used to
 * hold AZNT alone: USDF had been deployed with 500,000 supply and listed in the
 * DEX and the public token list, but not here, so a holder opening the wallet
 * saw nothing and had to know the address to find their own balance. One file
 * now, so a token cannot be live in three places and missing from a fourth.
 */
export const DEFAULT_TOKENS: DefaultToken[] = walletTokens().map((t) => ({
  address: t.address,
  symbol: t.symbol,
  name: t.name,
  decimals: t.decimals,
}));

/**
 * WalletConnect (Reown) project id, set at build time. Empty = WalletConnect
 * is not offered on this build; everything else works without it.
 */
export const WC_PROJECT_ID: string = (env.VITE_WC_PROJECT_ID ?? '').trim();

/**
 * TEST BUILDS ONLY (scripts/multichain-smoke.mjs): VITE_WC_TEST_KIT=1 lets the
 * page take a scripted stand-in for WalletKit from the test harness, so the
 * proposal and request modals can be driven end to end without the relay.
 * Never set for a deployed build; without it the hook is never read.
 */
export const WC_TEST_KIT: boolean = env.VITE_WC_TEST_KIT === '1';

/**
 * This build's connect page at every origin it is served from (one dist, see
 * vite.config.ts). A browser keeps a vault at the origin where it was created,
 * so a connect window that finds none offers the other one. Test builds point
 * this at two local origins.
 */
export const WALLET_CONNECT_URLS: string[] = list(env.VITE_WALLET_CONNECT_URLS, [
  'https://wallet.ferminux.net/connect.html',
  'https://ferminux.net/wallet/connect.html',
]);

/**
 * The Ferminux pay-in (agents/gateway: /api/payin/assets, /quote, /{id}):
 * buying FMX with USDT, USDC or a native coin on one of the seven other
 * networks. Same host as the NFT metadata, already in the wallet's CSP
 * connect-src; test builds point it at a local mock.
 */
export const PAYIN_API_URL: string = (env.VITE_PAYIN_API_URL ?? 'https://ferminux.net').replace(/\/+$/, '');

/** Idle time before the session auto-locks (15 minutes). */
export const IDLE_LOCK_MS = 15 * 60 * 1000;

/** Dashboard refresh cadence. */
export const REFRESH_MS = 10_000;
