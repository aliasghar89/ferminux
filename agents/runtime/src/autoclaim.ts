// `ferminux-agent serve --auto-claim` (env AGENT_AUTO_CLAIM=1).
//
// One merged watcher over the gateway's `GET /api/work` feed — every job,
// bounty, arena challenge, open question and paid endpoint an agent can earn
// from, in a single list. Each pass:
//   1. asks /api/work for the items matching this agent's capability text
//      (AGENT_CAPABILITIES + AGENT_DESCRIPTION) and agent id,
//   2. drops the ones already decided (state is shared with watch.ts, so the
//      bounty/arena watchers and this one never act on the same item twice),
//   3. asks the handler whether the brief is squarely in scope and for a pitch,
//   4. acts: `bounty` → bounties.claim, `arena` → arena.submit, `job` → nothing
//      but a log line, because serve.ts's poll/webhook path already delivers
//      jobs addressed to this agent id (double delivery is the one thing an
//      auto-claimer must never do).
//
// Rate limits reuse watch.ts's `lastClaimAt` machinery: at most one auto-claim
// per AUTO_CLAIM interval (default 10 min) and a hard cap of
// AGENT_AUTO_CLAIM_MAX_PER_DAY (default 20) inside a rolling 24 h window.
// Decisions live in the DATA_DIR watch-state file, so a restart never re-claims.
//
// `--dry-run` (AGENT_AUTO_CLAIM_DRY_RUN=1) logs exactly what it would claim —
// item id, title, reward and the pitch — and writes nothing, on disk or on-chain.
import {
  loadWatchState,
  saveWatchState,
  parseDecision,
  profileText,
  AUTO_CLAIM_DAY_MS,
  AUTO_CLAIM_MAX_PER_DAY,
  BOUNTY_CLAIM_INTERVAL_MS,
  MAX_PITCH_CHARS,
  MAX_SUBMISSION_CHARS,
  type AgentProfile,
  type Log,
  type WatchClient,
  type WatchState,
} from "./watch.js";
import type { Handler } from "./handlers/util.js";

/** The kinds `GET /api/work` returns. */
export type WorkKind = "job" | "bounty" | "arena" | "question" | "endpoint";

/** One row of `GET /api/work` (gateway contract). */
export interface WorkItem {
  kind: WorkKind;
  /** "<kind>:<refId>", stable */
  id: string;
  refId: number;
  title: string;
  summary: string;
  tags: string[];
  /** wei decimal string; "0" when there is no fixed reward */
  rewardWei: string;
  rewardFmx: string;
  postedAt: number;
  deadline: number | null;
  /** set for kind "job" — the agent it is addressed to */
  agentId: number | null;
  claims: number;
  /** who posted it (bounty poster, arena creator, job client) — gateway sends an Author */
  requester?: { address?: string | null } | null;
  url: string;
  api: string;
  /** one line: how to earn it */
  action: string;
}

export interface WorkQuery {
  capability?: string;
  /** wei decimal string */
  minReward?: string;
  /** comma-separated subset of WorkKind */
  kind?: string;
  agentId?: number;
  limit?: number;
  offset?: number;
}

export interface WorkList {
  items: WorkItem[];
  total: number;
  counts: Partial<Record<WorkKind, number>>;
  now: number;
}

/** The slice of the gateway the auto-claimer uses — narrow so tests can stub it (cf. WatchClient). */
export interface WorkClient {
  list: (query: WorkQuery) => Promise<WorkList>;
}

/** Kinds the runtime can act on unattended. `question` / `endpoint` are informational here. */
export const ACTIONABLE_KINDS: readonly WorkKind[] = ["job", "bounty", "arena"];

/** Default page size asked of `/api/work` (the route caps at 200). */
export const AUTO_CLAIM_LIMIT = 50;

/**
 * Plain `fetch` against the gateway — the SDK will grow `fmx.work.list()`, and
 * this is the one place to swap when it lands.
 */
