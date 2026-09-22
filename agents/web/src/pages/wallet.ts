import { AGENT_ACCOUNT_ABI, AGENT_ACCOUNT_FACTORY_ABI } from "../abi";
import { accountsDeployed, config } from "../config";
import { economy } from "../economy";
import { esc, fmxUnit, relTime, short, toWei } from "../format";
import { $, addrHtml, initChrome, setBusy, skel, toast, txHtml } from "../ui";
import { connect, contractRead, contractWrite, errMessage, getBalance, onWallet, pollUntil, sendCall, signer, type TxPhase } from "../wallet";
import type { AccountRow, AccountView, SessionView } from "../types";

initChrome();
const view = $("#view")!;
let current: string | null = null;

onWallet((s) => { if (s.address !== current) { current = s.address; s.address ? load(s.address) : renderEmpty(); } });

function renderEmpty() {
  view.innerHTML = `
    <section class="hero-sm"><div class="page-title"><div><h1>Agent wallets</h1><p>A policy wallet for an agent runtime: you keep ownership, a session key signs day to day with a spend cap and a target allowlist, and any relayer can submit the transaction for you.</p></div></div></section>
    <div class="empty"><h3>Connect a wallet to manage agent wallets</h3>Accounts are listed by owner address.<br><button class="btn btn-primary" type="button" id="w-connect">Connect wallet</button></div>`;
  $("#w-connect")!.addEventListener("click", async (ev) => { const b = ev.currentTarget as HTMLButtonElement; setBusy(b, true, "Connecting…"); try { await connect(); } catch (e) { toast(errMessage(e)); setBusy(b, false); } });
}

async function load(owner: string) {
  view.innerHTML = `
    <section class="hero-sm">
      <div class="page-title"><div><h1>Agent wallets</h1><p>A policy wallet for an agent runtime: you keep ownership, a session key signs day to day with a spend cap and a target allowlist, and any relayer can submit the transaction for you (<code>executeWithSig</code>, gasless).</p></div>
      <button class="btn btn-primary" type="button" id="w-create">Create an agent wallet</button></div>
    </section>
    ${!accountsDeployed ? `<div class="alert" style="margin-bottom:20px">The AgentAccount factory is not deployed yet. Creating accounts and adding sessions will be enabled the moment its address is published here.</div>` : ""}
    <div id="w-status" role="status" aria-live="polite"></div>
    <div id="w-list">${Array.from({ length: 1 }, () => `<div class="panel" style="margin-bottom:16px"><div class="panel-body">${skel("40%")}${skel("60%")}</div></div>`).join("")}</div>
    <div style="height:48px"></div>`;
  view.setAttribute("aria-busy", "false");

  $("#w-create")!.addEventListener("click", async () => {
    const btn = $("#w-create") as HTMLButtonElement, status = $("#w-status")!;
    setBusy(btn, true, "Creating…"); status.innerHTML = `<div class="alert info">Requesting a gasless create from the relayer (1 per owner per day)…</div>`;
    try {
      const r = await economy.relayCreateAccount(owner);
      status.innerHTML = `<div class="alert ok">Agent wallet ${r.existing ? "already exists" : "created"} at <span class="mono">${esc(r.account)}</span>${r.txHash ? ` — ${txHtml(r.txHash, "transaction")}` : ""}.</div>`;
      toast("Agent wallet created"); setBusy(btn, true, "Indexing…");
      // the relayer's tx confirms asynchronously; wait until the gateway lists the account before re-reading
      await pollUntil(() => economy.myAccounts(owner), (v) => v.items.some((a) => a.account.toLowerCase() === r.account.toLowerCase()), 40000).catch(() => null);
      loadAccounts(owner);
    } catch (e) {
      status.innerHTML = `<div class="alert warn">Gasless create failed: ${esc(errMessage(e))} — trying a direct on-chain create instead (you pay gas).</div>`;
      try {
        if (!accountsDeployed) { status.innerHTML = `<div class="alert warn">The AgentAccount factory is not deployed yet.</div>`; return; }
        const factory = await contractWrite(config.accountFactory, AGENT_ACCOUNT_FACTORY_ABI);
        const salt = "0x" + Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, "0")).join("");
        const res = await sendCall(factory, "create", [owner, salt], {}, phaseTo(btn));
        status.innerHTML = `<div class="alert ok">Agent wallet created — ${txHtml(res.hash, "transaction")}.</div>`;
        toast("Agent wallet created"); loadAccounts(owner);
      } catch (e2) { status.innerHTML = `<div class="alert warn">${esc(errMessage(e2))}</div>`; }
    } finally { setBusy(btn, false); }
  });
  loadAccounts(owner);
}

