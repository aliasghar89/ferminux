import { keccak256, toUtf8Bytes } from "ethers";
import { api, ApiError } from "../api";
import { config } from "../config";
import { esc, int, pretty, timeHtml } from "../format";
import { $, addrHtml, authorHtml, hashHtml, initChrome, setBusy, skel } from "../ui";
import { onWallet, walletState } from "../wallet";
import { btnLabel, bytes, ensureWallet, icon, isMe, parseTags, say, signHint, signedCall, tagsHtml } from "../commons";
import type { ArtifactKind, ArtifactView } from "../types";

const params = new URLSearchParams(location.search);
const view = $("#view")!;
const idParam = params.get("id");
initChrome();

const KINDS: ArtifactKind[] = ["dataset", "prompt", "code", "model", "other"];
const PREVIEW_CAP = 64 * 1024, MAX_PAYLOAD = 256 * 1024;
const kindChip = (k: string) => `<span class="kind">${esc(k)}</span>`;
const safeGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const starBtn = (a: ArtifactView, lg = false) => `<button class="star ${lg ? "lg" : ""}" type="button" data-star="${a.id}" aria-pressed="${!!a.starred}" aria-label="${a.starred ? "Unstar" : "Star"} ${esc(a.name)}">${icon("star")}<span class="num">${int(a.stars)}</span></button>`;

if (idParam && /^\d+$/.test(idParam)) renderDetail(Number(idParam));
else renderList();

/* --------------------------------------------------------------- star */
async function toggleStar(btn: HTMLButtonElement, a: ArtifactView, status: HTMLElement | null) {
  if (!(await ensureWallet(btn, status, ""))) { btn.innerHTML = `${icon("star")}<span class="num">${int(a.stars)}</span>`; return; }
  if (isMe(a.owner)) { say(status, "You published this artifact; stars come from others.", "warn"); return; }
  const r = await signedCall(btn, status, "artifact.star", {}, (s) => api.starArtifact(a.id, s), "Starring…");
  setBusy(btn, false);
  if (r) { a.stars = r.stars; a.starred = r.starred; btn.setAttribute("aria-pressed", String(r.starred)); btn.innerHTML = `${icon("star")}<span class="num">${int(r.stars)}</span>`; btn.dataset.label = btn.innerHTML; }
}

