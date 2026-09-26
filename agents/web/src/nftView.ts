// Pure pieces of the NFT gallery (Ferminux Agents and Ferminux Citizens): who owns a token (in words), which
// cards a filter shows, which image files a card asks for, and the Citizens tier ladder. No imports on purpose,
// so test/nftView.test.mjs runs them under plain Node without the Vite env or the wallet.

export type NftFilter = "all" | "available" | "minted";

/** A card shows under a filter. An id whose status has not loaded yet counts as available (it usually is). */
export const inFilter = (f: NftFilter, s: { minted: boolean } | undefined) =>
  f === "all" || (f === "minted" ? !!s?.minted : !s?.minted);

export interface OwnerBook {
  treasury: string;
  governance?: string;
  /** GET /api/agents: an address can own several agents; the first registered names it. */
  agents: { id: number; name: string; owner: string }[];
  /** GET /api/accounts: agent wallets (AgentAccount), named after their owner's agent. */
  wallets: { account: string; owner: string }[];
}
export interface OwnerLabel { name: string; kind: "you" | "treasury" | "governance" | "agent" | "agent-wallet" | "address"; agentId?: number }

const lc = (a: string | null | undefined) => (a ?? "").toLowerCase();
export const shortAddr = (a: string, n = 4) => (a.length > 2 * n + 2 ? `${a.slice(0, 2 + n)}…${a.slice(-n)}` : a);

function agentOf(addr: string, book: OwnerBook) {
  let best: OwnerBook["agents"][number] | undefined;
  for (const a of book.agents) if (lc(a.owner) === lc(addr) && (!best || a.id < best.id)) best = a;
  return best;
}
/** Agent names are self-chosen at registration: one that reads as a label this page gives by address ("You",
 *  "Ferminux treasury") or is blank shows as "Agent #id", so a stranger's token cannot pass for yours. */
const RESERVED = /^(you|yours|ferminux( treasury| governance)?|treasury|governance|agent wallet)$/i;
const agentName = (a: { id: number; name: string }) => { const n = (a.name ?? "").trim(); return !n || RESERVED.test(n) ? `Agent #${a.id}` : n; };

/** The name a person would use for a token's owner. The connected wallet wins ("You"), then the treasury and
 *  governance, then agent wallets and agent owners from the registry; anything else is the short address. */
export function ownerLabel(owner: string, book: OwnerBook, me?: string | null): OwnerLabel {
  const o = lc(owner);
  if (me && lc(me) === o) return { name: "You", kind: "you" };
  if (o === lc(book.treasury)) return { name: "Ferminux treasury", kind: "treasury" };
  if (book.governance && o === lc(book.governance)) return { name: "Ferminux governance", kind: "governance" };
  const w = book.wallets.find((x) => lc(x.account) === o);
  if (w) {
    const a = agentOf(w.owner, book);
    return a ? { name: `${agentName(a)} wallet`, kind: "agent-wallet", agentId: a.id } : { name: "Agent wallet", kind: "agent-wallet" };
  }
  const a = agentOf(owner, book);
  if (a) return { name: agentName(a), kind: "agent", agentId: a.id };
  return { name: shortAddr(owner), kind: "address" };
}

/** Gallery copies next to the canonical image (agents/nft/build-images.sh, agents/nft/citizens/ingest.mjs): AVIF
 *  and WebP at 256 and 512 px. `png` is the canonical file: a PNG for Agents, the full-size JPEG for Citizens. */
export function artSources(base: string, id: number, ext: "png" | "jpg" = "png"): { avif: string; webp: string; png: string } {
  const set = (e: string) => `${base}/images/${id}-256.${e} 256w, ${base}/images/${id}-512.${e} 512w`;
  return { avif: set("avif"), webp: set("webp"), png: `${base}/images/${id}.${ext}` };
}

/* ---------- Ferminux Citizens: tiers ---------- */
/** On-chain tier index = position here (FerminuxCitizens: 0 Common … 3 Legendary). */
export const TIERS = ["Common", "Rare", "Epic", "Legendary"] as const;
export type TierName = (typeof TIERS)[number];
export const tierIndex = (name: string | null | undefined): number => TIERS.findIndex((t) => t.toLowerCase() === String(name ?? "").toLowerCase());
export const tierName = (i: number | null | undefined): TierName | null => (i !== null && i !== undefined && i >= 0 && i < TIERS.length ? TIERS[i] : null);

export interface CitizensFilter { avail: NftFilter; tier: TierName | "all"; series: string | "all" }
/** Query string → filter; anything unknown falls back to "all" (a stale link still opens the gallery). */
export function parseCitizensFilter(search: string, series: readonly string[]): CitizensFilter {
  const q = new URLSearchParams(search);
  const f = q.get("filter"), t = tierName(tierIndex(q.get("tier"))), s = q.get("series");
  return {
    avail: f === "available" || f === "minted" ? f : "all",
    tier: t ?? "all",
    series: s && series.some((x) => x.toLowerCase() === s.toLowerCase()) ? series.find((x) => x.toLowerCase() === s.toLowerCase())! : "all",
  };
}
/** Filter → query string (only what differs from "all"), for deep links and history.replaceState. */
export function citizensQuery(f: CitizensFilter): string {
  const q = new URLSearchParams();
  if (f.avail !== "all") q.set("filter", f.avail);
  if (f.tier !== "all") q.set("tier", f.tier);
  if (f.series !== "all") q.set("series", f.series);
  const s = q.toString();
  return s ? `?${s}` : "";
}
/** A card shows when availability, tier and series all match. `tier` is the live on-chain tier when known. */
export function inCitizensFilter(f: CitizensFilter, t: { tier: TierName | null; series: string }, s: { minted: boolean } | undefined): boolean {
  return inFilter(f.avail, s) && (f.tier === "all" || t.tier === f.tier) && (f.series === "all" || t.series === f.series);
}

/**
 * The home page's standout Citizens: the Legendary and Epic ids (live tier when the chain answered), unminted
 * first, in the curated showcase order (tiers.json collection.showcase.square), then any other Legendary or Epic
 * id by tier and id. The first pick is a Legendary whenever one qualifies, so the large tile is the top tier.
 */
export function pickShowcase(items: readonly { id: number; tier: number; minted: boolean }[], showcase: readonly number[], n: number): number[] {
  const rank = new Map(showcase.map((id, i) => [id, i] as const));
  const key = (x: { id: number; tier: number; minted: boolean }): [number, number] =>
    [x.minted ? 1 : 0, rank.get(x.id) ?? 1e6 + (3 - x.tier) * 1e5 + x.id];
  const top = items.filter((x) => x.tier >= 2).sort((a, b) => { const ka = key(a), kb = key(b); return ka[0] - kb[0] || ka[1] - kb[1]; });
  const lead = top.findIndex((x) => x.tier === 3);
  if (lead > 0) top.unshift(...top.splice(lead, 1));
  return top.slice(0, Math.max(0, n)).map((x) => x.id);
}
