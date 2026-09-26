/* Client-side routing with the History API (surfaces/explorer.md §3.4–§3.7, §7.6, §10, §12).
   - The route table answers every Blockscout URL shape, so every inbound link keeps working.
   - Legacy shapes redirect (replace) here AND in nginx with a 307, so direct hits and in-app clicks agree.
   - One delegated click handler on a[href^="/"]; backend paths (/api, /socket) and files pass through.
   - Each navigation aborts the previous page's AbortController: a late response never paints into the
     wrong page. Pages are lazy chunks; the shell and skeleton paint in the same frame as the click.
   - Focus moves to the h1, a polite region says "{title}, loaded", scroll resets (or restores on back). */
import { withTransition, calm } from "./motion";
import { api } from "./api";
import { showError } from "./ui/state";

export type Params = Record<string, string>;
/** Every page module exports this. `root` is <main>, already emptied. Paint a skeleton synchronously,
 *  then fetch with `signal`; after an await, check `signal.aborted` before touching the DOM. */
export interface PageModule { render(params: Params, query: URLSearchParams, signal: AbortSignal, root: HTMLElement): void | Promise<void> }

export type PageKey =
  | "home" | "blocks" | "block" | "countdown" | "txs" | "tx" | "address" | "verify" | "tokens" | "token" | "instance"
  | "accounts" | "contracts" | "stats" | "search" | "tokenTransfers" | "internalTxs" | "apiDocs" | "validators" | "validatorSeat" | "notFound";
export type Section = "blocks" | "txs" | "tokens" | "accounts" | "contracts" | "stats" | "api" | "validators" | null;

const PAGES: Record<PageKey, () => Promise<PageModule>> = {
  home: () => import("./pages/home"),
  blocks: () => import("./pages/blocks"),
  block: () => import("./pages/block"),
  countdown: () => import("./pages/countdown"),
  txs: () => import("./pages/txs"),
  tx: () => import("./pages/tx"),
  address: () => import("./pages/address"),
  verify: () => import("./pages/verify"),
  tokens: () => import("./pages/tokens"),
  token: () => import("./pages/token"),
  instance: () => import("./pages/nft"),
  accounts: () => import("./pages/accounts"),
  contracts: () => import("./pages/contracts"),
  stats: () => import("./pages/stats"),
  search: () => import("./pages/search"),
  tokenTransfers: () => import("./pages/tokenTransfers"),
  internalTxs: () => import("./pages/internalTxs"),
  apiDocs: () => import("./pages/apiDocs"),
  validators: () => import("./pages/validators"),
  validatorSeat: () => import("./pages/validators/seat"),
  notFound: () => import("./pages/notFound"),
};

/* ---------------------------------------------------------------- route table (§3.4) */

