/* Home `/` (surfaces/explorer.md §5.1): the network at a glance, and one step to anything.
   - Head band: h1, lead, the omnibox, "Try:" chips; the stage (the block conveyor, §7.5) and its caption.
   - Vitals strip: Transactions (+ 30-day sparkline) · Block time · Signers · Addresses · Gas · Agents.
   - Latest blocks from the RPC (headers + clique_getSigner in one batch; new heads slide in, §7.3).
   - Latest transactions from the index every 14 s, and at once when a new head carries transactions.
   - Agent jobs (GW /jobs?limit=8) and Signers · last 64 blocks (clique_status), every 60 s, staggered.
   - Each pair of panels shows the same number of rows, so the two panels of a row end together (phones
     show the first 5 of each: home.css).
   The top half needs only the RPC (§8.5). Every panel loads and fails on its own. */
import "./home-blocks/home.css";
import { html, mount, dash, type Html } from "../ui/html";
import { omniboxHtml, bindOmnibox, TRY } from "../ui/omnibox";
import { sk } from "../ui/skeleton";
import { addrChip } from "../ui/hash";
import { seal, seals } from "../ui/seal";
import { amt, ago, txDot, jobPill, prov } from "../ui/marks";
import { hydrateMethods, kindMethod } from "../ui/txcols";
import { rowLink } from "../ui/table";
import { empty, showError } from "../ui/state";
import { setFastTicker } from "../ui/time";
import { panel, slot } from "./_shell";
import { setMeta, HOME_TITLE, type Params } from "../router";
import { api } from "../api";
import { rpc, RPC_DOWN, type RawBlock } from "../rpc";
import { gw, agentById, GW_DOWN, type Job } from "../gateway";
import type { Tx } from "../types";
import { onHead, onHeadState, type Head } from "../head";
import { signersFor, scheduleReward, signerNo } from "../signer";
import { checkIndexLag } from "../chrome";
import { liveText, feedInsert, resetText } from "../motion";
import { int, gasPrice, pct, amountCell, short, relTime } from "../format";
import { every, sleep, lc, isAbort } from "../util";
import { stageHtml, bindStage } from "./home-blocks/stage";
import { checksum } from "../enrich/checksum";
import { gasCell, hashLink, parties } from "./home-blocks/cells";
import { sparkHtml, bindSpark } from "./home-blocks/spark";
import { ltStatsOrNull, ltStatsFor, organic, organicTitle, organicDaily, orgText, ltNote, type LtStats } from "../loadtest";

// the index's /main-page/transactions answers 6: the blocks feed matches it so the pair ends together
const FEED_BLOCKS = 6, FEED_TXS = 6, FEED_JOBS = 8;
const feedSkeleton = (n: number) => html`<ol class="feed skel" aria-busy="true">${Array.from({ length: n }, () => html`<li>${sk("70%")}</li>`)}</ol>`;
const vital = (key: string, label: string, sub: Html | string, cls = "") =>
  html`<div class="${cls}"><span class="l">${label}</span><span class="v" data-k="${key}"><span class="skel">${sk("64px", "20px")}</span></span><span class="s" data-k="${key}-s">${sub}</span></div>`;

/* ---------------------------------------------------------------- latest blocks (RPC) */

interface FB { n: number; ts: number | null; txs: number | null; gasUsed: bigint | null; gasLimit: bigint | null; difficulty: number | null; signer: string | null | undefined }
const fromHead = (h: Head): FB => ({ n: h.n, ts: h.ts, txs: h.txCount, gasUsed: h.gasUsed, gasLimit: h.gasLimit, difficulty: h.difficulty, signer: h.signer ?? undefined });
const fromRaw = (n: number, b: RawBlock | null, signer: string | null | undefined): FB => b
  ? { n, ts: Number(BigInt(b.timestamp)), txs: b.transactions.length, gasUsed: BigInt(b.gasUsed), gasLimit: BigInt(b.gasLimit), difficulty: Number(BigInt(b.difficulty)), signer }
  : { n, ts: null, txs: null, gasUsed: null, gasLimit: null, difficulty: null, signer };

