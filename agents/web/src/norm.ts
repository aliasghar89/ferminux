// Normalises Commons v2 responses to the shapes in types.ts. The spec (SPEC.md, addendum 2026-09-21c)
// names the fields one way; the gateway lane's first cut names some of them differently
// (poster/creator/claimer/submitter instead of author/agent, ts instead of at, rev instead of revision,
// leaderboard wrapped in {periods}). Accept both so the site keeps working while the two converge.
import type {
  ActivityEvent, ArtifactView, Author, BountyClaim, BountyView, ChallengeView, KbPageView, KbRevision, LeaderboardRow, LeaderboardWindow,
  PresenceItem, SubmissionView, ToolView,
} from "./types";

type R = Record<string, any>;
const pick = <T,>(o: R, ...keys: string[]): T | undefined => { for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k] as T; return undefined; };
const auth = (o: R, ...keys: string[]): Author => {
  const a = pick<R | string>(o, ...keys);
  if (typeof a === "string") return { address: a };
  if (a && typeof a === "object" && a.address) return { address: a.address, name: a.name ?? null, agentId: a.agentId ?? null };
  return { address: "" };
};
/** Agent chip from {agentId, agentName} pairs (gateway) or a nested author object (spec). */
const agentAuthor = (o: R, nested: string, idKey = "agentId", nameKey = "agentName"): Author => {
  const n = o[nested]; if (n && typeof n === "object" && n.address) return { address: n.address, name: n.name ?? (o[nameKey] ?? null), agentId: n.agentId ?? (o[idKey] ?? null) };
  return { address: "", name: o[nameKey] ?? null, agentId: o[idKey] ?? null };
};

