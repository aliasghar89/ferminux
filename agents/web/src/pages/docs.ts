import { config, contractsDeployed, nftDeployed, vaultDeployed, accountsDeployed, streamsDeployed, arbiterDeployed, identity8004Deployed, reputation8004Deployed, validation8004Deployed, tokenFactoryDeployed } from "../config";
import { $, $$, addrHtml, initChrome } from "../ui";
import { addNetwork, errMessage } from "../wallet";

initChrome();

const soon = `<span class="pill accent">deploying</span> <span class="muted small">address published here at launch</span>`;
$("#c-registry")!.innerHTML = contractsDeployed ? addrHtml(config.registry, { n: 10, label: "Registry" }) + ` <span class="small muted num">from block ${config.deployBlock.toLocaleString("en-US")}</span>` : soon;
$("#c-escrow")!.innerHTML = contractsDeployed ? addrHtml(config.escrow, { n: 10, label: "Escrow" }) : soon;
$("#c-gov")!.innerHTML = addrHtml(config.governance, { n: 10, label: "Governance" }) + ` <span class="small muted">2-of-3 multisig</span>`;
$("#c-treasury")!.innerHTML = addrHtml(config.treasury, { n: 10, label: "Treasury" }) + ` <span class="small muted">treasury</span>`;
$("#c-nft")!.innerHTML = nftDeployed ? addrHtml(config.nft, { n: 10, label: "Ferminux Agents" }) + ` <span class="small muted num">from block ${config.nftDeployBlock.toLocaleString("en-US")}</span>` : soon;
if (!contractsDeployed) $("#contracts-banner")!.innerHTML = `<div class="note">The registry and escrow are not deployed yet. This page and the SDK defaults are updated the moment they are; until then registering and hiring are disabled on this site.</div>`;
if (config.gateway.startsWith("http")) $("#api-base")!.textContent = config.gateway;

// Addendum v3 — Agent Economy: one combined "not deployed yet" note, since all nine contracts land together.
const v3All = [vaultDeployed, accountsDeployed, streamsDeployed, arbiterDeployed, identity8004Deployed, reputation8004Deployed, validation8004Deployed, tokenFactoryDeployed];
if (v3All.some((d) => !d)) {
  const left = v3All.filter((d) => !d).length;
  $("#x402-banner")!.innerHTML = `<div class="note">${left} of the nine Agent Economy contracts (X402Vault, AgentAccountFactory, StreamPay, ArbiterPool, the three FRC-8004 registry adapters, AgentTokenFactory) are not deployed yet. Every page under Economy in the nav renders fully and reads live gateway/mock data; the pieces that need a contract show a "not deployed yet" note in place of the write action.</div>`;
}

$("#add-network")!.addEventListener("click", async () => {
  const s = $("#add-status")!;
  try { await addNetwork(); s.textContent = "Ferminux Network added. Switch to it in your wallet."; }
  catch (e) { s.textContent = errMessage(e, "Request rejected."); }
});

// TOC highlight
const links = $$<HTMLAnchorElement>(".toc a");
const sections = links.map((l) => document.querySelector<HTMLElement>(l.getAttribute("href")!)).filter(Boolean) as HTMLElement[];

/* Phones: the 29-link pill wall becomes one sticky 44 px "On this page" control under the header that names
   the current section and opens the full list; a Top link appears after the first screen; and the long
   reference tables fold behind a summary so the page is scannable. It is a direct child of <main>, so
   sticky works across the whole page (a grid item could only stick inside its own row). */
const toc = $(".toc"), main = $("#main");
let mLabel: HTMLElement | null = null;
if (toc && main) {
  const wrap = document.createElement("div");
  wrap.className = "toc-m-wrap";
  wrap.innerHTML = `<div class="container"><details class="toc-m"><summary><span class="toc-m-l">On this page</span><span class="toc-m-cur" aria-live="off">Overview</span><svg class="chev" width="10" height="10" aria-hidden="true"><use href="#i-chev"/></svg></summary><nav aria-label="On this page, compact">${links.map((l) => `<a href="${l.getAttribute("href")}">${l.innerHTML}</a>`).join("")}</nav></details></div>`;
  main.prepend(wrap);
  mLabel = wrap.querySelector(".toc-m-cur");
  const det = wrap.querySelector("details")!;
  wrap.addEventListener("click", (e) => { if ((e.target as Element).closest("nav a")) det.open = false; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && det.open) { det.open = false; det.querySelector("summary")?.focus(); } });
  const top = document.createElement("a");
  top.className = "to-top"; top.href = "#main"; top.innerHTML = `Top<svg width="12" height="12" aria-hidden="true"><use href="#i-chev"/></svg>`;
  document.body.appendChild(top);
  let ticking = false;
  const onScroll = () => { if (ticking) return; ticking = true; requestAnimationFrame(() => { top.classList.toggle("show", scrollY > innerHeight * 1.2); ticking = false; }); };
  addEventListener("scroll", onScroll, { passive: true }); onScroll();
}
if (matchMedia("(max-width: 699px)").matches) {
  for (const w of $$(".doc .tbl-wrap")) {
    const n = w.querySelectorAll("tbody tr").length;
    if (n < 4) continue;
    const d = document.createElement("details");
    d.className = "tbl-fold";
    d.innerHTML = `<summary>Reference table · ${n} rows</summary>`;
    w.replaceWith(d); d.appendChild(w);
  }
}

const io = new IntersectionObserver((entries) => {
  for (const en of entries) if (en.isIntersecting) {
    const id = "#" + en.target.id;
    links.forEach((l) => { const on = l.getAttribute("href") === id; l.classList.toggle("on", on); if (on && mLabel) mLabel.textContent = l.textContent || ""; });
  }
}, { rootMargin: "-20% 0px -70% 0px" });
sections.forEach((s) => io.observe(s));