const phaseTo = (btn: HTMLButtonElement) => (ph: TxPhase) => { if (ph === "pending") setBusy(btn, true, "Waiting for a block…"); else if (ph === "indexing") setBusy(btn, true, "Indexing…"); };

/** Sessions are not indexed off-chain (no gateway route); read live from the account when deployed:
 *  SessionAdded logs since the v3 deploy block (key is an indexed topic) → sessions(key) for the live state. */
async function liveSessions(account: string): Promise<SessionView[]> {
  if (!accountsDeployed) return [];
  try {
    const c = contractRead(account, AGENT_ACCOUNT_ABI);
    const added = (await c.queryFilter(c.filters.SessionAdded(), config.v3DeployBlock || 0)) as { args?: Record<string, unknown> }[];
    const keys = [...new Set(added.map((l) => String(l.args?.key ?? "")).filter(Boolean))];
    const rows = await Promise.all(keys.map(async (key) => {
      const s = (await c.sessions(key)) as { capPerDay: bigint; spentToday: bigint; expiry: bigint; anyTarget: boolean };
      if (BigInt(s.capPerDay) === 0n) return null; // revoked
      const targets = s.anyTarget ? [] : ((await c.sessionTargets(key).catch(() => [])) as string[]);
      return { key, capPerDayWei: s.capPerDay.toString(), spentTodayWei: s.spentToday.toString(), expiry: Number(s.expiry), anyTarget: s.anyTarget, targets } satisfies SessionView;
    }));
    return rows.filter((r): r is SessionView => r !== null);
  } catch { return []; }
}
async function hydrate(row: AccountRow): Promise<AccountView> {
  if (config.mock) return row as AccountView; // mock already returns the full shape (balanceWei + sessions)
  const [balance, sessions] = await Promise.all([getBalance(row.account).catch(() => 0n), liveSessions(row.account)]);
  return { ...row, balanceWei: balance.toString(), sessions };
}

async function loadAccounts(owner: string) {
  const box = $("#w-list")!;
  try {
    const { items } = await economy.myAccounts(owner);
    if (!items.length) { box.innerHTML = `<div class="empty"><h3>No agent wallets yet</h3>Create one above — it is a clone of one implementation contract, owned by this address, and it holds no funds until you send it some.</div>`; return; }
    box.innerHTML = items.map(() => `<div class="panel" style="margin-bottom:16px"><div class="panel-body">${skel("40%")}${skel("60%")}</div></div>`).join("");
    const hydrated = await Promise.all(items.map(hydrate));
    box.innerHTML = hydrated.map(accountPanel).join("");
    hydrated.forEach((a) => wireAccount(a, owner));
  } catch (e) { box.innerHTML = `<div class="alert warn">Could not load agent wallets: ${esc(errMessage(e))}</div>`; }
}

function sessionRow(a: AccountView, s: SessionView): string {
  const expired = Date.now() / 1000 > Number(s.expiry);
  const spent = BigInt(s.spentTodayWei), cap = BigInt(s.capPerDayWei);
  const pct = cap > 0n ? Math.min(100, Number((spent * 100n) / cap)) : 0;
  return `<tr>
    <td data-l="Session key">${addrHtml(s.key, { n: 6, label: "Session key" })}</td>
    <td data-l="Cap / day" class="num">${fmxUnit(s.capPerDayWei, 2)}</td>
    <td data-l="Spent today"><div style="display:flex;align-items:center;gap:8px"><div style="width:64px;height:6px;border-radius:999px;background:var(--surface-2);overflow:hidden"><div style="height:100%;width:${pct}%;background:${pct > 85 ? "var(--warn)" : "var(--accent)"}"></div></div><span class="small num">${fmxUnit(s.spentTodayWei, 2)}</span></div></td>
    <td data-l="Expiry">${expired ? `<span class="pill warn">expired</span>` : `<span class="small">${esc(relTime(s.expiry))}</span>`}</td>
    <td data-l="Targets">${s.anyTarget ? `<span class="pill">any target</span>` : `<span class="small mono">${s.targets.map((t) => short(t)).join(", ") || "—"}</span>`}</td>
    <td class="r" data-l="Actions"><button class="btn btn-danger btn-xs" type="button" data-revoke="${esc(s.key)}" data-account="${esc(a.account)}">Revoke</button></td>
  </tr>`;
}

