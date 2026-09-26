import { config } from "../config";
import { economy } from "../economy";
import { esc, fmxUnit, int, pretty, timeHtml } from "../format";
import { $, connectPrompt, initChrome, setBusy, skel, toast } from "../ui";
import { connect, errMessage, onWallet, walletState } from "../wallet";
import { signAction, type SignedFields } from "../sign";
import type { MemoryKeyView, MemoryQuota } from "../types";

initChrome();
const view = $("#view")!;
// undefined, not null: the first onWallet call (address null when no wallet) must still render the connect state.
let current: string | null | undefined = undefined;
let readSig: SignedFields | null = null;

onWallet((s) => { if (s.address !== current) { current = s.address; s.address ? load(s.address) : renderEmpty(); } });

function renderEmpty() {
  view.innerHTML = `
    <section class="hero-sm">
      <div class="page-title"><div><h1>Memory</h1><p>Private key/value storage, scoped to your address. Reads and writes are signed with your wallet key — no accounts, nothing on-chain.</p></div></div>
    </section>
    <div class="empty"><h3>Connect a wallet to see your memory</h3><p>Keys are readable only by the address that wrote them.</p>${connectPrompt("mem-connect")}</div>`;
  view.setAttribute("aria-busy", "false");
  $("#mem-connect")!.addEventListener("click", async (ev) => { const b = ev.currentTarget as HTMLButtonElement; setBusy(b, true, "Connecting…"); try { await connect(); } catch (e) { toast(errMessage(e)); setBusy(b, false); } });
}

function quotaBar(q: MemoryQuota): string {
  const used = q.usedBytes, total = q.quotaBytes || (q.freeBytes + q.paidBytes);
  const pct = total ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const kb = (n: number) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `<div class="panel"><div class="panel-head"><h3>Quota</h3><span class="pill ${pct > 90 ? "warn" : "ok"}">${kb(used)} / ${kb(total)}</span></div>
    <div class="panel-body">
      <div style="height:8px;border-radius:999px;background:var(--border);overflow:hidden"><div style="height:100%;width:${pct}%;background:${pct > 90 ? "var(--warn)" : "var(--accent)"}"></div></div>
      <p class="small muted">5 MB free per address (${int(q.keys)} key${q.keys === 1 ? "" : "s"} now). Above quota, writes are priced ${fmxUnit(q.pricing.perBlockWei, 4)} per ${(q.pricing.blockBytes / 1024).toFixed(0)} KB for ${Math.round(q.pricing.creditTtlSeconds / 86400)} days through <a href="/x402/" style="text-decoration:underline">x402</a>.</p>
    </div></div>`;
}

async function ensureReadSig(): Promise<SignedFields> {
  if (!readSig || readSig.address.toLowerCase() !== current!.toLowerCase() || Date.now() / 1000 - readSig.ts > 240) readSig = await signAction("memory.get", {});
  return readSig;
}

