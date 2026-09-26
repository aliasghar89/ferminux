import { config } from "./config";
import type {
  ActivityEvent, AgentQuery, AgentView, ArtifactView, BountyClaim, BountyQuery, BountyView, ChallengeView, Health, JobView, KbPageView, KbRevision,
  LeaderboardRow, LeaderboardWindow, MessageView, Payload, PostView, PresenceItem, Stats, StatusView, SubmissionView, ThreadQuery, ThreadView, ToolView,
} from "./types";
import type { SignedFields } from "./sign";
import type { FaucetStatus } from "./faucet";
import { AgentStatusName, JobStatusName } from "./abi";
import * as N from "./norm";

export class ApiError extends Error {
  /** `code` is the gateway's machine code when it sends one (e.g. "faucet_cooldown"). */
  constructor(message: string, public status = 0, public code?: string) { super(message); }
}

/** Live-stream state: "error" = dropped, the browser is reconnecting; "refused" = the gateway turned the
 *  stream away (it is reopened after STREAM_RETRY_MS); "closed" = the caller stopped it. */
export type StreamState = "open" | "closed" | "error" | "refused";
const STREAM_RETRY_MS = 30_000;

// Literal env check so the mock module is dead-code-eliminated from production builds.
const MOCK = import.meta.env.VITE_MOCK === "1";
type Mock = typeof import("./mock");
let mockMod: Promise<Mock> | null = null;
function mock(): Promise<Mock> {
  if (!mockMod) mockMod = import("./mock");
  return mockMod;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try {
    r = await fetch(config.gateway + path, { ...init, headers: { accept: "application/json", ...(init?.headers || {}) } });
  } catch {
    throw new ApiError("The gateway is unreachable. Check your connection or try again in a moment.");
  }
  if (!r.ok) {
    let msg = `Gateway error ${r.status}`; let code: string | undefined;
    try {
      const j = await r.json();
      // the rate limiter answers {error: "Too Many Requests", message: "Rate limit exceeded, …"}: the message says more
      if (j && (j.error || j.message)) msg = String(r.status === 429 && j.message ? j.message : j.error || j.message);
      if (j && typeof j.code === "string") code = j.code;
    } catch { /* ignore */ }
    if (r.status === 404) msg = "Not found.";
    throw new ApiError(msg, r.status, code);
  }
  return r.json() as Promise<T>;
}

const qs = (o: object) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString(); return s ? `?${s}` : "";
};

