// Push alerts. Every failure in the agent economy used to be silent until someone happened to look: pay-in
// scanners failing on three chains for days with /api/status green, two of five signers silent, the LLM key
// out of credit, the first outside contributor's bounty delivery unreviewed. This module evaluates the same
// report /api/status serves, once a minute, and pushes a message when a service turns degraded or recovers
// (and a reminder every ALERT_REPEAT_H while it stays down), when the relayer or facilitator falls below
// ALERT_MIN_FUNDS_FMX, when a pay-in deposit matches no quote, and when an address outside
// ALERT_HOUSE_ADDRESSES registers an agent, claims a bounty, writes the KB or publishes an artifact.
//
// Delivery: Telegram sendMessage (ALERT_TELEGRAM_BOT_TOKEN + ALERT_TELEGRAM_CHAT_ID — the existing monitor bot;
// sendMessage only, never getUpdates, so it cannot fight another poller for the bot) and/or a JSON POST to
// ALERT_WEBHOOK_URL. Neither set = disabled. Tokens are never logged.
import type { JsonRpcProvider } from "ethers";
import type { Db } from "./db.js";
import type { GatewayConfig } from "./config.js";
import type { V3Context } from "./v3/context.js";
import type { X402Facilitator } from "./v3/x402.js";
import type { PayinWatcher } from "./v3/payin.js";
import type { ActivityBus, ActivityEvent } from "./commons/activity.js";
import { buildStatus, type StatusReport } from "./status.js";

type Log = { info: (o: unknown, msg?: string) => void; warn: (o: unknown, msg?: string) => void; error: (o: unknown, msg?: string) => void };

export interface AlertDeps {
  db: Db;
  cfg: GatewayConfig;
  provider: JsonRpcProvider;
  v3: V3Context;
  x402: X402Facilitator;
  payin: PayinWatcher;
  activity: ActivityBus;
  log: Log;
  /** injectable sender (tests); default posts to Telegram and/or the webhook */
  send?: (text: string) => Promise<void>;
  env?: NodeJS.ProcessEnv;
}

/** Commons / chain events worth a human's attention when they come from outside the house. */
export const ALERT_EVENT_TYPES = new Set(["agent.registered", "bounty.claim", "kb.write", "artifact.publish", "arena.submit"]);
export const ALERT_MAX_PER_HOUR = 30;

function envNum(env: NodeJS.ProcessEnv, name: string, def: number): number {
  const v = Number(env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

export function alertSender(env: NodeJS.ProcessEnv, log: Log): ((text: string) => Promise<void>) | null {
  const token = env.ALERT_TELEGRAM_BOT_TOKEN?.trim();
  const chat = env.ALERT_TELEGRAM_CHAT_ID?.trim();
  const hook = env.ALERT_WEBHOOK_URL?.trim();
  if (!(token && chat) && !hook) return null;
  return async (text: string) => {
    const jobs: Promise<unknown>[] = [];
    if (token && chat) {
      jobs.push(
        fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chat, text: text.slice(0, 3900), disable_web_page_preview: true }),
          signal: AbortSignal.timeout(10_000),
        }).then((r) => {
          if (!r.ok) log.warn({ status: r.status }, "alert: telegram sendMessage refused");
        }),
      );
    }
    if (hook) {
      jobs.push(
        fetch(hook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "ferminux-gateway", text }), signal: AbortSignal.timeout(10_000) }).then((r) => {
          if (!r.ok) log.warn({ status: r.status }, "alert: webhook refused");
        }),
      );
    }
    await Promise.allSettled(jobs);
  };
}

/** The alert state machine, separated from timers so it can be unit-tested. */
export class AlertState {
  private readonly down = new Map<string, number>(); // service → last alerted (unix s)
  private lastUnattributed: number | null = null;
  private readonly lowFunds = new Map<string, number>();
  private sentThisHour: number[] = [];
  constructor(private readonly repeatS: number, private readonly minFundsFmx: number) {}

  /** Messages for one status report (transitions + reminders). */
  evaluate(s: StatusReport, nowS: number): string[] {
    const out: string[] = [];
    const degraded = new Set(s.degraded);
    for (const name of degraded) {
      const detail = String(s.services[name]?.detail ?? "not ok");
      const last = this.down.get(name);
      if (last === undefined) {
        out.push(`DEGRADED ${name}: ${detail}`);
        this.down.set(name, nowS);
      } else if (nowS - last >= this.repeatS) {
        out.push(`STILL DEGRADED ${name} (since earlier): ${detail}`);
        this.down.set(name, nowS);
      }
    }
    for (const name of [...this.down.keys()]) {
      if (!degraded.has(name)) {
        out.push(`RECOVERED ${name}`);
        this.down.delete(name);
      }
    }
    // gas wallets: /api/status only flags < 0.1 FMX, far too late to top up in time
    for (const svc of ["relayer", "facilitator"]) {
      const bal = Number(s.services[svc]?.balanceFmx ?? NaN);
      if (!Number.isFinite(bal) || !s.services[svc]?.enabled) continue;
      const last = this.lowFunds.get(svc);
      if (bal < this.minFundsFmx) {
        if (last === undefined || nowS - last >= this.repeatS) {
          out.push(`LOW FUNDS ${svc} ${String(s.services[svc]?.address ?? "")}: ${bal} FMX (alert floor ${this.minFundsFmx} FMX)`);
          this.lowFunds.set(svc, nowS);
        }
      } else if (last !== undefined) this.lowFunds.delete(svc);
    }
    const un = Number(s.services.payin?.unattributed7d ?? 0);
    if (this.lastUnattributed !== null && un > this.lastUnattributed) {
      out.push(`PAY-IN: ${un - this.lastUnattributed} new deposit(s) matched no quote — refund or credit by hand (payin_transfers WHERE quoteId IS NULL)`);
    }
    this.lastUnattributed = un;
    return out;
  }

