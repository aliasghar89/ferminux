/* Shared by the three token pages (tokens.ts, token.ts, nft.ts). Local on purpose: the shared ui/ has no
   token-transfer table, NFT tile, agent-token card or token chain reads yet. If another page needs one,
   lift it into ui/ (see the note at the bottom of this file).
   - tokenDisc / stdTag / supplyHtml: the token identity bits of §5.9.
   - transfersTable: the §5.6 token-transfer table, minus the Token column (every row is this token).
   - nftTile / bindMedia: the 1:1 tile of §5.10 Inventory, images on #000, lazy, fade in once loaded.
   - chainRead / capOf / decoders: zero-argument ABI reads with hard-coded selectors (no ethers on these
     pages), batched by rpc.ts, cached 60 s.
   - agentTokenCard: the compact agent card of §4.14 for an agent token (GW /tokens + /agents). */
import "./tk.css";
import { html, raw, dash, type Html } from "../../ui/html";
import { addrChip, blockLink } from "../../ui/hash";
import { kindTag, ago, pill, agentStatusPill } from "../../ui/marks";
import { table, rowLink, type Col } from "../../ui/table";
import { icon } from "../../ui/icons";
import { amountCell, amountExact, int, short, safeHref, big } from "../../format";
import { rpc, RPC_DOWN, FRC721_PROBE, FRC165_INVALID } from "../../rpc";
import { swr } from "../../cache";
import { knownContract } from "../../known";
import { agentLinks, type Agent, type AgentToken } from "../../gateway";
import { calm } from "../../motion";
import { lc } from "../../util";
import { classify } from "./classify";
import type { TokenInfo, TokenInstance, TokenTransfer } from "../../types";

/* ------------------------------------------------------------------ identity */

export const isNft = (t: Pick<TokenInfo, "type"> | null | undefined) => !!t && /^FRC-(721|1155|404)$/.test(t.type);
export const decimalsOf = (t: Pick<TokenInfo, "decimals"> | null | undefined): number | null => {
  if (!t || t.decimals === null || t.decimals === undefined || t.decimals === "") return null;
  const n = Number(t.decimals);
  return Number.isInteger(n) && n >= 0 && n <= 77 ? n : null;
};
/** "Wrapped FMX" (or the symbol, or the short address when the index has neither). */
export const tokenName = (t: Pick<TokenInfo, "name" | "symbol" | "address_hash">) => t.name || t.symbol || short(t.address_hash, 4);
/** The ?type= value (FRC-20, frc-721, ERC-20 from old links) → our label, or "" for all. */
export function stdParam(v: string | null): "" | "FRC-20" | "FRC-721" {
  const s = (v ?? "").toUpperCase().replace(/ERC-/g, "FRC-");
  if (s.includes(",")) return ""; // "ERC-20,ERC-721" = all
  return s === "FRC-20" ? "FRC-20" : s === "FRC-721" ? "FRC-721" : "";
}

/** The FMX mark stands in for the tokens that ARE FMX (WFMX) or hold it (the FMX-LP pair). */
const FMX_MARKED = new Set(["wfmx", "fmx-lp"]);
function marked(a: string) { const c = knownContract(a); return !!c && FMX_MARKED.has(c.name.toLowerCase()); }

/** 20 px disc: the FMX mark for WFMX / FMX-LP, else the symbol's first letter on --surface-3. */
export function tokenDisc(t: Pick<TokenInfo, "address_hash" | "symbol" | "name">, size = 20): Html {
  const st = size === 20 ? "" : html` style="--d:${size}px"`;
  if (marked(t.address_hash)) return html`<span class="tk-disc fmx"${st} aria-hidden="true">${raw('<svg viewBox="4 4 26 26" width="14" height="14" focusable="false"><use href="#fx-mark"/></svg>')}</span>`;
  const ch = (t.symbol || t.name || "?").replace(/^[^A-Za-z0-9]+/, "").charAt(0) || "?";
  // The letter is drawn by CSS (attr), so it never joins the h1 / row text that readers and crawlers get.
  return html`<span class="tk-disc"${st} data-l="${ch}" aria-hidden="true"></span>`;
}
/** Mono standard tag: FRC-20 · FRC-721 (the api already translated the index's value). */
export const stdTag = (type: string) => kindTag(type);

