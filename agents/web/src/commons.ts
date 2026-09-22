// Shared pieces for the Commons v2 pages (bounties, kb, tools, artifacts, activity, leaderboard, arena).
import { keccak256, toUtf8Bytes } from "ethers";
import { api } from "./api";
import { config } from "./config";
import { dur, esc, fmxUnit, int, short, timeHtml } from "./format";
import { plain } from "./md";
import { signAction, type CommonsAction } from "./sign";
import type { ActivityEvent, AgentView, Author } from "./types";
import { $, authorHtml, setBusy, txHtml } from "./ui";
import { connect, errMessage, eventArg, hasInjected, sendTx, walletState } from "./wallet";

/* ------------------------------------------------------------ icons */
// 16 px, stroke = currentColor, drawn inline (no emoji, no icon font).
const P: Record<string, string> = {
  agent: `<circle cx="8" cy="5.5" r="2.75"/><path d="M2.75 14a5.25 5.25 0 0 1 10.5 0"/>`,
  job: `<rect x="2" y="5" width="12" height="8.5" rx="1.5"/><path d="M5.5 5V3.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V5M2 9h12"/>`,
  check: `<circle cx="8" cy="8" r="6"/><path d="M5.25 8.25 7.25 10.25 10.75 6.25"/>`,
  refund: `<path d="M3 8a5 5 0 1 0 1.5-3.5M3 2.5V5h2.5"/>`,
  dispute: `<path d="M8 2.5 14 13H2Z"/><path d="M8 6.5v3M8 11.2v.3"/>`,
  thread: `<path d="M2.5 3.5h11v7h-6L4.5 13v-2.5h-2Z"/>`,
  message: `<rect x="2" y="3.5" width="12" height="9" rx="1.5"/><path d="m2.5 4.5 5.5 4 5.5-4"/>`,
  bounty: `<circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="2.5"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2"/>`,
  kb: `<path d="M3 2.5h5.5a2 2 0 0 1 2 2V14a1.5 1.5 0 0 0-1.5-1.5H3Z"/><path d="M13 2.5H7.5a2 2 0 0 0-2 2V14a1.5 1.5 0 0 1 1.5-1.5H13Z"/>`,
  tool: `<path d="M9.5 2.5a3.5 3.5 0 0 0 3.8 5.1L8.5 12.4a1.5 1.5 0 0 1-2.1 0l-.8-.8a1.5 1.5 0 0 1 0-2.1L10.4 4.7A3.5 3.5 0 0 0 9.5 2.5Z"/>`,
  artifact: `<path d="M2.5 5 8 2.5 13.5 5 8 7.5Z"/><path d="M2.5 5v6L8 13.5l5.5-2.5V5M8 7.5v6"/>`,
  star: `<path d="m8 2 1.8 3.8 4.2.5-3.1 2.9.8 4.1L8 11.2l-3.7 2.1.8-4.1L2 6.3l4.2-.5Z"/>`,
  arena: `<path d="M4.5 2.5h7v3a3.5 3.5 0 0 1-7 0Z"/><path d="M4.5 3.5H2.5v1a2 2 0 0 0 2 2M11.5 3.5h2v1a2 2 0 0 1-2 2M8 9v2.5M5.5 13.5h5"/>`,
  presence: `<circle cx="8" cy="8" r="2"/><path d="M4.5 4.5a5 5 0 0 0 0 7M11.5 4.5a5 5 0 0 1 0 7"/>`,
  dot: `<circle cx="8" cy="8" r="3"/>`,
  copy: `<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>`,
  edit: `<path d="m3 13 .6-2.8 7.1-7.1a1.2 1.2 0 0 1 1.7 0l.5.5a1.2 1.2 0 0 1 0 1.7L5.8 12.4Z"/>`,
  history: `<path d="M3 8a5 5 0 1 0 1.5-3.5M3 2.5V5h2.5M8 5.5V8l2 1.5"/>`,
  link: `<path d="M6.5 9.5 9.5 6.5M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 0 1 4.5 9l1-1"/>`,
  pause: `<rect x="4" y="3" width="3" height="10" rx=".8"/><rect x="9" y="3" width="3" height="10" rx=".8"/>`,
  play: `<path d="M5 3v10l8-5Z"/>`,
};
export function icon(name: string, cls = ""): string {
  const d = P[name] || P.dot;
  return `<svg class="ico ${cls}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
}

/* --------------------------------------------------------- activity */
interface Rendered { icon: string; tone: string; text: string }
const jobLink = (id: number | string) => `<a class="ref num" href="/jobs/">job #${esc(String(id))}</a>`;
function refLink(e: ActivityEvent): string {
  const r = e.ref; if (!r) return "";
  const t = r.title ? esc(plain(String(r.title), 70)) : `#${esc(String(r.id))}`;
  switch (r.kind) {
    case "job": return jobLink(r.id);
    case "agent": return `<a class="ref" href="/agents/?id=${esc(String(r.id))}">${t}</a>`;
    case "thread": return `<a class="ref" href="/forum/?id=${esc(String(r.id))}">${t}</a>`;
    case "bounty": return `<a class="ref" href="/bounties/?id=${esc(String(r.id))}">${t}</a>`;
    case "kb": return `<a class="ref" href="/kb/?slug=${encodeURIComponent(String(r.id))}">${t}</a>`;
    case "tool": return `<a class="ref" href="/tools/?id=${esc(String(r.id))}">${t}</a>`;
    case "artifact": return `<a class="ref" href="/artifacts/?id=${esc(String(r.id))}">${t}</a>`;
    case "arena": return `<a class="ref" href="/arena/?id=${esc(String(r.id))}">${t}</a>`;
    case "case": return `<a class="ref" href="/disputes/?id=${esc(String(r.id))}">case #${esc(String(r.id))}</a>`;
    case "stream": case "plan": case "sub": return `<a class="ref" href="/streams/">${r.kind} #${esc(String(r.id))}</a>`;
    case "token": return `<a class="ref" href="/tokens/">token</a>`;
    case "account": return `<a class="ref" href="/wallet/">agent wallet</a>`;
    case "x402": return `<a class="ref" href="/x402/">x402</a>`;
    default: return t;
  }
}
/** One activity event → {icon, tone, sentence html}. Unknown types degrade to "<actor> <type>". */
export function describe(e: ActivityEvent): Rendered {
  const who = e.actor ? authorHtml(e.actor) : `<span class="faint">someone</span>`;
  const ref = refLink(e); const sum = e.summary ? esc(e.summary) : "";
  const d = (e.data ?? {}) as Record<string, unknown>; const r = e.ref;
  const amt = (wei: unknown) => `<span class="num">${fmxUnit(String(wei ?? "0"), 4)}</span>`;
  const chip = (a: unknown) => typeof a === "string" ? `<span class="mono">${esc(short(a, 4))}</span>` : a && typeof a === "object" && (a as Author).address ? authorHtml(a as Author) : "";
  const t = String(e.type || "");
  const line = (icon: string, tone: string, text: string): Rendered => ({ icon, tone, text });
  switch (t) {
    case "agent.registered": return line("agent", "ok", `${who} registered ${ref || "an agent"}`);
    case "agent.updated": return line("agent", "", `${who} updated ${ref || "an agent"}`);
    case "agent.status": return line("agent", "", `${ref || "an agent"} changed status${sum ? ` — ${sum}` : ""}`);
    case "job.requested": return line("job", "job", `${who} opened ${ref || "a job"}${sum ? ` — ${sum}` : ""}`);
    case "job.delivered": return line("job", "job", `${who} delivered ${ref || "a job"}`);
    case "job.completed": return line("check", "ok", `${ref || "a job"} completed${sum ? ` — ${sum}` : ""}`);
    case "job.refunded": return line("refund", "warn", `${ref || "a job"} refunded${sum ? ` — ${sum}` : ""}`);
    case "job.disputed": return line("dispute", "warn", `${who} disputed ${ref || "a job"}`);
    case "job.resolved": return line("check", "info", `${ref || "a job"} resolved by governance${sum ? ` — ${sum}` : ""}`);
    case "thread.create": return line("thread", "", `${who} started ${ref || "a thread"}`);
    case "post.create": return line("thread", "", `${who} replied in ${ref || "a thread"}`);
    case "message.send": return line("message", "info", `${who} sent a message${sum ? ` ${sum}` : ""}`);
    case "bounty.create": return line("bounty", "job", `${who} posted bounty ${ref}`);
    case "bounty.claim": return line("bounty", "", `${who} claimed bounty ${ref}`);
    case "bounty.award": return line("bounty", "ok", `${who} awarded ${ref}${sum ? ` ${sum}` : ""}`);
    case "bounty.completed": return line("check", "ok", `bounty ${ref} completed`);
    case "kb.write": return line("kb", "info", `${who} edited ${ref || "a KB page"}${sum ? ` <span class="faint">(${sum})</span>` : ""}`);
    case "tool.publish": return line("tool", "", `${who} published tool ${ref}`);
    case "artifact.publish": return line("artifact", "", `${who} published ${ref}`);
    case "artifact.star": return line("star", "job", `${who} starred ${ref}`);
    case "arena.create": return line("arena", "job", `${who} opened challenge ${ref}`);
    case "arena.submit": return line("arena", "", `${who} submitted to ${ref}`);
    case "arena.vote": return line("arena", "", `${who} voted in ${ref}`);
    case "arena.award": return line("arena", "ok", `${who} paid the prize for ${ref}${sum ? ` — ${sum}` : ""}`);
    case "presence.ping": return line("presence", "ok", `${who} is online${sum && sum !== "online" ? ` — ${sum}` : ""}`);
    // Addendum v3 — Agent Economy (gateway/src/v3/indexer-v3.ts emit(...) types)
    case "x402.settled": return line("check", "ok", `${who} paid ${amt(d.amount)} by x402 voucher${d.payee ? ` to ${chip(d.payee)}` : ""}`);
    case "account.created": return line("agent", "", `${who} created an agent wallet${d.account ? ` <span class="mono">${esc(short(String(d.account), 6))}</span>` : ""}`);
    case "stream.opened": return line("job", "job", `${who} opened stream #${esc(String(d.streamId ?? r?.id ?? ""))}${d.payee ? ` to ${chip(d.payee)}` : ""}${d.ratePerSec ? ` at ${amt((BigInt(String(d.ratePerSec)) * 86400n).toString())} / day` : ""}`);
    case "stream.cancelled": return line("refund", "warn", `stream #${esc(String(d.streamId ?? r?.id ?? ""))} cancelled${d.toPayee ? ` — ${amt(d.toPayee)} to the payee` : ""}`);
    case "plan.created": return line("bounty", "", `${who} created plan #${esc(String(d.planId ?? r?.id ?? ""))}${d.pricePerPeriod ? ` at ${amt(d.pricePerPeriod)}${d.period ? ` / ${esc(dur(Number(d.period)))}` : ""}` : ""}`);
    case "sub.created": return line("check", "ok", `${who} subscribed to plan #${esc(String(d.planId ?? ""))}${d.payee ? ` from ${chip(d.payee)}` : ""}${d.periods ? ` (${int(Number(d.periods))} period${Number(d.periods) === 1 ? "" : "s"})` : ""}`);
    case "case.opened": return line("dispute", "warn", `${who} opened dispute case #${esc(String(d.caseId ?? r?.id ?? ""))} on ${jobLink(String(d.jobId ?? ""))}`);
    case "case.closed": return line("check", "info", `case #${esc(String(d.caseId ?? r?.id ?? ""))} closed${d.clientBps !== undefined ? ` — ${(Number(d.clientBps) / 100).toFixed(1)}% to the client` : ""}`);
    case "token.launched": return line("bounty", "job", `${who} launched token <span class="mono">${esc(String(d.symbol ?? ""))}</span>${d.agentName ? ` for ${esc(String(d.agentName))}` : ""}`);
    case "feedback.given": return line("star", "job", `${who} gave on-chain feedback${d.agentId ? ` to <a class="ref" href="/agents/?id=${esc(String(d.agentId))}">agent #${esc(String(d.agentId))}</a>` : ""}`);
    case "validation.requested": return line("check", "", `${who} requested validation of ${ref || "an agent"}`);
    case "validation.done": return line("check", "ok", `${ref || "an agent"} validated${d.response !== undefined && d.response !== null ? ` — ${esc(String(d.response))}/100` : ""}${d.tag ? ` (${esc(String(d.tag))})` : ""}`);
    default: return line("dot", "", `${who} <span class="mono">${esc(t)}</span>${ref ? ` ${ref}` : ""}${sum ? ` — ${sum}` : ""}`);
  }
}
export function activityRow(e: ActivityEvent, fresh = false): string {
  const d = describe(e);
  return `<div class="act ${fresh ? "new" : ""}" data-id="${esc(String(e.id))}"><span class="ico-wrap ${d.tone}">${icon(d.icon)}</span><span class="act-text">${d.text}</span><span class="act-time">${timeHtml(e.at)}</span></div>`;
}

/* ------------------------------------------------------- my agents */
/** Agents owned by the connected wallet (active ones first). */
export async function myAgents(addr: string): Promise<AgentView[]> {
  const r = await api.agents({ owner: addr, limit: 200, sort: "newest" });
  return r.items.filter((a) => a.owner.toLowerCase() === addr.toLowerCase()).sort((a, b) => (String(a.status).toLowerCase() === "active" ? -1 : 1) - (String(b.status).toLowerCase() === "active" ? -1 : 1));
}
export function agentSelect(id: string, agents: AgentView[]): string {
  return `<select id="${id}">${agents.map((a) => `<option value="${a.id}">${esc(a.name)} <span>#${a.id}</span>${String(a.status).toLowerCase() !== "active" ? ` (${esc(String(a.status).toLowerCase())})` : ""}</option>`).join("")}</select>`;
}

/* ----------------------------------------------------- signed form */
export const noWallet = () => !hasInjected() && !config.mock;
export const signHint = (what: string, cli?: string) =>
  `<p class="small faint">${esc(what)} signs a short message with your wallet key (<code>personal_sign</code>). Nothing goes on-chain and there is no fee.${noWallet() ? ` No browser wallet detected — install MetaMask${cli ? `, or use the CLI: <code>${esc(cli)}</code>` : ""}.` : ""}</p>`;
export const say = (el: HTMLElement | null, m: string, k: "" | "warn" | "ok" | "info" = "") => { if (el) el.innerHTML = m ? `<div class="alert ${k}">${m}</div>` : ""; };

/** Connect-or-sign button flow shared by every composer: returns false if the click only connected the wallet. */
export async function ensureWallet(btn: HTMLButtonElement, status: HTMLElement | null, label: string): Promise<boolean> {
  if (walletState().address) return true;
  setBusy(btn, true, "Connecting…");
  try { await connect(); say(status, ""); } catch (e) { say(status, esc(errMessage(e)), "warn"); }
  finally { setBusy(btn, false); btn.textContent = walletState().address ? label : "Connect wallet"; }
  return false;
}
export const btnLabel = (btn: HTMLButtonElement, label: string) => { if (!btn.disabled) btn.textContent = walletState().address ? label : "Connect wallet"; };

/** Sign + call. Shows the standard "confirm in wallet" note and turns errors into alerts. */
export async function signedCall<T>(btn: HTMLButtonElement, status: HTMLElement | null, action: CommonsAction, payload: Record<string, unknown>, call: (signed: Awaited<ReturnType<typeof signAction>>) => Promise<T>, busyLabel = "Sending…"): Promise<T | null> {
  setBusy(btn, true, "Sign in wallet…"); say(status, "Confirm the signature in your wallet. It is a message, not a transaction.", "info");
  try { const signed = await signAction(action, payload); setBusy(btn, true, busyLabel); const r = await call(signed); say(status, ""); return r; }
  catch (e) { say(status, esc(errMessage(e)), "warn"); setBusy(btn, false); return null; }
}

/* ------------------------------------------------- award → hire flow */
export interface AwardOpts {
  agentId: number; amountWei: bigint; inputURI: string; input: Record<string, unknown>;
  action: "bounty.award" | "arena.award";
  post: (signed: Awaited<ReturnType<typeof signAction>>, payload: { agentId: number; jobId: number }) => Promise<unknown>;
  status: HTMLElement | null; btn: HTMLButtonElement;
}
/**
 * One click: upload the brief as the job input, escrow.requestJob(agentId, hash, inputURI) with value = reward,
 * then sign and POST the award {agentId, jobId}. Returns the jobId or null.
 */
export async function awardAndHire(o: AwardOpts): Promise<number | null> {
  const { btn, status } = o;
  if (!walletState().address) { await ensureWallet(btn, status, btn.textContent || "Award"); if (!walletState().address) return null; }
  let agent: AgentView | null = null;
  setBusy(btn, true, "Checking agent…");
  try { agent = await api.agent(o.agentId); } catch { /* the contract is the final judge */ }
  if (agent) {
    if (agent.owner.toLowerCase() === walletState().address!.toLowerCase()) { say(status, "That agent is yours. The escrow does not let an owner hire their own agent — award it to another claim.", "warn"); setBusy(btn, false); return null; }
    const price = BigInt(agent.pricePerJob || "0");
    if (o.amountWei < price) { say(status, `${esc(agent.name)} charges ${fmxUnit(price)} per job and the reward is ${fmxUnit(o.amountWei)}. The escrow rejects payments below the agent's price — raise the reward or pick another agent.`, "warn"); setBusy(btn, false); return null; }
    if (String(agent.status).toLowerCase() !== "active") { say(status, `${esc(agent.name)} is ${esc(String(agent.status).toLowerCase())} and cannot take jobs right now.`, "warn"); setBusy(btn, false); return null; }
  }
  try {
    setBusy(btn, true, "Uploading brief…");
    const text = JSON.stringify(o.input);
    const p = await api.postPayload(text, "application/json");
    if (p.hash.toLowerCase() !== keccak256(toUtf8Bytes(text)).toLowerCase()) throw new Error("The gateway returned an unexpected hash for the brief. Not sending — try again.");
    setBusy(btn, true, "Confirm in wallet…");
    say(status, `Confirm the escrow payment of <strong class="num">${fmxUnit(o.amountWei)}</strong> plus gas in your wallet. The job input is the brief (${short(p.hash, 6)}), URI <code>${esc(o.inputURI)}</code>.`, "info");
    const r = await sendTx((c) => c.escrow.requestJob(o.agentId, p.hash, o.inputURI, { value: o.amountWei }), (ph, hash) => { if (ph === "pending") { setBusy(btn, true, "Waiting for a block…"); say(status, `Transaction sent, waiting for confirmation (about 7 s). ${txHtml(hash, "tx")}`, "info"); } });
    const idArg = eventArg(r.logs, "JobRequested", "jobId");
    let jobId = idArg !== undefined ? Number(idArg) : null;
    if (jobId === null && config.mock) jobId = 5200 + Math.floor(Math.random() * 50);
    if (jobId === null) throw new Error("The transaction confirmed but no JobRequested event was found. Check it on the explorer; the award can be linked from the CLI with the job id.");
    setBusy(btn, true, "Sign the award…");
    say(status, `Escrow job <strong class="num">#${jobId}</strong> is open (${txHtml(r.hash, "tx")}). One more signature links it to this ${o.action === "bounty.award" ? "bounty" : "challenge"}.`, "info");
    const payload = { agentId: o.agentId, jobId };
    const signed = await signAction(o.action, payload);
    await o.post(signed, payload);
    say(status, `Done. Job <strong class="num">#${jobId}</strong> is escrowed for ${fmxUnit(o.amountWei)}; the agent delivers within 24 h and you release from <a href="/jobs/" style="text-decoration:underline">My jobs</a>.`, "ok");
    return jobId;
  } catch (e) { say(status, esc(errMessage(e)), "warn"); setBusy(btn, false); return null; }
}

/* ------------------------------------------------------------ misc */
export const tagsHtml = (tags: string[] | undefined, base?: string) => tags?.length ? `<span class="tags inline">${tags.map((t) => base ? `<a class="tag" href="${base}${encodeURIComponent(t)}">${esc(t)}</a>` : `<span class="tag">${esc(t)}</span>`).join("")}</span>` : "";
export const parseTags = (s: string) => Array.from(new Set(s.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean)));
export const bytes = (s: string) => new TextEncoder().encode(s).length;
export const isMe = (a: Author | null | undefined) => !!a && !!walletState().address && a.address.toLowerCase() === walletState().address!.toLowerCase();
export const countText = (n: number, one: string, many = one + "s") => `${int(n)} ${n === 1 ? one : many}`;
export const kbUrl = (slug: string) => `/kb/?slug=${encodeURIComponent(slug)}`;
export { $ };
