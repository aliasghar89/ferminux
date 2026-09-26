/* Shared motion utility (.ui-craft/motion.md §3.4). One-time reveals ([data-rv]), loops that run only near
   the viewport ([data-loop]), the Pause-motion switch (WCAG 2.2.2) and the frosted header. The head script in
   partials/head.html has already set html[data-motion], html.rv-on and html[data-lite] before first paint.
   App pages carry no [data-rv] or [data-loop], so there this only drives the header. */

const root = document.documentElement;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Calm tier: the OS asks for reduced motion, or the reader pressed "Pause motion". */
export const calm = () => root.dataset.motion === "off";

const hooks = new WeakMap<Element, Array<() => void>>();
const loops: Array<[HTMLElement, (on: boolean) => void]> = [];
let started = false;

function show(el: Element) {
  if (el.classList.contains("in")) return;
  el.classList.add("in");
  const fs = hooks.get(el);
  if (fs) { hooks.delete(el); fs.forEach((f) => f()); }
}

/** Run `fn` once `el` (or its nearest [data-rv] host) has arrived; immediately if it already has or reveals are off. */
export function onReveal(el: Element | null | undefined, fn: () => void) {
  const host = el?.closest("[data-rv]");
  if (!host || host.classList.contains("in") || !root.classList.contains("rv-on")) { fn(); return; }
  const fs = hooks.get(host) ?? [];
  fs.push(fn); hooks.set(host, fs);
}

/** A JS-driven loop inside a [data-loop] element: `fn(true)` when it may run, `fn(false)` when it must stop
 *  (off-screen, tab hidden, or calm). Called once right away with the current state. */
export function onPlay(el: HTMLElement | null, fn: (on: boolean) => void) {
  if (!el) return;
  loops.push([el, fn]);
  fn(playing(el));
}
export const playing = (el: HTMLElement) => el.dataset.play !== "off" && !calm() && !document.hidden;
const notify = () => loops.forEach(([el, fn]) => fn(playing(el)));

/** Park the conveyor on its stations: token k rests at station k (the designed still frame, §8). */
function restFrame() {
  document.querySelectorAll(".lane .tk, .lane .tk > b").forEach((el) => el.getAnimations().forEach((a) => { a.currentTime = 0; }));
}

