// FRC-721 tokens the active account holds on Ferminux.
// Loaded when the NFTs tab opens and on demand — not polled: holdings change
// only when this account sends or receives one.

import { useCallback, useEffect, useState } from 'react';
import { EXPLORER_URL, RPC_URLS } from '../config.ts';
import { httpBatchTransport, type BatchTransport } from '../lib/balances.ts';
import {
  activeCollections,
  fetchTokenMetadata,
  filterOwned,
  metadataFromJson,
  parseExplorerInstance,
  parseExplorerNfts,
  readTokenUris,
  scanCollection,
  type ExplorerNft,
  type NftItem,
  type NftMetadata,
} from '../lib/nft.ts';

export type NftState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; items: NftItem[]; notes: string[] };

async function explorerJson(path: string, timeoutMs = 8000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${EXPLORER_URL}${path}`, { headers: { accept: 'application/json' }, signal: controller.signal });
    if (!res.ok) throw new Error(`explorer responded ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function sameOrigin(url: string): boolean {
  try {
    return new URL(url).origin === window.location.origin;
  } catch {
    return false;
  }
}

/** The first RPC in the list that answers the batch. */
export async function withTransport<T>(fn: (t: BatchTransport) => Promise<T>): Promise<T> {
  let last: unknown = null;
  for (const url of RPC_URLS) {
    try {
      return await fn(httpBatchTransport(url, 10_000));
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error('No Ferminux RPC endpoint answered.');
}

function item(
  contract: string,
  tokenId: string,
  collection: string,
  symbol: string,
  meta: NftMetadata | null,
  tokenUri: string | null,
  source: NftItem['metadataSource'],
): NftItem {
  return {
    contract,
    collection,
    symbol,
    tokenId,
    name: meta?.name ?? `${collection} #${tokenId}`,
    description: meta?.description ?? '',
    image: meta?.image ?? null,
    attributes: meta?.attributes ?? [],
    tokenUri,
    metadataSource: meta ? source : 'none',
  };
}

async function loadNfts(holder: string): Promise<{ items: NftItem[]; notes: string[] }> {
  const notes: string[] = [];

  // The explorer list is best-effort: it finds collections we do not know.
  let indexed: ExplorerNft[] = [];
  try {
    indexed = parseExplorerNfts(await explorerJson(`/api/v2/addresses/${holder}/nft?type=ERC-721`));
  } catch {
    notes.push(`The explorer could not be reached, so only ${activeCollections().map((c) => c.name).join(' and ')} ${activeCollections().length === 1 ? 'was' : 'were'} checked (on-chain).`);
  }

  // Built per attempt: a fallback endpoint starts from an empty list, so what
  // the failed endpoint had already read is not listed twice.
  const items = await withTransport(async (transport) => {
    const items: NftItem[] = [];
    // Known collections: the chain is the whole truth.
    for (const col of activeCollections()) {
      const ids = await scanCollection(transport, col, holder);
      if (ids.length === 0) continue;
      const uris = await readTokenUris(transport, col.address, ids);
      for (const id of ids) {
        const uri = uris.get(id) ?? null;
        const cached = indexed.find((x) => x.contract === col.address && x.tokenId === id);
        let meta: NftMetadata | null = null;
        let source: NftItem['metadataSource'] = 'none';
        const fromUri = async () => {
          if (!uri || meta) return;
          try {
            meta = await fetchTokenMetadata(uri);
            source = 'tokenURI';
          } catch {
            /* the metadata host may not allow this origin; fall back below */
          }
        };
        // tokenURI first when it can be read without a cross-origin request
        // (a data: URI, or metadata served from this page's own origin, as on
        // ferminux.net/wallet/). Otherwise the explorer's indexed copy of the
        // same tokenURI document comes first, and a cross-origin fetch — which
        // the metadata host may refuse — is the fallback.
        if (uri && (uri.startsWith('data:') || sameOrigin(uri))) await fromUri();
        if (!meta && cached?.metadata) {
          meta = cached.metadata;
          source = 'explorer';
        }
        await fromUri();
        if (!meta) {
          try {
            const one = parseExplorerInstance(await explorerJson(`/api/v2/tokens/${col.address}/instances/${id}`));
            if (one?.metadata) {
              meta = one.metadata;
              source = 'explorer';
            }
          } catch {
            /* shown without metadata */
          }
        }
        items.push(item(col.address, id, col.name, col.symbol, meta, uri, source));
      }
    }

    // Other collections from the index, each re-checked on-chain.
    const others = indexed.filter((x) => !activeCollections().some((c) => c.address === x.contract));
    const byContract = new Map<string, ExplorerNft[]>();
    for (const x of others) byContract.set(x.contract, [...(byContract.get(x.contract) ?? []), x]);
    for (const [contract, list] of byContract) {
      const owned = new Set(await filterOwned(transport, contract, list.map((x) => x.tokenId), holder));
      for (const x of list) {
        if (!owned.has(x.tokenId)) continue;
        const meta = x.metadata ?? (x.imageUrl ? metadataFromJson({ image: x.imageUrl }) : null);
        items.push(item(contract, x.tokenId, x.collection ?? 'Unnamed collection', x.symbol ?? '', meta, null, meta ? 'explorer' : 'none'));
      }
    }
    return items;
  });

  items.sort((a, b) => (a.collection === b.collection ? Number(BigInt(a.tokenId) - BigInt(b.tokenId)) : a.collection.localeCompare(b.collection)));
  return { items, notes };
}

export function useNfts(holder: string, enabled: boolean): { state: NftState; reload: () => void } {
  const [state, setState] = useState<NftState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setState({ kind: 'loading' });
    loadNfts(holder).then(
      (r) => alive && setState({ kind: 'ready', ...r }),
      (e: unknown) => alive && setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      alive = false;
    };
  }, [holder, enabled, attempt]);

  const reload = useCallback(() => setAttempt((a) => a + 1), []);
  return { state, reload };
}
