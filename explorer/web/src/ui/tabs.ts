/* Tabs (§4.9). Underline style with ONE 2 px indicator that slides (transform, 180 ms; jumps under calm).
   Selection writes ?tab= with replaceState (no new history entry), keeps the scroll, focuses the panel
   heading for readers and lazy-loads the panel once. ←/→ move and activate, Home/End jump.
   Tab keys ARE the index's ?tab= values (txs, token_transfers, logs, …) so links we write stay compatible.
   Tabs with a zero count do not render, except the default tab. */
import { html, type Html } from "./html";
import { count as fmtCount } from "../format";
import type { Capped } from "../types";
import { syncCanonical } from "../router";

export interface TabDef { key: string; label: string; count?: number | Capped | null; always?: boolean }
export interface TabsHandle { select(key: string, focus?: boolean): void; readonly active: string }

/** Markup: the tab list + one empty panel per tab (`<div data-panel="key">`). The default tab (`key`
 *  equal to `def`) is dropped from the URL. */
export function tabsHtml(id: string, tabs: TabDef[], active: string, label = "Sections"): Html {
  const shown = tabs.filter((t) => t.always || t.key === active || t.count === undefined || t.count === null || (typeof t.count === "number" ? t.count > 0 : t.count.n > 0));
  return html`<div class="xtabs" role="tablist" aria-label="${label}" id="${id}">${shown.map((t) =>
    html`<button type="button" class="tab" role="tab" id="${id}-t-${t.key}" data-tab="${t.key}" aria-controls="${id}-p-${t.key}" aria-selected="${String(t.key === active)}" tabindex="${t.key === active ? 0 : -1}">${t.label}${t.count !== undefined && t.count !== null ? html`<span class="n">${fmtCount(t.count)}</span>` : ""}</button>`)}<span class="ind" aria-hidden="true"></span></div>
${shown.map((t) => html`<div class="tabpanel" role="tabpanel" id="${id}-p-${t.key}" data-panel="${t.key}" aria-labelledby="${id}-t-${t.key}"${t.key === active ? "" : html` hidden`}></div>`)}`;
}

/**
 * Wire a tab list rendered by tabsHtml. `load(key, panel)` runs once per panel, the first time it is shown.
 * `def` is the default tab: selecting it removes ?tab= from the URL.
 */
export function bindTabs(root: ParentNode, id: string, def: string, load: (key: string, panel: HTMLElement) => void, signal?: AbortSignal): TabsHandle {
  const list = root.querySelector<HTMLElement>(`#${id}`)!;
  const tabs = () => Array.from(list.querySelectorAll<HTMLButtonElement>("[role=tab]"));
  const ind = list.querySelector<HTMLElement>(".ind")!;
  const loaded = new Set<string>();
  let active = tabs().find((t) => t.getAttribute("aria-selected") === "true")?.dataset.tab ?? def;

  const place = () => {
    const t = tabs().find((b) => b.dataset.tab === active);
    if (!t) return;
    ind.style.transform = `translateX(${t.offsetLeft}px) scaleX(${t.offsetWidth / 100})`;
  };
  const panel = (key: string) => (root as Element).querySelector<HTMLElement>(`#${id}-p-${CSS.escape(key)}`);
  const show = (key: string) => {
    const p = panel(key);
    if (p && !loaded.has(key)) { loaded.add(key); load(key, p); }
  };
  const select = (key: string, focus = false) => {
    if (!tabs().some((t) => t.dataset.tab === key)) key = def;
    active = key;
    tabs().forEach((t) => { const on = t.dataset.tab === key; t.setAttribute("aria-selected", String(on)); t.tabIndex = on ? 0 : -1; if (on && focus) t.focus(); if (on) t.scrollIntoView({ block: "nearest", inline: "nearest" }); });
    list.parentElement?.querySelectorAll<HTMLElement>(`[data-panel]`).forEach((p) => { p.hidden = p.dataset.panel !== key; });
    const u = new URL(location.href);
    if (key === def) u.searchParams.delete("tab"); else u.searchParams.set("tab", key);
    u.searchParams.delete("page"); u.searchParams.delete("next_page_params");
    history.replaceState(history.state, "", u.pathname + u.search + u.hash);
    syncCanonical();
    place();
    show(key);
  };
  list.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>("[role=tab]");
    if (b?.dataset.tab) select(b.dataset.tab);
  });
  list.addEventListener("keydown", (e) => {
    const all = tabs(); const i = all.findIndex((t) => t.dataset.tab === active);
    let j = -1;
    if (e.key === "ArrowRight") j = (i + 1) % all.length;
    else if (e.key === "ArrowLeft") j = (i - 1 + all.length) % all.length;
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = all.length - 1;
    if (j < 0) return;
    e.preventDefault();
    select(all[j].dataset.tab!, true);
  });
  const ro = new ResizeObserver(place);
  ro.observe(list);
  signal?.addEventListener("abort", () => ro.disconnect(), { once: true });
  place();
  show(active);
  return { select, get active() { return active; } };
}
