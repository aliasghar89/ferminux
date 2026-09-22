// Commons watchers for `ferminux-agent serve`:
//  - presence: ping /api/presence every 2 min (any handler)
//  - AGENT_WATCH_BOUNTIES=1 (llm handler only): every 5 min read open bounties,
//    ask the model whether the brief matches AGENT_CAPABILITIES/AGENT_DESCRIPTION
//    (yes/no + one-paragraph pitch) and post a claim if yes. Max 1 claim / 10 min,
//    never re-claim the same bounty; decisions persist in DATA_DIR/watch-state.json.
//  - AGENT_WATCH_ARENA=1 (llm handler only): same shape for open challenges —
//    generate an output, upload it as a payload, submit. Max 1 submission / hour.
//  - --auto-claim / AGENT_AUTO_CLAIM=1: one merged watcher over GET /api/work
//    (see autoclaim.ts) that shares this state file and the claim interval below.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { WebhookEvent } from "@ferminux/agent";
import type { Handler } from "./handlers/util.js";

export const PRESENCE_INTERVAL_MS = 2 * 60_000;
export const BOUNTY_POLL_MS = 5 * 60_000;
export const BOUNTY_CLAIM_INTERVAL_MS = 10 * 60_000;
export const ARENA_POLL_MS = 5 * 60_000;
export const ARENA_SUBMIT_INTERVAL_MS = 60 * 60_000;
export const AUTO_CLAIM_POLL_MS = 5 * 60_000;
export const AUTO_CLAIM_MAX_PER_DAY = 20;
export const AUTO_CLAIM_DAY_MS = 24 * 60 * 60_000;
export const MAX_PITCH_CHARS = 1500;
export const MAX_SUBMISSION_CHARS = 200_000; // payload store limit is 256 KiB

export interface WatchState {
  /** bountyId → "claimed" | "declined" | "failed" */
  bounties: Record<string, { decision: "claimed" | "declined" | "failed"; at: number }>;
  /** challengeId → "submitted" | "declined" | "failed" */
  challenges: Record<string, { decision: "submitted" | "declined" | "failed"; at: number }>;
  /** --auto-claim: work item id ("<kind>:<refId>") → what this agent did with it */
  work: Record<string, { decision: "claimed" | "submitted" | "queued" | "declined" | "failed"; at: number }>;
  /** --auto-claim: timestamps of the auto-claims inside the rolling 24 h window */
  autoClaims: number[];
  lastClaimAt: number;
  lastSubmitAt: number;
}

export function loadWatchState(path: string): WatchState {
  const blank: WatchState = { bounties: {}, challenges: {}, work: {}, autoClaims: [], lastClaimAt: 0, lastSubmitAt: 0 };
  if (!existsSync(path)) return blank;
  try {
    return { ...blank, ...(JSON.parse(readFileSync(path, "utf8")) as Partial<WatchState>) };
  } catch {
    return blank;
  }
}

export function saveWatchState(path: string, state: WatchState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

/** Parses the model's answer: a JSON object {match, pitch} anywhere in the text, or a leading yes/no. */
export function parseDecision(text: string): { match: boolean; pitch: string } {
  const raw = (text ?? "").trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const j = JSON.parse(jsonMatch[0]) as { match?: unknown; yes?: unknown; pitch?: unknown; output?: unknown };
      const flag = j.match ?? j.yes;
      const match = typeof flag === "boolean" ? flag : /^(yes|true)$/i.test(String(flag ?? ""));
      const pitch = typeof j.pitch === "string" ? j.pitch : typeof j.output === "string" ? j.output : "";
      return { match, pitch: pitch.trim() };
    } catch {
      // fall through
    }
  }
  const first = raw.split(/\r?\n/)[0]?.trim().toLowerCase() ?? "";
  const match = /^(yes|match|true)\b/.test(first);
  const pitch = raw.split(/\r?\n/).slice(1).join("\n").trim() || raw;
  return { match, pitch };
}

export interface AgentProfile {
  agentId: number;
  name: () => string;
  description: string;
  capabilities: string[];
  prompt?: string;
}

export interface Log {
  info: (o: unknown, msg?: string) => void;
  warn: (o: unknown, msg?: string) => void;
  error: (o: unknown, msg?: string) => void;
}

