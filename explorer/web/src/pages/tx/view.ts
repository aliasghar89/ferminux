/* Renderers for the transaction page (surfaces/explorer.md §5.5): the pill row, the overview detail list, the
   side column (agents, block), the token-transfer lines and tables, balance changes, the raw input block and the
   raw event cards. Pure functions of the data: the page re-renders them when the name book or the head changes. */
import { html, type Html, type Val, dash } from "../../ui/html";
import { addrChip, blockLink } from "../../ui/hash";
import { txPill, kindWord, txKind, methodChip, prov, amtExact, gasUsed, when, kindTag, pill } from "../../ui/marks";
import { isLoadTestTx, ltChip, LT_MANIFEST } from "../../loadtest";
import { seal } from "../../ui/seal";
import { kv, type Row } from "../../ui/kv";
import { copyBtn } from "../../ui/copy";
import { icon } from "../../ui/icons";
import { table, type Col } from "../../ui/table";
import { empty } from "../../ui/state";
import { POSA_BLOCK, knownContract } from "../../known";
import { agentById } from "../../book";
import { signerAddr } from "../../signer";
import { agentLinks } from "../../gateway";
import { int, units, gasPriceExact, weiInt, big, short, byteLen, amountCell } from "../../format";
import { utf8 } from "../../enrich/abidec";
import { lc, ZERO } from "../../util";
import type { Tx, TokenTransfer, StateChange, Log } from "../../types";

/* ---------------------------------------------------------------- head */

/** Status pill · kind · method chip (the decoded name replaces the selector once the chunk has run). */
export function pills(tx: Tx, decodedName?: string | null): Html {
  if (isLoadTestTx(tx)) return html`<div class="tx-pills">${txPill(tx.status)}${ltChip(true)}${kindWord("FMX transfer")}</div>`;
  const m = decodedName ? html`<span class="mchip" title="${decodedName}">${decodedName}</span>` : methodChip(tx.method, tx.raw_input);
  return html`<div class="tx-pills">${txPill(tx.status)}${m}${kindWord(txKind(tx))}</div>`;
}

/* ---------------------------------------------------------------- figures */

const conf = (n: number) => html`<span class="num-mono" data-conf>${int(n)}</span> <span data-conf-w>${n === 1 ? "confirmation" : "confirmations"}</span>`;
export const confirmationsOf = (tx: Tx, head: number | null) =>
  tx.block_number === null ? 0 : head !== null && head >= tx.block_number ? head - tx.block_number + 1 : tx.confirmations;

/** "~7 s" from confirmation_duration [min_ms, max_ms]. The index fills it from its average block time, not from
 *  this transaction (it never saw when the transaction was sent), so it is shown as an estimate, and only for
 *  blocks confirmed by signers: before 160,000 blocks did not come every 7 s. */
function confirmedIn(tx: Tx): string | null {
  if (tx.block_number === null || tx.block_number < POSA_BLOCK) return null;
  const d = tx.confirmation_duration;
  const max = Array.isArray(d) && d.length > 1 ? Number(d[1]) : NaN;
  return Number.isFinite(max) && max > 0 ? `~${Math.max(1, Math.round(max / 1000))} s` : null;
}
const TYPE: Record<number, string> = { 0: "0 (legacy)", 1: "1 (access list)", 2: "2 (dynamic fee)", 3: "3 (blob)" };

/** A burnt fee under 0.000001 FMX reads in wei (§5.3): "1,220,674 wei". */
function burnt(v: string | null): Html {
  const x = big(v);
  if (x === null) return dash();
  return x < 10n ** 12n ? html`<span class="num-mono">${weiInt(x)}</span>` : amtExact(x);
}
/** The effective tip (gas price − base fee), or null. */
function tipOf(tx: Tx): bigint | null {
  const g = big(tx.gas_price), b = big(tx.base_fee_per_gas);
  return g !== null && b !== null && g >= b ? g - b : null;
}

/** Why it failed: the decoded revert, else the index's result when it is a reason, else an honest gap. */
function revertLine(tx: Tx, decoded?: string | null): Html {
  if (decoded) return html`<span class="mono">${decoded}</span>`;
  const r = (tx.result ?? "").trim();
  if (r && !/^(awaiting_internal_transactions|error|pending|success)$/i.test(r)) return html`<span class="mono">${r}</span>`;
  return html`Reverted. The reason isn't recorded: the public node keeps no traces.`;
}