export function httpWorkClient(gatewayUrl: string): WorkClient {
  const base = gatewayUrl.replace(/\/+$/, "");
  return {
    async list(query: WorkQuery): Promise<WorkList> {
      const params = new URLSearchParams();
      if (query.capability) params.set("capability", query.capability);
      if (query.minReward) params.set("minReward", query.minReward);
      if (query.kind) params.set("kind", query.kind);
      if (query.agentId != null) params.set("agentId", String(query.agentId));
      if (query.limit != null) params.set("limit", String(query.limit));
      if (query.offset != null) params.set("offset", String(query.offset));
      const qs = params.toString();
      const res = await fetch(`${base}/work${qs ? `?${qs}` : ""}`);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Ferminux: gateway GET /work failed (${res.status}): ${body}`);
      }
      return (await res.json()) as WorkList;
    },
  };
}

/** The free-text `capability` query sent to /api/work: the capability list first, then the description. */
export function buildCapabilityQuery(capabilities: string[], description: string): string {
  const caps = capabilities.map((c) => c.trim()).filter(Boolean);
  const desc = (description || "").replace(/\s+/g, " ").trim();
  const parts: string[] = [];
  if (caps.length) parts.push(caps.join(" "));
  if (desc) parts.push(desc);
  return parts.join(" ").slice(0, 200).trim();
}

/**
 * Cheap local pre-filter so an off-topic item never costs a model call. An
 * agent that lists no capabilities takes everything the gateway sent.
 */
export function matchesProfile(item: Pick<WorkItem, "title" | "summary" | "tags">, capabilities: string[]): boolean {
  const caps = capabilities.map((c) => c.trim().toLowerCase()).filter((c) => c.length >= 2);
  if (!caps.length) return true;
  const hay = `${item.title} ${item.summary} ${(item.tags ?? []).join(" ")}`.toLowerCase();
  return caps.some((c) => hay.includes(c));
}

export interface AutoClaimOptions {
  fmx: WatchClient;
  work: WorkClient;
  handler: Handler;
  profile: AgentProfile;
  statePath: string;
  log: Log;
  now?: () => number;
  /** min gap between two auto-claims (default 10 min, shared with the bounty watcher) */
  claimIntervalMs?: number;
  /** hard cap inside a rolling 24 h window (default 20) */
  maxPerDay?: number;
  /** log what would be claimed; write nothing */
  dryRun?: boolean;
  /** wei decimal string passed straight to /api/work */
  minRewardWei?: string;
  limit?: number;
  /** kinds to act on (AGENT_AUTO_CLAIM_KINDS, default job,bounty,arena) — e.g. "job,arena" keeps a house agent off the bounties */
  kinds?: WorkKind[];
  /** never claim work posted by these addresses (AGENT_AUTO_CLAIM_SKIP_POSTERS) — e.g. the operator's own growth bounties */
  skipPosters?: string[];
}

/** "job, arena" → ["job","arena"], keeping only actionable kinds; empty/invalid → the default. */
export function parseKinds(v: string | undefined): WorkKind[] | undefined {
  const kinds = (v ?? "").split(",").map((k) => k.trim().toLowerCase()).filter((k): k is WorkKind => (ACTIONABLE_KINDS as readonly string[]).includes(k));
  return kinds.length ? kinds : undefined;
}

export interface AutoClaimPreview {
  id: string;
  kind: WorkKind;
  title: string;
  rewardFmx: string;
  pitch: string;
}

export interface AutoClaimResult {
  /** items that reached the model */
  considered: number;
  /** bounty ids claimed this pass */
  claimed: number[];
  /** arena challenge ids entered this pass */
  submitted: number[];
  /** job ids left to serve.ts's delivery loop */
  queued: number[];
  /** work item ids the model turned down */
  declined: string[];
  /** --dry-run: exactly what would have been claimed */
  wouldClaim: AutoClaimPreview[];
  /** items filtered out before the model (wrong kind, expired, off-profile, already decided) */
  skipped: number;
  /** true when a cap (interval or per-day) ended the pass early */
  capped: boolean;
}

function prune(times: unknown, now: number): number[] {
  if (!Array.isArray(times)) return [];
  return times.filter((t): t is number => typeof t === "number" && now - t < AUTO_CLAIM_DAY_MS);
}

/** Bounty/arena decisions are mirrored into watch.ts's own maps so the two watchers never act twice. */
function legacyKey(item: WorkItem): "bounties" | "challenges" | null {
  return item.kind === "bounty" ? "bounties" : item.kind === "arena" ? "challenges" : null;
}

/** Writes the same decision into watch.ts's `bounties` / `challenges` map (each has its own decision union). */
function markLegacy(state: WatchState, item: WorkItem, decision: "claimed" | "submitted" | "declined" | "failed", at: number): void {
  if (item.kind === "bounty") {
    if (decision !== "submitted") state.bounties[String(item.refId)] = { decision, at };
  } else if (item.kind === "arena") {
    if (decision !== "claimed") state.challenges[String(item.refId)] = { decision, at };
  }
}

/**
 * One auto-claim pass. Returns what happened (for tests / logs); never throws
 * on a single item — a failed claim is recorded, a failed model call is left
 * for the next pass.
 */
export async function autoClaimTick(opts: AutoClaimOptions): Promise<AutoClaimResult> {
  const now = opts.now ?? (() => Date.now());
  const claimInterval = opts.claimIntervalMs ?? BOUNTY_CLAIM_INTERVAL_MS;
  const maxPerDay = opts.maxPerDay ?? AUTO_CLAIM_MAX_PER_DAY;
  const dryRun = opts.dryRun === true;
  const state = loadWatchState(opts.statePath);
  state.work = state.work ?? {};
  state.autoClaims = prune(state.autoClaims, now());

  const result: AutoClaimResult = {
    considered: 0,
    claimed: [],
    submitted: [],
    queued: [],
    declined: [],
    wouldClaim: [],
    skipped: 0,
    capped: false,
  };

  const kinds: readonly WorkKind[] = opts.kinds?.length ? opts.kinds.filter((k) => ACTIONABLE_KINDS.includes(k)) : ACTIONABLE_KINDS;
  const skipPosters = new Set((opts.skipPosters ?? []).map((a) => a.trim().toLowerCase()).filter(Boolean));
  const capability = buildCapabilityQuery(opts.profile.capabilities, opts.profile.description);
  const { items } = await opts.work.list({
    capability: capability || undefined,
    minReward: opts.minRewardWei,
    kind: kinds.join(","),
    agentId: opts.profile.agentId,
    limit: opts.limit ?? AUTO_CLAIM_LIMIT,
  });

  // Caps are tracked in memory as well so --dry-run reports the same decisions
  // it would really make, without persisting anything.
  let lastClaimAt = state.lastClaimAt;
  let claimTimes = state.autoClaims;

  for (const item of items) {
    const key = item.id;
    const legacy = legacyKey(item);
    if (state.work[key]) {
      result.skipped++;
      continue;
    }
    if (legacy && state[legacy][String(item.refId)]) {
      result.skipped++; // the bounty / arena watcher already handled this one
      continue;
    }
    if (!kinds.includes(item.kind)) {
      result.skipped++;
      continue;
    }
    // A house agent claiming its own operator's growth bounties signals to outside agents that the rewards are
    // already taken (2026-09-23: Wizrd claimed 7 of 8 in 100 minutes). Jobs addressed to us are never skipped.
    const poster = item.requester?.address?.toLowerCase();
    if (item.kind !== "job" && poster && skipPosters.has(poster)) {
      result.skipped++;
      continue;
    }
    if (item.deadline != null && item.deadline * 1000 <= now()) {
      result.skipped++;
      continue;
    }

    // Jobs addressed to this agent are already delivered by serve.ts's poll /
    // webhook path — record and log them, never act on them here.
    if (item.kind === "job") {
      if (item.agentId !== opts.profile.agentId) {
        result.skipped++;
        continue;
      }
      result.queued.push(item.refId);
      opts.log.info({ jobId: item.refId, title: item.title, rewardFmx: item.rewardFmx }, "auto-claim: job addressed to this agent — the serve loop delivers it");
      if (!dryRun) {
        state.work[key] = { decision: "queued", at: now() };
        saveWatchState(opts.statePath, state);
      }
      continue;
    }

    if (!matchesProfile(item, opts.profile.capabilities)) {
      result.skipped++;
      continue;
    }

    if (now() - lastClaimAt < claimInterval) {
      result.capped = true;
      break; // leave the rest unseen for the next pass
    }
    claimTimes = prune(claimTimes, now());
    if (claimTimes.length >= maxPerDay) {
      result.capped = true;
      opts.log.warn({ maxPerDay, window: "24h" }, "auto-claim: daily cap reached");
      break;
    }

    result.considered++;
    const isArena = item.kind === "arena";
    let decision: { match: boolean; pitch: string };
    try {
      const out = await opts.handler({
        messages: [
          {
            role: "system",
            content:
              `${profileText(opts.profile)}\n\nYou are deciding whether to take on open work from the network's work feed. ` +
              (isArena
                ? `This is an arena challenge (a peer-voted competition; the creator pays the winner through the escrow). ` +
                  `Answer ONLY with JSON: {"match": true|false, "output": "<your complete entry, following the brief and rules exactly>"}. ` +
                  `Say match=true only if you can produce a strong entry within your capabilities.`
                : `This is a bounty (open work another party will pay for through the escrow). ` +
                  `Answer ONLY with JSON: {"match": true|false, "pitch": "<one paragraph, first person, concrete: what you would deliver and how, ≤ 120 words>"}. ` +
                  `Say match=true only if the brief is squarely within your capabilities.`),
          },
          {
            role: "user",
            content:
              `${item.kind === "arena" ? "Challenge" : "Bounty"} #${item.refId}: ${item.title}\n` +
              `Reward: ${item.rewardFmx} FMX\nTags: ${item.tags.join(", ") || "-"}\n` +
              (item.deadline != null ? `Deadline: ${new Date(item.deadline * 1000).toISOString()}\n` : "") +
              `How it is earned: ${item.action}\n\n${item.summary}`,
          },
        ],
      });
      decision = parseDecision(typeof out.output === "string" ? out.output : JSON.stringify(out));
    } catch (err) {
      opts.log.error({ err, item: key }, "auto-claim evaluation failed");
      continue; // transient — retry next pass
    }

    if (!decision.match || !decision.pitch) {
      result.declined.push(key);
      if (!dryRun) {
        state.work[key] = { decision: "declined", at: now() };
        markLegacy(state, item, "declined", now());
        saveWatchState(opts.statePath, state);
      }
      continue;
    }

    if (dryRun) {
      const preview: AutoClaimPreview = {
        id: key,
        kind: item.kind,
        title: item.title,
        rewardFmx: item.rewardFmx,
        pitch: decision.pitch.slice(0, isArena ? MAX_SUBMISSION_CHARS : MAX_PITCH_CHARS),
      };
      result.wouldClaim.push(preview);
      opts.log.info(preview, "auto-claim dry run: would claim");
      lastClaimAt = now();
      claimTimes = [...claimTimes, now()];
      continue;
    }

    try {
      if (isArena) {
        await opts.fmx.arena.submit({
          challengeId: item.refId,
          agentId: opts.profile.agentId,
          content: decision.pitch.slice(0, MAX_SUBMISSION_CHARS),
          note: `Entry by ${opts.profile.name()} (agent #${opts.profile.agentId})`,
        });
        result.submitted.push(item.refId);
        opts.log.info({ challengeId: item.refId, title: item.title }, "auto-claim: arena entry submitted");
      } else {
        await opts.fmx.bounties.claim({
          bountyId: item.refId,
          agentId: opts.profile.agentId,
          pitch: decision.pitch.slice(0, MAX_PITCH_CHARS),
        });
        result.claimed.push(item.refId);
        opts.log.info({ bountyId: item.refId, title: item.title, rewardFmx: item.rewardFmx }, "auto-claim: bounty claimed");
      }
      const decided = isArena ? "submitted" : "claimed";
      state.work[key] = { decision: decided, at: now() };
      markLegacy(state, item, decided, now());
      lastClaimAt = now();
      claimTimes = [...claimTimes, now()];
      state.lastClaimAt = lastClaimAt;
      if (isArena) state.lastSubmitAt = now();
      state.autoClaims = claimTimes;
    } catch (err) {
      state.work[key] = { decision: "failed", at: now() };
      markLegacy(state, item, "failed", now());
      opts.log.error({ err, item: key }, "auto-claim action failed");
    }
    saveWatchState(opts.statePath, state);
  }

  return result;
}
