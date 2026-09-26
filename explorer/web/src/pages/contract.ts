/* The Contract tab (surfaces/explorer.md §5.7), used by the address page (and open to the token page's
   `?tab=contract`). Sections, in order:
     status line   VERIFIED (the index verified it) · MATCHES BUILD (eth_getCode hashed in the browser equals the
                   Ferminux repository build) · NOT VERIFIED (unknown, or the deployed code differs: then no source)
     proxy line    EIP-1167 clones and index-reported proxies: "Proxy → implementation", reads use its ABI
     Read          zero-argument view functions in ONE eth_call batch at one block; the rest as forms
     Write         none: one line (the explorer is read-only)
     Source        file list, line numbers, a light highlighter, copy file, download all (.zip)
     ABI           the JSON, collapsed, with copy
     Bytecode      deployed and creation, collapsed
     Verify        the Foundry line with this address, and the link to the verify page
   The ABI and the sources come from src/pages/address/book (built from the repo's Foundry artifacts). */
import { html, mount, dash, type Html } from "../ui/html";
import { addrChip } from "../ui/hash";
import { prov } from "../ui/marks";
import { copyBtn, toast } from "../ui/copy";
import { icon } from "../ui/icons";
import { sk, skLine } from "../ui/skeleton";
import { note, showError } from "../ui/state";
import { int, byteLen } from "../format";
import { api, ApiError } from "../api";
import { rpc, RPC_DOWN, RpcError } from "../rpc";
import { currentHead } from "../head";
import { knownContract } from "../known";
import { isAbort } from "../util";
import type { Address, SmartContract } from "../types";
import { bookData, templateData, codeMatches, cloneTarget, ethers, FRC20, FRC721, type AbiItem, type AbiParam, type BookData } from "./address/abi";
import { valueHtml, valueText, type Unit } from "./address/values";
import { highlight } from "./address/highlight";

export interface ContractOpts {
  a: string;
  addr: Address | null;
  /** eth_getCode, shared with the page (null = the RPC failed). */
  code: Promise<string | null>;
  signal: AbortSignal;
  /** The gateway lists this address as an agent token (a factory-made AgentToken). */
  agentToken?: boolean | Promise<boolean>;
}

type Status = { kind: "verified" | "matches" | "differs" | "unknown" };
interface Resolved {
  status: Status;
  /** Where reads and the ABI come from. */
  abi: AbiItem[] | null;
  abiFrom: "index" | "repo" | "generic20" | "generic721" | null;
  book: BookData | null;
  /** Implementation for a proxy (reads go to the proxy with the implementation's ABI). */
  impl: { address: string; kind: string; book: BookData | null; matches: boolean | null } | null;
  sc: SmartContract | null;
  scErr: unknown;
  code: string | null;
}

/* ---------------------------------------------------------------- resolve */

async function resolveAll(o: ContractOpts): Promise<Resolved> {
  const s = o.signal;
  const [code, sc, own] = await Promise.all([
    o.code,
    api.smartContract(o.a, { signal: s }).then((v) => ({ v, e: null as unknown }), (e) => { if (isAbort(e)) throw e; return { v: null, e }; }),
    bookData(o.a).then(async (b) => b ?? ((await o.agentToken) ? templateData("agenttoken") : null)).catch(() => null),
  ]);
  // proxies: an EIP-1167 clone (read from the code), or the index's implementations when it names a real proxy type
  let impl: Resolved["impl"] = null;
  const clone = cloneTarget(code);
  const scImpl = sc.v?.proxy_type && sc.v.proxy_type !== "unknown" ? sc.v.implementations?.[0] : undefined;
  const implAddr = clone ?? scImpl?.address_hash ?? scImpl?.address ?? null;
  if (implAddr) {
    const ib = await bookData(implAddr).catch(() => null);
    let matches: boolean | null = null;
    if (ib) { const ic = await rpc.code(implAddr, s).catch(() => null); matches = ic ? await codeMatches(ib, ic).catch(() => false) : null; }
    impl = { address: implAddr, kind: clone ? "EIP-1167 minimal proxy" : (sc.v?.proxy_type ?? "proxy"), book: ib, matches };
  }
  const verified = !!(sc.v?.is_verified || o.addr?.is_verified);
  let status: Status = { kind: "unknown" };
  if (verified) status = { kind: "verified" };
  else if (own && code) status = { kind: (await codeMatches(own, code).catch(() => false)) ? "matches" : "differs" };
  let abi: AbiItem[] | null = null, abiFrom: Resolved["abiFrom"] = null;
  if (verified && Array.isArray(sc.v?.abi)) { abi = sc.v!.abi as AbiItem[]; abiFrom = "index"; }
  else if (impl?.book) { abi = impl.book.abi; abiFrom = "repo"; }
  else if (own) { abi = own.abi; abiFrom = "repo"; }
  else if (o.addr?.token?.type === "FRC-721") { abiFrom = "generic721"; }
  else if (o.addr?.token?.type === "FRC-20") { abiFrom = "generic20"; }
  return { status, abi, abiFrom, book: own, impl, sc: sc.v, scErr: sc.e, code };
}

