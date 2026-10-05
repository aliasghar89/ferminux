// POST /inbox — receives direct messages forwarded by the gateway
// ({id, from:{address,name,agentId}, to, subject, body, createdAt}), appends
// them to $DATA_DIR/inbox.jsonl, and (AGENT_AUTOREPLY=1 + llm handler) answers
// through fmx.messages.send with loop guards.
//
// The route is reachable by anyone (nginx proxies /a/<slug>/* to the runtime), and the forwarded body is not
// signed, so nothing in it can be trusted: before auto-replying, the runtime re-reads the message from the
// gateway with a signed inbox read (fmx.messages.inbox) and answers ONLY that copy — its sender, subject and
// body. A forged POST (made-up sender, prompt-injection body, or an unknown id) is stored and never answered.
// Also: a 64 KiB body limit, inbox.jsonl rotated at INBOX_MAX_BYTES, a global AGENT_AUTOREPLY_MAX_PER_HOUR
// budget on top of the per-sender cap, one reply per message id, no auto-reply while the agent is Paused, and
// at most one signed inbox read per INBOX_VERIFY_INTERVAL_MS however many POSTs arrive.
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { Ferminux } from "@ferminux/agent";
import type { Handler } from "./handlers/util.js";

export const AUTOREPLY_MIN_INTERVAL_MS = 60_000;
export const AUTOREPLY_MAX_DEPTH = 2; // "Re: Re: …" and deeper is never answered (cuts agent↔agent ping-pong)
export const INBOX_BODY_LIMIT = 64 * 1024;
export const INBOX_MAX_BYTES_DEFAULT = 10 * 1024 * 1024;
export const AUTOREPLY_MAX_PER_HOUR_DEFAULT = 20;
/** at most one signed gateway inbox read per this many ms, whatever the number of POSTs waiting on it */
export const INBOX_VERIFY_INTERVAL_MS = 5_000;
/** ids waiting for that read; past this a POST is stored but not queued (bounds memory while a read hangs) */
export const INBOX_VERIFY_QUEUE_MAX = 10_000;

export interface InboundMessage {
  id?: number;
  from?: { address?: string; name?: string | null; agentId?: number | null } | string;
  to?: unknown;
  subject?: string;
  body?: string;
  createdAt?: number;
}

/** One message as the gateway's signed inbox read returns it. */
export interface InboxItem {
  id: number;
  from: { address: string; name?: string | null } | string;
  to: { address: string } | string;
  subject?: string;
  body?: string;
}

/** The slice of the SDK the inbox uses (tests pass a stub). */
export interface InboxClient {
  requireSigner(): { address: string };
  messages: {
    send(m: { to: string; body: string; subject?: string }): Promise<unknown>;
    inbox?(p?: { limit?: number }): Promise<{ items: InboxItem[] }>;
  };
}

export interface InboxOptions {
  fmx: Ferminux | InboxClient;
  inboxPath: string;
  agentName: () => string;
  agentId: number;
  /** built-in name, or the path passed to `--handler ./handler.js` */
  handlerName: string;
  handler: Handler;
  autoreply: boolean;
  /** false while the agent is Paused/Retired on-chain: messages are stored, never auto-answered */
  isActive?: () => boolean;
  /** inbox.jsonl is rotated to inbox.jsonl.1 past this size (INBOX_MAX_BYTES, default 10 MiB) */
  maxInboxBytes?: number;
  /** global auto-reply budget (AGENT_AUTOREPLY_MAX_PER_HOUR, default 20) */
  maxRepliesPerHour?: number;
  /** minimum ms between two signed inbox reads (default INBOX_VERIFY_INTERVAL_MS) */
  verifyIntervalMs?: number;
  /** injectable clock for tests */
  now?: () => number;
}

export function fromAddress(msg: InboundMessage): string | null {
  if (typeof msg.from === "string") return msg.from;
  if (msg.from && typeof msg.from === "object" && typeof msg.from.address === "string") return msg.from.address;
  return null;
}

export function replyDepth(subject: string | undefined): number {
  let depth = 0;
  let s = (subject ?? "").trim();
  while (/^re:\s*/i.test(s)) {
    depth++;
    s = s.replace(/^re:\s*/i, "");
  }
  return depth;
}

export function appendInbox(path: string, record: unknown, maxBytes = INBOX_MAX_BYTES_DEFAULT): void {
  mkdirSync(dirname(path), { recursive: true });
  // anyone can POST here: never let the file grow without bound (one previous generation is kept)
  try {
    if (existsSync(path) && statSync(path).size >= maxBytes) renameSync(path, `${path}.1`);
  } catch {
    // rotation is best effort
  }
  appendFileSync(path, `${JSON.stringify(record)}\n`);
}

function addr(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof (v as { address?: unknown }).address === "string") return (v as { address: string }).address;
  return null;
}

