/* Blocks `/blocks` (surfaces/explorer.md §5.2).
   - BS /blocks?type=block|reorg|uncle, 50 per page, cursor paging (§4.10), "Page 1 of N" (N from the head).
   - Signer per block: the index's when it has one, else ONE batched clique_getSigner for the rows it left at
     0x0 (the newest ~50, API.md #1). Rewards: the index's signer reward (share + tips), else the schedule's
     share + tips, marked PER SCHEDULE.
   - Page 1 of All never moves under a reader: new heads raise a "N new blocks · Show" pill instead. */
import "./home-blocks/blocks.css";
import { html, mount, dash } from "../ui/html";
import { table, tableSkeleton, rowLink, sub, type Col } from "../ui/table";
import { ago, amt, gas, pill, prov } from "../ui/marks";
import { pagerHtml, bindPager, pageOf, PER_PAGE } from "../ui/pager";
import { empty, showError } from "../ui/state";
import { slowWatch } from "../ui/skeleton";
import { shell, seg, slot } from "./_shell";
import { resolveTab, setMeta, type Params } from "../router";
import { api } from "../api";
import { rpc, RPC_DOWN } from "../rpc";
import { onHead, currentHead } from "../head";
import { signersFor } from "../signer";
import { liveText, resetText } from "../motion";
import { int } from "../format";
import { isAbort, lc } from "../util";
import { gasCell, rewardCell, signerCell, sizeCell } from "./home-blocks/cells";
import type { Block, PageParams } from "../types";

type Kind = "block" | "reorg" | "uncle";
const NOTE: Record<Kind, string | null> = {
  block: null,
  reorg: "Blocks confirmed at a height and then replaced by another signer's block at the same height. They are not canonical and earned no reward.",
  uncle: "Proof-of-work era (before block 160,000).",
};
const EMPTY: Record<Kind, string> = { block: "No blocks on the index yet.", reorg: "No forked blocks.", uncle: "No uncle blocks." };

/** The signer cell. A canonical block: the index's signer, else the chain's. A forked block: only its own
 *  signer, never the chain's answer for that height (that is the canonical block's signer). */
function signerOf(b: Block, signers: Map<number, string | null>) {
  if (b.signer?.hash) return signerCell(b, lc(b.signer.hash));
  if (b.type !== "block" && b.era === "authority") return dash(FORK_GONE);
  return signerCell(b, signers.get(b.height));
}
const FORK_GONE = "Unknown: the index didn't record who confirmed this forked block, and the node no longer keeps its header";

/** Where a row links: canonical blocks by number, forked and uncle blocks by hash (the number is taken). */
const hrefOf = (b: Block) => (b.type === "block" ? `/block/${b.height}` : `/block/${b.hash}`);

function cols(signers: Map<number, string | null>, sched: { any: boolean }): Col<Block>[] {
  return [
    {
      label: "Block", w: "128px",
      cell: (b) => html`${rowLink(hrefOf(b), html`<span class="num-mono">${int(b.height)}</span>`, `Block ${int(b.height)}${b.type === "reorg" ? ", forked" : b.type === "uncle" ? ", uncle" : ""}`)}${b.type === "reorg" ? html` ${pill("Forked", "info")}` : b.type === "uncle" ? html` ${pill("Uncle", "info")}` : ""}${sub(ago(b.timestamp))}`,
    },
    { label: "Signer", cell: (b) => signerOf(b, signers) },
    { label: "Txs", align: "r", line: 2, l: "txs", w: "64px", cell: (b) => (b.transactions_count ? int(b.transactions_count) : html`<span class="zero">0</span>`) },
    { label: "Gas used", align: "r", line: 2, l: "gas", cell: (b) => gasCell(b.gas_used, b.gas_limit) },
    {
      label: "Reward (FMX)", align: "r", line: 2, end: true, l: "reward",
      cell: (b) => { const r = rewardCell(b); if (r.schedule) sched.any = true; return r.value; },
    },
    { label: "Burnt (FMX)", align: "r", hidePhone: true, cell: (b) => amt(b.burnt_fees) },
    { label: "Base fee", align: "r", hidePhone: true, cell: (b) => gas(b.base_fee_per_gas) },
    { label: "Size", align: "r", hidePhone: true, cell: (b) => sizeCell(b.size) },
  ];
}

