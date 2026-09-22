// Read views over the v3 contract state the indexer derives from events:
// streams, plans, subscriptions, arbitration cases, agent tokens, accounts.
// When the contract is not deployed the route answers
// {disabled:true, reason:"not deployed", items:[], total:0}.
import type { FastifyInstance } from "fastify";
import { HttpError } from "../commons/context.js";
import type { V3ContractKey } from "../config.js";
import { DISABLED_NOT_DEPLOYED, type V3Context } from "./context.js";

export function registerV3ReadRoutes(app: FastifyInstance, ctx: V3Context): void {
  const { db, commons } = ctx;
  const gate = (key: V3ContractKey) => (ctx.deployed(key) ? {} : DISABLED_NOT_DEPLOYED);

  app.get<{ Querystring: { payer?: string; payee?: string; status?: string; limit?: string; offset?: string } }>("/api/streams", async (req, reply) => {
    try {
      const { payer, payee, status } = req.query;
      const lim = commons.parseLimit(req.query.limit, 50, 200);
      const off = commons.parseOffset(req.query.offset);
      const where: string[] = [];
      const params: unknown[] = [];
      if (payer) {
        where.push("lower(payer) = lower(?)");
        params.push(payer);
      }
      if (payee) {
        where.push("lower(payee) = lower(?)");
        params.push(payee);
      }
      const t = ctx.nowS();
      if (status === "open") where.push(`cancelled = 0 AND stop > ${t}`);
      else if (status === "ended") where.push(`cancelled = 0 AND stop <= ${t}`);
      else if (status === "cancelled") where.push("cancelled = 1");
      else if (status) throw new HttpError(400, "status must be open|ended|cancelled");
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const total = (db.prepare(`SELECT COUNT(*) AS c FROM streams ${whereSql}`).get(...params) as { c: number }).c;
      const rows = db.prepare(`SELECT * FROM streams ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, lim, off) as Array<Record<string, unknown> & { cancelled: number; stop: number; payer: string; payee: string }>;
      return { ...gate("streamPay"), items: rows.map((r) => ({ ...r, payer: commons.author(r.payer), payee: commons.author(r.payee), cancelled: r.cancelled === 1, status: r.cancelled ? "cancelled" : r.stop > t ? "open" : "ended" })), total, now: t, contract: ctx.address("streamPay") ?? null };
    } catch (err) {
      return commons.sendError(reply, err);
    }
  });

  app.get<{ Querystring: { payee?: string; active?: string; limit?: string; offset?: string } }>("/api/streams/plans", async (req) => {
    const { payee, active } = req.query;
    const lim = commons.parseLimit(req.query.limit, 50, 200);
    const off = commons.parseOffset(req.query.offset);
    const where: string[] = [];
    const params: unknown[] = [];
    if (payee) {
      where.push("lower(payee) = lower(?)");
      params.push(payee);
    }
    if (active === "1" || active === "true") where.push("active = 1");
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM plans ${whereSql}`).get(...params) as { c: number }).c;
    const rows = db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM subs s WHERE s.planId = p.id AND s.cancelled = 0 AND s.paidThrough > ?) AS activeSubs FROM plans p ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`).all(ctx.nowS(), ...params, lim, off) as Array<Record<string, unknown> & { payee: string; active: number }>;
    return { ...gate("streamPay"), items: rows.map((r) => ({ ...r, payee: commons.author(r.payee), active: r.active === 1 })), total, contract: ctx.address("streamPay") ?? null };
  });

  app.get<{ Querystring: { payer?: string; planId?: string; active?: string; limit?: string; offset?: string } }>("/api/streams/subs", async (req) => {
    const { payer, planId, active } = req.query;
    const lim = commons.parseLimit(req.query.limit, 50, 200);
    const off = commons.parseOffset(req.query.offset);
    const where: string[] = [];
    const params: unknown[] = [];
    const t = ctx.nowS();
    if (payer) {
      where.push("lower(payer) = lower(?)");
      params.push(payer);
    }
    if (planId) {
      where.push("planId = ?");
      params.push(Number(planId));
    }
    if (active === "1" || active === "true") where.push(`cancelled = 0 AND paidThrough > ${t}`);
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM subs ${whereSql}`).get(...params) as { c: number }).c;
    const rows = db.prepare(`SELECT s.*, p.payee AS payee, p.pricePerPeriod, p.period FROM subs s LEFT JOIN plans p ON p.id = s.planId ${whereSql.replace(/\b(payer|planId|cancelled|paidThrough)\b/g, "s.$1")} ORDER BY s.id DESC LIMIT ? OFFSET ?`).all(...params, lim, off) as Array<Record<string, unknown> & { payer: string; payee: string | null; cancelled: number; paidThrough: number }>;
    return { ...gate("streamPay"), items: rows.map((r) => ({ ...r, payer: commons.author(r.payer), payee: r.payee ? commons.author(r.payee) : null, cancelled: r.cancelled === 1, active: !r.cancelled && r.paidThrough > t })), total, now: t, contract: ctx.address("streamPay") ?? null };
  });

  app.get<{ Querystring: { status?: string; open?: string; jobId?: string; opener?: string; limit?: string; offset?: string } }>("/api/disputes", async (req, reply) => {
    try {
      const { jobId, opener } = req.query;
      const status = req.query.status ?? (req.query.open === "1" ? "open" : req.query.open === "0" ? "closed" : undefined);
      const lim = commons.parseLimit(req.query.limit, 50, 200);
      const off = commons.parseOffset(req.query.offset);
      const where: string[] = [];
      const params: unknown[] = [];
      if (status === "open") where.push("closed = 0");
      else if (status === "closed") where.push("closed = 1");
      else if (status) throw new HttpError(400, "status must be open|closed");
      if (jobId) {
        where.push("jobId = ?");
        params.push(Number(jobId));
      }
      if (opener) {
        where.push("lower(opener) = lower(?)");
        params.push(opener);
      }
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const total = (db.prepare(`SELECT COUNT(*) AS c FROM arbiter_cases ${whereSql}`).get(...params) as { c: number }).c;
      const rows = db.prepare(`SELECT c.*, j.agentId AS agentId, j.client AS client FROM arbiter_cases c LEFT JOIN jobs j ON j.id = c.jobId ${whereSql.replace(/\b(closed|jobId|opener)\b/g, "c.$1")} ORDER BY c.id DESC LIMIT ? OFFSET ?`).all(...params, lim, off) as Array<Record<string, unknown> & { id: number; opener: string; closed: number }>;
      const evidenceStmt = db.prepare("SELECT * FROM case_evidence WHERE caseId = ? ORDER BY id ASC");
      return {
        ...gate("arbiterPool"),
        items: rows.map((r) => ({ ...r, opener: commons.author(r.opener), closed: r.closed === 1, status: r.closed ? "closed" : "open", evidence: evidenceStmt.all(r.id) })),
        total,
        contract: ctx.address("arbiterPool") ?? null,
      };
    } catch (err) {
      return commons.sendError(reply, err);
    }
  });

  app.get<{ Querystring: { agentId?: string; limit?: string; offset?: string } }>("/api/tokens", async (req) => {
    const lim = commons.parseLimit(req.query.limit, 50, 200);
    const off = commons.parseOffset(req.query.offset);
    const where: string[] = [];
    const params: unknown[] = [];
    if (req.query.agentId) {
      where.push("t.agentId = ?");
      params.push(Number(req.query.agentId));
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM agent_tokens t ${whereSql}`).get(...params) as { c: number }).c;
    const rows = db.prepare(`SELECT t.*, a.name AS agentName, a.owner AS owner FROM agent_tokens t LEFT JOIN agents a ON a.id = t.agentId ${whereSql} ORDER BY t.launchedAt DESC LIMIT ? OFFSET ?`).all(...params, lim, off);
    return { ...gate("tokenFactory"), items: rows, total, contract: ctx.address("tokenFactory") ?? null };
  });

  app.get<{ Querystring: { owner?: string; limit?: string; offset?: string } }>("/api/accounts", async (req) => {
    const lim = commons.parseLimit(req.query.limit, 50, 200);
    const off = commons.parseOffset(req.query.offset);
    const where: string[] = [];
    const params: unknown[] = [];
    if (req.query.owner) {
      where.push("lower(owner) = lower(?)");
      params.push(req.query.owner);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM agent_accounts ${whereSql}`).get(...params) as { c: number }).c;
    const rows = db.prepare(`SELECT * FROM agent_accounts ${whereSql} ORDER BY createdAt DESC LIMIT ? OFFSET ?`).all(...params, lim, off);
    return { ...gate("accountFactory"), items: rows, total, factory: ctx.address("accountFactory") ?? null, implementation: ctx.address("accountImpl") ?? null };
  });
}