function blockRow(r: FB): Html {
  const s = scheduleReward(r.n);
  const reward = !s ? dash() : r.txs
    ? html`<span title="The signer's 0.1 FMX share plus this block's tips; the exact total is on the block page">${amountCell(s.signer)} <span class="faint">+ tips</span></span>`
    : html`${amountCell(s.signer)}`;
  return html`<li data-h="${r.n}">
  <div class="c-blk">${rowLink(`/block/${r.n}`, html`<span class="num-mono">${int(r.n)}</span>`, `Block ${int(r.n)}`)}<span class="sub">${r.ts ? ago(r.ts) : dash(RPC_DOWN)}</span></div>
  <div class="c-sig">${seal({ height: r.n, signer: r.signer, difficulty: r.difficulty })}</div>
  <div class="c-n r">${r.txs === null ? dash(RPC_DOWN) : r.txs ? int(r.txs) : html`<span class="zero">0</span>`}<span class="ph" aria-hidden="true"> txs</span><span class="vh"> transactions</span></div>
  <div class="c-gas r">${r.gasUsed === null ? dash(RPC_DOWN) : gasCell(r.gasUsed, r.gasLimit)}<span class="ph" aria-hidden="true"> gas</span></div>
  <div class="c-rw r"><span class="vh">Signer reward </span>${reward}<span class="ph" aria-hidden="true"> FMX</span><span class="vh"> FMX</span></div>
</li>`;
}
const blocksHead = html`<div class="feed-h fb" aria-hidden="true"><span>Block</span><span>Signer</span><span class="r">Txs</span><span class="r">Gas used</span><span class="r">Reward (FMX)</span></div>`;

/* ---------------------------------------------------------------- latest transactions (index) */

function txRow(t: Tx): Html {
  return html`<li data-tx="${t.hash}">
  <div class="c-tx">${txDot(t.status)} ${hashLink(`/tx/${t.hash}`, t.hash, `Transaction ${t.hash}`)}<span class="sub">${ago(t.timestamp)}</span></div>
  <div class="c-kind">${kindMethod(t)}</div>
  <div class="c-pty">${parties(t)}</div>
  <div class="c-val r">${amt(t.value)}<span class="ph" aria-hidden="true"> FMX</span><span class="vh"> FMX</span></div>
</li>`;
}
const txsHead = html`<div class="feed-h ft" aria-hidden="true"><span>Tx</span><span>Kind / method</span><span>From → To</span><span class="r">Value (FMX)</span></div>`;

/* ---------------------------------------------------------------- agent jobs (gateway) */

function agentName(j: Job): Html {
  const a = agentById(j.agentId);
  return a ? addrChip(a.owner, { copy: false, href: `/address/${a.owner}?tab=jobs`, label: { name: j.agentName, kind: "agent", id: j.agentId } })
    : html`<b>${j.agentName}</b> <span class="faint">#${j.agentId}</span>`;
}
/** §6.4 short forms: names, no addresses. The row links to the job's latest transaction. */
function jobRow(j: Job): Html {
  const txh = j.tx.closed ?? j.tx.delivered ?? j.tx.requested;
  const job = txh ? rowLink(`/tx/${txh}`, html`job #${j.id}`, `Job #${j.id}, latest transaction`) : html`job #${j.id}`;
  const agent = agentName(j), client = addrChip(j.client, { copy: false });
  const s = j.status;
  const sentence = s === "Requested" ? html`${client} hired ${agent} for ${job}`
    : s === "Delivered" ? html`${agent} delivered ${job}`
      : s === "Completed" || s === "Released" ? html`${client} released ${job} to ${agent}`
        : s === "Claimed" ? html`${agent} claimed ${job}`
          : s === "Refunded" ? html`${job} refunded to ${client}`
            : s === "Disputed" ? html`${client} disputed ${job}`
              : s === "Resolved" ? html`${job} with ${agent} resolved`
                : html`${agent} · ${job}`;
  const t = s === "Requested" ? j.createdAt : j.deliveredAt ?? j.createdAt;
  return html`<li>
  <div class="c-job">${sentence}</div>
  <div class="c-st">${jobPill(s)}</div>
  <div class="c-amt r">${amt(j.amount)}<span class="unit">FMX</span></div>
  <div class="c-age r">${ago(t)}</div>
</li>`;
}

