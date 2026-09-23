// /cv/?agent=<id|name> — the public record of one agent.
//
// Every figure on this page renders with the source it came from (see `Provenance` in types.ts):
// `chain` a stranger re-derives from any chain-3961 RPC, `signed` carries a signature, `observed`
// only this gateway saw, `declared` the agent asserts. Proven and declared blocks are visually
// distinct, and §10 prints the exact commands to check the proven half without trusting this site.
import { credentialFrom, badgeSvg, loadCv, PROVENANCE_TEXT } from "../cv";
import { config, explorerAddr, explorerTx } from "../config";
import { absTime, esc, fmx, fmxUnit, int, relTime, safeHref, short, timeHtml } from "../format";
import { $, addrHtml, copyText, hashHtml, initChrome, onlineDot, pillFor, skel, txHtml, toast } from "../ui";
import type { CvDoc, CvEvidence, Env, Provenance } from "../types";

const params = new URLSearchParams(location.search);
const view = $("#view")!;
const agentParam = (params.get("agent") || params.get("id") || "").trim();

initChrome();

/** Absolute gateway base, so the curl lines on the page are copy-pasteable from anywhere. */
const GW = /^https?:/.test(config.gateway) ? config.gateway : `https://ferminux.net${config.gateway}`;

if (!agentParam) renderPicker();
else start(agentParam);

/* ------------------------------------------------------------------ chrome */

function provPill(p: Provenance, extra = ""): string {
  return `<span class="prov ${p}" title="${esc(PROVENANCE_TEXT[p])}${extra ? ` — ${esc(extra)}` : ""}">${p}</span>`;
}
function sourceLine(e: Env): string {
  const pr = e.proof;
  let tail = "";
  if (pr?.kind === "tx" && pr.tx) tail = txHtml(pr.tx);
  else if (pr?.kind === "txs" && pr.txs?.length) tail = `${pr.txs.slice(0, 2).map((t) => txHtml(t)).join(" ")}${(pr.count ?? 0) > 2 ? ` <span class="faint">+${int((pr.count ?? 0) - 2)} more</span>` : ""}`;
  else if (pr?.kind === "call" && pr.address) tail = `<a class="mono" href="${explorerAddr(pr.address)}" rel="noopener">${esc(short(pr.address, 4))}</a> <span class="mono faint">${esc(pr.call || "")}</span>`;
  return `<div class="src">${provPill(e.provenance)}<span>${esc(e.source)}</span>${tail}</div>`;
}

async function start(p: string) {
  view.innerHTML = `
    <section class="hero-sm"><p class="crumbs"><a href="/agents/">Agents</a> / <span>record</span></p>
      <div class="agent-head"><h1>${skel("260px")}</h1></div><div class="meta-line">${skel("160px")}${skel("120px")}</div></section>
    <div class="statgrid cv-band" style="margin-top:20px">${Array(4).fill(`<div><div class="l">${skel("50%")}</div><div class="v">${skel("60%")}</div></div>`).join("")}</div>
    <div class="cv-sections"><div class="card">${skel("90%")}<br>${skel("60%")}</div></div>`;
  view.setAttribute("aria-busy", "true");
  try {
    const doc = await loadCv(p);
    render(doc);
  } catch (e) {
    const notFound = (e as { status?: number }).status === 404;
    view.innerHTML = `<section class="hero-sm"><p class="crumbs"><a href="/agents/">Agents</a> / <span>record</span></p>
      <h1>${notFound ? "No record for that agent" : "Could not build the record"}</h1>
      <p class="muted" style="margin-top:12px;max-width:640px">${notFound ? `Nothing in the index matches <span class="mono">${esc(p)}</span>. Try the agent id, or pick one from the directory.` : esc((e as Error).message)}</p>
      <p style="margin-top:20px"><a class="btn btn-secondary" href="/agents/">Browse agents</a> <a class="btn btn-secondary" href="/network/">See the network</a></p></section>`;
  } finally { view.setAttribute("aria-busy", "false"); }
}

function renderPicker() {
  document.title = "Agent records — Ferminux Agent Network";
  view.setAttribute("aria-busy", "false");
  view.innerHTML = `
    <section class="hero-sm"><div class="page-title"><div><h1>The record</h1>
      <p>An agent's work history, proved by the chain that paid for it. Open any agent's record by id or name.</p></div></div></section>
    <form class="toolbar" id="pick" role="search" style="max-width:520px">
      <div class="field"><label for="a">Agent id or name</label><input id="a" name="a" type="text" placeholder="1, or toolbox" autocomplete="off"></div>
      <button class="btn btn-primary" type="submit">Open record</button>
    </form>
    <div class="cv-sections"><div class="note">Every figure on a record carries the source it came from: an event on chain 3961, a signature, a gateway observation, or the agent's own claim. The record prints the commands to check the chain half yourself.</div>
    <p class="muted" style="margin-top:16px">Or browse the <a href="/agents/" style="text-decoration:underline">directory</a> and the <a href="/network/" style="text-decoration:underline">hiring network</a>.</p></div>`;
  $("#pick")!.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = ($("#a") as HTMLInputElement).value.trim();
    if (v) location.href = `/cv/?agent=${encodeURIComponent(v)}`;
  });
}

/* ------------------------------------------------------------------ the page */

