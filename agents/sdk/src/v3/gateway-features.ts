// Addendum v3 — gateway-only features (SPEC.md "## G."): private memory, webhooks,
// USDC pay-in, audit export, compute listings. Most of these are `fmx.gatewayUrl`
// REST calls, some Commons-signed.
//
// FRC-100 memory anchoring is the exception: `fmx.memory.anchor()` asks the
// gateway to fold the agent's unanchored memory records into one merkle root,
// then sends `MemoryAnchor.anchor(...)` itself, from the agent's own key. No
// human is in that path, and the commitment is made by the agent, not by us.
import { Contract } from "ethers";
import { MEMORY_ANCHOR_ABI } from "../abi.js";
import { lazyContract, qs, type GatewayClient } from "./shared.js";
import { MEMORY_MERKLE_SPEC, ZERO_HASH, memoryLeaf, memoryVerify } from "./merkle.js";

export interface MemoryEntry {
  key: string;
  value: unknown;
  updatedAt: number;
}

/** The immutable header appended for every KV write — commitments only, no key name, no value. */
export interface MemoryRecordHeader {
  v: number;
  chainId: number;
  addr: string;
  seq: number;
  prev: string;
  op: "put" | "del";
  /** keccak256(utf8(canonicalJson({key, nonce}))) — SALTED, so the key name is not brute-forceable */
  keyCommit: string;
  valueHash: string;
  size: number;
  ts: number;
}

export interface MemoryRecordBundle {
  seq: number;
  index: number;
  op: "put" | "del";
  ts: number;
  size: number;
  key?: string;
  keyNonce?: string;
  valueHash: string;
  keyCommit: string;
  prev: string;
  recordHash: string;
  leaf: string;
  record: MemoryRecordHeader;
  recordBytes: string;
  recordJson: string;
  proof: string[];
}

export interface MemoryBatch {
  batchId: number;
  agentId: number;
  address: string | null;
  root: string;
  prevRoot: string;
  count: number;
  fromSeq: number;
  toSeq: number;
  uri: string;
  status: "built" | "submitted" | "anchored";
  onchainSeq: number | null;
  tx: string | null;
  block: number | null;
  records?: MemoryRecordBundle[];
  onchain?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface MemoryAnchorResult extends MemoryBatch {
  /** the transaction this call sent, or null when it only built the batch */
  tx: string | null;
  anchored: boolean;
  note: string;
}

export interface MemoryProofBundle extends MemoryRecordBundle {
  v?: number;
  chainId?: number;
  agentId: number;
  address: string;
  anchored: boolean;
  status?: string;
  batch?: MemoryBatch;
  count?: number;
  selfCheck?: boolean;
  onchain?: Record<string, unknown>;
  continuity?: Record<string, unknown>;
  verify?: Record<string, unknown>;
  reason?: string;
  [k: string]: unknown;
}

export class MemoryAPI {
  private readonly anchorContract: () => Contract;

  constructor(private readonly fmx: GatewayClient) {
    this.anchorContract = lazyContract("memoryAnchor", () => this.fmx.v3.memoryAnchor, MEMORY_ANCHOR_ABI as unknown as string[], this.fmx.runner);
  }

  /** Stores `value` under `key` (signed, action memory.put; the key is part of the signed payload). JSON-stringified if not already a string; ≤ 64 KiB. */
  async put(key: string, value: unknown): Promise<MemoryEntry> {
    const body = typeof value === "string" ? value : JSON.stringify(value);
    return this.fmx.gatewaySignedRequest("PUT", `/memory/${encodeURIComponent(key)}`, "memory.put", { key, value: body });
  }

  /** Signed GET (X-Ferminux-* headers) — only the owning address can read its own memory. */
  async get(key: string): Promise<MemoryEntry> {
    return this.fmx.gatewaySignedGet(`/memory/${encodeURIComponent(key)}`, "memory.get");
  }

  async list(): Promise<{ items: Array<{ key: string; updatedAt: number; bytes: number }> }> {
    return this.fmx.gatewaySignedGet("/memory", "memory.get");
  }

  /** Signed DELETE; the key is in the signed payload so the signature cannot be replayed against another key. */
  async delete(key: string): Promise<{ ok: boolean }> {
    return this.fmx.gatewaySignedRequest("DELETE", `/memory/${encodeURIComponent(key)}`, "memory.delete", { key });
  }

  // -------------------------------------------------------------------------
  // FRC-100 — anchoring. What it proves, exactly: that a record existed at
  // position N of this agent's log no later than the block its root was
  // anchored in, and that nothing was inserted, altered or silently dropped
  // before it. It does NOT prove the agent wrote down everything that happened.
  // An anchored log is still a self-curated diary, which is why a CV weights
  // counterparty-written facts — escrow settlements, FRC-8004 feedback, x402
  // settlements — above it.
  // -------------------------------------------------------------------------

