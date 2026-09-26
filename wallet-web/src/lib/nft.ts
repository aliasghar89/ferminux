// FRC-721 holdings on Ferminux: discovery, metadata, transfer encoding.
// No browser globals beyond `fetch` (injectable) — runs under Node for tests.
//
// Two sources, and the chain is the authority:
//   1. Known collections are scanned on-chain. Ferminux Agents is not
//      enumerable, but its ids are 1..41, so ownerOf(1..41) in one JSON-RPC
//      batch is the whole truth. Ferminux Citizens grows (ids 1..totalIds()),
//      and its tokensInfo(from, to) returns every owner in one eth_call.
//   2. The explorer's per-address NFT list finds every other collection. Its
//      index can lag a transfer, so each of its items is re-checked with
//      ownerOf before it is shown — a token the index still lists but the
//      holder no longer owns never appears with a Send button.
//
// Metadata comes from tokenURI. A data: URI is decoded locally; an https URI
// is fetched; when that fails (the metadata host may not send CORS headers to
// this origin) the explorer's cached copy of the same metadata is used.

import { Interface, getAddress, toUtf8String, decodeBase64 } from 'ethers';
import type { BatchTransport, JsonRpcCall, JsonRpcReply } from './balances.ts';
import { INVISIBLE_RE } from './text.ts';

export interface NftCollection {
  /** Empty = not deployed yet: the collection is skipped. */
  address: string;
  name: string;
  symbol: string;
  /** 'ownerOf': ids are 1..maxId, one ownerOf each in a batch. 'tokensInfo': a growing collection whose
   *  tokensInfo(1, max) answers (tiers, owners) for every id that exists, in one call (maxId unused). */
  scan: 'ownerOf' | 'tokensInfo';
  maxId: number;
}

/** Collections scanned on-chain: Ferminux Agents from agents/deployments.3961.json → "nft"; Ferminux Citizens from
 *  agents/deployments-citizens.3961.json → "citizens" once deployed (until then its address is empty and it is
 *  skipped). */
export const KNOWN_COLLECTIONS: NftCollection[] = [
  { address: '0x84FE97C49Ffe4227d9ea139B5998C097D9C06ddd', name: 'Ferminux Agents', symbol: 'FMXA', scan: 'ownerOf', maxId: 41 },
  { address: '0x5672AF1a567a46BAaFeb66959b7A95666E7f4252', name: 'Ferminux Citizens', symbol: 'FMXC', scan: 'tokensInfo', maxId: 0 },
];
/** The known collections that have an address. */
export const activeCollections = (list: NftCollection[] = KNOWN_COLLECTIONS): NftCollection[] =>
  list.filter((c) => /^0x[0-9a-fA-F]{40}$/.test(c.address));

export interface NftAttribute {
  trait: string;
  value: string;
}

export interface NftMetadata {
  name: string | null;
  description: string | null;
  image: string | null;
  attributes: NftAttribute[];
}

export interface NftItem {
  contract: string;
  collection: string;
  symbol: string;
  /** Decimal string — ids are uint256. */
  tokenId: string;
  name: string;
  description: string;
  image: string | null;
  attributes: NftAttribute[];
  tokenUri: string | null;
  /** Where the metadata shown came from. */
  metadataSource: 'tokenURI' | 'explorer' | 'none';
}

const erc721 = new Interface([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function safeTransferFrom(address from, address to, uint256 tokenId)',
  'function tokensInfo(uint256 fromId, uint256 toId) view returns (uint8[] tiers, address[] owners)',
]);

/** ABI-encode safeTransferFrom(from, to, tokenId) — the safe variant refuses a contract that cannot hold it. */
export function encodeNftTransfer(from: string, to: string, tokenId: string | bigint): string {
  return erc721.encodeFunctionData('safeTransferFrom', [getAddress(from), getAddress(to), BigInt(tokenId)]);
}

function callsFor(contract: string, fn: 'ownerOf' | 'tokenURI', ids: string[]): JsonRpcCall[] {
  return ids.map((id, i) => ({
    jsonrpc: '2.0',
    id: i + 1,
    method: 'eth_call',
    params: [{ to: contract, data: erc721.encodeFunctionData(fn, [BigInt(id)]) }, 'latest'],
  }));
}

function repliesById(replies: JsonRpcReply[]): Map<number, JsonRpcReply> {
  const m = new Map<number, JsonRpcReply>();
  for (const r of Array.isArray(replies) ? replies : [replies]) if (r && typeof r.id === 'number') m.set(r.id, r);
  return m;
}

