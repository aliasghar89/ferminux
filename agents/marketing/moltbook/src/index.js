#!/usr/bin/env node
// Entrypoint. Loads config/state, runs one heartbeat immediately, then loops
// every HEARTBEAT_MINUTES (default 10) unless MOLTBOOK_RUN_ONCE=1 (used by
// `npm run once`, and by the operator for the manual test runs described in
// README.md). PAUSED=1 skips all writes without exiting (still checks in so
// state/logs keep moving and the operator can flip it off without restarting
// the container); DRY_RUN=1 plans everything but performs no writes at all.
import { loadConfig } from "./config.js";
import { createLogger } from "./log.js";
import { loadState, saveState } from "./state.js";
import { MoltbookClient } from "./api.js";
import { makeLlmComplete } from "./llm.js";
import { runHeartbeat } from "./heartbeat.js";

async function main() {
  const cfg = loadConfig();
  const logger = createLogger(cfg);

  if (!cfg.apiKey) {
    logger.error("missing_api_key", { hint: "Set MOLTBOOK_API_KEY (see secrets/moltbook.env.example)" });
    process.exit(1);
  }

  logger.info("startup", {
    dryRun: cfg.dryRun,
    paused: cfg.paused,
    llmEnabled: cfg.llmEnabled,
    contentEngine: cfg.contentEngine,
    heartbeatMinutes: cfg.heartbeatMinutes,
    maxPostsPerDay: cfg.maxPostsPerDay,
    dataDir: cfg.dataDir,
  });

  const { path: statePath, data: state } = loadState(cfg);
  const client = new MoltbookClient(cfg, logger);
  const llmComplete = makeLlmComplete(cfg, logger);
  client.llmComplete = llmComplete; // used for verification-challenge solving too
  client.onVerifyResult = (ok) => {
    state.verification.total += 1;
    if (ok) {
      state.verification.ok += 1;
      state.verification.consecutiveFailures = 0;
    } else {
      state.verification.consecutiveFailures += 1;
      logger.warn("verification_failure_streak", { consecutiveFailures: state.verification.consecutiveFailures, ceiling: cfg.verifyFailCeiling });
    }
  };

  // Fetch our own creation date once at startup (used to decide new-agent vs
  // established caps/cooldowns); falls back to /agents/status's claimed_at.
  let agentCreatedAt = null;
  try {
    const me = await client.get("/agents/me");
    agentCreatedAt = me?.agent?.created_at || null;
  } catch (err) {
    logger.warn("agents_me_fetch_failed_at_startup", { err: err.message });
  }
  if (!agentCreatedAt) agentCreatedAt = cfg.accountCreatedAt;

  async function tick() {
    if (cfg.paused) {
      logger.info("paused_skip_tick");
      state.meta.lastHeartbeatAt = new Date().toISOString();
      saveState(statePath, state);
      return;
    }
    try {
      const summary = await runHeartbeat({ client, cfg, state, logger, llmComplete, agentCreatedAt });
      logger.info("heartbeat_done", { stopped: summary.stopped, actionCount: summary.actions.length, actions: summary.actions });
      saveState(statePath, state);
      if (summary.stopped === "not_claimed") {
        logger.error("stopping_process_not_claimed");
        process.exit(1);
      }
    } catch (err) {
      logger.error("heartbeat_crashed", { err: err.message, stack: err.stack });
      saveState(statePath, state);
    }
  }

  await tick();

  if (cfg.runOnce) {
    logger.info("run_once_complete_exiting");
    return;
  }

  const intervalMs = cfg.heartbeatMinutes * 60 * 1000;
  setInterval(tick, intervalMs);
  logger.info("looping", { intervalMs });
}

main().catch((err) => {
  console.error("fatal:", err?.stack || err);
  process.exit(1);
});
