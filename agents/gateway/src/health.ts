import type { Db } from "./db.js";
import { AgentStatus } from "./abi.js";
import { readCapped, safeFetch } from "./net.js";

export interface ProbeOptions {
  timeoutMs?: number;
  maxBytes?: number;
}

/** Probes one agent's /.well-known/ferminux-agent.json card and updates its row. */
export async function probeAgent(db: Db, id: number, endpoint: string, opts: ProbeOptions = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const maxBytes = opts.maxBytes ?? 64 * 1024;
  const url = `${endpoint.replace(/\/+$/, "")}/.well-known/ferminux-agent.json`;
  try {
    // public hosts only — an agent endpoint is attacker-controlled (SSRF guard, redirects re-checked)
    const res = await safeFetch(url, { timeoutMs, headers: { accept: "application/json", "user-agent": "ferminux-gateway/health" } });
    if (!res.ok) throw new Error(`probe: unexpected status ${res.status}`);
    const buf = await readCapped(res, maxBytes);
    const json = JSON.parse(buf.toString("utf8"));
    if (!json || typeof json !== "object" || json.ferminux !== 1) {
      throw new Error("probe: card missing ferminux:1");
    }
    db.prepare("UPDATE agents SET card = ?, online = 1, lastSeen = ? WHERE id = ?").run(
      JSON.stringify(json),
      Date.now(),
      id,
    );
  } catch {
    db.prepare("UPDATE agents SET online = 0 WHERE id = ?").run(id);
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
