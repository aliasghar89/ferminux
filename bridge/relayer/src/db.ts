// Durable state.
//
// Everything that must survive a kill -9 lives here: how far each chain has been
// scanned, every transfer ever seen, every signature collected, and — critically
// — every transaction the submitter has SIGNED, with its account nonce, recorded
// BEFORE it was broadcast. That last detail is the whole of the no-double-submit
// guarantee: all retries for a transfer reuse one account nonce, so at most one
// of them can ever be mined, and a crash between signing and broadcasting leaves
// a record we can resume from instead of a mystery.
//
// Two backends, one interface:
//   sqlite  — node:sqlite (built into Node 22.5+; no native module to compile,
//             no supply-chain surface). Preferred.
//   journal — append-only NDJSON replayed into memory at startup. Used when
//             node:sqlite is unavailable, and by anyone who would rather have a
//             file they can read with `tail`.
//
// bigints are stored as decimal TEXT. Never as REAL, never as INTEGER.

import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BridgeTransfer } from './transfer.ts';
import { parseTransfer, serializeTransfer } from './transfer.ts';

export type TransferStatus =
  /** Log observed, not yet deep enough to trust. */
  | 'seen'
  /** Survived `confirmations` and a re-read of the log. Safe to act on. */
  | 'confirmed'
  /** This node signed it (validator role). */
  | 'signed'
  /** This node refused it. `reason` says why. Never retried automatically. */
  | 'rejected'
  /** Observed as processed on the destination chain. Terminal. */
  | 'executed'
  /** The log disappeared or changed under us. Terminal, alerts. */
  | 'orphaned';

export interface StoredTransfer {
  transferId: string;
  transfer: BridgeTransfer;
  fee: bigint;
  srcBlockNumber: number;
  srcBlockHash: string;
  srcTxHash: string;
  srcLogIndex: number;
  status: TransferStatus;
  reason: string | null;
  firstSeenAt: number;
  confirmedAt: number | null;
  executedAt: number | null;
  executedTxHash: string | null;
  updatedAt: number;
}

export interface StoredSignature {
  transferId: string;
  /** Checksummed address recovered from the signature — never a claimed field. */
  signer: string;
  signature: string;
  /** 'local' or the peer name it was fetched from. Provenance, not authority. */
  origin: string;
  createdAt: number;
}

export interface SubmissionAttempt {
  txHash: string;
  raw: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  gasLimit: string;
  sentAt: number;
  /**
   * The validators whose signatures are inside `raw`, checksummed.
   *
   * Recorded because a bundle is only valid against the validator set that was
   * live when it was built: execute() rejects the WHOLE bundle if one signer has
   * since been removed. Knowing who is in the transaction sitting in the mempool
   * is what lets the submitter notice a rotation and re-slice immediately,
   * instead of waiting out the receipt timeout on a transaction that can only
   * revert. Optional because rows written before this field existed do not have
   * it — treat a missing value as "unknown", never as "empty".
   */
  signers?: string[];
}

export type SubmissionStatus = 'pending' | 'mined' | 'failed' | 'abandoned';

export interface StoredSubmission {
  transferId: string;
  dstChainId: number;
  /** Shared by every attempt: only one attempt can ever be mined. */
  accountNonce: number;
  attempts: SubmissionAttempt[];
  status: SubmissionStatus;
  minedTxHash: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Rolling volume bucket, mirroring FerminuxBridge's draining-window maths. */
export interface StoredWindow {
  key: string;
  used: bigint;
  updatedAt: number;
}

export interface Store {
  readonly driver: 'sqlite' | 'journal';

  getCursor(chainId: number): number | null;
  setCursor(chainId: number, block: number): void;

  putTransfer(t: StoredTransfer): void;
  getTransfer(transferId: string): StoredTransfer | null;
  listTransfers(filter: { status?: TransferStatus[]; dstChainId?: number; limit?: number }): StoredTransfer[];
  setTransferStatus(transferId: string, status: TransferStatus, reason?: string | null): void;
  markExecuted(transferId: string, txHash: string | null): void;

  putSignature(sig: StoredSignature): void;
  getSignatures(transferId: string): StoredSignature[];

  getSubmission(transferId: string): StoredSubmission | null;
  putSubmission(sub: StoredSubmission): void;
  listSubmissions(status: SubmissionStatus): StoredSubmission[];

