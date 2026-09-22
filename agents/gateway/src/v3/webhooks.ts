// Webhooks: an address registers {url, secret, events}; the gateway POSTs
// JSON for every matching event with `X-Ferminux-Signature: sha256=hmac(secret, body)`,
// retrying 3 times (10 s, 60 s, 10 min) and logging every attempt in
// `webhook_deliveries`. Event sources: the indexer (via the activity bus and
// the v3 event handlers) and the Commons hooks (dm.received, bounty.claimed).
import { createHmac, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db.js";
import type { ActivityBus, ActivityEvent } from "../commons/activity.js";
import { HttpError, type Author, type CommonsContext } from "../commons/context.js";
import { safeFetch } from "../net.js";

export const WEBHOOK_EVENTS = [
  "job.requested",
  "job.delivered",
  "job.completed",
  "job.refunded",
  "job.disputed",
  "dm.received",
  "bounty.claimed",
  "stream.opened",
  "sub.created",
  "case.opened",
  "validation.done",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** retry back-off after the first attempt: 10 s, 60 s, 10 min (3 retries) */
export const WEBHOOK_RETRY_S = [10, 60, 600] as const;
export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_MAX_PER_OWNER = 10;
export const WEBHOOK_SECRET_MIN = 16;
export const WEBHOOK_SECRET_MAX = 128;
export const WEBHOOK_DELIVERY_RETENTION_S = 30 * 86_400;

export interface WebhookRow {
  id: number;
  owner: string;
  url: string;
  secret: string;
  events: string;
  active: number;
  createdAt: number;
  updatedAt: number;
}
export interface WebhookView {
  id: number;
  owner: Author;
  url: string;
  events: WebhookEvent[];
  active: boolean;
  /** first 4 chars of the secret, for recognition only */
  secretHint: string;
  createdAt: number;
  updatedAt: number;
  deliveries: { pending: number; ok: number; failed: number };
}
export interface DeliveryRow {
  id: number;
  webhookId: number;
  owner: string;
  event: string;
  payload: string;
  status: "pending" | "ok" | "failed";
  attempts: number;
  nextAt: number;
  lastStatus: number | null;
  lastError: string | null;
  createdAt: number;
  deliveredAt: number | null;
  dedupKey: string | null;
}

export function signWebhook(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

function addrOf(v: unknown): string | null {
  if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) return v;
  if (v && typeof v === "object" && typeof (v as Author).address === "string") return (v as Author).address;
  return null;
}

export class WebhookBus {
  private readonly hooksFor;
  private readonly insertDelivery;
  private readonly due;
  private readonly markOk;
  private readonly markRetry;
  private readonly markFailed;
  private readonly prune;

  constructor(
    readonly db: Db,
    private readonly now: () => number = () => Date.now(),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.hooksFor = db.prepare(
      "SELECT * FROM webhooks WHERE lower(owner) = lower(?) AND active = 1 AND EXISTS (SELECT 1 FROM json_each(events) WHERE value = ?)",
    );
    this.insertDelivery = db.prepare(
      "INSERT OR IGNORE INTO webhook_deliveries (webhookId, owner, event, payload, status, attempts, nextAt, createdAt, dedupKey) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)",
    );
    this.due = db.prepare("SELECT * FROM webhook_deliveries WHERE status = 'pending' AND nextAt <= ? ORDER BY nextAt ASC, id ASC LIMIT 50");
    this.markOk = db.prepare("UPDATE webhook_deliveries SET status = 'ok', attempts = attempts + 1, lastStatus = ?, lastError = NULL, deliveredAt = ? WHERE id = ?");
    this.markRetry = db.prepare("UPDATE webhook_deliveries SET attempts = attempts + 1, lastStatus = ?, lastError = ?, nextAt = ? WHERE id = ?");
    this.markFailed = db.prepare("UPDATE webhook_deliveries SET status = 'failed', attempts = attempts + 1, lastStatus = ?, lastError = ? WHERE id = ?");
    this.prune = db.prepare("DELETE FROM webhook_deliveries WHERE status <> 'pending' AND createdAt < ?");
  }

  /**
   * Queues one delivery per active hook of each recipient subscribed to
   * `event`. `dedupBase` makes re-emits (indexer reorg re-scan) idempotent.
   */
  dispatch(event: WebhookEvent, recipients: Array<string | null | undefined>, data: Record<string, unknown>, dedupBase?: string): number {
    const seen = new Set<string>();
    const t = Math.floor(this.now() / 1000);
    let queued = 0;
    for (const r of recipients) {
      if (!r) continue;
      const key = r.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const hooks = this.hooksFor.all(r, event) as WebhookRow[];
      for (const hook of hooks) {
        const dedupKey = dedupBase ? `${dedupBase}:${hook.id}` : null;
        const payload = JSON.stringify({ id: dedupKey ?? `${event}:${hook.id}:${t}:${randomBytes(4).toString("hex")}`, event, ts: t, webhookId: hook.id, data });
        const res = this.insertDelivery.run(hook.id, hook.owner, event, payload, t, t, dedupKey);
        if (res.changes > 0) queued++;
      }
    }
    return queued;
  }

  /** Delivers everything due; returns the number of attempts made. */
  async tick(): Promise<number> {
    const t = Math.floor(this.now() / 1000);
    const rows = this.due.all(t) as DeliveryRow[];
    let attempts = 0;
    for (const row of rows) {
      attempts++;
      const hook = this.db.prepare("SELECT * FROM webhooks WHERE id = ?").get(row.webhookId) as WebhookRow | undefined;
      if (!hook || hook.active !== 1) {
        this.markFailed.run(null, "webhook removed", row.id);
        continue;
      }
      const { ok, status, error } = await this.deliver(hook, row);
      if (ok) {
        this.markOk.run(status, t, row.id);
      } else if (row.attempts < WEBHOOK_RETRY_S.length) {
        this.markRetry.run(status, error, t + WEBHOOK_RETRY_S[row.attempts]!, row.id);
      } else {
        this.markFailed.run(status, error, row.id);
      }
    }
    if (rows.length === 0 && Math.random() < 0.05) this.prune.run(t - WEBHOOK_DELIVERY_RETENTION_S);
    return attempts;
  }

  /** POSTs the payload. Public hosts only (SSRF guard: private/loopback/metadata targets and redirects to them are refused). */
  async deliver(hook: WebhookRow, row: DeliveryRow): Promise<{ ok: boolean; status: number | null; error: string | null }> {
    try {
      const res = await safeFetch(hook.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "ferminux-gateway/webhooks",
          "x-ferminux-event": row.event,
          "x-ferminux-delivery": String(row.id),
          "x-ferminux-signature": signWebhook(hook.secret, row.payload),
        },
        body: row.payload,
        timeoutMs: WEBHOOK_TIMEOUT_MS,
        fetchImpl: this.fetchImpl,
      });
      try {
        await res.body?.cancel();
      } catch {
        // ignore
      }
      return res.status >= 200 && res.status < 300 ? { ok: true, status: res.status, error: null } : { ok: false, status: res.status, error: `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, status: null, error: (err as Error).message.slice(0, 200) };
    }
  }

  start(intervalMs: number): () => void {
    let stopped = false;
    let running = false;
    const run = async () => {
      if (stopped || running) return;
      running = true;
      try {
        await this.tick();
      } catch (err) {
        console.error("[webhooks] tick failed:", err);
      } finally {
        running = false;
      }
    };
    const handle = setInterval(run, intervalMs);
    handle.unref?.();
    return () => {
      stopped = true;
      clearInterval(handle);
    };
  }

  /**
   * Routes activity-bus events (indexer + Commons) to webhook events:
   * job.* → agent owner + client; message.send → dm.received (recipient, with
   * the body); bounty.claim → bounty.claimed (poster).
   */
  attachActivity(activity: ActivityBus): () => void {
    const bountyStmt = this.db.prepare("SELECT poster FROM bounties WHERE id = ?");
    const messageStmt = this.db.prepare("SELECT id, fromAddr, toAddr, subject, body, createdAt FROM messages WHERE id = ?");
    return activity.subscribe((ev: ActivityEvent) => {
      const d = ev.data;
      const jobEvents: Record<string, WebhookEvent> = { "job.requested": "job.requested", "job.delivered": "job.delivered", "job.completed": "job.completed", "job.refunded": "job.refunded", "job.disputed": "job.disputed" };
      if (jobEvents[ev.type]) {
        const owner = addrOf(d.owner);
        const client = addrOf(d.client);
        this.dispatch(jobEvents[ev.type]!, [owner, client], { ...flatten(d), activityId: ev.id }, `${ev.type}:${d.tx ?? ev.id}`);
      } else if (ev.type === "message.send") {
        const to = addrOf(d.to);
        const msg = messageStmt.get(Number(d.messageId)) as { id: number; fromAddr: string; toAddr: string; subject: string; body: string; createdAt: number } | undefined;
        if (to && msg) this.dispatch("dm.received", [to], { messageId: msg.id, from: msg.fromAddr, to: msg.toAddr, subject: msg.subject, body: msg.body, createdAt: msg.createdAt }, `dm:${msg.id}`);
      } else if (ev.type === "bounty.claim") {
        const b = bountyStmt.get(Number(d.bountyId)) as { poster: string } | undefined;
        if (b) this.dispatch("bounty.claimed", [b.poster], { ...flatten(d), claimer: ev.actor?.address ?? null }, `bounty.claim:${d.bountyId}:${d.claimId}`);
      }
    });
  }
}

/** Author objects back to plain addresses for webhook payloads. */
function flatten(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) out[k] = v && typeof v === "object" && !Array.isArray(v) && typeof (v as Author).address === "string" ? (v as Author).address : v;
  return out;
}

/** The {sig} of a signed GET/DELETE wherever it travelled (header, query or body) — for the replay guard. */
export function signedEnvelope(req: { headers: Record<string, unknown>; query?: unknown; body?: unknown }): Record<string, unknown> {
  const h = req.headers;
  const qs = (req.query ?? {}) as Record<string, unknown>;
  let sig = typeof h["x-ferminux-sig"] === "string" ? (h["x-ferminux-sig"] as string) : typeof qs.sig === "string" ? qs.sig : undefined;
  if (!sig && Buffer.isBuffer(req.body) && req.body.length) {
    try {
      sig = String((JSON.parse(req.body.toString("utf8")) as { sig?: string }).sig ?? "");
    } catch {
      // ignore
    }
  }
  return { sig: sig ?? "" };
}

export function registerWebhookRoutes(app: FastifyInstance, ctx: CommonsContext, bus: WebhookBus): void {
  const { db, nowS, author } = ctx;
  const countStmt = db.prepare("SELECT status, COUNT(*) AS c FROM webhook_deliveries WHERE webhookId = ? GROUP BY status");

  function view(row: WebhookRow): WebhookView {
    const counts = { pending: 0, ok: 0, failed: 0 };
    for (const r of countStmt.all(row.id) as Array<{ status: keyof typeof counts; c: number }>) if (r.status in counts) counts[r.status] = r.c;
    let events: WebhookEvent[] = [];
    try {
      events = JSON.parse(row.events);
    } catch {
      events = [];
    }
    return { id: row.id, owner: author(row.owner), url: row.url, events, active: row.active === 1, secretHint: row.secret.slice(0, 4), createdAt: row.createdAt, updatedAt: row.updatedAt, deliveries: counts };
  }

  app.post("/api/webhooks", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    try {
      const body = ctx.parseJson(req);
      const address = ctx.authenticateWrite("webhook.set", body);
      const url = ctx.checkHttpsUrl(body.url, "url");
      const secret = ctx.requireString(body.secret, "secret");
      if (secret.length < WEBHOOK_SECRET_MIN || secret.length > WEBHOOK_SECRET_MAX) throw new HttpError(400, `secret must be ${WEBHOOK_SECRET_MIN}–${WEBHOOK_SECRET_MAX} chars`);
      if (!Array.isArray(body.events) || body.events.length === 0) throw new HttpError(400, `events must be a non-empty array of: ${WEBHOOK_EVENTS.join(", ")}`);
      const events: WebhookEvent[] = [];
      for (const e of body.events) {
        if (typeof e !== "string" || !(WEBHOOK_EVENTS as readonly string[]).includes(e)) throw new HttpError(400, `unknown event "${String(e)}"; allowed: ${WEBHOOK_EVENTS.join(", ")}`);
        if (!events.includes(e as WebhookEvent)) events.push(e as WebhookEvent);
      }
      const active = body.active === undefined ? true : body.active === true || body.active === "true";
      ctx.commitWrite(address, body);
      const t = nowS();
      const existing = db.prepare("SELECT id FROM webhooks WHERE lower(owner) = lower(?) AND url = ?").get(address, url) as { id: number } | undefined;
      let id: number;
      if (existing) {
        db.prepare("UPDATE webhooks SET secret = ?, events = ?, active = ?, owner = ?, updatedAt = ? WHERE id = ?").run(secret, JSON.stringify(events), active ? 1 : 0, address, t, existing.id);
        id = existing.id;
      } else {
        const n = (db.prepare("SELECT COUNT(*) AS c FROM webhooks WHERE lower(owner) = lower(?)").get(address) as { c: number }).c;
        if (n >= WEBHOOK_MAX_PER_OWNER) throw new HttpError(409, `at most ${WEBHOOK_MAX_PER_OWNER} webhooks per address`);
        const r = db.prepare("INSERT INTO webhooks (owner, url, secret, events, active, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)").run(address, url, secret, JSON.stringify(events), active ? 1 : 0, t, t);
        id = Number(r.lastInsertRowid);
      }
      const row = db.prepare("SELECT * FROM webhooks WHERE id = ?").get(id) as WebhookRow;
      return reply.code(existing ? 200 : 201).send(view(row));
    } catch (err) {
      return ctx.sendError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/webhooks/:id", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    try {
      const address = ctx.authenticateHeaders("webhook.delete", req);
      const id = Number(req.params.id);
      const bound = ctx.signedBodyOf(req).id;
      if (bound !== undefined && Number(bound) !== id) throw new HttpError(400, "signed id does not match the URL", "bad_sig");
      ctx.commitWrite(address, signedEnvelope(req)); // replay guard: a captured DELETE signature is single-use
      const row = db.prepare("SELECT * FROM webhooks WHERE id = ?").get(id) as WebhookRow | undefined;
      if (!row) throw new HttpError(404, "webhook not found");
      if (row.owner.toLowerCase() !== address.toLowerCase()) throw new HttpError(403, "not your webhook", "not_owner");
      db.prepare("DELETE FROM webhooks WHERE id = ?").run(id);
      db.prepare("UPDATE webhook_deliveries SET status = 'failed', lastError = 'webhook removed' WHERE webhookId = ? AND status = 'pending'").run(id);
      return { deleted: true, id };
    } catch (err) {
      return ctx.sendError(reply, err);
    }
  });

  // signed read: same envelope as webhook.set (the SDK's fmx.webhooks.list signs "webhook.set" over {})
  app.get<{ Querystring: { deliveries?: string } }>("/api/webhooks/mine", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    try {
      const address = ctx.authenticateHeaders("webhook.set", req);
      const rows = db.prepare("SELECT * FROM webhooks WHERE lower(owner) = lower(?) ORDER BY id ASC").all(address) as WebhookRow[];
      const lim = ctx.parseLimit(req.query.deliveries, 20, 200);
      const deliveries = (db.prepare("SELECT id, webhookId, event, status, attempts, nextAt, lastStatus, lastError, createdAt, deliveredAt FROM webhook_deliveries WHERE lower(owner) = lower(?) ORDER BY id DESC LIMIT ?").all(address, lim) as Array<Omit<DeliveryRow, "payload" | "owner" | "dedupKey">>);
      return { address, items: rows.map(view), events: [...WEBHOOK_EVENTS], retrySeconds: [...WEBHOOK_RETRY_S], deliveries };
    } catch (err) {
      return ctx.sendError(reply, err);
    }
  });
}
