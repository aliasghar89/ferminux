// Ferminux Staking configuration.
// Every value can be overridden at build time with VITE_* environment variables.
// This module must stay importable under plain Node (no browser globals) — the
// e2e suite imports it directly.

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

/** Native coin metadata. FMX is the chain's native coin — staking needs no ERC-20 approval. */
export const NATIVE_SYMBOL = 'FMX';
export const NATIVE_DECIMALS = 18;

/**
 * Staking contract addresses. Deliberately EMPTY until the audited contracts
 * are deployed by the multisig: an empty string makes the app render its
 * "not live yet" state instead of pointing at a wrong address. Set
 * VITE_STAKING_VAULT / VITE_NODE_REGISTRY at build time to go live.
 */
export const STAKING_VAULT_ADDRESS: string = env.VITE_STAKING_VAULT ?? '';
export const NODE_REGISTRY_ADDRESS: string = env.VITE_NODE_REGISTRY ?? '';

/** Chain-schedule facts for countdowns. Blocks are 7 s apart under authority consensus (since block 160,000). */
export const SECONDS_PER_BLOCK = 7;
/** The staking contract's VALIDATOR_LOCK_BLOCK (FMXStaking.sol): validator-tier bonds stay locked until it. */
export const VALIDATOR_LOCK_END_BLOCK = 4_680_000;
export const EMISSION_FORK_BLOCK = 20_000;

/** Dashboard refresh cadence. */
export const REFRESH_MS = 10_000;
