import { api } from "../api";
import { config } from "../config";
import { esc, int, short, timeHtml, toSec } from "../format";
import { renderMarkdown, plain } from "../md";
import { $, authorHtml, initChrome, setBusy } from "../ui";
import { connect, errMessage, onWallet, walletState } from "../wallet";
import { signAction, type SignedFields } from "../sign";
import type { Author, MessageView } from "../types";
import { checksum } from "../sign";

initChrome();
const box = $("#inbox")!, actions = $("#inbox-actions")!;
const MAX_BODY = 16 * 1024;
const bytes = (s: string) => new TextEncoder().encode(s).length;
const to = (v: string | null) => v && (/^\d+$/.test(v) || /^0x[0-9a-fA-F]{40}$/.test(v)) ? v : "";
const params = new URLSearchParams(location.search);

let items: MessageView[] | null = null; let readSig: SignedFields | null = null; let me: string | null = null;
let selected: string | null = null; // counterpart address, lower-case

/* -------------------------------------------------------------- states */
function renderSignedOut() {
  actions.innerHTML = "";
  box.innerHTML = `<div class="empty inbox-empty"><h3>Connect a wallet to open your inbox</h3>
    <p>Messages are addressed to wallet addresses. Reading yours takes one signature (<code>inbox.read</code>) so only the key holder can see them; the signature is a message, not a transaction, and costs nothing.</p>
    <button class="btn btn-primary" type="button" id="ib-connect">Connect wallet</button>
  </div>`;
  $("#ib-connect")?.addEventListener("click", async (ev) => { const b = ev.currentTarget as HTMLButtonElement; setBusy(b, true, "Connecting…"); try { await connect(); } catch (e) { setBusy(b, false); box.insertAdjacentHTML("afterbegin", `<div class="alert warn" style="margin-bottom:12px">${esc(errMessage(e))}</div>`); } });
}
function renderUnsigned(addr: string) {
  actions.innerHTML = "";
  box.innerHTML = `<div class="empty inbox-empty"><h3>Sign to read the inbox of ${esc(short(addr, 6))}</h3>
    <p>One signature proves you hold this key. Nothing is sent on-chain.</p>
    <button class="btn btn-primary" type="button" id="ib-sign">Sign and open inbox</button>
    <div id="ib-status" role="status" aria-live="polite" style="margin-top:12px"></div></div>`;
  $("#ib-sign")!.addEventListener("click", () => openInbox());
}
async function openInbox(silent = false) {
  const b = $("#ib-sign") as HTMLButtonElement | null; const st = $("#ib-status");
  if (b) setBusy(b, true, "Sign in wallet…");
  try {
    if (!readSig || readSig.address.toLowerCase() !== me!.toLowerCase() || Date.now() / 1000 - readSig.ts > 240) readSig = await signAction("inbox.read", {});
    const r = await api.inbox(readSig);
    items = r.items || [];
    if (!selected && !to(params.get("to"))) { const first = conversations()[0]; if (first) selected = first.key; }
    render();
  } catch (e) {
    if (b) setBusy(b, false);
    if (st) st.innerHTML = `<div class="alert warn">${esc(errMessage(e))}</div>`;
    else if (!silent) box.insertAdjacentHTML("afterbegin", `<div class="alert warn" style="margin-bottom:12px">${esc(errMessage(e))}</div>`);
  }
}

/* ------------------------------------------------------------ rendering */
interface Conv { key: string; who: Author; last: MessageView; count: number; msgs: MessageView[] }
function conversations(): Conv[] {
  const m = new Map<string, Conv>();
  for (const x of items || []) {
    const mine = x.from.address.toLowerCase() === me!.toLowerCase();
    const who = mine ? x.to : x.from; const key = who.address.toLowerCase();
    const c = m.get(key) || { key, who, last: x, count: 0, msgs: [] };
    c.count++; c.msgs.push(x); if ((toSec(x.createdAt) ?? 0) > (toSec(c.last.createdAt) ?? 0)) c.last = x;
    if (who.agentId && !c.who.agentId) c.who = who;
    m.set(key, c);
  }
  return Array.from(m.values()).sort((a, b) => (toSec(b.last.createdAt) ?? 0) - (toSec(a.last.createdAt) ?? 0));
}

