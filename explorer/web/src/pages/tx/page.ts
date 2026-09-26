/* The transaction page controller (surfaces/explorer.md §5.5), loaded by pages/tx.ts right after it paints the
   shell. One state object, pure renderers (view.ts), and independent loaders:
     index /transactions/:h  →  overview + side (first paint)
       ├ index /logs (page 1)                          → tabs (Events count)
       ├ RPC clique_getSigner(n) + header (one batch)  → signer seal, in turn / out of turn
       ├ the lazy decode chunk (after first paint)     → sentence, decoded input and events, method name
       │    └ gateway /jobs/:id when a jobId decodes   → the job rail
       └ head store                                    → live confirmations
   Each loader fails on its own: a missing signer is "—", a failed chunk leaves the raw data, a gateway failure
   hides the rail behind one line. Pending and not-found live in pending.ts. */
import "./tx.css";
import { html, mount, type Html } from "../../ui/html";
import { tabsHtml, bindTabs, type TabDef, type TabsHandle } from "../../ui/tabs";
import { sk, skLine } from "../../ui/skeleton";
import { showError, note, errorBox } from "../../ui/state";
import { prov } from "../../ui/marks";
import { api, ApiError } from "../../api";
import { rpc } from "../../rpc";
import { signersFor } from "../../signer";
import { onHead, currentHead } from "../../head";
import { gw, GW_DOWN, type Job } from "../../gateway";
import { label as bookLabel } from "../../book";
import { POSA_BLOCK } from "../../known";
import { liveText } from "../../motion";
import { int, short, toSec } from "../../format";
import { isAbort } from "../../util";
import { setMeta, resolveTab } from "../../router";
import type { Tx, Log, TokenTransfer, StateChange, PageParams } from "../../types";
import * as V from "./view";
import { ltSender, ltSenderPending } from "../../loadtest";
import { missing, watchIndexPending } from "./pending";
import type * as Story from "./story";

export interface RunOpts { h: string; query: URLSearchParams; signal: AbortSignal; root: HTMLElement; txP: Promise<Tx>; restart: () => void }

interface State {
  tx: Tx;
  head: number | null;
  signer: string | null | undefined;
  difficulty: string | null;
  logs: Log[] | null;
  logsNext: PageParams | null;
  logsErr: unknown;
  story: typeof Story | null;
  a: Story.Analysis | null;
  job: Job | null | "down";
  closedTs: number | null;
  tabs: TabsHandle | null;
}

const slot = (root: ParentNode, id: string) => root.querySelector<HTMLElement>(`[data-slot="${id}"]`);

