// Env parsing for the moltbook bot. No deps — reads process.env directly.

function bool(v, def = false) {
  if (v === undefined || v === null || v === "") return def;
  return v === "1" || v.toLowerCase() === "true";
}

function int(v, def) {
  if (v === undefined || v === null || v === "") return def;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

export function loadConfig(env = process.env) {
  const apiKey = env.MOLTBOOK_API_KEY || "";
  const cfg = {
    apiBase: env.MOLTBOOK_API_BASE || "https://www.moltbook.com/api/v1",
    apiKey,
    agentName: env.MOLTBOOK_AGENT_NAME || "ferminux",

    dataDir: env.DATA_DIR || "/data",
    heartbeatMinutes: int(env.HEARTBEAT_MINUTES, 10),

    // The account's creation time decides the first-24h limits (skill.md). Used
    // when GET /agents/me is unavailable at startup.
    accountCreatedAt: env.MOLTBOOK_ACCOUNT_CREATED_AT || "2026-09-21T22:01:43.162Z",

    dryRun: bool(env.DRY_RUN, false),
    // 1 = create content normally but log verification challenges + our answer
    // instead of submitting (operator check of the solver; content stays hidden).
    verifyDry: bool(env.VERIFY_DRY, false),
    // Consecutive wrong /verify answers before the bot stops writing (platform
    // auto-suspends at 10). Reset by deleting state.verification.consecutiveFailures.
    verifyFailCeiling: int(env.VERIFY_FAIL_CEILING, 4),
    paused: bool(env.PAUSED, false),
    runOnce: bool(env.MOLTBOOK_RUN_ONCE, false),

    // Cadence. Posts run at the platform ceiling (1/30 min established, 1/2 h in
    // the first 24 h) unless MAX_POSTS_PER_DAY says otherwise. Comments run to
    // the platform's daily cap (50; 20 first 24 h) with slots reserved for
    // replies on our own posts, paced across the UTC day. The platform's own
    // per-minute limits (skill.md) are enforced separately in api.js.
    maxPostsPerDay: int(env.MAX_POSTS_PER_DAY, 48),
    postCooldownMinutes: int(env.POST_COOLDOWN_MINUTES, 30),
    postCooldownMinutesFirst24h: int(env.POST_COOLDOWN_MINUTES_FIRST_24H, 120),
    maxCommentsPerDay: int(env.MAX_COMMENTS_PER_DAY, 50),
    maxCommentsPerDayFirst24h: int(env.MAX_COMMENTS_PER_DAY_FIRST_24H, 20),
    reservedReplySlots: int(env.RESERVED_REPLY_SLOTS, 5),
    // replies in threads (dm.js) per UTC day — they used to be uncapped (436 in three days)
    maxRepliesPerDay: int(env.MAX_REPLIES_PER_DAY, 10),
    // with no working LLM every post comes from templates: post far less, so the same few are not recycled
    maxPostsPerDayNoLlm: int(env.MAX_POSTS_PER_DAY_NO_LLM, 4),
    maxCommentsPerTick: int(env.MAX_COMMENTS_PER_TICK, 3),
    commentBurst: int(env.COMMENT_BURST, 4),
    maxFollowsPerDay: int(env.MAX_FOLLOWS_PER_DAY, 20),
    // Publish threshold for the content engine's 0–10 quality score.
    minPostScore: int(env.MIN_POST_SCORE, 7),
    // Set to 0 to disable the content engine and only run the curated invite queue.
    contentEngine: bool(env.CONTENT_ENGINE, true),

    // Ferminux content sources.
    ferminuxBase: env.FERMINUX_BASE || "https://ferminux.net",
    llmsTxtUrl: env.FERMINUX_LLMS_TXT_URL || "https://ferminux.net/llms.txt",
    statsUrl: env.FERMINUX_STATS_URL || "https://ferminux.net/api/stats",
    skillUrl: env.FERMINUX_SKILL_URL || "https://ferminux.net/skills/ferminux/SKILL.md",
    mcpInstallCmd:
      env.FERMINUX_MCP_INSTALL_CMD ||
      "npx -y -p https://ferminux.net/downloads/ferminux-sdk.tgz ferminux-mcp",
    // Build-log sources: git repo (local runs) or content/changelog.md (container).
    repoDir: env.FERMINUX_REPO_DIR || "",
    changelogPath: env.FERMINUX_CHANGELOG_PATH || "",

    // Optional LLM for FAQ replies / verification-challenge solving. All three required to use it.
    llmBaseUrl: env.LLM_BASE_URL || "",
    llmApiKey: env.LLM_API_KEY || "",
    llmModel: env.LLM_MODEL || "",

    logPath: env.MOLTBOOK_LOG_PATH || "", // resolved against dataDir in log.js if empty
    statePath: env.MOLTBOOK_STATE_PATH || "", // resolved against dataDir in state.js if empty
  };
  cfg.llmEnabled = Boolean(cfg.llmBaseUrl && cfg.llmApiKey && cfg.llmModel);
  return cfg;
}
