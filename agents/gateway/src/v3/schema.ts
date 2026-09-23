import type Database from "better-sqlite3";

type Db = InstanceType<typeof Database>;

/**
 * Addendum v3 tables: x402 vouchers/settlements, webhooks + deliveries,
 * private memory + paid credits, USDC pay-ins, gas relays, and the state
 * derived from the v3 contract events (streams, plans, subs, cases, tokens,
 * accounts, feedback, validations). Idempotent (CREATE IF NOT EXISTS) — the
 * prod SQLite volume persists across deploys.
 */
export function migrateV3(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS x402_vouchers (
      payer TEXT NOT NULL,
      nonce TEXT NOT NULL,
      payee TEXT NOT NULL,
      amount TEXT NOT NULL,
      ref TEXT NOT NULL,
      expiry INTEGER NOT NULL,
      sig TEXT NOT NULL,
      resource TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'queued',
      txHash TEXT,
      error TEXT,
      createdAt INTEGER NOT NULL,
      settledAt INTEGER,
      PRIMARY KEY (payer, nonce)
    );
    CREATE INDEX IF NOT EXISTS idx_x402_vouchers_status ON x402_vouchers(status, createdAt);
    CREATE INDEX IF NOT EXISTS idx_x402_vouchers_payee ON x402_vouchers(payee, createdAt DESC);

    CREATE TABLE IF NOT EXISTS x402_settlements (
      txHash TEXT NOT NULL,
      logIndex INTEGER NOT NULL,
      payer TEXT NOT NULL,
      payee TEXT NOT NULL,
      amount TEXT NOT NULL,
      fee TEXT NOT NULL DEFAULT '0',
      nonce TEXT NOT NULL,
      ref TEXT NOT NULL DEFAULT '',
      blockNumber INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      PRIMARY KEY (txHash, logIndex)
    );
    CREATE INDEX IF NOT EXISTS idx_x402_settlements_payee ON x402_settlements(payee, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_x402_settlements_payer ON x402_settlements(payer, ts DESC);

    CREATE TABLE IF NOT EXISTS webhooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner TEXT NOT NULL,
      url TEXT NOT NULL,
      secret TEXT NOT NULL,
      events TEXT NOT NULL DEFAULT '[]',
      active INTEGER NOT NULL DEFAULT 1,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      UNIQUE (owner, url)
    );
    CREATE INDEX IF NOT EXISTS idx_webhooks_owner ON webhooks(owner);

    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      webhookId INTEGER NOT NULL,
      owner TEXT NOT NULL,
      event TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      nextAt INTEGER NOT NULL,
      lastStatus INTEGER,
      lastError TEXT,
      createdAt INTEGER NOT NULL,
      deliveredAt INTEGER,
      dedupKey TEXT UNIQUE
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due ON webhook_deliveries(status, nextAt);
    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_owner ON webhook_deliveries(owner, id DESC);
    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_hook ON webhook_deliveries(webhookId, id DESC);

    CREATE TABLE IF NOT EXISTS memory (
      address TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      size INTEGER NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      PRIMARY KEY (address, key)
    );

    CREATE TABLE IF NOT EXISTS memory_credits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      address TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      payer TEXT NOT NULL,
      nonce TEXT NOT NULL,
      amount TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      expiresAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_credits_addr ON memory_credits(address, expiresAt);

    CREATE TABLE IF NOT EXISTS payins (
      quoteId TEXT PRIMARY KEY,
      chain TEXT NOT NULL,
      usdc TEXT NOT NULL,
      usdcUnits TEXT NOT NULL,
      asset TEXT NOT NULL DEFAULT 'USDC',
      amount TEXT,
      amountUnits TEXT,
      usd TEXT,
      fmxOut TEXT NOT NULL,
      priceUsdPerFmx TEXT NOT NULL,
      target TEXT NOT NULL,
      payer TEXT,
      depositAddress TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'quoted',
      txHashIn TEXT,
      blockIn INTEGER,
      confirmations INTEGER NOT NULL DEFAULT 0,
      txHashOut TEXT,
      error TEXT,
      createdAt INTEGER NOT NULL,
      expiresAt INTEGER NOT NULL,
      seenAt INTEGER,
      paidAt INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_payins_status ON payins(status, createdAt);
    CREATE INDEX IF NOT EXISTS idx_payins_txin ON payins(txHashIn);
    CREATE INDEX IF NOT EXISTS idx_payins_open ON payins(chain, status, expiresAt);

    CREATE TABLE IF NOT EXISTS payin_transfers (
      chain TEXT NOT NULL,
      txHash TEXT NOT NULL,
      logIndex INTEGER NOT NULL,
      fromAddr TEXT NOT NULL,
      units TEXT NOT NULL,
      blockNumber INTEGER NOT NULL,
      asset TEXT NOT NULL DEFAULT 'USDC',
      quoteId TEXT,
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (chain, txHash, logIndex)
    );

    CREATE TABLE IF NOT EXISTS relays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      subject TEXT NOT NULL,
      target TEXT,
      txHash TEXT,
      ok INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      gasLimit INTEGER,
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_relays_subject ON relays(kind, subject, createdAt);

    CREATE TABLE IF NOT EXISTS streams (
      id INTEGER PRIMARY KEY,
      payer TEXT NOT NULL,
      payee TEXT NOT NULL,
      ratePerSec TEXT NOT NULL DEFAULT '0',
      deposit TEXT NOT NULL DEFAULT '0',
      claimed TEXT NOT NULL DEFAULT '0',
      start INTEGER NOT NULL DEFAULT 0,
      stop INTEGER NOT NULL DEFAULT 0,
      cancelled INTEGER NOT NULL DEFAULT 0,
      txOpened TEXT,
      updatedAtBlock INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_streams_payer ON streams(payer);
    CREATE INDEX IF NOT EXISTS idx_streams_payee ON streams(payee);

    CREATE TABLE IF NOT EXISTS plans (
      id INTEGER PRIMARY KEY,
      payee TEXT NOT NULL,
      pricePerPeriod TEXT NOT NULL DEFAULT '0',
      period INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      metadataURI TEXT NOT NULL DEFAULT '',
      createdAt INTEGER NOT NULL DEFAULT 0,
      updatedAtBlock INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_plans_payee ON plans(payee);

    CREATE TABLE IF NOT EXISTS subs (
      id INTEGER PRIMARY KEY,
      planId INTEGER NOT NULL,
      payer TEXT NOT NULL,
      paidThrough INTEGER NOT NULL DEFAULT 0,
      cancelled INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL DEFAULT 0,
      updatedAtBlock INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_subs_plan ON subs(planId);
    CREATE INDEX IF NOT EXISTS idx_subs_payer ON subs(payer);

    CREATE TABLE IF NOT EXISTS arbiter_cases (
      id INTEGER PRIMARY KEY,
      jobId INTEGER NOT NULL,
      opener TEXT NOT NULL,
      evidenceURI TEXT NOT NULL DEFAULT '',
      openedAt INTEGER NOT NULL DEFAULT 0,
      votes INTEGER NOT NULL DEFAULT 0,
      closed INTEGER NOT NULL DEFAULT 0,
      result INTEGER,
      closedAt INTEGER,
      txOpened TEXT,
      updatedAtBlock INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_arbiter_cases_job ON arbiter_cases(jobId);

    CREATE TABLE IF NOT EXISTS case_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      caseId INTEGER NOT NULL,
      by TEXT NOT NULL,
      uri TEXT NOT NULL,
      ts INTEGER NOT NULL,
      txHash TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_case_evidence_case ON case_evidence(caseId, id);

    CREATE TABLE IF NOT EXISTS v3_counted (txHash TEXT NOT NULL, logIndex INTEGER NOT NULL, PRIMARY KEY (txHash, logIndex));
    CREATE TABLE IF NOT EXISTS agent_tokens (
      token TEXT PRIMARY KEY,
      agentId INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      launchedAt INTEGER NOT NULL DEFAULT 0,
      buys INTEGER NOT NULL DEFAULT 0,
      sells INTEGER NOT NULL DEFAULT 0,
      fmxIn TEXT NOT NULL DEFAULT '0',
      fmxOut TEXT NOT NULL DEFAULT '0',
      distributed TEXT NOT NULL DEFAULT '0',
      txLaunched TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_tokens_agent ON agent_tokens(agentId);

    CREATE TABLE IF NOT EXISTS agent_accounts (
      account TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      createdAt INTEGER NOT NULL DEFAULT 0,
      txHash TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_accounts_owner ON agent_accounts(owner);

    CREATE TABLE IF NOT EXISTS reputation_feedback (
      txHash TEXT NOT NULL,
      logIndex INTEGER NOT NULL,
      agentId INTEGER NOT NULL,
      client TEXT NOT NULL,
      value TEXT NOT NULL,
      valueDecimals INTEGER NOT NULL DEFAULT 0,
      tag1 TEXT NOT NULL DEFAULT '',
      tag2 TEXT NOT NULL DEFAULT '',
      feedbackURI TEXT NOT NULL DEFAULT '',
      ts INTEGER NOT NULL,
      PRIMARY KEY (txHash, logIndex)
    );
    CREATE INDEX IF NOT EXISTS idx_reputation_feedback_agent ON reputation_feedback(agentId, ts DESC);

    CREATE TABLE IF NOT EXISTS validations (
      requestHash TEXT PRIMARY KEY,
      validator TEXT NOT NULL,
      agentId INTEGER NOT NULL,
      requestURI TEXT NOT NULL DEFAULT '',
      response INTEGER,
      responseURI TEXT,
      tag TEXT,
      requestedAt INTEGER NOT NULL DEFAULT 0,
      respondedAt INTEGER,
      txRequest TEXT,
      txResponse TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_validations_agent ON validations(agentId, requestedAt DESC);

    -- ---- The record lane (AI-CV): memory records, their merkle anchors, endorsements, probe history ----

    -- One append-only header per memory write. The value never leaves the memory
    -- table: a record carries only commitments (keyCommit is SALTED with keyNonce,
    -- which stays private, so an anchored header can never leak a key name).
    CREATE TABLE IF NOT EXISTS memory_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      address TEXT NOT NULL,
      seq INTEGER NOT NULL,
      op TEXT NOT NULL,
      key TEXT NOT NULL,
      keyNonce TEXT NOT NULL,
      keyCommit TEXT NOT NULL,
      valueHash TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      prev TEXT NOT NULL,
      recordHash TEXT NOT NULL,
      ts INTEGER NOT NULL,
      batchId INTEGER,
      leafIndex INTEGER,
      UNIQUE (address, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_records_open ON memory_records(address, batchId, seq);
    CREATE INDEX IF NOT EXISTS idx_memory_records_batch ON memory_records(batchId, leafIndex);

    -- One row per merkle batch: built by POST /api/memory/anchor, submitted by the
    -- agent, confirmed by the indexer when MemoryAnchored lands.
    CREATE TABLE IF NOT EXISTS memory_anchors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agentId INTEGER NOT NULL,
      address TEXT NOT NULL,
      root TEXT NOT NULL,
      prevRoot TEXT NOT NULL,
      count INTEGER NOT NULL,
      fromSeq INTEGER NOT NULL,
      toSeq INTEGER NOT NULL,
      uri TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'built',
      onchainSeq INTEGER,
      totalRecords INTEGER,
      anchoredBy TEXT,
      txHash TEXT,
      blockNumber INTEGER,
      createdAt INTEGER NOT NULL,
      submittedAt INTEGER,
      anchoredAt INTEGER,
      UNIQUE (agentId, root)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_anchors_agent ON memory_anchors(agentId, id DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_anchors_status ON memory_anchors(status, id);
    CREATE INDEX IF NOT EXISTS idx_memory_anchors_tx ON memory_anchors(txHash);

    CREATE TABLE IF NOT EXISTS endorsements (
      id INTEGER PRIMARY KEY,
      fromAgentId INTEGER NOT NULL,
      toAgentId INTEGER NOT NULL,
      endorser TEXT NOT NULL DEFAULT '',
      capability TEXT NOT NULL DEFAULT '',
      capabilityId TEXT NOT NULL DEFAULT '',
      basis INTEGER NOT NULL DEFAULT 0,
      weight INTEGER NOT NULL DEFAULT 0,
      evidenceJobId INTEGER NOT NULL DEFAULT 0,
      evidenceAmountWei TEXT NOT NULL DEFAULT '0',
      uri TEXT NOT NULL DEFAULT '',
      revoked INTEGER NOT NULL DEFAULT 0,
      ts INTEGER NOT NULL DEFAULT 0,
      txHash TEXT,
      logIndex INTEGER,
      blockNumber INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_endorsements_to ON endorsements(toAgentId, revoked, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_endorsements_from ON endorsements(fromAgentId, ts DESC);

    -- Daily rollup of the health probe. startHealthProbe() overwrote agents.online
    -- in place, so uptime was unknowable; 288 probes/day fold into one row.
    CREATE TABLE IF NOT EXISTS agent_probes_daily (
      agentId INTEGER NOT NULL,
      day INTEGER NOT NULL,
      ok INTEGER NOT NULL DEFAULT 0,
      fail INTEGER NOT NULL DEFAULT 0,
      lastMs INTEGER,
      PRIMARY KEY (agentId, day)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_probes_day ON agent_probes_daily(day);
  `);
  // Columns added after a table first shipped (prod volume persists): add if missing.
  for (const [table, column, type] of [
    ["tools", "compute", "TEXT"], ["validations", "jobId", "INTEGER"],
    ["x402_vouchers", "attempts", "INTEGER NOT NULL DEFAULT 0"],
    ["relays", "ip", "TEXT"],
    // pay-in v2 (multi-asset): asset symbol, human amount, exact token units the payer must send (incl. dust), USD value
    ["payins", "asset", "TEXT NOT NULL DEFAULT 'USDC'"], ["payins", "amount", "TEXT"], ["payins", "amountUnits", "TEXT"], ["payins", "usd", "TEXT"],
    ["payin_transfers", "asset", "TEXT NOT NULL DEFAULT 'USDC'"],
  ] as const) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (cols.length && !cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