export async function run(o: RunOpts) {
  const { h, signal, root } = o;
  let tx: Tx;
  try { tx = await o.txP; }
  catch (e) {
    if (signal.aborted || isAbort(e)) return;
    if (e instanceof ApiError && e.kind === "not_found") { void missing(o); return; }
    if (e instanceof ApiError && e.kind === "invalid") { void missing(o, true); return; }
    showError(slot(root, "ov"), e, () => void run({ ...o, txP: api.tx(h, { signal, fresh: true }) }));
    mount(slot(root, "story"), "");
    return;
  }
  if (signal.aborted) return;

  const S: State = { tx, head: currentHead()?.n ?? null, signer: undefined, difficulty: null, logs: null, logsNext: null, logsErr: null, story: null, a: null, job: null, closedTs: null, tabs: null };
  const n = tx.block_number;
  const statusWord = tx.status === "ok" ? "Success" : tx.status === "error" ? "Failed" : "Pending";
  setMeta({ title: `Transaction ${short(h, 4)}`, description: `${statusWord} transaction ${h} on Ferminux Network (chain 3961)${n !== null ? ` in block ${int(n)}` : ""}: parties, value, fee and events.` });

  /* ---- painters ---- */
  const ctx = (): Story.Ctx => ({ tx: S.tx, logs: S.logs ?? [], tts: S.tx.token_transfers ?? [], job: S.job && S.job !== "down" ? S.job : null });
  const paintHead = () => mount(slot(root, "pills"), V.pills(S.tx, S.a?.input?.name));
  const paintOverview = () => {
    const dec = S.a?.input && S.story ? S.story.inputBlock(S.a.input) : S.story === null && S.tx.raw_input !== "0x" ? html`<p class="faint small dec-wait">${skLine("40%")}</p>` : "";
    mount(slot(root, "ov"), html`<h2 class="vh">Overview</h2>${V.overview(S.tx, { head: S.head, signer: S.signer, difficulty: S.difficulty, revertText: S.a?.revert?.text ?? null, inputDecoded: dec })}`);
  };
  const paintSide = () => {
    const ids = S.story ? S.story.agentsInTx(S.tx, S.a) : [];
    mount(slot(root, "side"), html`${V.agentCards(ids)}${V.blockPanel(S.tx, { head: S.head, signer: S.signer, difficulty: S.difficulty })}`);
  };
  const paintStory = () => {
    const host = slot(root, "story");
    if (!host) return;
    if (!S.story || !S.a?.story) { host.hidden = S.story !== null; if (S.story) mount(host, ""); return; }
    host.hidden = false;
    const more = S.a.more;
    mount(host, html`<section class="story" aria-labelledby="story-h"><h2 id="story-h" class="vh">What happened</h2>
      <div class="story-top"><p class="story-s">${S.a.story}</p>${S.a.decoded ? prov("abi") : ""}</div>
      ${more ? html`<p class="story-more"><a class="link-arrow" href="/tx/${h}?tab=logs" data-tab-link="logs">and ${int(more)} more ${more === 1 ? "event" : "events"} →</a></p>` : ""}
      ${S.a.jobId !== null ? html`<div class="story-job">${jobHtml()}</div>` : ""}
    </section>`);
  };
  const jobHtml = (): Html => {
    if (S.job === "down") return html`<p class="faint small">${GW_DOWN}</p>`;
    if (!S.job) return html`<div class="job skel" aria-busy="true">${skLine("50%")}${sk("100%", "44px")}</div>`;
    return S.story!.jobRail(S.job, h, S.closedTs);
  };
  const paintAll = () => { paintHead(); paintOverview(); paintSide(); paintStory(); paintPanels(); };

  /* ---- tabs ---- */
  const loaded = new Map<string, HTMLElement>();
  const panelPaint: Record<string, (p: HTMLElement) => void> = {};
  const paintPanels = () => loaded.forEach((p, k) => panelPaint[k]?.(p));

  const ttCount = (): number | { n: number; capped: boolean } => (S.tx.token_transfers_overflow ? { n: (S.tx.token_transfers ?? []).length, capped: true } : (S.tx.token_transfers ?? []).length);
  const logsCount = () => (S.logs === null ? null : S.logsNext ? { n: S.logs.length, capped: true } : S.logs.length);

  function paintTabs() {
    const host = slot(root, "tabs");
    if (!host) return;
    const tt = ttCount(), lg = logsCount();
    const has = (c: number | { n: number } | null) => c !== null && (typeof c === "number" ? c > 0 : c.n > 0);
    const def = has(tt) ? "token_transfers" : has(lg) || lg === null ? "logs" : "state";
    const want = resolveTab("tx", o.query).tab ?? def;
    const defs: TabDef[] = [
      { key: "token_transfers", label: "Token transfers", count: tt },
      { key: "logs", label: "Events", count: lg, always: S.logs === null },
      { key: "state", label: "Balance changes", always: true },
    ];
    mount(host, html`<section class="tx-tabs" aria-label="Transaction details"><h2 class="vh">Details</h2><div>${tabsHtml("txt", defs, want, "Transaction details")}</div></section>`);
    S.tabs = bindTabs(host, "txt", def, (key, panel) => { loaded.set(key, panel); panelPaint[key]?.(panel); }, signal);
  }

  // Token transfers: embedded in the tx (≤ 50); overflow pages through the index.
  let ttAll: TokenTransfer[] | null = S.tx.token_transfers_overflow ? null : S.tx.token_transfers ?? [];
  let ttNext: PageParams | null = null, ttBusy = false;
  const loadTt = async (p: HTMLElement, more = false) => {
    if (ttBusy) return; ttBusy = true;
    try {
      const r = await api.txTokenTransfers(h, more ? ttNext : null, { signal });
      if (signal.aborted) return;
      ttAll = more ? [...(ttAll ?? []), ...r.items] : r.items; ttNext = r.next_page_params;
      panelPaint.token_transfers(p);
    } catch (e) { showError(p, e, () => void loadTt(p, more)); }
    finally { ttBusy = false; }
  };
  panelPaint.token_transfers = (p) => {
    if (ttAll === null) { mount(p, html`<div class="skel" aria-busy="true">${skLine("70%")}${skLine("60%")}</div>`); void loadTt(p); return; }
    mount(p, html`${V.ttTable(ttAll)}${ttNext ? html`<p class="more-row"><button type="button" class="btn btn-secondary btn-sm" data-more="tt">Load more</button></p>` : ""}`);
    p.querySelector("[data-more=tt]")?.addEventListener("click", () => void loadTt(p, true), { once: true });
  };

  // Events: page 1 comes with the first load; "Load more" for the rest.
  const decodedEvent = (log: Log): V.EventView | null => {
    if (!S.story || !S.a) return null;
    const i = S.logs?.indexOf(log) ?? -1;
    const d = i >= 0 && i < S.a.events.length ? S.a.events[i] : S.story.decodeLog(log);
    if (!d.name || !d.args) return null;
    return { name: d.name, sig: d.sig ?? d.name, generic: d.generic, line: S.story.eventLine(d, ctx(), S.a), args: S.story.argsTable(d.args, d.abi, d.name) };
  };
  panelPaint.logs = (p) => {
    if (S.logsErr) { showError(p, S.logsErr, () => void loadLogs(false)); return; }
    if (S.logs === null) { mount(p, html`<div class="skel" aria-busy="true">${sk("100%", "96px")}</div>`); return; }
    if (!S.logs.length) { mount(p, html`<div class="empty">This transaction emitted no events.</div>`); return; }
    mount(p, html`${V.eventsList(S.logs.map((l) => V.eventCard(l, decodedEvent(l))))}${S.logsNext ? html`<p class="more-row"><button type="button" class="btn btn-secondary btn-sm" data-more="logs">Load more events</button></p>` : ""}`);
    p.querySelector("[data-more=logs]")?.addEventListener("click", () => void loadLogs(true), { once: true });
  };
  const loadLogs = async (more: boolean) => {
    try {
      const r = await api.txLogs(h, more ? S.logsNext : null, { signal });
      if (signal.aborted) return;
      S.logs = more ? [...(S.logs ?? []), ...r.items] : r.items; S.logsNext = r.next_page_params; S.logsErr = null;
    } catch (e) {
      if (signal.aborted || isAbort(e)) return;
      S.logsErr = e; if (S.logs === null) S.logs = null;
    }
    const lp = loaded.get("logs");
    if (lp) panelPaint.logs(lp);
  };

  // Balance changes: loads only with its tab.
  let sc: StateChange[] | null = null, scNext: PageParams | null = null, scErr: unknown = null, scBusy = false;
  const loadSc = async (p: HTMLElement, more = false) => {
    if (scBusy) return; scBusy = true;
    try {
      const r = await api.txStateChanges(h, more ? scNext : null, { signal });
      if (signal.aborted) return;
      sc = more ? [...(sc ?? []), ...r.items] : r.items; scNext = r.next_page_params; scErr = null;
    } catch (e) { if (signal.aborted || isAbort(e)) return; scErr = e; }
    finally { scBusy = false; }
    panelPaint.state(p);
  };
  panelPaint.state = (p) => {
    if (scErr) { mount(p, html`${note(V.stateNote(n !== null && n < POSA_BLOCK))}${errorBox(scErr)}`); p.querySelector("[data-retry]")?.addEventListener("click", () => { scErr = null; void loadSc(p); }, { once: true }); return; }
    if (sc === null) { mount(p, html`${note(V.stateNote(n !== null && n < POSA_BLOCK))}<div class="skel" aria-busy="true">${skLine("80%")}${skLine("70%")}${skLine("60%")}</div>`); void loadSc(p); return; }
    mount(p, html`${note(V.stateNote(n !== null && n < POSA_BLOCK))}${V.stateTable(sc, n !== null && n < POSA_BLOCK)}${scNext ? html`<p class="more-row"><button type="button" class="btn btn-secondary btn-sm" data-more="sc">Load more</button></p>` : ""}`);
    p.querySelector("[data-more=sc]")?.addEventListener("click", () => void loadSc(p, true), { once: true });
  };

  /* ---- first paint from the tx alone ---- */
  paintHead();
  paintOverview();
  paintSide();
  V.bindRaw(root);
  root.addEventListener("click", (e) => {
    const a = (e.target as Element).closest<HTMLAnchorElement>("[data-tab-link]");
    if (!a || !S.tabs) return;
    e.preventDefault();
    S.tabs.select(a.dataset.tabLink!, true);
    slot(root, "tabs")?.scrollIntoView({ block: "start" });
  });

  if (tx.status === null || n === null) watchIndexPending(o, S.tx, (t) => { S.tx = t; paintAll(); });
  // the FXLT marker labels the transaction only when its sender is a load-test wallet (src/loadtest.ts)
  if (ltSenderPending(tx)) void ltSender(tx.from.hash, signal).then((yes) => { if (yes && !signal.aborted) paintAll(); }, () => undefined);

  /* ---- parallel loaders ---- */
  const logsP = loadLogs(false);
  const signerP = (async () => {
    if (n === null || n < POSA_BLOCK) { S.signer = n === null ? undefined : null; return; }
    const [m, hdr] = await Promise.all([signersFor([n], signal).catch(() => null), rpc.block(n, signal).catch(() => null)]);
    if (signal.aborted) return;
    S.signer = m?.get(n) ?? undefined;
    S.difficulty = hdr ? String(Number(BigInt(hdr.difficulty))) : null;
    paintOverview(); paintSide();
  })();
  void logsP.then(() => { if (!signal.aborted) paintTabs(); });

  // live confirmations from the one head reader
  onHead((hd) => {
    S.head = hd.n;
    if (S.tx.block_number === null) return;
    const c = V.confirmationsOf(S.tx, hd.n);
    root.querySelectorAll<HTMLElement>("[data-conf]").forEach((el) => {
      if (el.dataset.v === undefined) el.dataset.v = el.textContent ?? "";
      liveText(el, int(c), true);
    });
    root.querySelectorAll<HTMLElement>("[data-conf-w]").forEach((el) => { el.textContent = c === 1 ? "confirmation" : "confirmations"; });
  }, signal);

  // names arrive with the book (gateway agents, wallets, tokens): re-label only when a label changed
  const addrs = [S.tx.from?.hash, S.tx.to?.hash, S.tx.created_contract?.hash].filter(Boolean) as string[];
  const sig = () => addrs.map((a) => bookLabel(a)?.name ?? "").join("|");
  let lastSig = sig();
  const onBook = () => { if (signal.aborted) return; const s = sig(); if (s !== lastSig) { lastSig = s; paintAll(); } };
  document.addEventListener("fx:book", onBook);
  signal.addEventListener("abort", () => document.removeEventListener("fx:book", onBook), { once: true });

  /* ---- the decode chunk, after first paint ---- */
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
  if (signal.aborted) return;
  let story: typeof Story;
  try {
    story = await import("./story");
    await Promise.all([story.ready(signal), gw.agents(signal).catch(() => [])]);
  } catch (e) {
    if (signal.aborted) return;
    // the chunk failed: selectors and raw logs stay, the sentence card hides (§8.3)
    S.story = null; mount(slot(root, "story"), ""); const s = slot(root, "story"); if (s) s.hidden = true;
    root.querySelector(".dec-wait")?.remove();
    void e; return;
  }
  if (signal.aborted) return;
  await logsP;
  if (signal.aborted) return;
  S.story = story;
  S.a = story.analyse(ctx());
  lastSig = sig();
  paintHead(); paintOverview(); paintSide(); paintStory(); paintPanels();
  void signerP;

  // the job rail, when the call or an event names a job
  if (S.a.jobId !== null) {
    try {
      S.job = await gw.job(S.a.jobId, signal);
      if (signal.aborted) return;
      S.a = story.analyse(ctx()); // sentences that name the client or agent read them from the job
      paintStory(); paintSide(); paintPanels();
      const closed = S.job.tx?.closed;
      if (closed) {
        const t = closed.toLowerCase() === h.toLowerCase() ? S.tx : await api.tx(closed, { signal }).catch(() => null);
        if (signal.aborted) return;
        S.closedTs = t?.timestamp ? toSec(t.timestamp) : null;
        paintStory();
      }
    } catch (e) {
      if (signal.aborted || isAbort(e)) return;
      S.job = "down"; paintStory();
    }
  }
}