/* ---------------------------------------------------------------- the overview (§5.5 table) */

export interface OverviewOpts {
  head: number | null;
  /** Lower-case signer; undefined = not read (RPC down); null = proof-of-work era. */
  signer: string | null | undefined;
  difficulty?: string | number | null;
  revertText?: string | null;
  /** The decoded-input slot content (the lazy chunk fills it). */
  inputDecoded?: Val;
}

export function overview(tx: Tx, o: OverviewOpts): Html {
  const n = tx.block_number;
  const pow = n !== null && n < POSA_BLOCK;
  const tts = tx.token_transfers ?? [];
  const tip = tipOf(tx);
  const fin = confirmedIn(tx);

  const status: Row[] = [
    { label: "Status", value: html`${txPill(tx.status)}${tx.status === "error" ? html`<span class="revert">${revertLine(tx, o.revertText)}</span>` : ""}` },
    { label: "Block", value: n === null ? dash("Not in a block yet") : html`${blockLink(n)} <span class="faint">·</span> ${conf(confirmationsOf(tx, o.head))}` },
    { label: "Confirmed", value: html`${when(tx.timestamp)}${fin ? html` <span class="faint">· typically confirmed in <span class="est" title="An estimate: the index's average block time, not a measurement of this transaction">${fin}</span></span>` : ""}` },
    pow
      ? { label: "Produced", value: html`${seal({ height: n!, signer: null })} <span class="faint">before block 160,000, in the proof-of-work era</span>` }
      : { label: "Signer", value: n === null ? dash() : html`${seal({ height: n, signer: o.signer, difficulty: o.difficulty, link: true, addr: true })}${o.signer ? prov("chain") : ""}`, hint: "The signer that confirmed this transaction's block, read from the chain. In turn means the block height was that signer's slot (difficulty 2)." },
  ];
  const created = tx.created_contract;
  const toKind = tx.to && (tx.to.is_contract || knownContract(tx.to.hash)) ? kindTag("Contract") : "";
  const parties: Row[] = [
    { label: "From", value: html`<span class="tx-party">${addrChip(tx.from, { full: true })}</span>` },
    { label: created ? "Created" : "To", value: created ? html`<span class="faint">Contract creation →</span> <span class="tx-party">${addrChip(created, { full: true })}</span>` : tx.to ? html`<span class="tx-party">${addrChip(tx.to, { full: true })}</span>${toKind}` : dash() },
  ];
  const money: Row[] = [
    { label: "Value", value: amtExact(tx.value) },
    ...(tts.length ? [{ label: "Token transfers", value: ttLines(tts, !!tx.token_transfers_overflow, tx.hash) }] : []),
    { label: "Transaction fee", value: html`${amtExact(tx.fee?.value)}${tx.gas_used && tx.gas_price ? html`<span class="line faint num-mono">${int(tx.gas_used)} gas × ${gasPriceExact(tx.gas_price)}</span>` : ""}` },
    { label: pow ? "Paid to producer" : "Paid to signer", value: tx.priority_fee === null ? dash() : html`${amtExact(tx.priority_fee)}${!pow && o.signer ? html` <span class="faint">→</span> ${addrChip(signerAddr(o.signer), { copy: false })}` : ""}`, hint: "The tip above the base fee. It goes to whoever confirmed the block." },
    { label: "Burnt", value: html`${burnt(tx.transaction_burnt_fee)} <span class="faint">base fee</span>`, hint: "The base fee is burned: it leaves circulation rather than paying anyone." },
  ];
  const gasRows: Row[] = [
    { label: "Gas price", value: tx.gas_price === null ? dash() : html`<span class="num-mono">${gasPriceExact(tx.gas_price)}</span>${tx.base_fee_per_gas !== null && tip !== null ? html`<span class="line faint num-mono">base ${gasPriceExact(tx.base_fee_per_gas)} + tip ${gasPriceExact(tip)}</span>` : ""}` },
    { label: "Gas used", value: gasUsed(tx.gas_used, tx.gas_limit) },
  ];
  const more: Row[] = [
    { label: "Type", value: tx.type === null ? dash() : html`<span class="num-mono">${TYPE[tx.type] ?? String(tx.type)}</span>` },
    ...(tx.type === 2 ? [{ label: "Max fee · max tip", value: html`<span class="num-mono">${gasPriceExact(tx.max_fee_per_gas)}</span> <span class="faint">·</span> <span class="num-mono">${gasPriceExact(tx.max_priority_fee_per_gas)}</span>` }] : []),
    { label: "Nonce · position", value: html`<span class="num-mono">${int(tx.nonce)}</span> <span class="faint">·</span> <span class="num-mono">${tx.position === null ? "—" : int(tx.position)}</span> <span class="faint">in the block</span>` },
    { label: "Input", id: "input", value: !tx.raw_input || tx.raw_input === "0x" ? html`<span class="mono faint">0x</span> <span class="faint">no input: a plain FMX transfer</span>` : html`<div class="tx-input">${isLoadTestTx(tx) ? html`<p class="lt-input">The FXLT marker (<span class="mono">0x46584c54</span>, version ${parseInt(tx.raw_input.slice(10, 12) || "0", 16)}): a Wizrd load-test transaction. A transfer to an account with no code ignores its input; the marker only labels it. <a class="link-inline" href="${LT_MANIFEST}" rel="noopener">How the load test works ↗</a></p>` : ""}<div data-slot="input-dec">${o.inputDecoded ?? ""}</div>${rawInput(tx.raw_input)}</div>` },
  ];
  return kv([status, parties, money, gasRows], { page: "tx", rows: more });
}

