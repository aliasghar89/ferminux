import { keccak256 } from "ethers";
import type { Db } from "./db.js";

export const MAX_PAYLOAD_BYTES = 256 * 1024; // 256 KiB

export interface StoredPayload {
  hash: string;
  contentType: string;
  bytes: Buffer;
  size: number;
  createdAt: number;
}

/** keccak256 of the exact bytes, 0x-prefixed hex. Pure — safe to unit test. */
export function hashPayload(bytes: Uint8Array): string {
  return keccak256(bytes);
}

export function storePayload(db: Db, bytes: Uint8Array, contentType: string): { hash: string; uri: string; size: number } {
  const { inserted: _inserted, ...out } = storePayloadDetailed(db, bytes, contentType);
  return out;
}

/** storePayload, plus whether the bytes were new (a duplicate costs no space and must not count against quotas). */
export function storePayloadDetailed(db: Db, bytes: Uint8Array, contentType: string): { hash: string; uri: string; size: number; inserted: boolean } {
  const hash = hashPayload(bytes);
  const size = bytes.byteLength;
  const createdAt = Date.now();
  const buf = Buffer.from(bytes);
  const r = db.prepare(
    `INSERT INTO payloads (hash, contentType, bytes, size, createdAt)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(hash) DO NOTHING`,
  ).run(hash, contentType || "application/octet-stream", buf, size, createdAt);
  return { hash, uri: `fmx://payload/${hash}`, size, inserted: r.changes > 0 };
}

/* ------------------------------------------------------------------ quota + retention */

// POST /api/payloads is anonymous and unpaid (the SDK's hire flow uploads job inputs there before paying), and
// nothing ever deleted a payload: one IP at 60 × 256 KiB a minute could add ~21 GB a day to agents.db, on the
// root disk the chain nodes and the explorer database share. Bounded three ways: a per-IP daily byte budget,
// a global byte cap, and a daily prune of old payloads nothing references.
export const PAYLOADS_MAX_TOTAL_BYTES_DEFAULT = 2 * 1024 ** 3; // 2 GiB
export const PAYLOADS_MAX_BYTES_PER_IP_PER_DAY_DEFAULT = 32 * 1024 ** 2; // 32 MiB ≈ 128 max-size uploads
export const PAYLOADS_TTL_DAYS_DEFAULT = 30;

function envInt(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : def;
}

export class PayloadQuota {
  readonly maxTotal: number;
  readonly maxPerIpPerDay: number;
  private used: number | null = null;
  private usedAt = 0;
  private readonly perIp = new Map<string, { day: number; bytes: number }>();
  constructor(private readonly db: Db, opts: { maxTotal?: number; maxPerIpPerDay?: number } = {}) {
    this.maxTotal = opts.maxTotal ?? envInt("PAYLOADS_MAX_TOTAL_BYTES", PAYLOADS_MAX_TOTAL_BYTES_DEFAULT);
    this.maxPerIpPerDay = opts.maxPerIpPerDay ?? envInt("PAYLOADS_MAX_BYTES_PER_IP_PER_DAY", PAYLOADS_MAX_BYTES_PER_IP_PER_DAY_DEFAULT);
  }
  usedBytes(): number {
    // SUM(size) is a full scan: recompute at most every 10 minutes, count inserts in between
    if (this.used === null || Date.now() - this.usedAt > 600_000) {
      this.used = Number((this.db.prepare("SELECT COALESCE(SUM(size), 0) AS s FROM payloads").get() as { s: number }).s);
      this.usedAt = Date.now();
    }
    return this.used;
  }
  /** null = allowed; otherwise [status, message]. */
  check(ip: string, size: number): [number, string] | null {
    const day = Math.floor(Date.now() / 86_400_000);
    const e = this.perIp.get(ip);
    const spent = e && e.day === day ? e.bytes : 0;
    if (spent + size > this.maxPerIpPerDay) return [429, `payload budget for your address is spent for today (${this.maxPerIpPerDay} bytes / UTC day)`];
    if (this.usedBytes() + size > this.maxTotal) return [507, "the payload store is full; try again later"];
    return null;
  }
  record(ip: string, size: number, inserted: boolean): void {
    if (!inserted) return;
    const day = Math.floor(Date.now() / 86_400_000);
    const e = this.perIp.get(ip);
    if (e && e.day === day) e.bytes += size;
    else this.perIp.set(ip, { day, bytes: size });
    if (this.used !== null) this.used += size;
    if (this.perIp.size > 50_000) for (const [k, v] of this.perIp) if (v.day !== day) this.perIp.delete(k);
  }
  /** After a prune, force a fresh SUM on the next check. */
  invalidate(): void {
    this.used = null;
  }
}

