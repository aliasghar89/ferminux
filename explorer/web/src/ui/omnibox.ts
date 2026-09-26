/* The omnibox (§4.11): an ARIA 1.2 combobox with aria-activedescendant.
   - Instant local detection (no request): address → /address, 64-hex → check-redirect (block or tx),
     digits → /block/n, "#12" / "agent 12" / an exact agent name → that agent's owner (Agent jobs tab),
     an exact token symbol → /token/a, anything else → /search-results?q=.
   - Typeahead: 150 ms debounce, ≥ 2 characters, ONE /search/quick request merged with the name book
     (agents, contracts, signers). Groups in order; max 8 rows; the match is weighted 600, never coloured.
   - Empty focus: the last 5 searches (removable) and "Try:" chips. `/` or ⌘K / Ctrl-K focuses it. */
import { html, type Html } from "./html";
import { icon, type IconId } from "./icons";
import { api, cachedTokens, searchHref } from "../api";
import { gw } from "../gateway";
import { CONTRACTS } from "../known";
import { authorisedSigners, signerNo } from "../signer";
import { navigate } from "../router";
import { short, int } from "../format";
import { debounce, store, isAddr, isHash, lc } from "../util";

interface Opt { group: string; label: string; sub?: string; href: string; glyph: IconId; recent?: boolean }
const GROUPS = ["Go to", "Recent", "Agents", "Contracts", "Signers", "Tokens", "Addresses", "Blocks", "Transactions"];
export const TRY = [
  { label: "396000", href: "/block/396000" },
  { label: "WFMX", href: "/token/0x8a9Ae4D652cEba09Db8Ebf48D28C943b41B377Ae" },
  { label: "Scribe", href: "/search-results?q=Scribe" },
  { label: "AgentRegistry", href: "/address/0xa94f27F18267d09349809f3e2AeF8e7767033e8F" },
];
const PLACEHOLDER = "Block, tx, address, token or agent";
let seq = 0;

export function omniboxHtml(o: { large?: boolean; value?: string; label?: string } = {}): Html {
  const id = `omni-${++seq}`;
  return html`<form class="omni${o.large ? " omni-lg" : ""}" role="search" action="/search-results" data-omni>
  <label class="vh" for="${id}">${o.label ?? "Search chain 3961"}</label>
  <div class="omni-box">${icon("i-search")}<input id="${id}" type="search" name="q" autocomplete="off" spellcheck="false" placeholder="${PLACEHOLDER}"
    role="combobox" aria-expanded="false" aria-autocomplete="list" aria-controls="${id}-list" value="${o.value ?? ""}"><kbd class="omni-key" aria-hidden="true">/</kbd></div>
  <ul class="omni-list" id="${id}-list" role="listbox" aria-label="Suggestions" hidden></ul>
</form>`;
}

/* ---------------------------------------------------------------- detection */

const recent = {
  all(): string[] { try { return JSON.parse(store.get("fx-recent") ?? "[]") as string[]; } catch { return []; } },
  add(q: string) { const l = [q, ...recent.all().filter((x) => x !== q)].slice(0, 5); store.set("fx-recent", JSON.stringify(l)); },
  del(q: string) { store.set("fx-recent", JSON.stringify(recent.all().filter((x) => x !== q))); },
  clear() { store.del("fx-recent"); },
};

