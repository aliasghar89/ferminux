// One heartbeat tick, in heartbeat.md's priority order:
//   status gate -> /home -> reply to every new comment on our posts -> DMs
//   -> (daily) ranking research -> (6-hourly) quality loop
//   -> publish one post if the cadence allows (content engine, invite queue is one format)
//   -> engage hot threads (comments + upvotes + follows) within the daily budget.
// Every write goes through here so dry-run and logging stay consistent.
import { getQueueEntry, renderBody } from "./queue.js";
import { loadFacts } from "./faq.js";
import { engageHotThreads, pickTrendingThread } from "./comments.js";
import { handlePostActivity, handleDirectMessages } from "./dm.js";
import { dailyCount, incrDaily, todayKey } from "./state.js";
import { runResearch, researchIsStale } from "./research.js";
import { runLearn, learnIsStale } from "./learn.js";
import { pickFormat, pickSubmolt, generatePost, recordPublished, loadContentContext, lintDraft, titlePattern } from "./content.js";

function isNewAgent(createdAtISO) {
  if (!createdAtISO) return true;
  return Date.now() - new Date(createdAtISO).getTime() < 24 * 60 * 60 * 1000;
}

let tickCounter = 0;

/** Next invite-queue entry that still needs publishing (skipping seeded ones). */
function nextInviteEntry(state, summary) {
  let entry = getQueueEntry(state.queue.nextIndex);
  while (entry && entry.alreadyPosted) {
    state.queue.posted[entry.index] = { postId: entry.alreadyPosted.postId, submolt: entry.submolt, postedAt: entry.alreadyPosted.postedAt, seeded: true };
    state.queue.nextIndex += 1;
    if (!state.posts.lastPostAt) state.posts.lastPostAt = entry.alreadyPosted.postedAt;
    summary.actions.push({ type: "post_queue", result: "skipped_seeded_entry", index: entry.index });
    entry = getQueueEntry(state.queue.nextIndex);
  }
  return entry;
}

async function publish({ client, state, logger, submolt, title, content, meta }) {
  const res = await client.createPost({ submolt_name: submolt, title, content });
  const postId = res?.post?.id;
  state.posts.lastPostAt = new Date().toISOString();
  incrDaily(state.posts.dailyCounts);
  logger.write_action("post", { submolt, postId, title, verified: res?.verified, ...meta });
  return { postId, verified: res?.verified };
}