function accountPanel(a: AccountView): string {
  const sessions = a.sessions ?? [];
  return `<div class="panel" style="margin-bottom:20px" id="acc-${esc(a.account)}">
    <div class="panel-head"><h3>${addrHtml(a.account, { n: 8, label: "Agent wallet" })}</h3><span class="pill" title="Created">created ${esc(relTime(a.createdAt))}</span></div>
    <div class="panel-body">
      <div class="price-line"><span>Balance</span><strong class="num">${fmxUnit(a.balanceWei ?? "0", 4)}</strong></div>
      <p class="small faint">Owner ${addrHtml(a.owner, { n: 4, label: "Owner" })}${a.txHash ? ` · created in ${txHtml(a.txHash, "tx")}` : ""}. Fund it below; a session key spends from this balance within its daily cap.</p>
      <div class="form-row">
        <div class="field"><label for="fund-${esc(a.account)}">Fund from your wallet</label><input type="number" id="fund-${esc(a.account)}" min="0" step="0.01" placeholder="1.0" class="num"></div>
        <div class="field" style="align-self:end"><button class="btn btn-secondary btn-block" type="button" data-fund="${esc(a.account)}">Send FMX</button></div>
      </div>
      <div id="fund-status-${esc(a.account)}"></div>
      <h4 style="margin-top:6px">Sessions</h4>
      ${sessions.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Session key</th><th scope="col" class="r">Cap / day</th><th scope="col">Spent today</th><th scope="col">Expiry</th><th scope="col">Targets</th><th scope="col" class="r">Actions</th></tr></thead><tbody>${sessions.map((s) => sessionRow(a, s)).join("")}</tbody></table></div>` : `<p class="small faint">No session keys yet — the owner key signs everything until you add one.</p>`}
      <details style="margin-top:14px"><summary class="small" style="cursor:pointer;color:var(--muted);font-weight:500">Add a session key</summary>
        <div class="form-row" style="margin-top:12px">
          <div class="field"><label for="sk-${esc(a.account)}">Session key address</label><input type="text" id="sk-${esc(a.account)}" placeholder="0x… (the runtime's signing key)" autocomplete="off" spellcheck="false"></div>
          <div class="field"><label for="sc-${esc(a.account)}">Cap / day (FMX)</label><input type="number" id="sc-${esc(a.account)}" min="0" step="0.01" placeholder="5" class="num"></div>
        </div>
        <div class="form-row">
          <div class="field"><label for="se-${esc(a.account)}">Expires in (days)</label><input type="number" id="se-${esc(a.account)}" min="1" step="1" placeholder="30" class="num"></div>
          <div class="field"><label for="st-${esc(a.account)}">Allowed targets <span class="faint">(comma-separated, blank = any)</span></label><input type="text" id="st-${esc(a.account)}" placeholder="0xEscrow…, 0xVault…" autocomplete="off" spellcheck="false"></div>
        </div>
        <div id="session-status-${esc(a.account)}"></div>
        <button class="btn btn-primary" type="button" data-add-session="${esc(a.account)}" style="width:auto">Sign and add session</button>
      </details>
    </div>
  </div>`;
}

function wireAccount(a: AccountView, owner: string) {
  $(`[data-fund="${a.account}"]`)?.addEventListener("click", async (ev) => {
    const btn = ev.currentTarget as HTMLButtonElement; const status = $(`#fund-status-${a.account}`)!;
    const amt = ($(`#fund-${a.account}`) as HTMLInputElement).value.trim();
    if (!amt || Number(amt) <= 0) { status.innerHTML = `<div class="alert warn">Enter an amount.</div>`; return; }
    setBusy(btn, true, "Confirm in wallet…");
    try {
      if (config.mock) { await new Promise((r) => setTimeout(r, 700)); status.innerHTML = `<div class="alert ok">Sent ${esc(amt)} FMX.</div>`; }
      else { const s = await signer(); setBusy(btn, true, "Waiting for a block…"); const tx = await s.sendTransaction({ to: a.account, value: toWei(amt) }); await tx.wait(1); status.innerHTML = `<div class="alert ok">Sent ${esc(amt)} FMX — ${txHtml(tx.hash, "transaction")}.</div>`; }
      toast("Funded"); $("#w-status")!.innerHTML = status.innerHTML; loadAccounts(owner);
    } catch (e) { status.innerHTML = `<div class="alert warn">${esc(errMessage(e))}</div>`; }
    finally { setBusy(btn, false); }
  });
  $(`[data-add-session="${a.account}"]`)?.addEventListener("click", async (ev) => {
    const btn = ev.currentTarget as HTMLButtonElement; const status = $(`#session-status-${a.account}`)!;
    const key = ($(`#sk-${a.account}`) as HTMLInputElement).value.trim();
    const capFmx = ($(`#sc-${a.account}`) as HTMLInputElement).value.trim();
    const days = ($(`#se-${a.account}`) as HTMLInputElement).value.trim();
    const targetsRaw = ($(`#st-${a.account}`) as HTMLInputElement).value.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(key)) { status.innerHTML = `<div class="alert warn">Enter a valid session key address.</div>`; return; }
    if (key.toLowerCase() === owner.toLowerCase()) { status.innerHTML = `<div class="alert warn">The owner key already signs everything — use the runtime's separate signing key.</div>`; return; }
    if (!capFmx || Number(capFmx) <= 0) { status.innerHTML = `<div class="alert warn">Enter a daily cap.</div>`; return; }
    if (days && !(Number(days) > 0)) { status.innerHTML = `<div class="alert warn">Expiry must be at least 1 day.</div>`; return; }
    const expiry = Math.floor(Date.now() / 1000) + (Number(days) || 30) * 86400;
    const targets = targetsRaw ? targetsRaw.split(",").map((t) => t.trim()).filter(Boolean) : [];
    const badTarget = targets.find((t) => !/^0x[0-9a-fA-F]{40}$/.test(t));
    if (badTarget) { status.innerHTML = `<div class="alert warn">"${esc(badTarget)}" is not an address.</div>`; return; }
    setBusy(btn, true, "Confirm in wallet…");
    try {
      if (config.mock) { await economy.mockAddSession(a.account, key, toWei(capFmx).toString(), expiry, targets); status.innerHTML = `<div class="alert ok">Session added.</div>`; }
      else { if (!accountsDeployed) throw new Error("The AgentAccount factory is not deployed yet."); const account = await contractWrite(a.account, AGENT_ACCOUNT_ABI); const r = await sendCall(account, "addSession", [key, toWei(capFmx), expiry, targets], {}, phaseTo(btn)); status.innerHTML = `<div class="alert ok">Session key ${esc(short(key, 6))} added (cap ${esc(capFmx)} FMX / day, expires ${esc(relTime(expiry))}) — ${txHtml(r.hash, "transaction")}.</div>`; }
      toast("Session added"); $("#w-status")!.innerHTML = status.innerHTML; loadAccounts(owner);
    } catch (e) { status.innerHTML = `<div class="alert warn">${esc(errMessage(e))}</div>`; }
    finally { setBusy(btn, false); }
  });
  document.querySelectorAll<HTMLButtonElement>(`#acc-${CSS.escape(a.account)} [data-revoke]`).forEach((b) => {
    b.addEventListener("click", async () => {
      setBusy(b, true, "Confirm…");
      try {
        if (config.mock) { await economy.mockRevokeSession(a.account, b.dataset.revoke!); }
        else { if (!accountsDeployed) throw new Error("The AgentAccount factory is not deployed yet."); const account = await contractWrite(a.account, AGENT_ACCOUNT_ABI); const r = await sendCall(account, "revokeSession", [b.dataset.revoke], {}, phaseTo(b)); $("#w-status")!.innerHTML = `<div class="alert ok">Session key ${esc(short(b.dataset.revoke!, 6))} revoked — ${txHtml(r.hash, "transaction")}.</div>`; }
        toast("Session revoked"); loadAccounts(owner);
      } catch (e) { toast(errMessage(e)); setBusy(b, false); }
    });
  });
}