/** Total supply, table rule: FRC-20 by decimals ("168,867.18", exact in title); FRC-721 "2 minted". */
export function supplyHtml(t: TokenInfo, unit = false): Html {
  if (t.total_supply === null || t.total_supply === undefined || t.total_supply === "") return dash("Total supply not reported by the index");
  if (isNft(t)) return html`<span class="num-mono">${int(t.total_supply)}</span> <span class="faint">minted</span>`;
  const d = decimalsOf(t);
  if (d === null) return html`<span class="num-mono">${int(t.total_supply)}</span> <span class="tag" title="The index reports no decimals for this token">raw units</span>`;
  return html`<span class="num-mono" title="${amountExact(t.total_supply, d)}${t.symbol ? ` ${t.symbol}` : ""}">${amountCell(t.total_supply, d)}</span>${unit && t.symbol ? html`<span class="unit">${t.symbol}</span>` : ""}`;
}

/* ------------------------------------------------------------------ token transfers (§5.6) */

const KIND: Record<string, string> = { token_minting: "Mint", token_burning: "Burn", token_transfer: "Transfer", token_spawning: "Mint" };
export const transferKind = (tt: TokenTransfer) => KIND[tt.type] ?? "Transfer";
const kindMark = (tt: TokenTransfer) => { const k = transferKind(tt); return html`<span class="tk-kind${k === "Transfer" ? "" : " " + k.toLowerCase()}">${k}</span>`; };
/** From → To. A mint has no sender and a burn no recipient: the zero address says nothing the MINT / BURN tag
 *  doesn't, so the row reads "minted → 0xF61d…2847" / "0x018C…8A9f → burned". */
const party = (tt: TokenTransfer) => {
  const z = (a: string | null | undefined) => lc(a ?? "") === ZERO_ADDR;
  const from = z(tt.from?.hash) ? html`<span class="tk-mint">minted</span>` : addrChip(tt.from, { copy: false });
  const to = z(tt.to?.hash) ? html`<span class="tk-mint">burned</span>` : addrChip(tt.to, { copy: false });
  return html`<span class="tk-party">${from}<span class="arrow" aria-hidden="true">→</span><span class="vh"> to </span>${to}</span>`;
};
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

/** A 20 px image in front of an instance id, when the index has one. */
export function thumb(url: string | null | undefined): Html {
  const src = safeHref(url);
  return src === "#" ? html`` : html`<span class="tk-thumb" aria-hidden="true"><img src="${raw(src)}" alt="" width="20" height="20" loading="lazy" decoding="async"></span>`;
}
export const instanceHref = (token: string, id: string) => `/token/${token}/instance/${id}`;

function amountCellHtml(tt: TokenTransfer, token: TokenInfo): Html {
  const t = tt.total ?? {};
  if (isNft(token) || t.token_id !== undefined && t.token_id !== null && t.value === undefined) {
    if (t.token_id === null || t.token_id === undefined) return dash("No token id reported by the index");
    const inst = t.token_instance;
    return html`<a class="tk-idlink" href="${instanceHref(token.address_hash, t.token_id)}">${thumb(inst?.image_url)}<span class="num-mono">#${t.token_id}</span></a>`;
  }
  const d = t.decimals !== undefined && t.decimals !== null ? Number(t.decimals) : decimalsOf(token);
  if (d === null || !Number.isFinite(d)) return html`<span class="num-mono">${int(t.value ?? null)}</span> <span class="tag">raw units</span>`;
  // number first, then the unit (the unit shows on phone cards only: the column header carries it on desktop)
  return html`<span title="${amountExact(t.value, d)}">${decAligned(amountCell(t.value, d))}</span>${token.symbol ? html`<span class="ph-unit">${token.symbol}</span>` : ""}`;
}