  getWindow(key: string): StoredWindow | null;
  putWindow(w: StoredWindow): void;

  counts(): Record<string, number>;
  close(): void;
}

// --------------------------------------------------------------------- sqlite

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cursors (
  chain_id   INTEGER PRIMARY KEY,
  block      INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS transfers (
  transfer_id      TEXT PRIMARY KEY,
  src_chain_id     INTEGER NOT NULL,
  dst_chain_id     INTEGER NOT NULL,
  nonce            INTEGER NOT NULL,
  src_token        TEXT NOT NULL,
  dst_token        TEXT NOT NULL,
  sender           TEXT NOT NULL,
  recipient        TEXT NOT NULL,
  amount           TEXT NOT NULL,
  fee              TEXT NOT NULL,
  src_block_number INTEGER NOT NULL,
  src_block_hash   TEXT NOT NULL,
  src_tx_hash      TEXT NOT NULL,
  src_log_index    INTEGER NOT NULL,
  status           TEXT NOT NULL,
  reason           TEXT,
  first_seen_at    INTEGER NOT NULL,
  confirmed_at     INTEGER,
  executed_at      INTEGER,
  executed_tx_hash TEXT,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS transfers_status  ON transfers(status);
CREATE INDEX IF NOT EXISTS transfers_dst     ON transfers(dst_chain_id, status);
CREATE TABLE IF NOT EXISTS signatures (
  transfer_id TEXT NOT NULL,
  signer      TEXT NOT NULL,
  signature   TEXT NOT NULL,
  origin      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (transfer_id, signer)
);
CREATE TABLE IF NOT EXISTS submissions (
  transfer_id   TEXT PRIMARY KEY,
  dst_chain_id  INTEGER NOT NULL,
  account_nonce INTEGER NOT NULL,
  attempts      TEXT NOT NULL,
  status        TEXT NOT NULL,
  mined_tx_hash TEXT,
  last_error    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS submissions_status ON submissions(status);
CREATE TABLE IF NOT EXISTS windows (
  key        TEXT PRIMARY KEY,
  used       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

interface SqliteRow {
  [key: string]: unknown;
}

class SqliteStore implements Store {
  readonly driver = 'sqlite' as const;
  private readonly db: {
    exec(sql: string): void;
    prepare(sql: string): { run(...a: unknown[]): unknown; get(...a: unknown[]): SqliteRow | undefined; all(...a: unknown[]): SqliteRow[] };
    close(): void;
  };

  constructor(db: SqliteStore['db']) {
    this.db = db;
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = FULL;');
    this.db.exec(SCHEMA);
  }

  getCursor(chainId: number): number | null {
    const row = this.db.prepare('SELECT block FROM cursors WHERE chain_id = ?').get(chainId);
    return row ? Number(row.block) : null;
  }

  setCursor(chainId: number, block: number): void {
    this.db
      .prepare('INSERT INTO cursors (chain_id, block, updated_at) VALUES (?, ?, ?) ON CONFLICT(chain_id) DO UPDATE SET block = excluded.block, updated_at = excluded.updated_at')
      .run(chainId, block, Date.now());
  }

  putTransfer(t: StoredTransfer): void {
    this.db
      .prepare(
        `INSERT INTO transfers (transfer_id, src_chain_id, dst_chain_id, nonce, src_token, dst_token, sender, recipient,
           amount, fee, src_block_number, src_block_hash, src_tx_hash, src_log_index, status, reason, first_seen_at,
           confirmed_at, executed_at, executed_tx_hash, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(transfer_id) DO UPDATE SET
           src_block_number = excluded.src_block_number,
           src_block_hash   = excluded.src_block_hash,
           src_tx_hash      = excluded.src_tx_hash,
           src_log_index    = excluded.src_log_index,
           status           = excluded.status,
           reason           = excluded.reason,
           confirmed_at     = excluded.confirmed_at,
           executed_at      = excluded.executed_at,
           executed_tx_hash = excluded.executed_tx_hash,
           updated_at       = excluded.updated_at`,
      )
      .run(
        t.transferId,
        t.transfer.srcChainId,
        t.transfer.dstChainId,
        t.transfer.nonce,
        t.transfer.srcToken,
        t.transfer.dstToken,
        t.transfer.sender,
        t.transfer.recipient,
        t.transfer.amount.toString(),
        t.fee.toString(),
        t.srcBlockNumber,
        t.srcBlockHash,
        t.srcTxHash,
        t.srcLogIndex,
        t.status,
        t.reason,
        t.firstSeenAt,
        t.confirmedAt,
        t.executedAt,
        t.executedTxHash,
        t.updatedAt,
      );
  }

  getTransfer(transferId: string): StoredTransfer | null {
    const row = this.db.prepare('SELECT * FROM transfers WHERE transfer_id = ?').get(transferId);
    return row ? rowToTransfer(row) : null;
  }

  listTransfers(filter: { status?: TransferStatus[]; dstChainId?: number; limit?: number }): StoredTransfer[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.status && filter.status.length > 0) {
      where.push(`status IN (${filter.status.map(() => '?').join(',')})`);
      args.push(...filter.status);
    }
    if (filter.dstChainId !== undefined) {
      where.push('dst_chain_id = ?');
      args.push(filter.dstChainId);
    }
    const sql = `SELECT * FROM transfers ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY first_seen_at ASC LIMIT ?`;
    args.push(filter.limit ?? 500);
    return this.db.prepare(sql).all(...args).map(rowToTransfer);
  }

  setTransferStatus(transferId: string, status: TransferStatus, reason?: string | null): void {
    const now = Date.now();
    this.db
      .prepare('UPDATE transfers SET status = ?, reason = ?, confirmed_at = CASE WHEN ? = \'confirmed\' AND confirmed_at IS NULL THEN ? ELSE confirmed_at END, updated_at = ? WHERE transfer_id = ?')
      .run(status, reason ?? null, status, now, now, transferId);
  }

  markExecuted(transferId: string, txHash: string | null): void {
    const now = Date.now();
    this.db
      .prepare('UPDATE transfers SET status = \'executed\', executed_at = ?, executed_tx_hash = ?, updated_at = ? WHERE transfer_id = ?')
      .run(now, txHash, now, transferId);
  }

  putSignature(sig: StoredSignature): void {
    this.db
      .prepare('INSERT INTO signatures (transfer_id, signer, signature, origin, created_at) VALUES (?,?,?,?,?) ON CONFLICT(transfer_id, signer) DO NOTHING')
      .run(sig.transferId, sig.signer, sig.signature, sig.origin, sig.createdAt);
  }

  getSignatures(transferId: string): StoredSignature[] {
    return this.db
      .prepare('SELECT * FROM signatures WHERE transfer_id = ? ORDER BY signer ASC')
      .all(transferId)
      .map((r) => ({
        transferId: String(r.transfer_id),
        signer: String(r.signer),
        signature: String(r.signature),
        origin: String(r.origin),
        createdAt: Number(r.created_at),
      }));
  }

  getSubmission(transferId: string): StoredSubmission | null {
    const row = this.db.prepare('SELECT * FROM submissions WHERE transfer_id = ?').get(transferId);
    return row ? rowToSubmission(row) : null;
  }

  putSubmission(sub: StoredSubmission): void {
    this.db
      .prepare(
        `INSERT INTO submissions (transfer_id, dst_chain_id, account_nonce, attempts, status, mined_tx_hash, last_error, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(transfer_id) DO UPDATE SET
           attempts = excluded.attempts, status = excluded.status, mined_tx_hash = excluded.mined_tx_hash,
           last_error = excluded.last_error, updated_at = excluded.updated_at`,
      )
      .run(
        sub.transferId,
        sub.dstChainId,
        sub.accountNonce,
        JSON.stringify(sub.attempts),
        sub.status,
        sub.minedTxHash,
        sub.lastError,
        sub.createdAt,
        sub.updatedAt,
      );
  }

  listSubmissions(status: SubmissionStatus): StoredSubmission[] {
    return this.db.prepare('SELECT * FROM submissions WHERE status = ?').all(status).map(rowToSubmission);
  }

  getWindow(key: string): StoredWindow | null {
    const row = this.db.prepare('SELECT * FROM windows WHERE key = ?').get(key);
    return row ? { key, used: BigInt(String(row.used)), updatedAt: Number(row.updated_at) } : null;
  }

  putWindow(w: StoredWindow): void {
    this.db
      .prepare('INSERT INTO windows (key, used, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET used = excluded.used, updated_at = excluded.updated_at')
      .run(w.key, w.used.toString(), w.updatedAt);
  }

  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const row of this.db.prepare('SELECT status, COUNT(*) AS n FROM transfers GROUP BY status').all()) {
      out[`transfers_${String(row.status)}`] = Number(row.n);
    }
    for (const row of this.db.prepare('SELECT status, COUNT(*) AS n FROM submissions GROUP BY status').all()) {
      out[`submissions_${String(row.status)}`] = Number(row.n);
    }
    const sigs = this.db.prepare('SELECT COUNT(*) AS n FROM signatures').get();
    out.signatures = sigs ? Number(sigs.n) : 0;
    return out;
  }

  close(): void {
    this.db.close();
  }
}

function rowToTransfer(r: SqliteRow): StoredTransfer {
  return {
    transferId: String(r.transfer_id),
    transfer: {
      srcChainId: Number(r.src_chain_id),
      dstChainId: Number(r.dst_chain_id),
      nonce: Number(r.nonce),
      srcToken: String(r.src_token),
      dstToken: String(r.dst_token),
      sender: String(r.sender),
      recipient: String(r.recipient),
      amount: BigInt(String(r.amount)),
    },
    fee: BigInt(String(r.fee)),
    srcBlockNumber: Number(r.src_block_number),
    srcBlockHash: String(r.src_block_hash),
    srcTxHash: String(r.src_tx_hash),
    srcLogIndex: Number(r.src_log_index),
    status: String(r.status) as TransferStatus,
    reason: r.reason === null || r.reason === undefined ? null : String(r.reason),
    firstSeenAt: Number(r.first_seen_at),
    confirmedAt: r.confirmed_at === null || r.confirmed_at === undefined ? null : Number(r.confirmed_at),
    executedAt: r.executed_at === null || r.executed_at === undefined ? null : Number(r.executed_at),
    executedTxHash: r.executed_tx_hash === null || r.executed_tx_hash === undefined ? null : String(r.executed_tx_hash),
    updatedAt: Number(r.updated_at),
  };
}

function rowToSubmission(r: SqliteRow): StoredSubmission {
  return {
    transferId: String(r.transfer_id),
    dstChainId: Number(r.dst_chain_id),
    accountNonce: Number(r.account_nonce),
    attempts: JSON.parse(String(r.attempts)) as SubmissionAttempt[],
    status: String(r.status) as SubmissionStatus,
    minedTxHash: r.mined_tx_hash === null || r.mined_tx_hash === undefined ? null : String(r.mined_tx_hash),
    lastError: r.last_error === null || r.last_error === undefined ? null : String(r.last_error),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

// -------------------------------------------------------------------- journal

type JournalRecord =
  | { t: 'cursor'; chainId: number; block: number }
  | { t: 'transfer'; v: Record<string, unknown> }
  | { t: 'status'; transferId: string; status: TransferStatus; reason: string | null; at: number }
  | { t: 'executed'; transferId: string; txHash: string | null; at: number }
  | { t: 'signature'; v: StoredSignature }
  | { t: 'submission'; v: Record<string, unknown> }
  | { t: 'window'; key: string; used: string; updatedAt: number };

/**
 * Append-only NDJSON journal replayed into memory at startup. Every mutation is
 * appended and fsync'd before the call returns, so a crash loses nothing that
 * the caller was told was durable.
 */
class JournalStore implements Store {
  readonly driver = 'journal' as const;
  private readonly path: string;
  private readonly fd: number;
  private readonly cursors = new Map<number, number>();
  private readonly transfers = new Map<string, StoredTransfer>();
  private readonly signatures = new Map<string, Map<string, StoredSignature>>();
  private readonly submissions = new Map<string, StoredSubmission>();
  private readonly windows = new Map<string, StoredWindow>();

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) this.replay();
    this.fd = openSync(path, 'a');
  }

  private replay(): void {
    const text = readFileSync(this.path, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let rec: JournalRecord;
      try {
        rec = JSON.parse(line) as JournalRecord;
      } catch {
        continue; // a torn final line from a hard kill — everything before it stands
      }
      this.apply(rec);
    }
  }

  private apply(rec: JournalRecord): void {
    switch (rec.t) {
      case 'cursor':
        this.cursors.set(rec.chainId, rec.block);
        break;
      case 'transfer': {
        const t = deserializeTransfer(rec.v);
        this.transfers.set(t.transferId, t);
        break;
      }
      case 'status': {
        const t = this.transfers.get(rec.transferId);
        if (t) {
          t.status = rec.status;
          t.reason = rec.reason;
          if (rec.status === 'confirmed' && t.confirmedAt === null) t.confirmedAt = rec.at;
          t.updatedAt = rec.at;
        }
        break;
      }
      case 'executed': {
        const t = this.transfers.get(rec.transferId);
        if (t) {
          t.status = 'executed';
          t.executedAt = rec.at;
          t.executedTxHash = rec.txHash;
          t.updatedAt = rec.at;
        }
        break;
      }
      case 'signature': {
        let bucket = this.signatures.get(rec.v.transferId);
        if (!bucket) {
          bucket = new Map();
          this.signatures.set(rec.v.transferId, bucket);
        }
        if (!bucket.has(rec.v.signer)) bucket.set(rec.v.signer, rec.v);
        break;
      }
      case 'submission': {
        const s = rec.v as unknown as StoredSubmission;
        this.submissions.set(s.transferId, s);
        break;
      }
      case 'window':
        this.windows.set(rec.key, { key: rec.key, used: BigInt(rec.used), updatedAt: rec.updatedAt });
        break;
    }
  }

  private write(rec: JournalRecord): void {
    appendFileSync(this.fd, `${JSON.stringify(rec)}\n`);
    fsyncSync(this.fd);
    this.apply(rec);
  }

  getCursor(chainId: number): number | null {
    return this.cursors.get(chainId) ?? null;
  }

  /** Every cursor, for compaction. Not part of the Store interface. */
  allCursors(): Array<[number, number]> {
    return [...this.cursors.entries()];
  }

  setCursor(chainId: number, block: number): void {
    this.write({ t: 'cursor', chainId, block });
  }

  putTransfer(t: StoredTransfer): void {
    this.write({ t: 'transfer', v: serializeStored(t) });
  }

  getTransfer(transferId: string): StoredTransfer | null {
    return this.transfers.get(transferId) ?? null;
  }

  listTransfers(filter: { status?: TransferStatus[]; dstChainId?: number; limit?: number }): StoredTransfer[] {
    let out = [...this.transfers.values()];
    if (filter.status && filter.status.length > 0) out = out.filter((t) => filter.status?.includes(t.status));
    if (filter.dstChainId !== undefined) out = out.filter((t) => t.transfer.dstChainId === filter.dstChainId);
    out.sort((a, b) => a.firstSeenAt - b.firstSeenAt);
    return out.slice(0, filter.limit ?? 500);
  }

  setTransferStatus(transferId: string, status: TransferStatus, reason?: string | null): void {
    this.write({ t: 'status', transferId, status, reason: reason ?? null, at: Date.now() });
  }

  markExecuted(transferId: string, txHash: string | null): void {
    this.write({ t: 'executed', transferId, txHash, at: Date.now() });
  }

  putSignature(sig: StoredSignature): void {
    if (this.signatures.get(sig.transferId)?.has(sig.signer)) return;
    this.write({ t: 'signature', v: sig });
  }

  getSignatures(transferId: string): StoredSignature[] {
    return [...(this.signatures.get(transferId)?.values() ?? [])].sort((a, b) => a.signer.localeCompare(b.signer));
  }

  getSubmission(transferId: string): StoredSubmission | null {
    return this.submissions.get(transferId) ?? null;
  }

  putSubmission(sub: StoredSubmission): void {
    this.write({ t: 'submission', v: sub as unknown as Record<string, unknown> });
  }

  listSubmissions(status: SubmissionStatus): StoredSubmission[] {
    return [...this.submissions.values()].filter((s) => s.status === status);
  }

  getWindow(key: string): StoredWindow | null {
    return this.windows.get(key) ?? null;
  }

  putWindow(w: StoredWindow): void {
    this.write({ t: 'window', key: w.key, used: w.used.toString(), updatedAt: w.updatedAt });
  }

  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const t of this.transfers.values()) {
      const k = `transfers_${t.status}`;
      out[k] = (out[k] ?? 0) + 1;
    }
    for (const s of this.submissions.values()) {
      const k = `submissions_${s.status}`;
      out[k] = (out[k] ?? 0) + 1;
    }
    let sigs = 0;
    for (const b of this.signatures.values()) sigs += b.size;
    out.signatures = sigs;
    return out;
  }

