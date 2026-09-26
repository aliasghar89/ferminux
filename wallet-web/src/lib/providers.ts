// One health-probed provider per chain, created on first use.
// No browser globals — runs under Node for the e2e suite.
//
// The home chain's provider is owned by App (it also drives the status
// footer); every other chain gets one here the first time something needs to
// send, estimate or read metadata on it. The probe (eth_chainId must equal the
// chain's id) runs once per page, not per call. A failed connection is not
// cached, so the next attempt tries the endpoint list again.

import type { JsonRpcProvider } from 'ethers';
import { connectRpc } from './rpc.ts';
import type { ChainDef } from './chains.ts';

const cache = new Map<number, Promise<JsonRpcProvider>>();

export function providerFor(chain: ChainDef, timeoutMs = 5000): Promise<JsonRpcProvider> {
  const hit = cache.get(chain.id);
  if (hit) return hit;
  const pending = connectRpc(chain.rpcUrls, chain.id, timeoutMs).then(
    ({ provider }) => provider,
    (e: unknown) => {
      cache.delete(chain.id);
      throw new Error(`Cannot reach ${chain.name}: ${e instanceof Error ? e.message : String(e)}`);
    },
  );
  cache.set(chain.id, pending);
  return pending;
}

/** Drop a chain's provider (e.g. after it stopped answering) so the next call reconnects. */
export function forgetProvider(chainId: number): void {
  const hit = cache.get(chainId);
  cache.delete(chainId);
  if (hit) void hit.then((p) => p.destroy(), () => undefined);
}
