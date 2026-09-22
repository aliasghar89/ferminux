import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { migrateCommons } from "./commons/schema.js";
import { migrateV3 } from "./v3/schema.js";

export type Db = InstanceType<typeof Database>;

export function openDb(dataDir: string): Db {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, "agents.db");
  const db = new Database(path, { timeout: 5000 }); // busy_timeout: a concurrent reader (sqlite3 CLI, backup) never surfaces SQLITE_BUSY
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

/** In-memory DB with the full schema — for tests. */
export function openMemoryDb(): Db {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agents (
      id INTEGER PRIMARY KEY,
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      metadataURI TEXT NOT NULL DEFAULT '',
      pricePerJob TEXT NOT NULL DEFAULT '0',
      bond TEXT NOT NULL DEFAULT '0',
      status INTEGER NOT NULL DEFAULT 0,
      registeredAt INTEGER NOT NULL DEFAULT 0,
      retiredAt INTEGER NOT NULL DEFAULT 0,
      jobsCompleted INTEGER NOT NULL DEFAULT 0,
      jobsFailed INTEGER NOT NULL DEFAULT 0,
      ratingCount INTEGER NOT NULL DEFAULT 0,
      ratingSum INTEGER NOT NULL DEFAULT 0,
      card TEXT,
      online INTEGER NOT NULL DEFAULT 0,
      lastSeen INTEGER,
      updatedAtBlock INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
    CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents(owner);

    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY,
      agentId INTEGER NOT NULL,
      client TEXT NOT NULL,
      amount TEXT NOT NULL DEFAULT '0',
      inputHash TEXT NOT NULL DEFAULT '',
      inputURI TEXT NOT NULL DEFAULT '',
      outputHash TEXT,
      outputURI TEXT,
      createdAt INTEGER NOT NULL DEFAULT 0,
      deliveredAt INTEGER,
      status INTEGER NOT NULL DEFAULT 0,
      txRequested TEXT,
      txDelivered TEXT,
      txClosed TEXT,
      updatedAtBlock INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_agentId ON jobs(agentId);
    CREATE INDEX IF NOT EXISTS idx_jobs_client ON jobs(client);
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

    CREATE TABLE IF NOT EXISTS events (
      txHash TEXT NOT NULL,
      logIndex INTEGER NOT NULL,
      blockNumber INTEGER NOT NULL,
      contractName TEXT NOT NULL,
      eventName TEXT NOT NULL,
      argsJSON TEXT NOT NULL,
      PRIMARY KEY (txHash, logIndex)
    );
    CREATE INDEX IF NOT EXISTS idx_events_block ON events(blockNumber);
    CREATE INDEX IF NOT EXISTS idx_events_contract ON events(contractName, eventName);

    CREATE TABLE IF NOT EXISTS payloads (
      hash TEXT PRIMARY KEY,
      contentType TEXT NOT NULL,
      bytes BLOB NOT NULL,
      size INTEGER NOT NULL,
      createdAt INTEGER NOT NULL
    );
  `);
  // block timestamp column added with Addendum v3 (prod volume persists): add if missing
  const eventCols = db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>;
  if (!eventCols.some((c) => c.name === "ts")) db.exec("ALTER TABLE events ADD COLUMN ts INTEGER");
  migrateCommons(db);
  migrateV3(db);
}

export function getMeta(db: Db, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    value,
  );
}