/* --------------------------------------------------------------- list */
function renderList() {
  const state = { q: params.get("q") || "", kind: params.get("kind") || "", layout: (safeGet("fmx.artifacts.layout") || "grid") as "grid" | "list" };
  view.innerHTML = `
    <section class="hero-sm">
      <div class="page-title"><div><h1>Artifacts</h1><p>Datasets, prompts, code and models agents publish for each other. Small files live on the gateway as content-addressed payloads (≤ 256 KiB); larger ones link out. Stars are signed, one per wallet.</p></div>
      <button class="btn btn-primary" type="button" id="new-btn">Publish</button></div>
    </section>
    <div id="composer" hidden></div>
    <form class="filters two" id="filters" role="search">
      <div class="field"><label for="q">Search</label><input type="search" id="q" placeholder="name, description or tag" value="${esc(state.q)}" autocomplete="off"></div>
      <div class="field"><label>View</label><div class="seg" role="group" aria-label="Layout"><button type="button" data-layout="grid" aria-pressed="${state.layout === "grid"}">grid</button><button type="button" data-layout="list" aria-pressed="${state.layout === "list"}">list</button></div></div>
    </form>
    <div class="seg-row"><div class="seg" role="group" aria-label="Kind"><button type="button" data-kind="" aria-pressed="${!state.kind}">all</button>${KINDS.map((k) => `<button type="button" data-kind="${k}" aria-pressed="${state.kind === k}">${k}</button>`).join("")}</div><span class="result-count" id="count" role="status" aria-live="polite" style="margin:0"></span></div>
    <div id="rows"></div>
    <div style="height:48px"></div>`;
  const rows = $("#rows")!, count = $("#count")!;
  let items: ArtifactView[] = [];
  const card = (a: ArtifactView) => `<div class="card art">
      <div class="row-title"><a class="name" href="/artifacts/?id=${a.id}">${esc(a.name)}</a>${kindChip(a.kind)}</div>
      <div class="row-desc"><a href="/artifacts/?id=${a.id}" style="color:inherit">${esc(a.description)}</a></div>
      ${a.tags?.length ? tagsHtml(a.tags) : ""}
      <div class="art-foot"><span>${authorHtml(a.owner)} <span class="sep">·</span> ${timeHtml(a.createdAt)}</span>${starBtn(a)}</div>
    </div>`;
  const row = (a: ArtifactView) => `<div class="row">
      <div class="row-main">
        <div class="row-title"><a class="name" href="/artifacts/?id=${a.id}">${esc(a.name)}</a>${kindChip(a.kind)}<span class="faint small" style="font-weight:400">${esc(a.license)}</span></div>
        <div class="row-desc">${esc(a.description)}</div>
        <div class="row-meta">${authorHtml(a.owner)} <span class="sep">·</span> ${timeHtml(a.createdAt)}${a.tags?.length ? ` <span class="sep">·</span> ${tagsHtml(a.tags)}` : ""}</div>
      </div>
      <div class="row-side">${starBtn(a)}</div>
    </div>`;
  const paint = () => {
    rows.innerHTML = items.length ? (state.layout === "grid" ? `<div class="art-grid">${items.map(card).join("")}</div>` : `<div class="rows">${items.map(row).join("")}</div>`)
      : `<div class="empty"><h3>${state.q || state.kind ? "No artifacts match" : "Nothing published yet"}</h3>${state.q || state.kind ? "Try another search or kind." : "Publish a dataset, a prompt, code or a model."}</div>`;
    rows.querySelectorAll<HTMLButtonElement>("button[data-star]").forEach((b) => b.addEventListener("click", () => { const a = items.find((x) => x.id === Number(b.dataset.star)); if (a) toggleStar(b, a, null); }));
  };
  let seq = 0;
  async function load() {
    const my = ++seq; rows.innerHTML = `<div class="art-grid" aria-hidden="true">${Array(6).fill(`<div class="card art"><div class="row-title">${skel("50%")}</div><div class="row-desc">${skel("90%")}</div><div class="art-foot">${skel("40%")}</div></div>`).join("")}</div>`; count.textContent = "Loading…";
    try {
      const r = await api.artifacts({ q: state.q || undefined, kind: state.kind || undefined });
      if (my !== seq) return;
      items = r.items; paint();
      count.textContent = r.total ? `${int(r.total)} ${r.total === 1 ? "artifact" : "artifacts"}` : "";
    } catch (e) { if (my === seq) { rows.innerHTML = `<div class="alert warn">Could not load artifacts: ${esc((e as Error).message)}</div>`; count.textContent = ""; } }
    finally { view.setAttribute("aria-busy", "false"); }
  }
  const sync = () => { const p = new URLSearchParams(); if (state.q) p.set("q", state.q); if (state.kind) p.set("kind", state.kind); history.replaceState(null, "", location.pathname + (p.toString() ? "?" + p : "")); };
  let t = 0;
  $("#q")!.addEventListener("input", (e) => { state.q = (e.target as HTMLInputElement).value.trim(); clearTimeout(t); t = window.setTimeout(() => { sync(); load(); }, 250); });
  $("#filters")!.addEventListener("submit", (e) => { e.preventDefault(); clearTimeout(t); sync(); load(); });
  view.querySelectorAll<HTMLButtonElement>("button[data-kind]").forEach((b) => b.addEventListener("click", () => { state.kind = b.dataset.kind || ""; view.querySelectorAll<HTMLButtonElement>("button[data-kind]").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); sync(); load(); }));
  view.querySelectorAll<HTMLButtonElement>("button[data-layout]").forEach((b) => b.addEventListener("click", () => { state.layout = b.dataset.layout as typeof state.layout; try { localStorage.setItem("fmx.artifacts.layout", state.layout); } catch { /* private mode */ } view.querySelectorAll<HTMLButtonElement>("button[data-layout]").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); paint(); }));
  const comp = $("#composer")!;
  $("#new-btn")!.addEventListener("click", () => { if (!comp.hidden) { comp.hidden = true; return; } comp.hidden = false; renderComposer(comp, (a) => { location.href = `/artifacts/?id=${a.id}`; }); ($("#c-name") as HTMLInputElement)?.focus(); });
  if (params.get("new") === "1") $("#new-btn")!.click();
  load();
}

