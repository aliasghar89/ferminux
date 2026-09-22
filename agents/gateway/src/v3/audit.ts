// Signed audit export: GET /api/agents/:id/audit.jsonl — every on-chain
// event, Commons write, webhook delivery and x402 settlement touching the
// agent (by id, or by its owner address), one JSON object per line. The last
// line is {merkleRoot, leaves, signer, sig}: the gateway key signs the MERKLE
// ROOT, and every line commits to it through
// leaf = keccak256(canonicalJson(line-without-sig)) in order — one signature
// covers the whole export, so the default response costs one signMessageSync
// instead of one per line.
//
// `?sign=lines` restores the per-line `sig` (gateway-key EIP-191 over the
// line's canonical JSON without `sig`) for callers that verify lines in
// isolation; it costs one signature per line, so the limit is lower.
import type { FastifyInstance } from "fastify";
import { concat, keccak256, toUtf8Bytes } from "ethers";
import { canonicalJson } from "../commons/sign.js";
import { HttpError } from "../commons/context.js";
import type { AgentRow } from "../types.js";
import type { V3Context } from "./context.js";

export const AUDIT_DEFAULT_LIMIT = 1000;
export const AUDIT_MAX_LIMIT = 1000;
/** ?sign=lines signs every line individually — one signMessageSync each, so it is capped lower. */
export const AUDIT_SIGN_LINES_MAX_LIMIT = 250;
/** from/to below this are block numbers, at or above are unix seconds */
export const AUDIT_TIME_THRESHOLD = 1_000_000_000;

export interface AuditLine {
  seq: number;
  kind: "chain" | "commons" | "webhook" | "x402";
  ts: number | null;
  block?: number;
  [k: string]: unknown;
}

export function leafHash(line: Record<string, unknown>): string {
  const { sig: _s, ...rest } = line;
  return keccak256(toUtf8Bytes(canonicalJson(rest)));
}

export function merkleRoot(leaves: string[]): string {
  if (!leaves.length) return keccak256("0x");
  let level = leaves;
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i]!;
      const b = level[i + 1] ?? a;
      next.push(keccak256(concat([a, b])));
    }
    level = next;
  }
  return level[0]!;
}

interface Filter {
  fromBlock?: number;
  toBlock?: number;
  fromTs?: number;
  toTs?: number;
}

function parseFilter(from?: string, to?: string): Filter {
  const f: Filter = {};
  const num = (v?: string) => (v === undefined || v === "" ? undefined : Number(v));
  const a = num(from);
  const b = num(to);
  for (const [name, v] of [["from", a], ["to", b]] as const) if (v !== undefined && (!Number.isFinite(v) || v < 0)) throw new HttpError(400, `${name} must be a block number or unix seconds`);
  if (a !== undefined) (a >= AUDIT_TIME_THRESHOLD ? (f.fromTs = a) : (f.fromBlock = a));
  if (b !== undefined) (b >= AUDIT_TIME_THRESHOLD ? (f.toTs = b) : (f.toBlock = b));
  return f;
}

function keep(line: AuditLine, f: Filter): boolean {
  if (f.fromBlock !== undefined && line.block !== undefined && line.block < f.fromBlock) return false;
  if (f.toBlock !== undefined && line.block !== undefined && line.block > f.toBlock) return false;
  // a block-range filter selects on-chain lines only (off-chain lines carry no block)
  if ((f.fromBlock !== undefined || f.toBlock !== undefined) && line.block === undefined) return false;
  if (f.fromTs !== undefined && line.ts !== null && line.ts < f.fromTs) return false;
  if (f.toTs !== undefined && line.ts !== null && line.ts > f.toTs) return false;
  return true;
}

