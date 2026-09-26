/* Detail list (§4.8): dt 180 px (Inter 500 --muted) · dd flexible; stacked on phones with a mono label.
   Rows are grouped by hairline breaks (Status · Parties · Value and fees · Gas · Technical), never by
   nested cards. "More details" is a <details> whose open state is remembered per page type. A row that
   needs explaining gets an ⓘ button that opens a one-sentence popover (not a title). */
import { html, type Html, type Val } from "./html";
import { icon } from "./icons";
import { store } from "../util";

export interface Row { label: string; value: Val; hint?: string; id?: string }
/** Rows, or rows under a mono group title (BLOCK · SIGNER · REWARD · GAS) that a reader can tell apart from a row. */
export type Group = Row[] | { title: string; rows: Row[] };

const row = (r: Row) => html`<div class="dl-row"${r.id ? html` id="${r.id}"` : ""}><dt>${r.label}${r.hint ? hintBtn(r.hint) : ""}</dt><dd>${r.value}</dd></div>`;
export const hintBtn = (text: string) => html`<button type="button" class="hint" data-hint="${text}" aria-label="More about this">${icon("i-info", "", 14)}</button>`;

/** Groups of rows, then an optional "More details" group. `page` keys the remembered open state. */
export function kv(groups: Group[], more?: { page: string; rows: Row[] }): Html {
  const open = more ? store.get(`fx-more-${more.page}`, "session") === "1" : false;
  const gs = groups.map((g) => (Array.isArray(g) ? { title: "", rows: g } : g)).filter((g) => g.rows.length);
  const moreHtml = more && more.rows.length
    ? html`<details class="dl-more" data-more="${more.page}"${open ? " open" : ""}><summary>More details</summary><dl class="dl-group dl-g">${more.rows.map(row)}</dl></details>` : "";
  // titled groups: one <dl> per group under its own heading (a heading can't sit inside a <dl>)
  if (gs.some((g) => g.title)) {
    return html`<div class="dl-list dl-titled">${gs.map((g) => html`<section class="dl-group">${g.title ? html`<h3 class="dl-gt">${g.title}</h3>` : ""}<dl class="dl-g">${g.rows.map(row)}</dl></section>`)}${moreHtml}</div>`;
  }
  return html`<dl class="dl-list">${gs.map((g) => html`<div class="dl-group">${g.rows.map(row)}</div>`)}${more && more.rows.length
    ? html`<details class="dl-more" data-more="${more.page}"${open ? " open" : ""}><summary>More details</summary><div class="dl-group">${more.rows.map(row)}</div></details>` : ""}</dl>`;
}

/** One delegated listener: ⓘ popovers (Esc closes, focus returns) and the remembered <details> state. */
export function initKv() {
  let pop: HTMLElement | null = null, from: HTMLElement | null = null;
  const close = (refocus: boolean) => { pop?.remove(); pop = null; if (refocus) from?.focus(); from = null; };
  document.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>("[data-hint]");
    if (!b) { if (pop && !(e.target as Element).closest(".pop")) close(false); return; }
    if (from === b) { close(false); return; }
    close(false);
    from = b;
    pop = document.createElement("div");
    pop.className = "pop"; pop.setAttribute("role", "note"); pop.textContent = b.dataset.hint ?? "";
    document.body.append(pop);
    const r = b.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8)) + "px";
    pop.style.top = r.bottom + 6 + "px";
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && pop) close(true); });
  addEventListener("scroll", () => close(false), { passive: true });
  document.addEventListener("toggle", (e) => {
    const d = e.target as HTMLDetailsElement;
    if (d instanceof HTMLDetailsElement && d.dataset.more) store.set(`fx-more-${d.dataset.more}`, d.open ? "1" : "0", "session");
  }, true);
}