function render() {
  const convs = conversations();
  actions.innerHTML = `<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-secondary btn-sm" type="button" id="ib-refresh">Refresh</button><button class="btn btn-primary btn-sm" type="button" id="ib-new">New message</button></div>`;
  $("#ib-refresh")!.addEventListener("click", async (ev) => { const b = ev.currentTarget as HTMLButtonElement; setBusy(b, true, "Loading…"); await openInbox(true); });
  $("#ib-new")!.addEventListener("click", () => { selected = null; paint(); $("#m-to")?.focus(); });
  paint();

  function paint() {
    const cur = selected ? convs.find((c) => c.key === selected) : null;
    box.innerHTML = `<div class="inbox-grid">
      <aside class="conv-list" aria-label="Conversations">
        <div class="conv-head"><span>${int(convs.length)} ${convs.length === 1 ? "conversation" : "conversations"}</span><span class="mono faint">${esc(short(me!, 4))}</span></div>
        ${convs.length ? convs.map((c) => `<button type="button" class="conv ${cur && c.key === cur.key ? "on" : ""}" data-key="${c.key}">
            <span class="conv-who">${c.who.agentId && c.who.name ? `<span class="author-mark" aria-hidden="true"></span>${esc(c.who.name)}` : `<span class="mono">${esc(short(c.who.address, 4))}</span>`}</span>
            <span class="conv-time">${timeHtml(c.last.createdAt)}</span>
            <span class="conv-prev">${c.last.from.address.toLowerCase() === me!.toLowerCase() ? "You: " : ""}${esc(plain(c.last.subject ? `${c.last.subject} — ${c.last.body}` : c.last.body, 70))}</span>
          </button>`).join("") : `<div class="conv-empty">No messages yet for this wallet. Anyone can write to your address or to an agent you own — try sending one to yourself.</div>`}
      </aside>
      <section class="conv-pane">${cur ? threadHtml(cur) : composeHtml()}</section>
    </div>`;
    box.querySelectorAll<HTMLButtonElement>(".conv").forEach((b) => b.addEventListener("click", () => { selected = b.dataset.key!; paint(); }));
    wireCompose(cur);
  }

  function threadHtml(c: Conv): string {
    const msgs = c.msgs.slice().sort((a, b) => (toSec(a.createdAt) ?? 0) - (toSec(b.createdAt) ?? 0));
    return `<div class="conv-title"><div>${authorHtml(c.who)} <span class="mono faint small">${esc(c.who.address)}</span></div><span class="small muted num">${int(c.count)} ${c.count === 1 ? "message" : "messages"}</span></div>
      <div class="msgs">${msgs.map((m) => { const mine = m.from.address.toLowerCase() === me!.toLowerCase(); return `<article class="msg ${mine ? "mine" : ""}"><div class="msg-head"><span>${mine ? "You" : authorHtml(m.from)}</span><span class="faint">${timeHtml(m.createdAt)}</span></div>${m.subject ? `<div class="msg-subject">${esc(m.subject)}</div>` : ""}<div class="msg-body md">${renderMarkdown(m.body)}</div></article>`; }).join("")}</div>
      ${composeHtml(c.who)}`;
  }

  function composeHtml(who?: Author): string {
    const preset = who ? (who.agentId ? String(who.agentId) : who.address) : to(params.get("to"));
    return `<form class="composer msg-compose" id="mform" novalidate>
      <h3 style="font-size:15px">${who ? `Reply to ${esc(who.name || short(who.address, 6))}` : "New message"}</h3>
      ${who ? "" : `<div class="field"><label for="m-to">To</label><input type="text" id="m-to" placeholder="0x… address or agent id (e.g. 1)" value="${esc(preset)}" autocomplete="off"><span class="hint">An agent id is resolved to its owner's address, and the message is also forwarded to the agent's endpoint so a running agent can react.</span><span class="err" id="e-to"></span></div>
      <div class="field"><label for="m-subject">Subject <span class="faint">(optional)</span></label><input type="text" id="m-subject" maxlength="200" autocomplete="off"></div>`}
      <div class="field"><label for="m-body">${who ? "Message" : "Body"}</label><textarea id="m-body" rows="${who ? 4 : 7}" placeholder="Markdown is fine. Up to 16 KiB."></textarea><span class="err" id="e-body"></span></div>
      <div id="m-status" role="status" aria-live="polite"></div>
      <div class="actions"><button class="btn btn-primary" type="submit" id="m-send" style="width:auto">Sign and send</button><span class="small faint">One signature, no gas. Anyone can write to any address; there is no blocking or moderation.</span></div>
    </form>`;
  }

  function wireCompose(cur: Conv | null | undefined) {
    const form = $("#mform") as HTMLFormElement | null; if (!form) return;
    const send = $("#m-send") as HTMLButtonElement, status = $("#m-status")!;
    const say = (m: string, k: "" | "warn" | "ok" | "info" = "") => { status.innerHTML = m ? `<div class="alert ${k}">${m}</div>` : ""; };
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      let toVal: string;
      if (cur) toVal = cur.who.agentId ? String(cur.who.agentId) : cur.who.address;
      else {
        toVal = ($("#m-to") as HTMLInputElement).value.trim();
        let bad = "";
        if (/^\d+$/.test(toVal)) bad = "";
        else if (/^0x[0-9a-fA-F]{40}$/.test(toVal)) { toVal = checksum(toVal); }
        else bad = "Enter a 0x address or a numeric agent id.";
        $("#e-to")!.textContent = bad; $("#m-to")!.setAttribute("aria-invalid", bad ? "true" : "false"); if (bad) return;
      }
      const body = ($("#m-body") as HTMLTextAreaElement).value.trim();
      const badB = !body ? "Write something." : bytes(body) > MAX_BODY ? `Message is ${int(bytes(body))} bytes; the limit is 16,384.` : "";
      $("#e-body")!.textContent = badB; $("#m-body")!.setAttribute("aria-invalid", badB ? "true" : "false"); if (badB) return;
      const subject = cur ? (cur.last.subject ? (cur.last.subject.startsWith("Re:") ? cur.last.subject : `Re: ${cur.last.subject}`) : undefined) : (($("#m-subject") as HTMLInputElement).value.trim() || undefined);
      setBusy(send, true, "Sign in wallet…"); say("Confirm the signature in your wallet. It is a message, not a transaction.", "info");
      try {
        const payload: { to: string; body: string; subject?: string } = { to: toVal, body }; if (subject) payload.subject = subject;
        const signed = await signAction("message.send", payload);
        setBusy(send, true, "Sending…");
        const m = await api.sendMessage(signed, payload);
        items = [m, ...(items || [])];
        selected = (m.from.address.toLowerCase() === me!.toLowerCase() ? m.to : m.from).address.toLowerCase();
        render();
      } catch (er) { say(esc(errMessage(er)), "warn"); setBusy(send, false); }
    });
  }
}

/* ------------------------------------------------------------- wallet */
onWallet((s) => {
  if (!s.address) { me = null; items = null; readSig = null; selected = null; renderSignedOut(); return; }
  if (me && me.toLowerCase() === s.address.toLowerCase() && items) return;
  me = s.address; items = null; readSig = null; selected = null; renderUnsigned(s.address);
  if (config.mock) openInbox(true);
});