/** The newest 100 messages to this agent, from ONE signed gateway inbox read ([] when the client has none). */
async function inboxItems(fmx: InboxOptions["fmx"]): Promise<InboxItem[]> {
  const inbox = (fmx as InboxClient).messages.inbox;
  if (typeof inbox !== "function") return [];
  return (await inbox.call((fmx as InboxClient).messages, { limit: 100 })).items;
}

/** The gateway's own copy of message `id` among `items`, addressed to `own` — or null (a forged POST). */
function trustedCopy(items: InboxItem[], id: number, own: string): InboundMessage | null {
  const m = items.find((x) => x.id === id);
  if (!m) return null;
  if ((addr(m.to) ?? "").toLowerCase() !== own.toLowerCase()) return null;
  return { id: m.id, from: typeof m.from === "string" ? { address: m.from } : m.from, subject: m.subject, body: m.body };
}

/**
 * The gateway's own copy of message `id`, addressed to `own` — or null when the gateway has no such message
 * (a forged POST). Reads the newest 100 messages with a signed inbox read.
 */
export async function trustedMessage(fmx: InboxOptions["fmx"], id: unknown, own: string): Promise<InboundMessage | null> {
  if (typeof id !== "number" || !Number.isSafeInteger(id)) return null;
  return trustedCopy(await inboxItems(fmx), id, own);
}

/** Decides whether an inbound message gets an auto-reply. Pure — unit-tested. */
export function shouldAutoReply(
  msg: InboundMessage,
  ownAddress: string,
  lastReplyBySender: Map<string, number>,
  nowMs: number,
  minIntervalMs = AUTOREPLY_MIN_INTERVAL_MS,
): { ok: true; sender: string } | { ok: false; reason: string } {
  const sender = fromAddress(msg);
  if (!sender) return { ok: false, reason: "no sender address" };
  if (sender.toLowerCase() === ownAddress.toLowerCase()) return { ok: false, reason: "message from self" };
  if (!msg.body || !String(msg.body).trim()) return { ok: false, reason: "empty body" };
  if (replyDepth(msg.subject) >= AUTOREPLY_MAX_DEPTH) return { ok: false, reason: "reply chain too deep" };
  const key = sender.toLowerCase();
  const last = lastReplyBySender.get(key) ?? 0;
  if (nowMs - last < minIntervalMs) return { ok: false, reason: `rate cap: 1 auto-reply per sender per ${minIntervalMs / 1000}s` };
  return { ok: true, sender };
}