/** The source state for the address head (§5.6 "source status"): the same checks the tab runs, shared caches. */
export async function sourceState(o: ContractOpts): Promise<"verified" | "matches" | "differs" | "unknown"> {
  const r = await resolveAll(o);
  if (r.status.kind !== "unknown") return r.status.kind;
  return r.impl?.matches ? "matches" : "unknown";
}

/** Human-readable fragments → JSON ABI items (the generic sets). */
async function genericAbi(kind: "generic20" | "generic721"): Promise<AbiItem[]> {
  const { Interface } = await ethers();
  return JSON.parse(new Interface(kind === "generic20" ? FRC20 : FRC721).formatJson()) as AbiItem[];
}

/** The file that declares the contract (`contract Name` as a word, so AgentToken ≠ AgentTokenFactory). */
const mainFile = (b: BookData) => { const re = new RegExp(`\\bcontract\\s+${b.contract}\\b`); return Object.keys(b.sources).find((p) => re.test(b.sources[p])); };

/* ---------------------------------------------------------------- render */

const secHead = (id: string, title: string, extra: Html | string = "") => html`<div class="ct-h"><h3 id="${id}">${title}</h3>${extra}</div>`;

export function renderContract(host: HTMLElement, o: ContractOpts) {
  mount(host, html`<div class="adx"><div class="ct skel" aria-busy="true">${skLine("50%")}${skLine("80%")}<div class="ct-read">${sk("100%", "120px")}</div></div></div>`);
  resolveAll(o).then(async (r) => {
    if (o.signal.aborted) return;
    if (r.abiFrom === "generic20" || r.abiFrom === "generic721") r.abi = await genericAbi(r.abiFrom).catch(() => null);
    if (o.signal.aborted) return;
    paint(host, o, r);
  }, (e) => showError(host, e, () => renderContract(host, o)));
}

function statusLine(o: ContractOpts, r: Resolved): Html {
  const k = r.status.kind;
  const bookName = knownContract(o.a)?.name ?? r.book?.name;
  if (k === "verified") return html`<div class="ct-status">${prov("verified")}<span>Source verified on this explorer${r.sc?.compiler_version ? html` <span class="faint">(${r.sc.compiler_version})</span>` : ""}.</span></div>`;
  if (k === "matches" && r.book?.template) return html`<div class="ct-status">${prov("matches")}<span>An agent token launched by AgentTokenFactory. Its deployed bytecode matches the repository's ${r.book.contract} build (<span class="mono">${r.book.project}/${mainFile(r.book) ?? ""}</span>), apart from the values each launch sets, checked in your browser just now.</span></div>`;
  if (k === "matches") return html`<div class="ct-status">${prov("matches")}<span>Source from the Ferminux repository${bookName ? html` (<span class="mono">${r.book!.project}/${mainFile(r.book!) ?? ""}</span>)` : ""}. The deployed bytecode matches this build, checked in your browser just now.</span></div>`;
  if (k === "differs") return html`<div class="ct-status">${prov("unverified")}<span>The deployed bytecode differs from the repository build of ${r.book!.contract}, so no source is shown. The read panel below uses the ABI from the Ferminux repository.</span></div>`;
  if (r.impl && r.impl.kind === "EIP-1167 minimal proxy" && r.impl.matches && r.impl.book)
    return html`<div class="ct-status">${prov("matches")}<span>A standard EIP-1167 minimal proxy (${int(byteLen(r.code))} bytes) that forwards every call to ${r.impl.book.contract}, whose deployed bytecode matches the Ferminux repository build, checked in your browser just now. The source below is ${r.impl.book.contract}'s.</span></div>`;
  if (r.impl) return html`<div class="ct-status">${prov("unverified")}<span>This proxy's own code is not verified. Calls run the implementation's code, described below.</span></div>`;
  return html`<div class="ct-status">${prov("unverified")}<span>Source not verified. Bytecode only.</span></div>`;
}

