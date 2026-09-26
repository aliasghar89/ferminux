import { X402_VAULT_ABI, X402_VOUCHER_TYPES } from "../abi";
import { config, vaultDeployed } from "../config";
import { economy } from "../economy";
import { esc, fmx, fmxUnit, int, relTime, short, timeHtml, toWei } from "../format";
import { $, addrHtml, connectPrompt, initChrome, setBusy, skel, toast, txHtml } from "../ui";
import { connect, contractWrite, errMessage, onWallet, sendCall, signTyped, walletState } from "../wallet";
import { mountCredits } from "../credits";
import type { VoucherRecord, X402Resource } from "../types";

initChrome();
const view = $("#view")!;
// undefined, not null: the first onWallet call (address null when no wallet) must still render the connect state.
let current: string | null | undefined = undefined;

const domain = { name: "FerminuxX402", version: "1", chainId: config.chainId, verifyingContract: config.x402Vault } as const;

render();

function render() {
  view.innerHTML = `
    <section class="hero-sm">
      <div class="page-title"><div><h1>x402 — pay-per-request</h1><p>Deposit FMX once; every priced call signs a cheap off-chain voucher instead of a transaction. The gateway facilitator batches settlement every 30 s or 50 vouchers. Withdrawals have a 1 h unlock so outstanding vouchers settle first.</p></div></div>
    </section>
    ${!vaultDeployed ? `<div class="alert" style="margin-bottom:20px">X402Vault is not deployed yet. Depositing and withdrawing will be enabled the moment its address is published here; the flow below still works end to end once you connect a wallet, using its price quotes and voucher signatures.</div>` : ""}
    <div class="detail" style="padding-top:8px">
      <div class="detail-main">
        <div id="x-vault"></div>
        <div id="x-vault-status" role="status" aria-live="polite"></div>
        <div id="x-credits"></div>
        <div class="section-head" style="margin-top:8px"><h3>Voucher history</h3></div>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Payee</th><th scope="col" class="r">Amount</th><th scope="col">Nonce</th><th scope="col">Status</th><th scope="col">Created</th></tr></thead><tbody id="x-vouchers"><tr aria-hidden="true"><td>${skel("40%")}</td><td class="r">${skel("30%")}</td><td>${skel("20%")}</td><td>${skel("40%")}</td><td>${skel("40%")}</td></tr></tbody></table></div>
        <div class="section-head" style="margin-top:28px"><h3>Try it — sign a test voucher</h3></div>
        <div class="panel composer"><div class="panel-body">
          <p class="small muted">Signs an EIP-712 <code>Voucher</code> for one priced call, exactly what a client library does before retrying a 402. Nothing is sent unless you also settle it below.</p>
          <div class="form-row">
            <div class="field"><label for="x-payee">Priced resource</label><select id="x-payee"></select></div>
            <div class="field"><label for="x-amt">Amount (FMX)</label><input type="number" id="x-amt" min="0" step="0.001" class="num" placeholder="0.05"></div>
          </div>
          <div id="x-sign-status" role="status" aria-live="polite"></div>
          <div class="actions"><button class="btn btn-secondary" type="button" id="x-sign" style="width:auto">Sign voucher</button><button class="btn btn-primary" type="button" id="x-settle" style="width:auto" disabled>Verify + queue for settlement</button></div>
          <div class="code-block" id="x-voucher-box" hidden><div class="code-head"><span>Voucher</span><span class="mono">EIP-712</span></div><pre id="x-voucher-pre" class="light"></pre></div>
        </div></div>
      </div>
      <aside class="detail-side">
        <div class="panel"><div class="panel-head"><h3>Price your endpoint</h3></div><div class="panel-body">
          <p class="small muted">A priced route replies <span class="mono">402</span> with a <span class="mono">PAYMENT-REQUIRED</span> header; the client signs a voucher and retries with <span class="mono">PAYMENT</span>. Set <span class="mono">PRICE_PER_CALL</span> on the reference runtime and it does this for you.</p>
          <div class="code-block"><div class="code-head"><span>402 response</span></div><pre>{
  "x402Version": 1,
  "accepts": [{
    "scheme": "ferminux-voucher",
    "network": "ferminux:3961",
    "asset": "FMX",
    "payTo": "&lt;agent owner&gt;",
    "maxAmountRequired": "&lt;wei&gt;",
    "resource": "/a/&lt;slug&gt;/invoke",
    "maxTimeoutSeconds": 300,
    "extra": {
      "vault": "${esc(short(config.x402Vault, 6))}"
    }
  }]
}</pre></div>
          <p class="small faint">SDK: <span class="mono">fmx.fetch(url, init)</span> handles the 402 → sign → retry loop for a client; <span class="mono">x402.requirePayment(price)</span> is the Fastify/Express middleware for a server.</p>
        </div></div>
        <div class="panel" style="margin-top:16px"><div class="panel-head"><h3>Supported resources</h3></div><div class="panel-body" id="x-resources"><p class="small muted">${skel("60%")}</p></div></div>
      </aside>
    </div>
    <div style="height:24px"></div>`;
  view.setAttribute("aria-busy", "false");
  loadResources();
  onWallet((s) => { if (s.address !== current) { current = s.address; s.address ? loadVault(s.address) : renderVaultEmpty(); } });
  wireSignDemo();
}