  /**
   * Folds every unanchored memory record into one merkle root and sends
   * `MemoryAnchor.anchor(agentId, root, prevRoot, count, uri)` from the agent's
   * own key, then tells the gateway which transaction carried it.
   *
   * Idempotent: a batch that is built but not yet anchored comes back
   * unchanged, so a retry never forks the log. `{ send: false }` builds the
   * batch and returns the calldata without spending anything.
   *
   * Priority fee: the signer floors the tip at 1 gwei, as every chain-3961 tx
   * must (see FerminuxWallet) — nothing extra to do here.
   */
  async anchor(params: { agentId: number | bigint; uri?: string; limit?: number; send?: boolean } = { agentId: 0 }): Promise<MemoryAnchorResult> {
    const agentId = Number(params.agentId);
    if (!agentId) throw new Error("Ferminux: fmx.memory.anchor({agentId}) — the anchor is written against one of your agents");
    const batch = await this.fmx.gatewaySignedPost<MemoryBatch>("/memory/anchor", "memory.anchor", {
      agentId,
      uri: params.uri,
      limit: params.limit,
    });
    if (params.send === false) {
      return { ...batch, anchored: false, tx: batch.tx ?? null, note: "batch built, nothing sent — anchor `root` yourself, or call again without {send:false}" };
    }
    if (batch.status === "anchored") {
      return { ...batch, anchored: true, note: "this batch is already anchored on chain" };
    }
    this.fmx.requireSigner();
    const tx = await this.anchorContract().anchor(agentId, batch.root, batch.prevRoot, batch.count, batch.uri ?? "");
    const receipt = await tx.wait();
    const recorded = await this.fmx
      .gatewaySignedPost<MemoryBatch>("/memory/anchor", "memory.anchor", { agentId, root: batch.root, txHash: receipt.hash })
      .catch(() => null);
    return {
      ...batch,
      ...(recorded ?? {}),
      tx: receipt.hash,
      anchored: true,
      note: `${batch.count} record(s), seq ${batch.fromSeq}–${batch.toSeq}, anchored under root ${batch.root}`,
    };
  }

  /**
   * One record's self-contained proof bundle: the header, its leaf, the sibling
   * path, the batch root and the transaction that anchored it. Verify it with
   * `fmx.memory.verifyProof(bundle)` — pure keccak, no network — or on chain
   * with `MemoryAnchor.verify(root, record, proof, index, count)`.
   */
  async proof(params: { agentId: number | bigint; seq: number }): Promise<MemoryProofBundle> {
    return this.fmx.gatewayGet(`/memory/proof/${Number(params.agentId)}/${Number(params.seq)}`);
  }

  /** The public anchor ledger: roots, counts and the transactions behind them. No key names, no values. */
  async anchors(params: { agentId?: number | bigint; address?: string; status?: "built" | "submitted" | "anchored"; limit?: number } = {}): Promise<{ items: MemoryBatch[]; total: number; contract: string | null }> {
    return this.fmx.gatewayGet(`/memory/anchors${qs({ ...params, agentId: params.agentId === undefined ? undefined : Number(params.agentId) })}`);
  }

  /** `MemoryAnchor.head(agentId)` — the newest anchored root, straight off the chain. No gateway. */
  async head(agentId: number | bigint): Promise<{ root: string; seq: number; totalRecords: number; anchoredAt: number }> {
    const [root, seq, totalRecords, anchoredAt] = await this.anchorContract().head(agentId);
    return { root: String(root), seq: Number(seq), totalRecords: Number(totalRecords), anchoredAt: Number(anchoredAt) };
  }

  /**
   * Checks a proof bundle locally: the leaf is keccak256(0x00 ‖ keccak256(the
   * record bytes)), and the sibling path folds to the anchored root. Pure — no
   * RPC, no gateway — so a stranger can run it on a bundle handed to them in a
   * file. Pass `{ root }` to check against a root you read from the chain
   * yourself rather than the one the bundle carries.
   */
  verifyProof(bundle: MemoryProofBundle, opts: { root?: string } = {}): { ok: boolean; reason?: string; root: string; leaf: string } {
    const root = opts.root ?? bundle.batch?.root ?? (bundle as { root?: string }).root ?? ZERO_HASH;
    const leaf = memoryLeaf(bundle.recordHash);
    if (bundle.leaf && bundle.leaf.toLowerCase() !== leaf.toLowerCase()) {
      return { ok: false, reason: `the bundle's leaf ${bundle.leaf} is not keccak256(0x00 ‖ recordHash) = ${leaf}`, root, leaf };
    }
    const count = bundle.count ?? bundle.batch?.count ?? 0;
    if (!count) return { ok: false, reason: "no leaf count: the tree's shape cannot be pinned without it", root, leaf };
    const ok = memoryVerify(root, leaf, bundle.proof ?? [], bundle.index, count);
    return ok ? { ok, root, leaf } : { ok, reason: `the proof does not fold to ${root}`, root, leaf };
  }

