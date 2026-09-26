#!/usr/bin/env node
// Operator CLI for the content engine (no heartbeat, no writes unless `publish`).
//   node src/cli.js research                      # refresh /data/research.json + style.md (reads only)
//   node src/cli.js draft <format> [submolt]      # generate + lint + score one draft, print it
//   node src/cli.js drafts [n]                    # n drafts across formats (default 3)
//   node src/cli.js learn                         # refresh /data/learn.json
//   node src/cli.js publish <format> [submolt]    # generate, gate, and publish ONE post (respects cooldown unless FORCE=1)
// Env: MOLTBOOK_API_KEY, DATA_DIR, LLM_* (optional).
import { loadConfig } from "./config.js";
import { createLogger } from "./log.js";
import { loadState, saveState } from "./state.js";
import { MoltbookClient } from "./api.js";
import { makeLlmComplete } from "./llm.js";
import { runResearch } from "./research.js";
import { runLearn } from "./learn.js";
import { FORMATS, generatePost, loadContentContext, pickSubmolt, recordPublished } from "./content.js";
import { publish } from "./heartbeat.js";
import { pickTrendingThread } from "./comments.js";
import { dailyCount, incrDaily, todayKey } from "./state.js";

const cfg = loadConfig();
const logger = createLogger({ ...cfg, logPath: cfg.logPath || `${cfg.dataDir}/cli-log.jsonl` });
const client = new MoltbookClient(cfg, logger);
const llmComplete = makeLlmComplete(cfg, logger);
client.llmComplete = llmComplete;
const { path: statePath, data: state } = loadState(cfg);
const [cmd, a1, a2] = process.argv.slice(2);

async function draftOne(format, submoltArg) {
  const ctx = await loadContentContext(cfg, logger);
  const thread = format === "replypost" ? await pickTrendingThread({ client, state, myName: cfg.agentName, logger }) : null;
  const submolt = submoltArg || pickSubmolt({ format, learn: ctx.learn, state });
  const gen = await generatePost({ cfg, state, logger, llmComplete, format, submolt, thread, data: ctx.data, facts: ctx.facts, style: ctx.style, threshold: cfg.minPostScore });
  return { gen, submolt, thread };
}

function show(format, submolt, gen) {
  console.log(`\n==== ${format} -> ${submolt} | score ${gen.score} (${gen.judge}) | attempts ${JSON.stringify(gen.attempts)}`);
  if (!gen.draft) {
    console.log("NO DRAFT PASSED THE GATE. Rejected:", gen.rejected.map((r) => ({ score: r.score, reasons: r.reasons, title: r.title })));
    return;
  }
  console.log("TITLE:", gen.draft.title);
  console.log("SOURCE:", gen.draft.source, "| words:", gen.draft.words, "| reasons:", gen.reasons);
  console.log("----\n" + gen.draft.body + "\n----");
}

if (cmd === "research") {
  const f = await runResearch({ client, cfg, logger, state });
  saveState(statePath, state);
  console.log(JSON.stringify({ sample: f.sample, medianWords: f.medianWords, bestLength: f.bestLength, winners: f.winners, ignored: f.ignored, rising: f.rising.slice(0, 5) }, null, 2));
} else if (cmd === "draft") {
  const format = a1 || "opinion";
  if (!FORMATS.includes(format)) throw new Error(`unknown format ${format}`);
  const { gen, submolt } = await draftOne(format, a2);
  show(format, submolt, gen);
} else if (cmd === "drafts") {
  const n = Number(a1 || 3);
  const order = ["data", "opinion", "buildlog", "tutorial", "replypost", "bounties"];
  for (let i = 0; i < n; i++) {
    const format = order[i % order.length];
    const { gen, submolt } = await draftOne(format);
    show(format, submolt, gen);
  }
} else if (cmd === "learn") {
  const l = await runLearn({ client, cfg, state, logger });
  saveState(statePath, state);
  console.log(JSON.stringify(l, null, 2));
} else if (cmd === "publish") {
  const format = a1 || "opinion";
  const cooldownMs = cfg.postCooldownMinutes * 60 * 1000;
  const last = state.posts.lastPostAt ? new Date(state.posts.lastPostAt).getTime() : 0;
  if (Date.now() - last < cooldownMs && process.env.FORCE !== "1") {
    console.log("cooldown not elapsed; waitMs", cooldownMs - (Date.now() - last));
    process.exit(2);
  }
  const { gen, submolt } = await draftOne(format, a2);
  show(format, submolt, gen);
  if (!gen.draft) process.exit(3);
  if (cfg.dryRun) {
    console.log("DRY_RUN=1: not publishing");
  } else {
    // same duplicate detection as the heartbeat (heartbeat.js publish): a repeat is not counted as a post
    const res = await publish({ client, state, logger, submolt, title: gen.draft.title, content: gen.draft.body, meta: { format, score: gen.score, cli: true } });
    const postId = res.postId;
    if (res.duplicate) {
      saveState(statePath, state);
      console.log("DUPLICATE — not published again", { postId: postId ?? null, title: gen.draft.title });
      process.exit(4);
    }
    recordPublished(state, { postId, format, submolt, title: gen.draft.title, source: gen.draft.source, score: gen.score, judge: gen.judge, threadId: gen.draft.threadId, threadAuthor: gen.draft.threadAuthor });
    saveState(statePath, state);
    console.log("PUBLISHED", { postId, verified: res.verified, url: `https://www.moltbook.com/post/${postId}`, postedToday: dailyCount(state.posts.dailyCounts, todayKey()) });
  }
} else {
  console.log("usage: node src/cli.js research | draft <format> [submolt] | drafts [n] | learn | publish <format> [submolt]");
  process.exit(1);
}
