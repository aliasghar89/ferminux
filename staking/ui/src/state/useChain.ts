// Chain connection state — ordered-fallback RPC with auto-retry, head polling.
// Same pattern as wallet-web's useChain.

import { useCallback, useEffect, useState } from 'react';
import type { JsonRpcProvider } from 'ethers';
import { RPC_URLS, CHAIN_ID, REFRESH_MS } from '../config.ts';
import { connectRpc } from '../lib/rpc.ts';

export interface ChainState {
  provider: JsonRpcProvider | null;
  rpcUrl: string | null;
  status: 'connecting' | 'ok' | 'error';
  blockNumber: number | null;
  blockTimestamp: number | null;
  baseFee: bigint | null;
  retry: () => void;
}

export function useChain(): ChainState {
  const [conn, setConn] = useState<{
    provider: JsonRpcProvider | null;
    rpcUrl: string | null;
    status: 'connecting' | 'ok' | 'error';
  }>({ provider: null, rpcUrl: null, status: 'connecting' });
  const [head, setHead] = useState<{ blockNumber: number | null; blockTimestamp: number | null; baseFee: bigint | null }>(
    { blockNumber: null, blockTimestamp: null, baseFee: null },
  );
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setConn((c) => ({ ...c, status: 'connecting' }));
    connectRpc(RPC_URLS, CHAIN_ID)
      .then(({ provider, url }) => {
        if (!alive) {
          provider.destroy();
          return;
        }
        setConn({ provider, rpcUrl: url, status: 'ok' });
      })
      .catch(() => {
        if (alive) setConn({ provider: null, rpcUrl: null, status: 'error' });
      });
    return () => {
      alive = false;
    };
  }, [attempt]);

  // Poll the chain head for the footer + countdown baselines.
  useEffect(() => {
    const p = conn.provider;
    if (!p) return;
    let alive = true;
    let failures = 0;
    const tick = async () => {
      try {
        const b = await p.getBlock('latest');
        if (alive && b) {
          failures = 0;
          setHead({ blockNumber: b.number, blockTimestamp: b.timestamp, baseFee: b.baseFeePerGas ?? null });
        }
      } catch {
        failures += 1;
        if (alive && failures >= 2) setAttempt((a) => a + 1); // re-run endpoint fallback
      }
    };
    void tick();
    const id = setInterval(() => void tick(), REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [conn.provider]);

  // Auto-retry while unreachable.
  useEffect(() => {
    if (conn.status !== 'error') return;
    const id = setTimeout(() => setAttempt((a) => a + 1), 10_000);
    return () => clearTimeout(id);
  }, [conn.status, attempt]);

  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  return { ...conn, ...head, retry };
}