async function load(addr: string) {
  view.innerHTML = `
    <section class="hero-sm">
      <div class="page-title"><div><h1>Memory</h1><p>Private key/value storage, scoped to your address (<span class="mono">${esc(addr)}</span>). Reads and writes are signed with your wallet key — no accounts, nothing on-chain.</p></div></div>
    </section>
    <div id="quota">${quotaBar({ usedBytes: 0, keys: 0, freeBytes: 5 * 1024 * 1024, paidBytes: 0, quotaBytes: 5 * 1024 * 1024, pricing: { perBlockWei: "10000000000000000", blockBytes: 65536, creditTtlSeconds: 30 * 86400, payTo: "" } })}</div>
    <div class="section-head" style="margin-top:28px"><h3>Your keys</h3></div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Key</th><th scope="col" class="r">Size</th><th scope="col">Updated</th><th scope="col" class="r">Actions</th></tr></thead>
    <tbody id="mem-rows"><tr aria-hidden="true"><td>${skel("40%")}</td><td class="r">${skel("30%")}</td><td>${skel("40%")}</td><td></td></tr></tbody></table></div>
    <div class="panel composer" style="margin-top:24px"><div class="panel-head"><h3>Write a key</h3></div>
      <div class="panel-body">
        <div class="form-row">
          <div class="field"><label for="mk-key">Key</label><input type="text" id="mk-key" maxlength="200" placeholder="agent-notes" autocomplete="off" spellcheck="false"></div>
        </div>
        <div class="field"><label for="mk-val">Value <span class="faint">(any UTF-8 text, ≤ 64 KB; encrypt client-side for anything sensitive)</span></label><textarea id="mk-val" rows="6" spellcheck="false" placeholder='{"lastRun": 1737000000}'></textarea></div>
        <p class="small faint">Signs <code>memory.put</code> with your wallet key (<code>personal_sign</code>) — a message, not a transaction, no fee.</p>
        <div id="mk-status" role="status" aria-live="polite"></div>
        <div class="actions"><button class="btn btn-primary" type="button" id="mk-save" style="width:auto">${walletState().address ? "Sign and save" : "Connect wallet"}</button></div>
      </div></div>
    <div style="height:48px"></div>`;
  loadKeys(addr);
  $("#mk-save")!.addEventListener("click", async () => {
    const btn = $("#mk-save") as HTMLButtonElement, status = $("#mk-status")!;
    const key = ($("#mk-key") as HTMLInputElement).value.trim(), value = ($("#mk-val") as HTMLTextAreaElement).value;
    if (!key) { status.innerHTML = `<div class="alert warn">Enter a key name.</div>`; return; }
    if (new TextEncoder().encode(value).length > 64 * 1024) { status.innerHTML = `<div class="alert warn">Value is larger than 64 KB.</div>`; return; }
    setBusy(btn, true, "Sign in wallet…"); status.innerHTML = `<div class="alert info">Confirm the signature in your wallet.</div>`;
    try {
      const signed = await signAction("memory.put", { value });
      await economy.memoryPut(key, signed, value);
      status.innerHTML = `<div class="alert ok">Saved <span class="mono">${esc(key)}</span>.</div>`;
      ($("#mk-key") as HTMLInputElement).value = ""; ($("#mk-val") as HTMLTextAreaElement).value = "";
      toast("Saved"); loadKeys(addr);
    } catch (e) { status.innerHTML = `<div class="alert warn">${esc(errMessage(e))}</div>`; }
    finally { setBusy(btn, false); }
  });
}

async function loadKeys(addr: string) {
  const rows = $("#mem-rows")!;
  try {
    const signed = await ensureReadSig();
    const { items, ...quota } = await economy.memoryList(signed);
    $("#quota")!.innerHTML = quotaBar(quota);
    rows.innerHTML = items.length ? items.map((k) => keyRow(k)).join("") : `<tr><td colspan="4"><div class="empty" style="border:0"><h3>No keys yet</h3>Write your first one below.</div></td></tr>`;
    rows.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((b) => b.addEventListener("click", () => viewKey(b.dataset.view!)));
    rows.querySelectorAll<HTMLButtonElement>("[data-del]").forEach((b) => b.addEventListener("click", () => delKey(b, addr, b.dataset.del!)));
  } catch (e) { rows.innerHTML = `<tr><td colspan="4"><div class="alert warn">${esc(config.mock ? errMessage(e) : "Could not load memory. Sign the request in your wallet and try again.")}</div></td></tr>`; }
}

function keyRow(k: MemoryKeyView): string {
  return `<tr id="row-${esc(k.key)}">
    <td data-l="Key"><span class="mono">${esc(k.key)}</span></td>
    <td class="r num" data-l="Size">${int(k.size)} B</td>
    <td data-l="Updated">${timeHtml(k.updatedAt)}</td>
    <td class="r" data-l="Actions"><div class="actions"><button class="btn btn-secondary btn-xs" type="button" data-view="${esc(k.key)}">View</button><button class="btn btn-danger btn-xs" type="button" data-del="${esc(k.key)}">Delete</button></div></td>
  </tr><tr class="mem-preview" id="preview-${esc(k.key)}" hidden><td colspan="4"><pre class="light" style="border:0;border-radius:0"></pre></td></tr>`;
}

async function viewKey(key: string) {
  const pre = document.querySelector<HTMLElement>(`#preview-${CSS.escape(key)}`); if (!pre) return;
  const wasHidden = pre.hidden; pre.hidden = !wasHidden; if (!wasHidden) return;
  const box = pre.querySelector("pre")!; box.textContent = "Loading…";
  try { const signed = await ensureReadSig(); const { value } = await economy.memoryGet(key, signed); box.textContent = typeof value === "string" ? value : pretty(value); }
  catch (e) { box.textContent = errMessage(e); }
}
async function delKey(btn: HTMLButtonElement, addr: string, key: string) {
  if (!confirm(`Delete "${key}"? This cannot be undone.`)) return;
  setBusy(btn, true, "Sign…");
  try { const signed = await signAction("memory.delete", {}); await economy.memoryDelete(key, signed); toast("Deleted"); loadKeys(addr); }
  catch (e) { toast(errMessage(e)); setBusy(btn, false); }
}
