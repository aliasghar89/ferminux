/* Dense table → card list (§4.7). ONE markup for both: a real <table> on desktop (≥ 760), re-laid as
   cards on phones by CSS (explorer.css `.xt`). Each column says which card line it lands on:
     line 1 primary id + status + age · line 2 the parties · line 3 amounts (end = right-aligned).
   Explicit ARIA roles keep table semantics when the phone layout changes `display`.
   Row activation: put `rowLink()` in the primary cell; the whole row becomes its target, and every other
   link or chip in the row stays clickable above it. */
import { html, type Html, type Val } from "./html";

export interface Col<R> {
  /** Header text: mono uppercase, ≤ 3 words. Units go here ("Value (FMX)"), never in cells. */
  label: string;
  cell: (row: R, i: number) => Val;
  /** Numbers right-aligned (and mono), status centred, text left. */
  align?: "l" | "r" | "c";
  /** Phone card line, 1–3 (default 1). */
  line?: 1 | 2 | 3;
  /** Phone: push to the right end of its line. */
  end?: boolean;
  /** Phone: hide this cell (its value is folded into another). */
  hidePhone?: boolean;
  /** Phone: a mono label before the value, only where it would be ambiguous without one. */
  l?: string;
  cls?: string;
  /** Desktop width hint, e.g. "140px". */
  w?: string;
}

export interface TableOpts<R> {
  caption: string;
  /** The panel head already names the table: keep the caption for readers only. */
  captionHidden?: boolean;
  cols: Col<R>[];
  rows: R[];
  /** --row-dense (36 px): home feeds, events, holders. */
  dense?: boolean;
  /** Sticky header at --header-h (lists longer than 15 rows). */
  sticky?: boolean;
  id?: string;
  /** Extra attributes per row, e.g. html`data-h="${n}"`. */
  rowAttrs?: (row: R, i: number) => Html;
}

const alignCls = (a?: "l" | "r" | "c") => (a === "r" ? "r" : a === "c" ? "c" : "");
function tdAttrs<R>(c: Col<R>): Html {
  const cls = [alignCls(c.align), c.cls ?? ""].filter(Boolean).join(" ");
  return html`${cls ? html` class="${cls}"` : ""}${c.line && c.line > 1 ? html` data-line="${c.line}"` : ""}${c.end ? html` data-end` : ""}${c.hidePhone ? html` data-phone="hide"` : ""}${c.l ? html` data-l="${c.l}"` : ""}`;
}
function head<R>(o: Pick<TableOpts<R>, "caption" | "captionHidden" | "cols" | "dense" | "sticky" | "id">): Html {
  return html`<table class="xt${o.dense ? " dense" : ""}${o.sticky ? " sticky" : ""}" role="table"${o.id ? html` id="${o.id}"` : ""}>
<caption class="${o.captionHidden ? "vh" : ""}" tabindex="-1">${o.caption}</caption>
<thead role="rowgroup"><tr role="row">${o.cols.map((c) => html`<th scope="col" role="columnheader" class="${alignCls(c.align)}"${c.w ? html` style="width:${c.w}"` : ""}>${c.label}</th>`)}</tr></thead>`;
}

export function table<R>(o: TableOpts<R>): Html {
  return html`<div class="xt-wrap">${head(o)}<tbody role="rowgroup">${o.rows.map((r, i) =>
    html`<tr role="row"${o.rowAttrs ? html` ${o.rowAttrs(r, i)}` : ""}>${o.cols.map((c) => html`<td role="cell"${tdAttrs(c)}>${c.cell(r, i)}</td>`)}</tr>`)}</tbody></table></div>`;
}

/** Skeleton rows with the same columns (10 rows for lists, the exact count for feeds). */
export function tableSkeleton<R>(o: Omit<TableOpts<R>, "rows">, n = 10): Html {
  const widths = ["70%", "55%", "40%", "80%", "50%", "60%"];
  return html`<div class="xt-wrap skel" aria-busy="true">${head(o)}<tbody role="rowgroup">${Array.from({ length: n }, (_, i) =>
    html`<tr role="row">${o.cols.map((c, j) => html`<td role="cell"${tdAttrs(c)}><span class="sk" style="width:${c.align === "r" ? "48px" : widths[(i + j) % widths.length]}"></span></td>`)}</tr>`)}</tbody></table></div>`;
}

/** The primary cell's link: it stretches over the whole row. */
export const rowLink = (href: string, content: Val, label?: string) =>
  html`<a class="rl" href="${href}"${label ? html` aria-label="${label}"` : ""}>${content}</a>`;
/** A second line under a cell's value (age under a block number). */
export const sub = (v: Val) => html`<span class="sub">${v}</span>`;
