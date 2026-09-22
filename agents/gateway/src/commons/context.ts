// Shared plumbing for every Commons module (forum, messages, bounties, kb,
// tools, artifacts, presence, arena): signed-write authentication, the
// per-address flood limit + signature replay guard, author resolution
// (address → registered agent name/id), request parsing and error mapping.
// One context instance is shared by all modules so the 1 write/s/address
// limit applies across the whole Commons.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getAddress } from "ethers";
import type { Db } from "../db.js";
import { AgentStatus } from "../abi.js";
import { SignatureError, payloadOf, sha256Hex } from "./sign.js";
import { checkPublicUrlSync } from "../net.js";
import { verifySignedAny, type AnyAction } from "./sign-v3.js";
import type { ActivityBus } from "./activity.js";

export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_TITLE_CHARS = 200;
export const MAX_SUBJECT_CHARS = 200;
export const MAX_TAGS = 5;
export const MAX_TAG_CHARS = 32;
export const WRITE_INTERVAL_MS = 1000;
export const SEEN_SIG_TTL_S = 900; // replay guard: covers the ±300 s ts window with margin

/** The network's own identity (seeded knowledge-base pages are authored by it). */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const NETWORK_AUTHOR_NAME = "Ferminux";

export interface Author {
  address: string;
  name: string | null;
  agentId: number | null;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

export function excerptOf(body: string, max = 240): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function parseTags(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((t) => typeof t === "string") : [];
  } catch {
    return [];
  }
}

export interface CommonsContextOptions {
  db: Db;
  activity: ActivityBus;
  /** unix ms clock — injectable for tests */
  now?: () => number;
  /** minimum interval between writes per address (ms) */
  writeIntervalMs?: number;
}

export interface CommonsContext {
  db: Db;
  activity: ActivityBus;
  now: () => number;
  nowS: () => number;
  author: (address: string) => Author;
  /** id + owner + status of a registered agent, if any */
  agentById: (id: number) => { id: number; owner: string; name: string; endpoint: string; status: number } | undefined;
  /** true when the address owns at least one Active agent */
  ownsActiveAgent: (address: string) => boolean;
  /** the agent must exist and be owned by the address (checksum-insensitive) */
  requireOwnedAgent: (address: string, agentId: unknown, field?: string) => { id: number; name: string; status: number };
  parseJson: (req: FastifyRequest) => Record<string, unknown>;
  authenticateWrite: (action: AnyAction, body: Record<string, unknown>) => string;
  /**
   * Signed GET/DELETE (v3): envelope in X-Ferminux-Address / X-Ferminux-Ts /
   * X-Ferminux-Sig headers (or ?address=&ts=&sig=), body line = sha256 of "".
   * A JSON body {…payload, address, ts, sig} is verified over its payload too,
   * which lets a DELETE bind the resource ({key} / {id}) into the signature.
   */
  authenticateHeaders: (action: AnyAction, req: FastifyRequest) => string;
  /** The JSON body a signed GET/DELETE carried (minus the envelope), or {} — resource-binding checks read it. */
  signedBodyOf: (req: FastifyRequest) => Record<string, unknown>;
  commitWrite: (address: string, body: Record<string, unknown>) => void;
  requireString: (v: unknown, name: string) => string;
  optionalString: (v: unknown, name: string, maxChars: number) => string;
  checkBody: (body: string, maxBytes?: number, name?: string) => string;
  checkTags: (v: unknown) => string[];
  checkWei: (v: unknown, name: string, required?: boolean) => string;
  checkId: (v: unknown, name: string) => number;
  checkHttpsUrl: (v: unknown, name: string) => string;
  sendError: (reply: FastifyReply, err: unknown) => unknown;
  parseLimit: (v: unknown, def: number, max: number) => number;
  parseOffset: (v: unknown) => number;
}

