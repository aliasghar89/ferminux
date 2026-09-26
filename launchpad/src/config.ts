// ---------------------------------------------------------------------------
// Ferminux Launchpad configuration.
//
// Build-time overrides (Vite): set VITE_FACTORY_ADDRESS / VITE_RPC_URL /
// VITE_EXPLORER_URL in the environment (or a .env file) before `npm run build`.
// ---------------------------------------------------------------------------

// Vite injects import.meta.env at build time; the optional chaining keeps this
// module loadable outside Vite (e.g. plain node) without crashing.
const env: Record<string, string | undefined> =
  (import.meta as { env?: Record<string, string | undefined> }).env ?? {};

/** TokenFactory registry address on Ferminux mainnet (chain 3961).
 *  Default = the canonical DeployCore address (deployer nonce 2). Override
 *  with VITE_FACTORY_ADDRESS once/if the production deployment differs. */
export const FACTORY_ADDRESS: string =
  env.VITE_FACTORY_ADDRESS ?? "0x62BC7d9671EfE1385413434aB8fdfE2fa4aE01D4";

function list(raw: string | undefined, fallback: string[]): string[] {
  const items = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return items.length > 0 ? items : fallback;
}

/** JSON-RPC endpoints for read-only queries (work without a wallet), in order
 *  of preference. rpc.ferminux.net is canonical; the apex /rpc alias is the
 *  fallback. App.tsx probes them and reads from the first that answers with
 *  chain 3961. VITE_RPC_URL (single) is still honoured for existing builds. */
export const RPC_URLS: string[] = list(env.VITE_RPC_URLS ?? env.VITE_RPC_URL, [
  "https://rpc.ferminux.net",
  "https://ferminux.net/rpc",
]);

/** The preferred endpoint (first of RPC_URLS). */
export const RPC_URL: string = RPC_URLS[0];

/** Block-explorer base URL used for outbound links. */
export const EXPLORER_URL: string =
  env.VITE_EXPLORER_URL ?? "https://explorer.ferminux.net";

/** Ferminux Network chain id. */
export const CHAIN_ID = 3961;
export const CHAIN_ID_HEX = "0xf79";

// wallet_addEthereumChain parameters live in shared/fxwallet/network.ts
// (FERMINUX_ADD_CHAIN_PARAMS): one definition for every Ferminux dApp.

/** Registry page size for the token list. */
export const PAGE_SIZE = 10;

export function explorerAddressUrl(address: string): string {
  return `${EXPLORER_URL}/address/${address}`;
}

export function explorerTxUrl(hash: string): string {
  return `${EXPLORER_URL}/tx/${hash}`;
}