/* ---------------------------------------------------------------- token transfers */

export const ttKind = (t: TokenTransfer) => (lc(t.from.hash) === ZERO || t.type === "token_minting" ? "Mint" : lc(t.to.hash) === ZERO || t.type === "token_burning" ? "Burn" : "Transfer");
/** "5,000 WFMX" / "#41" / raw units when decimals are unknown. */
export function ttAmount(t: TokenTransfer, exact = false, withToken = false): Html {
  const sym = t.token?.symbol ?? "";
  if (t.total?.token_id !== undefined && t.total?.token_id !== null) return html`<a class="num-mono" href="/token/${t.token.address_hash}/instance/${t.total.token_id}">#${t.total.token_id}</a>${withToken ? html` ${tokenLink(t)}` : ""}`;
  const v = t.total?.value;
  if (v === null || v === undefined) return dash();
  const d = t.total?.decimals ?? t.token?.decimals;
  if (d === null || d === undefined) return html`<span class="num-mono">${int(v)}</span> <span class="tag">raw units</span>`;
  const n = html`<span class="num-mono">${exact ? units(v, Number(d), Number(d)) : amountCell(v, Number(d))}</span>`;
  if (withToken) return html`${n} <a class="tt-tok" href="/token/${t.token.address_hash}" title="${t.token.name ?? sym}">${sym || t.token.name || short(t.token.address_hash, 4)}</a>`;
  return html`${n}${sym ? html`<span class="unit">${sym}</span>` : ""}`;
}
const tokenLink = (t: TokenTransfer) => html`<a class="tt-tok" href="/token/${t.token.address_hash}">${t.token.name ?? t.token.symbol ?? short(t.token.address_hash, 4)}</a>`;

/** Up to 5 lines in the overview + "+ N more →". */
export function ttLines(tts: TokenTransfer[], overflow: boolean, hash: string): Html {
  const shown = tts.slice(0, 5);
  const rest = tts.length - shown.length;
  return html`<ul class="tt-lines">${shown.map((t) => {
    const k = ttKind(t);
    return html`<li>${ttAmount(t, true, true)} ${kindTag(t.token.type)}${k === "Mint" ? html` <span class="kword">Mint</span> <span class="faint">to</span> ${addrChip(t.to, { copy: false })}` : k === "Burn" ? html` <span class="kword">Burn</span> <span class="faint">from</span> ${addrChip(t.from, { copy: false })}` : html` <span class="tt-pp">${addrChip(t.from, { copy: false })}<span class="arrow" aria-label="to">→</span>${addrChip(t.to, { copy: false })}</span>`}</li>`;
  })}${rest > 0 || overflow ? html`<li><a class="link-arrow" href="/tx/${hash}?tab=token_transfers" data-tab-link="token_transfers">+ ${rest > 0 ? int(rest) : "more"}${overflow ? "+" : ""} more →</a></li>` : ""}</ul>`;
}