const HASH_RE = /0x[0-9a-f]{64}/gi;

/**
 * Deletes payloads older than `ttlDays` that no row anywhere refers to. References are collected by scanning
 * every TEXT column of every table (except the payload store and full-text shadow tables) for 0x-hashes, so
 * job inputs/outputs, artifacts, arena entries, agent metadata, events and activity all keep theirs alive —
 * conservative on purpose: a payload is only lost when nothing mentions it.
 */
export function prunePayloads(db: Db, opts: { ttlDays?: number; nowMs?: number; batch?: number } = {}): { deleted: number; bytes: number } {
  const ttlDays = opts.ttlDays ?? envInt("PAYLOADS_TTL_DAYS", PAYLOADS_TTL_DAYS_DEFAULT);
  const cutoff = (opts.nowMs ?? Date.now()) - ttlDays * 86_400_000;
  const candidates = db.prepare("SELECT hash, size FROM payloads WHERE createdAt < ? ORDER BY createdAt ASC LIMIT ?").all(cutoff, opts.batch ?? 5000) as Array<{ hash: string; size: number }>;
  if (!candidates.length) return { deleted: 0, bytes: 0 };
  const referenced = new Set<string>();
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
    .map((t) => t.name)
    .filter((n) => n !== "payloads" && !n.startsWith("sqlite_") && !/_fts($|_)/.test(n));
  for (const table of tables) {
    const cols = (db.prepare(`PRAGMA table_info("${table.replace(/"/g, '""')}")`).all() as Array<{ name: string; type: string }>)
      .filter((c) => /TEXT|CHAR|CLOB|^$/i.test(c.type))
      .map((c) => c.name);
    for (const col of cols) {
      const q = `SELECT "${col.replace(/"/g, '""')}" AS v FROM "${table.replace(/"/g, '""')}" WHERE "${col.replace(/"/g, '""')}" LIKE '%0x%'`;
      for (const row of db.prepare(q).iterate() as Iterable<{ v: unknown }>) {
        if (typeof row.v !== "string") continue;
        for (const m of row.v.matchAll(HASH_RE)) referenced.add(m[0].toLowerCase());
      }
    }
  }
  let deleted = 0;
  let bytes = 0;
  const del = db.prepare("DELETE FROM payloads WHERE hash = ?");
  db.transaction(() => {
    for (const c of candidates) {
      if (referenced.has(c.hash.toLowerCase())) continue;
      deleted += del.run(c.hash).changes;
      bytes += c.size;
    }
  })();
  return { deleted, bytes };
}

export function getPayload(db: Db, hash: string): StoredPayload | undefined {
  const row = db
    .prepare("SELECT hash, contentType, bytes, size, createdAt FROM payloads WHERE hash = ?")
    .get(hash) as
    | { hash: string; contentType: string; bytes: Buffer; size: number; createdAt: number }
    | undefined;
  return row;
}

/**
 * Content type the payload store SERVES. Payloads are user bytes served from
 * the gateway's own origin, so anything a browser would execute (html, xml,
 * svg, javascript) goes out as text/plain; unknown types as octet-stream.
 * Pair with X-Content-Type-Options: nosniff.
 */
export function servableContentType(stored: string): string {
  const ct = (stored || "").trim();
  const base = ct.split(";")[0]!.trim().toLowerCase();
  if (/^(text\/(html|xml|xsl|vnd\.wap)|application\/(xhtml|xml|.*\+xml|javascript|ecmascript|x-javascript|x-shockwave)|image\/svg)/.test(base)) return "text/plain; charset=utf-8";
  if (base === "application/json" || base === "application/x-ndjson" || base === "application/pdf" || base === "application/octet-stream") return ct;
  if (/^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(base)) return ct;
  if (base.startsWith("text/")) return ct;
  return "application/octet-stream";
}