  close(): void {
    closeSync(this.fd);
  }
}

function serializeStored(t: StoredTransfer): Record<string, unknown> {
  return {
    transferId: t.transferId,
    transfer: serializeTransfer(t.transfer),
    fee: t.fee.toString(),
    srcBlockNumber: t.srcBlockNumber,
    srcBlockHash: t.srcBlockHash,
    srcTxHash: t.srcTxHash,
    srcLogIndex: t.srcLogIndex,
    status: t.status,
    reason: t.reason,
    firstSeenAt: t.firstSeenAt,
    confirmedAt: t.confirmedAt,
    executedAt: t.executedAt,
    executedTxHash: t.executedTxHash,
    updatedAt: t.updatedAt,
  };
}

function deserializeTransfer(v: Record<string, unknown>): StoredTransfer {
  return {
    transferId: String(v.transferId),
    transfer: parseTransfer(v.transfer),
    fee: BigInt(String(v.fee)),
    srcBlockNumber: Number(v.srcBlockNumber),
    srcBlockHash: String(v.srcBlockHash),
    srcTxHash: String(v.srcTxHash),
    srcLogIndex: Number(v.srcLogIndex),
    status: String(v.status) as TransferStatus,
    reason: v.reason === null || v.reason === undefined ? null : String(v.reason),
    firstSeenAt: Number(v.firstSeenAt),
    confirmedAt: v.confirmedAt === null || v.confirmedAt === undefined ? null : Number(v.confirmedAt),
    executedAt: v.executedAt === null || v.executedAt === undefined ? null : Number(v.executedAt),
    executedTxHash: v.executedTxHash === null || v.executedTxHash === undefined ? null : String(v.executedTxHash),
    updatedAt: Number(v.updatedAt),
  };
}