export function collectAudit(ctx: V3Context, agent: AgentRow, f: Filter, limit: number): AuditLine[] {
  const db = ctx.db;
  const owner = agent.owner.toLowerCase();
  const lines: AuditLine[] = [];
  const parse = (s: string): Record<string, unknown> => {
    try {
      return JSON.parse(s);
    } catch {
      return {};
    }
  };

  // on-chain: registry events for this id, escrow events for its jobs, v3 events naming the id or the owner
  const chain = db
    .prepare(
      `SELECT * FROM events WHERE
         (contractName = 'registry' AND json_extract(argsJSON, '$.id') = ?)
      OR (contractName = 'escrow' AND json_extract(argsJSON, '$.jobId') IN (SELECT id FROM jobs WHERE agentId = ?))
      OR (contractName NOT IN ('registry','escrow') AND (json_extract(argsJSON, '$.agentId') = ? OR lower(argsJSON) LIKE ?))
       ORDER BY blockNumber ASC, logIndex ASC`,
    )
    .all(String(agent.id), agent.id, String(agent.id), `%${owner}%`) as Array<{ txHash: string; logIndex: number; blockNumber: number; contractName: string; eventName: string; argsJSON: string; ts: number | null }>;
  for (const e of chain) lines.push({ seq: 0, kind: "chain", ts: e.ts ?? null, block: e.blockNumber, contract: e.contractName, event: e.eventName, tx: e.txHash, logIndex: e.logIndex, args: parse(e.argsJSON) });

  // Commons writes by the owner (forum, messages [public parts], bounties, kb, tools, artifacts, arena, presence)
  const commons = db
    .prepare("SELECT id, type, ts, actor, refKind, refId, data FROM activity WHERE lower(actor) = ? AND type NOT LIKE 'job.%' AND type NOT LIKE 'agent.%' ORDER BY id ASC")
    .all(owner) as Array<{ id: number; type: string; ts: number; actor: string; refKind: string | null; refId: string | null; data: string }>;
  for (const a of commons) lines.push({ seq: 0, kind: "commons", ts: a.ts, activityId: a.id, type: a.type, actor: a.actor, ref: a.refKind ? { kind: a.refKind, id: a.refId } : null, data: parse(a.data) });

  // webhook deliveries to the owner's hooks
  const hooks = db
    .prepare("SELECT d.id, d.webhookId, d.event, d.status, d.attempts, d.lastStatus, d.lastError, d.createdAt, d.deliveredAt, w.url FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhookId WHERE lower(d.owner) = ? ORDER BY d.id ASC")
    .all(owner) as Array<{ id: number; webhookId: number; event: string; status: string; attempts: number; lastStatus: number | null; lastError: string | null; createdAt: number; deliveredAt: number | null; url: string }>;
  for (const d of hooks) lines.push({ seq: 0, kind: "webhook", ts: d.createdAt, deliveryId: d.id, webhookId: d.webhookId, url: d.url, event: d.event, status: d.status, attempts: d.attempts, lastStatus: d.lastStatus, lastError: d.lastError, deliveredAt: d.deliveredAt });

  // x402: settlements (on-chain) + vouchers accepted by the facilitator where the owner is payee or payer
  const settlements = db
    .prepare("SELECT * FROM x402_settlements WHERE lower(payee) = ? OR lower(payer) = ? ORDER BY blockNumber ASC, logIndex ASC")
    .all(owner, owner) as Array<{ txHash: string; logIndex: number; payer: string; payee: string; amount: string; fee: string; nonce: string; ref: string; blockNumber: number; ts: number }>;
  for (const s of settlements) lines.push({ seq: 0, kind: "x402", ts: s.ts, block: s.blockNumber, event: "Settled", tx: s.txHash, logIndex: s.logIndex, payer: s.payer, payee: s.payee, amount: s.amount, fee: s.fee, nonce: s.nonce, ref: s.ref });
  const vouchers = db
    .prepare("SELECT payer, nonce, payee, amount, ref, expiry, resource, status, txHash, createdAt, settledAt FROM x402_vouchers WHERE lower(payee) = ? OR lower(payer) = ? ORDER BY createdAt ASC")
    .all(owner, owner) as Array<Record<string, unknown> & { createdAt: number }>;
  for (const v of vouchers) lines.push({ seq: 0, kind: "x402", ts: v.createdAt, event: "Voucher", ...v });

  const filtered = lines.filter((l) => keep(l, f));
  filtered.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0) || (a.block ?? 0) - (b.block ?? 0));
  const out = filtered.slice(0, limit);
  out.forEach((l, i) => (l.seq = i + 1));
  return out;
}

export function registerAuditRoutes(app: FastifyInstance, ctx: V3Context): void {
  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string; limit?: string; sign?: string } }>(
    "/api/agents/:id/audit.jsonl",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req, reply) => {
      try {
        const agent = ctx.db.prepare("SELECT * FROM agents WHERE id = ?").get(Number(req.params.id)) as AgentRow | undefined;
        if (!agent) throw new HttpError(404, "agent not found");
        const f = parseFilter(req.query.from, req.query.to);
        const signLines = req.query.sign === "lines";
        if (req.query.sign !== undefined && req.query.sign !== "" && req.query.sign !== "lines" && req.query.sign !== "root") {
          throw new HttpError(400, 'sign must be "root" (default) or "lines"');
        }
        const max = signLines ? AUDIT_SIGN_LINES_MAX_LIMIT : AUDIT_MAX_LIMIT;
        const limit = ctx.commons.parseLimit(req.query.limit, Math.min(AUDIT_DEFAULT_LIMIT, max), max);
        const lines = collectAudit(ctx, agent, f, limit);
        const signer = ctx.signer;
        const leaves: string[] = [];
        const out: string[] = [];
        for (const line of lines) {
          const withMeta = { ...line, agentId: agent.id, signer: signer.address };
          leaves.push(leafHash(withMeta));
          // Default: no per-line signature — the footer's signed merkle root covers every leaf.
          out.push(JSON.stringify(signLines ? { ...withMeta, sig: signer.signMessageSync(canonicalJson(withMeta)) } : withMeta));
        }
        const root = merkleRoot(leaves);
        const footer = {
          merkleRoot: root,
          leaves: leaves.length,
          leafHash: "keccak256(utf8(canonicalJson(line without sig)))",
          merkle: "pairwise keccak256(concat(left, right)) bottom-up; an odd node is paired with itself",
          signature: signLines
            ? "EIP-191 personal_sign over canonicalJson(line without sig); this footer's sig covers canonicalJson(footer without sig)"
            : "EIP-191 personal_sign over canonicalJson(footer without sig) — the signed merkleRoot authenticates every line; add ?sign=lines for a per-line sig",
          signedLines: signLines,
          agentId: agent.id,
          owner: agent.owner,
          signer: signer.address,
          signerEphemeral: ctx.signerEphemeral,
          generatedAt: ctx.nowS(),
          filter: f,
          limit,
          truncated: lines.length >= limit,
        };
        out.push(JSON.stringify({ ...footer, sig: signer.signMessageSync(canonicalJson(footer)) }));
        reply.header("content-type", "application/x-ndjson; charset=utf-8");
        reply.header("x-ferminux-signer", signer.address);
        reply.header("x-ferminux-merkle-root", root);
        reply.header("x-ferminux-signed", signLines ? "lines+root" : "root");
        return reply.send(out.join("\n") + "\n");
      } catch (err) {
        return ctx.commons.sendError(reply, err);
      }
    },
  );
}
