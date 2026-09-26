/* Address tab: Events (§5.6 → the §5.5 event cards). One card per log, dense: `#index` · event name ·
   DECODED · FERMINUX ABI (or "Not decoded"), the transaction and block; then the args (name · type · value)
   or the raw topics (nulls dropped) and data. Decoding runs in the browser with this contract's ABI from the
   Ferminux repository, falling back to the generic FRC-20 / FRC-721 / WFMX / pair events. */
import { html, mount, type Html } from "../../ui/html";
import { txChip, blockLink } from "../../ui/hash";
import { prov } from "../../ui/marks";
import { pagerHtml, bindPager } from "../../ui/pager";
import { slowWatch, sk } from "../../ui/skeleton";
import { empty, showError } from "../../ui/state";
import { api } from "../../api";
import type { Log } from "../../types";
import { ethers, FRC20, FRC721, EXTRA_EVENTS, type AbiItem, type AbiParam } from "./abi";
import { valueHtml } from "./values";
import { cursorFor, type Ctx } from "./common";

export interface Decoded { name: string; args: { p: AbiParam; v: unknown }[]; known: boolean }
type Decoder = (l: Pick<Log, "topics" | "data">) => Decoded | null;

/** A log decoder over an ABI (the contract's own) plus the generic sets. `known` = decoded with the
 *  contract's own ABI (a Ferminux contract), not a generic guess. */
export async function makeDecoder(abi: AbiItem[] | null): Promise<Decoder> {
  const { Interface } = await ethers();
  const own = abi ? new Interface(abi as never) : null;
  const g20 = new Interface([...FRC20, ...EXTRA_EVENTS]);
  const g721 = new Interface(FRC721);
  return (l) => {
    const topics = l.topics.filter((t): t is string => !!t);
    if (!topics.length) return null;
    const tries: [InstanceType<typeof Interface> | null, boolean][] = [[own, true], [topics.length === 4 ? g721 : g20, false], [topics.length === 4 ? g20 : g721, false]];
    for (const [i, known] of tries) {
      if (!i) continue;
      try {
        const d = i.parseLog({ topics, data: l.data });
        if (!d) continue;
        const inputs = d.fragment.inputs;
        return { name: d.name, known, args: inputs.map((p, k) => ({ p: { name: p.name, type: p.type, components: (p.components ?? undefined) as AbiParam[] | undefined, indexed: !!p.indexed }, v: d.args[k] })) };
      } catch { /* next */ }
    }
    return null;
  };
}

function card(l: Log, d: Decoded | null): Html {
  const head = html`<header class="ad-ev-h"><span class="ad-ev-i">#${l.index}</span>${d ? html`<b class="ad-ev-n">${d.name}</b>${d.known ? prov("abi") : html`<span class="prov declared" title="Decoded with the generic FRC-20 / FRC-721 / WFMX / pair events">Generic event</span>`}` : html`<span class="ad-ev-n faint">Not decoded</span>`}<span class="ad-ev-meta">${txChip(l.transaction_hash)} <span class="faint">in block</span> ${blockLink(l.block_number)}</span></header>`;
  const body = d
    ? html`<table class="ad-ev-args"><caption class="vh">Arguments of ${d.name}</caption><thead class="vh"><tr><th>Name</th><th>Type</th><th>Value</th></tr></thead><tbody>${d.args.map((a) => html`<tr><th scope="row">${a.p.name || "—"}${a.p.indexed ? html` <span class="faint ad-idx" title="An indexed argument (a log topic)">indexed</span>` : ""}</th><td class="ad-ev-t">${a.p.type}</td><td>${valueHtml(a.v, a.p)}</td></tr>`)}</tbody></table>`
    : html`<dl class="ad-ev-raw">${l.topics.filter(Boolean).map((t, i) => html`<div><dt>topic ${i}</dt><dd class="mono">${t}</dd></div>`)}<div><dt>data</dt><dd class="mono">${l.data === "0x" ? html`<span class="faint">0x (empty)</span>` : l.data}</dd></div></dl>`;
  return html`<article class="ad-ev">${head}${body}</article>`;
}

export function eventsTab(ctx: Ctx, panel: HTMLElement, abi: () => Promise<AbiItem[] | null>) {
  const c = cursorFor(ctx, "logs");
  mount(panel, html`<div class="ad-evs skel" aria-busy="true">${Array.from({ length: 4 }, () => html`<article class="ad-ev"><header class="ad-ev-h">${sk("40%")}</header><div class="ad-ev-args">${sk("80%")}</div></article>`)}</div>`);
  const done = slowWatch(panel, () => eventsTab(ctx, panel, abi), ctx.signal);
  const dec = abi().then(makeDecoder).catch(() => null);
  api.addressLogs(ctx.a, c.params, { signal: ctx.signal }).then(async (p) => {
    const decode = await dec;
    done();
    if (ctx.signal.aborted) return;
    if (!p.items.length && c.page === 1) { mount(panel, empty("This contract hasn't emitted events yet.")); return; }
    const pager = c.page > 1 || p.next_page_params ? pagerHtml({ page: c.page, next: p.next_page_params, expired: c.expired }) : "";
    mount(panel, html`<h3 class="vh" tabindex="-1">Events</h3><div class="ad-evs">${p.items.map((l) => card(l, decode ? decode(l) : null))}</div>${pager}`);
    if (pager) bindPager(panel, { page: c.page, next: p.next_page_params, current: c.params });
  }, (e) => { done(); showError(panel, e, () => eventsTab(ctx, panel, abi)); });
}
