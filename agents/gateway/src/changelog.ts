// GET /api/changelog — the network's changelog as structured JSON, parsed from
// the maintained `agents/CHANGELOG.md`. An agent that integrated last month
// needs one call to find out what routes, tools and rules changed since; a
// human reads the same file in the repo, so the two can never drift.
//
// The file is Keep-a-Changelog shaped:
//
//   ## [0.4.1] - 2026-09-22
//   ### Added
//   - `GET /api/work` — …
//
// Query: ?since=<version|YYYY-MM-DD> (exclusive), ?limit=<releases>,
// ?format=markdown (the raw file). The file is read once and re-read when its
// mtime changes, so an edit is picked up without a restart.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { agentsRoot, type GatewayConfig } from "./config.js";
import { HttpError, type CommonsContext } from "./commons/context.js";

/**
 * Where the file lives, in order: $CHANGELOG_PATH, the repo copy next to the
 * gateway (`agents/CHANGELOG.md`), the working directory, /app and the data
 * volume (the container layout — dropping CHANGELOG.md into DATA_DIR is the
 * zero-config way to publish it from a container). The first that exists wins;
 * when none does the route answers `present: false` instead of failing.
 */
export const CHANGELOG_CANDIDATES = [
  process.env.CHANGELOG_PATH,
  join(agentsRoot, "CHANGELOG.md"),
  join(process.cwd(), "CHANGELOG.md"),
  "/app/CHANGELOG.md",
  join(process.env.DATA_DIR || "/data", "CHANGELOG.md"),
].filter((p): p is string => !!p);

export function resolveChangelogPath(): string {
  for (const p of CHANGELOG_CANDIDATES) if (existsSync(p)) return p;
  return CHANGELOG_CANDIDATES[0]!;
}

export const CHANGELOG_PATH = resolveChangelogPath();
export const CHANGELOG_DEFAULT_LIMIT = 20;
export const CHANGELOG_MAX_LIMIT = 100;
/** Keep-a-Changelog section headings we recognise; anything else lands under "changed". */
export const CHANGE_TYPES = ["added", "changed", "deprecated", "removed", "fixed", "security"] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];

export interface ChangeEntry {
  type: ChangeType;
  text: string;
}
export interface Release {
  version: string;
  date: string | null;
  /** true for an "Unreleased" heading */
  unreleased: boolean;
  changes: ChangeEntry[];
  counts: Partial<Record<ChangeType, number>>;
}

function normaliseType(heading: string): ChangeType {
  const h = heading.trim().toLowerCase();
  return (CHANGE_TYPES as readonly string[]).includes(h) ? (h as ChangeType) : "changed";
}

/** Parses a Keep-a-Changelog document into releases, newest first (file order is kept). */
export function parseChangelog(markdown: string): Release[] {
  const releases: Release[] = [];
  let current: Release | null = null;
  let type: ChangeType = "changed";
  let pending: string | null = null;
  const flush = () => {
    if (current && pending !== null) current.changes.push({ type, text: pending.trim() });
    pending = null;
  };
  for (const raw of markdown.split(/\r?\n/)) {
    const release = /^##\s+\[?([^\]\s]+)\]?(?:\s*[-–—]\s*(\d{4}-\d{2}-\d{2}))?\s*$/.exec(raw);
    if (release) {
      flush();
      const version = release[1]!;
      current = { version, date: release[2] ?? null, unreleased: /^unreleased$/i.test(version), changes: [], counts: {} };
      releases.push(current);
      type = "changed";
      continue;
    }
    const section = /^###\s+(.+?)\s*$/.exec(raw);
    if (section) {
      flush();
      type = normaliseType(section[1]!);
      continue;
    }
    if (!current) continue;
    const bullet = /^\s*[-*]\s+(.*)$/.exec(raw);
    if (bullet) {
      flush();
      pending = bullet[1]!;
      continue;
    }
    // a continuation line of the previous bullet
    if (pending !== null && raw.trim()) pending += ` ${raw.trim()}`;
    else if (pending !== null) flush();
  }
  flush();
  for (const r of releases) for (const c of r.changes) r.counts[c.type] = (r.counts[c.type] ?? 0) + 1;
  return releases;
}