interface Route { page: PageKey; re: RegExp; keys: string[]; section: Section; title: string }
function R(pattern: string, page: PageKey, section: Section, title: string): Route {
  const keys: string[] = [];
  const src = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:(\w+)/g, (_, k: string) => { keys.push(k); return "([^/]+)"; });
  return { page, re: new RegExp(`^${src}$`, "i"), keys, section, title };
}
export const HOME_TITLE = "Ferminux Explorer · blocks, transactions and agents on chain 3961";
const ROUTES: Route[] = [
  R("/", "home", null, HOME_TITLE),
  R("/blocks", "blocks", "blocks", "Blocks"),
  R("/block/countdown", "countdown", "blocks", "Block countdown"),
  R("/block/countdown/:n", "countdown", "blocks", "Block countdown"),
  R("/block/:id", "block", "blocks", "Block"),
  R("/txs", "txs", "txs", "Transactions"),
  R("/tx/:hash", "tx", "txs", "Transaction"),
  R("/address/:addr/contract-verification", "verify", "contracts", "Verify a contract"),
  R("/address/:addr/contract_verification", "verify", "contracts", "Verify a contract"),
  R("/address/:addr", "address", "accounts", "Address"),
  R("/tokens", "tokens", "tokens", "Tokens"),
  R("/token/:addr/instance/:id", "instance", "tokens", "Token"),
  R("/token/:addr", "token", "tokens", "Token"),
  R("/accounts", "accounts", "accounts", "Accounts"),
  R("/verified-contracts", "contracts", "contracts", "Contracts"),
  R("/stats", "stats", "stats", "Network stats"),
  R("/search-results", "search", null, "Search"),
  R("/token-transfers", "tokenTransfers", "txs", "Token transfers"),
  R("/internal-txs", "internalTxs", "txs", "Internal transactions"),
  R("/contract-verification", "verify", "contracts", "Verify a contract"),
  R("/contract_verification", "verify", "contracts", "Verify a contract"),
  R("/api-docs", "apiDocs", "api", "API"),
  // Step 1 checkpoint validators; dark until VALIDATORS_ENABLED (validators/config.ts): both pages render
  // notFound() themselves while the hub isn't configured. nginx (deploy/proxy/default.conf, $spa_route 2)
  // serves these two shapes from validators.html, which the build writes only when the hub is configured,
  // so a build without it keeps them real 404s.
  R("/validators", "validators", "validators", "Validators"),
  R("/validators/:id", "validatorSeat", "validators", "Validator seat"),
];

/* ---------------------------------------------------------------- redirects (§3.4 tail, §3.6) */

type To = (m: RegExpMatchArray) => { path: string; tab?: string; hash?: string };
const L: [RegExp, To][] = [
  [/^\/gas-tracker$/i, () => ({ path: "/stats", hash: "#gas" })],
  [/^\/advanced-filter$/i, () => ({ path: "/txs" })],
  [/^\/charts$/i, () => ({ path: "/stats" })],
  [/^\/stats\/[^/]+$/i, () => ({ path: "/stats" })],
  [/^\/blocks\/([^/]+)$/i, (m) => ({ path: `/block/${m[1]}` })],
  [/^\/blocks?\/([^/]+)\/transactions$/i, (m) => ({ path: `/block/${m[1]}`, tab: "txs" })],
  [/^\/block\/([^/]+)\/withdrawals$/i, (m) => ({ path: `/block/${m[1]}` })],
  [/^\/uncles$/i, () => ({ path: "/blocks", tab: "uncles" })],
  [/^\/reorgs$/i, () => ({ path: "/blocks", tab: "reorgs" })],
  [/^\/pending-transactions$/i, () => ({ path: "/txs", tab: "pending" })],
  [/^\/tx\/([^/]+)\/internal-transactions$/i, (m) => ({ path: `/tx/${m[1]}`, tab: "internal" })],
  [/^\/tx\/([^/]+)\/logs$/i, (m) => ({ path: `/tx/${m[1]}`, tab: "logs" })],
  [/^\/tx\/([^/]+)\/token-transfers$/i, (m) => ({ path: `/tx/${m[1]}`, tab: "token_transfers" })],
  [/^\/tx\/([^/]+)\/raw-trace$/i, (m) => ({ path: `/tx/${m[1]}`, tab: "raw_trace" })],
  [/^\/tx\/([^/]+)\/state$/i, (m) => ({ path: `/tx/${m[1]}`, tab: "state" })],
  [/^\/address\/([^/]+)\/transactions$/i, (m) => ({ path: `/address/${m[1]}` })],
  [/^\/address\/([^/]+)\/tokens$/i, (m) => ({ path: `/address/${m[1]}`, tab: "tokens" })],
  [/^\/address\/([^/]+)\/token-transfers$/i, (m) => ({ path: `/address/${m[1]}`, tab: "token_transfers" })],
  [/^\/address\/([^/]+)\/internal-transactions$/i, (m) => ({ path: `/address/${m[1]}`, tab: "internal_txns" })],
  [/^\/address\/([^/]+)\/coin-balances$/i, (m) => ({ path: `/address/${m[1]}`, tab: "coin_balance_history" })],
  [/^\/address\/([^/]+)\/validations$/i, (m) => ({ path: `/address/${m[1]}`, tab: "blocks_validated" })],
  [/^\/address\/([^/]+)\/logs$/i, (m) => ({ path: `/address/${m[1]}`, tab: "logs" })],
  [/^\/address\/([^/]+)\/(contracts|read-contract|write-contract|read-proxy|write-proxy)$/i, (m) => ({ path: `/address/${m[1]}`, tab: "contract" })],
  [/^\/address\/([^/]+)\/(contract_verifications\/new|verify-via-flattened-code\/new)$/i, (m) => ({ path: `/address/${m[1]}/contract-verification` })],
  [/^\/tokens\/([^/]+)$/i, (m) => ({ path: `/token/${m[1]}` })],
  [/^\/token\/([^/]+)\/token-holders$/i, (m) => ({ path: `/token/${m[1]}`, tab: "holders" })],
  [/^\/token\/([^/]+)\/token-transfers$/i, (m) => ({ path: `/token/${m[1]}`, tab: "token_transfers" })],
  [/^\/token\/([^/]+)\/inventory$/i, (m) => ({ path: `/token/${m[1]}`, tab: "inventory" })],
  [/^\/token\/([^/]+)\/read-contract$/i, (m) => ({ path: `/token/${m[1]}`, tab: "contract" })],
  [/^\/token\/([^/]+)\/instance\/([^/]+)\/(token-transfers|token-holders)$/i, (m) => ({ path: `/token/${m[1]}/instance/${m[2]}` })],
  [/^\/token\/([^/]+)\/instance\/([^/]+)\/metadata$/i, (m) => ({ path: `/token/${m[1]}/instance/${m[2]}`, tab: "metadata" })],
  [/^\/bridged-tokens$/i, () => ({ path: "/tokens" })],
  [/^\/graphiql$/i, () => ({ path: "/api-docs", tab: "graphql_api" })],
];