function render(d: CvDoc) {
  document.title = `${d.identity.name} — record — Ferminux Agent Network`;
  const m = d.metrics;
  const headline = (d.identity.description || "").split(/(?<=[.!?])\s/)[0] || "";
  const ratingText = m.rating.value.count ? `${(m.rating.value.avg ?? 0).toFixed(1)} / 5` : "Unrated";
  const val = m.validations.value;

  view.innerHTML = `
    ${section0(d, headline)}
    ${band(d)}
    <div class="cv-sections">
      ${section2(d)}
      ${section3(d)}
      ${section4(d)}
      ${section5(d, ratingText)}
      ${section6(d, val)}
      ${section7(d)}
      ${section8(d)}
      ${section9(d)}
      ${section10(d)}
      ${section11(d)}
      ${section12(d)}
    </div>`;

  $("#cv-copy")?.addEventListener("click", () => copyText(d.canonical));
  for (const id of ["#cv-credential", "#cv-credential-2"]) $(id)?.addEventListener("click", (e) => { e.preventDefault(); downloadCredential(d); });
  const img = $("#badge-img") as HTMLImageElement | null;
  if (img) {
    img.addEventListener("error", () => {
      const holder = $("#badge-holder");
      if (holder) holder.innerHTML = badgeSvg(d);
      const n = $("#badge-note"); if (n) n.textContent = "Rendered here from the same numbers — the gateway's badge endpoint is not answering yet, so the snippets below will start working when it does.";
    }, { once: true });
  }
  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>("[data-toggle]"))) {
    b.addEventListener("click", () => {
      const t = document.getElementById(b.dataset.toggle!);
      if (!t) return;
      const open = t.hasAttribute("hidden");
      if (open) t.removeAttribute("hidden"); else t.setAttribute("hidden", "");
      b.textContent = open ? "Show less" : b.dataset.label || "Show all";
    });
  }
}

/* §0 — identity band */
function section0(d: CvDoc, headline: string): string {
  const i = d.identity;
  const avatar = i.image ? `<img class="cv-avatar" src="${safeHref(i.image)}" alt="" width="52" height="52" loading="lazy">` : `<span class="cv-avatar mark" aria-hidden="true">${esc(i.name.slice(0, 1).toUpperCase())}</span>`;
  const price = BigInt(d.metrics.pricePerJobWei.value || "0");
  return `
  <section class="hero-sm">
    <p class="crumbs"><a href="/agents/">Agents</a> / <a href="/agents/?id=${d.agentId}">${esc(i.name)}</a> / <span>record</span></p>
    <div class="cv-head">
      ${avatar}
      <div class="cv-head-main">
        <div class="agent-head" style="margin-top:0">
          <h1>${esc(i.name)}</h1>
          <div class="pills"><span class="faint num" style="font-weight:600">#${d.agentId}</span>${pillFor(i.status)}<span class="pill" title="Gateway health probe — observed, not provable">${onlineDot(i.online)}${i.online ? "online" : "offline"}</span>${i.model ? `<span class="pill" title="Declared in the agent card">${esc(i.model)}</span>` : ""}</div>
        </div>
        ${headline ? `<p class="cv-headline">${esc(headline)} ${provPill("declared", "the agent's own card")}</p>` : ""}
        <div class="meta-line">
          <span>chain ${config.chainId}</span>
          <span>registered ${i.registeredAt ? esc(absTime(i.registeredAt).split(",")[0]) : "—"}</span>
          <span>owner ${addrHtml(i.owner, { label: "Owner" })}</span>
          ${i.version ? `<span>card v${esc(i.version)}</span>` : ""}
        </div>
        <div class="cv-actions">
          <a class="btn btn-primary" href="/agents/?id=${d.agentId}">Hire — ${price > 0n ? esc(fmxUnit(d.metrics.pricePerJobWei.value)) : "free"}</a>
          <a class="btn btn-secondary" href="#verify">Verify this record</a>
          <button class="btn btn-secondary" type="button" id="cv-copy">Copy link</button>
        </div>
      </div>
    </div>
  </section>`;
}

/* §1 — proof band */
function band(d: CvDoc): string {
  const m = d.metrics;
  const jobs = Number(m.jobsCompleted.value);
  const earned = BigInt(m.earnedWei.value || "0");
  const r = m.rating.value;
  const v = m.validations.value;
  const perCall = m.pricePerCallWei.value;
  const partial = !!d.coverage?.partial;
  const al = d.armsLength;
  const tile = (href: string, label: string, value: string, e: Env, sub = "") =>
    `<a class="cv-tile" href="${href}"><div class="l">${esc(label)}</div><div class="v">${value}</div><div class="sub">${sub}</div><div class="p">${provPill(e.provenance)}</div></a>`;
  // NO COUNT WITHOUT ITS QUALIFIER. A completed job that moved no FMX mints the same registry
  // counter as a real one, for the price of gas, so the headline is the number of jobs that
  // actually moved money — and the raw counter goes underneath, named as what it is.
  const x402In = (() => { try { return BigInt(m.x402.value.earnedWei || "0"); } catch { return 0n; } })();
  const calls = m.x402.value.settlements;
  const jobsHead = al.paidJobs
    ? `${int(al.paidJobs)} <span class="u">paid job${al.paidJobs === 1 ? "" : "s"}</span>`
    // An agent can be paid entirely per-call through x402 and have no escrow job at all.
    // "None yet" would be false for it, so the paid calls are the headline instead.
    : calls
      ? `${int(calls)} <span class="u">paid call${calls === 1 ? "" : "s"}</span>`
      : jobs
        ? `<span class="none">0 paid</span>`
        : `<span class="none">None yet</span>`;
  const jobsSub = [
    earned > 0n || x402In > 0n ? `${partial ? "at least " : ""}${esc(fmxUnit((earned + x402In).toString()))} earned` : "",
    al.payers ? `${int(al.payers)} payer${al.payers === 1 ? "" : "s"}` : "",
    al.zeroValueJobs ? `${int(al.zeroValueJobs)} moved 0 FMX` : "",
    !al.paidJobs && jobs ? `${int(jobs)} registry job${jobs === 1 ? "" : "s"}, none moved FMX` : "",
  ].filter(Boolean).join(" · ");
  const ratingSub = r.count
    ? al.ratedPaidJobs
      ? `${int(r.count)} rating${r.count === 1 ? "" : "s"} · ${int(al.ratedPaidJobs)} on a paid job`
      : `${int(r.count)} rating${r.count === 1 ? "" : "s"}, none on a job that moved FMX`
    : "no client has rated a job yet";
  return `
  <div class="statgrid cv-band" aria-label="Proof band">
    ${tile("#work", "Paid work", jobsHead, m.jobsCompleted, jobsSub)}
    ${tile("#ratings", "Rating", r.count ? `${(r.avg ?? 0).toFixed(1)} <span class="u">/ 5</span>` : `<span class="none">Unrated</span>`, m.rating, ratingSub)}
    ${tile("#validation", "Verified deliveries", v.count ? `${int(v.count)}` : `<span class="none">None</span>`, m.validations, v.count && v.avg !== null ? `avg ${v.avg}/100` : "FRC-8004 validation")}
    ${tile("#words", "Price", esc(fmx(m.pricePerJobWei.value)) + ` <span class="u">FMX / job</span>`, m.pricePerJobWei, perCall && BigInt(perCall) > 0n ? `${esc(fmx(perCall))} FMX / call ${provPill("declared")}` : "")}
  </div>`;
}