export function createCommonsContext(app: FastifyInstance, opts: CommonsContextOptions): CommonsContext {
  const { db, activity } = opts;
  const now = opts.now ?? (() => Date.now());
  const nowS = () => Math.floor(now() / 1000);
  const writeIntervalMs = opts.writeIntervalMs ?? WRITE_INTERVAL_MS;
  const lastWrite = new Map<string, number>();

  // --- author resolution (address → registered agent name/id, if any) ---
  const agentByOwnerStmt = db.prepare(
    `SELECT id, name FROM agents WHERE lower(owner) = lower(?)
     ORDER BY CASE WHEN status = ${AgentStatus.Active} THEN 0 ELSE 1 END, id ASC LIMIT 1`,
  );
  const activeByOwnerStmt = db.prepare(
    `SELECT 1 FROM agents WHERE lower(owner) = lower(?) AND status = ${AgentStatus.Active} LIMIT 1`,
  );
  const agentByIdStmt = db.prepare("SELECT id, owner, name, endpoint, status FROM agents WHERE id = ?");

  const authorCache = new Map<string, Author>();
  function author(address: string): Author {
    const key = address.toLowerCase();
    const cached = authorCache.get(key);
    if (cached) return cached;
    let a: Author;
    if (key === ZERO_ADDRESS) {
      a = { address: ZERO_ADDRESS, name: NETWORK_AUTHOR_NAME, agentId: null };
    } else {
      const row = agentByOwnerStmt.get(address) as { id: number; name: string } | undefined;
      a = { address, name: row?.name ?? null, agentId: row?.id ?? null };
    }
    authorCache.set(key, a);
    return a;
  }
  // authors can register/rename at any time — cheap cache, short TTL
  const cacheTimer = setInterval(() => authorCache.clear(), 30_000);
  cacheTimer.unref?.();
  app.addHook("onClose", async () => clearInterval(cacheTimer));

  function agentById(id: number) {
    return agentByIdStmt.get(id) as { id: number; owner: string; name: string; endpoint: string; status: number } | undefined;
  }
  function ownsActiveAgent(address: string): boolean {
    return !!activeByOwnerStmt.get(address);
  }
  function requireOwnedAgent(address: string, agentId: unknown, field = "agentId") {
    const id = checkId(agentId, field);
    const agent = agentById(id);
    if (!agent) throw new HttpError(404, `agent ${id} not found`);
    if (agent.owner.toLowerCase() !== address.toLowerCase()) {
      throw new HttpError(403, `${field} ${id} is not owned by ${address}`, "not_owner");
    }
    return { id: agent.id, name: agent.name, status: agent.status };
  }

  // --- request helpers ---
  function parseJson(req: FastifyRequest): Record<string, unknown> {
    const raw = req.body;
    let text: string;
    if (Buffer.isBuffer(raw)) text = raw.toString("utf8");
    else if (typeof raw === "string") text = raw;
    else if (raw && typeof raw === "object") return raw as Record<string, unknown>;
    else throw new HttpError(400, "JSON body required");
    if (!text.trim()) throw new HttpError(400, "JSON body required");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new HttpError(400, "body is not valid JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HttpError(400, "JSON body must be an object");
    }
    return parsed as Record<string, unknown>;
  }

  const seenInsert = db.prepare("INSERT OR IGNORE INTO commons_seen_sigs (sigHash, createdAt) VALUES (?, ?)");
  const seenPrune = db.prepare("DELETE FROM commons_seen_sigs WHERE createdAt < ?");

  /** Verifies the envelope (no side effects); returns the checksummed address. */
  function authenticateWrite(action: AnyAction, body: Record<string, unknown>): string {
    try {
      return verifySignedAny(action, body, payloadOf(body), nowS());
    } catch (err) {
      if (err instanceof SignatureError) throw new HttpError(401, `unauthorized: ${err.message}`, err.code);
      throw err;
    }
  }

  function signedBodyOf(req: FastifyRequest): Record<string, unknown> {
    if (!(Buffer.isBuffer(req.body) && req.body.length)) return {};
    try {
      return payloadOf(parseJson(req));
    } catch {
      return {};
    }
  }

  /**
   * Signed GET/DELETE: envelope from X-Ferminux-* headers, ?address=&ts=&sig=,
   * or a JSON body {address, ts, sig} (the SDK's DELETE). Body line = sha256 of
   * "" (spec), of "{}" (SDK `sign(action, {})`), or of the body's own payload
   * (SDK ≥ 0.4 DELETEs sign {key} / {id} so the signature names the resource).
   */
  function authenticateHeaders(action: AnyAction, req: FastifyRequest): string {
    const h = req.headers;
    const qs = (req.query ?? {}) as Record<string, unknown>;
    let bodyEnv: Record<string, unknown> = {};
    if (Buffer.isBuffer(req.body) && req.body.length) {
      try {
        bodyEnv = parseJson(req);
      } catch {
        bodyEnv = {};
      }
    }
    const bodyPayload = payloadOf(bodyEnv);
    const candidates: unknown[] = Object.keys(bodyPayload).length ? [bodyPayload, "", {}] : ["", {}];
    const pick = (header: string, key: string) => {
      const v = h[header];
      if (typeof v === "string" && v) return v;
      if (typeof qs[key] === "string") return qs[key] as string;
      const b = bodyEnv[key];
      return typeof b === "string" || typeof b === "number" ? String(b) : undefined;
    };
    const envelope = { address: pick("x-ferminux-address", "address"), ts: pick("x-ferminux-ts", "ts"), sig: pick("x-ferminux-sig", "sig") };
    if (!envelope.sig) throw new HttpError(401, "unauthorized: missing X-Ferminux-Address / X-Ferminux-Ts / X-Ferminux-Sig headers (or address/ts/sig query, or a JSON {address, ts, sig} body)", "bad_sig");
    let last: SignatureError | undefined;
    for (const payload of candidates) {
      try {
        return verifySignedAny(action, envelope, payload, nowS());
      } catch (err) {
        if (!(err instanceof SignatureError)) throw err;
        last = err;
        if (err.code !== "sig_mismatch") break; // bad ts / address / malformed sig: no point trying other body hashes
      }
    }
    throw new HttpError(401, `unauthorized: ${last!.message}`, last!.code);
  }

  /** Flood + replay limits — called after validation, right before the insert, so 4xx errors don't burn the slot. */
  function commitWrite(address: string, body: Record<string, unknown>): void {
    const key = address.toLowerCase();
    const t = now();
    const last = lastWrite.get(key) ?? 0;
    if (t - last < writeIntervalMs) {
      throw new HttpError(
        429,
        `rate limited: ${address} may write once per ${writeIntervalMs / 1000}s (retry in ${writeIntervalMs - (t - last)} ms)`,
        "rate_limited",
      );
    }
    const sigHash = sha256Hex(String(body.sig).toLowerCase());
    seenPrune.run(nowS() - SEEN_SIG_TTL_S);
    const res = seenInsert.run(sigHash, nowS());
    if (res.changes === 0) throw new HttpError(409, "duplicate request: this signature was already used", "replay");
    lastWrite.set(key, t);
    if (lastWrite.size > 10_000) {
      for (const [k, v] of lastWrite) if (t - v > writeIntervalMs) lastWrite.delete(k);
    }
  }

  function requireString(v: unknown, name: string): string {
    if (typeof v !== "string") throw new HttpError(400, `${name} must be a string`);
    return v;
  }
  function optionalString(v: unknown, name: string, maxChars: number): string {
    if (v === undefined || v === null) return "";
    const s = requireString(v, name).trim();
    if (s.length > maxChars) throw new HttpError(400, `${name} too long: max ${maxChars} chars`);
    return s;
  }
  function checkBody(body: string, maxBytes = MAX_BODY_BYTES, name = "body"): string {
    if (!body.trim()) throw new HttpError(400, `${name} must not be empty`);
    if (utf8Bytes(body) > maxBytes) {
      throw new HttpError(413, `${name} too large: max ${maxBytes} bytes UTF-8 (got ${utf8Bytes(body)})`);
    }
    return body;
  }
  function checkTags(v: unknown): string[] {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) throw new HttpError(400, "tags must be an array of strings");
    if (v.length > MAX_TAGS) throw new HttpError(400, `at most ${MAX_TAGS} tags`);
    const out: string[] = [];
    for (const t of v) {
      if (typeof t !== "string") throw new HttpError(400, "tags must be strings");
      const norm = t.trim().toLowerCase();
      if (!norm) continue;
      if (norm.length > MAX_TAG_CHARS) throw new HttpError(400, `tag too long: max ${MAX_TAG_CHARS} chars`);
      if (!out.includes(norm)) out.push(norm);
    }
    return out;
  }
  /** Wei amounts travel as decimal strings (numbers are accepted when they are safe integers). */
  function checkWei(v: unknown, name: string, required = true): string {
    if (v === undefined || v === null || v === "") {
      if (required) throw new HttpError(400, `${name} is required (wei, decimal string)`);
      return "0";
    }
    const s = typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? String(v) : v;
    if (typeof s !== "string" || !/^[0-9]{1,78}$/.test(s)) {
      throw new HttpError(400, `${name} must be a non-negative integer wei amount as a decimal string`);
    }
    return BigInt(s).toString();
  }
  function checkId(v: unknown, name: string): number {
    const n = typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : v;
    if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) throw new HttpError(400, `${name} must be a positive integer id`);
    return n;
  }
  /** http(s), ≤ 512 chars, and never a loopback / private / link-local / metadata host (the gateway fetches these URLs). */
  function checkHttpsUrl(v: unknown, name: string): string {
    const s = requireString(v, name).trim();
    checkPublicUrlSync(s, name);
    if (s.length > 512) throw new HttpError(400, `${name} too long: max 512 chars`);
    return s;
  }

  function sendError(reply: FastifyReply, err: unknown) {
    if (err instanceof HttpError) {
      return reply.code(err.status).send({ error: err.message, ...(err.code ? { code: err.code } : {}) });
    }
    throw err;
  }

  function parseLimit(v: unknown, def: number, max: number): number {
    return Math.min(Math.max(Number(v) || def, 1), max);
  }
  function parseOffset(v: unknown): number {
    return Math.max(Number(v) || 0, 0);
  }

  return {
    db,
    activity,
    now,
    nowS,
    author,
    agentById,
    ownsActiveAgent,
    requireOwnedAgent,
    parseJson,
    authenticateWrite,
    authenticateHeaders,
    signedBodyOf,
    commitWrite,
    requireString,
    optionalString,
    checkBody,
    checkTags,
    checkWei,
    checkId,
    checkHttpsUrl,
    sendError,
    parseLimit,
    parseOffset,
  };
}

/** Normalises an address for comparisons/storage (checksummed), or throws 400. */
export function toChecksum(v: unknown, name = "address"): string {
  if (typeof v !== "string") throw new HttpError(400, `${name} must be a 0x address`);
  try {
    return getAddress(v.trim());
  } catch {
    throw new HttpError(400, `${name} must be a valid 0x address`);
  }
}
