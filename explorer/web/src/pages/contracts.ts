/* Contracts `/verified-contracts` (§5.12). The route name is kept for inbound links; the page is Contracts.
   - Identity line from the index's /smart-contracts/counters: "27 contracts on chain · 0 verified on this explorer".
   - The contract book (src/data/contracts.3961.json) grouped by section, painted at once from the book. Two
     columns fill lazily as rows near the viewport:
       Source   one eth_getCode per row (rows that arrive together go out as ONE RPC batch): no code → "No code";
                code + listed by the index's /smart-contracts → VERIFIED; else NOT VERIFIED + the bytecode size.
                (MATCHES BUILD needs the per-contract build files from scripts/contract-book.mjs, not built yet.)
       Deployed the index's creation_transaction_hash → that transaction's block (≤ 6 index requests at a time); a contract a factory created has
                no creation tx in the index, so the book's deployBlock (the start of its deploy batch) shows as "from N".
   - "Verified by their authors": the index's /smart-contracts list (empty today → "None yet.").
   Treasury and Reward sink are accounts, not contracts: they are on Accounts, not here. */
import "./misc/pages.css";
import { html, mount, dash, type Html } from "../ui/html";
import { sk } from "../ui/skeleton";
import { prov, kindTag, ago } from "../ui/marks";
import { addrChip, blockLink } from "../ui/hash";
import { table, rowLink, sub, type Col } from "../ui/table";
import { note, empty, showError } from "../ui/state";
import { shell } from "./_shell";
import { setMeta, type Params } from "../router";
import { api } from "../api";
import { rpc, RPC_DOWN } from "../rpc";
import { CONTRACTS, SECTIONS, type KnownContract } from "../known";
import { int, byteLen } from "../format";
import { isAbort, lc } from "../util";
import type { AddressParam, Paged } from "../types";
import { put, whenVisible, limit } from "../ui/kit";
import { matchesBuild } from "./address/abi";

const KIND: Record<KnownContract["kind"], string> = { contract: "Contract", token: "Token", impl: "Proxy impl" };
const hrefOf = (c: KnownContract) => (c.kind === "token" ? `/token/${c.address}` : `/address/${c.address}`);

/** A verified contract as the index lists it (only the fields we show). */
interface VerifiedItem { address?: AddressParam; compiler_version?: string | null; language?: string | null; verified_at?: string | null }

const COLS: Col<KnownContract>[] = [
  { label: "Name", cell: (c) => rowLink(hrefOf(c), html`<span class="cb-name">${c.long ?? c.name}</span>`, `${c.long ?? c.name}, ${c.address}`), w: "31%" },
  { label: "Address", cell: (c) => addrChip(c.address, { label: false }), line: 2, w: "19%" },
  { label: "Kind", cell: (c) => kindTag(KIND[c.kind]), end: true, w: "13%" },
  { label: "Source", cell: (c) => html`<span data-k="src-${lc(c.address)}">${sk("96px")}</span>`, line: 3, w: "22%" },
  { label: "Deployed", cell: (c) => html`<span data-k="dep-${lc(c.address)}">${sk("64px")}</span>`, align: "r", line: 3, end: true, w: "15%" },
];