export function render(_p: Params, query: URLSearchParams, signal: AbortSignal, root: HTMLElement) {
  const { tab } = resolveTab("blocks", query);
  const kind: Kind = tab === "reorgs" ? "reorg" : tab === "uncles" ? "uncle" : "block";
  const cur = pageOf(query);
  setMeta({
    title: kind === "block" ? "Blocks" : kind === "reorg" ? "Forked blocks" : "Uncle blocks",
    description: "Blocks on Ferminux Network (chain 3961), confirmed every 7 seconds by authorised signers.",
    canonical: kind === "block" && cur.page === 1 ? "/blocks" : undefined,
  });
  const skelCols = cols(new Map(), { any: false });
  shell(root, {
    h1: "Blocks",
    ident: html`<span>Latest <span class="num-mono" data-s="latest">—</span> · a block every 7 s · confirmed by <span data-s="conf">—</span> signers</span>`,
    body: [
      seg("Block filter", [
        { href: "/blocks", label: "All", on: kind === "block" },
        { href: "/blocks?tab=reorgs", label: "Forked", on: kind === "reorg" },
        { href: "/blocks?tab=uncles", label: "Uncles", on: kind === "uncle" },
      ]),
      NOTE[kind] ? html`<p class="seg-note">${NOTE[kind]}</p>` : "",
      html`<div data-slot="tbl">${tableSkeleton({ caption: "Blocks", captionHidden: true, cols: skelCols, sticky: true }, 10)}</div>`,
    ],
  });
  root.firstElementChild?.classList.add("xblks");
  // the "N new blocks · Show" pill lives in the filter row, so showing it never moves the table
  root.querySelector(".seg-row")?.insertAdjacentHTML("beforeend", '<div class="newrow" aria-live="polite" data-slot="new"></div>');
  const host = slot(root, "tbl")!, newHost = slot(root, "new")!;
  const latest = root.querySelector<HTMLElement>('[data-s="latest"]'), conf = root.querySelector<HTMLElement>('[data-s="conf"]');

  /* ---- identity line: the head (live) and how many signers confirmed in the last 64 blocks ---- */
  rpc.cliqueStatus(signal).then((st) => {
    const all = Object.keys(st.sealerActivity).length, on = Object.values(st.sealerActivity).filter((v) => v > 0).length;
    if (conf) conf.textContent = all ? `${on} of ${all}` : "—";
  }).catch((e) => { if (!isAbort(e) && conf) { conf.textContent = "—"; conf.title = RPC_DOWN; } });

  let top: number | null = null;   // the newest height on page 1 of All
  let shownAt = 0;
  let pagerState: { page: number; next: PageParams | null; expired: boolean } | null = null;
  const paintPager = () => {
    const pg = host.querySelector<HTMLElement>(".xpager");
    if (!pg || !pagerState) return;
    const h = currentHead();
    pg.outerHTML = pagerHtml({ ...pagerState, total: kind === "block" && h ? h.n + 1 : null }).s;
    bindPager(host, { page: pagerState.page, next: pagerState.next, current: cur.params });
  };
  const paintNew = (headN: number) => {
    if (kind !== "block" || cur.page !== 1 || top === null) return;
    const n = headN - top;
    if (n <= 0) { newHost.replaceChildren(); return; }
    if (Date.now() - shownAt < 6_500 && newHost.childElementCount) return; // at most one update per block
    shownAt = Date.now();
    mount(newHost, html`<button type="button" class="newpill" data-show><span class="status-dot ok" aria-hidden="true"></span>${int(n)} new block${n === 1 ? "" : "s"} · Show</button>`);
    newHost.querySelector("[data-show]")?.addEventListener("click", () => { newHost.replaceChildren(); void load(true, true); }, { once: true });
  };
  onHead((h, prev) => {
    liveText(latest, int(h.n));
    if (!prev) paintPager();
    paintNew(h.n);
  }, signal, { now: true });
  if (!currentHead() && latest) resetText(latest, "—");

  async function load(fresh = false, focus = false) {
    const done = slowWatch(host, () => void load(true), signal);
    try {
      const page = await api.blocks(kind, cur.params, { signal, fresh });
      if (signal.aborted) return;
      // the index leaves the signer at 0x0 on its newest ~50 blocks: ask the chain once, in one batch
      const miss = page.items.filter((b) => b.type === "block" && b.era === "authority" && !b.signer?.hash).map((b) => b.height);
      const signers = miss.length ? await signersFor(miss, signal).catch((e) => { if (isAbort(e)) throw e; return new Map<number, string | null>(); }) : new Map<number, string | null>();
      if (signal.aborted) return;
      done();
      if (!page.items.length) { mount(host, empty(EMPTY[kind], kind === "block" ? undefined : { href: "/blocks", label: "All blocks" })); return; }
      const sched = { any: false };
      const t = table({ caption: kind === "block" ? "Blocks, newest first" : kind === "reorg" ? "Forked blocks" : "Uncle blocks", captionHidden: true, cols: cols(signers, sched), rows: page.items, sticky: true, rowAttrs: (b) => html`data-h="${b.height}"` });
      const h = currentHead();
      pagerState = { page: cur.expired ? 1 : cur.page, next: page.next_page_params, expired: cur.expired };
      mount(host, html`${t}${sched.any ? html`<p class="tbl-note">${prov("schedule")} <span>Rewards marked with a dotted line are the signer's 40% share of the 0.25 FMX subsidy plus the block's tips, computed here: the index hasn't recorded these blocks' rewards yet (it records them about 50 blocks behind the head).</span></p>` : ""}${pagerHtml({ ...pagerState, total: kind === "block" && h ? h.n + 1 : null, perPage: PER_PAGE })}`);
      bindPager(host, { page: pagerState.page, next: pagerState.next, current: cur.params });
      if (kind === "block" && cur.page === 1) { top = page.items[0]?.height ?? null; newHost.replaceChildren(); }
      if (focus) host.querySelector<HTMLElement>("caption")?.focus({ preventScroll: false });
    } catch (e) {
      done();
      if (isAbort(e) || signal.aborted) return;
      showError(host, e, () => void load(true));
    }
  }
  void load();
}
