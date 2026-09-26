// Consistent snapshots of agents.db. The database is the only record of which pay-ins were paid out, which
// x402 nonces were settled or voided, which referral rewards were sent, the bounty/claim history and all
// Commons content — and until 2026-09-24 nothing backed it up: no cron, no restic on the host, and the Mac
// backup excluded docker volumes. The host has no sqlite3 binary either, so the gateway snapshots itself
// through SQLite's online backup API (safe while it keeps writing, WAL included) into BACKUP_DIR
// (default <DATA_DIR>/backups), keeps BACKUP_KEEP daily files plus agents-latest.db, and checks each copy
// before trusting it. An off-host copy still has to pull agents-latest.db (see the deploy notes): a snapshot
// on the same volume survives a bad migration or a deleted row, not a lost disk or `compose down -v`.
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Db } from "./db.js";
import { setMeta } from "./db.js";
import type { GatewayConfig } from "./config.js";

export const BACKUP_INTERVAL_H_DEFAULT = 24;
export const BACKUP_KEEP_DEFAULT = 7;

type Log = { info: (o: unknown, msg?: string) => void; error: (o: unknown, msg?: string) => void };

export interface BackupResult {
  file: string;
  bytes: number;
  at: number;
  counts: Record<string, number>;
}

function num(v: string | undefined, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/** Takes one snapshot, verifies it, rotates old ones. Throws on any failure (the caller logs and records it). */
export async function backupOnce(db: Db, dir: string, keep: number, now = new Date()): Promise<BackupResult> {
  mkdirSync(dir, { recursive: true });
  const day = now.toISOString().slice(0, 10);
  const tmp = join(dir, `.agents-${day}.db.tmp`);
  const file = join(dir, `agents-${day}.db`);
  if (existsSync(tmp)) unlinkSync(tmp);
  await db.backup(tmp);
  // A copy nobody has opened is not a backup: integrity check + the tables that hold money state.
  const counts: Record<string, number> = {};
  const check = new Database(tmp, { readonly: true, fileMustExist: true });
  try {
    const ok = check.pragma("quick_check", { simple: true });
    if (ok !== "ok") throw new Error(`snapshot failed quick_check: ${String(ok)}`);
    for (const t of ["payins", "payin_transfers", "x402_vouchers", "x402_settlements", "referrals", "bounties", "kb_pages", "messages"]) {
      try {
        counts[t] = (check.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;
      } catch {
        // table not created on this deployment yet
      }
    }
  } finally {
    check.close();
  }
  renameSync(tmp, file);
  const latestTmp = join(dir, ".agents-latest.db.tmp");
  await db.backup(latestTmp);
  renameSync(latestTmp, join(dir, "agents-latest.db"));
  const bytes = statSync(file).size;
  const at = Math.floor(now.getTime() / 1000);
  writeFileSync(join(dir, "latest.json"), JSON.stringify({ file: `agents-${day}.db`, at, bytes, counts }, null, 2));
  const dated = readdirSync(dir).filter((f) => /^agents-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  for (const old of dated.slice(0, Math.max(dated.length - keep, 0))) unlinkSync(join(dir, old));
  return { file, bytes, at, counts };
}

/** Starts the snapshot timer (first run 5 minutes after boot). Disabled for in-memory DBs and with BACKUP_DISABLE=1. */
export function startDbBackups(db: Db, cfg: GatewayConfig, log: Log): () => void {
  if (process.env.BACKUP_DISABLE === "1" || cfg.dataDir === ":memory:" || db.memory) return () => undefined;
  const dir = process.env.BACKUP_DIR || join(cfg.dataDir, "backups");
  const everyMs = num(process.env.BACKUP_INTERVAL_H, BACKUP_INTERVAL_H_DEFAULT) * 3_600_000;
  const keep = Math.floor(num(process.env.BACKUP_KEEP, BACKUP_KEEP_DEFAULT));
  setMeta(db, "backup:intervalS", String(Math.round(everyMs / 1000)));
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const r = await backupOnce(db, dir, keep);
      setMeta(db, "backup:lastAt", String(r.at));
      setMeta(db, "backup:lastError", "");
      log.info({ file: r.file, bytes: r.bytes, counts: r.counts }, "agents.db snapshot written");
    } catch (err) {
      setMeta(db, "backup:lastErrorAt", String(Math.floor(Date.now() / 1000)));
      setMeta(db, "backup:lastError", (err as Error).message.slice(0, 300));
      log.error({ err: (err as Error).message }, "agents.db snapshot FAILED");
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void run(), 300_000);
  const timer = setInterval(() => void run(), everyMs);
  first.unref?.();
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
