// Route-level data: connect to both chains, read both bridges, read the
// registry from chain. Nothing about the token list is hardcoded — if the owner
// multisig registers a new asset, it appears here on the next reload.

import { useCallback, useEffect, useState } from 'react';
import type { JsonRpcProvider } from 'ethers';
import type { ChainConfig } from '../config.ts';
import { chainConnection, dropConnection } from '../lib/rpc.ts';
import { readBridgeConfig, readRegistry, type BridgeConfig, type RegistryEntry } from '../lib/bridge.ts';
import { shortenError } from '../components/ui.tsx';

export interface BridgeData {
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  srcProvider: JsonRpcProvider | null;
  dstProvider: JsonRpcProvider | null;
  srcConfig: BridgeConfig | null;
  dstConfig: BridgeConfig | null;
  /** Source-registry entries whose route points at the selected destination. */
  routes: RegistryEntry[];
  /** Everything the source bridge has registered, including other destinations. */
  allSrcEntries: RegistryEntry[];
  dstEntries: RegistryEntry[];
  reload: () => void;
}

export function useBridgeData(src: ChainConfig | null, dst: ChainConfig | null): BridgeData {
  const [epoch, setEpoch] = useState(0);
  const [state, setState] = useState<Omit<BridgeData, 'reload'>>({
    status: 'loading',
    error: null,
    srcProvider: null,
    dstProvider: null,
    srcConfig: null,
    dstConfig: null,
    routes: [],
    allSrcEntries: [],
    dstEntries: [],
  });

  useEffect(() => {
    if (!src || !dst) {
      setState((s) => ({ ...s, status: 'error', error: 'Select a source and a destination chain.' }));
      return;
    }
    let alive = true;
    setState((s) => ({ ...s, status: 'loading', error: null }));

    void (async () => {
      try {
        const [srcConn, dstConn] = await Promise.all([chainConnection(src), chainConnection(dst)]);
        if (!alive) return;

        const [srcConfig, dstConfig] = await Promise.all([
          readBridgeConfig(srcConn.provider, src.bridgeAddress),
          readBridgeConfig(dstConn.provider, dst.bridgeAddress),
        ]);
        if (!alive) return;

        const [allSrcEntries, dstEntries] = await Promise.all([
          readRegistry(srcConn.provider, src, src.bridgeAddress),
          readRegistry(dstConn.provider, dst, dst.bridgeAddress),
        ]);
        if (!alive) return;

        setState({
          status: 'ready',
          error: null,
          srcProvider: srcConn.provider,
          dstProvider: dstConn.provider,
          srcConfig,
          dstConfig,
          routes: allSrcEntries.filter((e) => e.remoteChainId === dst.chainId),
          allSrcEntries,
          dstEntries,
        });
      } catch (err) {
        if (!alive) return;
        // A failed handshake must not leave a poisoned provider in the cache.
        dropConnection(src.key);
        dropConnection(dst.key);
        setState((s) => ({
          ...s,
          status: 'error',
          error: shortenError(err instanceof Error ? err.message : String(err)),
        }));
      }
    })();

    return () => {
      alive = false;
    };
  }, [src, dst, epoch]);

  const reload = useCallback(() => setEpoch((n) => n + 1), []);
  return { ...state, reload };
}
