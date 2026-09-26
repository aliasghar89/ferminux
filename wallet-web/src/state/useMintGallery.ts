// The mint gallery of one Ferminux collection: its metadata (names, tiers,
// artwork) from ferminux.net and its live sale state from the chain, loaded
// together when the Mint view opens. Metadata is cached for the session (it
// changes only when a batch of new pieces ships); the chain is read on every
// open and on demand. Nothing is polled.

import { useCallback, useEffect, useState } from 'react';
import { httpBatchTransport } from '../lib/balances.ts';
import { completePieces, loadPieces, readMintState, type MintCollection, type MintPiece, type MintState, type PieceStatus } from '../lib/nftMint.ts';
import { withTransport } from './useNfts.ts';

export type GalleryState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; key: string; pieces: MintPiece[]; state: MintState | null; stateError: string | null };

const metaCache = new Map<string, Promise<MintPiece[]>>();

function cachedPieces(c: MintCollection): Promise<MintPiece[]> {
  let p = metaCache.get(c.key);
  if (!p) {
    p = loadPieces(c);
    metaCache.set(c.key, p);
    p.catch(() => metaCache.delete(c.key)); // a failure is retried on the next open
  }
  return p;
}

/** The probed RPC first (the one transactions go through), then the configured fallbacks. */
async function readState(c: MintCollection, rpcUrl: string | null): Promise<MintState> {
  if (rpcUrl) {
    try {
      return await readMintState(httpBatchTransport(rpcUrl, 12_000), c);
    } catch {
      /* fall back to the list */
    }
  }
  return withTransport((t) => readMintState(t, c));
}

export function useMintGallery(
  c: MintCollection,
  rpcUrl: string | null,
): {
  gallery: GalleryState;
  reload: () => void;
  /** A fresh read of one piece (the sheet's pre-check, a mint): shown at once, without a reload. */
  setStatus: (id: number, status: PieceStatus) => void;
} {
  const [gallery, setGallery] = useState<GalleryState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    // A reload keeps the cards on screen; another collection starts from the skeleton.
    setGallery((g) => (g.kind === 'ready' && g.key === c.key ? g : { kind: 'loading' }));
    const state = readState(c, rpcUrl);
    Promise.allSettled([cachedPieces(c), state]).then(async ([pieces, st]) => {
      if (!alive) return;
      if (pieces.status === 'rejected') {
        const why = pieces.reason instanceof Error ? pieces.reason.message : String(pieces.reason);
        setGallery({
          kind: 'error',
          message: /abort/i.test(why)
            ? `ferminux.net took too long to send the ${c.name} artwork and names.`
            : `Could not load the ${c.name} artwork and names from ferminux.net (${why}).`,
        });
        return;
      }
      let list = pieces.value;
      if (st.status === 'fulfilled') {
        // Ids the chain has that a cached collection.json does not list yet; ids it lists that the chain lacks are dropped.
        list = await completePieces(c, list, st.value.totalIds).catch(() => list);
        if (!alive) return;
      }
      setGallery({
        kind: 'ready',
        key: c.key,
        pieces: list,
        state: st.status === 'fulfilled' ? st.value : null,
        stateError:
          st.status === 'rejected'
            ? `Could not read the sale from the chain (${st.reason instanceof Error ? st.reason.message : String(st.reason)}). Prices and availability are checked again before any mint.`
            : null,
      });
    });
    return () => {
      alive = false;
    };
  }, [c, rpcUrl, attempt]);

  const reload = useCallback(() => setAttempt((a) => a + 1), []);
  const setStatus = useCallback((id: number, status: PieceStatus) => {
    setGallery((g) => {
      if (g.kind !== 'ready' || !g.state) return g;
      const statuses = new Map(g.state.statuses);
      statuses.set(id, { ...statuses.get(id), ...status });
      return { ...g, state: { ...g.state, statuses } };
    });
  }, []);
  return { gallery, reload, setStatus };
}
