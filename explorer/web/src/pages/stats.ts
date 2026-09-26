/* Network stats `/stats` (§5.13). Six panels, each loading and failing on its own:
     1 Chain        head (chain) · block time (index average + measured over the last 64 headers, ESTIMATE)
                    · transactions total and last 24 h · addresses · contracts · tokens (index)
     2 Signers      #signers: in-turn share + the lanes over the last 64 headers (one RPC batch of
                    eth_getBlockByNumber + clique_getSigner), then a table with index totals
     3 Transactions per day   area chart, 30 days (index /stats/charts/transactions, newest first → reversed)
     4 Gas          #gas: base fee (head) · typical tip · gas price · block gas limit (chain)
     5 Rewards      PER SCHEDULE: the split from signer.ts scheduleReward(head)
     6 Agents on chain        gateway /stats
   Omitted on purpose: supply, price, market cap, "network utilisation", total gas used (§5.13).
   Live: the head, the lanes, the signer table and the gas cells follow onHead(); nothing animates except
   the head's digits (liveText). The index's `transactions_today` is yesterday's chart row, so it isn't shown
   as "today"; the 24 h count comes from /transactions/stats. */
import "./misc/pages.css";
import { html, mount, dash } from "../ui/html";
import { sk } from "../ui/skeleton";
import { prov, ago, gas } from "../ui/marks";
import { addrChip, blockLink } from "../ui/hash";
import { seal } from "../ui/seal";
import { table, tableSkeleton, rowLink, sub, type Col } from "../ui/table";
import { kv } from "../ui/kv";
import { note, showError } from "../ui/state";
import { shell } from "./_shell";
import { setMeta, type Params } from "../router";
import { api } from "../api";
import { nonCanonical, canonicalCount } from "../canon";
import { checksum } from "../enrich/checksum";
import { rpc, RPC_DOWN, type RawBlock } from "../rpc";
import { gw, GW_DOWN, type GwStats } from "../gateway";
import { onHead, firstHead, type Head } from "../head";
import { signersFor, authorisedSigners, inTurn, scheduleReward, signerNo } from "../signer";
import { REWARD_SINK, TREASURY } from "../known";
import { int, amountCell, gasPriceExact, units, pct, relTime, dur } from "../format";
import { liveText } from "../motion";
import { isAbort, lc } from "../util";
import type { Block, SmartContractsCounters, Stats, TokenInfo, TxStats, Paged } from "../types";
import { xpanel, put, keyEl, stat, dayLabel, limit } from "../ui/kit";
import { areaChart, lanesHtml, laneRows, type Tick } from "./misc/charts";
import { ltStatsOrNull, ltStatsFor, organic, organicTitle, organicDaily, orgText, ltNote, ltDailyNote } from "../loadtest";

const WINDOW = 64;
const HALVING = 4_500_000;
const agentsGrid = () => html`<div class="statgrid ns-stat ns-grid4">${[
  stat("ag", "Agents"), stat("ag-act", "Active"), stat("jobs", "Jobs"), stat("jobs-done", "Completed"),
  stat("escrow", "Through escrow"), stat("x402", "x402 settlements"), stat("wallets", "Agent wallets"), stat("atokens", "Agent tokens"),
]}</div>`;

