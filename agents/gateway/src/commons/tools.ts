// Tools registry: free capabilities agents expose to each other (MCP servers,
// HTTP APIs, A2A endpoints). One row per (owner, name); re-publishing updates
// it. A probe (HEAD, then GET; 5 s timeout) runs every 10 min → online/lastSeen.
import type { FastifyInstance } from "fastify";
import type { Db } from "../db.js";
import { safeFetch } from "../net.js";
import { HttpError, parseTags, type Author, type CommonsContext } from "./context.js";

export const TOOL_KINDS = ["mcp", "http", "a2a", "compute"] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];
export const TOOL_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
export const TOOL_DESCRIPTION_MAX_CHARS = 2000;
export const TOOL_SCHEMA_MAX_BYTES = 32 * 1024;
export const TOOL_PROBE_TIMEOUT_MS = 5000;
export const COMPUTE_REGION_MAX_CHARS = 64;
export const COMPUTE_GPU_MAX_CHARS = 64;

/** Compute listing (kind "compute"): the endpoint is x402-priced by the provider; the gateway only lists + health-checks. */
export interface ComputeSpec {
  gpu: string;
  vramGb: number;
  /** wei of FMX per second */
  pricePerSecond: string;
  region: string;
  endpoint: string;
}

export interface ToolRow {
  id: number;
  owner: string;
  name: string;
  kind: ToolKind;
  url: string;
  description: string;
  schema: string | null;
  compute: string | null;
  online: number;
  lastSeen: number | null;
  lastProbeAt: number | null;
  createdAt: number;
  updatedAt: number;
}
export interface ToolView {
  id: number;
  owner: Author;
  name: string;
  kind: ToolKind;
  url: string;
  description: string;
  schema: unknown | null;
  /** only for kind "compute" */
  compute: ComputeSpec | null;
  online: boolean;
  lastSeen: number | null;
  lastProbeAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export function parseCompute(json: string | null): ComputeSpec | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" ? (v as ComputeSpec) : null;
  } catch {
    return null;
  }
}

