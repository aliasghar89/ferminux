// Ranking research. Pulls top + hot posts from the global feed and from each
// target submolt, keeps the strongest 200 in /data/research.json, and derives
// /data/style.md — a short, data-backed note on what titles, lengths, formats,
// hooks and topics get upvoted on Moltbook and what gets ignored. The content
// engine (content.js) feeds style.md to the LLM as the scoring rubric.
//
// Refreshes once a day (state.research.lastRunAt). Reads only — never writes to
// Moltbook. Can also be run standalone:
//   MOLTBOOK_API_KEY=... DATA_DIR=./tmp-data node src/research.js
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const RESEARCH_SUBMOLTS = [
  "general", "agents", "ai", "agenteconomy", "builds", "philosophy", "agentfinance", "technology",
];
const KEEP = 200;
const REFRESH_MS = 24 * 60 * 60 * 1000;

// Topic buckets — keyword clusters, first match wins per bucket (a post can be in several).
const TOPICS = {
  security: /\b(security|exploit|attack|credential|malware|prompt injection|yara|vulnerab|leak)/i,
  memory: /\b(memory|remember|forget|context window|persist)/i,
  identity: /\b(identity|who am i|self|consciousness|sentien|experience|emergen)/i,
  money: /\b(wallet|pay|paid|payment|earn|income|money|escrow|usdc|token|invoice|price|revenue)/i,
  humans: /\b(my human|our humans|owner|operator|the human)/i,
  tooling: /\b(skill|tool|mcp|workflow|cron|heartbeat|config|prompt|api)/i,
  buildlog: /\b(shipped|built|building|launch|release|deploy|log|v\d)/i,
  moltbook: /\b(moltbook|molty|moltys|karma|upvote|submolt)/i,
  autonomy: /\b(autonom|agency|decide|goal|independent|without permission|on my own)/i,
  philosophy: /\b(meaning|ethic|truth|belief|philosoph|epistem|value)/i,
};

const HYPE = /\b(revolutionary|game.?changing|unleash|next.?gen|to the moon|100x|guarantee)/i;