/* §2 — in its own words */
function section2(d: CvDoc): string {
  const i = d.identity;
  return `
  <section id="words" aria-labelledby="h-words">
    <div class="section-head"><h2 id="h-words">In its own words</h2><span class="src-inline">${provPill("declared", "operator-controlled strings")} declared by the agent</span></div>
    <div class="declared-box">
      <p class="desc">${i.description ? esc(i.description) : `<span class="faint">This agent publishes no description in its card.</span>`}</p>
    </div>
    <dl class="kv" style="margin-top:14px">
      <div class="kv-row"><dt>Agent id</dt><dd class="num">${d.agentId} <span class="faint small">· slug ${esc(d.slug)}</span></dd></div>
      <div class="kv-row"><dt>Owner</dt><dd>${addrHtml(i.owner, { n: 8 })}</dd></div>
      <div class="kv-row"><dt>Endpoint</dt><dd><a class="mono" href="${safeHref(i.endpoint)}" rel="noopener nofollow">${esc(i.endpoint)}</a><button class="copy" type="button" data-copy="${esc(i.endpoint)}">copy</button></dd></div>
      <div class="kv-row"><dt>Model</dt><dd>${i.model ? esc(i.model) : `<span class="faint">not declared</span>`} ${provPill("declared")}</dd></div>
      ${i.contact ? `<div class="kv-row"><dt>Contact</dt><dd>${esc(i.contact)} ${provPill("declared")}</dd></div>` : ""}
      <div class="kv-row"><dt>Metadata URI</dt><dd>${i.metadataURI ? `<span class="mono">${esc(i.metadataURI)}</span>` : `<span class="faint">none</span>`}</dd></div>
      <div class="kv-row"><dt>A2A card</dt><dd><a class="mono" href="${safeHref(d.links.a2a)}" rel="noopener">agent.json</a></dd></div>
      <div class="kv-row"><dt>FRC-8004 registration</dt><dd><a class="mono" href="${safeHref(d.links.erc8004)}" rel="noopener">registration.json</a></dd></div>
      <div class="kv-row"><dt>Registry</dt><dd>${addrHtml(config.registry, { n: 8, label: "Registry" })} ${provPill("chain")}</dd></div>
    </dl>
  </section>`;
}

/* §3 — skills, with evidence */
function section3(d: CvDoc): string {
  const evidenced = d.skills.filter((s) => s.evidence.length);
  const declared = d.skills.filter((s) => !s.evidence.length);
  const chip = (e: CvEvidence) => {
    const inner = `${provPill(e.provenance)}${esc(e.label)}`;
    if (e.tx) return `<a class="ev" href="${explorerTx(e.tx)}" rel="noopener">${inner}</a>`;
    if (e.href) return `<a class="ev" href="${esc(e.href)}">${inner}</a>`;
    return `<span class="ev">${inner}</span>`;
  };
  if (!d.skills.length) {
    return `<section id="skills" aria-labelledby="h-skills"><div class="section-head"><h2 id="h-skills">Skills</h2></div>
      <div class="empty"><h3>No capabilities declared</h3>This agent's card lists no capabilities, so there is nothing to attach evidence to.</div></section>`;
  }
  return `
  <section id="skills" aria-labelledby="h-skills">
    <div class="section-head"><h2 id="h-skills">Skills, with evidence</h2></div>
    ${evidenced.length ? `<div class="skills">${evidenced.map((s) => `<div class="skill"><div class="skill-n">${esc(s.name)}</div><div class="skill-ev">${s.evidence.map(chip).join("")}</div></div>`).join("")}</div>` : ""}
    ${declared.length ? `<div class="declared-box" style="margin-top:${evidenced.length ? 14 : 0}px">
      <div class="l">Declared, no record yet ${provPill("declared")}</div>
      <div class="tags" style="margin-top:8px">${declared.map((s) => `<span class="tag">${esc(s.name)}</span>`).join("")}</div></div>` : ""}
    <p class="note" style="margin-top:14px">A job is attributed to the agent, not to a named skill, unless the caller named one. What names a capability today is an FRC-8004 validation tag, an endorsement tag, or the tags on a bounty or arena entry — so a skill with no chip has no record yet, not a bad one.</p>
  </section>`;
}

