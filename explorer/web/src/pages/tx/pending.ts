/* Pending and not-found transactions (surfaces/explorer.md §5.5 States, §5.15).
   - The index 404s but the node knows the tx: "Pending: seen by the node, not yet in a block", from / to / value
     from the RPC, the pending dot; re-checked on every head, and the full page replaces it once indexed.
   - The node has it in a block but the index hasn't caught up: the same view, worded as confirmed.
   - Neither knows it: the not-found page, checking again every 7 s for 2 minutes, then "Still not found". */
import { html, mount } from "../../ui/html";
import { api } from "../../api";
import { rpc, type RawTx } from "../../rpc";
import { onHead } from "../../head";
import { every } from "../../util";
import { short } from "../../format";
import { setMeta } from "../../router";
import { notFound } from "../notFound";
import { pendingView, type PendingTx } from "./view";
import type { RunOpts } from "./page";
import type { Tx } from "../../types";

const hexN = (h: string | undefined | null) => (h ? BigInt(h) : null);
function fromRaw(r: RawTx): PendingTx {
  return {
    hash: r.hash, from: r.from, to: r.to, value: BigInt(r.value), nonce: Number(BigInt(r.nonce)), gas: BigInt(r.gas), input: r.input,
    maxFee: hexN(r.maxFeePerGas), tip: hexN(r.maxPriorityFeePerGas), gasPrice: hexN(r.gasPrice), blockNumber: r.blockNumber ? Number(BigInt(r.blockNumber)) : null,
  };
}
const slot = (root: ParentNode, id: string) => root.querySelector<HTMLElement>(`[data-slot="${id}"]`);

/** The index doesn't have the tx (404), or rejected the hash (422): ask the node, then decide. */
export async function missing(o: RunOpts, invalid = false) {
  const { h, signal, root } = o;
  const raw = await rpc.tx(h, signal).catch(() => undefined);
  if (signal.aborted) return;
  if (raw) { showPending(o, raw); return; }
  if (invalid) {
    notFound(root, { h1: `${short(h, 6)} isn't a transaction hash`, body: "A transaction hash is 0x followed by 64 hexadecimal characters.", query: h });
    return;
  }
  notFound(root, {
    h1: `No transaction ${short(h, 4)} on chain 3961`,
    body: html`If you sent it just now, it appears once a signer confirms the next block (about 7 s). <span data-nf-status>This page checks again every 7 s for 2 minutes.</span>`,
    query: h,
  });
  // live re-check: every 7 s for 2 minutes, then stop with a plain line
  const stop = new AbortController();
  signal.addEventListener("abort", () => stop.abort(), { once: true });
  const until = Date.now() + 120_000;
  every(7000, async () => {
    if (Date.now() > until) {
      stop.abort();
      const s = root.querySelector("[data-nf-status]");
      if (s) s.textContent = "Still not found. Check the hash and the network (chain 3961).";
      return;
    }
    // ask the node (a 200 with null while it doesn't know the hash), not the index (a 404 each time)
    const found = !!(await rpc.tx(h, stop.signal).catch(() => null));
    if (found && !signal.aborted) { stop.abort(); o.restart(); }
  }, stop.signal);
}

function showPending(o: RunOpts, raw: RawTx) {
  const { h, signal, root } = o;
  const paint = (r: RawTx) => {
    const p = fromRaw(r);
    setMeta({ title: `Transaction ${short(h, 4)}`, description: `Pending transaction ${h} on Ferminux Network (chain 3961).`, noindex: true });
    mount(slot(root, "pills"), html`<div class="tx-pills"><span class="pill info"><span class="status-dot pending" aria-hidden="true"></span>${p.blockNumber === null ? "Pending" : "Awaiting the index"}</span></div>`);
    mount(slot(root, "ov"), pendingView(p));
    for (const id of ["story", "side", "tabs"]) { const s = slot(root, id); if (s) { s.hidden = true; mount(s, ""); } }
    // the call, decoded with the Ferminux ABI (lazy chunk; the raw input stays if it fails)
    if (p.input && p.input !== "0x") {
      import("./story").then(async (st) => {
        await st.ready(signal);
        const d = signal.aborted ? null : st.decodeInput({ to: p.to ? { hash: p.to } as Tx["to"] : null, raw_input: p.input });
        if (d) mount(slot(root, "pend-dec"), st.inputBlock(d));
      }).catch(() => { /* raw input stays */ });
    }
  };
  paint(raw);
  let busy = false, last = JSON.stringify(raw);
  onHead(async () => {
    if (busy || signal.aborted) return;
    busy = true;
    try {
      const r = await rpc.tx(h, signal).catch(() => undefined);
      if (signal.aborted) return;
      if (r && r.blockNumber) {
        const ok = await api.tx(h, { signal, fresh: true }).then(() => true).catch(() => false);
        if (signal.aborted) return;
        if (ok) { o.restart(); return; }
      }
      if (r && JSON.stringify(r) !== last) { last = JSON.stringify(r); paint(r); }
    } finally { busy = false; }
  }, signal);
}

/** The index has the tx but reports it pending (status null): refresh on every head until it's confirmed. */
export function watchIndexPending(o: RunOpts, tx: Tx, update: (t: Tx) => void) {
  const { h, signal } = o;
  let busy = false, last = JSON.stringify([tx.status, tx.block_number]);
  onHead(async () => {
    if (busy || signal.aborted) return;
    busy = true;
    try {
      const t = await api.tx(h, { signal, fresh: true }).catch(() => null);
      if (!t || signal.aborted) return;
      const now = JSON.stringify([t.status, t.block_number]);
      if (now !== last) { last = now; if (t.status !== null && t.block_number !== null) o.restart(); else update(t); }
    } finally { busy = false; }
  }, signal);
}