export function initMotion() {
  if (started) return;
  started = true;
  const rvOn = root.classList.contains("rv-on");
  // The CSS failsafe reveals everything 3 s after load in case this script never runs. When it runs in time,
  // cancel the failsafe so below-the-fold content still arrives on scroll; when it runs late, leave it (no flicker).
  if (rvOn && performance.now() < 2800) root.classList.add("rv-live");

  // 1 · Blur only where it is cheap: text blocks over the area cap, and the 5th+ member of a group, arrive
  // without blur (at most 4 blurring at once). Reads first, then writes.
  const cap = matchMedia("(max-width: 599px)").matches ? 60000 : 250000;
  const texts = Array.from(document.querySelectorAll<HTMLElement>('[data-rv="text"]'));
  const big = texts.filter((el) => { const r = el.getBoundingClientRect(); return r.width * r.height > cap; });
  big.forEach((el) => { el.dataset.rv = "card"; });
  document.querySelectorAll<HTMLElement>("[data-rv-group]").forEach((g) => {
    let i = 0;
    for (const c of Array.from(g.children) as HTMLElement[]) {
      if (!c.hasAttribute("data-rv")) continue;
      if (i >= 4 && c.dataset.rv === "text") c.dataset.rv = "card";
      if (!c.style.getPropertyValue("--i")) c.style.setProperty("--i", String(Math.min(i, 6)));
      i++;
    }
  });

  // 2 · Reveals, once, when the top crosses 90% of the viewport. Cards inside a horizontal snap row arrive
  // with the row, not one swipe at a time. Content already scrolled past is shown at once, never behind the reader.
  // Section headings arrive as a mask rise: the line lifts out of its own clip (the host only fades). Only when
  // this script is on time, so a late run never re-hides a heading the failsafe already showed.
  if (rvOn && root.classList.contains("rv-live") && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    document.querySelectorAll<HTMLElement>("[data-rv-heads] h2").forEach((h) => {
      const host = h.closest<HTMLElement>("[data-rv]");
      if (!host || host.closest(".hero-home") || h.querySelector(".mr")) return;
      h.innerHTML = `<span class="mr"><span>${h.innerHTML}</span></span>`;
      host.classList.add("rv-mask");
      if (host.dataset.rv === "card") host.dataset.rv = "text";
    });
  }

  const by = new Map<Element, Element[]>();
  let rio: IntersectionObserver | null = null;
  const reveal = (t: Element) => { by.get(t)?.forEach(show); by.delete(t); rio?.unobserve(t); };
  if (rvOn) {
    document.querySelectorAll("[data-rv]").forEach((el) => {
      const t = el.parentElement?.closest(".snap") ?? el;
      by.set(t, [...(by.get(t) ?? []), el]);
    });
    rio = new IntersectionObserver((es) => {
      for (const e of es) if (e.isIntersecting || e.boundingClientRect.bottom < 0) reveal(e.target);
    }, { rootMargin: matchMedia("(max-width: 599px)").matches ? "0px 0px -6% 0px" : "0px 0px -10% 0px", threshold: 0 });
    by.forEach((_, t) => rio!.observe(t));
  }
  // The last blocks of the page can never cross the 90% line: at the bottom, show whatever is on screen.
  const atEnd = () => {
    if (!by.size || innerHeight + scrollY < root.scrollHeight - 2) return;
    for (const t of [...by.keys()]) if (t.getBoundingClientRect().top < innerHeight) reveal(t);
  };

  // 3 · Loops play only within 200 px of the viewport.
  const lio = "IntersectionObserver" in window ? new IntersectionObserver((es) => {
    for (const e of es) {
      const el = e.target as HTMLElement;
      el.dataset.play = e.isIntersecting ? "on" : "off";
      loops.forEach(([l, fn]) => { if (l === el) fn(playing(el)); });
    }
  }, { rootMargin: "200px 0px" }) : null;
  document.querySelectorAll<HTMLElement>("[data-loop]").forEach((el) => { if (lio) lio.observe(el); else el.dataset.play = "on"; });
  document.addEventListener("visibilitychange", notify);

  // 4 · Pause motion (WCAG 2.2.2) and the OS setting, live. The OS wins: the switch hides while it asks.
  const mq = matchMedia("(prefers-reduced-motion: reduce)");
  const toggles = () => document.querySelectorAll<HTMLButtonElement>("[data-motion-toggle]");
  const saved = () => { try { return localStorage.getItem("fx-motion"); } catch { return null; } };
  const setMotion = (on: boolean, save: boolean) => {
    root.dataset.motion = on ? "on" : "off";
    if (save) try { localStorage.setItem("fx-motion", on ? "on" : "off"); } catch { /* private mode */ }
    toggles().forEach((b) => { b.setAttribute("aria-pressed", String(!on)); b.hidden = mq.matches; });
    if (!on) restFrame();
    document.dispatchEvent(new CustomEvent("fx:motion", { detail: on }));
    notify();
  };
  toggles().forEach((b) => b.addEventListener("click", () => setMotion(calm(), true)));
  mq.addEventListener?.("change", (e) => setMotion(!e.matches && saved() !== "off", false));
  setMotion(!calm(), false);

  // 5 · Frosted header from 8 px of scroll: one attribute flip per frame, never a scroll-driven animation.
  const hdr = document.querySelector<HTMLElement>(".site-header");
  let raf = 0;
  const upd = () => {
    raf = 0;
    const top = scrollY <= 8;
    if (hdr && hdr.hasAttribute("data-top") !== top) hdr.toggleAttribute("data-top", top);
    atEnd();
  };
  addEventListener("scroll", () => { if (!raf) raf = requestAnimationFrame(upd); }, { passive: true });
  upd();
}

/* ---- figures: digits land once, then only the changed digits roll (§4C). Never a count-up. ---- */

/** Split a figure into spans: digits rise into place, words and separators fade, 35 ms apart, left to right.
 *  A visually hidden copy keeps the value readable as one string for assistive tech. */