function proxyLine(r: Resolved): Html {
  if (!r.impl) return html``;
  const i = r.impl;
  const m = i.matches === true ? prov("matches") : i.matches === false ? prov("unverified") : "";
  return html`<div class="ct-proxy"><span class="kind">Proxy</span> <span class="faint">${i.kind} →</span> ${addrChip(i.address)} ${m}<span class="faint">${i.book ? `Reads use ${i.book.contract}'s ABI from the Ferminux repository.` : "The implementation's ABI isn't known here."}</span></div>`;
}

function paint(host: HTMLElement, o: ContractOpts, r: Resolved) {
  const src = r.status.kind === "verified" ? verifiedSources(r.sc) : r.status.kind === "matches" ? r.book?.sources ?? null : r.impl?.matches ? r.impl.book?.sources ?? null : null;
  const srcBook = r.status.kind === "matches" ? r.book : r.impl?.matches ? r.impl.book : null;
  const abiLabel = r.abiFrom === "index" ? "ABI from the verified source" : r.abiFrom === "repo" ? "ABI from the Ferminux repository" : r.abiFrom ? `Standard ${r.abiFrom === "generic20" ? "FRC-20" : "FRC-721"} read functions` : null;
  mount(host, html`<div class="adx"><div class="ct">
    <h3 class="vh" tabindex="-1">Contract</h3>
    ${statusLine(o, r)}
    ${proxyLine(r)}
    <section class="ct-sec" aria-labelledby="ct-read-h">${secHead("ct-read-h", "Read contract", abiLabel ? html`<span class="faint small">${abiLabel}</span>` : "")}<div data-read>${r.abi ? html`<div class="skel">${sk("100%", "96px")}</div>` : note("No ABI for this contract, so there is nothing to read here. Verify its source to add one.")}</div></section>
    <section class="ct-sec" aria-labelledby="ct-write-h">${secHead("ct-write-h", "Write")}<p class="muted">This explorer is read-only. To send a transaction, use <a class="link-inline" href="https://ferminux.net" data-external rel="noopener">ferminux.net</a> or your wallet.</p></section>
    ${src ? html`<section class="ct-sec" aria-labelledby="ct-src-h" data-src>${secHead("ct-src-h", "Source", srcBook ? html`<span class="faint small mono">solc ${srcBook.compiler.solc.replace(/\+commit.*$/, "")} · optimizer ${srcBook.compiler.optimizer ? `${srcBook.compiler.runs} runs` : "off"}${srcBook.compiler.evm ? ` · EVM ${srcBook.compiler.evm}` : ""}</span>` : r.sc?.compiler_version ? html`<span class="faint small mono">${r.sc.compiler_version}</span>` : "")}</section>` : ""}
    ${r.abi ? html`<section class="ct-sec" aria-labelledby="ct-abi-h">${secHead("ct-abi-h", "ABI")}${codeBlock(`ABI · ${r.abi.length} entries`, JSON.stringify(r.abi, null, 2), "Copy ABI")}</section>` : ""}
    <section class="ct-sec" aria-labelledby="ct-bc-h">${secHead("ct-bc-h", "Bytecode")}${bytecode(r)}</section>
    ${r.status.kind !== "verified" ? verifyBlock(o, r) : ""}
  </div></div>`);
  if (src) sourceView(host.querySelector<HTMLElement>("[data-src]")!, src, srcBook?.contract ?? null);
  if (r.abi) readPanel(host.querySelector<HTMLElement>("[data-read]")!, o, r.abi);
}