export function render(_p: Params, _q: URLSearchParams, signal: AbortSignal, root: HTMLElement) {
  setMeta({ title: "Contracts", description: "Contracts on Ferminux Network (chain 3961): the agent network, tokens and DEX, chain and treasury." });
  const sections = Object.entries(SECTIONS).map(([key, title]) => ({ key, title, rows: CONTRACTS.filter((c) => c.section === key) })).filter((s) => s.rows.length);
  shell(root, {
    h1: "Contracts",
    ident: html`<span data-k="ident"><span class="skel">${sk("300px")}</span></span>`,
    body: [
      note(html`Ferminux publishes the source of its own contracts. Where the deployed bytecode matches the repository build, the Contract tab shows the source. <a href="/contract-verification">See how to verify yours →</a>`),
      sections.map((s) => html`<section class="cb-sec" aria-labelledby="cb-${s.key}">
        <div class="xp-head"><h2 class="h2" id="cb-${s.key}">${s.title}</h2><span class="xp-aside">${s.rows.length} ${s.rows.length === 1 ? "contract" : "contracts"}</span></div>
        ${table({ caption: `${s.title}: contracts published by Ferminux`, captionHidden: true, cols: COLS, rows: s.rows, rowAttrs: (c) => html`data-row="${lc(c.address)}"` })}
      </section>`),
      html`<section class="cb-sec" aria-labelledby="cb-authors"><div class="xp-head"><h2 class="h2" id="cb-authors">Verified by their authors</h2></div><div data-k="authors"><div class="skel">${sk("100%", "48px")}</div></div></section>`,
    ],
  });

  /* identity line + the index's verified list (one request each) */
  let verified: Set<string> | null = null;
  const waiting: (() => void)[] = [];
  const verifiedReady = () => (verified ? Promise.resolve() : new Promise<void>((r) => waiting.push(r)));

  api.smartContractsCounters({ signal }).then((c) => {
    if (signal.aborted) return;
    const total = Number(c.smart_contracts), ver = Number(c.verified_smart_contracts);
    put(root, "ident", html`<span><span class="num-mono">${int(total)}</span> contracts on chain · <span class="num-mono">${int(ver)}</span> verified on this explorer</span>`);
  }, (e) => { if (!isAbort(e)) put(root, "ident", html`<span>${dash("The explorer's index didn't answer")} contracts on chain</span>`); });

  const loadAuthors = () => {
    const host = root.querySelector<HTMLElement>('[data-k="authors"]');
    api.smartContracts(null, { signal }).then((p) => {
      if (signal.aborted) return;
      const items = (p as Paged<VerifiedItem>).items.filter((i) => i.address?.hash);
      verified = new Set(items.map((i) => lc(i.address!.hash)));
      waiting.splice(0).forEach((f) => f());
      if (!host) return;
      mount(host, items.length ? table<VerifiedItem>({
        caption: "Contracts verified on this explorer by their authors", captionHidden: true, rows: items,
        cols: [
          { label: "Contract", cell: (i) => rowLink(`/address/${i.address!.hash}`, i.address!.name ?? i.address!.hash) },
          { label: "Address", cell: (i) => addrChip(i.address!, { label: false }), line: 2 },
          { label: "Compiler", cell: (i) => (i.compiler_version ? html`<span class="mono">${i.compiler_version}</span>` : dash()), line: 3 },
          { label: "Verified", cell: (i) => (i.verified_at ? ago(i.verified_at) : dash()), align: "r", end: true },
        ],
      }) : empty("None yet."));
    }, (e) => {
      if (isAbort(e)) return;
      verified = new Set(); // unknown: rows fall back to "not verified" only where the index says is_verified false
      waiting.splice(0).forEach((f) => f());
      showError(host, e, loadAuthors);
    });
  };
  loadAuthors();

  /* lazy per-row reads as rows near the viewport */
  const byAddr = new Map(CONTRACTS.map((c) => [lc(c.address), c]));
  const idx = limit(6);
  const rows = Array.from(root.querySelectorAll<HTMLElement>("tr[data-row]"));

  const source = (a: string, code: string | null, matches: boolean | null): Html => {
    if (code === null) return dash(RPC_DOWN);
    const bytes = byteLen(code);
    if (!bytes) return html`<span class="cb-none" title="eth_getCode returns no bytecode at this address">No code</span>`;
    const size = html`<span class="faint" title="Deployed bytecode size">${int(bytes)} B</span>`;
    return html`<span class="cb-src">${verified?.has(a) ? prov("verified") : matches ? prov("matches") : prov("unverified")}${size}</span>`;
  };

  const deployed = async (a: string) => {
    try {
      const ad = await idx(() => api.address(a, { signal }));
      if (signal.aborted) return;
      const h = ad.creation_transaction_hash;
      if (!h) {
        // created inside another transaction (a factory): the index keeps no creation tx. The book's deployBlock is
        // the start block of that contract's deploy batch (agents/deployments*.3961.json), so it reads "from N".
        const b = byAddr.get(a)?.deployBlock;
        put(root, `dep-${a}`, b ? html`<span title="Created inside another transaction, so the explorer's index has no creation transaction for it. Its deploy batch started at block ${int(b)} (Ferminux deployment record).">from ${blockLink(b)}${sub("deploy batch")}</span>`
          : dash("Created inside another transaction: the explorer's index has no creation transaction for this contract"));
        return;
      }
      const tx = await idx(() => api.tx(h, { signal }));
      if (signal.aborted) return;
      put(root, `dep-${a}`, html`${blockLink(tx.block_number)}${sub(tx.timestamp ? ago(tx.timestamp) : "")}`);
    } catch (e) {
      if (!isAbort(e)) put(root, `dep-${a}`, dash("The explorer's index didn't answer"));
    }
  };

  whenVisible(rows, (batch) => {
    const addrs = batch.map((r) => (r as HTMLElement).dataset.row!).filter((a) => byAddr.has(a));
    // one RPC batch: every eth_getCode made in this tick goes out together (rpc.ts)
    const codes = addrs.map((a) => rpc.code(a, signal).then((c) => c, (e) => { if (isAbort(e)) throw e; return null; }));
    addrs.forEach((a, i) => {
      Promise.all([codes[i], verifiedReady()])
        .then(async ([code]) => [code, await matchesBuild(a, code).catch(() => null)] as const)
        .then(([code, m]) => { if (!signal.aborted) put(root, `src-${a}`, source(a, code, m)); }, () => { /* aborted */ });
      void deployed(a);
    });
  }, signal);
}
