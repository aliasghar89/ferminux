/* Block countdown `/block/countdown(/:n)` (§5.3). The block page sends a height beyond the head here (replace).
   With :n: "603,492 blocks from now" (rolls with the head), the estimated time (ESTIMATE + ⓘ: 7 s per block ×
   remaining blocks) and the latest block. Source: the index's /blocks/:n/countdown for the first paint, then
   recomputed locally on every head (no request per block). On reaching the height it opens the block (replace).
   Without :n: a number input. */
import { html, mount, dash } from "../ui/html";
import { statSkeleton } from "../ui/skeleton";
import { prov } from "../ui/marks";
import { hintBtn } from "../ui/kv";
import { note } from "../ui/state";
import { int, dur, utc } from "../format";
import { api } from "../api";
import { onHead, currentHead, type Head } from "../head";
import { liveText } from "../motion";
import { RPC_DOWN } from "../rpc";
import { isAbort } from "../util";
import { shell, slot } from "./_shell";
import { setMeta, navigate, type Params } from "../router";

const BLOCK_S = 7;
const HINT = "7 s per block × the remaining blocks. Signers can be late, so treat this as a guide.";

/** "12 Nov 2026, 14:34 UTC" */
function whenUtc(sec: number): string {
  const d = new Date(sec * 1000);
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  return `${d.getUTCDate()} ${mon} ${d.getUTCFullYear()}, ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

export function render(p: Params, _q: URLSearchParams, signal: AbortSignal, root: HTMLElement) {
  const raw = (p.n ?? "").replace(/,/g, "");
  const n = /^\d{1,15}$/.test(raw) ? Number(raw) : null;
  setMeta({ title: n !== null ? `Block ${int(n)} countdown` : "Block countdown", noindex: true });

  if (n === null) {
    shell(root, {
      crumbs: [{ href: "/blocks", label: "Blocks" }, { label: "Countdown" }],
      h1: "Block countdown",
      ident: p.n ? html`<span class="warn-text">“${p.n}” isn't a block number.</span>` : "How long until a block height is confirmed.",
      body: html`<form class="field cd-form" action="/block/countdown" data-countdown>
  <label for="cd-n">Block number</label>
  <div class="cd-row"><input id="cd-n" class="input" type="text" inputmode="numeric" name="n" autocomplete="off" placeholder="${currentHead() ? int(currentHead()!.n + 10_000) : "500,000"}"><button type="submit" class="btn btn-secondary">Count down</button></div>
  <p class="cd-err warn-text" data-err hidden></p>
</form>`,
    });
    const form = root.querySelector<HTMLFormElement>("[data-countdown]")!;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const v = (root.querySelector<HTMLInputElement>("#cd-n")?.value ?? "").replace(/[,\s]/g, "");
      const err = form.querySelector<HTMLElement>("[data-err]")!;
      if (/^\d{1,15}$/.test(v)) { err.hidden = true; navigate(`/block/countdown/${v}`); }
      else { err.hidden = false; err.textContent = "Enter a block number, for example 500000."; }
    });
    return;
  }

  shell(root, {
    crumbs: [{ href: "/blocks", label: "Blocks" }, { label: int(n) }],
    h1: `Block ${int(n)}`,
    ident: html`<span data-slot="ident">Not confirmed yet</span>`,
    body: html`<div data-slot="stats">${statSkeleton(["Blocks from now", "Estimated", "Latest block"])}</div><div data-slot="note"></div>`,
  });

  let painted = false;
  const paint = (h: { n: number; ts?: number }) => {
    const left = n - h.n;
    if (left <= 0) { navigate(`/block/${n}`, { replace: true }); return; }
    const secs = left * BLOCK_S;
    const base = h.ts ?? Date.now() / 1000;
    if (!painted) {
      painted = true;
      mount(slot(root, "stats"), html`<div class="statgrid cd-stats">
  <div><span class="l">Blocks from now</span><span class="v" data-k="left">${int(left)}</span><span class="s">at ${BLOCK_S} s per block</span></div>
  <div><span class="l">Estimated ${prov("estimate")}${hintBtn(HINT)}</span><span class="v" data-k="when">${whenUtc(base + secs)}</span><span class="s" data-k="dur">about ${dur(secs)}</span></div>
  <div><span class="l">Latest block</span><span class="v"><a class="num-mono" href="/block/${h.n}" data-k="head">${int(h.n)}</a></span><span class="s">confirmed ${utc(base)}</span></div>
</div>`);
      return;
    }
    liveText(root.querySelector<HTMLElement>('[data-k="left"]'), int(left));
    const w = root.querySelector<HTMLElement>('[data-k="when"]'); if (w) w.textContent = whenUtc(base + secs);
    const d = root.querySelector<HTMLElement>('[data-k="dur"]'); if (d) d.textContent = `about ${dur(secs)}`;
    const a = root.querySelector<HTMLAnchorElement>('[data-k="head"]'); if (a) { a.href = `/block/${h.n}`; liveText(a, int(h.n)); }
  };

  // first paint: the head when the store has one (no wait), else the index's countdown
  const h0 = currentHead();
  if (h0) paint(h0);
  onHead((h: Head) => { if (!signal.aborted) paint(h); }, signal);
  if (!h0) {
    api.blockCountdown(n, { signal }).then((c) => {
      if (signal.aborted || painted) return;
      const cur = Number(c.current_block_number);
      if (Number.isFinite(cur)) paint({ n: cur });
    }, (e) => {
      if (isAbort(e) || signal.aborted || painted) return;
      mount(slot(root, "stats"), html`<div class="statgrid cd-stats"><div><span class="l">Blocks from now</span><span class="v">${dash(RPC_DOWN)}</span></div></div>`);
      mount(slot(root, "note"), note("Neither the chain nor the explorer's index answered, so the countdown can't start. It begins as soon as the chain answers."));
    });
  }
}