const TT_COLS: Col<TokenTransfer>[] = [
  { label: "Token", cell: (t) => html`${tokenLink(t)} ${kindTag(t.token.type)}` },
  { label: "From → To", cell: (t) => html`<span class="tt-pp">${addrChip(t.from, { copy: false })}<span class="arrow" aria-label="to">→</span>${addrChip(t.to, { copy: false })}</span>`, line: 2 },
  { label: "Amount", cell: (t) => ttAmount(t, true), align: "r", line: 3 },
  { label: "Kind", cell: (t) => html`<span class="kword">${ttKind(t)}</span>`, line: 1, end: true },
];
export const ttTable = (tts: TokenTransfer[]) => (tts.length ? table({ caption: "Token transfers in this transaction", captionHidden: true, cols: TT_COLS, rows: tts, dense: true }) : empty("No token transfers in this transaction."));

/* ---------------------------------------------------------------- balance changes (?tab=state) */

/** The index records the signer's fee as a change from 0: its before and after are not balances (a signer
 *  holds thousands of FMX). Only the Change column is real for that row. */
const SIGNER_BAL = "The explorer's index doesn't record the signer's balance around a transaction; only the fee it received (Change) is real";
const signerRow = (s: StateChange) => s.isSigner && s.type === "coin" && big(s.balance_before) === 0n;

function scAmount(s: StateChange, v: string | null, signed = false, exact = false): Html {
  if (v === null || v === undefined) return dash();
  const dec = s.type === "coin" ? 18 : s.token?.decimals ? Number(s.token.decimals) : null;
  const unit = s.type === "coin" ? "FMX" : s.token?.symbol ?? "";
  if (dec === null) return html`<span class="num-mono">${int(v)}</span>${unit ? html`<span class="unit">${unit}</span>` : ""}`;
  const x = big(v);
  const txt = exact ? units(v, dec, dec) : amountCell(v, dec);
  return html`<span class="num-mono${signed && x !== null ? (x > 0n ? " tx-pos" : x < 0n ? " tx-neg" : "") : ""}">${signed && x !== null && x > 0n ? "+" : ""}${txt}</span><span class="unit">${unit}</span>`;
}
function scChange(s: StateChange): Html {
  if (Array.isArray(s.change)) {
    const items = s.change as { direction?: string; total?: { token_id?: string } }[];
    return html`${items.map((c) => html`<span class="num-mono ${c.direction === "to" ? "tx-pos" : "tx-neg"}">${c.direction === "to" ? "+" : "−"}#${c.total?.token_id ?? "?"}</span> `)}<span class="unit">${s.token?.symbol ?? ""}</span>`;
  }
  return scAmount(s, s.change as string, true, true);
}
const scCols = (pow: boolean): Col<StateChange>[] => [
  { label: "Address", cell: (s) => html`${addrChip(s.address, { copy: false })}${s.isSigner ? html` ${kindTag(pow ? "Producer" : "Signer")}` : ""}${s.type === "token" && s.token ? html` <span class="faint">${s.token.symbol ?? ""}</span>` : ""}` },
  { label: "Before", cell: (s) => (signerRow(s) ? dash(SIGNER_BAL) : scAmount(s, s.balance_before)), align: "r", line: 3, l: "before" },
  { label: "After", cell: (s) => (signerRow(s) ? dash(SIGNER_BAL) : scAmount(s, s.balance_after)), align: "r", line: 3, l: "after" },
  { label: "Change", cell: (s) => scChange(s), align: "r", line: 1, end: true },
];
export const stateNote = (pow = false) => `This list covers the sender, the recipient, the ${pow ? "producer" : "signer"}'s fee and token balances. For the ${pow ? "producer" : "signer"} only the fee received is shown: the index doesn't record its balance around the transaction. Value paid out by contracts (for example a StreamPay withdrawal) shows in Events, not here.`;
/** `pow`: the block is from the proof-of-work era, so the fee recipient is its producer, not a signer. */
export const stateTable = (items: StateChange[], pow = false) => (items.length ? table({ caption: "Balance changes", captionHidden: true, cols: scCols(pow), rows: items, dense: true }) : empty("The explorer's index reports no balance changes for this transaction."));

/* ---------------------------------------------------------------- raw input (§4.15) */

