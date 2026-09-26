/* Address tab: Balance history (§5.6). The last 10 days as a step area chart, then the list of changes:
   Block · Tx · Change (± FMX) · Balance after · Age.
   Dates come from the chain, not from the index (QA data #8): the index's balance-history rows and its
   by-day balances carry block timestamps that are hours off, which put changes on the wrong day.
   - Ages in the list: the header timestamp of each row's block (one RPC batch per page).
   - The chart: for each of the last 9 UTC days, the last block confirmed before midnight (chaintime.ts), then
     the balance after the last change at or before that block (the index's list, read by block-number
     cursor: exact, whatever its timestamps say), and the chain's balance now. */
import { html, mount, dash } from "../../ui/html";
import { txChip } from "../../ui/hash";
import { ago } from "../../ui/marks";
import { rowLink, sub, type Col } from "../../ui/table";
import { amountCell, fmx, int, big } from "../../format";
import { api } from "../../api";
import { rpc, RPC_DOWN } from "../../rpc";
import { blockTimes, lastBlockAt } from "../../chaintime";
import { isAbort } from "../../util";
import type { CoinBalance, Paged } from "../../types";
import { areaChart, type Pt } from "./chart";
import { pagedTable, phu, type Ctx } from "./common";

type Row = CoinBalance & { chainTs: number | null };
const DAYS = 10;

const change = (d: string) => {
  const b = big(d);
  if (b === null) return html`<span class="faint">—</span>`;
  if (b === 0n) return html`<span class="zero">0</span>`;
  return b > 0n ? html`<span class="ad-pos">+${amountCell(b)}</span>` : html`<span class="ad-neg">−${amountCell(-b)}</span>`;
};
const COLS: Col<Row>[] = [
  { label: "Block", cell: (c) => html`${rowLink(`/block/${c.block_number}`, html`<span class="num-mono">${int(c.block_number)}</span>`, `Block ${c.block_number}`)}${sub(c.chainTs !== null ? ago(c.chainTs) : dash(`${RPC_DOWN}: the block's time is read from the chain`))}` },
  { label: "Tx", cell: (c) => (c.transaction_hash ? txChip(c.transaction_hash) : html`<span class="faint" title="A block reward or a value paid by a contract: no transaction of this address">block reward or contract</span>`) },
  { label: "Change (FMX)", cell: (c) => html`${change(c.delta)}${phu()}`, align: "r", line: 3 },
  { label: "Balance after (FMX)", cell: (c) => html`${amountCell(c.value)}${phu()}`, align: "r", line: 3, end: true, l: "after" },
];

/** One page of the list with each row's block time read from the chain. */
async function withChainTimes(p: Paged<CoinBalance>, signal: AbortSignal): Promise<Paged<Row>> {
  const ts = await blockTimes(p.items.map((c) => c.block_number), signal).catch((e) => { if (isAbort(e)) throw e; return new Map<number, number>(); });
  return { ...p, items: p.items.map((c) => ({ ...c, chainTs: ts.get(c.block_number) ?? null })) };
}

/** The balance after the last recorded change at or before block `b`; null when the index can't say. */
async function balanceAt(ctx: Ctx, b: number, first: Paged<CoinBalance>): Promise<bigint | null> {
  const items = first.items; // newest first
  const hit = items.find((c) => c.block_number <= b);
  if (hit) return big(hit.value);
  const oldest = items[items.length - 1];
  if (!oldest) return 0n;
  if (!first.next_page_params) {
    // before the first change the index recorded: the balance it started from
    const v = big(oldest.value), d = big(oldest.delta);
    return v !== null && d !== null ? v - d : null;
  }
  // deeper than page 1: ask for the first change below b + 1 (the cursor is "block_number < n")
  const p = await api.addressCoinHistory(ctx.a, { block_number: b + 1, items_count: 50 }, { signal: ctx.signal });
  if (p.items[0]) return big(p.items[0].value);
  return null;
}

async function chartPoints(ctx: Ctx): Promise<Pt[]> {
  const first = await api.addressCoinHistory(ctx.a, null, { signal: ctx.signal });
  const today = Math.floor(Date.now() / 86_400_000);
  const days = Array.from({ length: DAYS - 1 }, (_, i) => today - (DAYS - 1) + i); // the 9 completed days
  const ends = days.map((d) => (d + 1) * 86_400 - 1);                           // 23:59:59 UTC
  const blocks = await lastBlockAt(ends, ctx.signal);
  const pts: Pt[] = [];
  for (let i = 0; i < days.length; i++) {
    const b = blocks.get(ends[i]);
    if (b === undefined) continue;
    const v = b < 0 ? 0n : await balanceAt(ctx, b, first).catch((e) => { if (isAbort(e)) throw e; return null; });
    if (v === null) continue;
    const date = new Date(days[i] * 86_400_000).toISOString().slice(0, 10);
    pts.push({ t: ends[i] * 1000, label: date.slice(5), v });
  }
  const now = ctx.chainBal ?? await rpc.balance(ctx.a, ctx.signal).catch((e) => { if (isAbort(e)) throw e; return null; });
  if (now !== null) pts.push({ t: Date.now(), label: "now", v: now });
  return pts;
}

export function historyTab(ctx: Ctx, panel: HTMLElement) {
  panel.innerHTML = html`<section class="panel ad-ac-panel" aria-labelledby="ad-ac-h"><div class="panel-head"><h2 id="ad-ac-h">Balance, last ${DAYS} days</h2><span class="faint small">FMX at the end of each UTC day, dated by the chain</span></div><div class="ad-ac-host" data-chart></div><details class="ad-ac-data" hidden><summary>Show data</summary><div data-table></div></details></section><div data-list></div>`.s;
  const chart = panel.querySelector<HTMLElement>("[data-chart]")!;
  const box = panel.querySelector<HTMLElement>(".ad-ac-panel")!;
  chartPoints(ctx).then((pts) => {
    if (ctx.signal.aborted) return;
    if (pts.length < 2) { box.remove(); return; }
    areaChart(chart, pts, { label: `FMX balance over the last ${DAYS} days: from ${fmx(pts[0].v, 2)} to ${fmx(pts[pts.length - 1].v, 2)} FMX`, signal: ctx.signal });
    const det = box.querySelector<HTMLDetailsElement>(".ad-ac-data")!;
    det.hidden = false;
    mount(det.querySelector("[data-table]"), html`<table class="xt dense"><caption class="vh">Balance by day</caption><thead><tr><th scope="col">Date (UTC)</th><th scope="col" class="r">Balance (FMX)</th></tr></thead><tbody>${pts.map((p) => html`<tr><td class="mono">${p.label === "now" ? "now" : new Date(p.t).toISOString().slice(0, 10)}</td><td class="r">${fmx(p.v, 4)}</td></tr>`)}</tbody></table>`);
  }, () => { box.remove(); });
  pagedTable<Row>(panel.querySelector<HTMLElement>("[data-list]")!, {
    ctx, tab: "coin_balance_history", sticky: true,
    caption: "Balance changes",
    cols: COLS,
    fetch: async (next, signal) => withChainTimes(await api.addressCoinHistory(ctx.a, next, { signal }), signal),
    empty: "No balance changes recorded for this address yet.",
  });
}
