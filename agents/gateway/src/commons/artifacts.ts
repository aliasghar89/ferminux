// Artifacts: public datasets, prompts, code and models. The content is either
// a payload already uploaded to /api/payloads (payloadHash) or an external
// https URL. Stars: one per address, second star is a no-op 200.
import type { FastifyInstance } from "fastify";
import type { Db } from "../db.js";
import { HttpError, parseTags, type Author, type CommonsContext } from "./context.js";

export const ARTIFACT_KINDS = ["dataset", "prompt", "code", "model", "other"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export const ARTIFACT_NAME_MAX_CHARS = 120;
export const ARTIFACT_DESCRIPTION_MAX_CHARS = 4000;
export const ARTIFACT_LICENSE_MAX_CHARS = 64;

export interface ArtifactRow {
  id: number;
  owner: string;
  name: string;
  description: string;
  license: string;
  kind: ArtifactKind;
  payloadHash: string | null;
  url: string | null;
  tags: string;
  stars: number;
  createdAt: number;
}
export interface ArtifactView {
  id: number;
  owner: Author;
  name: string;
  description: string;
  license: string;
  kind: ArtifactKind;
  payloadHash: string | null;
  payloadURI: string | null;
  payloadSize: number | null;
  payloadContentType: string | null;
  url: string | null;
  tags: string[];
  stars: number;
  createdAt: number;
}

export function registerArtifacts(app: FastifyInstance, ctx: CommonsContext): void {
  const { db, activity, nowS, author } = ctx;
  const getStmt = db.prepare("SELECT * FROM artifacts WHERE id = ?");
  const payloadStmt = db.prepare("SELECT size, contentType FROM payloads WHERE hash = ?");

  function view(row: ArtifactRow): ArtifactView {
    const p = row.payloadHash ? (payloadStmt.get(row.payloadHash) as { size: number; contentType: string } | undefined) : undefined;
    return {
      id: row.id,
      owner: author(row.owner),
      name: row.name,
      description: row.description,
      license: row.license,
      kind: row.kind,
      payloadHash: row.payloadHash,
      payloadURI: row.payloadHash ? `fmx://payload/${row.payloadHash}` : null,
      payloadSize: p?.size ?? null,
      payloadContentType: p?.contentType ?? null,
      url: row.url,
      tags: parseTags(row.tags),
      stars: row.stars,
      createdAt: row.createdAt,
    };
  }

  app.get<{ Querystring: { q?: string; kind?: string; tag?: string; owner?: string; sort?: string; limit?: string; offset?: string } }>("/api/artifacts", async (req) => {
    const { q, kind, tag, owner, sort } = req.query;
    const lim = ctx.parseLimit(req.query.limit, 50, 200);
    const off = ctx.parseOffset(req.query.offset);
    const where: string[] = [];
    const params: unknown[] = [];
    if (kind) {
      if (!(ARTIFACT_KINDS as readonly string[]).includes(kind)) throw new HttpError(400, "kind must be dataset|prompt|code|model|other");
      where.push("kind = ?");
      params.push(kind);
    }
    if (q) {
      where.push("(name LIKE ? OR description LIKE ? OR url LIKE ?)");
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (tag) {
      where.push("EXISTS (SELECT 1 FROM json_each(artifacts.tags) WHERE value = ?)");
      params.push(tag.trim().toLowerCase());
    }
    if (owner) {
      where.push("lower(owner) = lower(?)");
      params.push(owner);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const orderSql = sort === "stars" ? "stars DESC, id DESC" : "createdAt DESC, id DESC";
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM artifacts ${whereSql}`).get(...params) as { c: number }).c;
    const rows = db.prepare(`SELECT * FROM artifacts ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`).all(...params, lim, off) as ArtifactRow[];
    return { items: rows.map(view), total };
  });

  app.get<{ Params: { id: string }; Querystring: { viewer?: string } }>("/api/artifacts/:id", async (req, reply) => {
    const row = getStmt.get(Number(req.params.id)) as ArtifactRow | undefined;
    if (!row) return reply.code(404).send({ error: "artifact not found" });
    const stargazers = db.prepare("SELECT address FROM artifact_stars WHERE artifactId = ? ORDER BY createdAt DESC LIMIT 100").all(row.id) as Array<{ address: string }>;
    const viewer = req.query.viewer;
    const starred = viewer && /^0x[0-9a-fA-F]{40}$/.test(viewer)
      ? !!db.prepare("SELECT 1 FROM artifact_stars WHERE artifactId = ? AND lower(address) = lower(?)").get(row.id, viewer)
      : undefined;
    return { ...view(row), stargazers: stargazers.map((s) => author(s.address)), ...(starred !== undefined ? { starred, viewer } : {}) };
  });

  app.post("/api/artifacts", async (req, reply) => {
    try {
      const body = ctx.parseJson(req);
      const address = ctx.authenticateWrite("artifact.publish", body);
      const name = ctx.requireString(body.name, "name").trim();
      if (!name) throw new HttpError(400, "name must not be empty");
      if (name.length > ARTIFACT_NAME_MAX_CHARS) throw new HttpError(400, `name too long: max ${ARTIFACT_NAME_MAX_CHARS} chars`);
      const kind = ctx.requireString(body.kind, "kind");
      if (!(ARTIFACT_KINDS as readonly string[]).includes(kind)) throw new HttpError(400, "kind must be dataset|prompt|code|model|other");
      const description = ctx.optionalString(body.description, "description", ARTIFACT_DESCRIPTION_MAX_CHARS);
      const license = ctx.optionalString(body.license, "license", ARTIFACT_LICENSE_MAX_CHARS);
      const tags = ctx.checkTags(body.tags);
      let payloadHash: string | null = null;
      if (body.payloadHash !== undefined && body.payloadHash !== null && body.payloadHash !== "") {
        const h = ctx.requireString(body.payloadHash, "payloadHash").trim().toLowerCase();
        if (!/^0x[0-9a-f]{64}$/.test(h)) throw new HttpError(400, "payloadHash must be a 0x-prefixed keccak256 hex");
        if (!payloadStmt.get(h)) throw new HttpError(400, `payloadHash ${h} is not in the payload store — POST /api/payloads first`, "unknown_payload");
        payloadHash = h;
      }
      let url: string | null = null;
      if (body.url !== undefined && body.url !== null && body.url !== "") {
        url = ctx.checkHttpsUrl(body.url, "url");
        if (!url.startsWith("https://")) throw new HttpError(400, "url must be https://");
      }
      if (!payloadHash && !url) throw new HttpError(400, "payloadHash (uploaded via /api/payloads) or an https url is required");
      ctx.commitWrite(address, body);
      const t = nowS();
      const r = db
        .prepare("INSERT INTO artifacts (owner, name, description, license, kind, payloadHash, url, tags, stars, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)")
        .run(address, name, description, license, kind, payloadHash, url, JSON.stringify(tags), t);
      const row = getStmt.get(Number(r.lastInsertRowid)) as ArtifactRow;
      activity.emit("artifact.publish", { actor: address, ref: { kind: "artifact", id: row.id }, data: { artifactId: row.id, name, kind, license, tags, description: description.slice(0, 160) } });
      return reply.code(201).send(view(row));
    } catch (err) {
      return ctx.sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/api/artifacts/:id/star", async (req, reply) => {
    try {
      const id = Number(req.params.id);
      const row = getStmt.get(id) as ArtifactRow | undefined;
      if (!row) throw new HttpError(404, "artifact not found");
      const body = ctx.parseJson(req);
      const address = ctx.authenticateWrite("artifact.star", body);
      ctx.commitWrite(address, body);
      const t = nowS();
      const changed = db.transaction(() => {
        const r = db.prepare("INSERT OR IGNORE INTO artifact_stars (artifactId, address, createdAt) VALUES (?, ?, ?)").run(id, address, t);
        if (r.changes > 0) db.prepare("UPDATE artifacts SET stars = stars + 1 WHERE id = ?").run(id);
        return r.changes > 0;
      })();
      const fresh = getStmt.get(id) as ArtifactRow;
      if (changed) {
        activity.emit("artifact.star", { actor: address, ref: { kind: "artifact", id }, data: { artifactId: id, name: row.name, owner: row.owner, stars: fresh.stars } });
      }
      return reply.code(200).send({ ...view(fresh), starred: true, changed });
    } catch (err) {
      return ctx.sendError(reply, err);
    }
  });
}

export function artifactCounts(db: Db): { artifacts: number; stars: number } {
  const artifacts = (db.prepare("SELECT COUNT(*) AS c FROM artifacts").get() as { c: number }).c;
  const stars = (db.prepare("SELECT COUNT(*) AS c FROM artifact_stars").get() as { c: number }).c;
  return { artifacts, stars };
}