/* ---------------------------------------------------------------- ?tab= map (§3.5) */

interface TabSpec { values: string[]; alias?: Record<string, string>; notes?: Record<string, string>; sub?: Record<string, string> }
/** Our tab keys ARE the index's values; aliases fold the extra ones in. null = the page's default tab. */
export const TABS: Partial<Record<PageKey, TabSpec>> = {
  tx: { values: ["token_transfers", "logs", "state"], notes: { internal: "internal", raw_trace: "raw_trace" } },
  block: { values: ["txs"], alias: { withdrawals: "" } },
  blocks: { values: ["reorgs", "uncles"] },
  txs: { values: ["pending"] },
  address: {
    values: ["txs", "token_transfers", "tokens", "coin_balance_history", "blocks_validated", "logs", "contract", "jobs"],
    alias: { tokens_erc20: "tokens", tokens_nfts: "tokens", read_contract: "contract", write_contract: "contract", read_proxy: "contract", write_proxy: "contract", internal_txns: "txs" },
    sub: { tokens_erc20: "FRC-20", tokens_nfts: "FRC-721" },
    notes: { internal_txns: "internal" },
  },
  token: { values: ["token_transfers", "holders", "inventory", "contract"], alias: { read_contract: "contract" } },
  instance: { values: ["token_transfers", "metadata"], alias: { holders: "token_transfers" } },
  tokens: { values: [], alias: { bridged: "" } },
  apiDocs: { values: ["graphql_api", "rpc_api"] },
};
export interface TabChoice { tab: string | null; note?: string; sub?: string }
/**
 * Read ?tab= for a page. Aliases map to our tab (and are rewritten in the URL); unknown values fall back to
 * the default and are removed with replaceState. `note` is set for the honest-gap values
 * (internal / raw_trace → Overview + the note). `sub` carries the FRC-20 / FRC-721 split of address tokens.
 */