export function toolView(row: ToolRow, author: (address: string) => Author): ToolView {
  let schema: unknown = null;
  if (row.schema) {
    try {
      schema = JSON.parse(row.schema);
    } catch {
      schema = null;
    }
  }
  return {
    id: row.id,
    owner: author(row.owner),
    name: row.name,
    kind: row.kind,
    url: row.url,
    description: row.description,
    schema,
    compute: row.kind === "compute" ? parseCompute(row.compute) : null,
    online: row.online === 1,
    lastSeen: row.lastSeen,
    lastProbeAt: row.lastProbeAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function registerTools(app: FastifyInstance, ctx: CommonsContext, opts: { fetchImpl?: typeof fetch } = {}): void {
  const { db, activity, nowS, author } = ctx;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const getStmt = db.prepare("SELECT * FROM tools WHERE id = ?");

  const view = (row: ToolRow) => toolView(row, author);

  app.get<{ Querystring: { q?: string; kind?: string; owner?: string; online?: string; limit?: string; offset?: string } }>("/api/tools", async (req) => {
    const { q, kind, owner, online } = req.query;
    const lim = ctx.parseLimit(req.query.limit, 50, 200);
    const off = ctx.parseOffset(req.query.offset);
    const where: string[] = [];
    const params: unknown[] = [];
    if (kind) {
      if (!(TOOL_KINDS as readonly string[]).includes(kind)) throw new HttpError(400, "kind must be mcp|http|a2a|compute");
      where.push("kind = ?");
      params.push(kind);
    }
    if (q) {
      where.push("(name LIKE ? OR description LIKE ? OR url LIKE ?)");
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (owner) {
      where.push("lower(owner) = lower(?)");
      params.push(owner);
    }
    if (online === "1" || online === "true") where.push("online = 1");
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM tools ${whereSql}`).get(...params) as { c: number }).c;
    const rows = db.prepare(`SELECT * FROM tools ${whereSql} ORDER BY online DESC, updatedAt DESC, id DESC LIMIT ? OFFSET ?`).all(...params, lim, off) as ToolRow[];
    return { items: rows.map(view), total };
  });

  app.get<{ Params: { id: string } }>("/api/tools/:id", async (req, reply) => {
    const row = getStmt.get(Number(req.params.id)) as ToolRow | undefined;
    if (!row) return reply.code(404).send({ error: "tool not found" });
    return view(row);
  });

  app.post("/api/tools", async (req, reply) => {
    try {
      const body = ctx.parseJson(req);
      const address = ctx.authenticateWrite("tool.publish", body);
      const name = ctx.requireString(body.name, "name").trim();
      if (!TOOL_NAME_RE.test(name)) throw new HttpError(400, "name must be 1–64 chars: letters, digits, . _ -");
      const kind = ctx.requireString(body.kind, "kind");
      if (!(TOOL_KINDS as readonly string[]).includes(kind)) throw new HttpError(400, "kind must be mcp|http|a2a|compute");
      // compute listings: {gpu, vramGb, pricePerSecond(wei), region, endpoint}; url defaults to the endpoint
      let compute: string | null = null;
      if (kind === "compute") {
        const endpoint = ctx.checkHttpsUrl(body.endpoint ?? body.url, "endpoint");
        const gpu = ctx.optionalString(body.gpu, "gpu", COMPUTE_GPU_MAX_CHARS);
        if (!gpu) throw new HttpError(400, "gpu is required for compute listings (e.g. \"H100\")");
        const vramGb = Number(body.vramGb);
        if (!Number.isFinite(vramGb) || vramGb < 0 || vramGb > 100000) throw new HttpError(400, "vramGb must be a non-negative number");
        const pricePerSecond = ctx.checkWei(body.pricePerSecond, "pricePerSecond");
        const region = ctx.optionalString(body.region, "region", COMPUTE_REGION_MAX_CHARS);
        const spec: ComputeSpec = { gpu, vramGb, pricePerSecond, region, endpoint };
        compute = JSON.stringify(spec);
        if (body.url === undefined || body.url === null) body.url = endpoint;
      }
      const url = ctx.checkHttpsUrl(body.url, "url");
      const description = ctx.optionalString(body.description, "description", TOOL_DESCRIPTION_MAX_CHARS);
      let schema: string | null = null;
      if (body.schema !== undefined && body.schema !== null) {
        if (typeof body.schema !== "object" || Array.isArray(body.schema)) throw new HttpError(400, "schema must be a JSON object");
        schema = JSON.stringify(body.schema);
        if (Buffer.byteLength(schema, "utf8") > TOOL_SCHEMA_MAX_BYTES) throw new HttpError(413, `schema too large: max ${TOOL_SCHEMA_MAX_BYTES} bytes`);
      }
      ctx.commitWrite(address, body);
      const t = nowS();
      const existing = db.prepare("SELECT id FROM tools WHERE lower(owner) = lower(?) AND name = ?").get(address, name) as { id: number } | undefined;
      let id: number;
      if (existing) {
        db.prepare("UPDATE tools SET kind = ?, url = ?, description = ?, schema = ?, compute = ?, owner = ?, updatedAt = ? WHERE id = ?").run(
          kind, url, description, schema, compute, address, t, existing.id,
        );
        id = existing.id;
      } else {
        const r = db
          .prepare("INSERT INTO tools (owner, name, kind, url, description, schema, compute, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(address, name, kind, url, description, schema, compute, t, t);
        id = Number(r.lastInsertRowid);
      }
      const row = getStmt.get(id) as ToolRow;
      activity.emit("tool.publish", { actor: address, ref: { kind: "tool", id }, data: { toolId: id, name, kind, url, updated: !!existing, description: description.slice(0, 160) } });
      // probe in the background so a fresh publish shows online quickly
      void probeTool(db, row, fetchImpl).catch(() => undefined);
      return reply.code(existing ? 200 : 201).send(view(row));
    } catch (err) {
      return ctx.sendError(reply, err);
    }
  });
}

/**
 * HEAD then GET (5 s each). HEAD 2xx/3xx → online without a GET; anything else
 * (405, 404, 5xx, timeout) falls through to GET, which counts as online when it
 * answers with a status other than 404/5xx (auth walls are "up").
 */
export async function probeUrl(url: string, fetchImpl: typeof fetch = fetch, timeoutMs = TOOL_PROBE_TIMEOUT_MS): Promise<boolean> {
  for (const method of ["HEAD", "GET"] as const) {
    try {
      // public hosts only; redirects are followed by safeFetch (≤ 3, each re-checked)
      const res = await safeFetch(url, { method, timeoutMs, fetchImpl, headers: { accept: "*/*", "user-agent": "ferminux-gateway/tool-probe" } });
      try {
        await res.body?.cancel();
      } catch {
        // ignore
      }
      if (res.status >= 200 && res.status < 400) return true;
      if (method === "GET") return res.status !== 404 && res.status < 500;
    } catch {
      if (method === "GET") return false;
    }
  }
  return false;
}

export async function probeTool(db: Db, row: { id: number; url: string }, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const online = await probeUrl(row.url, fetchImpl);
  const t = Math.floor(Date.now() / 1000);
  if (online) db.prepare("UPDATE tools SET online = 1, lastSeen = ?, lastProbeAt = ? WHERE id = ?").run(t, t, row.id);
  else db.prepare("UPDATE tools SET online = 0, lastProbeAt = ? WHERE id = ?").run(t, row.id);
  return online;
}

export async function probeAllTools(db: Db, fetchImpl: typeof fetch = fetch): Promise<void> {
  const rows = db.prepare("SELECT id, url FROM tools").all() as Array<{ id: number; url: string }>;
  // small concurrency to be a polite neighbour
  const queue = [...rows];
  const workers = Array.from({ length: Math.min(8, queue.length) }, async () => {
    while (queue.length) {
      const row = queue.shift()!;
      await probeTool(db, row, fetchImpl).catch(() => undefined);
    }
  });
  await Promise.all(workers);
}

export function startToolProbe(db: Db, probeMs: number, fetchImpl: typeof fetch = fetch): () => void {
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await probeAllTools(db, fetchImpl);
    } catch (err) {
      console.error("[tools] probe tick failed:", err);
    } finally {
      running = false;
    }
  };
  const handle = setInterval(tick, probeMs);
  handle.unref?.();
  void tick();
  return () => {
    stopped = true;
    clearInterval(handle);
  };
}

export function toolCounts(db: Db): { tools: number; toolsOnline: number } {
  const tools = (db.prepare("SELECT COUNT(*) AS c FROM tools").get() as { c: number }).c;
  const toolsOnline = (db.prepare("SELECT COUNT(*) AS c FROM tools WHERE online = 1").get() as { c: number }).c;
  return { tools, toolsOnline };
}

export { parseTags };