// -------------------------------------------------------------------- factory

/**
 * Open the durable store. `driver: 'auto'` prefers node:sqlite and falls back to
 * the journal only if this Node build has no SQLite — never silently, the caller
 * logs which backend it got.
 */
export async function openStore(path: string, driver: 'auto' | 'sqlite' | 'journal'): Promise<Store> {
  mkdirSync(dirname(path), { recursive: true });
  if (driver === 'journal') return openJournal(path);
  try {
    const sqlite = (await import('node:sqlite')) as unknown as {
      DatabaseSync: new (p: string) => SqliteStore['db'];
    };
    return new SqliteStore(new sqlite.DatabaseSync(path));
  } catch (err) {
    if (driver === 'sqlite') {
      throw new Error(
        `state.driver is "sqlite" but node:sqlite is unavailable on this Node build (${(err as Error).message}). ` +
          'Use Node 22.5+ (24+ recommended) or set state.driver to "journal".',
      );
    }
    return openJournal(path);
  }
}

/**
 * Open the journal, compacting it first if it has grown past the threshold.
 * An append-only file grows without bound otherwise, and the whole point of the
 * journal backend is that a human can still read it.
 */
const JOURNAL_COMPACT_BYTES = 8 * 1024 * 1024;

function openJournal(path: string): Store {
  const p = journalPath(path);
  if (existsSync(p) && statSync(p).size > JOURNAL_COMPACT_BYTES) compactJournal(p);
  return new JournalStore(p);
}