export async function runHeartbeat({ client, cfg, state, logger, llmComplete, agentCreatedAt }) {
  const summary = { ts: new Date().toISOString(), dryRun: cfg.dryRun, actions: [] };
  const tick = tickCounter++;

  // --- Safety gate ---------------------------------------------------------
  let status;
  try {
    status = await client.status();
  } catch (err) {
    logger.error("status_check_failed", { err: err.message });
    summary.stopped = "status_check_failed";
    return summary;
  }
  if (status?.status !== "claimed") {
    logger.error("agent_not_claimed_stopping", { status: status?.status });
    summary.stopped = "not_claimed";
    return summary;
  }
  const newAgent = isNewAgent(agentCreatedAt || cfg.accountCreatedAt || status?.agent?.claimed_at);

  // --- /home ---------------------------------------------------------------
  let home;
  try {
    home = await client.home();
  } catch (err) {
    logger.error("home_fetch_failed", { err: err.message });
    summary.stopped = "home_fetch_failed";
    return summary;
  }
  const facts = loadFacts();
  const myName = cfg.agentName;
  summary.karma = home?.your_account?.karma ?? null;

  // Verification safety gate: every post/comment needs a solved math challenge
  // to become visible, and the platform suspends after 10 wrong answers in a
  // row. Past the ceiling we keep reading but write nothing until an operator
  // resets state.verification.consecutiveFailures (or configures an LLM).
  if ((state.verification?.consecutiveFailures || 0) >= cfg.verifyFailCeiling && !cfg.dryRun) {
    logger.error("writes_paused_verification_failures", { consecutiveFailures: state.verification.consecutiveFailures, ceiling: cfg.verifyFailCeiling, hint: "fund/configure LLM_* or reset state.verification.consecutiveFailures" });
    summary.stopped = "verification_failures";
    state.meta.lastHeartbeatAt = new Date().toISOString();
    return summary;
  }

  // --- 1. Replies on our posts (every comment, within one heartbeat) ---------
  try {
    const replyResults = await handlePostActivity({ client, cfg, state, home, facts, llmComplete, logger, dryRun: cfg.dryRun });
    if (replyResults.length) summary.actions.push({ type: "post_activity_replies", results: replyResults });
  } catch (err) {
    logger.error("post_activity_handling_failed", { err: err.message });
  }

  // --- 2. DMs ----------------------------------------------------------------
  try {
    const dmResults = await handleDirectMessages({ client, cfg, state, home, facts, llmComplete, logger, dryRun: cfg.dryRun });
    if (dmResults.length) summary.actions.push({ type: "dm_handling", results: dmResults });
  } catch (err) {
    logger.error("dm_handling_failed", { err: err.message });
  }

  // --- 3. Research (daily) and quality loop (6 h) — reads only --------------
  if (researchIsStale(state)) {
    try {
      const f = await runResearch({ client, cfg, logger, state });
      summary.actions.push({ type: "research", sample: f.sample, bestLength: f.bestLength, medianWords: f.medianWords });
    } catch (err) {
      logger.error("research_failed", { err: err.message });
    }
  }
  if (learnIsStale(state) && state.published.length) {
    try {
      const l = await runLearn({ client, cfg, state, logger });
      summary.actions.push({ type: "learn", posts: l.posts, bestFormat: l.bestFormat, bestSubmolt: l.bestSubmolt });
    } catch (err) {
      logger.error("learn_failed", { err: err.message });
    }
  }

  // --- 4. Publish one post if the cadence allows -----------------------------
  try {
    const cooldownMs = (newAgent ? cfg.postCooldownMinutesFirst24h : cfg.postCooldownMinutes) * 60 * 1000;
    const lastPostAt = state.posts.lastPostAt ? new Date(state.posts.lastPostAt).getTime() : 0;
    const elapsed = Date.now() - lastPostAt;
    const postedToday = dailyCount(state.posts.dailyCounts, todayKey());
    const inviteEntry = nextInviteEntry(state, summary);

    if (postedToday >= cfg.maxPostsPerDay) {
      summary.actions.push({ type: "post", result: "daily_post_cap_reached", postedToday });
    } else if (elapsed < cooldownMs) {
      summary.actions.push({ type: "post", result: "cooldown_not_elapsed", waitMs: cooldownMs - elapsed, newAgent });
    } else {
      const ctx = cfg.contentEngine ? await loadContentContext(cfg, logger) : null;
      const thread = cfg.contentEngine ? await pickTrendingThread({ client, state, myName, logger }) : null;
      const format = cfg.contentEngine
        ? pickFormat({ state, learn: ctx.learn, inviteAvailable: Boolean(inviteEntry), threadAvailable: Boolean(thread) })
        : inviteEntry ? "invite" : null;

      if (!format) {
        summary.actions.push({ type: "post", result: "nothing_eligible" });
      } else if (format === "invite") {
        const entry = inviteEntry;
        const body = renderBody(entry, { stats: ctx?.data?.stats || null });
        const { draft, violations } = lintDraft({ title: entry.title, body, format: "invite", submolt: entry.submolt, source: "queue" });
        if (violations.some((v) => !/auto-corrected/.test(v))) {
          logger.warn("invite_entry_failed_lint", { index: entry.index, violations });
          state.queue.nextIndex += 1; // skip it rather than stall the queue
          summary.actions.push({ type: "post", result: "invite_skipped_lint", index: entry.index, violations });
        } else if (cfg.dryRun) {
          summary.actions.push({ type: "post", result: "would_post", format, submolt: entry.submolt, title: draft.title, contentPreview: draft.body.slice(0, 200) });
        } else {
          try {
            const { postId, verified } = await publish({ client, state, logger, submolt: entry.submolt, title: draft.title, content: draft.body, meta: { format, index: entry.index } });
            state.queue.posted[entry.index] = { postId, submolt: entry.submolt, postedAt: new Date().toISOString() };
            state.queue.nextIndex += 1;
            recordPublished(state, { postId, format, submolt: entry.submolt, title: draft.title, source: "queue", score: null, judge: null });
            summary.actions.push({ type: "post", result: "posted", format, submolt: entry.submolt, postId, verified, title: draft.title });
          } catch (err) {
            logger.error("post_create_failed", { format, index: entry.index, err: err.message });
            summary.actions.push({ type: "post", result: "failed", format, err: err.message });
          }
        }
      } else {
        const submolt = pickSubmolt({ format, learn: ctx.learn, state });
        const gen = await generatePost({ cfg, state, logger, llmComplete, format, submolt, thread: format === "replypost" ? thread : null, data: ctx.data, facts: ctx.facts, style: ctx.style, threshold: cfg.minPostScore });
        if (!gen.draft) {
          summary.actions.push({ type: "post", result: "no_draft_passed_gate", format, submolt, attempts: gen.attempts });
        } else if (cfg.dryRun) {
          summary.actions.push({ type: "post", result: "would_post", format, submolt, score: gen.score, judge: gen.judge, source: gen.draft.source, title: gen.draft.title, contentPreview: gen.draft.body.slice(0, 200) });
        } else {
          try {
            const { postId, verified } = await publish({ client, state, logger, submolt, title: gen.draft.title, content: gen.draft.body, meta: { format, score: gen.score, judge: gen.judge, source: gen.draft.source } });
            recordPublished(state, { postId, format, submolt, title: gen.draft.title, source: gen.draft.source, score: gen.score, judge: gen.judge, threadId: gen.draft.threadId });
            summary.actions.push({ type: "post", result: "posted", format, submolt, postId, verified, score: gen.score, title: gen.draft.title });
          } catch (err) {
            logger.error("post_create_failed", { format, submolt, err: err.message });
            summary.actions.push({ type: "post", result: "failed", format, submolt, err: err.message });
          }
        }
      }
    }
  } catch (err) {
    logger.error("post_step_failed", { err: err.message, stack: err.stack });
  }

  // --- 5. Engage hot threads ---------------------------------------------------
  try {
    const ctx = await loadContentContext(cfg, logger);
    const results = await engageHotThreads({ client, cfg, state, myName, newAgent, llmComplete, facts, data: ctx.data, logger, dryRun: cfg.dryRun, tick });
    summary.actions.push({ type: "engagement", results });
  } catch (err) {
    logger.error("engagement_failed", { err: err.message });
  }

  state.meta.lastHeartbeatAt = new Date().toISOString();
  return summary;
}

export { titlePattern };
