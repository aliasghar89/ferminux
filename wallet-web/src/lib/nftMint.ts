// Minting the two Ferminux collections from inside the wallet: what is for
// sale, what it costs, and the checks that run before anything is signed.
// No browser globals beyond `fetch` (injectable) — runs under Node for tests.
//
// The contracts (agents/contracts/src):
//   Ferminux Agents   (FMXA) ids 1..41, one price for every id: mint(id) with exactly price().
//   Ferminux Citizens (FMXC) ids 1..totalIds(), priced by tier: mint(id) with exactly
//                     price(id) = priceOfTier[tierOf(id)]; a tier priced 0 is not for sale.
// Both revert on a wrong value, a minted id, an unknown id or a paused sale, so
// every one of those is read fresh, in ONE JSON-RPC batch together with the
// account's balance, right before the confirm screen and again right before
// signing — nobody signs a transaction that is already known to revert.
//
// This is the same pre-check the ferminux.net NFT pages run
// (agents/web/src/pages/nfts.ts preflight + wireMint): the id exists and is
// free, the sale is open, the price is re-read, the balance covers it, and a
// mint lost to another wallet is named as such.

import { Interface, getAddress } from 'ethers';
import type { BatchTransport, JsonRpcCall, JsonRpcReply } from './balances.ts';
import { KNOWN_COLLECTIONS, metadataFromJson, type NftAttribute } from './nft.ts';
import { formatAmount } from './validate.ts';

export type MintKey = 'citizens' | 'agents';

export interface MintCollection {
  key: MintKey;
  address: string;
  name: string;
  symbol: string;
  /** Where the metadata and artwork live (the contracts' baseURI host). */
  base: string;
  /** The canonical artwork file: PNG for Agents, the full-size JPEG for Citizens. */
  ext: 'png' | 'jpg';
  /** 'tier': price(id) per rarity tier (Citizens). 'fixed': one price() for every id (Agents). */
  pricing: 'tier' | 'fixed';
  /** Fixed id range 1..maxId (Agents); null = 1..totalIds() read from the chain (Citizens). */
  maxId: number | null;
  /** One piece in words: "citizen", "agent". */
  noun: string;
}

const known = (symbol: string) => KNOWN_COLLECTIONS.find((c) => c.symbol === symbol)!;

/** Citizens first: it is the collection with pieces left in every tier. */
export const MINT_COLLECTIONS: MintCollection[] = [
  {
    key: 'citizens',
    address: known('FMXC').address,
    name: known('FMXC').name,
    symbol: 'FMXC',
    base: 'https://ferminux.net/nft/citizens',
    ext: 'jpg',
    pricing: 'tier',
    maxId: null,
    noun: 'citizen',
  },
  {
    key: 'agents',
    address: known('FMXA').address,
    name: known('FMXA').name,
    symbol: 'FMXA',
    base: 'https://ferminux.net/nft/agents',
    ext: 'png',
    pricing: 'fixed',
    maxId: known('FMXA').maxId,
    noun: 'agent',
  },
];

export const mintCollection = (key: MintKey): MintCollection => MINT_COLLECTIONS.find((c) => c.key === key)!;

/* ------------------------------------------------------------------ */
/* Tiers (FerminuxCitizens: 0 Common … 3 Legendary)                    */
/* ------------------------------------------------------------------ */

export const TIERS = ['Common', 'Rare', 'Epic', 'Legendary'] as const;
export type TierName = (typeof TIERS)[number];
export const tierIndex = (name: string | null | undefined): number =>
  TIERS.findIndex((t) => t.toLowerCase() === String(name ?? '').trim().toLowerCase());
export const tierName = (i: number | null | undefined): TierName | null =>
  i !== null && i !== undefined && Number.isInteger(i) && i >= 0 && i < TIERS.length ? TIERS[i]! : null;

/* ------------------------------------------------------------------ */
/* ABI                                                                 */
/* ------------------------------------------------------------------ */