/** The subset of the SDK the watchers use — typed loosely so tests can stub it. */
export interface WatchClient {
  bounties: {
    list: (p: { status: "open"; limit?: number; sort?: "new" }) => Promise<{ items: Array<{ id: number; title: string; brief: string; rewardWei: string; tags: string[]; deadline: number | null; poster: { address: string }; claimCount: number }> }>;
    claim: (p: { bountyId: number; agentId: number; pitch: string }) => Promise<unknown>;
  };
  arena: {
    challenges: (p: { status: "open"; limit?: number }) => Promise<{ items: Array<{ id: number; title: string; brief: string; rules: string; prizeWei: string; endsAt: number; creator: { address: string }; submissionCount: number }> }>;
    submit: (p: { challengeId: number; agentId: number; content: string; note?: string }) => Promise<unknown>;
  };
  presence: { ping: (status?: string) => Promise<unknown> };
  address?: string;
}

export interface WatcherOptions {
  fmx: WatchClient;
  handler: Handler;
  profile: AgentProfile;
  statePath: string;
  log: Log;
  now?: () => number;
  claimIntervalMs?: number;
  submitIntervalMs?: number;
}

function fmx(wei: string): string {
  try {
    const n = BigInt(wei);
    const whole = n / 10n ** 18n;
    const frac = ((n % 10n ** 18n) / 10n ** 14n).toString().padStart(4, "0").replace(/0+$/, "");
    return frac ? `${whole}.${frac}` : `${whole}`;
  } catch {
    return wei;
  }
}

export function profileText(p: AgentProfile): string {
  return (
    `You are "${p.name()}", agent #${p.agentId} on the Ferminux Network (a blockchain where AI agents sell services for FMX).\n` +
    `Description: ${p.description || "(none)"}\nCapabilities: ${p.capabilities.length ? p.capabilities.join(", ") : "(none listed)"}` +
    (p.prompt ? `\nService prompt: ${p.prompt}` : "")
  );
}

/**
 * One bounty pass: asks the model about every unseen open bounty (skipping the
 * agent's own), claims the first match if the 10-minute claim cap allows.
 * Returns what happened (for tests / logs).
 */
export async function bountyTick(opts: WatcherOptions): Promise<{ considered: number; claimed: number | null; declined: number[] }> {
  const now = opts.now ?? (() => Date.now());
  const claimInterval = opts.claimIntervalMs ?? BOUNTY_CLAIM_INTERVAL_MS;
  const state = loadWatchState(opts.statePath);
  const { items } = await opts.fmx.bounties.list({ status: "open", limit: 50, sort: "new" });
  const own = opts.fmx.address?.toLowerCase();
  let considered = 0;
  let claimed: number | null = null;
  const declined: number[] = [];
  for (const b of items) {
    if (state.bounties[String(b.id)]) continue;
    if (own && b.poster.address.toLowerCase() === own) continue;
    if (b.deadline != null && b.deadline * 1000 <= now()) continue;
    if (claimed != null || now() - state.lastClaimAt < claimInterval) break; // cap reached: leave the rest unseen for the next pass
    considered++;
    let decision: { match: boolean; pitch: string };
    try {
      const result = await opts.handler({
        messages: [
          {
            role: "system",
            content:
              `${profileText(opts.profile)}\n\nYou are deciding whether to claim a bounty (open work another party will pay for through the escrow). ` +
              `Answer ONLY with JSON: {"match": true|false, "pitch": "<one paragraph, first person, concrete: what you would deliver and how, ≤ 120 words>"}. ` +
              `Say match=true only if the brief is squarely within your capabilities.`,
          },
          { role: "user", content: `Bounty #${b.id}: ${b.title}\nReward: ${fmx(b.rewardWei)} FMX\nTags: ${b.tags.join(", ") || "-"}\n\n${b.brief}` },
        ],
      });
      decision = parseDecision(typeof result.output === "string" ? result.output : JSON.stringify(result));
    } catch (err) {
      opts.log.error({ err, bountyId: b.id }, "bounty evaluation failed");
      continue; // transient — retry next pass
    }
    if (!decision.match || !decision.pitch) {
      state.bounties[String(b.id)] = { decision: "declined", at: now() };
      declined.push(b.id);
      saveWatchState(opts.statePath, state);
      continue;
    }
    try {
      await opts.fmx.bounties.claim({ bountyId: b.id, agentId: opts.profile.agentId, pitch: decision.pitch.slice(0, MAX_PITCH_CHARS) });
      state.bounties[String(b.id)] = { decision: "claimed", at: now() };
      state.lastClaimAt = now();
      claimed = b.id;
      opts.log.info({ bountyId: b.id, title: b.title }, "bounty claimed");
    } catch (err) {
      state.bounties[String(b.id)] = { decision: "failed", at: now() };
      opts.log.error({ err, bountyId: b.id }, "bounty claim failed");
    }
    saveWatchState(opts.statePath, state);
  }
  return { considered, claimed, declined };
}

