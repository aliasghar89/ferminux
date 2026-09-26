/* The hash chip (§4.1): one component for addresses, tx hashes and block hashes.
   Anatomy: [kind glyph] [label] [#id] [short hash] [copy]. Label + hash form ONE link; copy is a sibling.
   The full value is in `title` and in a .vh span. Unnamed: the short hash alone, in --ink.
   Hovering or focusing a chip outlines every chip with the same address (one delegated listener). */
import { html, type Html, dash } from "./html";
import { icon, type IconId } from "./icons";
import { copyBtn } from "./copy";
import { short, int } from "../format";
import { label as bookLabel, type Label, type LabelKind } from "../book";
import { signerNo } from "../signer";
import type { AddressParam } from "../types";
import { lc, ZERO } from "../util";

const GLYPH: Partial<Record<LabelKind, IconId>> = { contract: "i-file-code", token: "i-coins", account: "i-landmark", agent: "i-bot", "agent-wallet": "i-bot" };

export interface ChipOpts {
  /** false = never look up a name (e.g. a signer row that already shows the seal). */
  label?: Label | null | false;
  /** Link target (default /address/:a). null = no link. */
  href?: string | null;
  copy?: boolean;
  /** Characters kept on each side of the short hash. */
  n?: number;
  /** Show the full address instead of the short one (detail pages). */
  full?: boolean;
}

function glyph(l: Label): Html {
  if (l.kind === "signer") return html`<span class="seal seal-sm out" aria-hidden="true">${l.id ?? "?"}</span>`;
  const id = GLYPH[l.kind];
  return id ? icon(id, "hc-g", 12) : html``;
}

/** An address chip. Accepts a bare address or the index's AddressParam (its `name` is resolution step 7). */
export function addrChip(a: string | AddressParam | null | undefined, o: ChipOpts = {}): Html {
  const hash = typeof a === "string" ? a : a?.hash;
  if (!hash) return dash();
  if (lc(hash) === ZERO) return html`<span class="hc hc-zero" data-addr="${lc(hash)}" title="${hash}"><span class="hc-h">${short(hash, 4)}</span></span> <span class="tag">none</span>`;
  const l = o.label === false ? null : o.label ?? bookLabel(hash, typeof a === "string" ? null : a?.name);
  const h = o.full ? hash : short(hash, o.n ?? 4);
  const href = o.href === undefined ? `/address/${hash}` : o.href;
  const hs = html`<span class="hc-h${o.full ? " hc-hf" : ""}">${h}</span>`;
  // a named full chip also carries the short hash: phones show name + short (the name identifies it; the full
  // value is in the title, the link and the copy button), wide screens the full hash
  const inner = l ? html`${labelHtml(l)}${hs}${o.full ? html`<span class="hc-h hc-hs" aria-hidden="true">${short(hash, 6)}</span>` : ""}` : hs;
  const name = l ? `${l.name}, ${hash}` : hash;
  const body = href ? html`<a href="${href}" title="${hash}" aria-label="${name}">${inner}</a>` : html`<span class="hc-t" title="${hash}">${inner}</span>`;
  // an unnamed chip that looked the book up may be named later (relabelChips, when the gateway lists land)
  const later = !l && o.label === undefined;
  return html`<span class="hc" data-addr="${lc(hash)}"${later ? html` data-relabel` : ""}>${body}${o.copy === false ? "" : copyBtn(hash, `Copy address ${short(hash, 4)}`)}</span>`;
}

const labelHtml = (l: Label): Html =>
  html`${glyph(l)}<span class="hc-n">${l.name}</span>${l.kind === "agent" || l.kind === "agent-wallet" ? (l.id ? html`<span class="hc-id">#${l.id}</span>` : "") : ""}${l.more ? html`<span class="hc-id">+${l.more}</span>` : ""}`;

/** Name the unnamed chips under `root` that the name book can name now (it refreshes after first paint). */
export function relabelChips(root: ParentNode) {
  root.querySelectorAll<HTMLElement>(".hc[data-relabel]").forEach((chip) => {
    const a = chip.dataset.addr;
    const body = chip.querySelector<HTMLElement>(":scope > a, :scope > .hc-t");
    const h = body?.querySelector<HTMLElement>(":scope > .hc-h");
    if (!a || !body || !h) return;
    const l = bookLabel(a);
    if (!l) return;
    h.insertAdjacentHTML("beforebegin", labelHtml(l).s);
    const full = body.getAttribute("title") ?? a;
    if (body.hasAttribute("aria-label")) body.setAttribute("aria-label", `${l.name}, ${full}`);
    chip.removeAttribute("data-relabel");
  });
}

/** Phones: the width that splits a full hash into two even lines (see .hc-full in explorer.css). */
export const halfWidth = (v: string) => `--hw:${Math.ceil(v.length / 2)}ch`;

/** A transaction hash chip. */
export const txChip = (h: string | null | undefined, o: { copy?: boolean; n?: number; full?: boolean } = {}): Html =>
  !h ? dash() : html`<span class="hc"><a href="/tx/${h}" title="${h}" aria-label="Transaction ${h}"><span class="hc-h">${o.full ? h : short(h, o.n ?? 4)}</span></a>${o.copy ? copyBtn(h, `Copy transaction hash ${short(h, 4)}`) : ""}</span>`;

/** A block-hash chip (links to the block by hash). */
export const blockHashChip = (h: string | null | undefined, o: { copy?: boolean } = {}): Html =>
  !h ? dash() : html`<span class="hc"><a href="/block/${h}" title="${h}"><span class="hc-h">${short(h, 4)}</span></a>${o.copy ? copyBtn(h, `Copy block hash ${short(h, 4)}`) : ""}</span>`;

/** A block number link: "396,650" (URLs never carry commas). */
export const blockLink = (n: number | null | undefined, cls = "num-mono"): Html =>
  n === null || n === undefined ? dash() : html`<a class="${cls}" href="/block/${n}">${int(n)}</a>`;

/** Detail pages: the full value on its own line, wrapping, with copy. */
export const fullHash = (v: string, what = "Copy"): Html =>
  html`<span class="hc-full" style="${halfWidth(v)}">${v}</span>${copyBtn(v, what)}`;

/** "Signer 1" for a known signer address, else null (for sentences). */
export const signerLabel = (a: string) => { const k = signerNo(a); return k ? `Signer ${k}` : null; };

/** Same-address highlight (desktop, pointer or keyboard focus): instant, no transition. */
export function initHighlight() {
  if (!matchMedia("(hover: hover) and (pointer: fine)").matches) return;
  let on = "";
  const set = (addr: string) => {
    if (addr === on) return;
    if (on) document.querySelectorAll(`[data-addr="${CSS.escape(on)}"].hl`).forEach((e) => e.classList.remove("hl"));
    on = addr;
    if (addr) {
      const all = document.querySelectorAll(`[data-addr="${CSS.escape(addr)}"]`);
      if (all.length > 1) all.forEach((e) => e.classList.add("hl"));
    }
  };
  const find = (t: EventTarget | null) => ((t as Element | null)?.closest?.("[data-addr]") as HTMLElement | null)?.dataset.addr ?? "";
  document.addEventListener("pointerover", (e) => set(find(e.target)));
  document.addEventListener("focusin", (e) => set(find(e.target)));
}