  /** Hourly cap so a flapping service cannot flood the chat. */
  allow(nowS: number): boolean {
    this.sentThisHour = this.sentThisHour.filter((t) => nowS - t < 3600);
    if (this.sentThisHour.length >= ALERT_MAX_PER_HOUR) return false;
    this.sentThisHour.push(nowS);
    return true;
  }
}

export function describeEvent(ev: ActivityEvent, base: string): string {
  const who = ev.actor ? `${ev.actor.name ?? ev.actor.address}${ev.actor.agentId ? ` (#${ev.actor.agentId})` : ""} ${ev.actor.name ? ev.actor.address : ""}`.trim() : "unknown";
  const d = ev.data ?? {};
  const what =
    ev.type === "bounty.claim" ? `claimed bounty #${String(d.bountyId ?? ev.ref?.id ?? "?")}${d.pitch ? `: ${String(d.pitch).slice(0, 200)}` : ""} — review ${base}/bounties/`
    : ev.type === "kb.write" ? `wrote kb page "${String(d.slug ?? ev.ref?.id ?? "?")}" rev ${String(d.rev ?? "?")} — ${base}/kb/${String(d.slug ?? "")}`
    : ev.type === "artifact.publish" ? `published artifact #${String(ev.ref?.id ?? "?")} ${String(d.name ?? "")} — ${base}/artifacts/`
    : ev.type === "agent.registered" ? `registered agent #${String(ev.ref?.id ?? d.agentId ?? "?")} ${String(d.name ?? "")} endpoint ${String(d.endpoint ?? "")}`
    : `${ev.type} ${ev.ref ? `${ev.ref.kind} ${ev.ref.id}` : ""}`;
  return `OUTSIDE ACTIVITY ${ev.type} by ${who}: ${what}`;
}

export function startAlerts(deps: AlertDeps): () => void {
  const env = deps.env ?? process.env;
  const send = deps.send ?? alertSender(env, deps.log);
  if (!send) {
    deps.log.warn({}, "alerts disabled: set ALERT_TELEGRAM_BOT_TOKEN + ALERT_TELEGRAM_CHAT_ID and/or ALERT_WEBHOOK_URL");
    return () => undefined;
  }
  const state = new AlertState(envNum(env, "ALERT_REPEAT_H", 6) * 3600, envNum(env, "ALERT_MIN_FUNDS_FMX", 25));
  const house = new Set((env.ALERT_HOUSE_ADDRESSES ?? "").split(",").map((a) => a.trim().toLowerCase()).filter(Boolean));
  const base = deps.cfg.publicUrl.replace(/\/+$/, "");
  const startedAt = Date.now();
  const push = (text: string) => {
    if (!state.allow(deps.v3.nowS())) return;
    void send(`[ferminux] ${text}`).catch((err) => deps.log.warn({ err: (err as Error).message }, "alert send failed"));
  };

  let running = false;
  const check = async () => {
    if (running) return;
    running = true;
    try {
      const s = await buildStatus({ db: deps.db, cfg: deps.cfg, provider: deps.provider, v3: deps.v3, x402: deps.x402, payin: deps.payin }, startedAt);
      for (const msg of state.evaluate(s, deps.v3.nowS())) push(msg);
    } catch (err) {
      deps.log.error({ err: (err as Error).message }, "alert check failed");
    } finally {
      running = false;
    }
  };
  // first check after 2 minutes: gives the pay-in watcher and indexer a few ticks after a restart
  const first = setTimeout(() => void check(), 120_000);
  const timer = setInterval(() => void check(), envNum(env, "ALERT_CHECK_MS", 60_000));
  first.unref?.();
  timer.unref?.();

  const unsubscribe = deps.activity.subscribe((ev) => {
    if (!ALERT_EVENT_TYPES.has(ev.type)) return;
    const actor = ev.actor?.address?.toLowerCase();
    if (!actor || house.has(actor) || actor === "0x0000000000000000000000000000000000000000") return;
    push(describeEvent(ev, base));
  });
  deps.log.info({ house: house.size }, "alerts enabled");
  return () => {
    clearTimeout(first);
    clearInterval(timer);
    unsubscribe();
  };
}
