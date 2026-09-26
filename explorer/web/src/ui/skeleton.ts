/* Loading states (§8.1). Skeletons match the final layout and appear only after 200 ms (CSS `.skel`), so a
   fast response never flashes one. At 5 s a line says the index is slow, with Retry. Panels load on their
   own: a slow tab never blocks the overview. */
import { html, type Html } from "./html";
import { onAbort } from "../util";

/** One bar. `w` is a CSS width ("60%", "96px"). */
export const sk = (w = "60%", h?: string) => html`<span class="sk" style="width:${w}${h ? `;height:${h}` : ""}"></span>`;
export const skLine = (w = "60%") => html`<span class="sk sk-line" style="width:${w}"></span>`;

/** A detail list skeleton: rows with 60 % / 40 % bars. */
export function kvSkeleton(labels: string[]): Html {
  return html`<dl class="dl-list sk-kv skel" aria-busy="true">${labels.map((l) => html`<div class="dl-row"><dt>${l}</dt><dd>${sk()}</dd></div>`)}</dl>`;
}
/** Stat cells with a 64 px bar under their label. */
export function statSkeleton(labels: string[]): Html {
  return html`<div class="statgrid skel" aria-busy="true">${labels.map((l) => html`<div><span class="l">${l}</span><span class="sk sk-stat"></span></div>`)}</div>`;
}
/** A page head skeleton under a known h1 (the h1 is real at once, so focus and the title land now). */
export const identSkeleton = () => html`<div class="ident skel">${sk("280px")}</div>`;

/**
 * Track a slow load inside `host`: after 5 s append "Still loading: the explorer's index is slow right now."
 * with Retry. Call the returned `done()` when the data arrives (or fails): it removes the line.
 */
export function slowWatch(host: HTMLElement | null, retry: () => void, signal?: AbortSignal) {
  let line: HTMLElement | null = null;
  const t = window.setTimeout(() => {
    if (!host || signal?.aborted) return;
    line = document.createElement("p");
    line.className = "slow";
    line.innerHTML = `<span>Still loading: the explorer's index is slow right now.</span><button type="button" class="btn btn-secondary btn-xs">Retry</button>`;
    line.querySelector("button")!.addEventListener("click", () => { done(); retry(); });
    host.append(line);
  }, 5000);
  const done = () => { clearTimeout(t); line?.remove(); line = null; };
  onAbort(signal, done);
  return done;
}