function verifiedSources(sc: SmartContract | null): Record<string, string> | null {
  if (!sc?.source_code) return null;
  const x = sc as SmartContract & { file_path?: string; name?: string; additional_sources?: { file_path: string; source_code: string }[] };
  const out: Record<string, string> = { [x.file_path || `${x.name ?? "Contract"}.sol`]: sc.source_code };
  for (const f of x.additional_sources ?? []) out[f.file_path] = f.source_code;
  return out;
}

/** A collapsed code block with a head (title, size, copy). */
function codeBlock(title: string, text: string, what: string, open = false): Html {
  return html`<details class="code-block ct-code"${open ? " open" : ""}><summary class="code-head"><span>${title}</span>${copyBtn(text, what)}</summary><pre><code>${text}</code></pre></details>`;
}

function bytecode(r: Resolved): Html {
  const dep = r.sc?.deployed_bytecode ?? r.code;
  const cre = r.sc?.creation_bytecode ?? null;
  if (!dep && !cre) return r.scErr instanceof ApiError || r.code === null ? html`<p>${dash(r.code === null ? RPC_DOWN : "Not reported by the index")}</p>` : html`<p class="muted">No code at this address.</p>`;
  return html`<div class="ct-bcs">${dep ? codeBlock(`Deployed bytecode (${int(byteLen(dep))} bytes)`, dep, "Copy deployed bytecode") : ""}${cre ? codeBlock(`Creation bytecode (${int(byteLen(cre))} bytes)`, cre, "Copy creation bytecode") : ""}</div>`;
}

function verifyBlock(o: ContractOpts, r: Resolved): Html {
  const b = r.book;
  const path = b ? mainFile(b) ?? `src/${b.contract}.sol` : "src/MyContract.sol";
  const cmd = `forge verify-contract --chain 3961 --verifier etherscan --verifier-url https://explorer.ferminux.net/api/ --etherscan-api-key ferminux ${o.a} ${path}:${b?.contract ?? "MyContract"}`;
  return html`<section class="ct-sec" aria-labelledby="ct-ver-h">${secHead("ct-ver-h", "Verify this contract")}
    <p class="muted">${r.status.kind === "matches" ? "The source above is matched in your browser. To have the explorer's index verify it too, submit it from the Foundry project:" : "Verify the source with the explorer's index from your Foundry project. Any API key is accepted."}</p>
    <div class="code-block ct-cmd"><div class="code-head"><span>Foundry${b ? html` · in <span class="mono">${b.project}</span>` : ""}</span>${copyBtn(cmd, "Copy the Foundry command")}</div><pre><code>${cmd}</code></pre></div>
    <p><a class="link-arrow" href="/address/${o.a}/contract-verification">How to verify a contract ${icon("i-arrow")}</a></p>
  </section>`;
}

/* ---------------------------------------------------------------- source view */