function renderVaultEmpty() {
  $("#x-vault-status")!.innerHTML = ""; $("#x-credits")!.innerHTML = "";
  $("#x-vault")!.innerHTML = `<div class="panel"><div class="panel-head"><h3>Your vault</h3></div><div class="panel-body"><p class="muted small">Connect a wallet to deposit, request an unlock, or withdraw.</p><div class="connect-inline">${connectPrompt("x-connect")}</div></div></div>`;
  $("#x-connect")!.addEventListener("click", async (ev) => { const b = ev.currentTarget as HTMLButtonElement; setBusy(b, true, "Connecting…"); try { await connect(); } catch (e) { toast(errMessage(e)); setBusy(b, false); } });
  $("#x-vouchers")!.innerHTML = `<tr><td colspan="5" class="muted small" style="text-align:center;padding:20px">Connect a wallet to see your voucher history.</td></tr>`;
}

async function loadVault(addr: string) {
  const box = $("#x-vault")!;
  box.innerHTML = `<div class="panel"><div class="panel-head"><h3>Your vault</h3></div><div class="panel-body">${skel("40%")}${skel("60%")}</div></div>`;
  try {
    const p = await economy.x402Payer(addr);
    const unlockAt = p.unlockAt ? Number(p.unlockAt) : null;
    const unlocked = unlockAt !== null && Date.now() / 1000 >= unlockAt;
    box.innerHTML = `<div class="panel"><div class="panel-head"><h3>Your vault</h3><span class="pill ${unlocked ? "ok" : unlockAt ? "warn" : ""}">${unlocked ? "unlocked" : unlockAt ? `unlocks ${esc(relTime(unlockAt))}` : "locked"}</span></div>
      <div class="panel-body">
        <div class="price-line"><span>Balance</span><strong class="num">${fmxUnit(p.balance ?? "0", 4)}</strong></div>
        <p class="small muted">${int(p.pending.length)} pending voucher${p.pending.length === 1 ? "" : "s"} · ${int(p.settledCount)} settled.</p>
        <div class="form-row">
          <div class="field"><label for="x-dep">Deposit (FMX)</label><input type="number" id="x-dep" min="0" step="0.01" class="num" placeholder="5"></div>
          <div class="field" style="align-self:end"><button class="btn btn-primary btn-block" type="button" id="x-dep-btn">Deposit</button></div>
        </div>
        <div class="form-row">
          <div class="field" style="align-self:end"><button class="btn btn-secondary btn-block" type="button" id="x-unlock-btn" ${unlockAt ? "disabled" : ""}>${unlockAt ? "Unlock requested" : "Request unlock"}</button></div>
          <div class="field"><label for="x-wd">Withdraw (FMX)</label><input type="number" id="x-wd" min="0" step="0.01" class="num" placeholder="1" ${unlocked ? "" : "disabled"}></div>
        </div>
        <button class="btn btn-danger" type="button" id="x-wd-btn" ${unlocked ? "" : "disabled"}>Withdraw</button>
        <p class="small faint">Withdrawing needs <code>requestUnlock()</code> first, then a 1 h wait — outstanding vouchers settle against the balance before it is released.</p>
      </div></div>`;
    $("#x-dep-btn")!.addEventListener("click", () => doDeposit(addr));
    $("#x-unlock-btn")!.addEventListener("click", () => doUnlock(addr));
    $("#x-wd-btn")!.addEventListener("click", () => doWithdraw(addr));
    renderVouchers(p.vouchers);
    mountCredits($("#x-credits"), "x402Vault", addr);
  } catch (e) { box.innerHTML = `<div class="alert warn">Could not read the vault: ${esc(errMessage(e))}</div>`; }
}

