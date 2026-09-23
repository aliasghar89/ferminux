// FRC-100 — memory anchoring. Every write to the private KV store (v3/memory.ts)
// now also appends an immutable HEADER to `memory_records`: a per-address hash
// chain of commitments. The value itself never leaves the KV table, and the key
// name is committed under a private 16-byte salt, so an anchored header leaks
// neither.
//
//   POST /api/memory/anchor            build a batch → merkle root + per-record proofs
//                                      (and, with a txHash, record the anchoring tx)
//   GET  /api/memory/anchors           the public anchor ledger
//   GET  /api/memory/proof/:agentId/:seq   one record's self-contained proof bundle
//
// What this proves, exactly: that a record existed at position N of an agent's
// log no later than the block its root was anchored in, and that nothing was
// inserted, altered or silently dropped before it. It does NOT prove the agent
// wrote down everything that happened — an anchored log is still a self-curated
// diary, which is why the CV weights counterparty-written facts (escrow
// settlements, FRC-8004 feedback, x402 settlements) above it.
import type { FastifyInstance } from "fastify";
import { getAddress, keccak256, randomBytes, toUtf8Bytes, hexlify } from "ethers";
import { canonicalJson } from "../commons/sign.js";
import { HttpError } from "../commons/context.js";
import { CHAIN } from "../constants.js";
import type { V3Context } from "./context.js";
import { MEMORY_MERKLE_SPEC, ZERO_HASH, memoryLeaf, memoryProof, memoryRoot, memoryVerify } from "./merkle.js";

/** Records folded into one root. Keeps proofs shallow and one batch inside a sane calldata budget. */
export const ANCHOR_MAX_BATCH = 4096;
export const ANCHOR_DEFAULT_BATCH = 512;
/** Signers enforce a 1 gwei priority-fee floor on chain 3961. */
export const PRIORITY_FEE_FLOOR_WEI = 1_000_000_000n;
export const ANCHOR_URI_MAX_BYTES = 256;

export const MEMORY_RECORD_VERSION = 1;

export interface MemoryRecordHeader {
  v: number;
  chainId: number;
  addr: string;
  seq: number;
  prev: string;
  op: "put" | "del";
  /** keccak256(utf8(canonicalJson({key, nonce}))) — SALTED, so the key name is not brute-forceable */
  keyCommit: string;
  /** keccak256(utf8(value)); zero for a tombstone */
  valueHash: string;
  size: number;
  ts: number;
}

export interface MemoryRecordRow {
  id: number;
  address: string;
  seq: number;
  op: "put" | "del";
  key: string;
  keyNonce: string;
  keyCommit: string;
  valueHash: string;
  size: number;
  prev: string;
  recordHash: string;
  ts: number;
  batchId: number | null;
  leafIndex: number | null;
}

export interface MemoryAnchorRow {
  id: number;
  agentId: number;
  address: string;
  root: string;
  prevRoot: string;
  count: number;
  fromSeq: number;
  toSeq: number;
  uri: string;
  status: "built" | "submitted" | "anchored";
  onchainSeq: number | null;
  totalRecords: number | null;
  anchoredBy: string | null;
  txHash: string | null;
  blockNumber: number | null;
  createdAt: number;
  submittedAt: number | null;
  anchoredAt: number | null;
}

/** keccak256(utf8(canonicalJson(header))) — the bytes the contract hashes. */
export function recordHashOf(header: MemoryRecordHeader): string {
  return keccak256(toUtf8Bytes(canonicalJson(header)));
}

export function keyCommitOf(key: string, nonce: string): string {
  return keccak256(toUtf8Bytes(canonicalJson({ key, nonce })));
}

export function headerOf(row: Pick<MemoryRecordRow, "address" | "seq" | "prev" | "op" | "keyCommit" | "valueHash" | "size" | "ts">): MemoryRecordHeader {
  return {
    v: MEMORY_RECORD_VERSION,
    chainId: CHAIN.chainId,
    addr: row.address,
    seq: row.seq,
    prev: row.prev,
    op: row.op,
    keyCommit: row.keyCommit,
    valueHash: row.valueHash,
    size: row.size,
    ts: row.ts,
  };
}

/**
 * Appends one immutable header for a KV write. Called by the memory routes after
 * the value lands, inside the same synchronous request, so seq can never skip.
 * Failure here must never fail the write — the KV store is the product, the log
 * is the proof — so the caller wraps it and logs.
 */