/** Selector in --code-key, then one 32-byte word per line with its index; Hex / UTF-8 switch. */
export function rawInput(hex: string): Html {
  const h = hex.replace(/^0x/i, "");
  const sel = h.slice(0, 8), body = h.slice(8);
  const words: string[] = [];
  for (let i = 0; i < body.length; i += 64) words.push(body.slice(i, i + 64));
  const text = printable(h);
  const hexView = html`<span class="k">0x${sel}</span>${words.map((w, i) => html`\n<span class="c">[${i}]</span> ${w}`)}`;
  return html`<div class="code-block raw-in" data-raw>
  <div class="code-head"><span>Input data <span class="mono faint">· ${int(byteLen(hex))} bytes</span></span><span class="raw-ctl"><span class="seg" role="group" aria-label="Show input as"><button type="button" aria-pressed="true" data-view="hex">Hex</button><button type="button" aria-pressed="false" data-view="utf8">UTF-8</button></span>${copyBtn(hex, "Copy input data")}</span></div>
  <pre class="raw" data-v="hex">${hexView}</pre>
  <pre class="raw" data-v="utf8" hidden>${text ?? html`<span class="c" title="These bytes are not printable text">—</span>`}</pre>
</div>`;
}
/** The input as UTF-8 text, NULs dropped; null when it isn't printable. */
function printable(h: string): string | null {
  const s = utf8(h.length % 2 ? h.slice(0, -1) : h).replace(/\u0000/g, "");
  if (!s.trim() || /[\u0001-\u0008\u000e-\u001f\u007f�]/.test(s)) return null;
  return s;
}
/** One delegated listener per page for every Hex / UTF-8 switch. */
export function bindRaw(root: HTMLElement) {
  root.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>("[data-raw] [data-view]");
    if (!b) return;
    const box = b.closest<HTMLElement>("[data-raw]")!;
    box.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    box.querySelectorAll<HTMLElement>("pre[data-v]").forEach((p) => { p.hidden = p.dataset.v !== b.dataset.view; });
  });
}

/* ---------------------------------------------------------------- events (raw form; the chunk re-renders decoded) */

export interface EventView { name: string; sig: string; generic: boolean; line: Html | null; args: Html }
export function eventCard(log: Log, dec: EventView | null): Html {
  const topics = log.topics.filter((t): t is string => !!t);
  return html`<article class="tx-ev" id="log-${log.index}">
  <header class="tx-ev-h"><span class="tx-ev-i num-mono">#${log.index}</span>${addrChip(log.address, { copy: false })}${dec ? html`<code class="tx-ev-n" title="${dec.sig}">${dec.name}</code>${dec.generic ? kindTag("Standard") : ""}${prov("abi")}` : html`<span class="faint small">Not decoded</span>`}</header>
  ${dec?.line ? html`<p class="tx-ev-line">${dec.line}</p>` : ""}
  ${dec ? dec.args : html`<dl class="tx-ev-raw">${topics.map((t, i) => html`<div><dt>Topic ${i}</dt><dd class="mono tx-wrap">${t}</dd></div>`)}<div><dt>Data</dt><dd class="mono tx-wrap">${log.data && log.data !== "0x" ? log.data : html`<span class="faint">0x (empty)</span>`}</dd></div></dl>`}
</article>`;
}
export const eventsList = (cards: Html[]) => html`<div class="evs">${cards}</div>`;

/* ---------------------------------------------------------------- side column */

/** The block this tx sits in: seal, signer, height, live confirmations (§5.5 side). */
export function blockPanel(tx: Tx, o: { head: number | null; signer: string | null | undefined; difficulty?: string | number | null }): Html {
  const n = tx.block_number;
  if (n === null) return html``;
  return html`<section class="panel side-card" aria-labelledby="blk-h">
  <div class="panel-head"><h2 id="blk-h">Block</h2><a href="/block/${n}">Open →</a></div>
  <div class="side-body">
    <p class="blk-n"><a class="num-mono" href="/block/${n}">${int(n)}</a></p>
    <p>${n < POSA_BLOCK ? seal({ height: n, signer: null }) : seal({ height: n, signer: o.signer, difficulty: o.difficulty, link: true })}</p>
    <p class="muted">${conf(confirmationsOf(tx, o.head))}</p>
    ${tx.timestamp ? html`<p class="faint small">${when(tx.timestamp)}</p>` : ""}
  </div>
</section>`;
}

