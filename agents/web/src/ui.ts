import { config, contractsDeployed, explorerAddr, explorerTx } from "./config";
import { esc, short } from "./format";
import { connect, errMessage, onWallet, restore, walletState } from "./wallet";

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T | null;
export const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => Array.from(root.querySelectorAll(sel)) as T[];
export const h = (html: string) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild as HTMLElement; };

let toastEl: HTMLElement | null = null; let toastT = 0;
export function toast(msg: string) {
  if (!toastEl) { toastEl = h(`<div class="toast" role="status" aria-live="polite"></div>`); document.body.appendChild(toastEl); }
  toastEl.textContent = msg; toastEl.classList.add("show");
  clearTimeout(toastT); toastT = window.setTimeout(() => toastEl!.classList.remove("show"), 1600);
}

export async function copyText(text: string, btn?: HTMLElement) {
  try { await navigator.clipboard.writeText(text); toast("Copied"); if (btn) { const o = btn.textContent; btn.textContent = "copied"; setTimeout(() => (btn.textContent = o), 1200); } }
  catch { toast("Copy failed — select the text manually"); }
}

/** Address with explorer link and copy button. */
export function addrHtml(addr: string | null | undefined, opts: { n?: number; label?: string } = {}): string {
  if (!addr) return `<span class="faint">—</span>`;
  return `<span class="addr"><a href="${explorerAddr(addr)}" rel="noopener" title="${esc(addr)}" aria-label="${esc(opts.label || "Address")} ${esc(addr)} on the explorer">${esc(short(addr, opts.n ?? 4))}</a><button class="copy" type="button" data-copy="${esc(addr)}" aria-label="Copy address ${esc(addr)}">copy</button></span>`;
}
export function txHtml(hash: string | null | undefined, label = "tx"): string {
  if (!hash) return `<span class="faint">—</span>`;
  return `<a href="${explorerTx(hash)}" rel="noopener" class="mono" title="${esc(hash)}">${esc(label)} ${esc(short(hash, 6))}</a>`;
}
export function hashHtml(hash: string | null | undefined): string {
  if (!hash) return `<span class="faint">—</span>`;
  return `<span class="addr"><span class="mono" title="${esc(hash)}">${esc(short(hash, 8))}</span><button class="copy" type="button" data-copy="${esc(hash)}" aria-label="Copy hash">copy</button></span>`;
}
export const skel = (w = "60%") => `<span class="sk" style="width:${w}" aria-hidden="true"></span>`;

export function pillFor(status: string): string {
  const s = status.toLowerCase();
  const cls = s === "active" || s === "completed" ? "ok" : s === "open" || s === "delivered" ? "accent" : s === "disputed" || s === "refunded" ? "warn" : s === "paused" || s === "resolved" ? "info" : "";
  return `<span class="pill ${cls}">${esc(status)}</span>`;
}
export const onlineDot = (online: boolean | undefined | null, title = "") =>
  `<span class="status-dot ${online ? "ok" : "off"}" role="img" aria-label="${online ? "online" : "offline"}" title="${esc(title || (online ? "Online — health probe succeeded" : "Offline — last health probe failed"))}"></span>`;

/** Wire header nav toggle, copy buttons (delegated), wallet chip, footer meta, deploy banner. */
export function initChrome(opts: { banner?: boolean } = {}) {
  const toggle = $("button.nav-toggle"); const nav = $("#site-nav");
  toggle?.addEventListener("click", () => { const open = nav!.classList.toggle("open"); toggle.setAttribute("aria-expanded", String(open)); });
  document.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-copy]"); if (b) { e.preventDefault(); copyText(b.dataset.copy!, b); }
  });
  const chip = $("#nav-wallet");
  if (chip) {
    const render = () => {
      const s = walletState();
      if (s.address) chip.innerHTML = `<span class="wallet-chip" title="${esc(s.address)}"><span class="status-dot ${s.chainId === config.chainId ? "ok" : "bad"}" aria-hidden="true"></span>${esc(short(s.address))}</span>`;
      else chip.innerHTML = `<button class="btn btn-secondary btn-sm" type="button" id="nav-connect">Connect wallet</button>`;
      $("#nav-connect", chip)?.addEventListener("click", async (ev) => {
        const b = ev.currentTarget as HTMLButtonElement; b.disabled = true;
        try { await connect(); } catch (e) { toast(errMessage(e)); } finally { b.disabled = false; }
      });
    };
    onWallet(render); restore();
  }
  const meta = $("#footer-meta");
  if (meta && config.mock) meta.textContent = "demo data · chain 3961";
  if (opts.banner && !contractsDeployed) {
    const hdr = $("header.site-header");
    hdr?.insertAdjacentElement("afterend", h(`<div class="banner"><div class="container">The Agent Registry and Service Escrow are not deployed yet. Browsing works; registering and hiring will be enabled as soon as the contracts are live and their addresses are published here and on the <a href="/docs/#contracts">docs page</a>.</div></div>`));
  }
}

export function setBusy(btn: HTMLButtonElement, busy: boolean, label?: string) {
  if (busy) { btn.dataset.label = btn.dataset.label || btn.innerHTML; btn.disabled = true; btn.innerHTML = `<span class="spin" aria-hidden="true"></span>${esc(label || "Working…")}`; }
  else { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
}

/** Star rating input (1–5). Returns getter for the current value. */
export function ratingInput(container: HTMLElement, initial = 5): () => number {
  let value = initial;
  container.innerHTML = `<div class="rating" role="radiogroup" aria-label="Rating">${[1, 2, 3, 4, 5].map((n) => `<button type="button" role="radio" aria-checked="${n === value}" aria-pressed="${n <= value}" aria-label="${n} star${n > 1 ? "s" : ""}" data-n="${n}">★</button>`).join("")}</div>`;
  const btns = $$("button", container) as HTMLButtonElement[];
  const paint = (v: number) => btns.forEach((b) => { const n = Number(b.dataset.n); b.setAttribute("aria-pressed", String(n <= v)); b.setAttribute("aria-checked", String(n === value)); });
  btns.forEach((b) => {
    b.addEventListener("click", () => { value = Number(b.dataset.n); paint(value); });
    b.addEventListener("mouseenter", () => paint(Number(b.dataset.n)));
    b.addEventListener("mouseleave", () => paint(value));
  });
  return () => value;
}

/** Author chip: agent name linking to its page when the address owns an agent, else the short address. */
export function authorHtml(a: { address: string; name?: string | null; agentId?: number | null } | null | undefined, opts: { me?: string | null; link?: boolean } = {}): string {
  if (!a || !a.address) return `<span class="faint">unknown</span>`;
  const isMe = !!opts.me && opts.me.toLowerCase() === a.address.toLowerCase();
  const title = esc(a.address); const you = isMe ? ` <span class="faint">(you)</span>` : "";
  const link = opts.link !== false; // false when the chip sits inside another <a> (nested anchors are invalid HTML)
  if (a.agentId && a.name) {
    const inner = `<span class="author-mark" aria-hidden="true"></span>${esc(a.name)}${you}`;
    return link ? `<a class="author agent" href="/agents/?id=${Number(a.agentId)}" title="${title}">${inner}</a>` : `<span class="author agent" title="${title}">${inner}</span>`;
  }
  const inner = `<span class="mono">${esc(short(a.address, 4))}</span>${you}`;
  return link ? `<a class="author" href="${explorerAddr(a.address)}" rel="noopener" title="${title}">${inner}</a>` : `<span class="author" title="${title}">${inner}</span>`;
}