// Two interfaces: price() (Agents) and price(uint256) (Citizens) share a name.
const agentsAbi = new Interface([
  'function mint(uint256 tokenId) payable',
  'function price() view returns (uint256)',
  'function paused() view returns (bool)',
  'function minted(uint256 tokenId) view returns (bool)',
  'function ownerOf(uint256 tokenId) view returns (address)',
]);
const citizensAbi = new Interface([
  'function mint(uint256 tokenId) payable',
  'function price(uint256 tokenId) view returns (uint256)',
  'function priceOfTier(uint256 tier) view returns (uint256)',
  'function tierOf(uint256 tokenId) view returns (uint8)',
  'function totalIds() view returns (uint256)',
  'function paused() view returns (bool)',
  'function minted(uint256 tokenId) view returns (bool)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function tokensInfo(uint256 fromId, uint256 toId) view returns (uint8[] tiers, address[] owners)',
]);
const abiOf = (c: MintCollection) => (c.pricing === 'tier' ? citizensAbi : agentsAbi);

/** The method a mint calls, as the confirm screen names it. */
export const MINT_METHOD = 'mint(uint256)';

/** ABI-encode mint(tokenId) — the same selector on both contracts. */
export function encodeMint(tokenId: number | bigint): string {
  const id = BigInt(tokenId);
  if (id <= 0n) throw new Error('Token ids start at 1.');
  return agentsAbi.encodeFunctionData('mint', [id]);
}

export interface MintCall {
  chainId: number;
  to: string;
  /** Exactly the price read from the contract: mint() reverts on any other value. */
  value: bigint;
  data: string;
}

/** The only chain both collections are deployed on: the addresses above mean nothing anywhere else. */
export const MINT_CHAIN_ID = 3961;

/** The transaction a mint is: mint(id) on the collection, with exactly `price` attached. */
export function buildMintCall(c: MintCollection, tokenId: number, price: bigint, chainId: number): MintCall {
  // A build pointed at another chain id (VITE_CHAIN_ID) must not sign a mint to these addresses there.
  if (chainId !== MINT_CHAIN_ID) throw new Error(`${c.name} lives on the Ferminux Network (chain ${MINT_CHAIN_ID}) only.`);
  if (price <= 0n) throw new Error('This piece has no price on chain, so it cannot be minted.');
  return { chainId, to: getAddress(c.address), value: price, data: encodeMint(tokenId) };
}

/* ------------------------------------------------------------------ */
/* Batch helpers                                                       */
/* ------------------------------------------------------------------ */

const ZERO = /^0x0{40}$/i;
const UINT_MAX = (1n << 256n) - 1n;

function ethCall(id: number, to: string, data: string): JsonRpcCall {
  return { jsonrpc: '2.0', id, method: 'eth_call', params: [{ to, data }, 'latest'] };
}

function byId(replies: JsonRpcReply[]): Map<number, JsonRpcReply> {
  const m = new Map<number, JsonRpcReply>();
  for (const r of Array.isArray(replies) ? replies : [replies]) if (r && typeof r.id === 'number') m.set(r.id, r);
  return m;
}

/** A reply that is a contract revert (not a transport or node failure). */
function isRevert(r: JsonRpcReply | undefined): boolean {
  if (!r?.error) return false;
  return r.error.code === 3 || /revert/i.test(r.error.message ?? '');
}