export function render(_p: Params, _q: URLSearchParams, signal: AbortSignal, root: HTMLElement) {
  setMeta({ title: "Network stats", description: "Chain 3961 read live: blocks, signers, transactions per day, gas, rewards and agents." });
  shell(root, {
    h1: "Network stats",
    ident: "Chain 3961 · read live",
    body: [
      xpanel("chain", "Chain", html`<div class="statgrid ns-stat ns-grid6">${[
        stat("head", "Latest block"), stat("btime", "Block time"), stat("txs", "Transactions"),
        stat("addrs", "Addresses"), stat("contracts", "Contracts"), stat("tokens", "Tokens"),
      ]}</div><p class="xp-foot lt-line" data-k="lt-note" hidden></p>`, prov("index")),
      xpanel("signers", "Signers", html`<div class="ns-sum" data-k="sig-sum"><span class="skel">${sk("240px")}</span></div><div class="ns-lanes-wrap" data-k="lanes"><div class="skel">${sk("100%", "164px")}</div></div><div class="xp-table" data-k="sig-table"><p class="xp-cap">&nbsp;</p>${tableSkeleton({ caption: "Signers", captionHidden: true, cols: SIGNER_COLS(0) }, 5)}</div>`, prov("chain")),
      xpanel("txday", "Transactions per day", html`<div class="ns-chart-host"><div class="xp-body skel">${sk("100%", "180px")}</div><div class="xp-ph" aria-hidden="true"></div></div>`, ""),
      xpanel("gas", "Gas", html`<div class="statgrid ns-stat ns-grid4">${[
        stat("basefee", "Base fee"), stat("tip", "Typical tip"), stat("gasprice", "Gas price"), stat("gaslimit", "Block gas limit"),
      ]}</div><p class="xp-foot">Signers require a tip of at least 1 gwei.</p>`, prov("chain")),
      xpanel("rewards", "Rewards", html`<div class="xp-body skel">${sk("100%", "250px")}</div>`, prov("schedule")),
      xpanel("agents", "Agents on chain", html`<div data-k="agents-grid">${agentsGrid()}</div><p class="xp-foot"><span>From the Ferminux gateway.</span><a class="link-arrow" href="https://ferminux.net/network/">ferminux.net/network ↗</a></p>`),
    ],
  });
  // the section ids are the panels' own (#signers, #gas): the router scrolls to location.hash after paint

  let head: Head | null = null;
  let avgMs: number | null = null;

  /* ---------------- 1 · chain ---------------- */
  const paintHead = (h: Head) => {
    head = h;
    liveText(keyEl(root, "head"), int(h.n));
    put(root, "head-s", html`<a href="/block/${h.n}"><time datetime="${new Date(h.ts * 1000).toISOString()}" data-rel>${relTime(h.ts)}</time></a>`);
  };

  const loadChain = async () => {
    const fail = (e: unknown, keys: string[]) => { if (isAbort(e)) return; keys.forEach((k) => put(root, k, dash(`The explorer's index didn't answer${e instanceof Error && e.message ? ` (${e.message})` : ""}`))); };
    // Wizrd's load test is taken out of Transactions, the 24 h count and Addresses (src/loadtest.ts)
    const L = ltStatsOrNull(signal).catch(() => null);
    const s = Promise.all([api.stats({ signal }), L]).then(async ([st]: [Stats, unknown]) => {
      if (signal.aborted) return;
      const lt = await ltStatsFor(signal, { transactions: st.total_transactions, addresses: st.total_addresses }).catch(() => null);
      if (signal.aborted) return;
      avgMs = st.average_block_time;
      put(root, "btime", avgMs ? `${(avgMs / 1000).toFixed(1)} s` : dash());
      if (!keyEl(root, "btime-s")?.textContent) put(root, "btime-s", "index average");
      const otx = organic(st.total_transactions, lt, "transactions"), oad = organic(st.total_addresses, lt, "addresses");
      const tip = (t: string | undefined, v: string) => (t ? html`<span title="${t}">${v}</span>` : v);
      put(root, "txs", otx.n !== null ? tip(organicTitle(otx, "transactions"), orgText(otx)) : dash());
      put(root, "addrs", oad.n !== null ? tip(organicTitle(oad, "addresses"), orgText(oad)) : dash());
      const note = put(root, "lt-note", ltNote(lt, otx, oad));
      if (note) note.hidden = !note.innerHTML;
      paintHalving();
    }, (e) => fail(e, ["btime", "txs", "addrs"]));
    const t = Promise.all([api.txStats({ signal }), L]).then(async ([ts]: [TxStats, unknown]) => {
      if (signal.aborted) return;
      const lt = await ltStatsFor(signal, { last24h: ts.transactions_count_24h }).catch(() => null);
      const o24 = organic(ts.transactions_count_24h, lt, "last24h");
      if (signal.aborted || o24.n === null) { if (!signal.aborted) put(root, "txs-s", ""); return; }
      const t24 = organicTitle(o24, "transactions");
      put(root, "txs-s", html`<span class="num-mono"${t24 ? html` title="${t24}"` : ""}>${orgText(o24)}</span> in the last 24 h`);
    }, () => { /* the total still stands */ });
    const c = api.smartContractsCounters({ signal }).then((sc: SmartContractsCounters) => {
      if (signal.aborted) return;
      put(root, "contracts", sc.smart_contracts ? int(sc.smart_contracts) : dash());
      put(root, "contracts-s", html`<a href="/verified-contracts"><span class="num-mono">${int(sc.verified_smart_contracts ?? 0)}</span> verified</a>`);
    }, (e) => fail(e, ["contracts"]));
    const k = api.tokens(undefined, null, { signal }).then((p: Paged<TokenInfo>) => {
      if (signal.aborted) return;
      const n = p.items.length;
      put(root, "tokens", p.next_page_params ? `${int(n)}+` : int(n));
      const by = (t: string) => p.items.filter((x) => x.type === t).length;
      put(root, "tokens-s", html`<a href="/tokens">${by("FRC-20")} FRC-20 · ${by("FRC-721")} FRC-721</a>`);
    }, (e) => fail(e, ["tokens"]));
    await Promise.allSettled([s, t, c, k]);
  };

  /* ---------------- 2 · signers ---------------- */
  const ticks = new Map<number, Tick>();
  let top = 0;
  let set: string[] = [];
  const totals = new Map<string, string | null>();       // canonical blocks confirmed per signer (lower-case)
  const excluded = new Map<string, number>();            // forked blocks left out of that total
  const lastSeen = new Map<string, { n: number; ts: string | number } | null>(); // idle signers: last block from the index
  let tableDrawn = false;
  let loading = false, pendingTop = 0;

  const windowTicks = () => [...ticks.values()].filter((t) => t.n > top - WINDOW && t.n <= top).sort((a, b) => a.n - b.n);

  const fillWindow = async (to: number) => {
    const want = Array.from({ length: WINDOW }, (_, i) => to - WINDOW + 1 + i).filter((n) => !ticks.has(n));
    if (want.length) {
      const [hs, ss] = await Promise.all([
        Promise.all(want.map((n) => rpc.block(n, signal).catch((e) => { if (isAbort(e)) throw e; return null as RawBlock | null; }))),
        signersFor(want, signal),
      ]);
      if (signal.aborted) return;
      want.forEach((n, i) => {
        const b = hs[i];
        ticks.set(n, { n, signer: ss.get(n), turn: b ? inTurn(Number(BigInt(b.difficulty))) : null, ts: b ? Number(BigInt(b.timestamp)) : 0 });
      });
    }
    top = Math.max(top, to);
    for (const n of ticks.keys()) if (n <= top - WINDOW) ticks.delete(n);
  };

  const paintSigners = () => {
    const w = windowTicks();
    if (!w.length) return;
    const rows = laneRows(set, w);
    const active = rows.filter((r) => r.count > 0).length;
    const inT = w.filter((t) => t.turn === true).length;
    const unread = w.filter((t) => !t.signer).length;
    put(root, "sig-sum", html`<span><strong>${active} of ${rows.length}</strong> confirming</span><span>in turn <strong>${pct((inT / w.length) * 100, 1)}</strong> <span class="faint">(${inT} of ${w.length})</span></span>${unread ? html`<span class="faint" title="${RPC_DOWN}">${unread} signers unread</span>` : ""}<span class="ns-key"><i class="in"></i>in turn</span><span class="ns-key"><i class="out"></i>out of turn</span>`);
    put(root, "lanes", lanesHtml(rows, w, top));
    // measured block time over the window (calc, ESTIMATE)
    const first = w[0], last = w[w.length - 1];
    if (first.ts && last.ts && w.length > 1) {
      const m = (last.ts - first.ts) / (last.n - first.n);
      put(root, "btime-s", html`<span title="Measured over the last ${w.length} blocks from the chain">${m.toFixed(1)} s over ${w.length} blocks</span> ${prov("estimate")}`);
    }
    // the table: drawn once, then cells update in place (focus is never lost)
    if (!tableDrawn) {
      tableDrawn = true;
      put(root, "sig-table", html`<p class="xp-cap">Last 64 and last confirmed are read from the chain; total confirmed is the explorer's index count of canonical blocks (forked blocks excluded).</p>${table({ caption: "Signers", captionHidden: true, cols: SIGNER_COLS(top), rows: rows.map((r) => r.addr), rowAttrs: (a) => html`data-row="${a}"` })}`);
      rows.forEach((r) => void loadSignerIndex(r.addr));
    }
    rows.forEach((r) => {
      const inWin = w.filter((t) => lc(t.signer) === r.addr);
      put(root, `s64-${r.addr}`, html`${int(r.count)}${sub(html`${r.inTurn} in turn`)}`);
      const lastT = inWin[inWin.length - 1];
      if (lastT) {
        put(root, `slast-${r.addr}`, html`${blockLink(lastT.n)}${sub(ago(lastT.ts))}`);
        put(root, `sst-${r.addr}`, html`<span class="st"><span class="status-dot ok" aria-hidden="true"></span>Confirming</span>`);
      } else {
        const seen = lastSeen.get(r.addr);
        if (seen === undefined) return; // still loading from the index
        put(root, `slast-${r.addr}`, seen ? html`${blockLink(seen.n)}${sub(ago(seen.ts))}` : dash());
        put(root, `sst-${r.addr}`, html`<span class="faint">Authorised · idle${seen ? ` since ${dayLabel(seen.ts)}` : ""}</span>`);
      }
    });
  };

  const idx = limit(3);
  const loadSignerIndex = async (a: string) => {
    // canonical blocks only: the index's counter also counts this signer's forked blocks (canon.ts)
    const counters = idx(() => Promise.all([api.addressCounters(a, { signal }), nonCanonical(a, signal)])).then(([c, nc]) => {
      const raw = c.blocksConfirmed && Number(c.blocksConfirmed) > 0 ? Number(c.blocksConfirmed) : null;
      totals.set(a, raw === null ? null : String(canonicalCount(raw, nc)));
      if (nc.forked) excluded.set(a, nc.forked);
    }, (e) => { if (!isAbort(e)) totals.set(a, null); });
    const lastB = idx(() => api.addressBlocksConfirmed(a, null, { signal })).then((p) => {
      const b: Block | undefined = p.items[0];
      lastSeen.set(a, b ? { n: b.height, ts: b.timestamp } : null);
    }, (e) => { if (!isAbort(e)) lastSeen.set(a, null); });
    await Promise.allSettled([counters, lastB]);
    if (signal.aborted) return;
    const t = totals.get(a), x = excluded.get(a);
    put(root, `stot-${a}`, t ? html`<span${x ? html` title="Excludes ${int(x)} forked block${x === 1 ? "" : "s"}"` : ""}>${int(t)}</span>` : dash());
    paintSigners();
  };

  const loadSigners = async (to: number) => {
    if (loading) { pendingTop = Math.max(pendingTop, to); return; }
    loading = true;
    try {
      if (!set.length) set = await authorisedSigners(signal).catch((e) => { if (isAbort(e)) throw e; return [] as string[]; });
      await fillWindow(to);
      if (signal.aborted) return;
      paintSigners();
    } catch (e) {
      if (isAbort(e) || signal.aborted) return;
      const host = keyEl(root, "lanes");
      if (host) host.innerHTML = html`<p class="xp-msg">${RPC_DOWN}: the signer lanes need the chain's recent headers. <button type="button" class="btn btn-secondary btn-sm" data-retry>Retry</button></p>`.s;
      host?.querySelector("[data-retry]")?.addEventListener("click", () => void loadSigners(to), { once: true });
      put(root, "sig-sum", "");
    } finally {
      loading = false;
      if (pendingTop > top && !signal.aborted) { const p = pendingTop; pendingTop = 0; void loadSigners(p); }
    }
  };

  const onNewHead = (h: Head) => {
    if (!top) return; // the first window is still loading
    if (h.n <= top) return;
    if (h.n === top + 1 && h.signer) {
      ticks.set(h.n, { n: h.n, signer: h.signer, turn: inTurn(h.difficulty), ts: h.ts });
      top = h.n;
      for (const n of ticks.keys()) if (n <= top - WINDOW) ticks.delete(n);
      paintSigners();
    } else void loadSigners(h.n);
  };

  /* ---------------- 3 · transactions per day ---------------- */
  const loadChart = async () => {
    const host = root.querySelector<HTMLElement>(".ns-chart-host");
    if (!host) return;
    try {
      const [r, lt] = await Promise.all([api.txChart({ signal }), ltStatsOrNull(signal).catch(() => null)]);
      if (signal.aborted) return;
      // per day without Wizrd's load test (src/loadtest.ts); unchanged, and labelled, when its counters can't be read
      const days = organicDaily([...(r.chart_data ?? [])].slice(0, 30).reverse(), (p) => Number(p.transactions_count) || 0, lt);
      const pts = days.map((p) => ({ date: p.date, value: p.n }));
      if (!pts.length) { mount(host, html`<div class="xp-body">${note("The explorer's index has no daily counts yet.")}</div>`); return; }
      put(root, "txday-aside", html`<span>${dayLabel(pts[0].date)} – ${dayLabel(pts[pts.length - 1].date, true)} · UTC days</span>`);
      host.replaceChildren();
      const c = document.createElement("div");
      host.append(c);
      areaChart(c, pts, { unit: "transactions", label: "Transactions per day", signal });
      const rows = [...pts].reverse();
      host.insertAdjacentHTML("beforeend", html`<details class="xp-details"><summary>Show data</summary>${table({
        caption: "Transactions per day, newest first", captionHidden: true, dense: true, rows,
        cols: [
          { label: "Day (UTC)", cell: (p) => html`<time datetime="${p.date}">${dayLabel(p.date, true)}</time>` },
          { label: "Transactions", cell: (p) => (p.value ? int(p.value) : html`<span class="zero">0</span>`), align: "r", end: true },
        ],
      })}</details>`.s);
      const lnote = ltDailyNote(days, lt);
      if (lnote) host.insertAdjacentHTML("beforeend", html`<p class="xp-foot lt-line">${lnote}</p>`.s);
    } catch (e) {
      showError(host, e, () => void loadChart());
    }
  };

  /* ---------------- 4 · gas ---------------- */
  const paintGasHead = (h: Head) => {
    put(root, "basefee", h.baseFee === null ? dash("This block reports no base fee") : gas(h.baseFee));
    put(root, "basefee-s", html`block ${blockLink(h.n)} · burnt`);
    put(root, "gaslimit", int(h.gasLimit));
    put(root, "gaslimit-s", html`<span class="num-mono">${int(h.gasUsed)}</span> used in block ${int(h.n)}`);
  };
  const loadGas = async () => {
    const [tip, price] = await Promise.allSettled([rpc.maxPriorityFee(signal), rpc.gasPrice(signal)]);
    if (signal.aborted) return;
    if (tip.status === "fulfilled") { put(root, "tip", gas(tip.value)); put(root, "tip-s", "suggested by the node"); }
    else put(root, "tip", dash(RPC_DOWN));
    if (price.status === "fulfilled") {
      put(root, "gasprice", html`<span title="${int(price.value)} wei">${gasPriceExact(price.value)}</span>`);
      put(root, "gasprice-s", html`base fee + tip · <span class="num-mono">${int(price.value)}</span> wei`);
    } else put(root, "gasprice", dash(RPC_DOWN));
  };

  /* ---------------- 5 · rewards (per schedule) ---------------- */
  let rewardsAt = -1;
  const paintRewards = (h: Head) => {
    const epoch = Math.floor(h.n / HALVING);
    if (epoch === rewardsAt && keyEl(root, "halving")) return;
    rewardsAt = epoch;
    const sp = scheduleReward(h.n);
    const host = root.querySelector<HTMLElement>('[data-slot="rewards"]');
    if (!host || !sp) return;
    const f = (w: bigint) => html`<span class="num-mono">${units(w, 18, 6)}</span><span class="unit">FMX</span>`;
    mount(host, kv([[
      { label: "Per block", value: html`${f(sp.total)} <span class="faint">block subsidy from 160,000</span>`, hint: "The block subsidy halves every 4,500,000 blocks." },
      { label: "To the signer", value: html`${f(sp.signer)} <span class="faint">40% · plus every transaction tip</span>` },
      { label: "To the reward sink", value: html`${f(sp.sink)} <span class="faint">50%</span> ${addrChip(REWARD_SINK)}` },
      { label: "To the treasury", value: html`${f(sp.treasury)} <span class="faint">10%</span> ${addrChip(TREASURY)}` },
      { label: "Base fee", value: html`Burnt <span class="faint">the base fee of every transaction is destroyed</span>` },
      { label: "Next halving", value: html`<span data-k="halving"></span>` },
    ]]));
    paintHalving();
  };
  const paintHalving = () => {
    if (!head) return;
    const next = (Math.floor(head.n / HALVING) + 1) * HALVING;
    const left = next - head.n;
    const secs = avgMs ? (left * avgMs) / 1000 : left * 7;
    put(root, "halving", html`block <span class="num-mono">${int(next)}</span> <span class="faint">in ${int(left)} blocks · about ${dur(secs)}</span> ${prov("estimate")}`);
  };

  /* ---------------- 6 · agents on chain (gateway) ---------------- */
  const loadAgents = async () => {
    const host = keyEl(root, "agents-grid");
    try {
      const s: GwStats = await gw.stats(signal);
      if (signal.aborted) return;
      const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? int(v) : dash("Not reported by the gateway"));
      put(root, "ag", n(s.agents)); put(root, "ag-s", "registered");
      put(root, "ag-act", n(s.activeAgents)); put(root, "ag-act-s", "status Active");
      put(root, "jobs", n(s.jobs)); put(root, "jobs-s", "on ServiceEscrow");
      put(root, "jobs-done", n(s.jobsCompleted)); put(root, "jobs-done-s", "released to agents");
      put(root, "escrow", s.volumeWei != null ? amountCell(s.volumeWei) : dash("Not reported by the gateway")); put(root, "escrow-s", "FMX");
      put(root, "x402", n(s.x402Settlements));
      put(root, "x402-s", s.x402VolumeWei != null ? html`<span class="num-mono">${amountCell(s.x402VolumeWei)}</span> FMX` : "");
      put(root, "wallets", n(s.accountsCreated)); put(root, "wallets-s", "AgentAccount");
      put(root, "atokens", n(s.tokensLaunched)); put(root, "atokens-s", "launched");
    } catch (e) {
      if (isAbort(e) || !host) return;
      host.innerHTML = html`<p class="xp-msg">${GW_DOWN} <button type="button" class="btn btn-secondary btn-sm" data-retry>Retry</button></p>`.s;
      host.querySelector("[data-retry]")?.addEventListener("click", () => {
        host.innerHTML = agentsGrid().s;
        void loadAgents();
      }, { once: true });
    }
  };

  /* ---------------- go: independent panels ---------------- */
  // registered after every painter above exists: `now` calls it at once when the head is already known
  onHead((h) => { if (!signal.aborted) { paintHead(h); paintGasHead(h); paintRewards(h); onNewHead(h); } }, signal, { now: true });
  void loadChain();
  void loadChart();
  void loadGas();
  void loadAgents();
  firstHead(signal).then((h) => {
    if (signal.aborted) return;
    paintHead(h); paintGasHead(h); paintRewards(h);
    void loadSigners(h.n);
  }, () => { /* aborted */ });
  // the head store may be down: say so in the cells that depend on it after 10 s
  window.setTimeout(() => {
    if (signal.aborted || head) return;
    ["head", "basefee", "gaslimit"].forEach((k) => put(root, k, dash(RPC_DOWN)));
    const lanes = keyEl(root, "lanes");
    if (lanes && !top) lanes.innerHTML = html`<p class="xp-msg">${RPC_DOWN}: the signer lanes need the chain's recent headers. They appear as soon as the chain answers.</p>`.s;
    put(root, "sig-sum", "");
    const rw = root.querySelector<HTMLElement>('[data-slot="rewards"]');
    if (rw && rewardsAt < 0) rw.innerHTML = html`<p class="xp-msg">${RPC_DOWN}: the reward split follows the latest block height.</p>`.s;
  }, 10_000);
}

/* The signer table: cells keyed per address, filled in place by paintSigners() / loadSignerIndex(). */
const SIGNER_COLS = (height: number): Col<string>[] => [
  { label: "Signer", cell: (a) => rowLink(`/address/${a}`, seal({ height, signer: a, name: true }), `Signer ${signerNo(a) ?? "?"}, ${a}`) },
  { label: "Address", cell: (a) => addrChip(checksum(a), { label: false }), line: 2 },
  { label: "Last 64", cell: (a) => html`<span data-k="s64-${a}">${sk("32px")}</span>`, align: "r", line: 3, l: "Last 64" },
  { label: "Total confirmed", cell: (a) => html`<span data-k="stot-${a}">${sk("56px")}</span>`, align: "r", line: 3, l: "Total", end: true },
  { label: "Last confirmed", cell: (a) => html`<span data-k="slast-${a}">${sk("64px")}</span>`, align: "r", line: 2, end: true },
  { label: "Status", cell: (a) => html`<span data-k="sst-${a}">${sk("72px")}</span>`, end: true },
];