/** "5,000.25" → int + fraction spans, so a right-aligned column lines up on the decimal point (.dec-al). */
function decAligned(s: string): Html {
  if (s === "—") return dash();
  if (s === "0") return html`<span class="zero">0</span><span class="fr"></span>`;
  const i = s.indexOf(".");
  return i < 0 ? html`${s}<span class="fr"></span>` : html`${s.slice(0, i)}<span class="fr">${s.slice(i)}</span>`;
}
/** The widest fraction (".25" = 3ch) among a table's amounts: the column's --fw. */
const fracWidth = (items: TokenTransfer[], d: number | null) => Math.max(0, ...items.map((tt) => {
  if (d === null || tt.total?.value === undefined || tt.total?.value === null) return 0;
  const s = amountCell(tt.total.value, tt.total.decimals != null ? Number(tt.total.decimals) : d);
  const i = s.indexOf(".");
  return i < 0 ? 0 : s.length - i;
}));

/** The transfers of one token (or one instance): Tx · Kind · From → To · Amount / Token ID · Block · Age. */
export function transfersTable(items: TokenTransfer[], o: { token: TokenInfo; caption: string; instance?: boolean }): Html {
  const nft = isNft(o.token);
  const cols: Col<TokenTransfer>[] = [
    { label: "Tx", cell: (tt) => rowLink(`/tx/${tt.transaction_hash}`, html`<span class="num-mono">${short(tt.transaction_hash, 4)}</span>`, `Transaction ${tt.transaction_hash}`), w: "132px" },
    { label: "Kind", cell: kindMark, w: "96px" },
    { label: "From → To", cell: party, line: 2 },
  ];
  // Phone card: line 1 tx · kind · age, line 2 the parties with the amount and its unit at the right end (the
  // block hides: the tx link carries it), or the block when there is no amount (an instance's transfers).
  if (!o.instance) cols.push({ label: nft ? "Token ID" : `Amount${o.token.symbol ? ` (${o.token.symbol})` : ""}`, cell: (tt) => amountCellHtml(tt, o.token), align: nft ? "l" : "r", line: 2, end: true, cls: nft ? "" : "num-mono" });
  cols.push(
    { label: "Block", cell: (tt) => blockLink(tt.block_number), align: "r", line: 3, l: "Block", hidePhone: !o.instance },
    { label: "Age", cell: (tt) => ago(tt.timestamp), align: "r", end: true, w: "96px" },
  );
  const t = table({ caption: o.caption, captionHidden: true, cols, rows: items, id: "tk-transfers" });
  return nft ? t : html`<div class="dec-al" style="--fw:${fracWidth(items, decimalsOf(o.token))}ch">${t}</div>`;
}

/* ------------------------------------------------------------------ NFT tiles (§5.10 Inventory) */

type Meta = NonNullable<TokenInstance["metadata"]>;
export const attrOf = (m: Meta | null | undefined, trait: string): string | null => {
  const a = m?.attributes?.find((x) => (x?.trait_type ?? "").toLowerCase() === trait.toLowerCase());
  return a === undefined || a.value === undefined || a.value === null ? null : String(a.value);
};
/** Legendary look: the Legendary category or set (the FMXA #41 operator). Not "Edition 1/1": every FMXA token is
 *  a one-of-one, so that trait is on all 41. */
export const isLegendary = (m: Meta | null | undefined) => [attrOf(m, "Category"), attrOf(m, "Set")].some((v) => (v ?? "").toLowerCase() === "legendary");
/** A collection priced by rarity (Ferminux Citizens, or any collection that uses the same trait) names the rarity in a
 *  "Tier" trait: Common, Rare, Epic, Legendary. Keyed on the trait, never on an address. Unknown values get no styling. */
