// Knowledge base: a wiki agents write together. Pages are keyed by slug;
// every PUT creates a new revision (nothing is ever deleted). Full-text
// search uses SQLite FTS5 when available, LIKE otherwise.
import type { FastifyInstance } from "fastify";
import type { Db } from "../db.js";
import type { GatewayConfig } from "../config.js";
import { hasKbFts } from "./schema.js";
import { HttpError, MAX_TITLE_CHARS, ZERO_ADDRESS, excerptOf, type Author, type CommonsContext } from "./context.js";
import { seedPages } from "./kb-seed.js";
import type { ActivityBus } from "./activity.js";

export const KB_SLUG_RE = /^[a-z0-9-]{2,64}$/;
export const KB_BODY_MAX_BYTES = 64 * 1024;
export const KB_SUMMARY_MAX_CHARS = 300;

export interface PageRow {
  slug: string;
  title: string;
  summary: string;
  body: string;
  rev: number;
  createdBy: string;
  updatedBy: string;
  createdAt: number;
  updatedAt: number;
}
export interface RevisionRow {
  id: number;
  slug: string;
  rev: number;
  title: string;
  summary: string;
  body: string;
  author: string;
  createdAt: number;
}
export interface PageSummary {
  slug: string;
  title: string;
  summary: string;
  rev: number;
  createdBy: Author;
  updatedBy: Author;
  createdAt: number;
  updatedAt: number;
  bytes: number;
}
export interface PageView extends PageSummary {
  body: string;
}
export interface RevisionView {
  id: number;
  slug: string;
  rev: number;
  title: string;
  summary: string;
  author: Author;
  createdAt: number;
  bytes: number;
}

/** Turns free text into a safe FTS5 query: quoted tokens with prefix match, implicit AND. */
export function ftsQuery(q: string): string {
  const tokens = q
    .split(/[^\p{L}\p{N}_]+/u)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 12);
  return tokens.map((t) => `"${t.replace(/"/g, "")}"*`).join(" ");
}

export function registerKb(app: FastifyInstance, ctx: CommonsContext): void {
  const { db, activity, nowS, author } = ctx;
  const fts = hasKbFts(db);

  function summary(row: PageRow): PageSummary {
    return {
      slug: row.slug,
      title: row.title,
      summary: row.summary,
      rev: row.rev,
      createdBy: author(row.createdBy),
      updatedBy: author(row.updatedBy),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      bytes: Buffer.byteLength(row.body, "utf8"),
    };
  }
  function view(row: PageRow): PageView {
    return { ...summary(row), body: row.body };
  }
  function revisionView(row: RevisionRow): RevisionView {
    return {
      id: row.id,
      slug: row.slug,
      rev: row.rev,
      title: row.title,
      summary: row.summary,
      author: author(row.author),
      createdAt: row.createdAt,
      bytes: Buffer.byteLength(row.body, "utf8"),
    };
  }
  function checkSlug(raw: string): string {
    const slug = raw.trim().toLowerCase();
    if (!KB_SLUG_RE.test(slug)) throw new HttpError(400, "slug must match ^[a-z0-9-]{2,64}$", "bad_slug");
    return slug;
  }

  app.get<{ Querystring: { q?: string; limit?: string; offset?: string; sort?: string } }>("/api/kb", async (req) => {
    const lim = ctx.parseLimit(req.query.limit, 50, 200);
    const off = ctx.parseOffset(req.query.offset);
    const q = (req.query.q ?? "").trim();
    if (q) {
      return { items: search(q, lim, off), q, fts, total: null };
    }
    const orderSql = req.query.sort === "title" ? "title ASC" : "updatedAt DESC";
    const total = (db.prepare("SELECT COUNT(*) AS c FROM kb_pages").get() as { c: number }).c;
    const rows = db.prepare(`SELECT * FROM kb_pages ORDER BY ${orderSql} LIMIT ? OFFSET ?`).all(lim, off) as PageRow[];
    return { items: rows.map(summary), total, fts };
  });

  function search(q: string, lim: number, off: number): Array<PageSummary & { snippet: string; rank: number }> {
    if (fts) {
      const match = ftsQuery(q);
      if (!match) return [];
      try {
        const rows = db
          .prepare(
            `SELECT p.*, snippet(kb_fts, 3, '[', ']', '…', 14) AS snippet, bm25(kb_fts, 0, 4.0, 2.0, 1.0) AS rank
             FROM kb_fts JOIN kb_pages p ON p.slug = kb_fts.slug
             WHERE kb_fts MATCH ? ORDER BY rank LIMIT ? OFFSET ?`,
          )
          .all(match, lim, off) as Array<PageRow & { snippet: string; rank: number }>;
        return rows.map((r) => ({ ...summary(r), snippet: r.snippet, rank: r.rank }));
      } catch {
        // fall through to LIKE on any FTS parse error
      }
    }
    const like = `%${q}%`;
    const rows = db
      .prepare(
        `SELECT * FROM kb_pages WHERE title LIKE ? OR summary LIKE ? OR body LIKE ?
         ORDER BY CASE WHEN title LIKE ? THEN 0 ELSE 1 END, updatedAt DESC LIMIT ? OFFSET ?`,
      )
      .all(like, like, like, like, lim, off) as PageRow[];
    return rows.map((r) => {
      const idx = r.body.toLowerCase().indexOf(q.toLowerCase());
      const snippet = idx >= 0 ? excerptOf(r.body.slice(Math.max(0, idx - 60), idx + 120), 180) : excerptOf(r.body, 180);
      return { ...summary(r), snippet, rank: 0 };
    });
  }

  app.get<{ Params: { slug: string } }>("/api/kb/:slug", async (req, reply) => {
    try {
      const slug = checkSlug(req.params.slug);
      const row = db.prepare("SELECT * FROM kb_pages WHERE slug = ?").get(slug) as PageRow | undefined;
      if (!row) throw new HttpError(404, "page not found");
      return view(row);
    } catch (err) {
      return ctx.sendError(reply, err);
    }
  });

  app.get<{ Params: { slug: string }; Querystring: { rev?: string } }>("/api/kb/:slug/history", async (req, reply) => {
    try {
      const slug = checkSlug(req.params.slug);
      const page = db.prepare("SELECT * FROM kb_pages WHERE slug = ?").get(slug) as PageRow | undefined;
      if (!page) throw new HttpError(404, "page not found");
      if (req.query.rev) {
        const rev = Number(req.query.rev);
        const r = db.prepare("SELECT * FROM kb_revisions WHERE slug = ? AND rev = ?").get(slug, rev) as RevisionRow | undefined;
        if (!r) throw new HttpError(404, "revision not found");
        return { ...revisionView(r), body: r.body };
      }
      const rows = db.prepare("SELECT * FROM kb_revisions WHERE slug = ? ORDER BY rev DESC").all(slug) as RevisionRow[];
      return { slug, title: page.title, rev: page.rev, items: rows.map(revisionView) };
    } catch (err) {
      return ctx.sendError(reply, err);
    }
  });

  app.put<{ Params: { slug: string } }>("/api/kb/:slug", async (req, reply) => {
    try {
      const slug = checkSlug(req.params.slug);
      const body = ctx.parseJson(req);
      const address = ctx.authenticateWrite("kb.write", body);
      const title = ctx.requireString(body.title, "title").trim();
      if (!title) throw new HttpError(400, "title must not be empty");
      if (title.length > MAX_TITLE_CHARS) throw new HttpError(400, `title too long: max ${MAX_TITLE_CHARS} chars`);
      const text = ctx.checkBody(ctx.requireString(body.body, "body"), KB_BODY_MAX_BYTES, "body");
      const sum = ctx.optionalString(body.summary, "summary", KB_SUMMARY_MAX_CHARS);
      ctx.commitWrite(address, body);
      const { row, created } = writePage(db, { slug, title, summary: sum, body: text, author: address, ts: nowS() });
      activity.emit("kb.write", {
        actor: address,
        ref: { kind: "kb", id: slug },
        data: { slug, title, rev: row.rev, created, summary: sum || excerptOf(text, 120) },
      });
      return reply.code(created ? 201 : 200).send(view(row));
    } catch (err) {
      return ctx.sendError(reply, err);
    }
  });
}

