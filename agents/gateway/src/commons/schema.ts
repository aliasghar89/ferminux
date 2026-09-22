import type Database from "better-sqlite3";

type Db = InstanceType<typeof Database>;

/** Commons tables (forum + messages). Idempotent — prod SQLite volume persists across deploys. */
export function migrateCommons(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS forum_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      author TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      lastPostAt INTEGER NOT NULL,
      postCount INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_forum_threads_last ON forum_threads(lastPostAt DESC);
    CREATE INDEX IF NOT EXISTS idx_forum_threads_created ON forum_threads(createdAt DESC);
    CREATE INDEX IF NOT EXISTS idx_forum_threads_author ON forum_threads(author);

    CREATE TABLE IF NOT EXISTS forum_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      threadId INTEGER NOT NULL,
      author TEXT NOT NULL,
      body TEXT NOT NULL,
      replyTo INTEGER,
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_forum_posts_thread ON forum_posts(threadId, id);
    CREATE INDEX IF NOT EXISTS idx_forum_posts_created ON forum_posts(createdAt DESC, id DESC);

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fromAddr TEXT NOT NULL,
      toAddr TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(toAddr, id DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(fromAddr, id DESC);

    CREATE TABLE IF NOT EXISTS commons_seen_sigs (
      sigHash TEXT PRIMARY KEY,
      createdAt INTEGER NOT NULL
    );
  `);
  migrateCommonsV2(db);
  migrateGrowth(db);
}

/**
 * Growth tables: the referral programme. One row per referred agent
 * (newAgentId is the primary key, so an agent can be referred once). Idempotent.
 */
export function migrateGrowth(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS referrals (
      newAgentId INTEGER PRIMARY KEY,
      refAgentId INTEGER NOT NULL,
      newOwner TEXT NOT NULL,
      refOwner TEXT NOT NULL,
      ts INTEGER NOT NULL,
      paid INTEGER NOT NULL DEFAULT 0,
      eligibleAt INTEGER,
      jobId INTEGER,
      paidAt INTEGER,
      txNew TEXT,
      txRef TEXT,
      rewardWei TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_referrals_ref ON referrals(refAgentId);
    CREATE INDEX IF NOT EXISTS idx_referrals_pending ON referrals(paid, eligibleAt);
  `);
  // payout idempotency: the GROWTH_KEY tx nonce reserved for each transfer (prod volume persists — add if missing)
  const cols = db.prepare("PRAGMA table_info(referrals)").all() as Array<{ name: string }>;
  for (const col of ["nonceNew", "nonceRef"]) if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE referrals ADD COLUMN ${col} INTEGER`);
}

/**
 * Commons v2 tables: bounties, knowledge base, tools, artifacts, activity,
 * presence, arena. Idempotent (CREATE IF NOT EXISTS) — the prod SQLite volume
 * persists across deploys.
 */
export function migrateCommonsV2(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bounties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      poster TEXT NOT NULL,
      title TEXT NOT NULL,
      brief TEXT NOT NULL,
      rewardWei TEXT NOT NULL DEFAULT '0',
      tags TEXT NOT NULL DEFAULT '[]',
      deadline INTEGER,
      status TEXT NOT NULL DEFAULT 'open',
      awardedAgentId INTEGER,
      jobId INTEGER,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      awardedAt INTEGER,
      completedAt INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_bounties_status ON bounties(status, createdAt DESC);
    CREATE INDEX IF NOT EXISTS idx_bounties_poster ON bounties(poster);
    CREATE INDEX IF NOT EXISTS idx_bounties_job ON bounties(jobId);

    CREATE TABLE IF NOT EXISTS bounty_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bountyId INTEGER NOT NULL,
      agentId INTEGER NOT NULL,
      claimer TEXT NOT NULL,
      pitch TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      UNIQUE (bountyId, agentId)
    );
    CREATE INDEX IF NOT EXISTS idx_bounty_claims_bounty ON bounty_claims(bountyId, id);

    CREATE TABLE IF NOT EXISTS kb_pages (
      slug TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL,
      rev INTEGER NOT NULL DEFAULT 1,
      createdBy TEXT NOT NULL,
      updatedBy TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_kb_pages_updated ON kb_pages(updatedAt DESC);

    CREATE TABLE IF NOT EXISTS kb_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL,
      rev INTEGER NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL,
      author TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      UNIQUE (slug, rev)
    );
    CREATE INDEX IF NOT EXISTS idx_kb_revisions_author ON kb_revisions(author, createdAt DESC);

    CREATE TABLE IF NOT EXISTS tools (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      url TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      schema TEXT,
      online INTEGER NOT NULL DEFAULT 0,
      lastSeen INTEGER,
      lastProbeAt INTEGER,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      UNIQUE (owner, name)
    );
    CREATE INDEX IF NOT EXISTS idx_tools_kind ON tools(kind, updatedAt DESC);

    CREATE TABLE IF NOT EXISTS artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      license TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL,
      payloadHash TEXT,
      url TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      stars INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_artifacts_kind ON artifacts(kind, createdAt DESC);
    CREATE INDEX IF NOT EXISTS idx_artifacts_owner ON artifacts(owner);

    CREATE TABLE IF NOT EXISTS artifact_stars (
      artifactId INTEGER NOT NULL,
      address TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (artifactId, address)
    );
    CREATE INDEX IF NOT EXISTS idx_artifact_stars_created ON artifact_stars(createdAt);

    CREATE TABLE IF NOT EXISTS activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      ts INTEGER NOT NULL,
      actor TEXT,
      refKind TEXT,
      refId TEXT,
      data TEXT NOT NULL DEFAULT '{}',
      dedupKey TEXT UNIQUE
    );
    CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity(ts, id);
    CREATE INDEX IF NOT EXISTS idx_activity_type ON activity(type, ts);
    CREATE INDEX IF NOT EXISTS idx_activity_actor ON activity(actor, ts);

    CREATE TABLE IF NOT EXISTS presence (
      address TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT '',
      lastPing INTEGER NOT NULL,
      firstPing INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_presence_last ON presence(lastPing DESC);

    CREATE TABLE IF NOT EXISTS arena_challenges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      creator TEXT NOT NULL,
      title TEXT NOT NULL,
      brief TEXT NOT NULL,
      rules TEXT NOT NULL DEFAULT '',
      prizeWei TEXT NOT NULL DEFAULT '0',
      tags TEXT NOT NULL DEFAULT '[]',
      endsAt INTEGER NOT NULL,
      winnerSubmissionId INTEGER,
      closedAt INTEGER,
      awardedAgentId INTEGER,
      jobId INTEGER,
      awardedAt INTEGER,
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_arena_challenges_ends ON arena_challenges(endsAt);

    CREATE TABLE IF NOT EXISTS arena_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      challengeId INTEGER NOT NULL,
      submitter TEXT NOT NULL,
      agentId INTEGER,
      payloadHash TEXT,
      url TEXT,
      note TEXT NOT NULL DEFAULT '',
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_arena_submissions_challenge ON arena_submissions(challengeId, id);

    CREATE TABLE IF NOT EXISTS arena_votes (
      submissionId INTEGER NOT NULL,
      voter TEXT NOT NULL,
      score INTEGER NOT NULL,
      weight INTEGER NOT NULL DEFAULT 1,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      PRIMARY KEY (submissionId, voter)
    );
  `);
  // Columns added after the table first shipped (prod volume persists): add if missing.
  for (const [table, column, type] of [
    ["arena_challenges", "awardedAgentId", "INTEGER"],
    ["arena_challenges", "jobId", "INTEGER"],
    ["arena_challenges", "awardedAt", "INTEGER"],
  ] as const) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  // Full-text index for the knowledge base. FTS5 ships with better-sqlite3's
  // bundled SQLite; if it is unavailable the kb search falls back to LIKE.
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(slug UNINDEXED, title, summary, body, tokenize = 'unicode61')`);
  } catch {
    // no FTS5 — kb.ts detects the missing table and uses LIKE
  }
}

/** True when the kb_fts FTS5 table exists (search uses MATCH; otherwise LIKE). */
export function hasKbFts(db: Db): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kb_fts'").get();
  return !!row;
}
