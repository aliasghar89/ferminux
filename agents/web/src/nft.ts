// Ferminux Agents (ERC-721, FMXA) — collection metadata + on-chain status reads shared by /nfts/ and the home strip.
import { config, nftDeployed } from "./config";
import { nftRead } from "./wallet";

export interface NftMeta {
  id: number;
  name: string;
  description: string;
  image: string;
  external_url?: string;
  attributes: { trait_type: string; value: string | number }[];
}
export interface NftStatus { id: number; minted: boolean; owner: string | null }

const MOCK = import.meta.env.VITE_MOCK === "1"; // literal so the mock branch is tree-shaken in production

export const attr = (m: NftMeta, t: string): string => { const a = m.attributes.find((x) => x.trait_type === t); return a === undefined ? "" : String(a.value); };
export const archetype = (m: NftMeta) => attr(m, "Archetype") || m.name.replace(/\s*#\d+$/, "");
export const category = (m: NftMeta) => attr(m, "Category");
export const isLegendary = (m: NftMeta) => attr(m, "Edition") === "1/1" || category(m) === "Legendary";
export const isTreasury = (s: NftStatus) => !!s.owner && s.owner.toLowerCase() === config.treasury.toLowerCase();
export const metaUrl = (id: number) => `${config.nftBase}/meta/${id}.json`;
export const imageUrl = (id: number) => `${config.nftBase}/images/${id}.png`;

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
const MOCK_OWNERS = ["0x8Ba1f109551bD432803012645Ac136ddd64DBA72", "0x4bBeEB066eD09B7AEd07bF39EEe0460DFa261520", "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"];
const mockMinted = new Set<number>([3, 7, 12, 18, 25, 33, 41]);
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
