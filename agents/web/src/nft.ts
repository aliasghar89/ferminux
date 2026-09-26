// Ferminux Agents (FRC-721, FMXA) — collection metadata + on-chain status reads shared by /nfts/ and the home strip.
import { config, nftDeployed } from "./config";
import { nftRead } from "./wallet";
import { api } from "./api";
import { esc } from "./format";
import { artSources, type OwnerBook } from "./nftView";

export interface NftMeta {
  id: number;
  name: string;
  description: string;
  image: string;
  external_url?: string;
  attributes: { trait_type: string; value: string | number }[];
}
/** `tier`: Ferminux Citizens only, the live on-chain tier index (it can differ from the metadata after setTier). */
export interface NftStatus { id: number; minted: boolean; owner: string | null; tier?: number }

const MOCK = import.meta.env.VITE_MOCK === "1"; // literal so the mock branch is tree-shaken in production

export const attr = (m: NftMeta, t: string): string => { const a = m.attributes.find((x) => x.trait_type === t); return a === undefined ? "" : String(a.value); };
export const archetype = (m: NftMeta) => attr(m, "Archetype") || m.name.replace(/\s*#\d+$/, "");
export const category = (m: NftMeta) => attr(m, "Category");
// Every token is a 1/1 edition, so "Edition" cannot single out the legendary: its Category (and Set) does.
export const isLegendary = (m: NftMeta) => category(m) === "Legendary" || attr(m, "Set") === "Legendary";
/** The archetype artwork (1-40) carries its number, name and category in the picture; the legendary's does not. */
export const artHasLabel = (m: NftMeta) => !isLegendary(m);
export const isTreasury = (s: NftStatus) => !!s.owner && s.owner.toLowerCase() === config.treasury.toLowerCase();
export const metaUrl = (id: number) => `${config.nftBase}/meta/${id}.json`;
export const imageUrl = (id: number) => `${config.nftBase}/images/${id}.png`;

/**
 * The artwork as <picture>: AVIF, then WebP, at 256/512 px (agents/nft/build-images.sh), the canonical PNG last.
 * The PNGs are ~245 kB each; on a phone the lazy loader fetched a dozen at once and none finished for tens of
 * seconds, so the cards sat black. `sizes` is the rendered width. The box pulses as a skeleton until the image
 * has loaded (bindArt), and a token whose metadata names another image keeps that image alone.
 */
export function artHtml(m: NftMeta, o: { sizes: string; alt?: string; eager?: boolean; base?: string; ext?: "png" | "jpg" }): string {
  const s = artSources(o.base ?? config.nftBase, m.id, o.ext);
  const own = !m.image || m.image === s.png;
  const img = `<img src="${esc(own ? s.png : m.image)}" alt="${esc(o.alt ?? "")}" width="512" height="512" ${o.eager ? `fetchpriority="high"` : `loading="lazy"`} decoding="async">`;
  return `<picture class="nft-art">${own ? `<source type="image/avif" srcset="${s.avif}" sizes="${o.sizes}"><source type="image/webp" srcset="${s.webp}" sizes="${o.sizes}">` : ""}${img}</picture>`;
}
/** Stop the skeleton once an artwork has loaded, and fall back to the PNG when a copy is missing on the server.
 *  Delegated (load/error do not bubble, so capture), so one call covers cards painted into `root` later. */
export function bindArt(root: HTMLElement) {
  const done = (img: HTMLImageElement) => img.closest(".nft-art")?.classList.add("ld");
  if (!root.dataset.art) {
    root.dataset.art = "1";
    root.addEventListener("load", (e) => { if (e.target instanceof HTMLImageElement) done(e.target); }, true);
    root.addEventListener("error", (e) => {
      const img = e.target; if (!(img instanceof HTMLImageElement)) return;
      const pic = img.closest("picture");
      if (pic?.querySelector("source")) { pic.querySelectorAll("source").forEach((x) => x.remove()); img.src = img.getAttribute("src")!; return; }
      done(img); // the PNG failed too: stop pulsing
    }, true);
  }
  // already decoded before the listener existed (memory cache)
  root.querySelectorAll<HTMLImageElement>(".nft-art:not(.ld) img").forEach((img) => { if (img.complete && img.naturalWidth) done(img); });
}

let book: Promise<OwnerBook> | null = null;
/** Registry names for owner addresses: agents (GET /api/agents) and agent wallets (GET /api/accounts). A gateway
 *  failure leaves the lists empty, so owners show as short addresses; it never holds up the gallery. */
export function ownerBook(): Promise<OwnerBook> {
  if (!book) {
    const accounts = (): Promise<{ account: string; owner: string }[]> => MOCK ? Promise.resolve([])
      : fetch(`${config.gateway}/accounts?limit=100`, { headers: { accept: "application/json" } }).then((r) => (r.ok ? r.json() : null)).then((j) => (Array.isArray(j?.items) ? j.items : []));
    book = Promise.allSettled([api.agents({ limit: 200 }), accounts()]).then(([ag, acc]) => ({
      treasury: config.treasury,
      governance: config.governance,
      agents: ag.status === "fulfilled" ? ag.value.items.map((a) => ({ id: Number(a.id), name: a.name, owner: a.owner })) : [],
      wallets: acc.status === "fulfilled" ? acc.value : [],
    }));
  }
  return book;
}

let collection: Promise<NftMeta[]> | null = null;
/** All 41 metadata objects, ordered by id. Served from /nft/agents/collection.json; the mock build bundles the file. */
export function loadCollection(): Promise<NftMeta[]> {
  if (!collection) {
    collection = (async () => {
      let raw: Omit<NftMeta, "id">[];
      if (MOCK) raw = (await import("../../nft/collection.json")).default as Omit<NftMeta, "id">[];
      else {
        const r = await fetch("/nft/agents/collection.json", { headers: { accept: "application/json" } });
        if (!r.ok) throw new Error(`collection.json: HTTP ${r.status}`);
        raw = await r.json();
      }
      if (!Array.isArray(raw) || !raw.length) throw new Error("collection.json is empty");
      const items = raw.map((m, i) => ({ ...m, id: Number(m.attributes?.find((a) => a.trait_type === "Number")?.value ?? i + 1) }));
      return items.sort((a, b) => a.id - b.id);
    })().catch((e) => { collection = null; throw e; });
  }
  return collection;
}

// ---- mock chain state (VITE_MOCK=1) ----
// behind the literal MOCK so a production build drops the demo owners instead of shipping them
const MOCK_OWNERS = MOCK ? ["0x8Ba1f109551bD432803012645Ac136ddd64DBA72", "0x4bBeEB066eD09B7AEd07bF39EEe0460DFa261520", "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"] : [];
const mockMinted = new Set<number>(MOCK ? [3, 7, 12, 18, 25, 33, 41] : []);
const mockStatus = (id: number): NftStatus => id === 41 ? { id, minted: true, owner: config.treasury } : mockMinted.has(id) ? { id, minted: true, owner: MOCK_OWNERS[id % MOCK_OWNERS.length] } : { id, minted: false, owner: null };
export function mockMarkMinted(id: number, owner: string) { mockMinted.add(id); MOCK_OWNERS[id % MOCK_OWNERS.length] = owner; }

/** Live collection facts: mint price, paused flag, minted count. */
export async function collectionState(): Promise<{ price: bigint; paused: boolean; totalSupply: number }> {
  if (MOCK) { await new Promise((r) => setTimeout(r, 200)); return { price: 50n * 10n ** 18n, paused: false, totalSupply: mockMinted.size }; }
  if (!nftDeployed) throw new Error("The Ferminux Agents collection is not deployed yet.");
  const c = nftRead();
  const [price, paused, ts] = await Promise.all([c.price() as Promise<bigint>, c.paused() as Promise<boolean>, c.totalSupply() as Promise<bigint>]);
  return { price: BigInt(price), paused: Boolean(paused), totalSupply: Number(ts) };
}

/** minted(id) for each id (no multicall on this chain: one eth_call per id, all in flight at once), then ownerOf for the minted ones. */
export async function statuses(ids: number[]): Promise<NftStatus[]> {
  if (MOCK) { await new Promise((r) => setTimeout(r, 300)); return ids.map(mockStatus); }
  if (!nftDeployed) return ids.map((id) => ({ id, minted: false, owner: null }));
  const c = nftRead();
  const minted = await Promise.all(ids.map((id) => (c.minted(id) as Promise<boolean>).then(Boolean)));
  const owners = await Promise.all(ids.map((id, i) => minted[i] ? (c.ownerOf(id) as Promise<string>).catch(() => null) : Promise.resolve(null)));
  return ids.map((id, i) => ({ id, minted: minted[i], owner: owners[i] }));
}
export const status = async (id: number) => (await statuses([id]))[0];
export const allIds = () => Array.from({ length: config.nftSupply }, (_, i) => i + 1);