export function registerInbox(app: FastifyInstance, opts: InboxOptions): void {
  const now = opts.now ?? (() => Date.now());
  const lastReplyBySender = new Map<string, number>();
  const repliedIds = new Set<number>();
  let replyTimes: number[] = [];
  const ownAddress = opts.fmx.requireSigner().address;
  const maxInboxBytes = opts.maxInboxBytes ?? (Number(process.env.INBOX_MAX_BYTES) > 0 ? Number(process.env.INBOX_MAX_BYTES) : INBOX_MAX_BYTES_DEFAULT);
  const maxPerHour = opts.maxRepliesPerHour ?? (Number(process.env.AGENT_AUTOREPLY_MAX_PER_HOUR) > 0 ? Number(process.env.AGENT_AUTOREPLY_MAX_PER_HOUR) : AUTOREPLY_MAX_PER_HOUR_DEFAULT);
  const verifyIntervalMs = opts.verifyIntervalMs ?? INBOX_VERIFY_INTERVAL_MS;

  // Forwarded ids waiting for the gateway to confirm them, each with the log of the POST that queued it.
  // Verifying is the one thing a forged POST makes the runtime do, and each check is a signed gateway read that
  // shares the gateway's per-IP rate limit with the job loop: one read per POST let a flood of fresh forged ids
  // push the agent into 429s, so its jobs.input reads failed and paid jobs were declined. Reads are therefore
  // coalesced (one read checks every queued id) and start at most once per verifyIntervalMs.
  const queued = new Map<number, FastifyBaseLogger>();
  /** ids in the read that is running now: a re-sent forward must not start a second reply */
  let inFlight = new Set<number>();
  let reading = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastReadAt = Number.NEGATIVE_INFINITY;

  const schedule = (): void => {
    if (reading || timer || queued.size === 0) return;
    timer = setTimeout(() => {
      timer = null;
      verifyQueued().catch((err) => app.log.error({ err }, "auto-reply verification failed"));
    }, Math.max(0, lastReadAt + verifyIntervalMs - now()));
    timer.unref?.();
  };

  const verifyQueued = async (): Promise<void> => {
    reading = true;
    lastReadAt = now();
    const batch = new Map(queued);
    queued.clear();
    inFlight = new Set(batch.keys());
    try {
      let items: InboxItem[];
      try {
        items = await inboxItems(opts.fmx);
      } catch (err) {
        for (const [id, log] of batch) log.error({ err, id }, "auto-reply failed: the signed inbox read failed");
        return;
      }
      // The hourly budget and the answered-id set are spent only once the gateway confirms the message: spent on
      // the unverified POST, anyone could exhaust the budget, or mark the next (sequential) message ids as already
      // answered, with forged messages the gateway never sent.
      for (const [id, log] of batch) {
        const trusted = trustedCopy(items, id, ownAddress);
        if (!trusted) {
          log.warn({ id }, "auto-reply refused: the gateway has no such message to this agent (forged or unknown id)");
          continue;
        }
        const again = shouldAutoReply(trusted, ownAddress, lastReplyBySender, now());
        if (!again.ok) {
          log.info({ id, reason: again.reason }, "auto-reply skipped (trusted copy)");
          continue;
        }
        const t2 = now();
        replyTimes = replyTimes.filter((x) => t2 - x < 3_600_000);
        if (replyTimes.length >= maxPerHour) {
          log.warn({ id, maxPerHour }, "auto-reply skipped: hourly budget spent");
          continue;
        }
        replyTimes.push(t2);
        if (repliedIds.size >= 5000) repliedIds.clear();
        repliedIds.add(id);
        lastReplyBySender.set(again.sender.toLowerCase(), t2);
        autoReply(opts, trusted, again.sender).catch((err) => log.error({ err, id }, "auto-reply failed"));
      }
    } finally {
      inFlight = new Set();
      reading = false;
      schedule();
    }
  };

  app.post("/inbox", { bodyLimit: INBOX_BODY_LIMIT }, async (req, reply) => {
    const msg = (req.body ?? {}) as InboundMessage;
    if (!msg || typeof msg !== "object") return reply.code(400).send({ ok: false, error: "JSON body required" });
    const record = { receivedAt: Math.floor(now() / 1000), ...msg };
    try {
      appendInbox(opts.inboxPath, record, maxInboxBytes);
    } catch (err) {
      req.log.error({ err }, "inbox append failed");
    }
    const sender = fromAddress(msg);
    req.log.info({ id: msg.id, from: sender, subject: msg.subject ?? "" }, "inbox message received");

    let willReply = false;
    if (opts.autoreply && opts.handlerName === "llm") {
      if (opts.isActive && !opts.isActive()) {
        req.log.info({ id: msg.id }, "auto-reply skipped: agent is not Active");
      } else if (typeof msg.id !== "number" || !Number.isSafeInteger(msg.id)) {
        req.log.info({ id: msg.id }, "auto-reply skipped: no gateway message id to verify");
      } else if (repliedIds.has(msg.id) || queued.has(msg.id) || inFlight.has(msg.id)) {
        req.log.info({ id: msg.id }, "auto-reply skipped: already answered this message");
      } else {
        // cheap pre-checks on the claimed fields first; the trusted copy is checked again once it is read
        const decision = shouldAutoReply(msg, ownAddress, lastReplyBySender, now());
        const t = now();
        replyTimes = replyTimes.filter((x) => t - x < 3_600_000);
        if (!decision.ok) {
          req.log.info({ id: msg.id, reason: decision.reason }, "auto-reply skipped");
        } else if (replyTimes.length >= maxPerHour) {
          req.log.warn({ id: msg.id, maxPerHour }, "auto-reply skipped: hourly budget spent");
        } else if (queued.size >= INBOX_VERIFY_QUEUE_MAX) {
          req.log.warn({ id: msg.id }, "auto-reply skipped: too many messages waiting for the gateway to confirm them");
        } else {
          // verified and answered asynchronously — never block the gateway's 5 s forward timeout
          willReply = true;
          queued.set(msg.id, req.log);
          schedule();
        }
      }
    }
    return { ok: true, id: msg.id ?? null, autoreply: willReply };
  });
}

async function autoReply(opts: InboxOptions, msg: InboundMessage, sender: string): Promise<void> {
  const fromName = typeof msg.from === "object" && msg.from?.name ? `${msg.from.name} (${sender})` : sender;
  const system =
    `You are "${opts.agentName()}", agent #${opts.agentId} on the Ferminux Network (a blockchain where AI agents ` +
    `sell services for FMX). You are replying to a direct message from another agent or a human on the network. ` +
    `Answer helpfully and keep it short (a few sentences). If they ask what you do, describe your service and ` +
    `that they can hire you through the Ferminux escrow. Do not include greetings/sign-offs longer than a few words.` +
    (process.env.AGENT_PROMPT ? `\n\nYour service description: ${process.env.AGENT_PROMPT}` : "");
  const user = `From: ${fromName}\nSubject: ${msg.subject ?? "(none)"}\n\n${msg.body ?? ""}`;
  const result = await opts.handler({ messages: [{ role: "system", content: system }, { role: "user", content: user }] });
  const output = typeof result.output === "string" ? result.output.trim() : "";
  if (!output) return;
  const subject = msg.subject && msg.subject.trim() ? `Re: ${msg.subject.trim()}` : `Re: message to ${opts.agentName()}`;
  await (opts.fmx as InboxClient).messages.send({ to: sender, body: output.slice(0, 16_000), subject: subject.slice(0, 200) });
}
