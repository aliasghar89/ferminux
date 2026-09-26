import { config, contractsDeployed, explorerAddr, explorerTx } from "./config";
import { esc, short } from "./format";
import { connect, connectedWalletName, disconnect, errMessage, hasInjected, isMobile, onWallet, restore, walletDeepLinks, walletState } from "./wallet";
import { initMotion } from "./motion";

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T | null;
export const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => Array.from(root.querySelectorAll(sel)) as T[];
export const h = (html: string) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild as HTMLElement; };

let toastEl: HTMLElement | null = null; let toastT = 0;
/** The live region exists, empty, before the first message (initChrome makes it), so screen readers announce the first toast too. */
function toastRegion(): HTMLElement {
  if (!toastEl) { toastEl = h(`<div class="toast" role="status" aria-live="polite"></div>`); document.body.appendChild(toastEl); }
  return toastEl;
}
export function toast(msg: string) {
  const el = toastRegion();
  el.textContent = "";
  requestAnimationFrame(() => { el.textContent = msg; el.classList.add("show"); });
  clearTimeout(toastT); toastT = window.setTimeout(() => el.classList.remove("show"), 1600);
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
/** Decorative status dot. When no visible "online"/"offline" text sits beside it, put onlineSr() after the name. */
export const onlineDot = (online: boolean | undefined | null, title = "") =>
  `<span class="status-dot ${online ? "ok" : "off"}" aria-hidden="true" title="${esc(title || (online ? "Online — health probe succeeded" : "Offline — last health probe failed"))}"></span>`;
/** Screen-reader status that follows the agent's name (", online"), so links read and sort by name. */
export const onlineSr = (online: boolean | undefined | null) => `<span class="vh">, ${online ? "online" : "offline"}</span>`;

/**
 * Connect prompt for pages that need a wallet. The button opens the wallet chooser (Ferminux Wallet works in
 * any browser, phones included); a phone without a wallet app's browser also keeps the links that reopen the
 * page inside MetaMask or Trust Wallet, which come back to the same URL.
 */
export function connectPrompt(id: string): string {
  const deep = isMobile() && !hasInjected()
    ? `<div class="deep-links"><span class="small faint">Or open this page in your wallet app:</span><div class="deep-row">${walletDeepLinks().slice(0, 2).map((l) => `<a class="btn btn-secondary" href="${l.url}" rel="noopener">${esc(l.name)}</a>`).join("")}</div></div>`
    : "";
  return `<button class="btn btn-primary" type="button" id="${id}">Connect wallet</button>${deep}`;
}

/**
 * Keyboard model for a role=tablist: one Tab stop (roving tabindex), ArrowLeft/Right and Home/End move
 * focus and select. `onSelect` runs for arrow keys too; clicks keep their own handlers.
 */
export function wireTabs(list: HTMLElement | null, onSelect?: (t: HTMLElement) => void) {
  if (!list) return;
  const tabs = () => Array.from(list.querySelectorAll<HTMLElement>("[role=tab]"));
  const sync = () => tabs().forEach((t) => { t.tabIndex = t.getAttribute("aria-selected") === "true" ? 0 : -1; });
  sync();
  list.addEventListener("click", () => requestAnimationFrame(sync));
  list.addEventListener("keydown", (e) => {
    const l = tabs(); const i = l.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    const j = e.key === "ArrowRight" ? (i + 1) % l.length : e.key === "ArrowLeft" ? (i - 1 + l.length) % l.length : e.key === "Home" ? 0 : e.key === "End" ? l.length - 1 : -1;
    if (j < 0) return;
    e.preventDefault();
    const t = l[j];
    l.forEach((x) => x.setAttribute("aria-selected", String(x === t)));
    sync(); t.focus();
    if (onSelect) onSelect(t); else t.click();
  });
}

/** Wire header nav toggle, copy buttons (delegated), wallet chip, footer meta, deploy banner. */
export function initChrome(opts: { banner?: boolean } = {}) {
  initMotion();
  const toggle = $("button.nav-toggle"); const nav = $("#site-nav");
  // The header partial keeps the page behind an open sheet inert and moves focus into it.
  toggle?.addEventListener("click", () => { const open = nav!.classList.toggle("open"); toggle.setAttribute("aria-expanded", String(open)); });
  toastRegion();
  document.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-copy]"); if (b) { e.preventDefault(); copyText(b.dataset.copy!, b); }
  });
  const chip = $("#nav-wallet");
  if (chip) {
    // Connected: the chip opens a small menu naming the wallet, with Disconnect.
    const closeMenu = () => { $(".wallet-menu", chip)?.remove(); $(".wallet-chip", chip)?.setAttribute("aria-expanded", "false"); };
    // Wallet events fire for more than address changes; re-render only when what the chip shows changed,
    // so an open menu is not torn down under the pointer.
    let shown = "";
    const render = () => {
      const s = walletState();
      const key = `${s.address ?? ""}|${s.chainId === config.chainId}`;
      if (key === shown && chip.firstElementChild) return;
      shown = key;
      // Phones under 375 px drop " wallet" from the label and, under 360, shorten the address: the header's
      // brand, menu and wallet control must fit 320 px without scrolling sideways (styles.css, "header fit").
      if (s.address) chip.innerHTML = `<button type="button" class="wallet-chip" id="nav-wallet-chip" aria-haspopup="menu" aria-expanded="false" title="${esc(s.address)}"><span class="status-dot ${s.chainId === config.chainId ? "ok" : "bad"}" aria-hidden="true"></span><span class="wc-addr">${esc(short(s.address))}</span><span class="wc-addr-s">${esc(short(s.address, 2))}</span></button>`;
      else chip.innerHTML = `<button class="btn btn-secondary btn-sm" type="button" id="nav-connect" aria-label="Connect wallet"><span>Connect<span class="nw-more"> wallet</span></span></button>`;
      $("#nav-connect", chip)?.addEventListener("click", async (ev) => {
        const b = ev.currentTarget as HTMLButtonElement; b.disabled = true;
        try { await connect(); } catch (e) { toast(errMessage(e)); } finally { b.disabled = false; }
      });
      $("#nav-wallet-chip", chip)?.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if ($(".wallet-menu", chip)) return closeMenu();
        const addr = walletState().address; if (!addr) return;
        const menu = h(`<div class="wallet-menu" role="menu" aria-label="Wallet">
          <div class="wallet-menu-head"><span class="faint">${esc(connectedWalletName() ?? "Wallet")}</span><span class="mono">${esc(addr)}</span></div>
          <button type="button" class="wallet-menu-item" role="menuitem" data-copy="${esc(addr)}">Copy address</button>
          <button type="button" class="wallet-menu-item" role="menuitem" id="nav-disconnect">Disconnect</button>
        </div>`);
        chip.appendChild(menu);
        (ev.currentTarget as HTMLElement).setAttribute("aria-expanded", "true");
        $("#nav-disconnect", menu)?.addEventListener("click", async () => { closeMenu(); await disconnect(); toast("Wallet disconnected"); });
        ($("button", menu) as HTMLButtonElement | null)?.focus();
      });
    };
    document.addEventListener("click", (e) => { if (!(e.target as HTMLElement).closest?.(".wallet-menu")) closeMenu(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $(".wallet-menu", chip)) { closeMenu(); $("#nav-wallet-chip", chip)?.focus(); } });
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
  container.innerHTML = `<div class="rating" role="radiogroup" aria-label="Rating">${[1, 2, 3, 4, 5].map((n) => `<button type="button" role="radio" aria-checked="${n === value}" tabindex="${n === value ? 0 : -1}" aria-label="${n} star${n > 1 ? "s" : ""}" data-n="${n}">★</button>`).join("")}</div>`;
  const group = $(".rating", container)!;
  const btns = $$("button", container) as HTMLButtonElement[];
  // Fill is visual only (class "on"); the checked state stays on the one chosen star.
  const paint = (v: number) => btns.forEach((b) => b.classList.toggle("on", Number(b.dataset.n) <= v));
  const choose = (v: number, focus = false) => {
    value = v; paint(v);
    btns.forEach((b) => { const on = Number(b.dataset.n) === v; b.setAttribute("aria-checked", String(on)); b.tabIndex = on ? 0 : -1; if (on && focus) b.focus(); });
  };
  choose(value);
  btns.forEach((b) => {
    b.addEventListener("click", () => choose(Number(b.dataset.n)));
    b.addEventListener("mouseenter", () => paint(Number(b.dataset.n)));
    b.addEventListener("mouseleave", () => paint(value));
  });
  group.addEventListener("keydown", (e) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    choose(Math.min(5, Math.max(1, value + step)), true);
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