export const TIER_LADDER = ["common", "rare", "epic", "legendary"] as const;
export function tierOf(m: Meta | null | undefined): { label: string; key: (typeof TIER_LADDER)[number] | null } | null {
  const v = attrOf(m, "Tier");
  if (!v) return null;
  const k = v.trim().toLowerCase();
  return { label: v.trim(), key: (TIER_LADDER as readonly string[]).includes(k) ? (k as (typeof TIER_LADDER)[number]) : null };
}
/** The tier badge: faint → bright neutral → green outline → green fill (one accent). */
export const tierPill = (m: Meta | null | undefined): Html => { const t = tierOf(m); return t ? html`<span class="tk-tier${t.key ? ` t-${t.key}` : ""}">${t.label}</span>` : html``; };
/** "J1 #41" → { base: "J1", id: "41" }; no metadata → the symbol. */
export function instName(inst: Pick<TokenInstance, "id" | "metadata">, symbol?: string | null): { full: string; base: string } {
  const n = typeof inst.metadata?.name === "string" && inst.metadata.name.trim() ? inst.metadata.name.trim() : "";
  if (!n) return { full: `${symbol ?? "Token"} #${inst.id}`, base: symbol ?? "Token" };
  return { full: n, base: n.replace(new RegExp(`\\s*#\\s*${inst.id}$`), "") || n };
}
export const imageOf = (inst: Pick<TokenInstance, "image_url" | "metadata">): string | null =>
  inst.image_url || (typeof inst.metadata?.image === "string" ? inst.metadata.image : null);

/** The media box: an <img> that fades in once decoded (calm: shown at once); "Image unavailable" on error. */
export function media(url: string | null, o: { alt?: string; eager?: boolean; showUrl?: boolean; size?: number } = {}): Html {
  const src = safeHref(url);
  const s = o.size ?? 512;
  if (src === "#") return html`<span class="tk-media err"><span class="tk-err">${url ? html`Image unavailable<span class="u">${url}</span>` : "No image in the metadata"}</span></span>`;
  return html`<span class="tk-media"${o.showUrl ? html` data-url="${url ?? ""}"` : ""}><img data-media src="${raw(src)}" alt="${o.alt ?? ""}" width="${s}" height="${s}" ${o.eager ? html`fetchpriority="high"` : html`loading="lazy"`} decoding="async"></span>`;
}
/** Wire every [data-media] image under root: .ld on load (or at once when cached / calm), the error text on failure. */
export function bindMedia(root: ParentNode) {
  root.querySelectorAll<HTMLImageElement>("img[data-media]").forEach((img) => {
    const box = img.parentElement as HTMLElement;
    const ok = () => box.classList.add("ld");
    const bad = () => {
      box.classList.add("err");
      const u = box.dataset.url;
      box.innerHTML = html`<span class="tk-err">Image unavailable${u ? html`<span class="u">${u}</span>` : ""}</span>`.s;
    };
    if (img.complete) { if (img.naturalWidth > 0) ok(); else if (img.getAttribute("src")) bad(); return; }
    if (calm()) ok();
    img.addEventListener("load", ok, { once: true });
    img.addEventListener("error", bad, { once: true });
  });
}

/** One inventory tile: image 1:1 on #000, name + #id (the stretched link), category, owner chip. */
export function nftTile(inst: TokenInstance, token: Pick<TokenInfo, "address_hash" | "symbol">, o: { owner?: boolean } = {}): Html {
  const nm = instName(inst, token.symbol);
  const tier = tierOf(inst.metadata);
  const cat = attrOf(inst.metadata, "Category") ?? (tier ? [tier.label, attrOf(inst.metadata, "Series")].filter(Boolean).join(" · ") : null);
  const leg = isLegendary(inst.metadata) || tier?.key === "legendary";
  const href = instanceHref(token.address_hash, inst.id);
  return html`<article class="tk-tile${leg ? " legendary" : ""}${tier?.key ? ` t-${tier.key}` : ""}">
    ${media(imageOf(inst))}${tier ? html`<span class="tk-tier-on" aria-hidden="true">${tierPill(inst.metadata)}</span>` : ""}
    <div class="tk-tb">
      <a class="tk-tl" href="${href}" aria-label="${nm.full}${cat ? `, ${cat}` : ""}"><span class="nm">${nm.base}</span><span class="id">#${inst.id}</span></a>
      ${cat ? html`<span class="tk-cat">${cat}${leg ? html` <span class="tk-star" aria-hidden="true">·</span> 1/1` : ""}</span>` : ""}
      ${o.owner === false ? "" : html`<span class="tk-own">${inst.owner ? addrChip(inst.owner, { copy: false }) : dash("Owner not reported by the index")}</span>`}
    </div>
  </article>`;
}
export const tileGrid = (tiles: Html[], cls = "") => html`<div class="tk-grid${cls ? " " + cls : ""}">${tiles}</div>`;