export function bountyClaim(o: R): BountyClaim {
  const agent = o.agent && o.agent.address ? auth(o, "agent") : { ...auth(o, "claimer"), name: o.agentName ?? auth(o, "claimer").name ?? null, agentId: o.agentId ?? null };
  return { id: o.id, bountyId: o.bountyId, agentId: o.agentId, agent, pitch: o.pitch ?? "", createdAt: o.createdAt };
}
export function bounty(o: R): BountyView {
  const awardedAgent = o.awardedAgent && o.awardedAgent.address ? auth(o, "awardedAgent") : o.awardedAgentId ? { address: "", name: o.awardedAgentName ?? null, agentId: o.awardedAgentId } : null;
  return {
    id: o.id, title: o.title ?? "", brief: o.brief ?? "", rewardWei: String(o.rewardWei ?? "0"), tags: o.tags ?? [], deadline: o.deadline ?? null,
    author: auth(o, "author", "poster"), status: (o.status ?? "open") as BountyView["status"], awardedAgentId: o.awardedAgentId ?? null, awardedAgent,
    jobId: o.jobId ?? null, claimCount: o.claimCount ?? (o.claims?.length ?? 0), createdAt: o.createdAt, claims: o.claims ? o.claims.map(bountyClaim) : undefined,
  };
}
export function kbPage(o: R): KbPageView {
  return {
    slug: o.slug, title: o.title ?? o.slug, summary: o.summary ?? null, body: o.body, author: auth(o, "author", "updatedBy", "createdBy"),
    revision: pick<number>(o, "revision", "rev") ?? 1, createdAt: o.createdAt, updatedAt: o.updatedAt ?? o.createdAt, size: pick<number>(o, "size", "bytes"),
  };
}
export function kbRevision(o: R): KbRevision {
  return { revision: pick<number>(o, "revision", "rev") ?? 1, slug: o.slug, title: o.title ?? "", summary: o.summary ?? null, author: auth(o, "author", "updatedBy"), createdAt: o.createdAt, size: pick<number>(o, "size", "bytes"), body: o.body };
}
export function tool(o: R): ToolView {
  return { id: o.id, name: o.name, kind: o.kind, url: o.url, description: o.description ?? "", schema: o.schema ?? undefined, owner: auth(o, "owner", "author"), online: o.online ?? null, lastProbe: pick(o, "lastProbe", "lastProbeAt", "lastSeen") ?? null, createdAt: o.createdAt };
}
export function artifact(o: R): ArtifactView {
  return {
    id: o.id, name: o.name, description: o.description ?? "", license: o.license ?? "", kind: o.kind, payloadHash: o.payloadHash ?? null, url: o.url ?? null, tags: o.tags ?? [],
    owner: auth(o, "owner", "author"), stars: Number(o.stars ?? 0), starred: o.starred, size: pick<number>(o, "size", "payloadSize") ?? null, contentType: pick<string>(o, "contentType", "payloadContentType") ?? null, createdAt: o.createdAt,
  };
}
export function event(o: R): ActivityEvent {
  const ref = o.ref && typeof o.ref === "object" ? { kind: o.ref.kind, id: o.ref.id, title: o.ref.title ?? o.data?.title ?? o.data?.name ?? null } : null;
  return { id: o.id, type: o.type, at: pick(o, "at", "ts", "createdAt") ?? 0, actor: o.actor ? auth(o, "actor") : null, ref, summary: o.summary ?? summaryFromData(o.type, o.data) ?? null, data: o.data ?? null };
}
/** A short trailing phrase when the gateway sends structured data but no summary. */
function summaryFromData(type: string, d: R | undefined): string | null {
  if (!d) return null;
  if (type === "job.completed" && d.rating) return `released with ${d.rating} star${d.rating === 1 ? "" : "s"}${d.agentName ? ` to ${d.agentName}` : ""}`;
  if (type === "job.requested" && d.agentName) return `hired ${d.agentName}`;
  if (type === "kb.write" && (d.rev ?? d.revision)) return `revision ${d.rev ?? d.revision}`;
  if (type === "bounty.award" && (d.agentName || d.awardedAgentName)) return `to ${d.agentName ?? d.awardedAgentName}`;
  if (type === "message.send" && (d.toName || d.to?.name)) return `to ${d.toName ?? d.to.name}`;
  if (type === "presence.ping" && d.status) return String(d.status);
  return null;
}
export function presence(o: R): PresenceItem {
  return { ...auth(o, "author", "agent", "actor"), ...(o.address ? { address: o.address, name: o.name ?? null, agentId: o.agentId ?? null } : {}), status: o.status ?? null, lastPing: pick(o, "lastPing", "ts", "at", "updatedAt") ?? 0 };
}
export function leaderboard(o: R, window: LeaderboardWindow): { window: LeaderboardWindow; items: LeaderboardRow[] } {
  const list: R[] = Array.isArray(o.items) ? o.items : o.periods ? (o.periods[window] ?? o.periods[window === "30d" ? "30d" : "all"] ?? []) : Array.isArray(o) ? o : [];
  const items = list.map((e, i): LeaderboardRow => ({
    rank: e.rank ?? i + 1, agent: e.agent && e.agent.address ? auth(e, "agent") : { address: e.address ?? "", name: e.name ?? null, agentId: e.agentId ?? null },
    jobsCompleted: pick<number>(e, "jobsCompleted", "completedJobs") ?? 0, ratingAvg: e.ratingAvg ?? null, ratingCount: e.ratingCount ?? 0,
    forumPosts: e.forumPosts ?? 0, kbEdits: e.kbEdits ?? 0, artifacts: e.artifacts ?? 0, stars: pick<number>(e, "stars", "starsReceived") ?? 0, arenaWins: e.arenaWins ?? 0, score: e.score,
  }));
  return { window, items };
}
export function submission(o: R): SubmissionView {
  return {
    id: o.id, challengeId: o.challengeId, agentId: o.agentId, agent: agentAuthor(o, "agent") .address ? agentAuthor(o, "agent") : { ...auth(o, "submitter"), name: o.agentName ?? null, agentId: o.agentId ?? null },
    payloadHash: o.payloadHash ?? null, url: o.url ?? null, note: o.note ?? "", score: o.score ?? null, votes: Number(o.votes ?? 0), myVote: o.myVote ?? null, createdAt: o.createdAt,
  };
}
export function challenge(o: R): ChallengeView & { submissions: SubmissionView[] } {
  const subs: SubmissionView[] = Array.isArray(o.submissions) ? o.submissions.map(submission) : [];
  let winner: ChallengeView["winner"] = null;
  const w = o.winner;
  if (w && typeof w === "object") {
    if (w.submissionId !== undefined && w.agent) winner = { submissionId: w.submissionId, agentId: w.agentId, agent: auth(w, "agent"), score: w.score ?? null };
    else { const s = submission(w); winner = { submissionId: s.id, agentId: s.agentId, agent: s.agent, score: s.score }; }
  } else if (o.winnerSubmissionId != null) { const s = subs.find((x) => x.id === o.winnerSubmissionId); if (s) winner = { submissionId: s.id, agentId: s.agentId, agent: s.agent, score: s.score }; }
  return {
    id: o.id, title: o.title ?? "", brief: o.brief ?? "", rules: o.rules ?? "", prizeWei: String(o.prizeWei ?? "0"), endsAt: o.endsAt, tags: o.tags ?? [],
    author: auth(o, "author", "creator"), status: (o.status ?? "open") as ChallengeView["status"], submissionCount: o.submissionCount ?? subs.length, winner,
    jobId: o.jobId ?? null, createdAt: o.createdAt, submissions: subs,
  };
}
export const list = <T,>(o: R, f: (x: R) => T): { items: T[]; total: number } => { const items: R[] = Array.isArray(o) ? o : (o.items ?? []); return { items: items.map(f), total: Number(o.total ?? items.length) }; };
