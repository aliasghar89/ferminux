// v3 contract events → state tables + activity + webhooks. Called by the
// indexer for every log from an X402Vault / AgentAccountFactory / StreamPay /
// ArbiterPool / *Registry8004 / AgentTokenFactory address. Argument names
// are read tolerantly (spec names first, common aliases second) so the
// as-built ABI JSONs need not match the spec fragments exactly.
import type { LogDescription } from "ethers";
import { getAddress } from "ethers";
import type { Db } from "../db.js";
import type { V3ContractKey } from "../config.js";
import type { ActivityBus, ActivityType } from "../commons/activity.js";
import type { WebhookBus } from "./webhooks.js";

export interface V3LogEvent {
  key: V3ContractKey;
  parsed: LogDescription;
  args: Record<string, unknown>;
  blockNumber: number;
  txHash: string;
  logIndex: number;
  ts: number;
}

export interface V3IndexerDeps {
  db: Db;
  activity: ActivityBus;
  webhooks: WebhookBus;
}

function pick(args: Record<string, unknown>, names: string[]): unknown {
  for (const n of names) if (args[n] !== undefined) return args[n];
  return undefined;
}
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function str(v: unknown): string {
  return v === undefined || v === null ? "" : String(v);
}
function addr(v: unknown): string {
  try {
    return getAddress(String(v));
  } catch {
    return str(v);
  }
}