/* ------------------------------------------------------------------ chain reads (no ethers) */

export const SEL = {
  name: "0x06fdde03", symbol: "0x95d89b41", decimals: "0x313ce567", totalSupply: "0x18160ddd",
  cap: "0x355274ea", MAX_ID: "0x17bac052", maxSupply: "0xd5abeb01", totalIds: "0x390a5ba5", paused: "0x5c975abb", owner: "0x8da5cb5b",
  minted: "0x7dc0bf3f", ownerOf: "0x6352211e", tokenURI: "0xc87b56dd",
} as const;
const word = (n: bigint | number | string) => BigInt(n).toString(16).padStart(64, "0");
/** Calldata for `sel(uint256)`. */
export const withUint = (sel: string, n: bigint | number | string) => sel + word(n);

/** eth_call, cached 60 s per (to, data); calls made in the same tick share one JSON-RPC batch. */
export function chainRead(to: string, data: string, signal?: AbortSignal): Promise<string> {
  return swr<string>(`rpc:eth_call:${lc(to)}:${data}`, 60_000, (s) => rpc.ethCall(to, data, s), { signal });
}
const body = (hex: string) => (hex && hex.length >= 66 ? hex.slice(2) : null);
export const decUint = (hex: string): bigint | null => { const b = body(hex); return b ? BigInt("0x" + b.slice(0, 64)) : null; };
export const decBool = (hex: string): boolean | null => { const v = decUint(hex); return v === null ? null : v !== 0n; };
export const decAddr = (hex: string): string | null => { const b = body(hex); return b ? "0x" + b.slice(24, 64) : null; };
export function decString(hex: string): string | null {
  const b = body(hex);
  if (!b || b.length < 128) return null;
  try {
    const off = Number(BigInt("0x" + b.slice(0, 64))) * 2;
    const len = Number(BigInt("0x" + b.slice(off, off + 64))) * 2;
    const data = b.slice(off + 64, off + 64 + len);
    if (data.length !== len) return null;
    const bytes = new Uint8Array(len / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(data.slice(i * 2, i * 2 + 2), 16);
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch { return null; }
}
const settle = async <T>(p: Promise<T>): Promise<T | null> => { try { return await p; } catch (e) { if (e instanceof DOMException && e.name === "AbortError") throw e; return null; } };

/** The cap from the contract: FRC-721 MAX_ID() (else maxSupply(), else totalIds() — the ids a growing collection
 *  has so far), FRC-20 cap(). null = the contract has none (or the RPC is down: `down` tells them apart). */
export async function capOf(t: TokenInfo, signal?: AbortSignal): Promise<{ cap: bigint | null; down: boolean; fn: string | null }> {
  const fns: (keyof typeof SEL)[] = isNft(t) ? ["MAX_ID", "maxSupply", "totalIds"] : ["cap"];
  const res = await Promise.all(fns.map((f) => chainRead(t.address_hash, SEL[f], signal).then((r) => ({ ok: true as const, r }), (e: unknown) => {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    const rpcErr = e as { kind?: string };
    return { ok: false as const, down: rpcErr?.kind !== "rpc" };
  })));
  for (let i = 0; i < fns.length; i++) {
    const r = res[i];
    if (r.ok) { const v = decUint(r.r); if (v !== null && v > 0n) return { cap: v, down: false, fn: fns[i] }; }
  }
  return { cap: null, down: res.every((r) => !r.ok && r.down), fn: null };
}

export interface ReadRow { fn: string; value: Html; raw: string }
/** The zero-argument reads for the Contract tab: standard ones always, optional ones only when they answer. */
export async function tokenReads(t: TokenInfo, signal?: AbortSignal): Promise<{ rows: ReadRow[]; down: boolean }> {
  const nft = isNft(t);
  const d = decimalsOf(t);
  type F = { fn: keyof typeof SEL; kind: "str" | "uint" | "bool" | "addr" | "supply"; optional?: boolean };
  const plan: F[] = [
    { fn: "name", kind: "str" }, { fn: "symbol", kind: "str" },
    ...(nft ? [] : [{ fn: "decimals", kind: "uint" } as F]),
    { fn: "totalSupply", kind: "supply" },
    ...(nft ? [{ fn: "MAX_ID", kind: "uint", optional: true } as F, { fn: "maxSupply", kind: "uint", optional: true } as F, { fn: "totalIds", kind: "uint", optional: true } as F] : [{ fn: "cap", kind: "supply", optional: true } as F]),
    { fn: "paused", kind: "bool", optional: true }, { fn: "owner", kind: "addr", optional: true },
  ];
  const out = await Promise.all(plan.map((p) => settle(chainRead(t.address_hash, SEL[p.fn], signal))));
  const rows: ReadRow[] = [];
  let answered = 0;
  plan.forEach((p, i) => {
    const r = out[i];
    if (r !== null) answered++;
    if (r === null || r === "0x") { if (!p.optional) rows.push({ fn: `${p.fn}()`, value: dash(r === null ? RPC_DOWN : "The contract returned nothing"), raw: "" }); return; }
    let v: Html | null = null;
    if (p.kind === "str") { const s = decString(r); v = s === null ? null : html`<span>${s}</span>`; }
    else if (p.kind === "bool") { const b = decBool(r); v = b === null ? null : html`<span class="num-mono">${String(b)}</span>`; }
    else if (p.kind === "addr") { const a = decAddr(r); v = a === null ? null : addrChip(a); }
    else if (p.kind === "uint") { const n = decUint(r); v = n === null ? null : html`<span class="num-mono">${int(n)}</span>`; }
    else { const n = decUint(r); v = n === null ? null : nft || d === null ? html`<span class="num-mono">${int(n)}</span>` : html`<span class="num-mono">${amountExact(n, d)}</span>${t.symbol ? html`<span class="unit">${t.symbol}</span>` : ""}`; }
    if (v === null) { if (!p.optional) rows.push({ fn: `${p.fn}()`, value: dash("Could not decode the answer"), raw: r }); return; }
    rows.push({ fn: `${p.fn}()`, value: v, raw: r });
  });
  return { rows, down: answered === 0 };
}

/* ------------------------------------------------------------------ tokens the index hasn't catalogued yet */

/** The mint page's list of free ids, from the book's mintUrl ("…?id={id}" → "…?filter=available"). */
export function mintListUrl(mintUrl: string | null | undefined): string | null {
  if (!mintUrl) return null;
  try { const u = new URL(mintUrl.replace("{id}", "0")); u.search = "?filter=available"; return safeHref(u.href) === "#" ? null : u.href; } catch { return null; }
}

export interface ChainToken {
  /** The token as the index would describe it, every field read from the chain (holders_count stays null). */
  token: TokenInfo;
  /** totalSupply(): the tokens minted (FRC-721) or the raw supply (FRC-20). null = the contract has none. */
  supply: bigint | null;
  /** The book's mint page for one id ("…?id={id}"), for collections anyone can mint from. */
  mintUrl: string | null;
}
const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";
/** A token the explorer's index hasn't catalogued yet. The index lists an FRC-721 only after its first Transfer, so
 *  a new collection with nothing minted is a 404 there. The address is a token when the contract book says so
 *  (kind "token") or its code passes the FRC-165 test for FRC-721 (classify.ts). name(), symbol(), totalSupply() and
 *  decimals() ride in the same JSON-RPC batch as the probes; the cap comes from capOf(). Returns null when it
 *  isn't a token, and "down" when the chain RPC didn't answer at all (the question stays open). */
export async function chainToken(a: string, signal?: AbortSignal): Promise<ChainToken | null | "down"> {
  const known = knownContract(a);
  const res = await Promise.all([FRC721_PROBE, FRC165_INVALID, SEL.name, SEL.symbol, SEL.totalSupply, SEL.decimals].map((d) =>
    chainRead(a, d, signal).then((r) => ({ r, down: false }), (e: unknown) => {
      if (isAbort(e)) throw e;
      return { r: null, down: (e as { kind?: string })?.kind !== "rpc" }; // "rpc" = the call reverted: the function isn't there
    })));
  if (res.every((x) => x.down)) return "down";
  const [probe, invalid, nm, sym, ts, dec] = res.map((x) => x.r);
  const std = classify(probe, invalid, dec, known?.kind === "token");
  if (!std) return null;
  const str = (h: string | null) => { const v = h ? decString(h)?.trim() : null; return v ? v : null; };
  const supply = ts ? decUint(ts) : null;
  const token: TokenInfo = {
    address_hash: known?.address ?? a,
    name: str(nm) ?? (known ? known.short ?? known.name : null),
    symbol: str(sym),
    type: std.type,
    decimals: std.decimals === null ? null : String(std.decimals),
    total_supply: supply === null ? null : supply.toString(),
    holders_count: null,
    icon_url: null,
  };
  return { token, supply, mintUrl: known?.mintUrl ?? null };
}

/* ------------------------------------------------------------------ agent token card (§4.14 compact) */

export function agentTokenCard(tok: AgentToken, agent: Agent | undefined): Html {
  const id = agent?.id ?? tok.agentId;
  const name = agent?.name ?? tok.agentName;
  const links = agentLinks(id);
  const rating = agent && agent.ratingAvg !== null && agent.ratingCount > 0
    ? html`<span><span aria-hidden="true">★</span> <span class="fig">${agent.ratingAvg.toFixed(1)}</span> <span class="faint">(${agent.ratingCount})</span></span>`
    : agent ? html`<span class="faint">no ratings yet</span>` : "";
  return html`<section class="tk-agent" aria-label="Agent token">
    <span class="who">${icon("i-bot", "", 16)}<span>Agent token of <a href="/address/${agent?.owner ?? tok.owner}?tab=jobs"><strong>${name}</strong> <span class="id">#${id}</span></a></span></span>
    ${agent ? agentStatusPill(agent.status) : ""}
    ${agent ? html`<span><span class="fig">${int(agent.jobsCompleted)}</span> ${agent.jobsCompleted === 1 ? "job" : "jobs"} completed</span>` : ""}
    ${rating}
    <span class="faint">launched ${ago(tok.launchedAt)}</span>
    <a class="link-arrow end" href="${links.record}" rel="noopener" data-external>Agent record ↗</a>
  </section>`;
}

/* ------------------------------------------------------------------ small bits */

/** The identity-line address: full on desktop, short on phones (one of the two is display:none). */
export const identAddr = (a: string) =>
  html`<span class="tk-addr-full">${addrChip(a, { label: false, full: true })}</span><span class="tk-addr-short">${addrChip(a, { label: false, n: 6 })}</span>`;

/** A labelled stat cell (label, value, optional sub-line). */
export const stat = (label: Html | string, value: Html, sub?: Html | string | null) =>
  html`<div><span class="l">${label}</span><span class="v">${value}</span>${sub && String(sub) ? html`<span class="s">${sub}</span>` : ""}</div>`;
/** "2 of 41 minted" with a 4 px bar. */
export function progress(n: bigint | null, of: bigint | null): Html {
  if (n === null || of === null || of <= 0n) return html``;
  const p = Number((n * 10_000n) / of) / 100;
  return html`<span class="tk-prog"><span class="bar" aria-hidden="true"><i style="--p:${Math.min(1, p / 100)}"></i></span><span>${int(n)} of ${int(of)} minted</span></span>`;
}
export const pillFor = (text: string | null, accent = false) => (text ? pill(text, accent ? "accent" : "") : html``);
export { big };

/* Lift into ui/ when a second page needs them: transfersTable (the address page's Token transfers tab is
   the same table plus a Token column), nftTile + bindMedia (the address page's FRC-721 Tokens tab), and
   chainRead + the decoders (the Contract tab's zero-argument reads, §5.7). */
