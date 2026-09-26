/* Transaction `/tx/:hash` (§5.5). This module stays light (the address page imports TX_NOTES from it): it
   validates the hash, paints the shell with skeletons in every slot, starts the index read, and hands over to
   ./tx/page (overview, tabs, signer, live confirmations) which loads in parallel with that read. The decode
   chunk (./tx/story + ./tx/decode: sentence, decoded input and events, job rail) loads after first paint.
   Layout: main column (story card + job rail, overview) and a sticky side column (agents, block) on desktop;
   one column on phones: story, overview, side cards, tabs. */
import { html } from "../ui/html";
import { kvSkeleton, sk, skLine } from "../ui/skeleton";
import { note, showError } from "../ui/state";
import { copyBtn } from "../ui/copy";
import { halfWidth } from "../ui/hash";
import { short } from "../format";
import { api } from "../api";
import { shell } from "./_shell";
import { notFound } from "./notFound";
import { resolveTab, setMeta, type Params } from "../router";

export const TX_NOTES: Record<string, string> = {
  internal: "Internal transactions are not indexed on this network. Value moved by contracts appears as events: see Events.",
  raw_trace: "Raw traces are not available: the public node keeps no trace data.",
};

export function render(p: Params, query: URLSearchParams, signal: AbortSignal, root: HTMLElement) {
  const h = p.hash;
  if (!/^0x[0-9a-f]{64}$/i.test(h)) {
    const hexLen = h.replace(/^0x/i, "").length;
    notFound(root, { h1: `${short(h, 6)} isn't a transaction hash`, body: `A transaction hash is 0x followed by 64 hexadecimal characters. This one has ${hexLen}.`, query: h });
    return;
  }
  start(h, query, signal, root);
}

/** One run of the page. `restart` (pending → confirmed, not found → found) aborts this run and paints afresh. */
function start(h: string, query: URLSearchParams, page: AbortSignal, root: HTMLElement) {
  const ctl = new AbortController();
  const off = () => ctl.abort();
  page.addEventListener("abort", off, { once: true });
  const signal = ctl.signal;
  const restart = () => { page.removeEventListener("abort", off); ctl.abort(); if (!page.aborted) start(h, query, page, root); };

  const { note: gap } = resolveTab("tx", query);
  setMeta({ title: `Transaction ${short(h, 4)}`, description: `Transaction ${h} on Ferminux Network (chain 3961): status, value, fee and events.` });
  const gapNote = gap === "internal"
    ? note(html`Internal transactions are not indexed on this network. Value moved by contracts appears as events: <a href="/tx/${h}?tab=logs" data-tab-link="logs">see Events →</a>`)
    : gap ? note(TX_NOTES[gap]) : "";
  shell(root, {
    crumbs: [{ href: "/txs", label: "Transactions" }, { label: short(h, 4) }],
    h1: "Transaction",
    ident: html`<span class="hc-full" style="${halfWidth(h)}">${h}</span>${copyBtn(h, `Copy transaction hash ${short(h, 4)}`)}`,
    headExtra: html`<div data-slot="pills"><div class="tx-pills skel">${sk("72px", "22px")}${sk("96px")}${sk("80px")}</div></div>`,
    body: html`${gapNote}<div class="txg">
      <div class="txg-top">
        <div data-slot="story"><div class="story skel" aria-busy="true">${skLine("72%")}</div></div>
        <div data-slot="ov">${kvSkeleton(["Status", "Block", "Confirmed", "Signer", "From", "To", "Value", "Transaction fee", "Gas price", "Gas used"])}</div>
      </div>
      <aside class="txg-side" aria-label="Block and agents"><div data-slot="side"><div class="panel skel" aria-busy="true"><div class="side-body">${skLine("40%")}${skLine("60%")}${skLine("50%")}</div></div></div></aside>
      <div class="txg-tabs" data-slot="tabs"><div class="xtabs skel" aria-hidden="true">${sk("320px")}</div></div>
    </div>`,
  });
  // the index read and the page module load together
  const txP = api.tx(h, { signal });
  txP.catch(() => { /* handled in the page module */ });
  import("./tx/page")
    .then((m) => { if (!signal.aborted) return m.run({ h, query, signal, root, txP, restart }); })
    .catch((e) => { if (!signal.aborted) showError(root.querySelector<HTMLElement>('[data-slot="ov"]'), e, restart); });
}