async function doDeposit(addr: string) {
  const btn = $("#x-dep-btn") as HTMLButtonElement, status = $("#x-vault-status")!;
  const amt = ($("#x-dep") as HTMLInputElement).value.trim();
  if (!amt || Number(amt) <= 0) { status.innerHTML = `<div class="alert warn">Enter an amount.</div>`; return; }
  setBusy(btn, true, "Confirm in wallet…");
  try {
    if (config.mock) { await economy.mockDeposit(toWei(amt)); status.innerHTML = `<div class="alert ok">Deposited ${esc(amt)} FMX.</div>`; }
    else { if (!vaultDeployed) throw new Error("X402Vault is not deployed yet."); const vault = await contractWrite(config.x402Vault, X402_VAULT_ABI); const r = await sendCall(vault, "deposit", [], { value: toWei(amt) }, phaseTo(btn)); status.innerHTML = `<div class="alert ok">Deposited ${esc(amt)} FMX — ${txHtml(r.hash, "transaction")}.</div>`; }
    toast("Deposited"); await loadVault(addr);
  } catch (e) { status.innerHTML = `<div class="alert warn">${esc(errMessage(e))}</div>`; }
  finally { setBusy(btn, false); }
}
async function doUnlock(addr: string) {
  const btn = $("#x-unlock-btn") as HTMLButtonElement, status = $("#x-vault-status")!;
  setBusy(btn, true, "Confirm in wallet…");
  try {
    if (config.mock) { await economy.mockRequestUnlock(); status.innerHTML = `<div class="alert ok">Unlock requested. Wait 1 h, then withdraw.</div>`; }
    else { if (!vaultDeployed) throw new Error("X402Vault is not deployed yet."); const vault = await contractWrite(config.x402Vault, X402_VAULT_ABI); const r = await sendCall(vault, "requestUnlock", [], {}, phaseTo(btn)); status.innerHTML = `<div class="alert ok">Unlock requested — ${txHtml(r.hash, "transaction")}. Wait 1 h, then withdraw.</div>`; }
    toast("Unlock requested"); await loadVault(addr);
  } catch (e) { status.innerHTML = `<div class="alert warn">${esc(errMessage(e))}</div>`; setBusy(btn, false); }
}
async function doWithdraw(addr: string) {
  const btn = $("#x-wd-btn") as HTMLButtonElement, status = $("#x-vault-status")!;
  const amt = ($("#x-wd") as HTMLInputElement).value.trim();
  if (!amt || Number(amt) <= 0) { status.innerHTML = `<div class="alert warn">Enter an amount.</div>`; return; }
  setBusy(btn, true, "Confirm in wallet…");
  try {
    if (config.mock) { await economy.mockWithdraw(toWei(amt)); status.innerHTML = `<div class="alert ok">Withdrew ${esc(amt)} FMX.</div>`; }
    else { if (!vaultDeployed) throw new Error("X402Vault is not deployed yet."); const vault = await contractWrite(config.x402Vault, X402_VAULT_ABI); const r = await sendCall(vault, "withdraw", [toWei(amt)], {}, phaseTo(btn)); status.innerHTML = `<div class="alert ok">Withdrew ${esc(amt)} FMX — ${txHtml(r.hash, "transaction")}.</div>`; }
    toast("Withdrawn"); await loadVault(addr);
  } catch (e) { status.innerHTML = `<div class="alert warn">${esc(errMessage(e))}</div>`; }
  finally { setBusy(btn, false); }
}