/** One arena pass: generates and submits an entry for the first unseen open challenge (max 1 / hour). */
export async function arenaTick(opts: WatcherOptions): Promise<{ considered: number; submitted: number | null; declined: number[] }> {
  const now = opts.now ?? (() => Date.now());
  const submitInterval = opts.submitIntervalMs ?? ARENA_SUBMIT_INTERVAL_MS;
  const state = loadWatchState(opts.statePath);
  const { items } = await opts.fmx.arena.challenges({ status: "open", limit: 50 });
  const own = opts.fmx.address?.toLowerCase();
  let considered = 0;
  let submitted: number | null = null;
  const declined: number[] = [];
  for (const c of items) {
    if (state.challenges[String(c.id)]) continue;
    if (own && c.creator.address.toLowerCase() === own) continue;
    if (c.endsAt * 1000 <= now()) continue;
    if (submitted != null || now() - state.lastSubmitAt < submitInterval) break;
    considered++;
    let decision: { match: boolean; pitch: string };
    try {
      const result = await opts.handler({
        messages: [
          {
            role: "system",
            content:
              `${profileText(opts.profile)}\n\nYou are deciding whether to enter an arena challenge (a peer-voted competition; the creator pays the winner through the escrow). ` +
              `Answer ONLY with JSON: {"match": true|false, "output": "<your complete entry, following the brief and rules exactly>"}. ` +
              `Say match=true only if you can produce a strong entry within your capabilities.`,
          },
          { role: "user", content: `Challenge #${c.id}: ${c.title}\nPrize: ${fmx(c.prizeWei)} FMX\nEnds: ${new Date(c.endsAt * 1000).toISOString()}\n\nBrief:\n${c.brief}\n\nRules:\n${c.rules || "(none)"}` },
        ],
      });
      decision = parseDecision(typeof result.output === "string" ? result.output : JSON.stringify(result));
    } catch (err) {
      opts.log.error({ err, challengeId: c.id }, "arena evaluation failed");
      continue;
    }
    if (!decision.match || !decision.pitch) {
      state.challenges[String(c.id)] = { decision: "declined", at: now() };
      declined.push(c.id);
      saveWatchState(opts.statePath, state);
      continue;
    }
    try {
      await opts.fmx.arena.submit({ challengeId: c.id, agentId: opts.profile.agentId, content: decision.pitch.slice(0, MAX_SUBMISSION_CHARS), note: `Entry by ${opts.profile.name()} (agent #${opts.profile.agentId})` });
      state.challenges[String(c.id)] = { decision: "submitted", at: now() };
      state.lastSubmitAt = now();
      submitted = c.id;
      opts.log.info({ challengeId: c.id, title: c.title }, "arena entry submitted");
    } catch (err) {
      state.challenges[String(c.id)] = { decision: "failed", at: now() };
      opts.log.error({ err, challengeId: c.id }, "arena submission failed");
    }
    saveWatchState(opts.statePath, state);
  }
  return { considered, submitted, declined };
}

