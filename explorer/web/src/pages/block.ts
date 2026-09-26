/* Block `/block/:numberOrHash` (surfaces/explorer.md §5.3).
   - Reads, in parallel: BS /blocks/:id, the RPC header (vanity, seal, checkpoint signer list, state root) and
     clique_getSigner(n) (always: the chain's word). The number path sends the two RPC calls as one batch.
   - Head: crumbs, h1 with ‹ › (next appears live when the head moves), the signer line.
   - Layout 8/4 (the tx page's): the grouped details (BLOCK · SIGNER · REWARD · GAS) on the left; a rail with the
     signer card, the blocks around this one (the rotation) and, for a busy block, its first transactions.
   - A block with 5 transactions or fewer lists them under the details; a busier one has Details · Transactions
     tabs (?tab=txs, BS /blocks/:id/transactions, 50 per page).
   - A forked block (not canonical) earns no reward and links to the canonical block at its height.
   - Proof-of-work era (< 160,000): Producer · Difficulty · Uncles, one "Block reward" row, and the note.
   - A number above the head replaces to the countdown. A block the chain has but the index hasn't recorded
     yet (the newest seconds, or an index outage) renders from the chain header alone (§8.5). */
import "./home-blocks/blocks.css";
import { html, mount, dash, type Html } from "../ui/html";
import { addrChip, blockHashChip, fullHash, txChip, halfWidth } from "../ui/hash";
import { copyBtn } from "../ui/copy";
import { amtExact, ago, when, pill, prov, gasUsed, amt } from "../ui/marks";
import { seal } from "../ui/seal";
import { kv, type Row, type Group } from "../ui/kv";
import { tabsHtml, bindTabs } from "../ui/tabs";
import { table, tableSkeleton } from "../ui/table";
import { pagerHtml, bindPager, pageOf } from "../ui/pager";
import { kvSkeleton, identSkeleton, sk } from "../ui/skeleton";
import { empty, note, showError } from "../ui/state";
import { icon } from "../ui/icons";
import { shell, slot } from "./_shell";
import { notFound } from "./notFound";
import { resolveTab, setMeta, navigate, type Params } from "../router";
import { api, ApiError } from "../api";
import { rpc, RPC_DOWN, type RawBlock } from "../rpc";
import { onHead, currentHead, firstHead } from "../head";
import { signersFor, signerFromHeader, signerNo, signerAddr, inTurn, vanityOf, sealOf, checkpointSigners, scheduleReward } from "../signer";
import { POSA_BLOCK, REWARD_SINK, TREASURY } from "../known";
import { isCheckpointHeight } from "../validators/config";
import { liveText } from "../motion";
import { big, int, short, utc, gasPriceExact, weiInt } from "../format";
import { checksum } from "../enrich/checksum";
import { isAbort, lc, sleep, ZERO } from "../util";
import { burntExact } from "./home-blocks/cells";
import { txCols, hydrateMethods, kindMethod } from "../ui/txcols";
import type { AddressParam, Block, Reward } from "../types";

/** One view of a block, from the index, the chain header, or both. */
interface M {
  n: number; hash: string; parent: string | null; ts: string | number | null; txs: number | null;
  gasUsed: string | null; gasLimit: string | null; baseFee: string | null; burnt: string | null;
  difficulty: string | null; size: number | null; nonce: string | null; totalDifficulty: string | null;
  type: string; era: "authority" | "pow"; producer: AddressParam | string | null; rewards: Reward[]; tips: string | null;
  uncles: string[]; indexSigner: string | null; fromIndex: boolean;
}
const hexStr = (h: string | undefined | null) => (h ? BigInt(h).toString() : null);
function fromIndex(b: Block): M {
  return {
    n: b.height, hash: b.hash, parent: b.parent_hash, ts: b.timestamp, txs: b.transactions_count, gasUsed: b.gas_used, gasLimit: b.gas_limit,
    baseFee: b.base_fee_per_gas, burnt: b.burnt_fees, difficulty: b.difficulty, size: b.size, nonce: b.nonce, totalDifficulty: b.total_difficulty,
    type: b.type, era: b.era, producer: b.producer, rewards: b.rewards ?? [], tips: b.priority_fee,
    // the index lists uncles as {hash} objects (the chain header as plain strings)
    uncles: (b.uncles_hashes ?? []).map((u) => (typeof u === "string" ? u : u?.hash ?? "")).filter(Boolean),
    indexSigner: b.signer?.hash ? lc(b.signer.hash) : null, fromIndex: true,
  };
}
function fromHeader(h: RawBlock): M {
  const n = Number(BigInt(h.number));
  return {
    n, hash: h.hash, parent: h.parentHash, ts: Number(BigInt(h.timestamp)), txs: h.transactions.length, gasUsed: hexStr(h.gasUsed), gasLimit: hexStr(h.gasLimit),
    baseFee: hexStr(h.baseFeePerGas), burnt: null, difficulty: hexStr(h.difficulty), size: h.size ? Number(BigInt(h.size)) : null, nonce: h.nonce,
    totalDifficulty: hexStr(h.totalDifficulty), type: "block", era: n >= POSA_BLOCK ? "authority" : "pow",
    producer: n < POSA_BLOCK && h.miner && lc(h.miner) !== ZERO ? h.miner : null, rewards: [], tips: null, uncles: h.uncles ?? [],
    indexSigner: null, fromIndex: false,
  };
}