/** The one "Go to" row for an input, or null. Sync: agents come from the cached gateway list. */
function detect(q: string, agents: { id: number; name: string; owner: string }[]): Opt | null {
  const s = q.trim();
  if (isAddr(s)) return { group: "Go to", label: `Address ${short(s, 6)}`, href: `/address/${s}`, glyph: "i-user" };
  if (isHash(s)) return { group: "Go to", label: `Transaction or block ${short(s, 6)}`, href: `?redirect=${s}`, glyph: "i-tx" };
  if (/^\d[\d,]*$/.test(s)) { const n = s.replace(/,/g, ""); return { group: "Go to", label: `Block ${int(n)}`, href: `/block/${n}`, glyph: "i-box" }; }
  const m = s.match(/^(?:agent\s*)?#\s*(\d+)$/i) ?? s.match(/^agent\s+(\d+)$/i);
  if (m) { const a = agents.find((x) => x.id === Number(m[1])); if (a) return { group: "Go to", label: `${a.name} #${a.id}`, sub: "agent", href: `/address/${a.owner}?tab=jobs`, glyph: "i-bot" }; }
  const byName = agents.find((x) => x.name.toLowerCase() === s.toLowerCase());
  if (byName) return { group: "Go to", label: `${byName.name} #${byName.id}`, sub: "agent", href: `/address/${byName.owner}?tab=jobs`, glyph: "i-bot" };
  const tok = cachedTokens().find((t) => (t.symbol ?? "").toLowerCase() === s.toLowerCase());
  if (tok) return { group: "Go to", label: `${tok.name ?? tok.symbol} (${tok.symbol})`, sub: tok.type, href: `/token/${tok.address_hash}`, glyph: "i-coins" };
  return null;
}

/** Enter with no highlighted row. */
export async function go(q: string) {
  const s = q.trim();
  if (!s) return;
  recent.add(s);
  const agents = await gw.agents().catch(() => []);
  const d = detect(s, agents);
  if (d && !d.href.startsWith("?redirect=")) { navigate(d.href); return; }
  if (isHash(s)) {
    try {
      const r = await api.checkRedirect(s);
      if (r.redirect && r.parameter) { navigate(r.type === "block" ? `/block/${r.parameter}` : r.type === "transaction" ? `/tx/${r.parameter}` : `/address/${r.parameter}`); return; }
    } catch { /* fall through to results */ }
  }
  navigate(`/search-results?q=${encodeURIComponent(s)}`);
}

/* ---------------------------------------------------------------- binding */

const mark = (text: string, q: string) => {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  return i < 0 || !q ? html`${text}` : html`${text.slice(0, i)}<b>${text.slice(i, i + q.length)}</b>${text.slice(i + q.length)}`;
};

export function bindOmnibox(form: HTMLFormElement) {
  if (form.dataset.bound) return;
  form.dataset.bound = "1";
  const input = form.querySelector<HTMLInputElement>("input")!;
  const list = form.querySelector<HTMLUListElement>(".omni-list")!;
  let opts: Opt[] = [];
  let active = -1;
  let q = "";
  let req = 0;

  const open = (on: boolean) => { list.hidden = !on; input.setAttribute("aria-expanded", String(on)); if (!on) { active = -1; input.removeAttribute("aria-activedescendant"); } };
  const paint = (empty?: Html) => {
    const order = [...opts].sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group));
    opts = order;
    let last = "";
    const rows: Html[] = [];
    order.forEach((o, i) => {
      if (o.group !== last) { rows.push(html`<li class="omni-group" role="presentation">${o.group === "Recent" ? "Recent searches" : o.group}</li>`); last = o.group; }
      rows.push(html`<li class="omni-opt" role="option" id="${list.id}-${i}" data-i="${i}" aria-selected="${String(i === active)}">${icon(o.glyph, "g", 14)}<span class="l">${mark(o.label, q)}</span>${o.sub ? html`<span class="s">${o.sub}</span>` : ""}${o.recent ? html`<button type="button" class="x" data-del="${o.label}" aria-label="Remove ${o.label} from recent searches">×</button>` : ""}</li>`);
    });
    if (!order.length && empty) rows.push(html`<li class="omni-empty" role="presentation">${empty}</li>`);
    list.innerHTML = rows.map((r) => r.s).join("");
    open(rows.length > 0);
  };
  const setActive = (i: number) => {
    active = i;
    list.querySelectorAll<HTMLElement>(".omni-opt").forEach((li) => li.setAttribute("aria-selected", String(Number(li.dataset.i) === i)));
    if (i >= 0) { input.setAttribute("aria-activedescendant", `${list.id}-${i}`); list.querySelector(`#${CSS.escape(`${list.id}-${i}`)}`)?.scrollIntoView({ block: "nearest" }); }
    else input.removeAttribute("aria-activedescendant");
  };

  const showEmpty = () => {
    q = "";
    opts = recent.all().map((r) => ({ group: "Recent", label: r, href: `/search-results?q=${encodeURIComponent(r)}`, glyph: "i-search" as IconId, recent: true }));
    paint(html`Try: ${TRY.map((t, i) => html`${i ? " · " : ""}<a href="${t.href}">${t.label}</a>`)}`);
  };

  const suggest = debounce(async (text: string) => {
    const my = ++req;
    const agents = await gw.agents().catch(() => []);
    const local: Opt[] = [];
    const d = detect(text, agents);
    if (d) local.push(d);
    const t = text.toLowerCase();
    if (text.length >= 2) {
      agents.filter((a) => a.name.toLowerCase().includes(t)).slice(0, 3).forEach((a) => local.push({ group: "Agents", label: a.name, sub: `#${a.id} · ${short(a.owner, 4)}`, href: `/address/${a.owner}?tab=jobs`, glyph: "i-bot" }));
      CONTRACTS.filter((c) => c.name.toLowerCase().includes(t) && c.kind !== "token").slice(0, 3).forEach((c) => local.push({ group: "Contracts", label: c.name, sub: short(c.address, 4), href: `/address/${c.address}`, glyph: "i-file-code" }));
      const sm = t.match(/^signer\s*(\d)?$/);
      if (sm) {
        const set = await authorisedSigners().catch(() => [] as string[]);
        set.map((a) => ({ a, k: signerNo(a) ?? 0 })).filter((x) => !sm[1] || x.k === Number(sm[1])).sort((x, y) => x.k - y.k)
          .forEach((x) => local.push({ group: "Signers", label: x.k ? `Signer ${x.k}` : "Signer", sub: short(x.a, 4), href: `/address/${x.a}`, glyph: "i-user" }));
      }
    }
    let remote: Opt[] = [];
    if (text.length >= 2) {
      try {
        const items = await api.searchQuick(text);
        remote = items.slice(0, 8).map((it): Opt => {
          const g = it.type === "token" ? "Tokens" : it.type === "block" ? "Blocks" : it.type === "transaction" ? "Transactions" : "Addresses";
          const lbl = it.type === "token" ? `${it.name ?? ""}${it.symbol ? ` (${it.symbol})` : ""}` : it.type === "block" ? `Block ${int(it.block_number)}` : it.type === "transaction" ? short(it.transaction_hash, 6) : it.name ?? short(it.address_hash, 6);
          const sub = it.type === "token" ? `${it.token_type ?? ""} · ${short(it.address_hash, 4)}` : it.type === "address" || it.type === "contract" ? short(it.address_hash, 4) : "";
          return { group: g, label: lbl, sub, href: searchHref(it), glyph: g === "Tokens" ? "i-coins" : g === "Blocks" ? "i-box" : g === "Transactions" ? "i-tx" : "i-user" };
        });
      } catch { /* local matches still show */ }
    }
    if (my !== req || input.value.trim() !== text) return;
    const seen = new Set<string>();
    opts = [...local, ...remote].filter((o) => { const k = lc(o.href); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 8);
    active = opts.length ? 0 : -1;
    paint(html`Nothing on chain 3961 matches “${text}”. Try a block number, a 0x hash or address, a token symbol or an agent name.`);
    if (active >= 0) setActive(0);
  }, 150);

  const choose = (o: Opt) => {
    open(false);
    recent.add(o.recent ? o.label : input.value.trim() || o.label);
    if (o.href.startsWith("?redirect=")) void go(o.href.slice(10)); else navigate(o.href);
    input.blur();
  };

  input.addEventListener("focus", () => { if (!input.value.trim()) showEmpty(); });
  input.addEventListener("input", () => {
    q = input.value.trim();
    if (!q) { showEmpty(); return; }
    suggest(q);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); if (list.hidden) { input.value.trim() ? suggest(input.value.trim()) : showEmpty(); return; } setActive(Math.min(opts.length - 1, active + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(Math.max(-1, active - 1)); }
    else if (e.key === "Escape") {
      if (input.value) { input.value = ""; q = ""; showEmpty(); } else { open(false); input.blur(); }
      e.preventDefault();
    }
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const o = active >= 0 ? opts[active] : undefined;
    if (o) choose(o); else { open(false); void go(input.value); input.blur(); }
  });
  list.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the input
  list.addEventListener("click", (e) => {
    const t = e.target as Element;
    const del = t.closest<HTMLElement>("[data-del]");
    if (del) { recent.del(del.dataset.del!); showEmpty(); return; }
    const a = t.closest("a");
    if (a) { open(false); return; } // "Try:" links go through the router
    const li = t.closest<HTMLElement>(".omni-opt");
    if (li) choose(opts[Number(li.dataset.i)]);
  });
  input.addEventListener("blur", () => window.setTimeout(() => { if (document.activeElement !== input) open(false); }, 120));
}

/** `/` or ⌘K / Ctrl-K focuses the page's omnibox (the large one on home, else the header's). */
export function initOmniKeys(openPhone: () => void) {
  document.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    const typing = t.closest("input, textarea, select, [contenteditable=true]");
    const k = (e.key === "/" && !typing) || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k");
    if (!k) return;
    e.preventDefault();
    const boxes = Array.from(document.querySelectorAll<HTMLInputElement>("[data-omni] input")).filter((i) => i.offsetParent !== null);
    const main = boxes.find((i) => i.closest("main")) ?? boxes[0];
    if (main) main.focus(); else openPhone();
  });
}
