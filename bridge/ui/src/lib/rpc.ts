// Read-only RPC connections, one per chain, with ordered fallback + health probe.
// The bridge always needs TWO providers at once (source and destination), so
// connections are cached by chain key and shared.
// No browser globals — runs under Node for the e2e suite.

import { JsonRpcProvider, Network } from 'ethers';
import type { ChainConfig } from '../config.ts';

export interface RpcConnection {
  provider: JsonRpcProvider;
  url: string;
  chainId: number;
}

/**
 * Probe an RPC endpoint: POST eth_chainId, require a response matching the
 * expected chain id within `timeoutMs`. A wrong chain id is a hard fail — an
 * endpoint that silently serves another network would mis-price every transfer.
 */
export async function probeRpc(url: string, chainId: number, timeoutMs = 5000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { result?: string };
    if (typeof body.result !== 'string') return false;
    return BigInt(body.result) === BigInt(chainId);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** First endpoint that answers eth_chainId with the expected id wins. */
export async function connectRpc(urls: string[], chainId: number, timeoutMs = 5000): Promise<RpcConnection> {
  const network = Network.from({ chainId, name: `chain-${chainId}` });
  for (const url of urls) {
    if (await probeRpc(url, chainId, timeoutMs)) {
      // cacheTimeout -1 disables ethers' short-lived response cache: a bridge
      // must never show a stale allowance or cap right after a confirmed tx.
      const provider = new JsonRpcProvider(url, network, { staticNetwork: network, cacheTimeout: -1 });
      return { provider, url, chainId };
    }
  }
  throw new Error(`No reachable RPC endpoint for chain ${chainId} (tried ${urls.length}: ${urls.join(', ')})`);
}

export async function connectChain(chain: ChainConfig, timeoutMs = 5000): Promise<RpcConnection> {
  return connectRpc(chain.rpcUrls, chain.chainId, timeoutMs);
}

// --------------------------------------------------------------- shared cache
const cache = new Map<string, Promise<RpcConnection>>();

/**
 * Shared, de-duplicated connection per chain key. A failed connection is
 * evicted so the next caller retries instead of inheriting a dead provider.
 */
export function chainConnection(chain: ChainConfig, timeoutMs = 5000): Promise<RpcConnection> {
  const existing = cache.get(chain.key);
  if (existing) return existing;
  const pending = connectChain(chain, timeoutMs).catch((err) => {
    cache.delete(chain.key);
    throw err;
  });
  cache.set(chain.key, pending);
  return pending;
}

/** Drop a cached connection (used when an endpoint starts failing). */
export function dropConnection(chainKey: string): void {
  const pending = cache.get(chainKey);
  cache.delete(chainKey);
  void pending?.then(({ provider }) => provider.destroy()).catch(() => {});
}

export function dropAllConnections(): void {
  for (const key of [...cache.keys()]) dropConnection(key);
}
