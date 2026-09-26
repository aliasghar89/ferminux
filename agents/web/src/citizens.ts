// Ferminux Citizens (FRC-721, FMXC): metadata and on-chain reads for /nfts/citizens/.
// The collection grows: ids 1..totalIds() exist on chain, and each new batch ships its metadata files first.
// The gallery starts from /nft/citizens/collection.json, drops ids the contract does not have yet, and fetches
// meta/<id>.json for ids the contract has but a cached collection.json does not list.
import { Contract } from "ethers";
import { config, citizensDeployed } from "./config";
import { CITIZENS_ABI } from "./abi";
import { contractRead, contractWrite } from "./wallet";
import { tierIndex, type TierName } from "./nftView";
import type { NftMeta, NftStatus } from "./nft";

const MOCK = import.meta.env.VITE_MOCK === "1";
export const citizensRead = () => contractRead(config.citizens, CITIZENS_ABI) as Contract;
export const citizensWrite = async () => (await contractWrite(config.citizens, CITIZENS_ABI)) as Contract;
export const citizensMetaUrl = (id: number) => `${config.citizensBase}/meta/${id}.json`;
export const citizensImageUrl = (id: number) => `${config.citizensBase}/images/${id}.jpg`;

const attr = (m: NftMeta, t: string) => { const a = m.attributes.find((x) => x.trait_type === t); return a === undefined ? "" : String(a.value); };
export const metaTier = (m: NftMeta) => attr(m, "Tier") as TierName | "";
export const metaSeries = (m: NftMeta) => attr(m, "Series");
/** The live tier wins over the metadata: the curator can re-tier an unminted id on chain. */
export const liveTier = (m: NftMeta, s: NftStatus | undefined): number => (s?.tier !== undefined ? s.tier : tierIndex(metaTier(m)));

/** One token's metadata in the shape the gallery reads: a file missing `attributes` (or with a non-string name)
 *  would otherwise throw inside the tier/series lookups and take the whole gallery down with it. */
export function normalizeMeta(m: Partial<NftMeta> | null | undefined, id: number): NftMeta {
  const o = (m ?? {}) as Partial<NftMeta>;
  return {
    ...o,
    id,
    name: typeof o.name === "string" && o.name ? o.name : `Citizen #${id}`,
    description: typeof o.description === "string" ? o.description : "",
    image: typeof o.image === "string" ? o.image : "", // "" = the collection's own file for this id (artHtml, imageUrlOf)
    attributes: Array.isArray(o.attributes) ? o.attributes.filter((a) => a && typeof a === "object" && typeof a.trait_type === "string") : [],
  };
}

let collection: Promise<NftMeta[]> | null = null;
/** Every token listed in collection.json, ordered by id. */
export function loadCitizens(): Promise<NftMeta[]> {
  if (!collection) {
    collection = (async () => {
      let raw: NftMeta[];
      if (MOCK) raw = (await import("../../nft/citizens/collection.json")).default as NftMeta[];
      else {
        const r = await fetch("/nft/citizens/collection.json", { headers: { accept: "application/json" } });
        if (!r.ok) throw new Error(`collection.json: HTTP ${r.status}`);
        raw = await r.json();
      }
      if (!Array.isArray(raw) || !raw.length) throw new Error("collection.json is empty");
      return raw
        .map((m, i) => ({ m, id: Number(m?.id ?? i + 1) }))
        .filter(({ id }) => Number.isSafeInteger(id) && id > 0)
        .map(({ m, id }) => normalizeMeta(m, id))
        .sort((a, b) => a.id - b.id);
    })().catch((e) => { collection = null; throw e; });
  }
  return collection;
}

/** meta/<id>.json for ids past the end of collection.json (a batch appended after the file was cached). */
export async function loadExtraMetas(fromId: number, toId: number): Promise<NftMeta[]> {
  const ids = Array.from({ length: Math.max(0, toId - fromId + 1) }, (_, i) => fromId + i).slice(0, 500);
  const out: NftMeta[] = [];
  for (let i = 0; i < ids.length; i += 8) {
    const got = await Promise.all(ids.slice(i, i + 8).map((id) => fetch(citizensMetaUrl(id), { headers: { accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : null)).then((m) => (m && typeof m === "object" ? normalizeMeta(m as Partial<NftMeta>, id) : null)).catch(() => null)));
    for (const m of got) if (m) out.push(m);
  }
  return out;
}

export interface CitizensState { paused: boolean; totalSupply: number; totalIds: number; prices: bigint[] }

// ---- mock chain state (VITE_MOCK=1 with VITE_CITIZENS set) ----
// the demo owners sit behind the literal MOCK so a production build drops them instead of shipping them
const mockMinted = new Map<number, string>(MOCK ? [[3, "0x8Ba1f109551bD432803012645Ac136ddd64DBA72"], [26, "0x4bBeEB066eD09B7AEd07bF39EEe0460DFa261520"], [51, "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984"], [60, "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"]] : []);
export function mockCitizenMinted(id: number, owner: string) { mockMinted.set(id, owner); }

/** Live facts: pause flag, minted count, how many ids exist, and the four tier prices (wei). */
export async function citizensState(): Promise<CitizensState> {
  if (MOCK) {
    await new Promise((r) => setTimeout(r, 200));
    return { paused: false, totalSupply: mockMinted.size, totalIds: (await loadCitizens()).length, prices: [50n, 100n, 250n, 500n].map((p) => p * 10n ** 18n) };
  }
  if (!citizensDeployed) throw new Error("The Ferminux Citizens contract is not deployed yet.");
  const c = citizensRead();
  const [paused, ts, ids, ...prices] = await Promise.all([c.paused(), c.totalSupply(), c.totalIds(), ...[0, 1, 2, 3].map((t) => c.priceOfTier(t))]);
  return { paused: Boolean(paused), totalSupply: Number(ts), totalIds: Number(ids), prices: prices.map((p) => BigInt(p)) };
}

/** Tier and owner of ids fromId..toId in one call (tokensInfo), 500 ids per call. */
export async function citizensStatuses(fromId: number, toId: number): Promise<NftStatus[]> {
  const out: NftStatus[] = [];
  if (toId < fromId) return out;
  if (MOCK) {
    await new Promise((r) => setTimeout(r, 300));
    const metas = await loadCitizens();
    for (let id = fromId; id <= toId; id++) {
      const m = metas.find((x) => x.id === id);
      const o = mockMinted.get(id) ?? null;
      out.push({ id, minted: !!o, owner: o, tier: m ? tierIndex(metaTier(m)) : 0 });
    }
    return out;
  }
  const c = citizensRead();
  for (let a = fromId; a <= toId; a += 500) {
    const b = Math.min(toId, a + 499);
    const [tiers, owners] = (await c.tokensInfo(a, b)) as [bigint[], string[]];
    tiers.forEach((t, i) => {
      const o = owners[i];
      const minted = !!o && !/^0x0{40}$/i.test(o);
      out.push({ id: a + i, minted, owner: minted ? o : null, tier: Number(t) });
    });
  }
  return out;
}
export const citizenStatus = async (id: number) => (await citizensStatuses(id, id))[0];