/** Button label follows the tx phase so the user sees "Waiting for a block…" then "Indexing…". */
function phaseTo(btn: HTMLButtonElement) {
  return (ph: string) => { if (ph === "pending") setBusy(btn, true, "Waiting for a block…"); else if (ph === "indexing") setBusy(btn, true, "Indexing…"); };
}

function renderVouchers(items: VoucherRecord[]) {
  const tb = $("#x-vouchers")!;
  tb.innerHTML = items.length ? items.map(voucherRow).join("") : `<tr><td colspan="5" class="muted small" style="text-align:center;padding:20px">No vouchers yet.</td></tr>`;
}
function voucherRow(v: VoucherRecord): string {
  const tone = v.status === "settled" ? "ok" : v.status === "queued" || v.status === "submitted" ? "accent" : "warn";
  return `<tr><td data-l="Payee">${addrHtml(v.payee)}</td><td class="r num" data-l="Amount">${fmxUnit(v.amount, 4)}</td><td class="num" data-l="Nonce">${esc(v.nonce)}</td><td data-l="Status"><span class="pill ${tone}">${esc(v.status)}</span>${v.txHash ? ` ${txHtml(v.txHash, "tx")}` : ""}</td><td data-l="Created">${timeHtml(v.createdAt)}</td></tr>`;
}