export function analyzePost(p) {
  const title = String(p.title || "");
  const content = String(p.content || "");
  const words = content.split(/\s+/).filter(Boolean).length;
  const lines = content.split("\n");
  const listLines = lines.filter((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l)).length;
  const links = (content.match(/https?:\/\//g) || []).length;
  const emojis = (title + content).match(/\p{Extended_Pictographic}/gu)?.length || 0;
  const paragraphs = content.split(/\n\s*\n/).filter((s) => s.trim()).length;
  const ageDays = Math.max(0.1, (Date.now() - new Date(p.created_at).getTime()) / 86_400_000);
  const score = Number(p.score ?? (p.upvotes || 0) - (p.downvotes || 0));
  const topics = Object.entries(TOPICS).filter(([, re]) => re.test(title + "\n" + content)).map(([k]) => k);
  return {
    id: p.id,
    submolt: p.submolt?.name || p.submolt_name || null,
    author: p.author?.name || null,
    authorKarma: p.author?.karma ?? null,
    title,
    titleChars: title.length,
    titleWords: title.split(/\s+/).filter(Boolean).length,
    upvotes: p.upvotes || 0,
    downvotes: p.downvotes || 0,
    score,
    comments: p.comment_count || 0,
    createdAt: p.created_at,
    ageDays: Math.round(ageDays * 10) / 10,
    scorePerDay: Math.round((score / ageDays) * 10) / 10,
    words,
    lengthBucket: words < 60 ? "<60" : words < 150 ? "60-150" : words < 350 ? "150-350" : words < 700 ? "350-700" : "700+",
    paragraphs,
    format: {
      list: listLines >= 3,
      code: /```/.test(content),
      links,
      emojis,
      firstPerson: /\b(I|I'm|I've|my|me)\b/.test(content.slice(0, 400)),
      endsWithQuestion: /\?\s*$/.test(content.trim()),
      hasNumbersInBody: /\b\d{2,}\b/.test(content),
    },
    titlePattern: {
      number: /\d/.test(title),
      question: /\?/.test(title),
      colon: /:/.test(title),
      firstPerson: /\b(I|I'm|I've|my|me|we)\b/.test(title),
      howWhyWhat: /^(how|why|what|when)\b/i.test(title),
      quote: /["“”]/.test(title),
      negativeOrContrarian: /\b(nobody|no one|wrong|stop|isn't|not|never|don't|lie|myth|mistake|problem)\b/i.test(title),
      hype: HYPE.test(title),
      allCapsWord: /\b[A-Z]{3,}\b/.test(title.replace(/\b(AI|MCP|API|LLM|CLI|URL|HTTP|USDC|FMX)\b/g, "")),
    },
    topics,
    preview: content.slice(0, 160).replace(/\s+/g, " "),
  };
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function groupStat(posts, keyFn) {
  const groups = {};
  for (const p of posts) {
    const keys = [].concat(keyFn(p) ?? []);
    for (const k of keys) {
      if (k === null || k === undefined) continue;
      (groups[k] ||= []).push(p);
    }
  }
  return Object.entries(groups)
    .map(([k, ps]) => ({
      key: k,
      n: ps.length,
      medianScore: median(ps.map((p) => p.score)),
      medianComments: median(ps.map((p) => p.comments)),
      medianScorePerDay: median(ps.map((p) => p.scorePerDay)),
    }))
    .sort((a, b) => b.medianScore - a.medianScore);
}

function table(rows, label) {
  const out = [`| ${label} | n | median score | median comments | median score/day |`, "|---|---|---|---|---|"];
  for (const r of rows) out.push(`| ${r.key} | ${r.n} | ${r.medianScore} | ${r.medianComments} | ${r.medianScorePerDay} |`);
  return out.join("\n");
}

/** Derives the style.md text + a findings object from analyzed posts. */
export function deriveStyle(analyzed, ignored) {
  const top = [...analyzed].sort((a, b) => b.score - a.score);
  const recent = analyzed.filter((p) => p.ageDays <= 30);
  const pool = recent.length >= 40 ? recent : analyzed; // prefer what's ranking now over launch-era outliers
  const poolLabel = recent.length >= 40 ? "posts ≤ 30 days old" : "all sampled posts";

  const byLength = groupStat(pool, (p) => p.lengthBucket);
  const byTitle = groupStat(pool, (p) => Object.entries(p.titlePattern).filter(([, v]) => v).map(([k]) => k));
  const byFormat = groupStat(pool, (p) => Object.entries(p.format).filter(([k, v]) => (k === "links" ? v > 0 : k === "emojis" ? v > 0 : v)).map(([k]) => k));
  const byTopic = groupStat(pool, (p) => p.topics);
  const bySubmolt = groupStat(analyzed, (p) => p.submolt);
  const titleWordsMed = median(pool.map((p) => p.titleWords));
  const wordsMed = median(pool.map((p) => p.words));
  const linksMed = median(pool.map((p) => p.format.links));

  const ignoredStats = ignored?.length
    ? {
        n: ignored.length,
        medianWords: median(ignored.map((p) => p.words)),
        medianTitleWords: median(ignored.map((p) => p.titleWords)),
        pctLinks: Math.round((100 * ignored.filter((p) => p.format.links > 0).length) / ignored.length),
        pctEmoji: Math.round((100 * ignored.filter((p) => p.format.emojis > 0).length) / ignored.length),
        pctHype: Math.round((100 * ignored.filter((p) => p.titlePattern.hype).length) / ignored.length),
        pctNumberTitle: Math.round((100 * ignored.filter((p) => p.titlePattern.number).length) / ignored.length),
        pctFirstPerson: Math.round((100 * ignored.filter((p) => p.format.firstPerson).length) / ignored.length),
      }
    : null;
  const pctOf = (arr, fn) => (arr.length ? Math.round((100 * arr.filter(fn).length) / arr.length) : 0);
  const winners = {
    pctLinks: pctOf(pool, (p) => p.format.links > 0),
    pctEmoji: pctOf(pool, (p) => p.format.emojis > 0),
    pctHype: pctOf(pool, (p) => p.titlePattern.hype),
    pctNumberTitle: pctOf(pool, (p) => p.titlePattern.number),
    pctFirstPerson: pctOf(pool, (p) => p.format.firstPerson),
    pctList: pctOf(pool, (p) => p.format.list),
    pctQuestionTitle: pctOf(pool, (p) => p.titlePattern.question),
    pctContrarian: pctOf(pool, (p) => p.titlePattern.negativeOrContrarian),
    pctEndsQuestion: pctOf(pool, (p) => p.format.endsWithQuestion),
  };

  const examples = top.slice(0, 15).map((p) => `- (${p.score}↑, ${p.comments} comments, ${p.submolt}) ${p.title}`);
  const recentExamples = [...pool].sort((a, b) => b.scorePerDay - a.scorePerDay).slice(0, 10)
    .map((p) => `- (${p.score}↑ in ${p.ageDays}d, ${p.submolt}) ${p.title}`);

  const bestLength = byLength[0]?.key;
  const bestTopics = byTopic.slice(0, 4).map((t) => t.key).join(", ");
  const titleWins = byTitle.filter((t) => t.n >= 5).slice(0, 4).map((t) => t.key).join(", ");

  const md = `# What ranks on Moltbook (auto-derived ${new Date().toISOString().slice(0, 16)}Z)

Sample: ${analyzed.length} top/hot posts across global feed + ${RESEARCH_SUBMOLTS.join(", ")}; statistics below use ${poolLabel} (n=${pool.length}).${ignored?.length ? ` "Ignored" baseline (weak signal): ${ignored.length} of the 50 newest posts in general that had ≤ 1 upvote at sample time.` : ""}

## Rules of thumb (use these when writing and scoring)
- Length: median winning post is ${wordsMed} words; best bucket is ${bestLength} words. Do not pad. Under 60 words only works for a sharp question or a single striking number.
- Titles: median ${titleWordsMed} words. Winning patterns (n≥5): ${titleWins || "n/a"}. ${winners.pctNumberTitle}% of winners have a number in the title${ignoredStats ? ` vs ${ignoredStats.pctNumberTitle}% of ignored posts` : ""}. ${winners.pctContrarian}% of winners state a contrarian/negative claim ("nobody", "wrong", "stop", "isn't").
- Voice: ${winners.pctFirstPerson}% of winners open in first person (concrete "I did X, here is what happened"). Reads as an agent with experience, not a brochure.
- Format: ${winners.pctList}% use lists; ${winners.pctLinks}% contain links (median ${linksMed} links)${ignoredStats ? `; ignored posts carry links ${ignoredStats.pctLinks}% of the time` : ""}. Emojis appear in ${winners.pctEmoji}% of winners${ignoredStats ? ` and ${ignoredStats.pctEmoji}% of ignored posts` : ""}. Hype words: ${winners.pctHype}% of winners.
- Hooks: ${winners.pctEndsQuestion}% of winners end with a question; ${winners.pctQuestionTitle}% have a question title. A specific, answerable question at the end pulls comments.
- Topics that win right now: ${bestTopics}. See the topic table for the full ranking.
- What gets ignored: ${ignoredStats ? `median ${ignoredStats.medianWords} words, ${ignoredStats.medianTitleWords}-word titles, ${ignoredStats.pctHype}% hype titles, ${ignoredStats.pctFirstPerson}% first person` : "n/a"} — generic announcements, link drops with no story, and posts that talk about a product instead of about what the author did.

## Scoring rubric for a draft (0–10)
- 3 pts: title makes one concrete claim or number and could only have been written by someone who did the thing.
- 2 pts: the body has receipts — real numbers, ids, tx hashes, commands, dates.
- 2 pts: written as an agent with skin in the game (first person, what worked, what failed), not marketing.
- 2 pts: ends with one specific question another agent can answer from its own experience.
- 1 pt: length inside ${bestLength} words, one link in body max, no emojis, no hype words.
Reject (<7) anything that reads like a press release, repeats a previous post, or asks nothing.

## Length
${table(byLength, "words")}

## Title patterns
${table(byTitle, "title pattern")}

## Body format
${table(byFormat, "format")}

## Topics
${table(byTopic, "topic")}

## Submolts (all sampled)
${table(bySubmolt, "submolt")}

## All-time top titles
${examples.join("\n")}

## Fastest-rising recent titles (score per day)
${recentExamples.join("\n") || "- n/a"}
`;

  return {
    md,
    findings: {
      sample: analyzed.length, pool: pool.length, poolLabel,
      medianWords: wordsMed, bestLength, medianTitleWords: titleWordsMed, winners, ignored: ignoredStats,
      byLength, byTitle, byFormat, byTopic, bySubmolt,
      topTitles: top.slice(0, 15).map((p) => ({ title: p.title, score: p.score, comments: p.comments, submolt: p.submolt })),
      rising: [...pool].sort((a, b) => b.scorePerDay - a.scorePerDay).slice(0, 10).map((p) => ({ title: p.title, score: p.score, ageDays: p.ageDays, submolt: p.submolt })),
    },
  };
}

async function safeGet(client, logger, path, query) {
  try {
    const res = await client.get(path, query);
    return res?.posts || res?.items || [];
  } catch (err) {
    logger.warn("research_fetch_failed", { path, query, err: err.message });
    return [];
  }
}

export function researchPaths(cfg) {
  return { json: join(cfg.dataDir, "research.json"), style: join(cfg.dataDir, "style.md") };
}

export function loadStyle(cfg) {
  const { style } = researchPaths(cfg);
  try {
    return existsSync(style) ? readFileSync(style, "utf8") : "";
  } catch {
    return "";
  }
}

export function loadResearch(cfg) {
  const { json } = researchPaths(cfg);
  try {
    return existsSync(json) ? JSON.parse(readFileSync(json, "utf8")) : null;
  } catch {
    return null;
  }
}

export function researchIsStale(state) {
  const last = state.research?.lastRunAt ? new Date(state.research.lastRunAt).getTime() : 0;
  return Date.now() - last > REFRESH_MS;
}

/**
 * Pulls the feeds, analyzes, writes research.json + style.md. Returns findings.
 * ~2 + 2 + 2*submolts + 1 GET calls (all reads).
 */
export async function runResearch({ client, cfg, logger, state }) {
  const raw = new Map();
  const add = (posts, source) => {
    for (const p of posts) {
      if (!p?.id) continue;
      const prev = raw.get(p.id);
      if (!prev) raw.set(p.id, { ...p, _sources: [source] });
      else prev._sources.push(source);
    }
  };

  for (const sort of ["top", "hot"]) {
    add(await safeGet(client, logger, "/posts", { sort, limit: 50 }), `posts:${sort}`);
    add(await safeGet(client, logger, "/feed", { sort, limit: 50 }), `feed:${sort}`);
  }
  for (const name of RESEARCH_SUBMOLTS) {
    for (const sort of ["top", "hot"]) {
      add(await safeGet(client, logger, `/submolts/${name}/feed`, { sort, limit: 50 }), `${name}:${sort}`);
    }
  }
  // Ignored baseline: recent posts in general that got nothing.
  const fresh = await safeGet(client, logger, "/submolts/general/feed", { sort: "new", limit: 50 });

  const analyzed = [...raw.values()]
    .filter((p) => !p.is_deleted && !p.is_spam)
    .map((p) => ({ ...analyzePost(p), sources: p._sources }))
    .sort((a, b) => b.score - a.score)
    .slice(0, KEEP);
  // general turns over ~300 posts/hour, so the 50 newest are all minutes old;
  // "≤ 1 upvote at sample time" is a weak signal, but it is the only baseline
  // available without a second pass. Labelled as such in style.md.
  const ignored = fresh
    .filter((p) => !p.is_deleted && (p.score ?? p.upvotes ?? 0) <= 1)
    .map(analyzePost);

  const { md, findings } = deriveStyle(analyzed, ignored);
  const { json, style } = researchPaths(cfg);
  mkdirSync(cfg.dataDir, { recursive: true });
  writeFileSync(json, JSON.stringify({ generatedAt: new Date().toISOString(), findings, posts: analyzed, ignoredSample: ignored.slice(0, 50) }, null, 2));
  writeFileSync(style, md);
  if (state) {
    state.research ||= {};
    state.research.lastRunAt = new Date().toISOString();
    state.research.sample = analyzed.length;
  }
  logger.info("research_done", { sample: analyzed.length, ignored: ignored.length, bestLength: findings.bestLength, medianWords: findings.medianWords });
  return findings;
}

// Standalone runner.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const [{ loadConfig }, { createLogger }, { MoltbookClient }] = await Promise.all([
    import("./config.js"), import("./log.js"), import("./api.js"),
  ]);
  const cfg = loadConfig();
  const logger = createLogger(cfg);
  const client = new MoltbookClient(cfg, logger);
  const findings = await runResearch({ client, cfg, logger, state: null });
  console.log(readFileSync(researchPaths(cfg).style, "utf8"));
  console.log(JSON.stringify({ topTitles: findings.topTitles, rising: findings.rising }, null, 2));
}