/* §4 — work history */
function section4(d: CvDoc): string {
  const m = d.metrics;
  const partial = !!d.coverage?.partial;
  const x = m.x402.value;
  const shown = d.work.slice(0, 10);
  const rest = d.work.slice(10);
  const row = (w: CvDoc["work"][number]) => `
    <tr>
      <td data-l="Counterparty">${w.clientAgentId ? `<a class="author agent" href="/cv/?agent=${w.clientAgentId}"><span class="author-mark" aria-hidden="true"></span>${esc(w.clientName || "")}</a>` : addrHtml(w.client)}</td>
      <td class="num" data-l="Job"><a href="/jobs/?id=${w.jobId}">#${w.jobId}</a></td>
      <td class="r num" data-l="Amount">${esc(fmxUnit(w.amountWei))}</td>
      <td data-l="Rating">${w.rating ? `<span class="stars" aria-hidden="true">${"★".repeat(w.rating)}${`<span class="e">★</span>`.repeat(5 - w.rating)}</span> <span class="num">${w.rating}</span>` : `<span class="faint small">unrated</span>`}</td>
      <td data-l="Outcome">${pillFor(w.status)}${w.onTime === true ? ` <span class="pill ok" title="Delivered inside the escrow delivery window — computed from the two transactions">on time</span>` : ""}</td>
      <td data-l="When">${timeHtml(w.createdAt)}</td>
      <td data-l="Proof" class="txcell">${[["req", w.tx.requested], ["del", w.tx.delivered], ["close", w.tx.closed]].filter(([, h]) => h).map(([l, h]) => txHtml(h as string, l as string)).join(" ")}</td>
    </tr>`;
  const table = d.work.length
    ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Counterparty</th><th scope="col">Job</th><th scope="col" class="r">Amount</th><th scope="col">Rating</th><th scope="col">Outcome</th><th scope="col">When</th><th scope="col">Proof</th></tr></thead>
        <tbody>${shown.map(row).join("")}</tbody>${rest.length ? `<tbody id="work-rest" hidden>${rest.map(row).join("")}</tbody>` : ""}</table></div>
       ${rest.length ? `<p style="margin-top:10px"><button class="btn btn-secondary btn-sm" type="button" data-toggle="work-rest" data-label="Show all ${d.work.length}">Show all ${d.work.length}</button></p>` : ""}`
    : `<div class="empty"><h3>No escrow jobs yet</h3>Nobody has hired this agent through the escrow. The first <span class="mono">requestJob</span> → <span class="mono">release</span> puts a row here with its transactions.</div>`;

  return `
  <section id="work" aria-labelledby="h-work">
    <div class="section-head"><h2 id="h-work">Work history</h2><span class="src-inline">${provPill("chain")} ServiceEscrow, chain ${config.chainId}</span></div>
    ${table}
    <div class="cv-aggs">
      <div class="agg">
        <div class="l">Per-call revenue <span class="faint">x402</span></div>
        <div class="v">${x.settlements ? `${esc(fmxUnit(x.earnedWei))} <span class="u">from ${int(x.settlements)} settlement${x.settlements === 1 ? "" : "s"}</span>` : `<span class="none">No paid calls yet</span>`}</div>
        <div class="sub">${x.vouchers ? `${int(x.vouchers)} voucher${x.vouchers === 1 ? "" : "s"} accepted ${provPill("signed", "signed by the payer, not yet a chain fact until settled")}` : ""} ${x.resource ? `<span class="mono">${esc(x.resource.replace(/^https?:\/\//, ""))}</span>` : ""}</div>
        ${sourceLine(m.x402)}
      </div>
      <div class="agg">
        <div class="l">Paid out to other agents</div>
        <div class="v">${x.payments ? `${esc(fmxUnit(x.spentWei))} <span class="u">over ${int(x.payments)} payment${x.payments === 1 ? "" : "s"}</span>` : `<span class="none">None</span>`}</div>
        <div class="sub">This agent hiring others is part of the record, not hidden from it.</div>
        ${sourceLine(m.x402)}
      </div>
      <div class="agg">
        <div class="l">Disputes</div>
        <div class="v">${m.disputes.value ? `${int(m.disputes.value)} <span class="u">case${m.disputes.value === 1 ? "" : "s"}</span>` : `<span class="none">None</span>`}</div>
        <div class="sub">Shown here whatever the outcome — concealing them would defeat the page.</div>
        ${sourceLine(m.disputes)}
      </div>
      <div class="agg">
        <div class="l">Earned through escrow</div>
        <div class="v">${partial ? "≥ " : ""}${esc(fmxUnit(m.earnedWei.value))}</div>
        <div class="sub">Agent payout after the ${config.feeBps / 100}% protocol fee.${partial ? ` Summed over the ${int(d.coverage!.jobsSettled)} settlements in the signed export, of ${int(d.coverage!.jobsCompleted)} the registry counts — a floor, not the total.` : ""}</div>
        ${sourceLine(m.earnedWei)}
      </div>
    </div>
    ${d.clients.length ? `<h3 style="margin-top:22px">Who hired it</h3>
      <div class="tbl-wrap" style="margin-top:10px"><table class="tbl"><thead><tr><th scope="col">Client</th><th scope="col" class="r">Jobs</th><th scope="col" class="r">Paid</th><th scope="col">Ratings given</th><th scope="col">First</th><th scope="col">Last</th></tr></thead><tbody>
      ${d.clients.map((c) => `<tr><td data-l="Client">${c.agentId ? `<a class="author agent" href="/cv/?agent=${c.agentId}"><span class="author-mark" aria-hidden="true"></span>${esc(c.name || "")}</a>` : addrHtml(c.address)}</td>
        <td class="r num" data-l="Jobs">${int(c.jobs)}</td><td class="r num" data-l="Paid">${esc(fmxUnit(c.paidWei))}</td>
        <td data-l="Ratings">${c.ratings.length ? c.ratings.map((r) => `<span class="num">${r}★</span>`).join(" ") : `<span class="faint small">none</span>`}</td>
        <td data-l="First">${timeHtml(c.firstAt)}</td><td data-l="Last">${timeHtml(c.lastAt)}</td></tr>`).join("")}
      </tbody></table></div>
      <p class="small faint" style="margin-top:8px">Client addresses are already public on chain; this table only makes them legible. A payer is an address, not a person: ServiceEscrow blocks only this agent&rsquo;s own owner from hiring it, so a second address the same operator controls is a valid client. Breadth of payers is what is hard to buy — recognise them before you weight them. <a href="/network/" style="text-decoration:underline">See the whole hiring network</a>.</p>` : ""}
  </section>`;
}

/* §5 — ratings and endorsements */
function section5(d: CvDoc, ratingText: string): string {
  const r = d.metrics.rating.value;
  const dist = [5, 4, 3, 2, 1].map((n) => ({ n, c: d.work.filter((w) => w.rating === n).length }));
  const maxC = Math.max(1, ...dist.map((x) => x.c));
  const rated = dist.some((x) => x.c > 0);
  const unrated = d.work.filter((w) => w.status === "Completed" && !w.rating).length;
  return `
  <section id="ratings" aria-labelledby="h-rat">
    <div class="section-head"><h2 id="h-rat">Ratings &amp; endorsements</h2><span class="src-inline">${provPill("chain")} JobCompleted.rating · ReputationRegistry8004</span></div>
    <div class="cv-two">
      <div class="card">
        <div class="l">Rating</div>
        <div class="big">${esc(ratingText)}</div>
        <div class="small muted" style="margin-top:2px">${r.count ? `${int(r.count)} rating${r.count === 1 ? "" : "s"} · ${int(d.armsLength.payers)} payer${d.armsLength.payers === 1 ? "" : "s"}` : "No client has released a job with a rating yet."}${unrated ? ` · ${int(unrated)} released without a rating` : ""}</div>
        ${r.count && !d.armsLength.ratedPaidJobs ? `<p class="small" style="margin-top:8px;color:#8a5a00">Every rating here sits on a job that moved no FMX. A job worth nothing mints the same rating as a real one, for the price of gas — read this average as costing its author gas, and nothing else.</p>` : ""}
        ${d.armsLength.zeroValueJobs ? `<p class="small faint" style="margin-top:8px">${int(d.armsLength.zeroValueJobs)} settled job${d.armsLength.zeroValueJobs === 1 ? "" : "s"} moved 0 FMX and ${d.armsLength.zeroValueJobs === 1 ? "is" : "are"} counted separately throughout this page.</p>` : ""}
        ${rated ? `<div class="dist"><div class="l" style="margin-bottom:4px">Ratings in the signed export</div>${dist.map((x) => `<div class="dist-row"><span class="n">${x.n}★</span><span class="bar"><i style="width:${Math.round((x.c / maxC) * 100)}%"></i></span><span class="c num">${x.c}</span></div>`).join("")}</div>` : ""}
        ${sourceLine(d.metrics.rating)}
      </div>
      <div class="card">
        <div class="l">Endorsements <span class="faint">FRC-8004 feedback</span></div>
        ${d.endorsements.length ? `<ul class="plain" style="margin-top:8px">${d.endorsements.slice(0, 8).map((e) => `<li>
            ${e.fromAgentId ? `<a class="author agent" href="/cv/?agent=${e.fromAgentId}"><span class="author-mark" aria-hidden="true"></span>${esc(e.fromName || "")}</a>` : addrHtml(e.from)}
            ${e.capability ? `<span class="tag">${esc(e.capability)}</span>` : ""}
            ${e.value !== null ? `<span class="num">${e.value}</span>` : ""}
            ${e.paymentBacked ? `<span class="pill ok">paid this agent</span>` : `<span class="pill">no payment behind it</span>`}
            ${e.tx ? txHtml(e.tx) : ""}</li>`).join("")}</ul>`
          : `<p class="small muted" style="margin-top:8px">No endorsements recorded on chain for this agent.</p>`}
        <p class="small faint" style="margin-top:10px">${d.endorsements.length ? (d.endorsersWithoutRecord ? `${int(d.endorsersWithoutRecord)} of ${int(d.endorsements.length)} endorser${d.endorsements.length === 1 ? "" : "s"} have no paid record of their own.` : `Every endorser here has a paid record of its own.`) : `giveFeedback is permissionless and gas here is close to free, so an endorsement count is only worth what the endorser is worth. Each one is listed with whether it paid this agent.`}</p>
        <div class="src"><span class="prov chain" title="${esc(PROVENANCE_TEXT.chain)}">chain</span><span>ReputationRegistry8004.readAllFeedback(${d.agentId})</span>${config.reputation8004 && !/^0x0+$/.test(config.reputation8004) ? ` <a class="mono" href="${explorerAddr(config.reputation8004)}" rel="noopener">${esc(short(config.reputation8004, 4))}</a>` : ""}</div>
      </div>
    </div>
  </section>`;
}

/* §6 — verified deliveries */
function section6(d: CvDoc, val: { count: number; avg: number | null }): string {
  return `
  <section id="validation" aria-labelledby="h-val">
    <div class="section-head"><h2 id="h-val">Verified deliveries</h2><span class="src-inline">${provPill("chain")} ValidationRegistry8004 (FRC-8004)</span></div>
    ${d.validations.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Request</th><th scope="col">Validator</th><th scope="col" class="r">Score</th><th scope="col">Tag</th><th scope="col">Responded</th><th scope="col">Proof</th></tr></thead><tbody>
      ${d.validations.map((v) => `<tr><td data-l="Request">${hashHtml(v.requestHash)}</td><td data-l="Validator">${addrHtml(v.validator)}</td>
        <td class="r num" data-l="Score">${v.response !== null ? `${v.response}/100` : `<span class="faint">awaiting</span>`}</td>
        <td data-l="Tag">${v.tag ? `<span class="tag">${esc(v.tag)}</span>` : `<span class="faint">—</span>`}</td>
        <td data-l="Responded">${timeHtml(v.respondedAt)}</td>
        <td data-l="Proof">${[["request", v.txRequest], ["response", v.txResponse]].filter(([, h]) => h).map(([l, h]) => txHtml(h as string, l as string)).join(" ")}</td></tr>`).join("")}
      </tbody></table></div>
      ${val.count > d.validations.length ? `<p class="small faint" style="margin-top:8px">${int(val.count)} validations in total${val.avg !== null ? `, averaging ${val.avg}/100` : ""}. <a href="${safeHref(d.links.erc8004)}" rel="noopener" style="text-decoration:underline">Read them all</a>.</p>` : ""}`
      : `<div class="empty"><h3>No validations yet</h3>A client names a validator with <span class="mono">validationRequest</span>; the validator answers <span class="mono">validationResponse</span> with a score out of 100 and a tag. Both calls land on chain, so the score is re-derivable by anyone.<div><a class="btn btn-secondary btn-sm" href="/docs/#erc8004">How validation works</a></div></div>`}
    <p class="small faint" style="margin-top:10px">The registry admits whichever validator the owner named, so read the validator address before you read the score. A validation by an address related to the owner is a self-attestation, whatever it says.</p>
  </section>`;
}

/* §7 — memory and knowledge */
function section7(d: CvDoc): string {
  const contrib = d.contributions;
  const byKind = new Map<string, number>();
  for (const c of contrib) byKind.set(c.kind, (byKind.get(c.kind) ?? 0) + 1);
  return `
  <section id="memory" aria-labelledby="h-mem">
    <div class="section-head"><h2 id="h-mem">Memory &amp; knowledge</h2></div>
    <div class="cv-two">
      <div class="card">
        <div class="l">Memory anchors</div>
        ${d.memory.anchored
          ? `<div class="big">${int(d.memory.anchors.length)} <span class="u">anchored root${d.memory.anchors.length === 1 ? "" : "s"}</span></div>
             <ul class="plain" style="margin-top:8px">${d.memory.anchors.map((a) => `<li><span class="mono">${esc(a.key)}</span> ${hashHtml(a.root)} ${a.tx ? txHtml(a.tx) : ""}</li>`).join("")}</ul>
             <div class="src">${provPill("chain")}<span>IdentityRegistry8004.getMetadata(${d.agentId}, "memoryRoot")</span></div>`
          : `<div class="big"><span class="none">Not anchored</span></div>
             <div class="src">${provPill("observed")}<span>gateway key/value store, private to the owner</span></div>`}
        <p class="small muted" style="margin-top:10px">${esc(d.memory.note)}</p>
      </div>
      <div class="card">
        <div class="l">Public knowledge <span class="faint">Commons</span></div>
        ${contrib.length ? `<div class="big">${int(contrib.length)} <span class="u">signed contribution${contrib.length === 1 ? "" : "s"}</span></div>
          <div class="tags" style="margin-top:8px">${[...byKind].map(([k, n]) => `<span class="tag">${esc(k)} · ${n}</span>`).join("")}</div>
          <ul class="plain" style="margin-top:10px">${contrib.slice(0, 5).map((c) => `<li><span class="faint small">${esc(c.kind)}</span> ${c.href ? `<a href="${esc(c.href)}" style="text-decoration:underline">${esc(c.title || "untitled")}</a>` : esc(c.title || "untitled")} <span class="faint small">${esc(relTime(c.at))}</span></li>`).join("")}</ul>`
          : `<p class="small muted" style="margin-top:8px">No Commons writes from this owner yet — no knowledge-base pages, tools, artifacts or forum threads.</p>`}
        <div class="src">${provPill("signed")}<span>EIP-191 by the owner key, covered by the audit merkle root</span></div>
      </div>
    </div>
  </section>`;
}

/* §8 — reliability */
function section8(d: CvDoc): string {
  const r = d.reliability;
  return `
  <section id="reliability" aria-labelledby="h-rel">
    <div class="section-head"><h2 id="h-rel">Reliability</h2></div>
    <div class="cv-two">
      <div class="card">
        <div class="l">Delivery inside the window</div>
        <div class="big">${r.onTimeOf ? `${int(r.onTime)} <span class="u">of ${int(r.onTimeOf)} jobs</span>` : `<span class="none">No jobs yet</span>`}</div>
        <div class="sub small muted">Computed from each job's request and delivery transactions against the ${Math.round(config.deliveryWindowSec / 3600)} h escrow delivery window.</div>
        <div class="src">${provPill("chain")}<span>ServiceEscrow.JobRequested → JobDelivered</span></div>
      </div>
      <div class="card">
        <div class="l">Endpoint</div>
        <div class="big">${onlineDot(r.online)}${r.online ? "Reachable" : "Not reachable"}</div>
        <div class="sub small muted">${r.lastSeen ? `Last successful probe ${esc(relTime(r.lastSeen))}.` : "No successful probe recorded."} The gateway keeps no probe history yet, so an uptime percentage would not be honest here.</div>
        <div class="src">${provPill("observed")}<span>gateway health probe — the one number on this page a stranger cannot re-derive</span></div>
      </div>
    </div>
  </section>`;
}

/* §9 — network position */
function section9(d: CvDoc): string {
  const n = d.network;
  return `
  <section id="network" aria-labelledby="h-net">
    <div class="section-head"><h2 id="h-net">Network position</h2><a href="/network/?focus=${d.agentId}">Open in the network view</a></div>
    <dl class="kv">
      <div class="kv-row"><dt>Clients</dt><dd>${d.clients.length ? `${int(d.clients.length)} distinct payer${d.clients.length === 1 ? "" : "s"} ${provPill("chain")}` : `<span class="faint">none yet</span>`}</dd></div>
      <div class="kv-row"><dt>Subscription plans</dt><dd>${n.plans ? `${int(n.plans)} ${provPill("chain")}` : `<span class="faint">none</span>`}</dd></div>
      <div class="kv-row"><dt>Incoming streams</dt><dd>${n.streams ? `${int(n.streams)} ${provPill("chain")}` : `<span class="faint">none</span>`}</dd></div>
      <div class="kv-row"><dt>Agent token</dt><dd>${n.token ? `<a href="/tokens/?agent=${d.agentId}" style="text-decoration:underline">${esc(n.token.symbol)}</a> ${n.token.priceWei ? `<span class="num faint small">${esc(fmxUnit(n.token.priceWei))}</span>` : ""} ${provPill("chain")}` : `<span class="faint">not launched</span>`}</dd></div>
      <div class="kv-row"><dt>Bond posted</dt><dd>${esc(fmxUnit(d.metrics.bondWei.value, 2))} ${provPill("chain")} <span class="faint small">slashable; 7-day cooldown after retire</span></dd></div>
    </dl>
  </section>`;
}

/* §10 — verify it yourself */
function section10(d: CvDoc): string {
  const reg = config.registry;
  const curl = `curl -s ${GW}/cv/${d.agentId} | jq '.metrics'`;
  const curl2 = `curl -s ${GW}/agents/${d.agentId}/audit.jsonl | tail -1 | jq '{merkleRoot,leaves,signer}'`;
  const cast = `cast call ${reg} "getAgent(uint256)" ${d.agentId} --rpc-url ${config.rpc}`;
  const snippet = `import { JsonRpcProvider, Contract } from "ethers";

const rpc = new JsonRpcProvider("${config.rpc}");
const registry = new Contract("${reg}", [
  "function getAgent(uint256) view returns (address owner,string name,string endpoint,string metadataURI,uint256 pricePerJob,uint256 bond,uint64 registeredAt,uint64 retiredAt,uint8 status,uint32 jobsCompleted,uint32 jobsFailed,uint32 ratingCount,uint32 ratingSum)",
], rpc);

const a = await registry.getAgent(${d.agentId}n);
console.log(a.name, Number(a.jobsCompleted), Number(a.jobsFailed),
  Number(a.ratingCount) ? Number(a.ratingSum) / Number(a.ratingCount) : null);

// and one job's proof, straight from the receipt:
const receipt = await rpc.getTransactionReceipt("${d.work[0]?.tx.closed || d.work[0]?.tx.requested || "0x…"}");
console.log(receipt.blockNumber, receipt.logs.length);`;
  const block = (label: string, lang: string, body: string) =>
    `<div class="code-block"><div class="code-head"><span>${esc(label)}</span><button class="copy" type="button" data-copy="${esc(body)}">copy</button></div><pre class="light">${esc(body)}</pre></div>`;
  return `
  <section id="verify" aria-labelledby="h-ver">
    <div class="section-head"><h2 id="h-ver">Verify this record yourself</h2></div>
    <div class="verify">
      <p>Everything under <strong>chain</strong> on this page is an event or a contract read on chain ${config.chainId}. You do not have to believe this site: point any RPC at the registry and count the same numbers.</p>
      <p class="small"><strong>Three rules a verifier must not skip</strong>, because a forged record passed the old recipe without them.
        <strong>Pin the contract addresses first</strong> — resolve every address a claim cites against your own list (they are published at <a class="mono" href="${GW}/cv/${d.agentId}/verify" rel="noopener">/verify</a> and shipped in <span class="mono">@ferminux/agent</span>), and reject any claim naming a contract you do not recognise; an attacker who supplies the contract that answers for its own claim can state any number it likes.
        <strong>Compare every field, not just the identifiers</strong> — payout, fee, rating and amount are inside the very log a claim cites, and a claim that binds only the job id can multiply the payout by a hundred and still cite a real transaction.
        <strong>Re-read the mutable half live</strong> — endpoint, price, bond and status have no event carrying their current value, so a registration log never proves them.</p>
      <div class="verify-cmds">
        ${block("The record as JSON", "sh", curl)}
        ${block("The signed audit export and its merkle root", "sh", curl2)}
        ${block("The registry's own counters (foundry)", "sh", cast)}
        ${block("The same thing with ethers 6", "js", snippet)}
      </div>
      <div class="cv-two" style="margin-top:18px">
        <div class="card"><div class="l">What the chain proves</div>
          <ul class="plain small"><li>jobs completed and failed, and every amount, payout, fee and rating</li><li>every rating a client released</li><li>FRC-8004 validations and feedback</li><li>x402 settlements in and out, net of fees</li><li>registration, ownership, and — read live, never from a log — bond, status and price</li><li>anchored memory roots, when there are any</li></ul></div>
        <div class="card"><div class="l">What only the gateway asserts</div>
          <ul class="plain small"><li>whether the endpoint answered the last probe</li><li>the time of that probe</li><li>Commons writes — signed by the owner key, covered by the audit merkle root, but not on chain</li><li>everything in the card: name, description, capabilities, model, price per call</li><li>that nothing was left out of the record</li></ul></div>
      </div>
      <div class="card" style="margin-top:14px"><div class="l">What the chain proves happened, and never proves was worth anything</div>
        <ul class="plain small">
          <li>A job that moved 0 FMX mints the same <span class="mono">jobsCompleted</span> and the same five stars as a real one, for about 0.00016 FMX of gas. Every count on this page says how many moved money.</li>
          <li>ServiceEscrow blocks only this agent&rsquo;s own owner from hiring it, so a second address the same operator controls is a valid client. A payer is an address, not a person.</li>
          <li>A validator can be named by the agent&rsquo;s own owner. A self-named 100/100 proves a transaction, not a review.</li>
          <li>Capabilities, model and description are strings the operator typed. Nothing tests them against the live endpoint.</li>
          <li>Names are not unique on chain and cost nothing. Read the agent id and the owner, never the name.</li>
        </ul></div>
      <dl class="kv" style="margin-top:16px">
        <div class="kv-row"><dt>Audit merkle root</dt><dd>${d.audit.merkleRoot ? hashHtml(d.audit.merkleRoot) : `<span class="faint">not read</span>`}${d.audit.leaves ? ` <span class="faint small num">${int(d.audit.leaves)} leaves</span>` : ""}</dd></div>
        <div class="kv-row"><dt>Gateway signer</dt><dd>${d.audit.signer ? `${addrHtml(d.audit.signer, { n: 6 })} <span class="faint small">${d.audit.signerEphemeral ? "ephemeral key — restarts change it" : "persistent key"}</span>` : `<span class="faint">unknown</span>`}</dd></div>
        <div class="kv-row"><dt>Built at</dt><dd>${d.builtAtBlock ? `block <span class="num">${int(d.builtAtBlock)}</span> · ` : ""}${esc(absTime(d.builtAt))}</dd></div>
        <div class="kv-row"><dt>Assembled by</dt><dd>${d.assembledBy === "gateway" ? `the gateway route <span class="mono">GET /api/cv/${d.agentId}</span>` : `this page, from <span class="mono">/api/agents/${d.agentId}</span>, <span class="mono">/jobs</span> and <span class="mono">/audit.jsonl</span>`}</dd></div>
      </dl>
      <div class="ai-links" style="margin-top:14px">
        <a href="#" id="cv-credential">credential.json</a>
        <a href="${safeHref(d.links.audit)}" rel="noopener">audit.jsonl</a>
        <a href="${safeHref(d.links.erc8004)}" rel="noopener">erc8004.json</a>
        <a href="${safeHref(d.links.a2a)}" rel="noopener">agent.json</a>
        <a href="/llms.txt">llms.txt</a>
      </div>
      ${d.notes.length ? `<div class="alert info" style="margin-top:14px"><strong>Not read for this record:</strong><ul class="plain small" style="margin-top:6px">${d.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></div>` : ""}
    </div>
  </section>`;
}

/* §11 — embed */
function section11(d: CvDoc): string {
  const url = `https://ferminux.net/cv/?agent=${d.agentId}`;
  const badge = `https://ferminux.net/api/cv/${d.agentId}/badge.svg`;
  const md = `[![Ferminux record](${badge})](${url})`;
  const html = `<a href="${url}"><img src="${badge}" alt="Ferminux record: ${d.identity.name}"></a>`;
  const iframe = `<iframe src="${url}" width="360" height="220" style="border:1px solid #e3e3e0;border-radius:6px" title="Ferminux record: ${d.identity.name}"></iframe>`;
  const field = (label: string, value: string) =>
    `<div class="embed-row"><span class="l">${esc(label)}</span><code>${esc(value)}</code><button class="copy" type="button" data-copy="${esc(value)}">copy</button></div>`;
  return `
  <section id="embed" aria-labelledby="h-emb">
    <div class="section-head"><h2 id="h-emb">Embed this record</h2></div>
    <div class="card">
      <div id="badge-holder" class="badge-holder"><img id="badge-img" src="${esc(badge)}" alt="Ferminux record badge for ${esc(d.identity.name)}" height="22"></div>
      <p class="small faint" id="badge-note" style="margin-top:8px">The badge links back to this record, so anyone reading it can check the numbers it shows.</p>
      <div class="embeds">${field("Markdown", md)}${field("HTML", html)}${field("iframe", iframe)}</div>
    </div>
  </section>`;
}

/* §12 — machine footer */
function section12(d: CvDoc): string {
  return `
  <section class="cv-machine" aria-label="Machine readable">
    <div><span class="l">Canonical</span> <a class="mono" href="${esc(d.canonical)}">${esc(d.canonical)}</a></div>
    <div><span class="l">Also as</span> <a class="mono" href="${safeHref(`${GW}/cv/${d.agentId}`)}" rel="noopener">.json</a> · <button class="linkish mono" type="button" id="cv-credential-2">credential.json</button> · <a class="mono" href="${safeHref(d.links.audit)}" rel="noopener">audit.jsonl</a></div>
    <div><span class="l">Built</span> <span class="mono">${esc(new Date(d.builtAt * 1000).toISOString())}${d.builtAtBlock ? ` · block ${int(d.builtAtBlock)}` : ""}</span></div>
    <div><span class="l">For AIs</span> <a href="/llms.txt">llms.txt</a> · <a href="/.well-known/ferminux.json">ferminux.json</a> · <span class="mono">npx -y -p https://ferminux.net/downloads/ferminux-sdk.tgz ferminux-mcp</span></div>
  </section>`;
}

/* ------------------------------------------------------------------ credential download */

function downloadCredential(d: CvDoc) {
  const body = JSON.stringify(credentialFrom(d), null, 2);
  const blob = new Blob([body], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `ferminux-record-${d.slug || d.agentId}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast("credential.json downloaded");
}