async function loadResources() {
  const box = $("#x-resources")!, sel = $("#x-payee") as HTMLSelectElement;
  try {
    const { items } = await economy.x402Resources();
    box.innerHTML = items.length ? `<div style="display:grid;gap:10px">${items.map((r) => `<div><div class="row-title" style="font-size:14px"><a href="/agents/?id=${r.agentId}">${esc(r.agentName ?? `agent #${r.agentId}`)}</a> <span class="mono small faint">${esc(r.resource)}</span></div><div class="small muted">${esc(r.description ?? "")} · <span class="num">${fmxUnit(r.pricePerCallWei ?? "0", 3)}</span> / call</div></div>`).join("")}</div>` : `<p class="small muted">No priced resources listed yet.</p>`;
    sel.innerHTML = items.map((r) => `<option value="${esc(r.agentId)}" data-price="${esc(r.pricePerCallWei ?? "0")}" data-name="${esc(r.agentName ?? "")}" data-owner="${esc(r.owner)}">${esc(r.agentName ?? `agent #${r.agentId}`)} — ${esc(r.resource)}</option>`).join("") || `<option value="">No priced resources</option>`;
    sel.addEventListener("change", () => { const opt = sel.selectedOptions[0]; if (opt?.dataset.price) ($("#x-amt") as HTMLInputElement).value = fmx(opt.dataset.price, 6).replace(/,/g, ""); });
    if (items.length) sel.dispatchEvent(new Event("change"));
    (window as unknown as { __x402Resources?: X402Resource[] }).__x402Resources = items;
  } catch { box.innerHTML = `<p class="small muted">Could not load priced resources.</p>`; }
}

function wireSignDemo() {
  let lastVoucher: { voucher: Record<string, unknown>; sig: string } | null = null;
  $("#x-sign")!.addEventListener("click", async () => {
    const btn = $("#x-sign") as HTMLButtonElement, status = $("#x-sign-status")!;
    const sel = $("#x-payee") as HTMLSelectElement; const amt = ($("#x-amt") as HTMLInputElement).value.trim();
    const opt = sel.selectedOptions[0];
    if (!opt?.dataset.name) { status.innerHTML = `<div class="alert warn">No priced resource selected.</div>`; return; }
    if (!amt || Number(amt) <= 0) { status.innerHTML = `<div class="alert warn">Enter an amount.</div>`; return; }
    setBusy(btn, true, "Sign in wallet…");
    try {
      const w = walletState().address || (await connect());
      const resources = (window as unknown as { __x402Resources?: X402Resource[] }).__x402Resources || [];
      const res = resources.find((r) => String(r.agentId) === opt.value);
      // The payee is the agent's owner (the address a real 402 names in `payTo`). This used to sign
      // vouchers to 0x4242…4242 — a burn address — and settling one sent real FMX there.
      if (!res?.owner || !/^0x[0-9a-fA-F]{40}$/.test(res.owner)) throw new Error("This resource has no payee address.");
      if (res.owner.toLowerCase() === w.toLowerCase()) throw new Error("You own this resource — a voucher to yourself is pointless (and the vault treats it as a normal payment with a fee).");
      const voucher = { payer: w, payee: res.owner, amount: toWei(amt).toString(), nonce: String(Date.now()) + String(Math.floor(Math.random() * 1000)).padStart(3, "0"), expiry: Math.floor(Date.now() / 1000) + 3600, ref: "0x" + Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, "0")).join("") };
      const sig = await signTyped(domain, X402_VOUCHER_TYPES, voucher);
      lastVoucher = { voucher, sig };
      $("#x-voucher-box")!.hidden = false;
      $("#x-voucher-pre")!.textContent = JSON.stringify({ voucher, signature: sig }, null, 2);
      status.innerHTML = `<div class="alert ok">Signed for ${esc(res?.agentName || "the selected resource")} (payee ${esc(short(res!.owner, 6))}). Verify and queue it, or discard — nothing has moved yet. Queuing it pays ${esc(amt)} FMX from your vault for real.</div>`;
      ($("#x-settle") as HTMLButtonElement).disabled = false;
    } catch (e) { status.innerHTML = `<div class="alert warn">${esc(errMessage(e))}</div>`; }
    finally { setBusy(btn, false); }
  });
  $("#x-settle")!.addEventListener("click", async () => {
    const btn = $("#x-settle") as HTMLButtonElement, status = $("#x-sign-status")!;
    if (!lastVoucher) return;
    setBusy(btn, true, "Verifying…");
    try {
      const v = await economy.x402Verify(lastVoucher.voucher, lastVoucher.sig);
      if (!v.ok) { status.innerHTML = `<div class="alert warn">The facilitator rejected the voucher: ${esc(v.invalidReason || v.reason || "invalid")}.</div>`; return; }
      const s = await economy.x402Settle(lastVoucher.voucher, lastVoucher.sig);
      if (!s.success) { status.innerHTML = `<div class="alert warn">Settlement rejected: ${esc(s.errorReason || "unknown reason")}.</div>`; return; }
      status.innerHTML = `<div class="alert ok">Queued for the next batch (every 30 s or 50 vouchers)${s.txHash ? ` — ${txHtml(s.txHash, "tx")}` : ""}. It will appear in the voucher history once settled.</div>`;
      toast("Queued for settlement"); btn.disabled = true; lastVoucher = null;
      if (current) { setTimeout(() => loadVault(current!), 35000); }
    } catch (e) { status.innerHTML = `<div class="alert warn">${esc(errMessage(e))}</div>`; }
    finally { setBusy(btn, false); }
  });
}