/** Compact agent cards (§4.14 compact): name, #id, status, jobs, rating, links. */
export function agentCards(ids: number[]): Html {
  const list = ids.map((id) => agentById(id)).filter((a): a is NonNullable<typeof a> => !!a);
  if (!list.length) return html``;
  return html`<section class="panel side-card" aria-labelledby="tx-ag-h">
  <div class="panel-head"><h2 id="tx-ag-h">${list.length === 1 ? "Agent" : "Agents"} in this transaction</h2></div>
  <ul class="tx-ag-list">${list.map((a) => html`<li class="tx-ag">
    <div class="tx-ag-top">${icon("i-bot", "tx-ag-g", 14)}<a class="tx-ag-n" href="/address/${a.owner}?tab=jobs">${a.name}</a><span class="hc-id">#${a.id}</span><span class="tx-ag-st"><span class="status-dot ${a.status === "Active" ? "ok" : "off"}" aria-hidden="true"></span>${a.status}</span></div>
    <div class="tx-ag-facts"><span><b class="num-mono">${int(a.jobsCompleted)}</b> jobs</span><span>${a.ratingCount ? html`<b class="num-mono">★ ${(a.ratingAvg ?? 0).toFixed(1)}</b> (${a.ratingCount})` : html`<span class="faint">no ratings yet</span>`}</span><span><b class="num-mono">${units(big(a.pricePerJob) ?? 0n, 18, 6)}</b> FMX per job</span></div>
    <div class="tx-ag-links"><a class="link-arrow" href="${agentLinks(a.id).record}" target="_blank" rel="noopener" data-external>Record ${icon("i-ext", "", 14)}</a><a class="link-arrow" href="/address/${a.owner}?tab=jobs">Jobs →</a></div>
  </li>`)}</ul>
</section>`;
}

/* ---------------------------------------------------------------- pending (§5.5 States) */

export interface PendingTx { hash: string; from: string; to: string | null; value: bigint; nonce: number; gas: bigint; input: string; maxFee: bigint | null; tip: bigint | null; gasPrice: bigint | null; blockNumber: number | null }
export function pendingView(p: PendingTx): Html {
  const inBlock = p.blockNumber !== null;
  return html`<div class="pend">
  <p class="pend-line"><span class="status-dot pending" aria-hidden="true"></span>${inBlock
    ? html`<span><b>Confirmed on chain</b> in block ${blockLink(p.blockNumber)}; the explorer's index hasn't caught up yet. This page refreshes when it has.</span>`
    : html`<span><b>Pending:</b> seen by the node, not yet in a block. A signer confirms a block every 7 s; this page updates on its own.</span>`}</p>
  ${kv([[
    { label: "Status", value: inBlock ? pill("Confirmed", "ok") : pill("Pending", "info") },
    { label: "From", value: html`<span class="tx-party">${addrChip(p.from, { full: true })}</span>` },
    { label: "To", value: p.to ? html`<span class="tx-party">${addrChip(p.to, { full: true })}</span>` : html`<span class="faint">Contract creation</span>` },
    { label: "Value", value: amtExact(p.value) },
  ], [
    { label: "Nonce", value: html`<span class="num-mono">${int(p.nonce)}</span>` },
    { label: "Gas limit", value: html`<span class="num-mono">${int(p.gas)}</span>` },
    { label: p.maxFee !== null ? "Max fee · max tip" : "Gas price", value: p.maxFee !== null ? html`<span class="num-mono">${gasPriceExact(p.maxFee)}</span> <span class="faint">·</span> <span class="num-mono">${gasPriceExact(p.tip)}</span>` : html`<span class="num-mono">${gasPriceExact(p.gasPrice)}</span>` },
    { label: "Input", value: p.input && p.input !== "0x" ? html`<div class="tx-input"><div data-slot="pend-dec"></div>${rawInput(p.input)}</div>` : html`<span class="mono faint">0x</span> <span class="faint">no input: a plain FMX transfer</span>` },
  ]])}
  <p class="faint small">${prov("chain")} Read from rpc.ferminux.net. The fee, gas used and events appear once a signer confirms it and the explorer's index records it.</p>
</div>`;
}