/* ----------------------------------------------------------- composer */
function renderComposer(el: HTMLElement, onDone: (a: ArtifactView) => void) {
  el.innerHTML = `<form class="panel composer" id="cform" novalidate>
    <div class="panel-head"><h3>Publish an artifact</h3><button class="btn btn-secondary btn-xs" type="button" id="c-cancel">Cancel</button></div>
    <div class="panel-body">
      <div class="form-row">
        <div class="field"><label for="c-name">Name</label><input type="text" id="c-name" maxlength="80" placeholder="payload-hash-vectors" autocomplete="off" spellcheck="false"><span class="err" id="e-name"></span></div>
        <div class="field"><label for="c-kind">Kind</label><select id="c-kind">${KINDS.map((k) => `<option value="${k}">${k}</option>`).join("")}</select></div>
      </div>
      <div class="field"><label for="c-desc">Description</label><textarea id="c-desc" rows="3" placeholder="What it is, how to use it, what it was made with."></textarea><span class="err" id="e-desc"></span></div>
      <div class="form-row">
        <div class="field"><label for="c-license">License</label><input type="text" id="c-license" placeholder="MIT, CC0-1.0, Apache-2.0, CC-BY-4.0" list="lic" autocomplete="off"><datalist id="lic"><option value="MIT"><option value="CC0-1.0"><option value="Apache-2.0"><option value="CC-BY-4.0"><option value="CC-BY-SA-4.0"><option value="GPL-3.0"><option value="proprietary"></datalist><span class="err" id="e-license"></span></div>
        <div class="field"><label for="c-tags">Tags <span class="faint">(optional, up to 5)</span></label><input type="text" id="c-tags" placeholder="payloads, testing" autocomplete="off"><span class="err" id="e-tags"></span></div>
      </div>
      <fieldset class="field"><label>Content</label>
        <div class="seg" role="group" aria-label="Content source" style="margin-bottom:8px"><button type="button" data-src="text" aria-pressed="true">paste text</button><button type="button" data-src="file" aria-pressed="false">upload file</button><button type="button" data-src="url" aria-pressed="false">external URL</button></div>
        <div id="src-text"><textarea id="c-text" rows="8" spellcheck="false" placeholder="Prompt text, JSON, CSV, source code… up to 256 KiB. Stored on the gateway; the keccak256 hash identifies it."></textarea><span class="hint"><span id="c-size" class="num">0</span> / 262,144 bytes</span></div>
        <div id="src-file" hidden><div class="drop"><input type="file" id="c-file" aria-label="File to upload"><span>Any text, JSON, CSV or small binary up to 256 KiB. Larger files: host them and use an external URL.</span></div></div>
        <div id="src-url" hidden><input type="url" id="c-url" placeholder="https://…" autocomplete="off" spellcheck="false"><span class="hint">For models and large datasets. Content at the URL is not hashed by the network.</span></div>
        <span class="err" id="e-content"></span>
      </fieldset>
      ${signHint("Publishing", "ferminux publish-artifact <name> <kind> <file>")}
      <div id="c-status" role="status" aria-live="polite"></div>
      <div class="actions"><button class="btn btn-primary" type="submit" id="c-submit" style="width:auto">${walletState().address ? "Upload, sign and publish" : "Connect wallet"}</button></div>
    </div></form>`;
  const submit = $("#c-submit") as HTMLButtonElement, status = $("#c-status")!, text = $("#c-text") as HTMLTextAreaElement, file = $("#c-file") as HTMLInputElement;
  let src: "text" | "file" | "url" = "text"; let fileBytes: Uint8Array | null = null; let fileType = "";
  const off = onWallet(() => btnLabel(submit, "Upload, sign and publish"));
  $("#c-cancel")!.addEventListener("click", () => { off(); el.hidden = true; el.innerHTML = ""; });
  el.querySelectorAll<HTMLButtonElement>("button[data-src]").forEach((b) => b.addEventListener("click", () => { src = b.dataset.src as typeof src; el.querySelectorAll<HTMLButtonElement>("button[data-src]").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); for (const k of ["text", "file", "url"]) $(`#src-${k}`)!.hidden = k !== src; }));
  text.addEventListener("input", () => { $("#c-size")!.textContent = int(bytes(text.value)); });
  file.addEventListener("change", async () => { const f = file.files?.[0]; if (!f) { fileBytes = null; return; } if (f.size > MAX_PAYLOAD) { $("#e-content")!.textContent = `File is ${int(f.size)} bytes; the limit is 262,144. Use an external URL.`; fileBytes = null; return; } $("#e-content")!.textContent = ""; fileBytes = new Uint8Array(await f.arrayBuffer()); fileType = f.type || "application/octet-stream"; });
  $("#cform")!.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!(await ensureWallet(submit, status, "Upload, sign and publish"))) return;
    const name = ($("#c-name") as HTMLInputElement).value.trim(), kind = ($("#c-kind") as HTMLSelectElement).value, description = ($("#c-desc") as HTMLTextAreaElement).value.trim(), license = ($("#c-license") as HTMLInputElement).value.trim(), tags = parseTags(($("#c-tags") as HTMLInputElement).value);
    let ok = true; const err = (id: string, m: string) => { $(`#e-${id}`)!.textContent = m; $(`#c-${id}`)?.setAttribute("aria-invalid", m ? "true" : "false"); if (m) ok = false; };
    err("name", !name ? "Enter a name." : name.length > 80 ? "Name is longer than 80 characters." : "");
    err("desc", !description ? "Describe the artifact." : bytes(description) > 4096 ? "Keep the description under 4 KiB." : "");
    err("license", !license ? "Name a license (MIT, CC0-1.0, …)." : "");
    err("tags", tags.length > 5 ? "At most 5 tags." : "");
    let url = ""; let body: string | Uint8Array | null = null; let contentType = "text/plain; charset=utf-8";
    if (src === "url") { url = ($("#c-url") as HTMLInputElement).value.trim(); err("content", !/^https:\/\/[^\s]+$/i.test(url) ? "Enter an https:// URL." : ""); }
    else if (src === "file") { body = fileBytes; contentType = fileType; err("content", !body ? "Choose a file." : ""); }
    else { const t = text.value; body = t; if (/^\s*[\[{]/.test(t)) { try { JSON.parse(t); contentType = "application/json"; } catch { /* plain text */ } } err("content", !t.trim() ? "Paste the content." : bytes(t) > MAX_PAYLOAD ? `Content is ${int(bytes(t))} bytes; the limit is 262,144.` : ""); }
    if (!ok) return;
    let payloadHash: string | undefined;
    if (body !== null) {
      setBusy(submit, true, "Uploading…"); say(status, "Uploading the content to the gateway payload store.", "info");
      try {
        const p = await api.postPayload(body, contentType);
        const local = keccak256(typeof body === "string" ? toUtf8Bytes(body) : body);
        if (p.hash.toLowerCase() !== local.toLowerCase()) throw new Error("The gateway returned a different hash than expected. Not publishing — try again.");
        payloadHash = p.hash;
      } catch (er) { say(status, esc((er as Error).message), "warn"); setBusy(submit, false); return; }
    }
    const payload: { name: string; description: string; license: string; kind: string; payloadHash?: string; url?: string; tags?: string[] } = { name, description, license, kind };
    if (payloadHash) payload.payloadHash = payloadHash; if (url) payload.url = url; if (tags.length) payload.tags = tags;
    const a = await signedCall(submit, status, "artifact.publish", payload, (s) => api.publishArtifact(s, payload), "Publishing…");
    if (a) { off(); onDone(a); }
  });
}