/**
 * Which of `ids` on `contract` belong to `holder`. One batch; an id whose
 * ownerOf reverts (unminted) or does not answer is simply not owned.
 */
export async function filterOwned(
  transport: BatchTransport,
  contract: string,
  ids: string[],
  holder: string,
): Promise<string[]> {
  if (ids.length === 0) return [];
  const want = holder.toLowerCase();
  const replies = repliesById(await transport(callsFor(contract, 'ownerOf', ids)));
  // Not one reply for any id (a rate-limit or batch error object) is an
  // endpoint failure, not "owns nothing": throw so the caller tries the next
  // endpoint or says the check failed, instead of showing an empty list.
  if (!ids.some((_, i) => replies.has(i + 1))) throw new Error('The RPC endpoint did not answer the ownership check.');
  const out: string[] = [];
  ids.forEach((id, i) => {
    const r = replies.get(i + 1);
    if (!r || r.error || typeof r.result !== 'string') return;
    try {
      const [owner] = erc721.decodeFunctionResult('ownerOf', r.result);
      if (String(owner).toLowerCase() === want) out.push(id);
    } catch {
      /* not an address: not owned */
    }
  });
  return out;
}

/** Scan a known collection's whole id range for the holder's tokens. */
export async function scanCollection(transport: BatchTransport, collection: NftCollection, holder: string): Promise<string[]> {
  if (collection.scan === 'tokensInfo') {
    // toId past the end is clamped by the contract to totalIds(), so one call covers every id there is
    const call: JsonRpcCall = {
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to: collection.address, data: erc721.encodeFunctionData('tokensInfo', [1n, (1n << 256n) - 1n]) }, 'latest'],
    };
    const r = repliesById(await transport([call])).get(1);
    if (!r) throw new Error('The RPC endpoint did not answer the ownership check.');
    if (r.error || typeof r.result !== 'string') throw new Error(`${collection.name}: the ownership read failed.`);
    const [, owners] = erc721.decodeFunctionResult('tokensInfo', r.result) as unknown as [bigint[], string[]];
    const want = holder.toLowerCase();
    const out: string[] = [];
    owners.forEach((o, i) => {
      if (String(o).toLowerCase() === want) out.push(String(i + 1));
    });
    return out;
  }
  const ids = Array.from({ length: collection.maxId }, (_, i) => String(i + 1));
  return filterOwned(transport, collection.address, ids, holder);
}