export function applyV3Event(deps: V3IndexerDeps, ev: V3LogEvent): void {
  const { db, activity, webhooks } = deps;
  const { key, args, ts } = ev;
  const name = ev.parsed.name;
  const dedup = `${name}:${ev.txHash}:${ev.logIndex}`;
  const emit = (type: ActivityType, actor: string | null, ref: { kind: string; id: string | number }, data: Record<string, unknown>) =>
    activity.emit(type, { actor, ref, ts, dedupKey: dedup, data: { ...data, tx: ev.txHash, block: ev.blockNumber, contract: key, event: name } });
  const agentStmt = db.prepare("SELECT id, owner, name FROM agents WHERE id = ?");
  const jobStmt = db.prepare("SELECT id, agentId, client FROM jobs WHERE id = ?");
  // Handlers that INCREMENT (stream deposit/claimed, case votes, token counters) must apply a log exactly once:
  // the 12-block reorg rescan and a resumed backfill replay logs, so each is claimed in v3_counted first.
  const counted = () => db.prepare("INSERT OR IGNORE INTO v3_counted (txHash, logIndex) VALUES (?, ?)").run(ev.txHash, ev.logIndex).changes === 1;

  switch (key) {
    case "x402Vault": {
      if (name === "Settled") {
        const payer = addr(args.payer);
        const payee = addr(args.payee);
        const amount = str(args.amount);
        const nonce = str(args.nonce);
        db.prepare(
          `INSERT INTO x402_settlements (txHash, logIndex, payer, payee, amount, fee, nonce, ref, blockNumber, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(txHash, logIndex) DO UPDATE SET payer=excluded.payer, payee=excluded.payee, amount=excluded.amount, fee=excluded.fee, nonce=excluded.nonce, ref=excluded.ref, blockNumber=excluded.blockNumber, ts=excluded.ts`,
        ).run(ev.txHash, ev.logIndex, payer, payee, amount, str(args.fee ?? "0"), nonce, str(args.ref), ev.blockNumber, ts);
        db.prepare("UPDATE x402_vouchers SET status = 'settled', txHash = ?, settledAt = ?, error = NULL WHERE payer = ? AND nonce = ?").run(ev.txHash, ts, payer, nonce);
        emit("x402.settled", payer, { kind: "x402", id: `${payer}:${nonce}` }, { payer, payee, amount, fee: str(args.fee ?? "0"), nonce, ref: str(args.ref) });
      } else if (name === "Skipped") {
        db.prepare("UPDATE x402_vouchers SET status = 'skipped', txHash = ?, error = ? WHERE payer = ? AND nonce = ? AND status <> 'settled'").run(ev.txHash, str(args.reason), addr(args.payer), str(args.nonce));
      }
      break;
    }
    case "accountFactory": {
      if (name === "AccountCreated") {
        const owner = addr(args.owner);
        const account = addr(args.account);
        db.prepare("INSERT INTO agent_accounts (account, owner, createdAt, txHash) VALUES (?, ?, ?, ?) ON CONFLICT(account) DO UPDATE SET owner=excluded.owner").run(account, owner, ts, ev.txHash);
        emit("account.created", owner, { kind: "account", id: account }, { owner, account });
      }
      break;
    }
    case "streamPay": {
      if (name === "StreamOpened") {
        const id = num(pick(args, ["id", "streamId"]));
        const payer = addr(args.payer);
        const payee = addr(args.payee);
        const ratePerSec = str(pick(args, ["ratePerSec", "rate"]) ?? "0");
        const deposit = str(pick(args, ["deposit", "amount"]) ?? "0");
        let start = num(args.start) || ts;
        let stop = num(args.stop);
        if (!stop && BigInt(ratePerSec || "0") > 0n) stop = start + Number(BigInt(deposit) / BigInt(ratePerSec));
        db.prepare(
          `INSERT INTO streams (id, payer, payee, ratePerSec, deposit, start, stop, cancelled, txOpened, updatedAtBlock) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
           ON CONFLICT(id) DO UPDATE SET payer=excluded.payer, payee=excluded.payee, ratePerSec=excluded.ratePerSec, deposit=excluded.deposit, start=excluded.start, stop=excluded.stop, txOpened=excluded.txOpened, updatedAtBlock=excluded.updatedAtBlock`,
        ).run(id, payer, payee, ratePerSec, deposit, start, stop, ev.txHash, ev.blockNumber);
        emit("stream.opened", payer, { kind: "stream", id }, { streamId: id, payer, payee, ratePerSec, deposit, start, stop });
        webhooks.dispatch("stream.opened", [payer, payee], { streamId: id, payer, payee, ratePerSec, deposit, start, stop, tx: ev.txHash }, dedup);
      } else if (name === "StreamToppedUp") {
        // as built: StreamToppedUp(id, amount, deposit, stop) — `deposit` is the new total when present
        const id = num(pick(args, ["id", "streamId"]));
        const amount = str(pick(args, ["amount", "value"]) ?? "0");
        if (args.deposit !== undefined) db.prepare("UPDATE streams SET deposit = ?, stop = CASE WHEN ? > 0 THEN ? ELSE stop END, updatedAtBlock = ? WHERE id = ?").run(str(args.deposit), num(args.stop), num(args.stop), ev.blockNumber, id);
        else if (counted()) db.prepare("UPDATE streams SET deposit = CAST(CAST(deposit AS INTEGER) + ? AS TEXT), stop = CASE WHEN ? > 0 THEN ? ELSE stop END, updatedAtBlock = ? WHERE id = ?").run(amount, num(args.stop), num(args.stop), ev.blockNumber, id);
      } else if (name === "StreamClaimed") {
        // as built: StreamClaimed(id, payeeAmount, fee)
        const id = num(pick(args, ["id", "streamId"]));
        const claimed = BigInt(str(pick(args, ["amount", "payeeAmount"]) ?? "0")) + BigInt(str(args.fee ?? "0"));
        if (counted()) db.prepare("UPDATE streams SET claimed = CAST(CAST(claimed AS INTEGER) + ? AS TEXT), updatedAtBlock = ? WHERE id = ?").run(claimed.toString(), ev.blockNumber, id);
      } else if (name === "StreamCancelled") {
        // as built: StreamCancelled(id, by, payeeAmount, fee, refund)
        const id = num(pick(args, ["id", "streamId"]));
        db.prepare("UPDATE streams SET cancelled = 1, updatedAtBlock = ? WHERE id = ?").run(ev.blockNumber, id);
        const s = db.prepare("SELECT payer, payee FROM streams WHERE id = ?").get(id) as { payer: string; payee: string } | undefined;
        emit("stream.cancelled", args.by !== undefined ? addr(args.by) : (s?.payer ?? null), { kind: "stream", id }, { streamId: id, payer: s?.payer ?? null, payee: s?.payee ?? null, toPayee: str(pick(args, ["payeeAmount", "toPayee"]) ?? ""), toPayer: str(pick(args, ["refund", "toPayer"]) ?? ""), fee: str(args.fee ?? "0") });
      } else if (name === "PlanCreated") {
        const id = num(pick(args, ["planId", "id"]));
        const payee = addr(args.payee);
        db.prepare(
          `INSERT INTO plans (id, payee, pricePerPeriod, period, active, metadataURI, createdAt, updatedAtBlock) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET payee=excluded.payee, pricePerPeriod=excluded.pricePerPeriod, period=excluded.period, metadataURI=excluded.metadataURI, updatedAtBlock=excluded.updatedAtBlock`,
        ).run(id, payee, str(pick(args, ["pricePerPeriod", "price"]) ?? "0"), num(args.period), str(args.metadataURI), ts, ev.blockNumber);
        emit("plan.created", payee, { kind: "plan", id }, { planId: id, payee, pricePerPeriod: str(pick(args, ["pricePerPeriod", "price"]) ?? "0"), period: num(args.period), metadataURI: str(args.metadataURI) });
      } else if (name === "PlanActiveSet" || name === "PlanUpdated") {
        db.prepare("UPDATE plans SET active = ?, updatedAtBlock = ? WHERE id = ?").run(String(args.active) === "true" ? 1 : 0, ev.blockNumber, num(pick(args, ["planId", "id"])));
      } else if (name === "Subscribed") {
        const id = num(pick(args, ["subId", "id"]));
        const planId = num(args.planId);
        const payer = addr(args.payer);
        const paidThrough = num(args.paidThrough);
        db.prepare(
          `INSERT INTO subs (id, planId, payer, paidThrough, cancelled, createdAt, updatedAtBlock) VALUES (?, ?, ?, ?, 0, ?, ?)
           ON CONFLICT(id) DO UPDATE SET planId=excluded.planId, payer=excluded.payer, paidThrough=excluded.paidThrough, updatedAtBlock=excluded.updatedAtBlock`,
        ).run(id, planId, payer, paidThrough, ts, ev.blockNumber);
        const plan = db.prepare("SELECT payee FROM plans WHERE id = ?").get(planId) as { payee: string } | undefined;
        emit("sub.created", payer, { kind: "sub", id }, { subId: id, planId, payer, payee: plan?.payee ?? null, periods: num(args.periods), paidThrough });
        webhooks.dispatch("sub.created", [payer, plan?.payee], { subId: id, planId, payer, payee: plan?.payee ?? null, periods: num(args.periods), paidThrough, tx: ev.txHash }, dedup);
      } else if (name === "SubRenewed") {
        db.prepare("UPDATE subs SET paidThrough = ?, updatedAtBlock = ? WHERE id = ?").run(num(args.paidThrough), ev.blockNumber, num(pick(args, ["subId", "id"])));
      } else if (name === "SubCancelled") {
        db.prepare("UPDATE subs SET cancelled = 1, updatedAtBlock = ? WHERE id = ?").run(ev.blockNumber, num(pick(args, ["subId", "id"])));
      }
      break;
    }
    case "arbiterPool": {
      if (name === "CaseOpened") {
        const id = num(pick(args, ["caseId", "id"]));
        const jobId = num(args.jobId);
        const opener = addr(args.opener);
        db.prepare(
          `INSERT INTO arbiter_cases (id, jobId, opener, evidenceURI, openedAt, votes, closed, txOpened, updatedAtBlock) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)
           ON CONFLICT(id) DO UPDATE SET jobId=excluded.jobId, opener=excluded.opener, evidenceURI=excluded.evidenceURI, openedAt=excluded.openedAt, txOpened=excluded.txOpened, updatedAtBlock=excluded.updatedAtBlock`,
        ).run(id, jobId, opener, str(args.evidenceURI), ts, ev.txHash, ev.blockNumber);
        const job = jobStmt.get(jobId) as { id: number; agentId: number; client: string } | undefined;
        const agent = job ? (agentStmt.get(job.agentId) as { owner: string; name: string } | undefined) : undefined;
        emit("case.opened", opener, { kind: "case", id }, { caseId: id, jobId, opener, evidenceURI: str(args.evidenceURI), agentId: job?.agentId ?? null, agentName: agent?.name ?? null, client: job?.client ?? null });
        webhooks.dispatch("case.opened", [job?.client, agent?.owner], { caseId: id, jobId, opener, evidenceURI: str(args.evidenceURI), agentId: job?.agentId ?? null, tx: ev.txHash }, dedup);
      } else if (name === "EvidenceSubmitted") {
        const id = num(pick(args, ["caseId", "id"]));
        const exists = !counted();
        if (!exists) db.prepare("INSERT INTO case_evidence (caseId, by, uri, ts, txHash) VALUES (?, ?, ?, ?, ?)").run(id, addr(pick(args, ["by", "submitter", "from"])), str(args.uri), ts, ev.txHash);
      } else if (name === "Voted") {
        // (was guarded by updatedAtBlock < block, which also dropped a second vote in the same block)
        if (counted()) db.prepare("UPDATE arbiter_cases SET votes = votes + 1, updatedAtBlock = ? WHERE id = ?").run(ev.blockNumber, num(pick(args, ["caseId", "id"])));
      } else if (name === "CaseClosed") {
        const id = num(pick(args, ["caseId", "id"]));
        const result = num(pick(args, ["clientBps", "result"]));
        db.prepare("UPDATE arbiter_cases SET closed = 1, result = ?, closedAt = ?, updatedAtBlock = ? WHERE id = ?").run(result, ts, ev.blockNumber, id);
        emit("case.closed", null, { kind: "case", id }, { caseId: id, jobId: num(args.jobId), clientBps: result });
      }
      break;
    }
    case "tokenFactory": {
      if (name === "Launched") {
        const token = addr(args.token);
        const agentId = num(args.agentId);
        db.prepare("INSERT INTO agent_tokens (token, agentId, symbol, launchedAt, txLaunched) VALUES (?, ?, ?, ?, ?) ON CONFLICT(token) DO UPDATE SET agentId=excluded.agentId, symbol=excluded.symbol").run(token, agentId, str(args.symbol), ts, ev.txHash);
        const agent = agentStmt.get(agentId) as { owner: string; name: string } | undefined;
        emit("token.launched", agent?.owner ?? null, { kind: "token", id: token }, { token, agentId, agentName: agent?.name ?? null, symbol: str(args.symbol) });
      } else if (name === "Bought" || name === "Sold" || name === "Distributed") {
        // counters are increments, so the 12-block reorg rescan must not re-apply a log we already counted
        const fresh = counted();
        if (fresh && name === "Bought") {
          db.prepare("UPDATE agent_tokens SET buys = buys + 1, fmxIn = CAST(CAST(fmxIn AS INTEGER) + ? AS TEXT) WHERE token = ?").run(str(args.fmxIn ?? "0"), addr(args.token));
        } else if (fresh && name === "Sold") {
          db.prepare("UPDATE agent_tokens SET sells = sells + 1, fmxOut = CAST(CAST(fmxOut AS INTEGER) + ? AS TEXT) WHERE token = ?").run(str(args.fmxOut ?? "0"), addr(args.token));
        } else if (fresh && name === "Distributed") {
          db.prepare("UPDATE agent_tokens SET distributed = CAST(CAST(distributed AS INTEGER) + ? AS TEXT) WHERE token = ?").run(str(args.amount ?? "0"), addr(args.token));
        }
      }
      break;
    }
    case "reputation8004": {
      if (name === "NewFeedback") {
        const agentId = num(args.agentId);
        const client = addr(args.clientAddress ?? args.client);
        db.prepare(
          "INSERT OR REPLACE INTO reputation_feedback (txHash, logIndex, agentId, client, value, valueDecimals, tag1, tag2, feedbackURI, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(ev.txHash, ev.logIndex, agentId, client, str(args.value ?? "0"), num(args.valueDecimals), str(args.tag1), str(args.tag2), str(args.feedbackURI), ts);
        emit("feedback.given", client, { kind: "agent", id: agentId }, { agentId, client, value: str(args.value ?? "0"), valueDecimals: num(args.valueDecimals), tag1: str(args.tag1), tag2: str(args.tag2) });
      }
      break;
    }
    case "validation8004": {
      if (name === "ValidationRequest") {
        const requestHash = str(args.requestHash).toLowerCase();
        const validator = addr(args.validatorAddress ?? args.validator);
        const agentId = num(args.agentId);
        db.prepare(
          `INSERT INTO validations (requestHash, validator, agentId, requestURI, requestedAt, txRequest) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(requestHash) DO UPDATE SET validator=excluded.validator, agentId=excluded.agentId, requestURI=excluded.requestURI, requestedAt=excluded.requestedAt, txRequest=excluded.txRequest`,
        ).run(requestHash, validator, agentId, str(args.requestURI), ts, ev.txHash);
        emit("validation.requested", validator, { kind: "agent", id: agentId }, { agentId, validator, requestHash, requestURI: str(args.requestURI) });
      } else if (name === "ValidationResponse") {
        const requestHash = str(args.requestHash).toLowerCase();
        const agentId = num(args.agentId);
        const response = num(args.response);
        db.prepare(
          `INSERT INTO validations (requestHash, validator, agentId, response, responseURI, tag, requestedAt, respondedAt, txResponse) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(requestHash) DO UPDATE SET response=excluded.response, responseURI=excluded.responseURI, tag=excluded.tag, respondedAt=excluded.respondedAt, txResponse=excluded.txResponse`,
        ).run(requestHash, addr(args.validatorAddress ?? args.validator), agentId, response, str(args.responseURI), str(args.tag), ts, ts, ev.txHash);
        const agent = agentStmt.get(agentId) as { owner: string; name: string } | undefined;
        emit("validation.done", addr(args.validatorAddress ?? args.validator), { kind: "agent", id: agentId }, { agentId, agentName: agent?.name ?? null, requestHash, response, responseURI: str(args.responseURI), tag: str(args.tag) });
        webhooks.dispatch("validation.done", [agent?.owner], { agentId, requestHash, response, responseURI: str(args.responseURI), tag: str(args.tag), validator: addr(args.validatorAddress ?? args.validator), tx: ev.txHash }, dedup);
      }
      break;
    }
    case "identity8004":
    case "accountImpl":
    default:
      break;
  }
}