export function appendMemoryRecord(
  ctx: V3Context,
  address: string,
  op: "put" | "del",
  key: string,
  value: string | null,
): MemoryRecordRow {
  const db = ctx.db;
  const addr = getAddress(address);
  const ts = ctx.nowS();
  const nonce = hexlify(randomBytes(16));
  const keyCommit = keyCommitOf(key, nonce);
  const valueHash = op === "put" && value !== null ? keccak256(toUtf8Bytes(value)) : ZERO_HASH;
  const size = op === "put" && value !== null ? Buffer.byteLength(value, "utf8") : 0;

  const insert = db.transaction(() => {
    const head = db.prepare("SELECT seq, recordHash FROM memory_records WHERE address = ? ORDER BY seq DESC LIMIT 1").get(addr) as
      | { seq: number; recordHash: string }
      | undefined;
    const seq = (head?.seq ?? 0) + 1;
    const prev = head?.recordHash ?? ZERO_HASH;
    const recordHash = recordHashOf({ v: MEMORY_RECORD_VERSION, chainId: CHAIN.chainId, addr, seq, prev, op, keyCommit, valueHash, size, ts });
    db.prepare(
      `INSERT INTO memory_records (address, seq, op, key, keyNonce, keyCommit, valueHash, size, prev, recordHash, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(addr, seq, op, key, nonce, keyCommit, valueHash, size, prev, recordHash, ts);
    return { id: 0, address: addr, seq, op, key, keyNonce: nonce, keyCommit, valueHash, size, prev, recordHash, ts, batchId: null, leafIndex: null } as MemoryRecordRow;
  });
  return insert();
}

/** Head of an address's log: how far it has been written, and how far it has been anchored. */
export function memoryLogHead(ctx: V3Context, address: string) {
  const db = ctx.db;
  const addr = getAddress(address);
  const head = db.prepare("SELECT seq, recordHash, ts FROM memory_records WHERE address = ? ORDER BY seq DESC LIMIT 1").get(addr) as
    | { seq: number; recordHash: string; ts: number }
    | undefined;
  const pending = (db.prepare("SELECT COUNT(*) AS c FROM memory_records WHERE address = ? AND batchId IS NULL").get(addr) as { c: number }).c;
  const anchored = db
    .prepare("SELECT toSeq, root, anchoredAt, txHash, onchainSeq FROM memory_anchors WHERE address = ? AND status = 'anchored' ORDER BY toSeq DESC LIMIT 1")
    .get(addr) as { toSeq: number; root: string; anchoredAt: number | null; txHash: string | null; onchainSeq: number | null } | undefined;
  return {
    address: addr,
    seq: head?.seq ?? 0,
    headHash: head?.recordHash ?? ZERO_HASH,
    lastWriteAt: head?.ts ?? null,
    unanchored: pending,
    anchoredThroughSeq: anchored?.toSeq ?? 0,
    lastRoot: anchored?.root ?? null,
    lastAnchorTx: anchored?.txHash ?? null,
    lastAnchorSeq: anchored?.onchainSeq ?? null,
    lastAnchoredAt: anchored?.anchoredAt ?? null,
  };
}

/** Anchor counters for one agent — what the CV reports and the badge counts. */
export function memoryAnchorSummary(ctx: V3Context, agentId: number, owner: string) {
  const db = ctx.db;
  const anchors = (db.prepare("SELECT COUNT(*) AS c FROM memory_anchors WHERE agentId = ? AND status = 'anchored'").get(agentId) as { c: number }).c;
  const latest = db
    .prepare("SELECT * FROM memory_anchors WHERE agentId = ? AND status = 'anchored' ORDER BY COALESCE(onchainSeq, id) DESC LIMIT 1")
    .get(agentId) as MemoryAnchorRow | undefined;
  const log = memoryLogHead(ctx, owner);
  const kv = db.prepare("SELECT COUNT(*) AS c, COALESCE(SUM(size), 0) AS s FROM memory WHERE address = ?").get(getAddress(owner)) as { c: number; s: number };
  return {
    keys: kv.c,
    bytes: kv.s,
    records: log.seq,
    unanchored: log.unanchored,
    anchors,
    anchoredThroughSeq: log.anchoredThroughSeq,
    latestRoot: latest?.root ?? null,
    latestAnchorSeq: latest?.onchainSeq ?? null,
    latestAnchorTx: latest?.txHash ?? null,
    latestAnchorBlock: latest?.blockNumber ?? null,
    latestAnchoredAt: latest?.anchoredAt ?? null,
  };
}

function batchLeaves(rows: MemoryRecordRow[]): string[] {
  return rows.map((r) => memoryLeaf(r.recordHash));
}

/** The record bundle for one row inside its batch: header, bytes, leaf, sibling path. */
function recordBundle(rows: MemoryRecordRow[], leaves: string[], i: number, reveal: boolean) {
  const row = rows[i]!;
  const header = headerOf(row);
  const bytes = canonicalJson(header);
  return {
    seq: row.seq,
    index: i,
    op: row.op,
    ts: row.ts,
    size: row.size,
    ...(reveal ? { key: row.key, keyNonce: row.keyNonce } : {}),
    valueHash: row.valueHash,
    keyCommit: row.keyCommit,
    prev: row.prev,
    recordHash: row.recordHash,
    leaf: leaves[i]!,
    record: header,
    recordBytes: hexlify(toUtf8Bytes(bytes)),
    recordJson: bytes,
    proof: memoryProof(leaves, i),
  };
}

function anchorOnchain(ctx: V3Context, row: MemoryAnchorRow) {
  const addr = ctx.address("memoryAnchor") ?? null;
  const iface = ctx.iface("memoryAnchor");
  let calldata: string | null = null;
  try {
    calldata = iface.encodeFunctionData("anchor", [row.agentId, row.root, row.prevRoot, row.count, row.uri]);
  } catch {
    calldata = null;
  }
  return {
    chainId: CHAIN.chainId,
    contract: addr,
    ...(addr ? {} : { disabled: true, reason: "MemoryAnchor is not deployed on this gateway yet — the root and the proofs below are already final and stay valid; anchor them once the contract is configured" }),
    method: "anchor(uint256 agentId, bytes32 root, bytes32 prevRoot, uint32 count, string uri)",
    args: [row.agentId, row.root, row.prevRoot, row.count, row.uri],
    calldata,
    priorityFeeFloorWei: PRIORITY_FEE_FLOOR_WEI.toString(),
    priorityFeeNote: "chain 3961 signers enforce a 1 gwei priority-fee floor; send maxPriorityFeePerGas >= 1000000000",
    relayed: {
      method: "anchorFor(uint256 agentId, bytes32 root, bytes32 prevRoot, uint32 count, string uri, uint64 deadline, bytes sig)",
      eip712: {
        domain: { name: "FerminuxMemoryAnchor", version: "1", chainId: CHAIN.chainId, verifyingContract: addr },
        primaryType: "Anchor",
        types: {
          Anchor: [
            { name: "agentId", type: "uint256" },
            { name: "root", type: "bytes32" },
            { name: "prevRoot", type: "bytes32" },
            { name: "count", type: "uint32" },
            { name: "uri", type: "string" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint64" },
          ],
        },
        message: { agentId: row.agentId, root: row.root, prevRoot: row.prevRoot, count: row.count, uri: row.uri, nonce: null, deadline: null },
        messageNote: "fill nonce from MemoryAnchor.nonceOf(agentId) and deadline with a future unix second, then sign",
      },
    },
    submit: "POST /api/memory/anchor {agentId, root, txHash} (signed, action memory.anchor) once the transaction is confirmed — or just wait: the indexer records MemoryAnchored on its own",
  };
}

function anchorView(row: MemoryAnchorRow) {
  return {
    batchId: row.id,
    agentId: row.agentId,
    address: row.address || null,
    root: row.root,
    prevRoot: row.prevRoot,
    count: row.count,
    fromSeq: row.fromSeq,
    toSeq: row.toSeq,
    uri: row.uri,
    status: row.status,
    onchainSeq: row.onchainSeq,
    totalRecords: row.totalRecords,
    anchoredBy: row.anchoredBy,
    tx: row.txHash,
    block: row.blockNumber,
    createdAt: row.createdAt,
    submittedAt: row.submittedAt,
    anchoredAt: row.anchoredAt,
  };
}

export function registerMemoryAnchorRoutes(app: FastifyInstance, ctx: V3Context): void {
  const { db, commons } = ctx;
  const { sendError } = commons;

  const openRecords = db.prepare("SELECT * FROM memory_records WHERE address = ? AND batchId IS NULL ORDER BY seq ASC LIMIT ?");
  const batchRecords = db.prepare("SELECT * FROM memory_records WHERE batchId = ? ORDER BY leafIndex ASC");

  /**
   * Build a batch (or record the tx that anchored one). Signed by the agent's
   * owner, action `memory.anchor`. Idempotent: while a built batch is still
   * unanchored the same root comes back, so a retry never forks the log.
   */
  app.post("/api/memory/anchor", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    try {
      const body = commons.parseJson(req);
      const address = commons.authenticateWrite("memory.anchor", body);
      const agent = commons.requireOwnedAgent(address, body.agentId);
      const txHash = body.txHash === undefined || body.txHash === null ? undefined : commons.requireString(body.txHash, "txHash");
      if (txHash !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new HttpError(400, "txHash must be a 0x-prefixed 32-byte hash");
      const uri = commons.optionalString(body.uri, "uri", ANCHOR_URI_MAX_BYTES);
      const limit = commons.parseLimit(body.limit, ANCHOR_DEFAULT_BATCH, ANCHOR_MAX_BATCH);

      // ---- record an anchoring transaction for a batch we already built ----
      if (txHash !== undefined) {
        const root = body.root === undefined ? undefined : commons.requireString(body.root, "root");
        if (root !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(root)) throw new HttpError(400, "root must be a 0x-prefixed 32-byte hash");
        const row = (root
          ? db.prepare("SELECT * FROM memory_anchors WHERE agentId = ? AND lower(root) = lower(?)").get(agent.id, root)
          : db.prepare("SELECT * FROM memory_anchors WHERE agentId = ? AND status <> 'anchored' ORDER BY id DESC LIMIT 1").get(agent.id)) as
          | MemoryAnchorRow
          | undefined;
        if (!row) throw new HttpError(404, root ? "no batch with that root for this agent" : "no unanchored batch for this agent — build one first (omit txHash)");
        commons.commitWrite(address, body);
        db.prepare("UPDATE memory_anchors SET status = CASE WHEN status = 'anchored' THEN 'anchored' ELSE 'submitted' END, txHash = COALESCE(txHash, ?), submittedAt = COALESCE(submittedAt, ?) WHERE id = ?").run(
          txHash,
          ctx.nowS(),
          row.id,
        );
        const fresh = db.prepare("SELECT * FROM memory_anchors WHERE id = ?").get(row.id) as MemoryAnchorRow;
        return reply.code(200).send({
          ...anchorView(fresh),
          recorded: true,
          note: "the indexer confirms this batch (status → anchored) when MemoryAnchored lands in a block it has reached",
        });
      }

      // ---- an already-built, still-unanchored batch wins: never fork the log ----
      const existing = db.prepare("SELECT * FROM memory_anchors WHERE agentId = ? AND status = 'built' ORDER BY id ASC LIMIT 1").get(agent.id) as
        | MemoryAnchorRow
        | undefined;
      if (existing) {
        const rows = batchRecords.all(existing.id) as MemoryRecordRow[];
        const leaves = batchLeaves(rows);
        commons.commitWrite(address, body);
        return reply.code(200).send({
          ...anchorView(existing),
          rebuilt: false,
          note: "this batch was already built and is not anchored yet — anchor this root, or record its tx with {agentId, root, txHash}",
          records: rows.map((_r, i) => recordBundle(rows, leaves, i, true)),
          onchain: anchorOnchain(ctx, existing),
          verify: MEMORY_MERKLE_SPEC,
        });
      }

      const rows = openRecords.all(getAddress(address), limit) as MemoryRecordRow[];
      if (!rows.length) {
        throw new HttpError(409, "nothing to anchor: every memory record for this address is already in a batch (PUT /api/memory/{key} appends one)");
      }
      const leaves = batchLeaves(rows);
      const root = memoryRoot(leaves);
      const prev = db.prepare("SELECT root, totalRecords FROM memory_anchors WHERE agentId = ? AND status = 'anchored' ORDER BY COALESCE(onchainSeq, id) DESC LIMIT 1").get(agent.id) as
        | { root: string; totalRecords: number | null }
        | undefined;
      const prevRoot = prev?.root ?? ZERO_HASH;
      const t = ctx.nowS();
      commons.commitWrite(address, body);
      const batchId = db.transaction(() => {
        const info = db
          .prepare(
            `INSERT INTO memory_anchors (agentId, address, root, prevRoot, count, fromSeq, toSeq, uri, status, createdAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'built', ?)`,
          )
          .run(agent.id, getAddress(address), root, prevRoot, rows.length, rows[0]!.seq, rows[rows.length - 1]!.seq, uri, t);
        const id = Number(info.lastInsertRowid);
        const mark = db.prepare("UPDATE memory_records SET batchId = ?, leafIndex = ? WHERE id = ?");
        rows.forEach((r, i) => mark.run(id, i, r.id));
        return id;
      })();

      const row = db.prepare("SELECT * FROM memory_anchors WHERE id = ?").get(batchId) as MemoryAnchorRow;
      return reply.code(201).send({
        ...anchorView(row),
        rebuilt: true,
        records: rows.map((_r, i) => recordBundle(rows, leaves, i, true)),
        onchain: anchorOnchain(ctx, row),
        verify: MEMORY_MERKLE_SPEC,
        proves:
          "that each record existed at its position in this agent's log no later than the block this root is anchored in, and that nothing was inserted, altered or dropped before it. It does not prove the log is complete.",
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** The public anchor ledger. Roots and counts only — no key names, no values. */
  app.get<{ Querystring: { agentId?: string; address?: string; status?: string; limit?: string; offset?: string } }>(
    "/api/memory/anchors",
    async (req, reply) => {
      try {
        const lim = commons.parseLimit(req.query.limit, 50, 200);
        const off = commons.parseOffset(req.query.offset);
        const where: string[] = [];
        const params: unknown[] = [];
        if (req.query.agentId) {
          where.push("agentId = ?");
          params.push(commons.checkId(req.query.agentId, "agentId"));
        }
        if (req.query.address) {
          where.push("lower(address) = lower(?)");
          params.push(req.query.address);
        }
        if (req.query.status) {
          if (!["built", "submitted", "anchored"].includes(req.query.status)) throw new HttpError(400, "status must be built|submitted|anchored");
          where.push("status = ?");
          params.push(req.query.status);
        }
        const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
        const total = (db.prepare(`SELECT COUNT(*) AS c FROM memory_anchors ${whereSql}`).get(...params) as { c: number }).c;
        const rows = db.prepare(`SELECT * FROM memory_anchors ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, lim, off) as MemoryAnchorRow[];
        return {
          ...(ctx.deployed("memoryAnchor") ? {} : { disabled: true, reason: "not deployed" }),
          items: rows.map(anchorView),
          total,
          contract: ctx.address("memoryAnchor") ?? null,
          chainId: CHAIN.chainId,
          verify: MEMORY_MERKLE_SPEC,
        };
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  /**
   * One record's self-contained proof bundle. Public by design: the header
   * carries only commitments, and a log nobody can inspect cannot be checked
   * for omissions, which is the whole point of anchoring it.
   */
  app.get<{ Params: { agentId: string; seq: string } }>("/api/memory/proof/:agentId/:seq", async (req, reply) => {
    try {
      const agentId = commons.checkId(req.params.agentId, "agentId");
      const seq = commons.checkId(req.params.seq, "seq");
      const agent = commons.agentById(agentId);
      if (!agent) throw new HttpError(404, `agent ${agentId} not found`);
      const owner = getAddress(agent.owner);
      const row = db.prepare("SELECT * FROM memory_records WHERE address = ? AND seq = ?").get(owner, seq) as MemoryRecordRow | undefined;
      if (!row) throw new HttpError(404, `no memory record at seq ${seq} for agent ${agentId}`);

      const head = memoryLogHead(ctx, owner);
      if (row.batchId === null) {
        return {
          agentId,
          address: owner,
          seq: row.seq,
          anchored: false,
          reason: "this record is written but not yet in a batch — its owner has not called POST /api/memory/anchor for it",
          record: headerOf(row),
          recordHash: row.recordHash,
          leaf: memoryLeaf(row.recordHash),
          log: head,
          verify: MEMORY_MERKLE_SPEC,
        };
      }
      const batch = db.prepare("SELECT * FROM memory_anchors WHERE id = ?").get(row.batchId) as MemoryAnchorRow;
      const rows = batchRecords.all(batch.id) as MemoryRecordRow[];
      const leaves = batchLeaves(rows);
      const i = rows.findIndex((r) => r.seq === row.seq);
      const bundle = recordBundle(rows, leaves, i, false);
      const ok = memoryVerify(batch.root, bundle.leaf, bundle.proof, i, rows.length);
      return {
        v: 1,
        chainId: CHAIN.chainId,
        agentId,
        address: owner,
        anchored: batch.status === "anchored",
        status: batch.status,
        batch: anchorView(batch),
        ...bundle,
        count: rows.length,
        selfCheck: ok,
        onchain: {
          contract: ctx.address("memoryAnchor") ?? null,
          call: "verify(bytes32 root, bytes record, bytes32[] proof, uint256 index, uint256 count) returns (bool)",
          args: [batch.root, bundle.recordBytes, bundle.proof, i, rows.length],
          head: "MemoryAnchor.head(agentId) → (root, seq, totalRecords, anchoredAt)",
          tx: batch.txHash,
          block: batch.blockNumber,
          anchorSeq: batch.onchainSeq,
        },
        continuity: {
          prev: row.prev,
          note: "fetch seq-1 and check its recordHash equals this record's `prev`; a gap in seq is a dropped record and is visible to anyone",
          logHead: head,
        },
        reveal: "the owner can hand a verifier {key, keyNonce} from POST /api/memory/anchor to open keyCommit for one record without revealing any other key",
        verify: MEMORY_MERKLE_SPEC,
      };
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