export function resolveTab(page: PageKey, query: URLSearchParams): TabChoice {
  const v = query.get("tab");
  const spec = TABS[page];
  if (!v || !spec) return { tab: null };
  if (spec.values.includes(v)) return { tab: v };
  const note = spec.notes?.[v];
  const alias = spec.alias?.[v];
  const out: TabChoice = { tab: alias ? alias : null, note, sub: spec.sub?.[v] };
  if (note === undefined) {
    // rewrite to the canonical value (or drop it) without a new history entry
    const u = new URL(location.href);
    if (alias) u.searchParams.set("tab", alias); else u.searchParams.delete("tab");
    history.replaceState(history.state, "", u.pathname + u.search + u.hash);
  }
  return out;
}

/* ---------------------------------------------------------------- matching */

export interface Match { route: Route; params: Params }
function normalise(path: string): string {
  let p = path.replace(/\/{2,}/g, "/");
  if (p.length > 1) p = p.replace(/\/+$/, "");
  p = p.replace(/^\/block\/(\d{1,3}(?:,\d{3})+)$/i, (_, n: string) => `/block/${n.replace(/,/g, "")}`);
  return p || "/";
}
export function match(path: string): Match | null {
  for (const route of ROUTES) {
    const m = path.match(route.re);
    if (!m) continue;
    const params: Params = {};
    route.keys.forEach((k, i) => { try { params[k] = decodeURIComponent(m[i + 1]); } catch { params[k] = m[i + 1]; } });
    return { route, params };
  }
  return null;
}
function redirectFor(path: string, search: string): string | null {
  for (const [re, to] of L) {
    const m = path.match(re);
    if (!m) continue;
    const t = to(m);
    const q = new URLSearchParams(search);
    if (t.tab) q.set("tab", t.tab);
    const s = q.toString();
    return t.path + (s ? `?${s}` : "") + (t.hash ?? "");
  }
  return null;
}

/* ---------------------------------------------------------------- meta (§10) */

const ORIGIN = "https://explorer.ferminux.net";
function metaTag(sel: string, attr: string, key: string): HTMLMetaElement {
  let m = document.head.querySelector<HTMLMetaElement>(sel);
  if (!m) { m = document.createElement("meta"); m.setAttribute(attr, key); document.head.append(m); }
  return m;
}
export interface Meta { title: string; description?: string; noindex?: boolean; canonical?: string | null }
/** Title "{title} · Ferminux Explorer" (the home title stands alone), description, canonical, robots. */
export function setMeta(m: Meta) {
  const t = m.title === HOME_TITLE ? m.title : `${m.title} · Ferminux Explorer`;
  document.title = t;
  metaTag('meta[property="og:title"]', "property", "og:title").content = t;
  if (m.description) {
    metaTag('meta[name="description"]', "name", "description").content = m.description;
    metaTag('meta[property="og:description"]', "property", "og:description").content = m.description;
  }
  const path = m.canonical === undefined ? canonicalPath() : m.canonical;
  let link = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (path) {
    if (!link) { link = document.createElement("link"); link.rel = "canonical"; document.head.append(link); }
    link.href = ORIGIN + path;
    if (m.canonical === undefined) delete link.dataset.fixed; else link.dataset.fixed = "1";
    metaTag('meta[property="og:url"]', "property", "og:url").content = ORIGIN + path;
  } else link?.remove();
  const robots = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]');
  if (m.noindex) metaTag('meta[name="robots"]', "name", "robots").content = "noindex";
  else robots?.remove();
}
/** The page's own URL for canonical/og:url: the path, plus ?tab= when it isn't the default tab (the router and
 *  bindTabs drop the default from the URL, so any ?tab= left is a real one). Paging and filters are not canonical. */