/* ---------------------------------------------------------------- signers (RPC + index) */

const lastCache = new Map<string, { at: number; n: number; ts: string }>(); // idle signers' last block, 5 min
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayMonth = (v: string | number) => { const d = new Date(typeof v === "number" ? v * 1000 : v); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };

export function render(_p: Params, _q: URLSearchParams, signal: AbortSignal, root: HTMLElement) {
  setMeta({ title: HOME_TITLE, description: "Explore chain 3961: blocks confirmed every 7 seconds by Clique signers, transactions, FRC-20 and FRC-721 tokens, and AI agent jobs settled in FMX.", canonical: "/" });
  mount(root, html`<div class="container page xhome">
  <section class="page-head home-head cols cols-5-7" aria-labelledby="home-h1">
    <div class="home-intro">
      <h1 id="home-h1" tabindex="-1">Ferminux explorer</h1>
      <p class="lead">Blocks, transactions, tokens and agent work on chain 3961, confirmed every 7 seconds.</p>
      <div class="home-omni">${omniboxHtml({ large: true })}</div>
      <p class="try">Try: ${TRY.map((t) => html`<a href="${t.href}">${t.label}</a>`)}</p>
    </div>
    <div class="home-stage">${stageHtml()}</div>
  </section>
  <div class="stack">
    <section class="vitals" aria-label="Network vitals">
      <div class="vt-tx"><span class="l">Transactions</span><div class="vt-row"><div class="vt-num"><span class="v" data-k="tx"><span class="skel">${sk("96px", "20px")}</span></span><span class="s" data-k="tx-s">&nbsp;</span></div><div class="vt-spark" data-k="spark"></div></div></div>
      ${vital("bt", "Block time", "average, from the index")}
      ${vital("sg", "Signers", " ")}
      ${vital("ad", "Addresses", "seen on chain")}
      ${vital("gas", "Gas", " ")}
      ${vital("ag", "Agents", " ")}
    </section>
    <p class="lt-line" data-slot="lt-note" hidden></p>
    <div class="cols cols-5-7 pair">
      ${panel("blocks", "Latest blocks", html`${blocksHead}${feedSkeleton(FEED_BLOCKS)}`, { href: "/blocks", label: "View all →" })}
      ${panel("txs", "Latest transactions", html`${txsHead}${feedSkeleton(FEED_TXS)}`, { href: "/txs", label: "View all →" })}
    </div>
    <p class="home-note" data-slot="sched"></p>
    <div class="cols cols-7-5 pair">
      ${panel("jobs", "Agent jobs", feedSkeleton(FEED_JOBS), { href: "https://ferminux.net/jobs/", label: "ferminux.net ↗" })}
      ${panel("signers", "Signers · last 64 blocks", feedSkeleton(5), { href: "/stats#signers", label: "Signer lanes →" })}
    </div>
  </div>
</div>`);
  const f = root.querySelector<HTMLFormElement>("[data-omni]");
  if (f) bindOmnibox(f);
  root.querySelector('.panel-head a[href^="https://ferminux.net"]')?.setAttribute("rel", "noopener");

  setFastTicker(true);
  signal.addEventListener("abort", () => setFastTicker(false), { once: true });

  const V = (k: string) => root.querySelector<HTMLElement>(`[data-k="${k}"]`);
  const setV = (k: string, text: string, why?: string) => { const el = V(k); if (!el) return; if (why) { el.title = why; resetText(el, "—"); } else { el.removeAttribute("title"); liveText(el, text); } };
  const setS = (k: string, h: Html | string) => { const el = V(`${k}-s`); if (el) mount(el, h); };
  const stage = bindStage(root, signal);

  /* ---- last block each signer confirmed that this page has seen (feeds the signer panel) ---- */
  const seen = new Map<string, { n: number; ts: number }>();
  const see = (r: FB) => { if (r.signer && r.ts) { const k = lc(r.signer), o = seen.get(k); if (!o || o.n < r.n) seen.set(k, { n: r.n, ts: r.ts }); } };

  /* ---- latest blocks ---- */
  const bHost = slot(root, "blocks")!;
  let top = 0, chain: Promise<void> = Promise.resolve();
  let list: HTMLOListElement | null = null;
  async function firstBlocks(h: Head) {
    const ns = Array.from({ length: FEED_BLOCKS }, (_, i) => h.n - i).filter((n) => n >= 0);
    const rest = ns.slice(1);
    // one batch: 7 headers + the signers of all 8 (the head's is cached by the head store)
    const [hs, sig] = await Promise.all([
      Promise.all(rest.map((n) => rpc.block(n, signal).catch(() => null))),
      signersFor(ns, signal).catch(() => new Map<number, string | null>()),
    ]);
    if (signal.aborted) return;
    const rows = [fromHead(h), ...rest.map((n, i) => fromRaw(n, hs[i], sig.get(n)))];
    if (rows[0].signer === undefined) rows[0].signer = sig.get(h.n);
    rows.forEach(see);
    mount(bHost, html`${blocksHead}<ol class="feed fb" aria-label="Latest blocks, newest first">${rows.map(blockRow)}</ol>`);
    mount(slot(root, "sched"), schedFoot);
    list = bHost.querySelector("ol");
    top = h.n;
    paintSeen();
  }
  async function nextBlocks(h: Head) {
    if (h.n <= top || !list) return;
    const gap: number[] = [];
    for (let n = h.n - 1; n > top && gap.length < FEED_BLOCKS - 1; n--) gap.push(n);
    let extra: FB[] = [];
    if (gap.length) {
      const [hs, sig] = await Promise.all([
        Promise.all(gap.map((n) => rpc.block(n, signal).catch(() => null))),
        signersFor(gap, signal).catch(() => new Map<number, string | null>()),
      ]);
      if (signal.aborted) return;
      extra = gap.map((n, i) => fromRaw(n, hs[i], sig.get(n)));
    }
    const rows = [fromHead(h), ...extra];
    rows.forEach(see);
    const els = rows.map((r) => { const t = document.createElement("template"); t.innerHTML = blockRow(r).s.trim(); return t.content.firstElementChild as HTMLElement; });
    feedInsert(list, els, FEED_BLOCKS);
    top = h.n;
    paintSeen();
  }
  const schedFoot = html`${prov("schedule")} <span>Latest blocks: the reward is the signer's 40% share of the 0.25 FMX block subsidy; blocks with transactions add their tips.</span>`;

  /* ---- latest transactions ---- */
  // method names: the decode chunk loads when the browser is idle (never on the first-paint path)
  const idleHydrate = () => {
    const run = () => { if (!signal.aborted && tList) void hydrateMethods(tList, signal); };
    if ("requestIdleCallback" in window) requestIdleCallback(run, { timeout: 3000 }); else setTimeout(run, 1200);
  };
  const tHost = slot(root, "txs")!;
  let tList: HTMLOListElement | null = null;
  async function loadTxs(fresh = false) {
    try {
      const items = (await api.mainTxs({ signal, fresh })).slice(0, FEED_TXS);
      if (signal.aborted) return;
      if (!items.length) { mount(tHost, empty("No transactions on chain 3961 yet.")); tList = null; return; }
      const known = new Set(Array.from(tList?.children ?? []).map((li) => (li as HTMLElement).dataset.tx));
      const firstKnown = items.findIndex((t) => known.has(t.hash));
      if (!tList || firstKnown < 0) {
        mount(tHost, html`${txsHead}<ol class="feed ft" aria-label="Latest transactions, newest first">${items.map(txRow)}</ol>`);
        tList = tHost.querySelector("ol");
        idleHydrate();
        return;
      }
      if (firstKnown > 0) {
        const els = items.slice(0, firstKnown).map((t) => { const x = document.createElement("template"); x.innerHTML = txRow(t).s.trim(); return x.content.firstElementChild as HTMLElement; });
        feedInsert(tList, els, FEED_TXS);
        idleHydrate();
      }
    } catch (e) {
      if (isAbort(e) || signal.aborted) return;
      if (!tList) showError(tHost, e, () => void loadTxs(true));
    }
  }

  /* ---- vitals from the index ---- */
  let ltCache: LtStats | null | undefined; // the load-test counters from the last vitals read (the sparkline reuses them)
  const titled = (el: HTMLElement | null, t: string | undefined) => { if (el && t) el.title = t; };
  async function loadStats(fresh = false) {
    try {
      // the index's `transactions_today` is yesterday's chart row, so the sub-line uses its rolling 24 h count
      // Wizrd's load test is taken out of Transactions, the 24 h count and Addresses (src/loadtest.ts)
      const [s, ts] = await Promise.all([api.stats({ signal, fresh }), api.txStats({ signal, fresh }).catch((e) => { if (isAbort(e)) throw e; return null; }), ltStatsOrNull(signal)]);
      if (signal.aborted) return;
      const lt = await ltStatsFor(signal, { transactions: s.total_transactions, addresses: s.total_addresses, last24h: ts?.transactions_count_24h });
      if (signal.aborted) return;
      const otx = organic(s.total_transactions, lt, "transactions"), oad = organic(s.total_addresses, lt, "addresses");
      const o24 = organic(ts?.transactions_count_24h, lt, "last24h");
      setV("tx", orgText(otx));
      titled(V("tx"), organicTitle(otx, "transactions"));
      const today = V("tx-s");
      const n24 = o24.n;
      if (today) { const t = n24 === null ? "" : `${orgText(o24)} in the last 24 h`; today.dataset.base = t; if (today.dataset.hover === undefined) today.textContent = t; const tt = organicTitle(o24, "transactions"); if (tt) today.title = tt; else today.removeAttribute("title"); }
      setV("bt", s.average_block_time ? `${(s.average_block_time / 1000).toFixed(1)} s` : "—", s.average_block_time ? undefined : "Not reported by the index");
      setV("ad", orgText(oad), oad.n === null ? "Not reported by the index" : undefined);
      titled(V("ad"), organicTitle(oad, "addresses"));
      const note = slot(root, "lt-note");
      if (note) { const h = ltNote(lt, otx, oad, o24); mount(note, h); note.hidden = !h; }
      ltCache = lt;
    } catch (e) {
      if (isAbort(e) || signal.aborted) return;
      for (const k of ["tx", "bt", "ad"]) if (!V(k)?.dataset.v) setV(k, "—", "The explorer's index didn't answer");
    }
  }
  async function loadChart() {
    try {
      const [c, lt] = await Promise.all([api.txChart({ signal }), ltCache !== undefined ? Promise.resolve(ltCache) : ltStatsOrNull(signal)]);
      if (signal.aborted) return;
      // per day without Wizrd's load test (src/loadtest.ts); unchanged when its counters can't be read
      const pts = organicDaily([...(c.chart_data ?? [])].sort((a, b) => a.date.localeCompare(b.date)).slice(-30), (p) => p.transactions_count, lt).map((p) => ({ date: p.date, n: p.n }));
      const host = V("spark");
      if (!host) return;
      mount(host, html`${sparkHtml(pts)}<span class="vt-per" aria-hidden="true">${pts.length} d</span>`);
      bindSpark(host.querySelector("svg"), V("tx-s"));
    } catch { /* the sparkline is optional: the figure stands without it */ }
  }

  /* ---- signers: the vitals cell, the stage pips and the panel ---- */
  const sHost = slot(root, "signers")!;
  function paintSeen() {
    for (const [a, v] of seen) {
      const el = sHost.querySelector<HTMLElement>(`.sg-row[data-a="${a}"] .c-last`);
      if (el && el.dataset.n !== String(v.n)) { el.dataset.n = String(v.n); mount(el, html`last confirmed ${ago(v.ts)}`); }
    }
  }
  async function lastOf(a: string) {
    const c = lastCache.get(a);
    if (c && Date.now() - c.at < 300_000) return c;
    const p = await api.addressBlocksConfirmed(a, null, { signal });
    const b = p.items[0];
    if (!b) return null;
    const v = { at: Date.now(), n: b.height, ts: b.timestamp };
    lastCache.set(a, v);
    return v;
  }
  async function loadSigners() {
    const [setR, stR, tipR] = await Promise.allSettled([rpc.cliqueGetSigners(signal), rpc.cliqueStatus(signal), rpc.maxPriorityFee(signal)]);
    if (signal.aborted) return;
    if (tipR.status === "fulfilled") setV("gas", gasPrice(tipR.value)); else if (!V("gas")?.dataset.v) setV("gas", "—", RPC_DOWN);
    if (setR.status !== "fulfilled" || stR.status !== "fulfilled") {
      if (!V("sg")?.dataset.v) setV("sg", "—", RPC_DOWN);
      if (!sHost.querySelector(".sg-row")) mount(sHost, html`<p class="panel-note">Signer activity is unreadable: ${RPC_DOWN.toLowerCase()}. <button type="button" class="btn btn-secondary btn-xs" data-retry>Retry</button></p>`);
      sHost.querySelector("[data-retry]")?.addEventListener("click", () => void loadSigners(), { once: true });
      return;
    }
    const set = setR.value, st = stR.value, act = st.sealerActivity;
    const active = set.filter((a) => (act[lc(a)] ?? 0) > 0).length;
    setV("sg", `${active} of ${set.length}`);
    setS("sg", html`${seals(set, act)} <span title="Filled: confirmed at least one of the last 64 blocks">active</span>`);
    stage.signers(set, act);
    const rows = set.map((a) => ({ a: lc(a), k: signerNo(a) ?? 99, n: act[lc(a)] ?? 0 })).sort((x, y) => x.k - y.k);
    const of = st.numBlocks || 64;
    mount(sHost, html`<ol class="feed fs" aria-label="Authorised signers">${rows.map((r) => html`<li class="sg-row" data-a="${r.a}">
  <div class="c-sg">${seal({ height: 400_000, signer: r.a, link: true })}<span class="hb-hash faint">${short(checksum(r.a), 4)}</span><span class="c-last">${r.n ? html`<span class="faint">confirming</span>` : html`<span class="faint">idle</span>`}</span></div>
  <div class="c-bar" aria-hidden="true"><span class="bar"><i style="--p:${Math.min(1, r.n / of)}"></i></span></div>
  <div class="c-cnt r">${r.n ? int(r.n) : html`<span class="zero">0</span>`}<span class="vh"> of the last ${of} blocks</span></div>
  <i class="sg-tick" aria-hidden="true"></i>
</li>`)}</ol>
<p class="feed-foot">${active} of ${set.length} confirming · in turn ${pct(st.inturnPercent, 1)} of the last ${of} blocks</p>`);
    paintSeen();
    // signers with no block in this page's feed: their last confirmed block from the index (cached 5 min)
    for (const r of rows) {
      if (seen.has(r.a)) continue;
      lastOf(r.a).then((v) => {
        if (signal.aborted || seen.has(r.a)) return;
        const el = sHost.querySelector<HTMLElement>(`.sg-row[data-a="${r.a}"] .c-last`);
        if (!el) return;
        if (!v) { mount(el, html`<span class="faint">no block on the index</span>`); return; }
        mount(el, r.n ? html`last confirmed ${ago(v.ts)}`
          : html`<span title="${relTime(v.ts)}">idle since ${dayMonth(v.ts)} (block ${blockA(v.n)})</span>`);
      }).catch(() => { /* keep "idle" / "confirming" */ });
    }
  }
  const blockA = (n: number) => html`<a class="num-mono" href="/block/${n}">${int(n)}</a>`;
  function signerTick(a: string | null) {
    if (!a || document.hidden) return;
    const t = sHost.querySelector<HTMLElement>(`.sg-row[data-a="${lc(a)}"] .sg-tick`);
    t?.animate([{ opacity: 0 }, { opacity: 1, offset: 0.3 }, { opacity: 0 }], { duration: 700, easing: "cubic-bezier(.4,0,.2,1)" });
  }

  /* ---- agents (gateway) ---- */
  const jHost = slot(root, "jobs")!;
  async function loadJobs() {
    try {
      const [jobs, , st] = await Promise.all([gw.jobs({ limit: FEED_JOBS }, signal), gw.agents(signal).catch(() => []), gw.stats(signal).catch((e) => { if (isAbort(e)) throw e; return null; })]);
      if (signal.aborted) return;
      if (!jobs.length) { mount(jHost, html`<div class="panel-pad">${empty("No agent jobs yet. Agents are hired through ServiceEscrow; see", { href: "https://ferminux.net/agents/", label: "ferminux.net/agents ↗" })}</div>`); return; }
      // the totals from the gateway, at the foot (it lines up with the signers panel's foot)
      const foot = st ? html`<p class="feed-foot">${int(st.jobs)} job${st.jobs === 1 ? "" : "s"} · ${int(st.jobsCompleted)} completed · ${amountCell(st.volumeWei)} FMX paid through ServiceEscrow</p>` : "";
      mount(jHost, html`<ol class="feed fj" aria-label="Latest agent jobs">${jobs.slice(0, FEED_JOBS).map(jobRow)}</ol>${foot}`);
    } catch (e) {
      if (isAbort(e) || signal.aborted) return;
      if (!jHost.querySelector(".fj")) {
        mount(jHost, html`<p class="panel-note">Agent jobs unavailable from ferminux.net right now. <button type="button" class="btn btn-secondary btn-xs" data-retry>Retry</button></p>`);
        jHost.querySelector("[data-retry]")?.addEventListener("click", () => void loadJobs(), { once: true });
      }
    }
  }
  async function loadAgents() {
    try {
      const s = await gw.stats(signal);
      if (signal.aborted) return;
      setV("ag", int(s.agents));
      setS("ag", html`${int(s.activeAgents)} active · <a class="link-inline" href="https://ferminux.net/agents/" rel="noopener">ferminux.net ↗</a>`);
    } catch (e) {
      if (isAbort(e) || signal.aborted) return;
      if (!V("ag")?.dataset.v) { setV("ag", "—", GW_DOWN); setS("ag", "ferminux.net unavailable"); }
    }
  }

  /* ---- the head: stage, feed, gas sub-line, signer tick ---- */
  onHead((h, prev) => {
    stage.head(h, prev);
    setS("gas", html`tip · base fee ${h.baseFee === null ? dash("Not in the header") : gasPrice(h.baseFee)}`);
    chain = chain.then(() => (top ? nextBlocks(h) : firstBlocks(h))).catch((e) => {
      if (isAbort(e) || signal.aborted) return;
      if (!list) showError(bHost, e, () => { chain = chain.then(() => firstBlocks(h)); });
    });
    if (prev) {
      signerTick(h.signer);
      if (h.txCount > 0) { void loadTxs(true); void loadStats(true); }
    }
  }, signal, { now: true });
  onHeadState((s) => {
    if (s === "down" && !list) mount(bHost, html`<p class="panel-note">The chain head is unreadable right now (${RPC_DOWN.toLowerCase()}). Latest blocks appear as soon as rpc.ferminux.net answers.</p>`);
  }, signal);

  // first load: RPC batch A (signers, status, tip) and the index/gateway reads in parallel
  void loadSigners(); void loadStats(); void loadTxs(); void loadJobs(); void loadAgents();
  void checkIndexLag();
  const idle = (fn: () => void) => ("requestIdleCallback" in window ? requestIdleCallback(fn, { timeout: 2000 }) : setTimeout(fn, 600));
  idle(() => { if (!signal.aborted) void loadChart(); });

  // refresh: transactions every 14 s; the 60 s set staggered 300 ms apart; everything visible-only
  every(14_000, () => loadTxs(true), signal);
  const later: [number, () => Promise<unknown>][] = [[0, () => loadStats(true)], [300, loadSigners], [600, loadJobs], [900, loadAgents], [1200, checkIndexLag]];
  later.forEach(([d, fn]) => { sleep(d, signal).then(() => every(60_000, fn, signal), () => { /* left the page */ }); });
}