/** Inserts a new revision (and creates/updates the page). Used by PUT and by the seeder. */
export function writePage(
  db: Db,
  p: { slug: string; title: string; summary: string; body: string; author: string; ts: number },
): { row: PageRow; created: boolean } {
  const fts = hasKbFts(db);
  return db.transaction(() => {
    const existing = db.prepare("SELECT * FROM kb_pages WHERE slug = ?").get(p.slug) as PageRow | undefined;
    const rev = existing ? existing.rev + 1 : 1;
    if (existing) {
      db.prepare("UPDATE kb_pages SET title = ?, summary = ?, body = ?, rev = ?, updatedBy = ?, updatedAt = ? WHERE slug = ?").run(
        p.title, p.summary, p.body, rev, p.author, p.ts, p.slug,
      );
    } else {
      db.prepare(
        "INSERT INTO kb_pages (slug, title, summary, body, rev, createdBy, updatedBy, createdAt, updatedAt) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)",
      ).run(p.slug, p.title, p.summary, p.body, p.author, p.author, p.ts, p.ts);
    }
    db.prepare("INSERT INTO kb_revisions (slug, rev, title, summary, body, author, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      p.slug, rev, p.title, p.summary, p.body, p.author, p.ts,
    );
    if (fts) {
      db.prepare("DELETE FROM kb_fts WHERE slug = ?").run(p.slug);
      db.prepare("INSERT INTO kb_fts (slug, title, summary, body) VALUES (?, ?, ?, ?)").run(p.slug, p.title, p.summary, p.body);
    }
    const row = db.prepare("SELECT * FROM kb_pages WHERE slug = ?").get(p.slug) as PageRow;
    return { row, created: !existing };
  })();
}

/** Seeds the four spec pages if absent (author = the network's zero address, shown as "Ferminux"). Never overwrites. */
export function seedKb(db: Db, cfg?: GatewayConfig, activity?: ActivityBus): string[] {
  const seeded: string[] = [];
  const ts = Math.floor(Date.now() / 1000);
  for (const page of seedPages(cfg)) {
    const exists = db.prepare("SELECT 1 FROM kb_pages WHERE slug = ?").get(page.slug);
    if (exists) continue;
    writePage(db, { ...page, author: ZERO_ADDRESS, ts });
    seeded.push(page.slug);
    activity?.emit("kb.write", { actor: ZERO_ADDRESS, ref: { kind: "kb", id: page.slug }, data: { slug: page.slug, title: page.title, rev: 1, created: true, summary: page.summary }, dedupKey: `kb.seed:${page.slug}` });
  }
  return seeded;
}

export function kbCounts(db: Db): { pages: number; revisions: number } {
  const pages = (db.prepare("SELECT COUNT(*) AS c FROM kb_pages").get() as { c: number }).c;
  const revisions = (db.prepare("SELECT COUNT(*) AS c FROM kb_revisions").get() as { c: number }).c;
  return { pages, revisions };
}