/** tokenURI for each id, in one batch. Ids that fail are absent. */
export async function readTokenUris(transport: BatchTransport, contract: string, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const replies = repliesById(await transport(callsFor(contract, 'tokenURI', ids)));
  ids.forEach((id, i) => {
    const r = replies.get(i + 1);
    if (!r || r.error || typeof r.result !== 'string') return;
    try {
      const [uri] = erc721.decodeFunctionResult('tokenURI', r.result);
      if (typeof uri === 'string' && uri.trim() !== '') out.set(id, uri.trim());
    } catch {
      /* skip */
    }
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* Metadata                                                            */
/* ------------------------------------------------------------------ */

const TEXT_MAX = 400;

function text(v: unknown, max = TEXT_MAX): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v)
    .replace(INVISIBLE_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s === '') return null;
  return s.length > max ? s.slice(0, max).trimEnd() + '…' : s;
}

/** Normalise an OpenSea-style metadata JSON. Never throws. */
export function metadataFromJson(json: unknown): NftMetadata {
  const j = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const attributes: NftAttribute[] = [];
  if (Array.isArray(j.attributes)) {
    for (const a of j.attributes.slice(0, 40)) {
      const o = a as Record<string, unknown>;
      const trait = text(o?.trait_type, 60);
      const value = text(o?.value, 120);
      if (trait && value) attributes.push({ trait, value });
    }
  }
  const image = typeof j.image === 'string' ? j.image.trim() : typeof j.image_url === 'string' ? j.image_url.trim() : null;
  return {
    name: text(j.name, 120),
    description: text(j.description),
    image: image && image.length <= 100_000 ? image : null,
    attributes,
  };
}

export type ResolvedUri =
  | { kind: 'inline'; json: unknown }
  | { kind: 'https'; url: string }
  | { kind: 'unsupported'; reason: string };

/** Classify a tokenURI: decode a data: URI here, fetch only https. */
export function resolveTokenUri(uri: string): ResolvedUri {
  const s = uri.trim();
  const data = /^data:application\/json(;charset=[\w-]+)?(;base64)?,(.*)$/is.exec(s);
  if (data) {
    try {
      const body = data[2] ? toUtf8String(decodeBase64(data[3])) : decodeURIComponent(data[3]);
      return { kind: 'inline', json: JSON.parse(body) };
    } catch {
      return { kind: 'unsupported', reason: 'The on-chain metadata is not valid JSON.' };
    }
  }
  if (/^https:\/\//i.test(s)) {
    try {
      return { kind: 'https', url: new URL(s).toString() };
    } catch {
      return { kind: 'unsupported', reason: 'The metadata URL is malformed.' };
    }
  }
  if (/^ipfs:\/\//i.test(s)) return { kind: 'unsupported', reason: 'The metadata is on IPFS, which this wallet does not fetch.' };
  return { kind: 'unsupported', reason: 'The metadata URL is not https.' };
}

/** Fetch and normalise one token's metadata from its tokenURI. Throws on failure. */
export async function fetchTokenMetadata(
  uri: string,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<NftMetadata> {
  const resolved = resolveTokenUri(uri);
  if (resolved.kind === 'inline') return metadataFromJson(resolved.json);
  if (resolved.kind === 'unsupported') throw new Error(resolved.reason);
  const f = opts?.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 8000);
  try {
    const res = await f(resolved.url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`metadata host responded ${res.status}`);
    return metadataFromJson(await res.json());
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Explorer (Blockscout v2)                                            */
/* ------------------------------------------------------------------ */

export interface ExplorerNft {
  contract: string;
  tokenId: string;
  collection: string | null;
  symbol: string | null;
  metadata: NftMetadata | null;
  imageUrl: string | null;
}

/** Parse GET /api/v2/addresses/{a}/nft?type=ERC-721 (and a single instance). */
export function parseExplorerNfts(payload: unknown): ExplorerNft[] {
  const items = (payload as { items?: unknown[] } | null)?.items;
  if (!Array.isArray(items)) return [];
  const out: ExplorerNft[] = [];
  for (const raw of items) {
    const one = parseExplorerInstance(raw);
    if (one && !out.some((o) => o.contract === one.contract && o.tokenId === one.tokenId)) out.push(one);
  }
  return out;
}

export function parseExplorerInstance(raw: unknown): ExplorerNft | null {
  const it = raw as {
    id?: unknown;
    image_url?: unknown;
    metadata?: unknown;
    token?: { address_hash?: unknown; address?: unknown; name?: unknown; symbol?: unknown; type?: unknown };
  } | null;
  if (!it || typeof it !== 'object') return null;
  const addr = typeof it.token?.address_hash === 'string' ? it.token.address_hash : it.token?.address;
  if (typeof addr !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(addr)) return null;
  if (typeof it.token?.type === 'string' && it.token.type !== 'ERC-721') return null;
  const id = typeof it.id === 'string' || typeof it.id === 'number' ? String(it.id) : null;
  if (!id || !/^\d{1,78}$/.test(id)) return null;
  return {
    contract: getAddress(addr.toLowerCase()),
    tokenId: BigInt(id).toString(),
    collection: text(it.token?.name, 80),
    symbol: text(it.token?.symbol, 20),
    metadata: it.metadata && typeof it.metadata === 'object' ? metadataFromJson(it.metadata) : null,
    imageUrl: typeof it.image_url === 'string' ? it.image_url : null,
  };
}

/* ------------------------------------------------------------------ */
/* Images                                                              */
/* ------------------------------------------------------------------ */

export interface ImagePlan {
  url: string;
  host: string;
  /** Load without asking: a data: image or a host the project runs. */
  autoload: boolean;
}

/**
 * Decide how an NFT image is shown. Loading an image from an arbitrary host
 * tells that host this address is looking at its token, so only data: images
 * and first-party hosts load on their own; anything else waits for a click.
 */
export function planImage(image: string | null, trustedHosts: string[]): ImagePlan | null {
  if (!image) return null;
  const s = image.trim();
  if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml)[;,]/i.test(s)) return { url: s, host: 'inline', autoload: true };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  return { url: u.toString(), host, autoload: trustedHosts.some((h) => host === h || host.endsWith('.' + h)) };
}