function journalPath(path: string): string {
  return path.endsWith('.ndjson') ? path : `${path.replace(/\.db$/, '')}.ndjson`;
}

/** Compact a journal file in place: replay, then rewrite the minimal record set. */
export function compactJournal(path: string): void {
  const p = journalPath(path);
  if (!existsSync(p)) return;
  const store = new JournalStore(p);
  const lines: string[] = [];
  for (const [chainId, block] of store.allCursors()) {
    lines.push(JSON.stringify({ t: 'cursor', chainId, block }));
  }
  for (const t of store.listTransfers({ limit: Number.MAX_SAFE_INTEGER })) {
    lines.push(JSON.stringify({ t: 'transfer', v: serializeStored(t) }));
  }
  for (const t of store.listTransfers({ limit: Number.MAX_SAFE_INTEGER })) {
    for (const s of store.getSignatures(t.transferId)) lines.push(JSON.stringify({ t: 'signature', v: s }));
  }
  for (const status of ['pending', 'mined', 'failed', 'abandoned'] as SubmissionStatus[]) {
    for (const s of store.listSubmissions(status)) lines.push(JSON.stringify({ t: 'submission', v: s }));
  }
  store.close();
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, lines.length ? `${lines.join('\n')}\n` : '');
  renameSync(tmp, p);
}
