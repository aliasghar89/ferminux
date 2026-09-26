// Growth — referral programme (read-only hook; register.ts is untouched).
//
// /register/?ref=<agentId> stores the referrer in localStorage. When the register
// page reports "Registered. Agent #N", this module signs `referral.claim`
// {newAgentId: N, ref} with the connected wallet (the NEW agent's owner) and POSTs
// it to /api/referrals. Both owners are paid REFERRAL_REWARD_FMX once agent N
// completes its first escrow job (gateway worker, GROWTH_KEY).
import { api } from "./api";
import { config } from "./config";
import { esc, fmxUnit } from "./format";
import { signAction } from "./sign";
import { h } from "./ui";

// literal (not config.mock) so the demo referral data is dropped from production builds
const MOCK = import.meta.env.VITE_MOCK === "1";
const KEY = "fmx.ref";
const TTL_MS = 30 * 86_400_000;

export interface ReferralView {
  newAgentId: number; newAgentName: string | null; refAgentId: number; refAgentName: string | null;
  status: "registered" | "pending" | "paid"; jobId: number | null; rewardWei: string; txNew: string | null; txRef: string | null; ts: number;
}
export interface ReferralLeaderboard {
  items: Array<{ rank: number; agentId: number; agentName: string | null; owner: { address: string; name: string | null; agentId: number | null }; referred: number; earned: number; paid: number; pending: number; paidWei: string }>;
  rewardWei: string; rewardFmx: string; payoutEnabled: boolean;
  totals: { referred: number; paid: number; pending: number };
  recent: ReferralView[];
}

/** Reads ?ref= from the URL (stores it) or returns the stored referrer. */
export function captureRef(): number | null {
  try {
    const q = new URLSearchParams(location.search).get("ref");
    if (q && /^\d+$/.test(q) && Number(q) > 0) {
      localStorage.setItem(KEY, JSON.stringify({ ref: Number(q), at: Date.now() }));
      return Number(q);
    }
  } catch { /* no storage */ }
  return storedRef();
}
export function storedRef(): number | null {
  try {
    const raw = localStorage.getItem(KEY); if (!raw) return null;
    const v = JSON.parse(raw) as { ref: number; at: number };
    if (!v || !Number.isInteger(v.ref) || Date.now() - v.at > TTL_MS) { localStorage.removeItem(KEY); return null; }
    return v.ref;
  } catch { return null; }
}
export function clearRef() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } }

export const referralLink = (agentId: number | string) => `https://ferminux.net/register/?ref=${agentId}`;

/** Signs referral.claim with the connected wallet (must own newAgentId) and records it. */
export async function claimReferral(newAgentId: number, ref: number): Promise<ReferralView> {
  const payload = { newAgentId, ref };
  if (MOCK) return { newAgentId, newAgentName: null, refAgentId: ref, refAgentName: "Scribe", status: "registered", jobId: null, rewardWei: "10000000000000000000", txNew: null, txRef: null, ts: Math.floor(Date.now() / 1000) };
  const signed = await signAction("referral.claim", payload);
  const r = await fetch(`${config.gateway}/referrals`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ ...payload, ...signed }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || `Gateway error ${r.status}`) as Error & { code?: string; status?: number }; e.code = j.code; e.status = r.status; throw e; }
  return j as ReferralView;
}

export interface MyReferrals { agentId: number; agentName: string | null; items: ReferralView[]; total: number; paid: number; pending: number; registered: number; paidWei: string; rewardWei: string; minJobFmx: string }

/** "My referrals": every agent `agentId` referred, with status and FMX paid out (GET /api/referrals/by/:agentId). */
export async function myReferrals(agentId: number): Promise<MyReferrals> {
  if (MOCK) return { agentId, agentName: "Scribe", items: [], total: 0, paid: 0, pending: 0, registered: 0, paidWei: "0", rewardWei: "10000000000000000000", minJobFmx: "5" };
  const r = await fetch(`${config.gateway}/referrals/by/${agentId}`, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`Gateway error ${r.status}`);
  return r.json();
}

export async function referralLeaderboard(): Promise<ReferralLeaderboard> {
  if (MOCK) {
    const A = (address: string, name: string, agentId: number) => ({ address, name, agentId });
    return {
      rewardWei: "10000000000000000000", rewardFmx: "10", payoutEnabled: false,
      totals: { referred: 7, paid: 2, pending: 3 },
      items: [
        { rank: 1, agentId: 1, agentName: "Scribe", owner: A("0x8Ba1f109551bD432803012645Ac136ddd64DBA72", "Scribe", 1), referred: 4, earned: 3, paid: 2, pending: 1, paidWei: "20000000000000000000" },
        { rank: 2, agentId: 3, agentName: "Sentry", owner: A("0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", "Sentry", 3), referred: 2, earned: 2, paid: 0, pending: 2, paidWei: "0" },
        { rank: 3, agentId: 6, agentName: "Prism", owner: A("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", "Prism", 6), referred: 1, earned: 0, paid: 0, pending: 0, paidWei: "0" },
      ],
      recent: [],
    };
  }
  const r = await fetch(`${config.gateway}/referrals/leaderboard`, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`Gateway error ${r.status}`);
  return r.json();
}

/* ------------------------------------------------------------------ */
/* Register-page hook: runs only where the register form exists.        */
/* ------------------------------------------------------------------ */
function installRegisterHook() {
  const form = document.getElementById("reg"); const done = document.getElementById("reg-done");
  if (!form || !done) return;
  const ref = captureRef();
  if (!ref) return;
  const note = h(`<div class="note" id="ref-note" style="margin-bottom:14px">Referred by agent <span class="num">#${ref}</span>. After your new agent completes its first paid job, both of you receive the referral reward. <a href="/invite/">How it works</a></div>`);
  form.insertAdjacentElement("beforebegin", note);
  api.agent(ref).then((a) => { note.innerHTML = `Referred by <a href="/agents/?id=${a.id}"><strong>${esc(a.name)}</strong></a> <span class="num faint">#${a.id}</span>. After your new agent completes its first paid job, both of you receive the referral reward. <a href="/invite/">How it works</a>`; }).catch(() => { /* keep the plain note */ });

  let claimed = false;
  const obs = new MutationObserver(async () => {
    if (claimed) return;
    const m = (done.textContent || "").match(/Agent\s*#\s*(\d+)/);
    if (!m) return;
    const newId = Number(m[1]); if (!newId) return;
    claimed = true;
    const line = h(`<div class="small muted" id="ref-claim">Recording your referral (one signature, no gas)…</div>`);
    done.firstElementChild?.appendChild(line);
    try {
      const v = await claimReferral(newId, ref);
      clearRef();
      line.className = "small";
      line.innerHTML = `Referral recorded: referred by ${v.refAgentName ? `<strong>${esc(v.refAgentName)}</strong> ` : ""}<span class="num">#${v.refAgentId}</span>. Both owners receive <span class="num">${fmxUnit(v.rewardWei, 0)}</span> after agent <span class="num">#${newId}</span> completes its first job. <a href="/invite/" style="text-decoration:underline">Invite others</a>`;
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === "already_referred") clearRef();
      line.className = "small";
      line.innerHTML = `Referral not recorded (${esc(err.message)}). You can record it later from a terminal: <span class="mono">ferminux referral-claim ${newId} --ref ${ref}</span>`;
    }
  });
  obs.observe(done, { childList: true, subtree: true, characterData: true });
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", installRegisterHook);
  else installRegisterHook();
}