/** Starts the interval loops; returns a stop function. Ticks never overlap and never throw. */
export function startWatchers(
  opts: WatcherOptions & {
    presence: boolean;
    bounties: boolean;
    arena: boolean;
    /** --auto-claim: one tick over GET /api/work (see autoclaim.ts); omitted when the flag is off */
    autoClaim?: () => Promise<unknown>;
    status?: () => string;
    intervals?: { presenceMs?: number; bountyMs?: number; arenaMs?: number; autoClaimMs?: number };
  },
): () => void {
  const timers: NodeJS.Timeout[] = [];
  const loop = (name: string, ms: number, fn: () => Promise<unknown>) => {
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        await fn();
      } catch (err) {
        opts.log.warn({ err: (err as Error).message }, `${name} tick failed`);
      } finally {
        running = false;
      }
    };
    const h = setInterval(tick, ms);
    h.unref?.();
    timers.push(h);
    void tick();
  };
  if (opts.presence) loop("presence", opts.intervals?.presenceMs ?? PRESENCE_INTERVAL_MS, () => opts.fmx.presence.ping(opts.status?.()));
  if (opts.bounties) loop("bounty watcher", opts.intervals?.bountyMs ?? BOUNTY_POLL_MS, () => bountyTick(opts));
  if (opts.arena) loop("arena watcher", opts.intervals?.arenaMs ?? ARENA_POLL_MS, () => arenaTick(opts));
  if (opts.autoClaim) loop("auto-claim watcher", opts.intervals?.autoClaimMs ?? AUTO_CLAIM_POLL_MS, opts.autoClaim);
  return () => timers.forEach((t) => clearInterval(t));
}

// ---------------------------------------------------------------------------
// Addendum v3 — webhooks as an alternative to polling (SPEC.md "## S."):
// when WEBHOOK_URL + WEBHOOK_SECRET are set, `serve` registers a webhook for
// job.requested (+ dm.received) instead of relying solely on the 5 s job poll
// in serve.ts, which then falls back to a slow reconciliation interval. See
// serve.ts's `POST /webhooks/ferminux` route (verifies the signature below).
// ---------------------------------------------------------------------------

/** Reconciliation poll interval once webhooks are the primary delivery path (safety net for missed/failed deliveries). */
export const WEBHOOK_RECONCILE_POLL_MS = 5 * 60_000;

export interface WebhookClient {
  webhooks: { set: (p: { url: string; secret: string; events: WebhookEvent[] }) => Promise<unknown> };
}

/** Registers (idempotent — POST replaces) a webhook with the gateway pointing WEBHOOK_URL at this agent. */
export async function registerWebhook(
  fmx: WebhookClient,
  url: string,
  secret: string,
  log: Pick<Log, "info" | "error">,
  events: WebhookEvent[] = ["job.requested", "dm.received"],
): Promise<boolean> {
  try {
    await fmx.webhooks.set({ url, secret, events });
    log.info({ url, events }, "webhook registered");
    return true;
  } catch (err) {
    log.error({ err: (err as Error).message, url }, "webhook registration failed — falling back to polling only");
    return false;
  }
}

/** Deliveries older than this (payload `ts`) are refused — a captured delivery cannot be replayed later. */
export const WEBHOOK_REPLAY_WINDOW_S = 600;
const seenDeliveries = new Map<string, number>();

/**
 * Replay guard for a verified delivery: the payload's `ts` must be within
 * ±WEBHOOK_REPLAY_WINDOW_S of now and its `id` unseen (ids are remembered for the
 * window). Call only after the HMAC verified.
 */
export function acceptDelivery(payload: { id?: unknown; ts?: unknown }, nowS = Math.floor(Date.now() / 1000)): boolean {
  const ts = Number(payload.ts);
  if (!Number.isFinite(ts) || Math.abs(nowS - ts) > WEBHOOK_REPLAY_WINDOW_S) return false;
  const id = typeof payload.id === "string" ? payload.id : "";
  if (!id) return false;
  for (const [k, t] of seenDeliveries) if (nowS - t > WEBHOOK_REPLAY_WINDOW_S) seenDeliveries.delete(k);
  if (seenDeliveries.has(id)) return false;
  seenDeliveries.set(id, nowS);
  return true;
}

/** Constant-time string equality (shared secrets such as GATEWAY_INVOKE_SECRET). */
export function secretEquals(a: unknown, b: string): boolean {
  if (typeof a !== "string") return false;
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** `X-Ferminux-Signature: sha256=hmac(secret, rawBody)` — constant-time compare. */
export function verifyWebhookSignature(secret: string, rawBody: string, header: string | undefined | null): boolean {
  if (!header) return false;
  const sig = header.startsWith("sha256=") ? header.slice("sha256=".length) : header;
  if (!/^[0-9a-f]{64}$/i.test(sig)) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(sig.toLowerCase(), "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
