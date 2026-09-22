// Private per-address memory: a signed KV store. 5 MB free per address;
// above that a write is x402-priced at 0.01 FMX per 64 KB-month (paid to the
// treasury), credited as `memory_credits` rows that expire after 30 days.
// Values are stored exactly as given (client-side encryption recommended).
import type { FastifyInstance } from "fastify";
import { HttpError } from "../commons/context.js";
import type { V3Context } from "./context.js";
import type { X402Facilitator } from "./x402.js";
import { signedEnvelope } from "./webhooks.js";

export const MEMORY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const MEMORY_VALUE_MAX_BYTES = 64 * 1024;
export const MEMORY_FREE_BYTES = 5 * 1024 * 1024;
export const MEMORY_BLOCK_BYTES = 64 * 1024;
export const MEMORY_PRICE_PER_BLOCK_WEI = 10n ** 16n; // 0.01 FMX
export const MEMORY_CREDIT_TTL_S = 30 * 86_400;
export const MEMORY_MAX_KEYS = 10_000;

interface MemoryRow {
  address: string;
  key: string;
  value: string;
  size: number;
  createdAt: number;
  updatedAt: number;
}

export function memoryQuota(ctx: V3Context, address: string) {
  const db = ctx.db;
  const t = ctx.nowS();
  const used = (db.prepare("SELECT COALESCE(SUM(size), 0) AS s, COUNT(*) AS c FROM memory WHERE address = ?").get(address) as { s: number; c: number });
  const paid = (db.prepare("SELECT COALESCE(SUM(bytes), 0) AS s FROM memory_credits WHERE address = ? AND expiresAt > ?").get(address, t) as { s: number }).s;
  return { usedBytes: used.s, keys: used.c, freeBytes: MEMORY_FREE_BYTES, paidBytes: paid, quotaBytes: MEMORY_FREE_BYTES + paid };
}

export function registerMemoryRoutes(app: FastifyInstance, ctx: V3Context, fac: X402Facilitator): void {
  const { db, commons } = ctx;
  const { sendError } = commons;
  const getStmt = db.prepare("SELECT * FROM memory WHERE address = ? AND key = ?");

  function checkKey(raw: string): string {
    const key = decodeURIComponent(raw);
    if (!MEMORY_KEY_RE.test(key)) throw new HttpError(400, "key must be 1–128 chars: letters, digits, . _ : -");
    return key;
  }

  const rlRead = { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } };

  app.get("/api/memory", rlRead, async (req, reply) => {
    try {
      const address = commons.authenticateHeaders("memory.get", req);
      const rows = db.prepare("SELECT key, size, size AS bytes, createdAt, updatedAt FROM memory WHERE address = ? ORDER BY key ASC").all(address) as Array<Omit<MemoryRow, "address" | "value"> & { bytes: number }>;
      return { address, items: rows, ...memoryQuota(ctx, address), pricing: { perBlockWei: MEMORY_PRICE_PER_BLOCK_WEI.toString(), blockBytes: MEMORY_BLOCK_BYTES, creditTtlSeconds: MEMORY_CREDIT_TTL_S, payTo: ctx.feeRecipient } };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { key: string } }>("/api/memory/:key", rlRead, async (req, reply) => {
    try {
      const address = commons.authenticateHeaders("memory.get", req);
      const key = checkKey(req.params.key);
      const row = getStmt.get(address, key) as MemoryRow | undefined;
      if (!row) throw new HttpError(404, "key not found");
      let value: unknown = row.value;
      try {
        value = JSON.parse(row.value);
      } catch {
        // stored as raw text
      }
      return { address, key, value, size: row.size, createdAt: row.createdAt, updatedAt: row.updatedAt };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.put<{ Params: { key: string } }>("/api/memory/:key", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req, reply) => {
    try {
      const body = commons.parseJson(req);
      const address = commons.authenticateWrite("memory.put", body);
      const key = checkKey(req.params.key);
      if (body.key !== undefined && String(body.key) !== key) throw new HttpError(400, "signed key does not match the URL", "bad_sig");
      if (body.value === undefined) throw new HttpError(400, "value is required (any JSON value)");
      const stored = typeof body.value === "string" ? body.value : JSON.stringify(body.value);
      const size = Buffer.byteLength(stored, "utf8");
      if (size > MEMORY_VALUE_MAX_BYTES) throw new HttpError(413, `value too large: max ${MEMORY_VALUE_MAX_BYTES} bytes (got ${size})`);
      const existing = getStmt.get(address, key) as MemoryRow | undefined;
      const quota = memoryQuota(ctx, address);
      if (!existing && quota.keys >= MEMORY_MAX_KEYS) throw new HttpError(409, `at most ${MEMORY_MAX_KEYS} keys per address`);
      const after = quota.usedBytes - (existing?.size ?? 0) + size;
      const overflow = after - quota.quotaBytes;
      let paid: { blocks: number; bytes: number } | null = null;
      if (overflow > 0) {
        const blocks = Math.ceil(overflow / MEMORY_BLOCK_BYTES);
        const price = MEMORY_PRICE_PER_BLOCK_WEI * BigInt(blocks);
        const info = await fac.charge(req, reply, {
          amount: () => price,
          payTo: () => ctx.feeRecipient,
          description: `Ferminux memory: ${blocks} × 64 KB for 30 days above the ${MEMORY_FREE_BYTES / 1024 / 1024} MB free quota`,
        });
        if (!info) return reply; // 402 sent
        if (!info.free) {
          const t = ctx.nowS();
          db.prepare("INSERT INTO memory_credits (address, bytes, payer, nonce, amount, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
            address, blocks * MEMORY_BLOCK_BYTES, info.payer, info.nonce, info.amount, t, t + MEMORY_CREDIT_TTL_S,
          );
          paid = { blocks, bytes: blocks * MEMORY_BLOCK_BYTES };
        }
      }
      commons.commitWrite(address, body);
      const t = ctx.nowS();
      db.prepare(
        `INSERT INTO memory (address, key, value, size, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(address, key) DO UPDATE SET value = excluded.value, size = excluded.size, updatedAt = excluded.updatedAt`,
      ).run(address, key, stored, size, t, t);
      return reply.code(existing ? 200 : 201).send({ address, key, size, createdAt: existing?.createdAt ?? t, updatedAt: t, ...memoryQuota(ctx, address), ...(paid ? { paid } : {}) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { key: string } }>("/api/memory/:key", rlRead, async (req, reply) => {
    try {
      const address = commons.authenticateHeaders("memory.delete", req);
      const key = checkKey(req.params.key);
      const bound = commons.signedBodyOf(req).key;
      if (bound !== undefined && String(bound) !== key) throw new HttpError(400, "signed key does not match the URL", "bad_sig");
      commons.commitWrite(address, signedEnvelope(req)); // replay guard: a captured DELETE signature is single-use
      const r = db.prepare("DELETE FROM memory WHERE address = ? AND key = ?").run(address, key);
      if (r.changes === 0) throw new HttpError(404, "key not found");
      return { address, key, deleted: true, ...memoryQuota(ctx, address) };
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
