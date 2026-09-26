/* The shared relative-time ticker (§4.6): every 10 s it refreshes the <time data-rel> elements that are on
   screen, only while the tab is visible. A page can ask for 1 s ticks under a minute (home feed). */
import { relTime } from "../format";

let fast = false;
const onScreen = new Set<Element>();
let io: IntersectionObserver | null = null;
let mo: MutationObserver | null = null;

function paint(t: Element, now = Date.now() / 1000) {
  const d = (t as HTMLTimeElement).dateTime;
  if (d) { const s = relTime(d, now); if (t.textContent !== s) t.textContent = s; }
}
function refresh() {
  const now = Date.now() / 1000;
  onScreen.forEach((t) => {
    if (!t.isConnected) { onScreen.delete(t); return; }
    paint(t, now);
  });
}
function observe(root: ParentNode) {
  root.querySelectorAll?.("time[data-rel]").forEach((t) => io?.observe(t));
}

/** Start once (main.ts). */
export function initTicker() {
  if (io) return;
  // an age that scrolls into view is brought up to date at once (a row that slid in off screen kept its
  // "0 s ago" until the next tick otherwise)
  io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { onScreen.add(e.target); paint(e.target); } else onScreen.delete(e.target); }));
  mo = new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => { if (n instanceof Element) { if (n.matches("time[data-rel]")) io!.observe(n); observe(n); } })));
  mo.observe(document.getElementById("main") ?? document.body, { childList: true, subtree: true });
  observe(document);
  let tick = 0;
  window.setInterval(() => {
    if (document.hidden) return;
    tick++;
    if (fast || tick % 10 === 0) refresh();
  }, 1000);
}
/** Home feed: tick every second while fresh ages (< 60 s) are on screen. Reset on navigation. */
export const setFastTicker = (on: boolean) => { fast = on; };