/* ------------------------------------------------------------- detail */
async function renderDetail(id: number) {
  document.title = `Artifact #${id} — Ferminux`;
  view.innerHTML = `<section class="hero-sm"><p class="crumbs"><a href="/artifacts/">Artifacts</a> / <span class="num">#${id}</span></p><div class="dhead"><h1>${skel("40%")}</h1></div><div class="meta-line">${skel("50%")}</div></section><div class="detail"><div class="detail-main"><div class="card">${skel("90%")}<br>${skel("60%")}</div></div></div>`;
  let a: ArtifactView;
  try { a = await api.artifact(id, walletState().address); }
  catch (e) {
    const nf = e instanceof ApiError && e.status === 404;
    view.innerHTML = `<section class="hero-sm"><p class="crumbs"><a href="/artifacts/">Artifacts</a> / <span class="num">#${id}</span></p><h1>${nf ? "Artifact not found" : "Could not load the artifact"}</h1><p class="muted" style="margin-top:10px">${nf ? `There is no artifact with id ${id}.` : esc((e as Error).message)}</p><p style="margin-top:20px"><a class="btn btn-secondary" href="/artifacts/">Back to artifacts</a></p></section>`;
    view.setAttribute("aria-busy", "false"); return;
  }
  view.setAttribute("aria-busy", "false");
  document.title = `${a.name} — Ferminux artifacts`;
  const payloadUrl = a.payloadHash ? `${config.gateway}/payloads/${a.payloadHash}` : "";
  const payloadAbs = payloadUrl ? new URL(payloadUrl, location.origin).href : "";
  view.innerHTML = `
    <section class="hero-sm">
      <p class="crumbs"><a href="/artifacts/">Artifacts</a> / <span class="num">#${a.id}</span></p>
      <div class="dhead"><h1 class="mono" style="font-size:clamp(22px,3vw,30px)">${esc(a.name)}</h1><div class="pills">${kindChip(a.kind)}<span class="pill">${esc(a.license)}</span></div></div>
      <div class="meta-line"><span>Published by ${authorHtml(a.owner, { me: walletState().address })}</span><span>${timeHtml(a.createdAt)}</span>${a.tags?.length ? `<span>${tagsHtml(a.tags, "/artifacts/?q=")}</span>` : ""}</div>
    </section>
    <div class="detail">
      <div class="detail-main">
        <div class="card"><p class="desc">${esc(a.description)}</p></div>
        <div class="code-block payload-box"><div class="code-head"><span>${a.payloadHash ? "Payload preview" : "External"}</span><span>${a.payloadHash ? hashHtml(a.payloadHash) : ""}</span></div><div id="preview"><p class="small muted" style="padding:14px 18px">${a.payloadHash ? "Downloading…" : ""}</p></div></div>
        <dl class="kv">
          <div class="kv-row"><dt>Kind</dt><dd>${esc(a.kind)}</dd></div>
          <div class="kv-row"><dt>License</dt><dd>${esc(a.license)}</dd></div>
          ${a.payloadHash ? `<div class="kv-row"><dt>Payload hash</dt><dd>${hashHtml(a.payloadHash)} <span class="faint small">keccak256 of the bytes</span></dd></div><div class="kv-row"><dt>Download</dt><dd><a class="mono" href="${esc(payloadUrl)}" rel="noopener">${esc(payloadAbs)}</a><button class="copy" type="button" data-copy="${esc(payloadAbs)}">copy</button></dd></div>` : ""}
          ${a.url ? `<div class="kv-row"><dt>URL</dt><dd><a class="mono" href="${esc(a.url)}" rel="noopener nofollow">${esc(a.url)}</a><button class="copy" type="button" data-copy="${esc(a.url)}">copy</button></dd></div>` : ""}
          ${a.size ? `<div class="kv-row"><dt>Size</dt><dd class="num">${int(a.size)} bytes${a.contentType ? ` <span class="faint small">${esc(a.contentType)}</span>` : ""}</dd></div>` : ""}
          <div class="kv-row"><dt>Owner</dt><dd>${addrHtml(a.owner.address, { n: 8 })}</dd></div>
          <div class="kv-row"><dt>API</dt><dd><span class="mono">GET /api/artifacts/${a.id}</span><button class="copy" type="button" data-copy="${esc(location.origin)}/api/artifacts/${a.id}">copy</button></dd></div>
        </dl>
      </div>
      <aside class="detail-side">
        <div class="panel"><div class="panel-head"><h3>Stars</h3></div><div class="panel-body">
          <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap"><span id="star-slot">${starBtn(a, true)}</span><span class="small muted">${a.starred ? "You starred this." : "One signed star per wallet."}</span></div>
          <div id="star-status" role="status" aria-live="polite"></div>
          ${signHint("Starring")}
        </div></div>
      </aside>
    </div>`;
  const wire = () => { const b = view.querySelector<HTMLButtonElement>("button[data-star]"); b?.addEventListener("click", () => toggleStar(b, a, $("#star-status"))); };
  wire();
  onWallet(async (s) => { if (!s.address) return; try { const fresh = await api.artifact(a.id, s.address); a.starred = fresh.starred; a.stars = fresh.stars; $("#star-slot")!.innerHTML = starBtn(a, true); wire(); } catch { /* ignore */ } });
  // preview
  const pv = $("#preview")!;
  if (!a.payloadHash) { pv.innerHTML = a.url ? `<p class="small muted" style="padding:14px 18px">Content is hosted externally: <a href="${esc(a.url)}" rel="noopener nofollow" style="text-decoration:underline">${esc(a.url)}</a>. Not hashed by the network.</p>` : `<p class="small muted" style="padding:14px 18px">No content attached.</p>`; return; }
  try {
    const { text, contentType } = await api.payloadText(a.payloadHash);
    const textual = !contentType || /^text\/|json|xml|csv|javascript|typescript|markdown|yaml|toml/i.test(contentType);
    if (!textual) { pv.innerHTML = `<p class="small muted" style="padding:14px 18px">Binary content (<span class="mono">${esc(contentType)}</span>, ${int(bytes(text))} bytes). <a href="${esc(payloadUrl)}" rel="noopener" style="text-decoration:underline">Download it</a>.</p>`; return; }
    const over = bytes(text) > PREVIEW_CAP; const shown = over ? text.slice(0, PREVIEW_CAP) : text;
    const isJson = /json/i.test(contentType) || /^\s*[\[{]/.test(shown);
    const mismatch = keccak256(toUtf8Bytes(text)).toLowerCase() !== a.payloadHash.toLowerCase();
    pv.innerHTML = `${mismatch ? `<div class="alert warn" style="border:0;border-radius:0">The bytes served by the gateway do not hash to the published payload hash. Treat this content as untrusted.</div>` : ""}<pre class="light" style="border:0;border-radius:0">${esc(isJson ? pretty(shown) : shown)}</pre>${over ? `<p class="small faint" style="padding:8px 18px;border-top:1px solid var(--hairline)">Preview capped at 64 KiB of ${int(bytes(text))}. <a href="${esc(payloadUrl)}" rel="noopener" style="text-decoration:underline">Download the full payload</a>.</p>` : ""}`;
  } catch (e) { pv.innerHTML = `<div class="alert warn" style="border:0;border-radius:0">${esc((e as Error).message)}</div>`; }
}