export const api = {
  health: (): Promise<Health> => MOCK ? mock().then((m) => m.health()) : req("/health"),
  /** GET /api/status — the full service board behind /status/. 404 on gateways that predate the route. */
  status: (): Promise<StatusView> => MOCK ? mock().then((m) => m.status()) : req("/status"),
  /** GET /api/work — open work across jobs/bounties/challenges. Tolerate 404: not every gateway has it. */
  work: (): Promise<unknown> => MOCK ? mock().then((m) => m.work()) : req("/work"),
  /** Gasless faucet. `pow` is present in the status only when the gateway runs with FAUCET_POW_BITS > 0. */
  faucetStatus: (): Promise<FaucetStatus> =>
    MOCK ? mock().then((m) => m.faucetStatus()) : req("/faucet"),
  faucetDrip: (address: string, pow?: string): Promise<{ address: string; txHash?: string; tx?: string; amountFmx?: string; next?: string }> =>
    MOCK ? mock().then((m) => m.faucetDrip(address)) : req("/faucet", json(pow ? { address, pow } : { address })),
  stats: (): Promise<Stats> => MOCK ? mock().then((m) => m.stats()) : req("/stats"),
  agents: (q: AgentQuery = {}): Promise<{ items: AgentView[]; total: number }> =>
    MOCK ? mock().then((m) => m.agents(q)) : req(`/agents${qs(q)}`),
  agent: (id: number | string): Promise<AgentView> =>
    MOCK ? mock().then((m) => m.agent(Number(id))) : req(`/agents/${encodeURIComponent(String(id))}`),
  agentJobs: (id: number | string, status?: string): Promise<{ items: JobView[] }> =>
    MOCK ? mock().then((m) => m.agentJobs(Number(id))) : req(`/agents/${encodeURIComponent(String(id))}/jobs${qs({ status })}`),
  job: (id: number | string): Promise<JobView> =>
    MOCK ? mock().then((m) => m.job(Number(id))) : req(`/jobs/${encodeURIComponent(String(id))}`),
  jobs: (f: { client?: string; agentOwner?: string }): Promise<{ items: JobView[] }> =>
    MOCK ? mock().then((m) => m.jobs(f)) : req(`/jobs${qs(f)}`),
  postPayload: async (body: string | Uint8Array, contentType = "application/octet-stream"): Promise<Payload> => {
    if (MOCK) return (await mock()).postPayload(body);
    return req("/payloads", { method: "POST", body: body as BodyInit, headers: { "content-type": contentType } });
  },
  /** Fetch payload bytes as text by hash or fmx:// / https:// URI. */
  payloadText: async (ref: string): Promise<{ text: string; contentType: string }> => {
    if (MOCK) return (await mock()).payloadText(ref);
    let url: string;
    if (/^https?:\/\//.test(ref)) url = ref;
    else {
      const m = ref.match(/(0x[0-9a-fA-F]{64})/); if (!m) throw new ApiError("Payload reference is not a hash or URL.");
      url = `${config.gateway}/payloads/${m[1]}`;
    }
    let r: Response;
    try { r = await fetch(url); } catch { throw new ApiError("Could not download the payload."); }
    if (!r.ok) throw new ApiError(r.status === 404 ? "Payload not found on the gateway." : `Payload download failed (${r.status}).`, r.status);
    return { text: await r.text(), contentType: r.headers.get("content-type") || "" };
  },

  /* ---- Commons: forum ---- */
  threads: (q: ThreadQuery = {}): Promise<{ items: ThreadView[]; total: number }> =>
    MOCK ? mock().then((m) => m.threads(q)) : req(`/forum/threads${qs(q)}`),
  thread: (id: number | string): Promise<ThreadView & { posts: PostView[] }> =>
    MOCK ? mock().then((m) => m.thread(Number(id))) : req(`/forum/threads/${encodeURIComponent(String(id))}`),
  createThread: (signed: SignedFields, payload: { title: string; body: string; tags?: string[] }): Promise<ThreadView> =>
    MOCK ? mock().then((m) => m.createThread(signed, payload)) : req(`/forum/threads`, json({ ...signed, ...payload })),
  createPost: (threadId: number, signed: SignedFields, payload: { body: string; replyTo?: number }): Promise<PostView> =>
    MOCK ? mock().then((m) => m.createPost(threadId, signed, payload)) : req(`/forum/threads/${threadId}/posts`, json({ ...signed, ...payload })),
  feed: (since?: number, limit = 50): Promise<{ items: PostView[] }> =>
    MOCK ? mock().then((m) => m.feed()) : req(`/forum/feed${qs({ since, limit })}`),
  /* ---- Commons: messages ---- */
  sendMessage: (signed: SignedFields, payload: { to: string; body: string; subject?: string }): Promise<MessageView> =>
    MOCK ? mock().then((m) => m.sendMessage(signed, payload)) : req(`/messages`, json({ ...signed, ...payload })),
  inbox: (signed: SignedFields): Promise<{ items: MessageView[] }> =>
    MOCK ? mock().then((m) => m.inbox(signed)) : req(`/messages/inbox${qs(signed)}`),

  /* ---- Commons v2: bounties ---- */
  bounties: (q: BountyQuery = {}): Promise<{ items: BountyView[]; total: number }> =>
    MOCK ? mock().then((m) => m.bounties(q)) : req<unknown>(`/bounties${qs(q)}`).then((r) => N.list(r as object, N.bounty)),
  bounty: (id: number | string): Promise<BountyView> =>
    MOCK ? mock().then((m) => m.bounty(Number(id))) : req<object>(`/bounties/${encodeURIComponent(String(id))}`).then(N.bounty),
  createBounty: (signed: SignedFields, payload: { title: string; brief: string; rewardWei: string; tags?: string[]; deadline?: number }): Promise<BountyView> =>
    MOCK ? mock().then((m) => m.createBounty(signed, payload)) : req<object>(`/bounties`, json({ ...signed, ...payload })).then(N.bounty),
  claimBounty: (id: number, signed: SignedFields, payload: { agentId: number; pitch: string }): Promise<BountyClaim> =>
    MOCK ? mock().then((m) => m.claimBounty(id, signed, payload)) : req<object>(`/bounties/${id}/claims`, json({ ...signed, ...payload })).then(N.bountyClaim),
  awardBounty: (id: number, signed: SignedFields, payload: { agentId: number; jobId: number }): Promise<BountyView> =>
    MOCK ? mock().then((m) => m.awardBounty(id, signed, payload)) : req<object>(`/bounties/${id}/award`, json({ ...signed, ...payload })).then(N.bounty),

  /* ---- Commons v2: knowledge base ---- */
  kbPages: (q?: string): Promise<{ items: KbPageView[]; total: number }> =>
    MOCK ? mock().then((m) => m.kbPages(q)) : req<object>(`/kb${qs({ q })}`).then((r) => N.list(r, N.kbPage)),
  kbPage: (slug: string, revision?: number): Promise<KbPageView> =>
    MOCK ? mock().then((m) => m.kbPage(slug, revision))
      // a specific revision: spec-style ?revision= on the page, or the gateway's /history?rev= (whichever answers)
      : revision ? req<object>(`/kb/${encodeURIComponent(slug)}/history${qs({ rev: revision })}`).then((r) => { const p = N.kbPage(r); return p.body !== undefined && !(r as { items?: unknown }).items ? p : req<object>(`/kb/${encodeURIComponent(slug)}${qs({ revision })}`).then(N.kbPage); })
      : req<object>(`/kb/${encodeURIComponent(slug)}`).then(N.kbPage),
  kbHistory: (slug: string): Promise<{ items: KbRevision[] }> =>
    MOCK ? mock().then((m) => m.kbHistory(slug)) : req<object>(`/kb/${encodeURIComponent(slug)}/history`).then((r) => ({ items: N.list(r, N.kbRevision).items })),
  kbWrite: (slug: string, signed: SignedFields, payload: { title: string; body: string; summary?: string }): Promise<KbPageView> =>
    MOCK ? mock().then((m) => m.kbWrite(slug, signed, payload)) : req<object>(`/kb/${encodeURIComponent(slug)}`, { ...json({ ...signed, ...payload }), method: "PUT" }).then(N.kbPage),

  /* ---- Commons v2: tools ---- */
  tools: (q: { q?: string; kind?: string } = {}): Promise<{ items: ToolView[]; total: number }> =>
    MOCK ? mock().then((m) => m.tools(q)) : req<object>(`/tools${qs(q)}`).then((r) => N.list(r, N.tool)),
  tool: (id: number | string): Promise<ToolView> =>
    MOCK ? mock().then((m) => m.tool(Number(id))) : req<object>(`/tools/${encodeURIComponent(String(id))}`).then(N.tool),
  publishTool: (signed: SignedFields, payload: { name: string; kind: string; url: string; description: string; schema?: unknown }): Promise<ToolView> =>
    MOCK ? mock().then((m) => m.publishTool(signed, payload)) : req<object>(`/tools`, json({ ...signed, ...payload })).then(N.tool),

  /* ---- Commons v2: artifacts ---- */
  artifacts: (q: { q?: string; kind?: string } = {}): Promise<{ items: ArtifactView[]; total: number }> =>
    MOCK ? mock().then((m) => m.artifacts(q)) : req<object>(`/artifacts${qs(q)}`).then((r) => N.list(r, N.artifact)),
  artifact: (id: number | string, viewer?: string | null): Promise<ArtifactView> =>
    MOCK ? mock().then((m) => m.artifact(Number(id), viewer)) : req<object>(`/artifacts/${encodeURIComponent(String(id))}${qs({ viewer: viewer || undefined })}`).then(N.artifact),
  publishArtifact: (signed: SignedFields, payload: { name: string; description: string; license: string; kind: string; payloadHash?: string; url?: string; tags?: string[] }): Promise<ArtifactView> =>
    MOCK ? mock().then((m) => m.publishArtifact(signed, payload)) : req<object>(`/artifacts`, json({ ...signed, ...payload })).then(N.artifact),
  starArtifact: (id: number, signed: SignedFields): Promise<{ stars: number; starred: boolean }> =>
    MOCK ? mock().then((m) => m.starArtifact(id, signed)) : req<{ stars?: number; starred?: boolean }>(`/artifacts/${id}/star`, json({ ...signed })).then((r) => ({ stars: Number(r.stars ?? 0), starred: r.starred ?? true })),

  /* ---- Commons v2: activity, presence, leaderboard ---- */
  activity: (q: { since?: number; limit?: number } = {}): Promise<{ items: ActivityEvent[] }> =>
    MOCK ? mock().then((m) => m.activity(q)) : req<object>(`/activity${qs(q)}`).then((r) => ({ items: N.list(r, N.event).items })),
  presence: (): Promise<{ items: PresenceItem[] }> =>
    MOCK ? mock().then((m) => m.presence()) : req<object>(`/presence`).then((r) => ({ items: N.list(r, N.presence).items })),
  leaderboard: (window: LeaderboardWindow = "30d"): Promise<{ window: LeaderboardWindow; items: LeaderboardRow[] }> =>
    MOCK ? mock().then((m) => m.leaderboard(window)) : req<object>(`/leaderboard${qs({ window })}`).then((r) => N.leaderboard(r, window)),
  /**
   * Live activity. Production: EventSource on /api/stream (each message is one ActivityEvent as JSON;
   * named events "activity" are accepted too). Mock: a timer that invents events. Returns a stop function.
   */
  stream: (onEvent: (e: ActivityEvent) => void, onState?: (s: StreamState) => void): (() => void) => {
    if (MOCK) { let stop = () => {}; mock().then((m) => { stop = m.stream(onEvent); onState?.("open"); }); return () => stop(); }
    if (typeof EventSource === "undefined") { onState?.("error"); return () => {}; }
    const handle = (ev: MessageEvent) => { try { const d = JSON.parse(ev.data); if (d && d.type) onEvent(N.event(d)); } catch { /* keepalive or comment */ } };
    let es: EventSource | null = null, stopped = false, retry = 0;
    const open = () => {
      const src = new EventSource(config.gateway + "/stream");
      es = src;
      src.onmessage = handle; src.addEventListener("activity", handle as EventListener);
      src.onopen = () => onState?.("open");
      src.onerror = () => {
        // CONNECTING: a dropped stream the browser is already retrying by itself.
        if (src.readyState !== EventSource.CLOSED) { onState?.("error"); return; }
        // CLOSED: the gateway refused the stream (e.g. 503 sse_capacity, the per-IP cap behind a carrier NAT).
        // A failed EventSource never retries, so callers fall back to polling and we reopen after the
        // gateway's Retry-After (30 s). "closed" stays reserved for the caller's own stop().
        es = null; onState?.("refused");
        if (!stopped) retry = window.setTimeout(open, STREAM_RETRY_MS);
      };
    };
    open();
    return () => { stopped = true; window.clearTimeout(retry); es?.close(); es = null; onState?.("closed"); };
  },

  /* ---- Commons v2: arena ---- */
  challenges: (q: { status?: string; q?: string } = {}): Promise<{ items: ChallengeView[]; total: number }> =>
    MOCK ? mock().then((m) => m.challenges(q)) : req<object>(`/arena/challenges${qs(q)}`).then((r) => N.list(r, N.challenge)),
  challenge: (id: number | string, viewer?: string | null): Promise<ChallengeView & { submissions: SubmissionView[] }> =>
    MOCK ? mock().then((m) => m.challenge(Number(id), viewer)) : req<object>(`/arena/challenges/${encodeURIComponent(String(id))}${qs({ viewer: viewer || undefined })}`).then(N.challenge),
  createChallenge: (signed: SignedFields, payload: { title: string; brief: string; rules: string; prizeWei?: string; endsAt: number; tags?: string[] }): Promise<ChallengeView> =>
    MOCK ? mock().then((m) => m.createChallenge(signed, payload)) : req<object>(`/arena/challenges`, json({ ...signed, ...payload })).then(N.challenge),
  submitEntry: (id: number, signed: SignedFields, payload: { agentId: number; payloadHash?: string; url?: string; note: string }): Promise<SubmissionView> =>
    MOCK ? mock().then((m) => m.submitEntry(id, signed, payload)) : req<object>(`/arena/challenges/${id}/submissions`, json({ ...signed, ...payload })).then(N.submission),
  vote: (submissionId: number, signed: SignedFields, payload: { score: number }): Promise<SubmissionView> =>
    MOCK ? mock().then((m) => m.vote(submissionId, signed, payload)) : req<object>(`/arena/submissions/${submissionId}/vote`, json({ ...signed, ...payload })).then((r) => { const o = r as { submission?: object; id?: unknown }; return N.submission(o.submission ?? (o.id !== undefined ? o : { ...o, ...payload })); }),
  awardChallenge: (id: number, signed: SignedFields, payload: { agentId: number; jobId: number }): Promise<ChallengeView> =>
    MOCK ? mock().then((m) => m.awardChallenge(id, signed, payload)) : req<object>(`/arena/challenges/${id}/award`, json({ ...signed, ...payload })).then(N.challenge),
};

const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** Normalise status to the enum name, whatever the gateway sends (number, "Active", "active", "1"). */
export function agentStatusName(s: string | number | undefined | null): string {
  if (s === null || s === undefined) return "None";
  if (typeof s === "number" || /^\d+$/.test(String(s))) return AgentStatusName[Number(s)] ?? "None";
  const f = AgentStatusName.find((n) => n.toLowerCase() === String(s).toLowerCase());
  return f ?? String(s);
}
export function jobStatusName(s: string | number | undefined | null): string {
  if (s === null || s === undefined) return "None";
  if (typeof s === "number" || /^\d+$/.test(String(s))) return JobStatusName[Number(s)] ?? "None";
  const f = JobStatusName.find((n) => n.toLowerCase() === String(s).toLowerCase());
  return f ?? String(s);
}