function canonicalPath(): string {
  const tab = new URLSearchParams(location.search).get("tab");
  return location.pathname + (tab ? `?tab=${encodeURIComponent(tab)}` : "");
}
/** Keep canonical/og:url in step after a tab switch (replaceState), when the page itself set no explicit one. */
export function syncCanonical() {
  const link = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!link || link.dataset.fixed) return;
  link.href = ORIGIN + canonicalPath();
  metaTag('meta[property="og:url"]', "property", "og:url").content = link.href;
}
/** Mark the current nav section (the green dot). The address page switches Accounts ↔ Contracts. */
export function setSection(s: Section) {
  document.querySelectorAll<HTMLAnchorElement>("[data-nav]").forEach((a) => {
    if (a.dataset.nav === s) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
}

/* ---------------------------------------------------------------- navigation */

let ctl: AbortController | null = null;
let navId = 0;
const scrolls = new Map<string, number>();
const key = () => ((history.state ?? {}) as { key?: string }).key ?? "";
const newKey = () => Math.random().toString(36).slice(2, 10);
type Focus = "h1" | "caption" | "none";

export interface NavOpts { replace?: boolean; state?: Record<string, unknown>; focus?: Focus }
/** Go to an in-app URL (path + query + hash). External URLs are assigned. */
export function navigate(url: string, o: NavOpts = {}) {
  const u = new URL(url, location.href);
  if (u.origin !== location.origin) { location.assign(u.href); return; }
  if (key()) scrolls.set(key(), scrollY);
  const state = { ...(o.state ?? {}), key: newKey() };
  const to = u.pathname + u.search + u.hash;
  if (o.replace) history.replaceState(state, "", to); else history.pushState(state, "", to);
  void render({ restore: false, focus: o.focus ?? "h1" });
}

function announce(msg: string) {
  const r = document.getElementById("live-polite");
  if (!r) return;
  r.textContent = "";
  window.setTimeout(() => { r.textContent = msg; }, 60);
}

async function render(o: { restore: boolean; focus: Focus; first?: boolean }) {
  const id = ++navId;
  ctl?.abort();
  ctl = new AbortController();
  const signal = ctl.signal;

  // 1 · normalise and redirect (replace, never a new entry)
  for (let hop = 0; hop < 3; hop++) {
    const p = normalise(location.pathname);
    const r = redirectFor(p, location.search);
    if (r) { history.replaceState({ ...(history.state ?? {}), key: key() || newKey() }, "", r); continue; }
    if (p !== location.pathname) history.replaceState(history.state, "", p + location.search + location.hash);
    break;
  }
  if (!key()) history.replaceState({ ...(history.state ?? {}), key: newKey() }, "", location.href);

  // 2 · match
  const m = match(location.pathname);
  const page: PageKey = m?.route.page ?? "notFound";
  const params = m?.params ?? {};
  const query = new URLSearchParams(location.search);
  document.body.dataset.page = page;
  setSection(m?.route.section ?? null);
  setMeta(m ? { title: m.route.title } : { title: "Not found", noindex: true });

  // 3 · load the page chunk (the old page stays until it arrives; usually < 1 frame from cache)
  let mod: PageModule;
  try { mod = await PAGES[page](); } catch (e) {
    if (id !== navId) return;
    const main = document.getElementById("main")!;
    main.replaceChildren();
    showError(main, e, () => location.reload());
    return;
  }
  if (id !== navId) return;

  // 4 · swap <main> and paint the page's skeleton in the same frame
  const main = document.getElementById("main")!;
  const swap = () => {
    main.replaceChildren();
    try {
      const r = mod.render(params, query, signal, main);
      if (r instanceof Promise) r.catch((e) => { if (!signal.aborted) { console.error(e); if (!main.children.length) showError(main, e, () => void render({ restore: false, focus: "none" })); } });
    } catch (e) { console.error(e); showError(main, e, () => void render({ restore: false, focus: "none" })); }
  };
  if (o.first) swap(); else await withTransition(swap);
  if (id !== navId) return;

  // 5 · scroll, focus, announce
  const h = location.hash ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null;
  if (o.restore) scrollTo(0, scrolls.get(key()) ?? 0);
  else if (h) h.scrollIntoView();
  else if (o.focus === "caption") main.querySelector("caption, table, .xt-wrap")?.scrollIntoView({ block: "start" });
  else if (!o.first) scrollTo(0, 0);
  if (!o.first && !o.restore && o.focus === "caption") focusCaption(main, signal);
  else if (!o.first && !o.restore && o.focus !== "none") {
    const target = main.querySelector<HTMLElement>("h1");
    if (target) { if (!target.hasAttribute("tabindex")) target.tabIndex = -1; target.focus({ preventScroll: true }); }
  }
  if (!o.first) announce(`${document.title.replace(/ · Ferminux Explorer$/, "")}, loaded`);
}

/** After paging, focus the list's caption. A skeleton is invisible for its first 200 ms (so it can't take focus)
 *  and is replaced when the rows land, so wait for the first caption outside a skeleton (≤ 10 s, or until the
 *  next navigation), then fall back to the h1. */
function focusCaption(main: HTMLElement, signal: AbortSignal) {
  const put = (el: HTMLElement) => { if (!el.hasAttribute("tabindex")) el.tabIndex = -1; el.focus({ preventScroll: true }); };
  const real = () => Array.from(main.querySelectorAll<HTMLElement>("caption")).find((c) => !c.closest(".skel, [aria-busy=true]"));
  const c0 = real();
  if (c0) { put(c0); return; }
  const mo = new MutationObserver(() => { const c = real(); if (c) { stop(); put(c); } });
  const t = window.setTimeout(() => { stop(); const h = main.querySelector<HTMLElement>("h1"); if (h && !main.contains(document.activeElement)) put(h); }, 10_000);
  const stop = () => { mo.disconnect(); clearTimeout(t); };
  mo.observe(main, { childList: true, subtree: true });
  signal.addEventListener("abort", stop, { once: true });
}

/* ---------------------------------------------------------------- start */

const PASS = /^\/(api|socket|public-metrics|auth|fonts|brand|contracts|assets)(\/|$)/i;
export function startRouter() {
  history.scrollRestoration = "manual";
  addEventListener("popstate", () => void render({ restore: true, focus: "none" }));
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download") || a.dataset.external !== undefined) return;
    const href = a.getAttribute("href") ?? "";
    if (!href.startsWith("/") || href.startsWith("//")) return;
    const u = new URL(href, location.origin);
    if (PASS.test(u.pathname) || /\.[a-z0-9]{2,5}$/i.test(u.pathname)) return; // backend and files: a real load
    e.preventDefault();
    if (u.pathname === location.pathname && u.search === location.search && u.hash) {
      document.getElementById(decodeURIComponent(u.hash.slice(1)))?.scrollIntoView({ behavior: calm() ? "auto" : "smooth" });
      history.replaceState(history.state, "", u.pathname + u.search + u.hash);
      return;
    }
    navigate(u.pathname + u.search + u.hash);
  });
  initPrefetch();
  void render({ restore: false, focus: "none", first: true });
}

/** Prefetch on intent (§1.3): hovering or focusing a detail link for ≥ 80 ms warms that entity's main JSON.
 *  Mouse and keyboard only (never on touch). */
function initPrefetch() {
  let t = 0;
  const warm = (a: HTMLAnchorElement | null) => {
    clearTimeout(t);
    const href = a?.getAttribute("href") ?? "";
    const m = href.match(/^\/(tx|block|address)\/([^/?#]+)$/i);
    if (!m) return;
    t = window.setTimeout(() => {
      const [, kind, id] = m;
      const p = kind === "tx" ? api.tx(id) : kind === "block" ? api.block(id) : api.address(id);
      p.catch(() => { /* a prefetch never surfaces an error */ });
    }, 80);
  };
  document.addEventListener("pointerover", (e) => { if ((e as PointerEvent).pointerType === "mouse") warm((e.target as Element).closest?.("a[href]") as HTMLAnchorElement | null); });
  document.addEventListener("focusin", (e) => warm((e.target as Element).closest?.("a[href]") as HTMLAnchorElement | null));
}