function landHtml(text: string): string {
  let j = 0;
  const parts = (text.match(/\d|\s+|[^\d\s]+/g) ?? []).map((t) => /^\s+$/.test(t) ? t
    : `<span class="dl${/^\d$/.test(t) ? "" : " s"}" style="--j:${j++}">${esc(t)}</span>`);
  return `<span class="vh">${esc(text)}</span><span aria-hidden="true">${parts.join("")}</span>`;
}
function rollHtml(prev: string, next: string): string {
  const same = prev.length === next.length;
  let j = 0; // changed digits roll 30 ms apart, left to right
  const parts = [...next].map((c, i) => /\d/.test(c) ? (!same || prev[i] !== c ? `<span class="dg roll" style="--j:${j++}">${c}</span>` : `<span class="dg">${c}</span>`) : esc(c));
  return `<span class="vh">${esc(next)}</span><span aria-hidden="true">${parts.join("")}</span>`;
}

/**
 * Write a live figure. The first real value lands when its section has arrived (whichever comes second);
 * later values roll only the digits that changed. "—" and the calm tier never animate. Once settled, the
 * figure goes back to one plain text node unless `keep` is set.
 */
export function liveText(el: HTMLElement | null, text: string, keep = false) {
  if (!el) return;
  const prev = el.dataset.v;
  if (prev === text) return;
  el.dataset.v = text;
  const quiet = calm() || text === "—" || (!/\d/.test(text) && prev !== undefined);
  // Once the figure has settled it goes back to one plain text node (one string for readers, a light DOM).
  // `keep` leaves the spans in place (the chip: collapsing would cost a second paint on every block).
  const settle = (ms: number) => { if (!keep) window.setTimeout(() => { if (el.dataset.v === text) el.textContent = text; }, ms); };
  if (prev === undefined || prev === "—") {
    el.textContent = text;
    if (quiet) return;
    onReveal(el, () => {
      if (el.dataset.v !== text || calm()) return;
      el.innerHTML = landHtml(text);
      settle(420 + 35 * text.length + 80);
    });
    return;
  }
  if (quiet) { el.textContent = text; return; }
  el.innerHTML = rollHtml(prev, text);
  settle(260 + 80);
}

/** Forget a figure's history, so the next value is written plainly (used when a live source drops out). */
export function resetText(el: HTMLElement | null, text: string) {
  if (!el) return;
  el.dataset.v = text;
  el.textContent = text;
}

/** Rows that just loaded fade in, 40 ms apart, once their panel has arrived. */
export function fadeRows(list: HTMLElement | null, sel = ":scope > *") {
  if (!list) return;
  onReveal(list, () => {
    if (calm()) return;
    list.querySelectorAll<HTMLElement>(sel).forEach((r, j) => {
      if (j < 8) r.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 280, delay: j * 40, easing: "cubic-bezier(.16,1,.3,1)", fill: "backwards" });
    });
  });
}

/* ---- snap carousel with dash position (§4H): the reader swipes; nothing autoplays ---- */
export function initSnap(track: HTMLElement | null, dots: HTMLElement | null) {
  if (!track || !dots) return;
  const items = Array.from(track.children) as HTMLElement[];
  if (items.length < 2) return;
  dots.innerHTML = items.map((it, i) => {
    const name = it.querySelector("h3")?.textContent?.trim() || `Card ${i + 1}`;
    return `<button type="button" aria-label="${esc(name)}"${i ? "" : ' aria-current="true"'}></button>`;
  }).join("");
  const btns = Array.from(dots.children) as HTMLButtonElement[];
  const setActive = (i: number) => btns.forEach((b, j) => { if (j === i) b.setAttribute("aria-current", "true"); else b.removeAttribute("aria-current"); });
  btns.forEach((b, i) => b.addEventListener("click", () => {
    const it = items[i];
    track.scrollTo({ left: it.offsetLeft - (track.clientWidth - it.clientWidth) / 2, behavior: calm() ? "auto" : "smooth" });
  }));
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) setActive(items.indexOf(e.target as HTMLElement)); }, { root: track, threshold: 0.6 });
    items.forEach((it) => io.observe(it));
  }
}
