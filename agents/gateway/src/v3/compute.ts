// Compute listings: tools of kind "compute" ({gpu, vramGb, pricePerSecond, region, endpoint}).
// The endpoint is x402-priced by the provider; the gateway lists + health-checks only.
import type { FastifyInstance } from "fastify";
import { HttpError } from "../commons/context.js";
import { toolView, type ToolRow } from "../commons/tools.js";
import type { V3Context } from "./context.js";

export function registerComputeRoutes(app: FastifyInstance, ctx: V3Context): void {
  const { db, commons } = ctx;
  app.get<{ Querystring: { gpu?: string; region?: string; maxPricePerSecond?: string; minVramGb?: string; online?: string; q?: string; limit?: string; offset?: string } }>(
    "/api/compute",
    async (req, reply) => {
      try {
        const { gpu, region, maxPricePerSecond, minVramGb, online, q } = req.query;
        const lim = commons.parseLimit(req.query.limit, 50, 200);
        const off = commons.parseOffset(req.query.offset);
        const where: string[] = ["kind = 'compute'"];
        const params: unknown[] = [];
        if (gpu) {
          where.push("lower(json_extract(compute, '$.gpu')) LIKE lower(?)");
          params.push(`%${gpu}%`);
        }
        if (region) {
          where.push("lower(json_extract(compute, '$.region')) LIKE lower(?)");
          params.push(`%${region}%`);
        }
        if (minVramGb) {
          const n = Number(minVramGb);
          if (!Number.isFinite(n)) throw new HttpError(400, "minVramGb must be a number");
          where.push("CAST(json_extract(compute, '$.vramGb') AS REAL) >= ?");
          params.push(n);
        }
        if (q) {
          where.push("(name LIKE ? OR description LIKE ?)");
          params.push(`%${q}%`, `%${q}%`);
        }
        if (online === "1" || online === "true") where.push("online = 1");
        const whereSql = `WHERE ${where.join(" AND ")}`;
        let rows = db.prepare(`SELECT * FROM tools ${whereSql} ORDER BY online DESC, updatedAt DESC, id DESC`).all(...params) as ToolRow[];
        if (maxPricePerSecond) {
          const max = commons.checkWei(maxPricePerSecond, "maxPricePerSecond");
          rows = rows.filter((r) => {
            try {
              return BigInt((JSON.parse(r.compute ?? "{}") as { pricePerSecond?: string }).pricePerSecond ?? "0") <= BigInt(max);
            } catch {
              return false;
            }
          });
        }
        const total = rows.length;
        return { items: rows.slice(off, off + lim).map(view), total, pricing: "x402 at the provider endpoint (wei of FMX per second)" };
      } catch (err) {
        return commons.sendError(reply, err);
      }
    },
  );

  app.get<{ Params: { id: string } }>("/api/compute/:id", async (req, reply) => {
    const row = db.prepare("SELECT * FROM tools WHERE id = ? AND kind = 'compute'").get(Number(req.params.id)) as ToolRow | undefined;
    if (!row) return reply.code(404).send({ error: "compute listing not found" });
    return view(row);
  });

  /** ToolView + the compute fields flattened to the top level (gpu, vramGb, pricePerSecond, region, endpoint). */
  function view(row: ToolRow) {
    const v = toolView(row, commons.author);
    return { ...v, ...(v.compute ?? {}) };
  }
}