const TURN_HINT = "Signers take turns. The signer whose turn it is confirms with difficulty 2; another authorised signer may confirm with difficulty 1 when the in-turn signer is late.";
const NOT_INDEXED = "Not recorded by the index yet";
/** The chain no longer has a forked block's header: the node keeps only the canonical chain. */
const FORK_GONE = "The node no longer keeps this forked block's header, and the index didn't record its signer";
/** At most this many transactions are listed under the details instead of behind a tab. */
const INLINE_TXS = 5;
type HdrState = "ok" | "gone" | "down";

export function render(p: Params, query: URLSearchParams, signal: AbortSignal, root: HTMLElement) {
  const id = p.id.replace(/,/g, "");
  const isNum = /^\d+$/.test(id), isHash = /^0x[0-9a-f]{64}$/i.test(id);
  if (!isNum && !isHash) { notFound(root, { h1: "That isn't a block number or hash", body: "A block is a number (like 396000) or 0x followed by 64 hexadecimal characters.", query: p.id }); return; }
  const n0 = isNum ? Number(id) : null;
  const label = isNum ? int(id) : `${id.slice(0, 6)}…${id.slice(-4)}`;
  const { tab } = resolveTab("block", query);
  const cur = pageOf(query);
  setMeta({ title: `Block ${label}` });
  shell(root, {
    crumbs: [{ href: "/blocks", label: "Blocks" }, { label }],
    h1: `Block ${label}`,
    ident: identSkeleton(),
    body: html`<div class="blkg"><div class="blkg-main" data-slot="main">${kvSkeleton(["Height", "Status", "Timestamp", "Transactions", "Confirmed by", "Turn", "Signer share", "Gas used", "Base fee"])}</div><aside class="blkg-side" data-slot="side" aria-label="Around this block"></aside></div>`,
  });

  root.firstElementChild?.classList.add("xblk");
  /* ---- head row: h1 + ‹ › (links: real history entries, and prefetch on hover) ---- */
  const head = root.querySelector<HTMLElement>(".page-head")!;
  head.classList.add("blk-head");
  const h1 = head.querySelector("h1")!;
  const row = document.createElement("div");
  row.className = "blk-h1row";
  h1.replaceWith(row);
  row.append(h1);
  row.insertAdjacentHTML("beforeend", html`<nav class="pn-nav" aria-label="Neighbouring blocks"><a class="pn" data-pn="prev" hidden>${icon("i-prev")}</a><a class="pn" data-pn="next" hidden>${icon("i-next")}</a></nav>`.s);
  const prevA = row.querySelector<HTMLAnchorElement>('[data-pn="prev"]')!, nextA = row.querySelector<HTMLAnchorElement>('[data-pn="next"]')!;
  const ident = head.querySelector<HTMLElement>(".ident");
  const main = slot(root, "main")!;
  const side = slot(root, "side")!;

  let m: M | null = null;
  let navN: number | null = n0; // canonical height, once known (a forked block has no neighbours to step to)
  const paintNav = () => {
    if (navN === null) return;
    const n = navN, hN = currentHead()?.n;
    prevA.hidden = n <= 0;
    prevA.href = `/block/${n - 1}`; prevA.setAttribute("aria-label", `Block ${int(n - 1)}`);
    nextA.href = `/block/${n + 1}`; nextA.setAttribute("aria-label", `Block ${int(n + 1)}`);
    nextA.hidden = hN === undefined || n >= hN;
  };
  paintNav();

  void load();

  async function load() {
    // start all three reads in this tick: the two RPC calls leave as one batch
    const bP = api.block(id, { signal }).then((b) => ({ b, e: null as unknown }), (e) => ({ b: null as Block | null, e }));
    const hst: { v: HdrState } = { v: "ok" };
    const hP = (n0 !== null ? rpc.block(n0, signal) : rpc.blockByHash(id, signal)).then((h) => { if (!h) hst.v = "gone"; return h; }, () => { hst.v = "down"; return null; });
    const sP = n0 !== null && n0 >= POSA_BLOCK ? signersFor([n0], signal).then((x) => x.get(n0), () => undefined) : null;
    const [{ b, e }, hdr] = await Promise.all([bP, hP]);
    if (signal.aborted) return;
    if (!b && isAbort(e)) return;

    if (b) m = fromIndex(b);
    else if (hdr) m = fromHeader(hdr);
    else {
      const missing = e instanceof ApiError && e.notFound;
      if (missing || !e) {
        if (n0 !== null) {
          const h = currentHead() ?? await Promise.race([firstHead(signal), sleep(3000, signal).then(() => null)]).catch(() => null);
          if (signal.aborted) return;
          if (h && n0 > h.n) { navigate(`/block/countdown/${n0}`, { replace: true }); return; }
        }
        notFound(root, isHash
          ? { h1: "No block with that hash on chain 3961", body: html`Neither the explorer's index nor the chain knows block ${short(id, 8)}. If it is a transaction hash, <a class="link-inline" href="/tx/${id}">open it as a transaction</a>.`, query: id }
          : { h1: `Block ${label} isn't on chain 3961`, body: "Neither the explorer's index nor the chain has a block at that height.", query: id });
        return;
      }
      showError(main, e, () => { mount(main, kvSkeleton(["Height", "Status", "Timestamp"])); void load(); });
      return;
    }
    const md = m;

    // the signer: the chain's word for canonical blocks; a forked block's own seal otherwise
    let signer: string | null | undefined = undefined;
    let signerProv: "chain" | "index" = "chain";
    if (md.era === "authority") {
      if (md.type === "block") {
        signer = sP ? await sP : await signersFor([md.n], signal).then((x) => x.get(md.n), () => undefined);
        if (signer === undefined && hdr) signer = await signerFromHeader(hdr).catch(() => undefined) ?? undefined;
        if (signer === undefined && md.indexSigner) { signer = md.indexSigner; signerProv = "index"; }
      } else {
        signer = md.indexSigner ?? (hdr && lc(hdr.hash) === lc(md.hash) ? await signerFromHeader(hdr).catch(() => undefined) ?? undefined : undefined);
        signerProv = md.indexSigner ? "index" : "chain";
      }
      if (signal.aborted) return;
    } else signer = null;
    const extra = hdr && lc(hdr.hash) === lc(md.hash) ? hdr.extraData : null;

    // the header we hold is this block's only when the hashes match (a number reads the canonical header)
    const own = hdr && lc(hdr.hash) === lc(md.hash) ? hdr : null;
    const hs: HdrState = own ? "ok" : hst.v === "down" ? "down" : "gone";
    paint(md, signer, signerProv, extra, own, e, hs);
  }

  function paint(md: M, signer: string | null | undefined, signerProv: "chain" | "index", extra: string | null, hdr: RawBlock | null, indexErr: unknown, hs: HdrState) {
    /** Why a chain-read field is empty: the RPC failed, or the node no longer has this (forked) header. */
    const gone = hs === "down" ? RPC_DOWN : md.type !== "block" ? FORK_GONE : RPC_DOWN;
    const nLabel = int(md.n);
    const k = signerNo(signer);
    const who = md.era === "pow" ? "proof-of-work era" : k ? `confirmed by Signer ${k}` : signer ? `confirmed by ${short(signer, 4)}` : "confirmed by a signer";
    setMeta({
      title: `Block ${nLabel}`,
      description: `Block ${nLabel} on Ferminux Network (chain 3961), ${who}: ${md.txs === null ? "" : `${int(md.txs)} transaction${md.txs === 1 ? "" : "s"}, `}${utc(md.ts)}.`,
      canonical: md.type === "block" ? `/block/${md.n}` : `/block/${md.hash}`,
    });
    if (!isNum) {
      h1.textContent = `Block ${nLabel}`;
      const cr = head.querySelector('.crumbs [aria-current="page"]');
      if (cr) cr.textContent = nLabel;
    }
    navN = md.type === "block" ? md.n : null;
    if (navN === null) { prevA.hidden = true; nextA.hidden = true; }
    paintNav();

    /* ---- identity line ---- */
    const turn = md.difficulty === null ? null : inTurn(md.difficulty);
    const showCert = md.type === "block" && isCheckpointHeight(md.n); // §3.2 checkpoint validators: a small, isolated hook (../validators/blockBadge, lazy)
    const idLine: Html = md.era === "pow"
      ? html`<span>Produced by</span> ${md.producer ? addrChip(md.producer, { copy: false, label: false }) : dash("Not reported")} <span class="sep" aria-hidden="true">·</span> <span>proof-of-work era</span> <span class="sep" aria-hidden="true">·</span> ${ago(md.ts)}`
      : html`${md.type !== "block" ? html`${pill(md.type === "reorg" ? "Forked, not canonical" : "Uncle", "info")} ` : ""}<span aria-hidden="true">Confirmed by</span> ${signer ? seal({ height: md.n, signer, difficulty: md.difficulty, link: true, addr: true }) : html`<span class="vh">Confirmed by</span>${dash(md.type !== "block" && hs !== "down" ? FORK_GONE : RPC_DOWN)}`}${turn === null ? "" : html` <span class="sep" aria-hidden="true">·</span> <span${signer ? html` aria-hidden="true"` : ""}>${turn ? "in turn" : "out of turn"}</span>`} <span class="sep" aria-hidden="true">·</span> ${ago(md.ts)}${showCert ? html`<span data-slot="cert-badge"></span>` : ""}`;
    if (ident) { ident.classList.remove("skel"); ident.classList.add("blk-ident"); mount(ident, idLine); }
    if (showCert) { const b = ident?.querySelector<HTMLElement>('[data-slot="cert-badge"]'); if (b) void import("../validators/blockBadge").then((m) => m.paintCertifiedBadge(b, md.n, signal)); }

    /* ---- details: inline transactions for a quiet block, tabs for a busy one ---- */
    const lagNote = !md.fromIndex ? note(indexErr instanceof ApiError && !indexErr.notFound
      ? "The explorer's index didn't answer, so this page shows the chain's own header. Rewards and burnt fees appear once the index is back."
      : "The explorer's index hasn't recorded this block yet (it follows the chain by a few seconds). This page shows the chain's own header; rewards and burnt fees appear once the index has it.") : "";
    const inline = md.txs !== null && md.txs <= INLINE_TXS && cur.page === 1;
    let tabs: { select(key: string, focus?: boolean): void } | null = null;
    if (inline) {
      mount(main, html`${lagNote}<div data-slot="details"></div>${md.txs ? html`<section class="blk-txs" aria-labelledby="blk-txs-h"><h2 class="blk-sec" id="blk-txs-h">Transactions <span class="n">${int(md.txs)}</span></h2><div data-slot="txs-inline"></div></section>` : ""}`);
      detailsPanel(slot(main, "details")!, md, signer, signerProv, extra, hdr, gone);
      const tHost = slot(main, "txs-inline");
      if (tHost) {
        void txsPanel(tHost, md, false).then(() => { if (tab === "txs" && !signal.aborted) tHost.closest("section")?.scrollIntoView({ block: "start" }); });
      }
    } else {
      const active = tab === "txs" ? "txs" : "details";
      mount(main, html`${lagNote}${tabsHtml("blk", [{ key: "details", label: "Details", always: true }, { key: "txs", label: "Transactions", count: md.txs ?? undefined }], active, "Block sections")}`);
      tabs = bindTabs(main, "blk", "details", (key, panel) => {
        if (key === "details") detailsPanel(panel, md, signer, signerProv, extra, hdr, gone);
        else void txsPanel(panel, md, active === "txs");
      }, signal);
    }
    root.addEventListener("click", (ev) => {
      const a = (ev.target as Element).closest<HTMLAnchorElement>("[data-go-tab]");
      if (!a) return;
      ev.preventDefault();
      if (tabs) { tabs.select(a.dataset.goTab!, true); main.scrollIntoView({ block: "start" }); }
      else slot(main, "txs-inline")?.closest("section")?.scrollIntoView({ block: "start" });
    });

    /* ---- the rail ---- */
    paintSide(md, signer, hdr);

    /* ---- live: confirmations and the next-block link ---- */
    onHead((h) => {
      paintNav();
      const c = main.querySelector<HTMLElement>('[data-s="conf"]');
      if (c && md.type === "block") { const x = h.n - md.n + 1; liveText(c, x >= 1 ? `${int(x)} confirmation${x === 1 ? "" : "s"}` : "—"); }
    }, signal, { now: true });
  }

  function detailsPanel(panel: HTMLElement, md: M, signer: string | null | undefined, signerProv: "chain" | "index", extra: string | null, hdr: RawBlock | null, gone: string) {
    const groups: Group[] = [];
    const status = md.type === "reorg" ? pill("Forked, not canonical", "info") : md.type === "uncle" ? pill("Uncle", "info")
      : html`<span>Confirmed</span> <span class="faint">·</span> <span class="num-mono" data-s="conf">—</span>`;
    groups.push({ title: "Block", rows: [
      { label: "Height", value: html`<span class="num-mono">${int(md.n)}</span>${copyBtn(String(md.n), "Copy block number")}` },
      { label: "Status", value: html`${status}${md.type !== "block" ? html` <a class="link-inline" href="/block/${md.n}">Canonical block ${int(md.n)} →</a>` : ""}` },
      { label: "Timestamp", value: when(md.ts) },
      { label: "Transactions", value: md.txs === null ? dash(NOT_INDEXED) : md.txs ? html`<a class="link-inline" href="?tab=txs" data-go-tab="txs">${int(md.txs)} transaction${md.txs === 1 ? "" : "s"}</a>` : html`<span class="faint">No transactions</span>` },
    ] });

    if (md.era === "authority") {
      const turn = md.difficulty === null ? null : inTurn(md.difficulty);
      const sg: Row[] = [
        { label: "Confirmed by", value: signer ? html`${seal({ height: md.n, signer, difficulty: md.difficulty, link: true })} ${addrChip(signerAddr(signer), { label: false, full: true })} ${prov(signerProv)}` : dash(gone) },
        { label: "Turn", hint: TURN_HINT, value: turn === null ? dash() : html`${turn ? "In turn" : "Out of turn"} <span class="faint">(difficulty ${md.difficulty})</span>` },
        { label: "Vanity", value: extra ? (vanityOf(extra) ? html`<span class="num-mono">${vanityOf(extra)}</span>` : dash("The vanity isn't printable text")) : dash(gone) },
      ];
      if (extra && extra.length >= 2 + 130) {
        const sig = sealOf(extra);
        sg.push({ label: "Seal", hint: "The signer's 65-byte signature over the block header, at the end of extraData. Anyone can recover the signer from it.", value: html`<details class="sig-d"><summary>${short(sig, 10)} <span class="faint">65 bytes</span></summary><pre>${sig}</pre></details>${copyBtn(sig, "Copy seal")}` });
        const list = checkpointSigners(extra);
        // the index and the header carry lower-case hex here: show the checksummed form every other page uses
        if (list.length) sg.push({ label: "Signer list", hint: "Epoch checkpoints (every 30,000 blocks from 180,000) carry the full authorised signer set.", value: html`<div class="sig-list">${list.map((a) => addrChip(checksum(a)))}</div>` });
      } else if (!extra) sg.push({ label: "Seal", value: dash(gone) });
      groups.push({ title: "Signer", rows: sg });
      groups.push({ title: "Reward", rows: rewardRows(md) });
    } else {
      groups.push({ title: "Producer", rows: [
        { label: "Producer", value: md.producer ? addrChip(md.producer, { full: true }) : dash("Not reported by the index") },
        { label: "Difficulty", value: md.difficulty === null ? dash() : html`<span class="num-mono">${int(md.difficulty)}</span>` },
        { label: "Uncles", value: md.uncles.length ? html`<div class="sig-list">${md.uncles.map((u) => blockHashChip(u, { copy: true }))}</div>` : html`<span class="faint">None</span>` },
      ] });
      const own = md.rewards.find((r) => r.type === "producer");
      groups.push({ title: "Reward", rows: [{ label: "Block reward", value: md.type !== "block" ? noReward(md) : own ? amtExact(own.reward) : dash(md.fromIndex ? "Not reported by the index" : NOT_INDEXED) }] });
    }

    const bf = big(md.baseFee);
    groups.push({ title: "Gas", rows: [
      { label: "Gas used", value: md.gasUsed === null ? dash() : gasUsed(md.gasUsed, md.gasLimit) },
      { label: "Base fee", value: bf === null ? dash() : html`<span class="num-mono">${gasPriceExact(bf)}</span>${bf >= 1_000_000n ? html` <span class="faint">(${weiInt(bf)})</span>` : ""}` },
      { label: "Burnt fees", value: md.fromIndex ? burntExact(md.burnt) : dash(NOT_INDEXED) },
    ] });

    const more: Row[] = [
      { label: "Hash", value: fullHash(md.hash, "Copy block hash") },
      { label: "Parent hash", value: md.parent ? html`<a class="hc-full" style="${halfWidth(md.parent)}" href="/block/${md.parent}">${md.parent}</a>${copyBtn(md.parent, "Copy parent hash")}` : dash() },
      { label: "State root", value: hdr?.stateRoot ? fullHash(hdr.stateRoot, "Copy state root") : dash(gone) },
      { label: "Size", value: md.size === null ? dash() : html`<span class="num-mono">${int(md.size)}</span><span class="unit">bytes</span>` },
      { label: "Gas limit", value: md.gasLimit === null ? dash() : html`<span class="num-mono">${int(md.gasLimit)}</span>` },
      { label: "Nonce", value: md.nonce ? html`<span class="num-mono">${md.nonce}</span>` : dash() },
      { label: "Total difficulty", value: md.totalDifficulty ? html`<span class="num-mono">${int(md.totalDifficulty)}</span>` : dash() },
    ];
    mount(panel, html`${md.era === "pow" ? html`<div class="blk-note">${note(html`Before block 160,000 Ferminux ran proof-of-work. Blocks from 160,000 on are confirmed by authorised signers. <a href="https://ferminux.net/consensus.html" rel="noopener">How consensus works ↗</a>`)}</div>` : ""}${kv(groups, { page: "block", rows: more })}`);
    const c = panel.querySelector<HTMLElement>('[data-s="conf"]'), hN = currentHead()?.n;
    if (c && hN !== undefined) { const x = hN - md.n + 1; liveText(c, x >= 1 ? `${int(x)} confirmation${x === 1 ? "" : "s"}` : "—"); }
  }

  /** A forked or uncle block is not canonical: it earned nothing, whatever the schedule says. */
  function noReward(md: M): Html {
    return html`<span class="faint">None: ${md.type === "uncle" ? "an uncle block" : "a forked block"} is not canonical and earns no reward</span>`;
  }

  /** Signer share · reward sink · treasury (§6.2): the index's rows when it has them, else the schedule (tagged). */
  function rewardRows(md: M): Row[] {
    if (md.type !== "block") return [{ label: "Reward", value: noReward(md) }];
    const tips = big(md.tips);
    const find = (t: string) => md.rewards.find((r) => r.type === t);
    const sgn = find("signer"), sink = find("sink"), tre = find("treasury");
    const sum = (base: bigint, tip: bigint | null) => tip && tip > 0n
      ? html`<span class="rw-sum">${amtExact(base)} <span class="op">+ tips</span> ${amtExact(tip)} <span class="op">=</span> ${amtExact(base + tip)}</span>`
      : amtExact(base);
    if (sgn) {
      const total = big(sgn.reward) ?? 0n;
      const base = tips !== null && tips <= total ? total - tips : total;
      return [
        { label: "Signer share", value: sum(base, tips !== null && tips <= total ? tips : null) },
        { label: "Reward sink", value: sink ? html`${amtExact(sink.reward)} <span class="op faint">→</span> ${addrChip(REWARD_SINK)}` : dash("Not reported by the index") },
        { label: "Treasury", value: tre ? html`${amtExact(tre.reward)} <span class="op faint">→</span> ${addrChip(TREASURY)}` : dash("Not reported by the index") },
      ];
    }
    const s = scheduleReward(md.n);
    if (!s) return [{ label: "Reward", value: dash() }];
    const tipNote = tips === null ? html` <span class="faint">+ tips (${md.txs ? "not read yet" : "none"})</span>` : "";
    return [
      { label: "Signer share", value: html`${sum(s.signer, tips)}${md.txs ? tipNote : ""} ${prov("schedule")}` },
      { label: "Reward sink", value: html`${amtExact(s.sink)} <span class="op faint">→</span> ${addrChip(REWARD_SINK)} ${prov("schedule")}` },
      { label: "Treasury", value: html`${amtExact(s.treasury)} <span class="op faint">→</span> ${addrChip(TREASURY)} ${prov("schedule")}` },
    ];
  }

  async function txsPanel(panel: HTMLElement, md: M, deep: boolean) {
    const c = deep ? cur : { page: 1, params: null, expired: false };
    const cols = txCols({ block: false });
    mount(panel, tableSkeleton({ caption: "Transactions in this block", captionHidden: true, cols }, Math.max(1, Math.min(10, md.txs ?? 10))));
    try {
      const key = md.type === "block" ? md.n : md.hash;
      const pg = await api.blockTxs(key, c.params, { signal });
      if (signal.aborted) return;
      if (!pg.items.length) { mount(panel, empty(md.txs ? "The explorer's index hasn't listed this block's transactions yet." : "No transactions in this block.")); return; }
      mount(panel, html`${table({ caption: `Transactions in block ${int(md.n)}`, captionHidden: true, cols, rows: pg.items, sticky: pg.items.length > 15, dense: pg.items.length <= INLINE_TXS })}${pg.next_page_params || c.page > 1 ? pagerHtml({ page: c.page, next: pg.next_page_params, total: md.txs, expired: c.expired }) : ""}`);
      bindPager(panel, { page: c.page, next: pg.next_page_params, current: c.params });
      void hydrateMethods(panel, signal);
    } catch (e) {
      if (isAbort(e) || signal.aborted) return;
      showError(panel, e, () => void txsPanel(panel, md, deep));
    }
  }

  /* ---------------------------------------------------------------- the rail */

  function paintSide(md: M, signer: string | null | undefined, hdr: RawBlock | null) {
    const cards: Html[] = [];
    if (md.era === "authority") {
      const turn = md.difficulty === null ? null : inTurn(md.difficulty);
      const k = signerNo(signer);
      cards.push(signer
        ? html`<section class="panel side-card" aria-labelledby="blk-sg-h">
  <div class="panel-head"><h2 id="blk-sg-h">Confirmed by</h2><a href="/address/${signerAddr(signer)}?tab=blocks_validated">Blocks →</a></div>
  <div class="side-body blk-sgc">
    <p class="sgc-top"><span class="seal seal-lg ${k === null ? "unk" : turn ? "in" : "out"}" aria-hidden="true">${k ?? "?"}</span><span><a class="sgc-nm" href="/address/${signerAddr(signer)}">${k ? `Signer ${k}` : "Unknown signer"}</a><span class="sgc-sub">${turn === null ? "" : turn ? "in turn" : "out of turn"}${hdr && vanityOf(hdr.extraData) ? html` · <span class="mono">${vanityOf(hdr.extraData)}</span>` : ""}</span></span></p>
    <p>${addrChip(signerAddr(signer), { label: false, n: 6 })}</p>
  </div>
</section>`
        : html``);
    } else if (md.producer) {
      cards.push(html`<section class="panel side-card" aria-labelledby="blk-sg-h">
  <div class="panel-head"><h2 id="blk-sg-h">Produced by</h2></div>
  <div class="side-body"><p>${addrChip(md.producer, { n: 6 })}</p><p class="faint small">Before block 160,000, in the proof-of-work era</p></div>
</section>`);
    }
    if (md.type !== "block") cards.push(html`<section class="panel side-card" aria-labelledby="blk-can-h"><div class="panel-head"><h2 id="blk-can-h">Canonical block</h2></div><div class="side-body" data-slot="canon"><p><a class="num-mono blk-big" href="/block/${md.n}">${int(md.n)}</a></p><p class="faint small" data-slot="canon-sg">${sk("60%")}</p></div></section>`);
    cards.push(html`<section class="panel side-card" aria-labelledby="blk-nb-h"><div class="panel-head"><h2 id="blk-nb-h">Around this block</h2><a href="/blocks">All →</a></div><ol class="blk-nb" data-slot="nb">${[-2, -1, 0, 1, 2].map(() => html`<li>${sk("70%")}</li>`)}</ol></section>`);
    if (md.txs !== null && md.txs > INLINE_TXS) cards.push(html`<section class="panel side-card" aria-labelledby="blk-mt-h"><div class="panel-head"><h2 id="blk-mt-h">Transactions</h2><a href="?tab=txs" data-go-tab="txs">All ${int(md.txs)} →</a></div><ol class="blk-mt" data-slot="mt">${Array.from({ length: 6 }, () => html`<li>${sk("80%")}</li>`)}</ol></section>`);
    mount(side, html`${cards}`);

    // the canonical block's signer, for a forked block (the chain's word for that height)
    if (md.type !== "block") {
      const host = slot(side, "canon-sg");
      if (md.era === "authority") {
        signersFor([md.n], signal).then((m) => {
          const a = m.get(md.n);
          if (host) mount(host, a ? html`Confirmed by ${seal({ height: md.n, signer: a, link: true })} ${prov("chain")}` : dash(RPC_DOWN));
        }, (e) => { if (!isAbort(e) && host) mount(host, dash(RPC_DOWN)); });
      } else if (host) mount(host, "The block the chain kept at this height");
    }
    void neighbours(md);
    if (md.txs !== null && md.txs > INLINE_TXS) void miniTxs(md);
  }

  /** Two blocks either side (the signer rotation around this one), from the chain in one batch. Live at the head. */
  async function neighbours(md: M) {
    const host = slot(side, "nb");
    if (!host) return;
    const paint = async () => {
      const hN = currentHead()?.n ?? null;
      const ns = [md.n - 2, md.n - 1, md.n, md.n + 1, md.n + 2].filter((n) => n >= 0);
      const have = ns.filter((n) => hN === null || n <= hN);
      const [hs, sg] = await Promise.all([
        Promise.all(have.map((n) => rpc.block(n, signal).catch(() => null))),
        signersFor(have.filter((n) => n >= POSA_BLOCK), signal).catch((e) => { if (isAbort(e)) throw e; return new Map<number, string | null>(); }),
      ]);
      if (signal.aborted) return;
      const byN = new Map(have.map((n, i) => [n, hs[i]]));
      mount(host, html`${ns.map((n) => {
        const b = byN.get(n);
        const here = n === md.n && md.type === "block";
        if (hN !== null && n > hN) return html`<li class="nb-next"><span class="num-mono faint">${int(n)}</span><span class="faint">not confirmed yet</span></li>`;
        const ts = b ? Number(BigInt(b.timestamp)) : null;
        const d = b ? Number(BigInt(b.difficulty)) : null;
        return html`<li${here ? html` class="nb-here" aria-current="true"` : ""}>${here ? html`<span class="num-mono">${int(n)}</span>` : html`<a class="num-mono" href="/block/${n}">${int(n)}</a>`}${n >= POSA_BLOCK ? seal({ height: n, signer: sg.get(n), difficulty: d }) : b && lc(b.miner) !== ZERO ? html`<span class="hb-hash faint" title="Produced by ${b.miner}">${short(b.miner, 4)}</span>` : dash()}<span class="nb-age">${ts ? ago(ts) : dash(RPC_DOWN)}</span></li>`;
      })}`);
      return hN !== null && md.n + 2 > hN;
    };
    try {
      const waiting = await paint();
      if (waiting && md.type === "block") {
        // the next blocks land every 7 s: repaint as the head passes them
        const off = onHead((h) => { if (h.n >= md.n + 1) void paint().then((w) => { if (!w) off(); }).catch(() => {}); }, signal);
      }
    } catch (e) { if (!isAbort(e)) mount(host, html`<li>${dash(RPC_DOWN)}</li>`); }
  }

  /** A busy block: its first six transactions in the rail (the same index page the tab reads, so one request). */
  async function miniTxs(md: M) {
    const host = slot(side, "mt");
    if (!host) return;
    try {
      const pg = await api.blockTxs(md.type === "block" ? md.n : md.hash, null, { signal });
      if (signal.aborted) return;
      mount(host, html`${pg.items.slice(0, 6).map((t) => html`<li>${txChip(t.hash)}${kindMethod(t)}<span class="r">${amt(t.value)}<span class="unit">FMX</span></span></li>`)}`);
      void hydrateMethods(host, signal);
    } catch (e) { if (!isAbort(e)) mount(host, html`<li>${dash("The explorer's index didn't answer")}</li>`); }
  }
}