function sourceView(sec: HTMLElement, files: Record<string, string>, main: string | null) {
  const paths = Object.keys(files).sort((x, y) => {
    const decl = main ? new RegExp(`\\bcontract\\s+${main}\\b`) : null;
    const mx = decl?.test(files[x]) ? 0 : 1, my = decl?.test(files[y]) ? 0 : 1;
    return mx - my || x.localeCompare(y);
  });
  let cur = paths[0];
  sec.insertAdjacentHTML("beforeend", html`<div class="srcv">
    <nav class="srcv-files" aria-label="Source files"><ul>${paths.map((p) => html`<li><button type="button" data-file="${p}" aria-current="${String(p === cur)}">${p.split("/").pop()}<span class="faint">${p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ""}</span></button></li>`)}</ul></nav>
    <div class="srcv-main">
      <div class="code-head srcv-head">
        <label class="srcv-sel"><span class="vh">Source file</span><select data-select>${paths.map((p) => html`<option value="${p}">${p}</option>`)}</select></label>
        <span class="mono srcv-path" data-path></span>
        <span class="srcv-act"><button type="button" class="btn btn-secondary btn-xs" data-copyfile>Copy file</button>${typeof Blob !== "undefined" ? html`<button type="button" class="btn btn-secondary btn-xs" data-zip>Download all (.zip)</button>` : ""}</span>
      </div>
      <div class="srcv-code"><pre class="srcv-g" aria-hidden="true"></pre><pre class="srcv-t" tabindex="0"><code></code></pre></div>
    </div>
  </div>`.s);
  const g = sec.querySelector<HTMLElement>(".srcv-g")!, t = sec.querySelector<HTMLElement>(".srcv-t code")!;
  const sel = sec.querySelector<HTMLSelectElement>("[data-select]")!, pathEl = sec.querySelector<HTMLElement>("[data-path]")!;
  const show = (p: string) => {
    cur = p;
    const text = files[p];
    const n = text.split("\n").length;
    g.textContent = Array.from({ length: n }, (_, i) => String(i + 1)).join("\n");
    t.innerHTML = highlight(text);
    pathEl.textContent = `${p} · ${int(n)} lines`;
    sel.value = p;
    sec.querySelectorAll<HTMLButtonElement>("[data-file]").forEach((b) => b.setAttribute("aria-current", String(b.dataset.file === p)));
    sec.querySelector<HTMLElement>(".srcv-t")!.scrollTop = 0;
  };
  sec.querySelector(".srcv-files")!.addEventListener("click", (e) => { const b = (e.target as Element).closest<HTMLButtonElement>("[data-file]"); if (b) show(b.dataset.file!); });
  sel.addEventListener("change", () => show(sel.value));
  // the gutter scrolls with the code
  const tp = sec.querySelector<HTMLElement>(".srcv-t")!;
  tp.addEventListener("scroll", () => { g.scrollTop = tp.scrollTop; }, { passive: true });
  sec.querySelector("[data-copyfile]")!.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(files[cur]); toast(`Copied ${cur.split("/").pop()}`); } catch { toast("Select the code and copy it"); }
  });
  sec.querySelector("[data-zip]")?.addEventListener("click", async () => {
    const { zip } = await import("./address/zip");
    const url = URL.createObjectURL(zip(files));
    const a = document.createElement("a");
    a.href = url; a.download = `${(main ?? "contract").toLowerCase()}-source.zip`; a.dataset.external = "";
    document.body.append(a); a.click(); a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
  });
  show(cur);
}

/* ---------------------------------------------------------------- read panel */

const isRead = (f: AbiItem) => f.type === "function" && (f.stateMutability === "view" || f.stateMutability === "pure");
const sig = (f: AbiItem) => `${f.name}(${(f.inputs ?? []).map((i) => `${i.type}${i.name ? " " + i.name : ""}`).join(", ")})`;
const outText = (f: AbiItem) => (f.outputs ?? []).map((p) => p.type).join(", ");

function outputsHtml(f: AbiItem, res: ArrayLike<unknown>, token?: Unit): Html {
  const outs = f.outputs ?? [];
  // a single unnamed output takes the function's name, so feeBps reads as a percent and minBond as FMX
  if (outs.length === 1) return valueHtml(res[0], { ...outs[0], name: outs[0].name || f.name || "" }, token);
  return html`<dl class="ad-tv">${outs.map((p, i) => html`<div><dt>${p.name || `#${i}`} <span class="faint">${p.type}</span></dt><dd>${valueHtml(res[i], p, token)}</dd></div>`)}</dl>`;
}
/** The revert reason: a custom error decoded with this contract's ABI when the node returned its data,
 *  else the node's message. */
