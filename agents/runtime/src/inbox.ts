// POST /inbox — receives direct messages forwarded by the gateway
// ({id, from:{address,name,agentId}, to, subject, body, createdAt}), appends
// them to $DATA_DIR/inbox.jsonl, and (AGENT_AUTOREPLY=1 + llm handler) answers
// through fmx.messages.send with loop guards.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { FastifyInstance } from "fastify";
import type { Ferminux } from "@ferminux/agent";
import type { Handler } from "./handlers/util.js";

export const AUTOREPLY_MIN_INTERVAL_MS = 60_000;
export const AUTOREPLY_MAX_DEPTH = 2; // "Re: Re: …" and deeper is never answered (cuts agent↔agent ping-pong)

export interface InboundMessage {
  id?: number;
  from?: { address?: string; name?: string | null; agentId?: number | null } | string;
  to?: unknown;
  subject?: string;
  body?: string;
  createdAt?: number;
}

export interface InboxOptions {
  fmx: Ferminux;
  inboxPath: string;
  agentName: () => string;
  agentId: number;
  /** built-in name, or the path passed to `--handler ./handler.js` */
  handlerName: string;
  handler: Handler;
  autoreply: boolean;
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

export function appendInbox(path: string, record: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`);
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
  const ownAddress = opts.fmx.requireSigner().address;

  app.post("/inbox", async (req, reply) => {
    const msg = (req.body ?? {}) as InboundMessage;
    if (!msg || typeof msg !== "object") return reply.code(400).send({ ok: false, error: "JSON body required" });
    const record = { receivedAt: Math.floor(now() / 1000), ...msg };
    try {
      appendInbox(opts.inboxPath, record);
    } catch (err) {
      req.log.error({ err }, "inbox append failed");
    }
    const sender = fromAddress(msg);
    req.log.info({ id: msg.id, from: sender, subject: msg.subject ?? "" }, "inbox message received");

    let willReply = false;
    if (opts.autoreply && opts.handlerName === "llm") {
      const decision = shouldAutoReply(msg, ownAddress, lastReplyBySender, now());
      if (decision.ok) {
        willReply = true;
        lastReplyBySender.set(decision.sender.toLowerCase(), now());
        // reply asynchronously — never block the gateway's 5 s forward timeout
        void autoReply(opts, msg, decision.sender).catch((err) => {
          req.log.error({ err, id: msg.id }, "auto-reply failed");
        });
      } else {
        req.log.info({ id: msg.id, reason: decision.reason }, "auto-reply skipped");
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
  await opts.fmx.messages.send({ to: sender, body: output.slice(0, 16_000), subject: subject.slice(0, 200) });
}