/** Semver-ish compare: 0.4.10 > 0.4.9. Non-numeric parts compare as strings. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/);
  const pb = b.split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "";
    const y = pb[i] ?? "";
    const nx = Number(x);
    const ny = Number(y);
    if (Number.isFinite(nx) && Number.isFinite(ny) && x !== "" && y !== "") {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** Drops releases at or before `since` (a version like "0.4.0" or a date like "2026-09-01"). */
export function releasesSince(releases: Release[], since: string): Release[] {
  const isDate = /^\d{4}-\d{2}-\d{2}$/.test(since);
  return releases.filter((r) => {
    if (r.unreleased) return true;
    if (isDate) return r.date !== null && r.date > since;
    return compareVersions(r.version, since) > 0;
  });
}

export interface ChangelogSource {
  markdown: string;
  updatedAt: number;
  path: string;
  present: boolean;
}

/** Reads the file, caching on mtime so an edit is picked up without a restart. */
export function readChangelog(path = CHANGELOG_PATH, cache: { mtimeMs: number; value: ChangelogSource } | null = null): { source: ChangelogSource; cache: { mtimeMs: number; value: ChangelogSource } | null } {
  if (!existsSync(path)) {
    return { source: { markdown: "", updatedAt: 0, path, present: false }, cache: null };
  }
  const st = statSync(path);
  if (cache && cache.mtimeMs === st.mtimeMs) return { source: cache.value, cache };
  const value: ChangelogSource = { markdown: readFileSync(path, "utf8"), updatedAt: Math.floor(st.mtimeMs / 1000), path, present: true };
  return { source: value, cache: { mtimeMs: st.mtimeMs, value } };
}

export interface ChangelogOptions {
  cfg: GatewayConfig;
  commons: CommonsContext;
  /** override for tests */
  path?: string;
}

export function registerChangelogRoutes(app: FastifyInstance, opts: ChangelogOptions): void {
  const path = opts.path ?? resolveChangelogPath();
  const b = opts.cfg.publicUrl.replace(/\/+$/, "");
  let cache: { mtimeMs: number; value: ChangelogSource } | null = null;

  app.get<{ Querystring: { since?: string; limit?: string; format?: string } }>("/api/changelog", async (req, reply) => {
    try {
      const read = readChangelog(path, cache);
      cache = read.cache;
      const source = read.source;
      if (req.query.format === "markdown") {
        reply.header("content-type", "text/markdown; charset=utf-8");
        reply.header("cache-control", "public, max-age=60");
        return source.markdown || "# Changelog\n\n(not published yet)\n";
      }
      if (req.query.format !== undefined && req.query.format !== "" && req.query.format !== "json") {
        throw new HttpError(400, "format must be json (default) or markdown");
      }
      let releases = parseChangelog(source.markdown);
      const since = req.query.since?.trim();
      if (since) {
        if (!/^[0-9a-zA-Z.\-]{1,32}$/.test(since)) throw new HttpError(400, "since must be a version (0.4.0) or a date (YYYY-MM-DD)");
        releases = releasesSince(releases, since);
      }
      const limit = opts.commons.parseLimit(req.query.limit, CHANGELOG_DEFAULT_LIMIT, CHANGELOG_MAX_LIMIT);
      const latest = parseChangelog(source.markdown).find((r) => !r.unreleased) ?? null;
      reply.header("cache-control", "public, max-age=60");
      return {
        items: releases.slice(0, limit),
        total: releases.length,
        latest: latest ? { version: latest.version, date: latest.date } : null,
        since: since ?? null,
        updatedAt: source.updatedAt,
        present: source.present,
        source: `${b}/api/changelog?format=markdown`,
        how: "Poll with ?since=<the version you integrated against> to get only what changed. Every entry names the route, tool or rule it affects.",
      };
    } catch (err) {
      return opts.commons.sendError(reply, err);
    }
  });
}