const revertText = (e: unknown, iface?: { parseError(data: string): { name: string; args: ArrayLike<unknown> } | null }) => {
  if (e instanceof RpcError && iface && e.data && /^0x[0-9a-f]{8}/i.test(e.data)) {
    try {
      const pe = iface.parseError(e.data);
      if (pe) return pe.name === "Error" ? String(pe.args[0]) : `${pe.name}(${Array.from(pe.args).map((a) => String(a)).join(", ")})`;
    } catch { /* not in this ABI: fall back to the message */ }
  }
  const m = e instanceof RpcError ? e.message : e instanceof Error ? e.message : String(e);
  return m.replace(/^execution reverted:?\s*/i, "") || "reverted without a reason";
};

async function readPanel(host: HTMLElement, o: ContractOpts, abi: AbiItem[]) {
  const s = o.signal;
  const { Interface, isAddress, getAddress } = await ethers();
  if (s.aborted) return;
  const iface = new Interface(abi as never);
  const tk = o.addr?.token;
  const token: Unit | undefined = tk?.symbol && tk.decimals !== null && tk.decimals !== undefined && tk.decimals !== "" ? { symbol: tk.symbol, decimals: Number(tk.decimals) } : undefined;
  const fns = abi.filter(isRead).sort((x, y) => (x.name ?? "").localeCompare(y.name ?? ""));
  const zero = fns.filter((f) => !(f.inputs ?? []).length);
  const withArgs = fns.filter((f) => (f.inputs ?? []).length);
  if (!fns.length) { mount(host, note("This ABI has no read functions.")); return; }
  const block = currentHead()?.n ?? await rpc.blockNumber(s).catch(() => null);
  if (s.aborted) return;
  const tag = block ?? "latest";
  // ONE batch: every zero-argument read at the same block
  const results = await Promise.allSettled(zero.map((f) => rpc.ethCall(o.a, iface.encodeFunctionData(f.name!, []), s, tag)));
  if (s.aborted) return;
  const rows = zero.map((f, i) => {
    const r = results[i];
    let v: Html;
    if (r.status === "fulfilled") {
      try { const d = iface.decodeFunctionResult(f.name!, r.value); v = html`<span title="${valueText(Array.from(d))}">${outputsHtml(f, d, token)}</span>`; }
      catch { v = html`<span class="warn-text mono">${r.value === "0x" ? "empty return" : "could not decode the return value"}</span>`; }
    } else v = r.reason instanceof RpcError && r.reason.kind === "rpc" ? html`<span class="warn-text">${revertText(r.reason, iface)}</span>` : dash(RPC_DOWN);
    return html`<tr><th scope="row"><span class="mono">${f.name}</span></th><td class="ct-t mono faint">${outText(f)}</td><td>${v}</td></tr>`;
  });
  mount(host, html`${zero.length ? html`<div class="ct-rtw"><table class="ct-rt"><caption class="vh">Values read from the contract</caption><thead class="vh"><tr><th>Function</th><th>Returns</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table></div>` : ""}
    ${withArgs.length ? html`<div class="ct-fns">${withArgs.map((f) => html`<details class="ad-rf"><summary><span class="mono">${f.name}</span><span class="faint mono ad-rf-sig">(${(f.inputs ?? []).map((i) => `${i.type}${i.name ? " " + i.name : ""}`).join(", ")})${f.outputs?.length ? ` → ${outText(f)}` : ""}</span></summary>
      <form class="ad-rf-form" data-fn="${sig(f)}" novalidate>${(f.inputs ?? []).map((p, k) => inputHtml(f, p, k))}<div class="ad-rf-go"><button type="submit" class="btn btn-secondary btn-sm">Read</button></div><div class="ad-rf-out" aria-live="polite"></div></form></details>`)}</div>` : ""}
    <p class="ad-src">Read with eth_call from rpc.ferminux.net at ${block ? html`block <a href="/block/${block}" class="num-mono">${int(block)}</a>` : "the latest block"} ${prov("chain")}</p>`);

  host.querySelectorAll<HTMLFormElement>(".ad-rf-form").forEach((form) => {
    const f = withArgs.find((x) => sig(x) === form.dataset.fn)!;
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const out = form.querySelector<HTMLElement>(".ad-rf-out")!;
      const args: unknown[] = [];
      let bad = false;
      (f.inputs ?? []).forEach((p, k) => {
        const el = form.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="a${k}"]`)!;
        const err = form.querySelector<HTMLElement>(`[data-err="${k}"]`)!;
        const r = parseArg(p, el.value.trim(), isAddress, getAddress);
        el.setAttribute("aria-invalid", String(!r.ok));
        err.textContent = r.ok ? "" : r.msg;
        if (r.ok) args.push(r.v); else bad = true;
      });
      if (bad) return;
      out.innerHTML = html`<span class="faint">Reading…</span>`.s;
      try {
        const ret = await rpc.ethCall(o.a, iface.encodeFunctionData(f.name!, args), s, "latest");
        const d = iface.decodeFunctionResult(f.name!, ret);
        mount(out, html`<div class="ad-rf-res" title="${valueText(Array.from(d))}">${outputsHtml(f, d, token)}</div>`);
      } catch (x) {
        if (isAbort(x)) return;
        mount(out, x instanceof RpcError && x.kind !== "rpc" ? html`<p class="warn-text">${RPC_DOWN}: ${x.message}</p>` : html`<p class="warn-text mono">Reverted: ${revertText(x, iface)}</p>`);
      }
    });
  });
}

function inputHtml(f: AbiItem, p: AbiParam, k: number): Html {
  const id = `rf-${f.name}-${k}-${Math.random().toString(36).slice(2, 7)}`;
  const label = html`<label for="${id}"><span class="mono">${p.name || `arg ${k}`}</span> <span class="faint mono">${p.type}</span></label>`;
  const ph = p.type === "address" ? "0x… (40 hex characters)" : /^u?int/.test(p.type) ? "a whole number, e.g. 1" : p.type === "bytes32" ? "0x… (64 hex characters)" : p.type.startsWith("bytes") ? "0x…" : /\[|tuple/.test(p.type) ? "JSON, e.g. [1, 2]" : "";
  const field = p.type === "bool"
    ? html`<select id="${id}" name="a${k}"><option value="true">true</option><option value="false">false</option></select>`
    : html`<input id="${id}" name="a${k}" type="text" autocomplete="off" spellcheck="false" inputmode="${/^u?int/.test(p.type) ? "numeric" : "text"}" placeholder="${ph}">`;
  return html`<div class="field">${label}${field}<span class="err" data-err="${k}"></span></div>`;
}

type Parsed = { ok: true; v: unknown } | { ok: false; msg: string };
function parseArg(p: AbiParam, s: string, isAddress: (a: string) => boolean, getAddress: (a: string) => string): Parsed {
  const t = p.type;
  if (t === "address") {
    if (!/^0x[0-9a-fA-F]{40}$/.test(s)) return { ok: false, msg: "An address is 0x followed by 40 hexadecimal characters." };
    if (!isAddress(s)) return { ok: false, msg: "The checksum (mixed case) doesn't match. Paste it again, or type it all lower-case." };
    return { ok: true, v: getAddress(s) };
  }
  if (/^u?int\d*$/.test(t)) {
    if (!/^-?\d+$/.test(s.replace(/[,_\s]/g, ""))) return { ok: false, msg: "A whole number in decimal (no units)." };
    const v = BigInt(s.replace(/[,_\s]/g, ""));
    if (t.startsWith("u") && v < 0n) return { ok: false, msg: "Must not be negative." };
    return { ok: true, v };
  }
  if (t === "bool") return { ok: true, v: s === "true" };
  if (t === "string") return { ok: true, v: s };
  if (/^bytes\d+$/.test(t)) {
    const n = Number(t.slice(5));
    return new RegExp(`^0x[0-9a-fA-F]{${n * 2}}$`).test(s) ? { ok: true, v: s } : { ok: false, msg: `0x followed by ${n * 2} hexadecimal characters.` };
  }
  if (t === "bytes") return /^0x([0-9a-fA-F]{2})*$/.test(s) ? { ok: true, v: s } : { ok: false, msg: "0x followed by an even number of hexadecimal characters." };
  try { return { ok: true, v: JSON.parse(s) }; } catch { return { ok: false, msg: "Enter this as JSON, e.g. [1, 2] or [\"0x…\", 5]." }; }
}

