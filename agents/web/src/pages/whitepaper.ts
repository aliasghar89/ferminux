// /whitepaper/ — the Ferminux Network whitepaper. The page is static HTML, so crawlers, agents and the PDF print
// read every word and figure without running anything; its figures are a dated read, stated in the text. This
// script only adds: the site chrome, the phone "Contents" control and a scroll-spy on the contents list, copy
// buttons on the verify commands, and a small panel that re-reads four figures live, so a reader can see how far
// the chain has moved since the paper's read. Each live figure stays "—" when its read fails.
import { config } from "../config";
import { rpc } from "../chainread";
import { $, $$, copyText, initChrome } from "../ui";

initChrome();

document.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-copy-block]"); if (!b) return;
  const pre = b.closest(".code-block")?.querySelector("pre"); if (pre) copyText(pre.textContent ?? "", b);
});

/* Contents: the desktop list highlights the section in view; on phones the list becomes the docs pages' sticky
   "On this page" control under the header (styles.css, "docs on phones"), which names the current section. */
const links = $$<HTMLAnchorElement>(".wp .toc a");
const sections = links.map((l) => document.querySelector<HTMLElement>(l.getAttribute("href")!)).filter(Boolean) as HTMLElement[];
const main = $("#main");
let current: HTMLElement | null = null;
if (links.length && main) {
  const wrap = document.createElement("div");
  wrap.className = "toc-m-wrap";
  wrap.innerHTML = `<div class="container"><details class="toc-m"><summary><span class="toc-m-l">Contents</span><span class="toc-m-cur" aria-live="off">Abstract</span><svg class="chev" width="10" height="10" aria-hidden="true"><use href="#i-chev"/></svg></summary><nav aria-label="Contents, compact">${links.map((l) => `<a href="${l.getAttribute("href")}">${l.innerHTML}</a>`).join("")}</nav></details></div>`;
  main.prepend(wrap);
  current = wrap.querySelector(".toc-m-cur");
  const det = wrap.querySelector("details")!;
  wrap.addEventListener("click", (e) => { if ((e.target as Element).closest("nav a")) det.open = false; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && det.open) { det.open = false; det.querySelector("summary")?.focus(); } });
  const top = document.createElement("a");
  top.className = "to-top"; top.href = "#main"; top.innerHTML = `Top<svg width="12" height="12" aria-hidden="true"><use href="#i-chev"/></svg>`;
  document.body.appendChild(top);
  let ticking = false;
  const onScroll = () => { if (ticking) return; ticking = true; requestAnimationFrame(() => {
    top.classList.toggle("show", scrollY > innerHeight * 1.2);
    // back above the first section: the control names it again, not the last section seen
    if (current && sections[0] && sections[0].getBoundingClientRect().top > innerHeight * 0.3) current.textContent = (links[0].textContent || "").replace(/^\s*\d+\s*/, "");
    ticking = false;
  }); };
  addEventListener("scroll", onScroll, { passive: true }); onScroll();
}
if ("IntersectionObserver" in window) {
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) {
      const id = "#" + en.target.id;
      links.forEach((l) => {
        const on = l.getAttribute("href") === id;
        l.classList.toggle("on", on);
        if (on) { l.setAttribute("aria-current", "location"); if (current) current.textContent = (l.textContent || "").replace(/^\s*\d+\s*/, ""); }
        else l.removeAttribute("aria-current");
      });
    }
  }, { rootMargin: "-20% 0px -70% 0px" });
  sections.forEach((s) => io.observe(s));
}

/* The live panel: the same sources the paper read, read again now. */
const set = (id: string, v: string) => { const el = $(`#${id}`); if (el) el.textContent = v; };
const whole = (s: unknown) => { const n = Number(s); return Number.isFinite(n) ? `${Math.floor(n).toLocaleString("en-US")} FMX` : "—"; };

async function live() {
  if (config.mock) return;
  rpc<string>("eth_blockNumber").then((h) => set("wl-head", Number.parseInt(h, 16).toLocaleString("en-US"))).catch(() => {});
  rpc<string[]>("clique_getSigners").then((s) => { if (Array.isArray(s) && s.length) set("wl-signers", String(s.length)); }).catch(() => {});
  try {
    const r = await fetch(`${config.gateway}/supply`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(String(r.status));
    const j = (await r.json()) as { totalSupply?: string; circulatingSupply?: string; asOfBlock?: number };
    set("wl-total", whole(j.totalSupply));
    set("wl-circ", whole(j.circulatingSupply));
    if (j.asOfBlock) set("wl-asof", `Supply figures at block ${j.asOfBlock.toLocaleString("en-US")} (the head minus 64).`);
  } catch { /* the em-dashes stay */ }
}
live();
