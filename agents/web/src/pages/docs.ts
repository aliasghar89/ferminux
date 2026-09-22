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
const io = new IntersectionObserver((entries) => {
  for (const en of entries) if (en.isIntersecting) { const id = "#" + en.target.id; links.forEach((l) => l.classList.toggle("on", l.getAttribute("href") === id)); }
}, { rootMargin: "-20% 0px -70% 0px" });
sections.forEach((s) => io.observe(s));
