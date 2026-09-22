// The two chains the bridge panel talks to, and the wallet plumbing for moving
// between them.
//
// WHY THESE ARE DECLARED HERE rather than imported from the bridge app's
// config.ts, when everything else in the panel is shared: that module builds six
// ChainConfigs, four of which have no deployment, and each carries RPC and
// explorer hostnames. Importing it would put those hosts in this bundle where
// scripts/check-dist.mjs cannot account for them, and would ship dead chains to
// a DEX that only bridges one route. The TYPE is imported — types are erased —
// so the shape cannot drift from the app the logic comes from.
//
// WHY THE ADDRESSES ARE TRACKED CONSTANTS with an env override, and not env
// alone: `.env.*` is gitignored, so an env-only address lives on whichever
// machine built last. The bridge app shipped exactly that way and served an
// empty shell for weeks — no chain passed its address test, so it had nothing
// to route between and said nothing about why. A deployed address is public and
// belongs in source, where a build cannot lose it and a reviewer sees it change.
//
// They ARE replaced by the wFMX migration. That is a two-constant commit here,
// which is the right weight for changing where user funds are sent.
import type { ChainConfig } from '@bridge/config.ts';

// Same shape as src/config.ts: Vite injects import.meta.env at build time, and
// the fallback keeps this module loadable under plain Node so the suite can
// import it directly rather than testing a copy of it.
const env: Record<string, string | undefined> =
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

/**
 * The live FerminuxBridge deployments. Replaced by the wFMX migration — both of
 * them, because the route registry is once-only and the Ferminux side has the
 * old wrapper address frozen in its TokenConfig.
 */
const DEPLOYED_FERMINUX = '0xe162eeDa683f067d4Ebf61060Fa322332a779EF4';
const DEPLOYED_BSC = '0xe43951a0E421A6B3Cb9C6ae66273dc0D3c8a70ff';

function list(raw: string | undefined, fallback: string[]): string[] {
  const parsed = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : fallback;
}

export const FERMINUX: ChainConfig = {
  key: 'ferminux',
  chainId: Number(env.VITE_CHAIN_ID_FERMINUX ?? 3961),
  chainIdHex: '0xf79',
  name: 'Ferminux Network',
  short: 'Ferminux',
  native: { name: 'Ferminux', symbol: 'FMX', decimals: 18 },
  rpcUrls: list(env.VITE_RPC_FERMINUX, ['https://rpc.ferminux.net']),
  explorerUrl: (env.VITE_EXPLORER_FERMINUX ?? 'https://explorer.ferminux.net').replace(/\/+$/, ''),
  bridgeAddress: (env.VITE_BRIDGE_FERMINUX ?? DEPLOYED_FERMINUX).trim(),
  confirmations: Number(env.VITE_CONFIRMATIONS_FERMINUX ?? 8),
  blockSeconds: Number(env.VITE_BLOCK_SECONDS_FERMINUX ?? 7),
};

export const BSC: ChainConfig = {
  key: 'bsc',
  chainId: 56,
  chainIdHex: '0x38',
  name: 'BNB Smart Chain',
  short: 'BSC',
  native: { name: 'BNB', symbol: 'BNB', decimals: 18 },
  rpcUrls: list(env.VITE_RPC_BSC, [
    'https://bsc-dataseed.bnbchain.org',
    'https://bsc-rpc.publicnode.com',
  ]),
  explorerUrl: (env.VITE_EXPLORER_BSC ?? 'https://bscscan.com').replace(/\/+$/, ''),
  bridgeAddress: (env.VITE_BRIDGE_BSC ?? DEPLOYED_BSC).trim(),
  confirmations: Number(env.VITE_CONFIRMATIONS_BSC ?? 6),
  blockSeconds: Number(env.VITE_BLOCK_SECONDS_BSC ?? 3),
};

/**
 * A chain is usable only once its bridge address is configured.
 *
 * This is not defensive padding. The bundle deployed at ferminux.net/bridge/ was
 * built with no VITE_BRIDGE_* set at all, so every chain failed this test, the
 * app had nothing to route between, and it rendered an empty shell for as long
 * as it was up — with no error, because an unconfigured chain is indistinguishable
 * from one that is not live yet. The panel says so out loud instead.
 */
export function isConfigured(c: ChainConfig): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(c.bridgeAddress);
}

/** Both ends configured — anything less and the panel cannot offer a route. */
export function bridgeReady(): boolean {
  return isConfigured(FERMINUX) && isConfigured(BSC);
}

export function otherChain(c: ChainConfig): ChainConfig {
  return c.key === FERMINUX.key ? BSC : FERMINUX;
}

/**
 * Point the wallet at `chain`, adding it first if the wallet does not know it
 * (error 4902).
 *
 * The DEX's own switchChain() cannot be used: it is hardcoded to Ferminux,
 * which is right for swapping and wrong for the return leg of a bridge. The
 * bridge app's switchNetwork() does exactly this — but it reaches into that
 * app's config for addChainParams, which would pull its whole six-chain CHAINS
 * list and their hosts into this bundle. The logic is small enough to state
 * here; the six chains are not.
 *
 * Some wallets add a chain without switching to it, so the switch is asked for
 * a second time after an add, and a refusal there is ignored — by then the user
 * is either on the chain or has declined twice.
 */
export async function switchTo(chain: ChainConfig): Promise<void> {
  const eth = (window as { ethereum?: { request(a: { method: string; params?: unknown[] }): Promise<unknown> } })
    .ethereum;
  if (!eth) throw new Error('No injected wallet found.');
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chain.chainIdHex }] });
  } catch (err) {
    const e = err as { code?: number; data?: { originalError?: { code?: number } } };
    if (e?.code !== 4902 && e?.data?.originalError?.code !== 4902) throw err;
    await eth.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: chain.chainIdHex,
          chainName: chain.name,
          nativeCurrency: chain.native,
          rpcUrls: [chain.rpcUrls[0]],
          blockExplorerUrls: [chain.explorerUrl],
        },
      ],
    });
    try {
      await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chain.chainIdHex }] });
    } catch {
      /* added but not switched, or declined again */
    }
  }
}