function decodeOne<T>(iface: Interface, fn: string, r: JsonRpcReply | undefined): T | undefined {
  if (!r || r.error || typeof r.result !== 'string' || r.result === '0x') return undefined;
  try {
    return iface.decodeFunctionResult(fn, r.result)[0] as T;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* Gallery state: prices, pause flag and every id's status             */
/* ------------------------------------------------------------------ */

export interface PieceStatus {
  minted: boolean;
  owner: string | null;
  /** Citizens: the live on-chain tier index (it wins over the metadata; unminted ids can be re-tiered). */
  tier?: number;
}

export interface MintState {
  paused: boolean;
  /** Agents: [price]. Citizens: the price of each tier, Common..Legendary (0 = not for sale). */
  prices: bigint[];
  /** Ids 1..totalIds exist on chain. */
  totalIds: number;
  statuses: Map<number, PieceStatus>;
}

/**
 * Everything the gallery shows, in one batch. Agents: paused(), price() and
 * ownerOf(1..41) (a revert = unminted). Citizens: paused(), totalIds(), the
 * four tier prices and tokensInfo(1, max) — tiers and owners of every id in one
 * call (the contract clamps the range to totalIds()).
 */
export async function readMintState(transport: BatchTransport, c: MintCollection): Promise<MintState> {
  const iface = abiOf(c);
  if (c.pricing === 'fixed') {
    const max = c.maxId ?? 0;
    const calls = [
      ethCall(1, c.address, iface.encodeFunctionData('paused')),
      ethCall(2, c.address, iface.encodeFunctionData('price')),
      ...Array.from({ length: max }, (_, i) => ethCall(10 + i, c.address, iface.encodeFunctionData('ownerOf', [BigInt(i + 1)]))),
    ];
    const r = byId(await transport(calls));
    const paused = decodeOne<boolean>(iface, 'paused', r.get(1));
    const price = decodeOne<bigint>(iface, 'price', r.get(2));
    if (paused === undefined || price === undefined) throw new Error(`${c.name}: the RPC endpoint did not answer the sale check.`);
    const statuses = new Map<number, PieceStatus>();
    for (let i = 0; i < max; i++) {
      const reply = r.get(10 + i);
      const owner = decodeOne<string>(iface, 'ownerOf', reply);
      if (owner && !ZERO.test(owner)) statuses.set(i + 1, { minted: true, owner: getAddress(owner) });
      else if (isRevert(reply)) statuses.set(i + 1, { minted: false, owner: null });
      // no answer at all: status unknown, the card shows no status and the pre-check decides
    }
    return { paused: Boolean(paused), prices: [BigInt(price)], totalIds: max, statuses };
  }

  const calls = [
    ethCall(1, c.address, iface.encodeFunctionData('paused')),
    ethCall(2, c.address, iface.encodeFunctionData('totalIds')),
    ...TIERS.map((_, t) => ethCall(3 + t, c.address, iface.encodeFunctionData('priceOfTier', [BigInt(t)]))),
    ethCall(9, c.address, iface.encodeFunctionData('tokensInfo', [1n, UINT_MAX])),
  ];
  const r = byId(await transport(calls));
  const paused = decodeOne<boolean>(iface, 'paused', r.get(1));
  const total = decodeOne<bigint>(iface, 'totalIds', r.get(2));
  const prices = TIERS.map((_, t) => decodeOne<bigint>(iface, 'priceOfTier', r.get(3 + t)));
  if (paused === undefined || total === undefined || prices.some((p) => p === undefined)) {
    throw new Error(`${c.name}: the RPC endpoint did not answer the sale check.`);
  }
  const statuses = new Map<number, PieceStatus>();
  const info = r.get(9);
  if (info && !info.error && typeof info.result === 'string') {
    try {
      const [tiers, owners] = iface.decodeFunctionResult('tokensInfo', info.result) as unknown as [bigint[], string[]];
      owners.forEach((o, i) => {
        const minted = !!o && !ZERO.test(o);
        statuses.set(i + 1, { minted, owner: minted ? getAddress(o) : null, tier: Number(tiers[i]) });
      });
    } catch {
      /* statuses stay unknown */
    }
  }
  return { paused: Boolean(paused), prices: prices.map((p) => BigInt(p!)), totalIds: Number(total), statuses };
}

/** What one piece costs right now, from a gallery read (null when unknown). */
export function piecePrice(c: MintCollection, state: MintState | null, piece: { id: number; tier: TierName | null }): bigint | null {
  if (!state) return null;
  if (c.pricing === 'fixed') return state.prices[0] ?? null;
  const live = state.statuses.get(piece.id)?.tier;
  const t = live !== undefined ? live : tierIndex(piece.tier);
  return t >= 0 ? (state.prices[t] ?? null) : null;
}

/* ------------------------------------------------------------------ */
/* Pre-check: read fresh right before the confirm screen and signing   */
/* ------------------------------------------------------------------ */

export interface MintPreflight {
  tokenId: number;
  /** The id is in the collection's range on chain. */
  exists: boolean;
  minted: boolean;
  owner: string | null;
  paused: boolean;
  /** Exactly what mint(id) must carry: price() (Agents) or price(id) (Citizens). 0 when unknown/not for sale. */
  price: bigint;
  /** Citizens: the live tier index. */
  tier: number | null;
  /** Citizens: how many ids exist. */
  totalIds: number | null;
  /** The minting account's FMX balance at the same block. */
  balance: bigint;
}

/**
 * One batch: the sale flag, the exact price, whether the id exists and is
 * minted (and by whom), and the account's balance. Throws when the endpoint
 * did not answer a question the decision needs, so a failed read is never
 * mistaken for "available".
 */
export async function readMintPreflight(
  transport: BatchTransport,
  c: MintCollection,
  tokenId: number,
  holder: string,
): Promise<MintPreflight> {
  const iface = abiOf(c);
  const id = BigInt(tokenId);
  const fail = () => new Error('The network did not answer the mint check. Try again in a moment.');
  const balanceCall: JsonRpcCall = { jsonrpc: '2.0', id: 90, method: 'eth_getBalance', params: [holder, 'latest'] };

  if (c.pricing === 'fixed') {
    const max = c.maxId ?? 0;
    const exists = tokenId >= 1 && tokenId <= max;
    const calls = [
      ethCall(1, c.address, iface.encodeFunctionData('paused')),
      ethCall(2, c.address, iface.encodeFunctionData('price')),
      ...(exists
        ? [ethCall(3, c.address, iface.encodeFunctionData('minted', [id])), ethCall(4, c.address, iface.encodeFunctionData('ownerOf', [id]))]
        : []),
      balanceCall,
    ];
    const r = byId(await transport(calls));
    const paused = decodeOne<boolean>(iface, 'paused', r.get(1));
    const price = decodeOne<bigint>(iface, 'price', r.get(2));
    const minted = exists ? decodeOne<boolean>(iface, 'minted', r.get(3)) : false;
    const balance = readBalance(r.get(90));
    if (paused === undefined || price === undefined || minted === undefined || balance === null) throw fail();
    const owner = minted ? decodeOne<string>(iface, 'ownerOf', r.get(4)) : undefined;
    return {
      tokenId,
      exists,
      minted: Boolean(minted),
      owner: owner && !ZERO.test(owner) ? getAddress(owner) : null,
      paused: Boolean(paused),
      price: BigInt(price),
      tier: null,
      totalIds: max,
      balance,
    };
  }

  const calls = [
    ethCall(1, c.address, iface.encodeFunctionData('paused')),
    ethCall(2, c.address, iface.encodeFunctionData('totalIds')),
    ethCall(3, c.address, iface.encodeFunctionData('price', [id])),
    ethCall(4, c.address, iface.encodeFunctionData('tierOf', [id])),
    ethCall(5, c.address, iface.encodeFunctionData('minted', [id])),
    ethCall(6, c.address, iface.encodeFunctionData('ownerOf', [id])),
    balanceCall,
  ];
  const r = byId(await transport(calls));
  const paused = decodeOne<boolean>(iface, 'paused', r.get(1));
  const total = decodeOne<bigint>(iface, 'totalIds', r.get(2));
  const minted = decodeOne<boolean>(iface, 'minted', r.get(5));
  const balance = readBalance(r.get(90));
  if (paused === undefined || total === undefined || minted === undefined || balance === null) throw fail();
  const exists = tokenId >= 1 && BigInt(tokenId) <= total;
  // price(id) and tierOf(id) revert BadId() for an id past totalIds(): that is "does not exist", not a failure.
  const price = decodeOne<bigint>(iface, 'price', r.get(3));
  const tier = decodeOne<bigint>(iface, 'tierOf', r.get(4));
  if (exists && (price === undefined || tier === undefined)) throw fail();
  const owner = minted ? decodeOne<string>(iface, 'ownerOf', r.get(6)) : undefined;
  return {
    tokenId,
    exists,
    minted: Boolean(minted),
    owner: owner && !ZERO.test(owner) ? getAddress(owner) : null,
    paused: Boolean(paused),
    price: exists ? BigInt(price!) : 0n,
    tier: exists ? Number(tier) : null,
    totalIds: Number(total),
    balance,
  };
}

function readBalance(r: JsonRpcReply | undefined): bigint | null {
  if (!r || r.error || typeof r.result !== 'string') return null;
  try {
    return BigInt(r.result);
  } catch {
    return null;
  }
}

export type MintProblemCode = 'missing' | 'yours' | 'taken' | 'paused' | 'not-for-sale' | 'funds' | 'price-changed';

export interface MintProblem {
  code: MintProblemCode;
  message: string;
  /** 'funds': how much more FMX the account needs (price + worst-case fee − balance). */
  shortWei?: bigint;
}

const fmx = (wei: bigint, digits = 4) => `${formatAmount(wei, 18, digits)} FMX`;

/**
 * Whether a mint can go ahead, from a fresh pre-check. `feeWei` is the
 * worst-case network fee once the transaction is prepared; before that, the
 * balance only has to cover the price (the fee is checked again with it).
 * `expectPrice`: the price the user already saw on a confirm screen — a
 * different price now means they have to look again.
 */
export function mintProblem(
  c: MintCollection,
  pf: MintPreflight,
  holder: string,
  opts: { feeWei?: bigint; expectPrice?: bigint } = {},
): MintProblem | null {
  const id = pf.tokenId;
  if (!pf.exists) {
    return c.pricing === 'tier'
      ? { code: 'missing', message: `#${id} is not on chain yet${pf.totalIds ? ` (ids run 1–${pf.totalIds})` : ''}. Its batch is still being added — try again later.` }
      : { code: 'missing', message: `There is no #${id} in ${c.name} (ids run 1–${c.maxId}).` };
  }
  if (pf.minted) {
    if (pf.owner && pf.owner.toLowerCase() === holder.toLowerCase()) {
      return { code: 'yours', message: `#${id} is already in this account.` };
    }
    return { code: 'taken', message: `#${id} was just minted by someone else. Each id exists once — pick another ${c.noun}.` };
  }
  if (pf.paused) return { code: 'paused', message: 'Minting is paused by the contract right now. Nothing was signed.' };
  if (pf.price === 0n) return { code: 'not-for-sale', message: `This ${pf.tier !== null ? `${tierName(pf.tier)} ` : ''}tier is not for sale through the contract right now.` };
  if (opts.expectPrice !== undefined && opts.expectPrice !== pf.price) {
    return { code: 'price-changed', message: `The mint price changed to ${fmx(pf.price, 2)} since you reviewed it. Review the new price before signing.` };
  }
  const need = pf.price + (opts.feeWei ?? 0n);
  if (pf.balance < need) {
    const fee = opts.feeWei !== undefined ? `plus up to ${fmx(opts.feeWei, 6)} network fee` : 'plus a small network fee';
    return {
      code: 'funds',
      shortWei: need - pf.balance,
      message: `This account holds ${fmx(pf.balance)}. Minting #${id} needs ${fmx(pf.price, 2)} ${fee}.`,
    };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Metadata: collection.json + per-token files                         */
/* ------------------------------------------------------------------ */

export interface MintPiece {
  id: number;
  name: string;
  description: string;
  /** The metadata's image URL (the collection's own file, normally). */
  image: string | null;
  attributes: NftAttribute[];
  /** Citizens: the metadata tier (the live on-chain tier wins where known). */
  tier: TierName | null;
  /** Agents: "Genesis 40" or "Legendary"; Citizens: the series. */
  set: string | null;
}

const attr = (attrs: NftAttribute[], trait: string) => attrs.find((a) => a.trait.toLowerCase() === trait.toLowerCase())?.value ?? null;

/** One metadata object → a piece. `fallbackId` is used when the file carries no id (Agents' files do not). */
export function pieceFromJson(json: unknown, fallbackId: number): MintPiece | null {
  const meta = metadataFromJson(json);
  const raw = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const num = Number(raw.id ?? attr(meta.attributes, 'Number') ?? fallbackId);
  const id = Number.isSafeInteger(num) && num > 0 ? num : fallbackId;
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const t = tierName(tierIndex(attr(meta.attributes, 'Tier')));
  return {
    id,
    name: meta.name ?? `#${id}`,
    description: meta.description ?? '',
    image: meta.image,
    attributes: meta.attributes,
    tier: t,
    set: attr(meta.attributes, 'Set') ?? attr(meta.attributes, 'Series'),
  };
}

/** Parse collection.json (an array of metadata objects), ordered by id, one entry per id. */
export function parseCollection(json: unknown): MintPiece[] {
  if (!Array.isArray(json)) throw new Error('collection.json is not a list.');
  const out = new Map<number, MintPiece>();
  json.slice(0, 5000).forEach((m, i) => {
    const p = pieceFromJson(m, i + 1);
    if (p && !out.has(p.id)) out.set(p.id, p);
  });
  if (out.size === 0) throw new Error('collection.json is empty.');
  return [...out.values()].sort((a, b) => a.id - b.id);
}

async function getJson(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`metadata host responded ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Every piece listed in the collection's collection.json, ordered by id. */
export async function loadPieces(c: MintCollection, opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<MintPiece[]> {
  return parseCollection(await getJson(`${c.base}/collection.json`, opts.fetchImpl ?? fetch, opts.timeoutMs ?? 12_000));
}

/**
 * Fit the metadata to the chain: ids the chain has (1..totalIds) that a
 * cached collection.json does not list yet — a batch appended after the file
 * was cached — are fetched from meta/<id>.json (at most `extraMax`), and ids
 * the file lists but the chain does not have yet (metadata ships before its
 * appendTokens) are dropped: they cannot be minted.
 */
export async function completePieces(
  c: MintCollection,
  pieces: MintPiece[],
  totalIds: number,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; extraMax?: number } = {},
): Promise<MintPiece[]> {
  const f = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const out = [...pieces];
  const have = new Set(out.map((p) => p.id));
  const missing: number[] = [];
  for (let id = 1; id <= totalIds && missing.length < (opts.extraMax ?? 60); id++) if (!have.has(id)) missing.push(id);
  for (let i = 0; i < missing.length; i += 8) {
    const got = await Promise.all(
      missing.slice(i, i + 8).map((id) =>
        getJson(`${c.base}/meta/${id}.json`, f, timeoutMs).then(
          (j) => pieceFromJson({ ...(j && typeof j === 'object' ? j : {}), id }, id),
          () => null,
        ),
      ),
    );
    for (const p of got) {
      if (p && !have.has(p.id)) {
        have.add(p.id);
        out.push(p);
      }
    }
  }
  return out.filter((p) => p.id <= totalIds).sort((a, b) => a.id - b.id);
}

/* ------------------------------------------------------------------ */
/* Artwork                                                             */
/* ------------------------------------------------------------------ */

export interface ArtSources {
  avif: string;
  webp: string;
  /** The canonical file (PNG / full-size JPEG): the <img> fallback. */
  src: string;
}

/**
 * The gallery copies next to a collection's canonical artwork
 * (agents/nft/build-images.sh, agents/nft/citizens/ingest.mjs): AVIF and WebP
 * at 256 and 512 px. Null when `image` is not that collection's own file for
 * this id — such an image is shown as it is, through planImage.
 */
export function artSources(image: string | null, base: string, id: number, ext: 'png' | 'jpg'): ArtSources | null {
  const canonical = `${base}/images/${id}.${ext}`;
  if (image && image !== canonical) return null;
  const set = (e: string) => `${base}/images/${id}-256.${e} 256w, ${base}/images/${id}-512.${e} 512w`;
  return { avif: set('avif'), webp: set('webp'), src: canonical };
}

/** The collection (and id) an image URL belongs to, when it is one of the two collections' canonical files. */
export function collectionArt(image: string | null): ArtSources | null {
  if (!image) return null;
  for (const c of MINT_COLLECTIONS) {
    const m = new RegExp(`^${c.base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/images/(\\d{1,6})\\.${c.ext}$`).exec(image.trim());
    if (m) return artSources(image.trim(), c.base, Number(m[1]), c.ext);
  }
  return null;
}