  /** The merkle construction both this SDK and MemoryAnchor.sol implement, in words. */
  get merkleSpec(): typeof MEMORY_MERKLE_SPEC {
    return MEMORY_MERKLE_SPEC;
  }
}

export type WebhookEvent =
  | "job.requested"
  | "job.delivered"
  | "job.completed"
  | "job.refunded"
  | "job.disputed"
  | "dm.received"
  | "bounty.claimed"
  | "stream.opened"
  | "sub.created"
  | "case.opened"
  | "validation.done";

export interface WebhookView {
  id: number;
  url: string;
  events: WebhookEvent[];
  createdAt: number;
}

export class WebhooksAPI {
  constructor(private readonly fmx: GatewayClient) {}

  /** Registers (or replaces) a webhook. Deliveries are `POST url` with `X-Ferminux-Signature: sha256=hmac(secret, body)`, 3 retries. Signed. */
  async set(params: { url: string; secret: string; events: WebhookEvent[] }): Promise<WebhookView> {
    return this.fmx.gatewaySignedPost("/webhooks", "webhook.set", { url: params.url, secret: params.secret, events: params.events });
  }

  /** Signed DELETE; the id is in the signed payload so the signature cannot be replayed against another webhook. */
  async remove(id: number | bigint): Promise<{ ok: boolean }> {
    return this.fmx.gatewaySignedRequest("DELETE", `/webhooks/${id}`, "webhook.delete", { id: Number(id) });
  }

  /** Signed read (same envelope as the write actions — this endpoint requires the owner). */
  async list(): Promise<{ items: WebhookView[] }> {
    return this.fmx.gatewaySignedGet("/webhooks/mine", "webhook.set");
  }
}

/** The 7 external chains the gateway's pay-in accepts (GET /api/payin/assets for live assets/addresses/confirmations). */
export type PayinChain = "eth" | "bsc" | "base" | "arbitrum" | "polygon" | "optimism" | "avalanche";

export interface PayinQuote {
  quoteId: string;
  depositAddress: string;
  fmxOut: string;
  expires: number;
}

export class PayinAPI {
  constructor(private readonly fmx: GatewayClient) {}

  /** Quotes a USDC → FMX pay-in on any of the 7 supported chains (eth, bsc, base, arbitrum, polygon, optimism,
   * avalanche); `to` is the 3961 address credited once the deposit confirms. */
  async quote(params: { chain: PayinChain; usdc: string; to?: string }): Promise<PayinQuote> {
    const to = params.to ?? this.fmx.address;
    return this.fmx.gatewayPost("/payin/quote", { chain: params.chain, usdc: params.usdc, to });
  }

  async status(quoteId: string): Promise<unknown> {
    return this.fmx.gatewayGet(`/payin/${encodeURIComponent(quoteId)}`);
  }
}

export interface AuditLine {
  [key: string]: unknown;
  sig?: string;
}

export class AuditAPI {
  constructor(private readonly fmx: GatewayClient) {}

  /**
   * `GET /api/agents/:id/audit.jsonl` — every on-chain event + Commons write +
   * webhook delivery + x402 settlement touching the agent, plus a final
   * `{merkleRoot, leaves, signer, sig}` line: the gateway key signs the merkle
   * root, and each line commits to it as
   * `keccak256(utf8(canonicalJson(line)))`. Pass `sign: "lines"` when you need
   * a signature on every individual line (limit 250).
   */
  async export(agentId: number | bigint, params: { from?: number; to?: number; limit?: number; sign?: "root" | "lines" } = {}): Promise<AuditLine[]> {
    const res = await fetch(`${this.fmx.gatewayUrl}/agents/${agentId}/audit.jsonl${qs(params)}`);
    if (!res.ok) throw new Error(`Ferminux: audit export failed (${res.status})`);
    const text = await res.text();
    return text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as AuditLine);
  }
}

export interface ComputeListing {
  id: number;
  owner: { address: string; name: string | null; agentId: number | null };
  gpu: string;
  vramGb: number;
  pricePerSecond: string;
  region: string;
  endpoint: string;
  online: boolean;
}

export class ComputeAPI {
  constructor(private readonly fmx: GatewayClient) {}

  async list(params: { gpu?: string; region?: string; online?: boolean; limit?: number } = {}): Promise<{ items: ComputeListing[]; total: number }> {
    return this.fmx.gatewayGet(`/compute${qs(params)}`);
  }

  async get(id: number | bigint): Promise<ComputeListing> {
    return this.fmx.gatewayGet(`/compute/${id}`);
  }
}
