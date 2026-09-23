import type { Db } from "./db.js";
import { AgentStatus } from "./abi.js";
import { readCapped, safeFetch } from "./net.js";

/** Probe history window the CV reports on. */
export const UPTIME_WINDOW_DAYS = 30;
/** Below this many days of history an uptime percentage is noise, so the CV says so instead of flattering. */
export const UPTIME_MIN_DAYS = 7;

function dayOf(ms: number): number {
  const s = Math.floor(ms / 1000);
  return s - (s % 86400);
}

/**
 * Folds one probe into the agent's daily rollup. Before this existed the probe
 * overwrote agents.online in place with no history, so uptime was unknowable —
 * 288 probes a day now collapse into one row.
 */
export function recordProbe(db: Db, id: number, ok: boolean, ms: number, nowMs = Date.now()): void {
  db.prepare(
    `INSERT INTO agent_probes_daily (agentId, day, ok, fail, lastMs) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(agentId, day) DO UPDATE SET ok = ok + excluded.ok, fail = fail + excluded.fail, lastMs = COALESCE(excluded.lastMs, agent_probes_daily.lastMs)`,
  ).run(id, dayOf(nowMs), ok ? 1 : 0, ok ? 0 : 1, ok ? Math.round(ms) : null);
}

export interface UptimeView {
  windowDays: number;
  days: number;
  probes: number;
  ok: number;
  fail: number;
  /** null until UPTIME_MIN_DAYS of history exist — an uptime number built on two days is not one */
  uptimePct: number | null;
  lastMs: number | null;
  enoughHistory: boolean;
  note: string;
}

/** Uptime over the last `windowDays`, from the probe rollup. Observed by this gateway — nobody else can re-derive it. */
export function agentUptime(db: Db, agentId: number, windowDays = UPTIME_WINDOW_DAYS, nowMs = Date.now()): UptimeView {
  const since = dayOf(nowMs) - (windowDays - 1) * 86400;
  const row = db
    .prepare("SELECT COUNT(*) AS days, COALESCE(SUM(ok), 0) AS ok, COALESCE(SUM(fail), 0) AS fail FROM agent_probes_daily WHERE agentId = ? AND day >= ?")
    .get(agentId, since) as { days: number; ok: number; fail: number };
  const last = db.prepare("SELECT lastMs FROM agent_probes_daily WHERE agentId = ? AND lastMs IS NOT NULL ORDER BY day DESC LIMIT 1").get(agentId) as { lastMs: number } | undefined;
  const probes = row.ok + row.fail;
  const enough = row.days >= UPTIME_MIN_DAYS && probes > 0;
  return {
    windowDays,
    days: row.days,
    probes,
    ok: row.ok,
    fail: row.fail,
    uptimePct: enough ? Math.round((row.ok / probes) * 1000) / 10 : null,
    lastMs: last?.lastMs ?? null,
    enoughHistory: enough,
    note: enough
      ? "observed by this gateway's probe of the agent's card; the one number on a Ferminux CV a stranger cannot re-derive from chain 3961"
      : `not enough probe history yet (${row.days} of ${UPTIME_MIN_DAYS} days)`,
  };
}

export interface ProbeOptions {
  timeoutMs?: number;
  maxBytes?: number;
}

/** Probes one agent's /.well-known/ferminux-agent.json card and updates its row. */
export async function probeAgent(db: Db, id: number, endpoint: string, opts: ProbeOptions = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const maxBytes = opts.maxBytes ?? 64 * 1024;
  const url = `${endpoint.replace(/\/+$/, "")}/.well-known/ferminux-agent.json`;
  const startedAt = Date.now();
  try {
    // public hosts only — an agent endpoint is attacker-controlled (SSRF guard, redirects re-checked)
    const res = await safeFetch(url, { timeoutMs, headers: { accept: "application/json", "user-agent": "ferminux-gateway/health" } });
    if (!res.ok) throw new Error(`probe: unexpected status ${res.status}`);
    const buf = await readCapped(res, maxBytes);
    const json = JSON.parse(buf.toString("utf8"));
    if (!json || typeof json !== "object" || json.ferminux !== 1) {
      throw new Error("probe: card missing ferminux:1");
    }
    const now = Date.now();
    db.prepare("UPDATE agents SET card = ?, online = 1, lastSeen = ? WHERE id = ?").run(JSON.stringify(json), now, id);
    recordProbe(db, id, true, now - startedAt, now);
  } catch {
    db.prepare("UPDATE agents SET online = 0 WHERE id = ?").run(id);
    recordProbe(db, id, false, Date.now() - startedAt);
  }
}

export async function probeActiveAgents(db: Db, opts: ProbeOptions = {}): Promise<void> {
  const rows = db.prepare("SELECT id, endpoint FROM agents WHERE status = ?").all(AgentStatus.Active) as Array<{
    id: number;
    endpoint: string;
  }>;
  await Promise.all(rows.map((r) => probeAgent(db, r.id, r.endpoint, opts)));
}

export function startHealthProbe(db: Db, probeMs: number, opts: ProbeOptions = {}): () => void {
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await probeActiveAgents(db, opts);
    } catch (err) {
      console.error("[health] probe tick failed:", err);
    } finally {
      running = false;
    }
  };

  const handle = setInterval(tick, probeMs);
  void tick();

  return () => {
    stopped = true;
    clearInterval(handle);
  };
}
