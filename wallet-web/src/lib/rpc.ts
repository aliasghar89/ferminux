// RPC connection with ordered fallback + health probe.
// No browser globals — runs under Node for the e2e suite.

import { JsonRpcProvider, Network } from 'ethers';

export interface RpcConnection {
  provider: JsonRpcProvider;
  url: string;
}

/**
 * Probe an RPC endpoint: POST eth_chainId, require a response that matches
 * the expected chain id within `timeoutMs`.
 */
export async function probeRpc(url: string, chainId: number, timeoutMs = 4000): Promise<boolean> {
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

/**
 * Try each URL in order; return a provider on the first endpoint that
 * answers eth_chainId with the expected chain id. Throws if none respond.
 */
export async function connectRpc(urls: string[], chainId: number, timeoutMs = 4000): Promise<RpcConnection> {
  const network = Network.from({ chainId, name: 'ferminux' });
  for (const url of urls) {
    if (await probeRpc(url, chainId, timeoutMs)) {
      // cacheTimeout -1 disables ethers' short-lived response cache: a wallet
      // must never show a stale balance right after a confirmed transaction.
      const provider = new JsonRpcProvider(url, network, { staticNetwork: network, cacheTimeout: -1 });
      return { provider, url };
    }
  }
  throw new Error(`No reachable RPC endpoint (tried ${urls.length}: ${urls.join(', ')})`);
}
