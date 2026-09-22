// Quality loop. Every 6 h, re-fetch every post we published (state.published),
// record upvotes/comments, and aggregate by format, submolt and title pattern
// into /data/learn.json. The content engine reads it as bandit weights
// (80 % best, 20 % explore). Scores are age-normalized: a post's raw score is
// divided by min(ageHours, 48)/48 so a 2-hour-old post with 5 upvotes counts
// like a 48-hour-old post with ~120 — otherwise old posts always "win".
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const REFRESH_MS = 6 * 60 * 60 * 1000;
const NORMALIZE_HOURS = 48;

export function learnPath(cfg) {
  return join(cfg.dataDir, "learn.json");
}

export function loadLearn(cfg) {
  try {
    const p = learnPath(cfg);
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
  } catch {
    return null;
  }
}

export function learnIsStale(state) {
  const last = state.learn?.lastRunAt ? new Date(state.learn.lastRunAt).getTime() : 0;
  return Date.now() - last > REFRESH_MS;
}

function aggregate(rows, keyFn) {
  const groups = {};
  for (const r of rows) {
    const k = keyFn(r);
    if (!k) continue;
    (groups[k] ||= []).push(r);
  }
  const out = {};
  for (const [k, rs] of Object.entries(groups)) {
    const mean = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0);
    out[k] = {
      n: rs.length,
      meanScore: Math.round(mean(rs.map((r) => r.normScore)) * 100) / 100,
      meanRaw: Math.round(mean(rs.map((r) => r.score)) * 100) / 100,
      meanComments: Math.round(mean(rs.map((r) => r.comments)) * 100) / 100,
      best: rs.reduce((b, r) => (r.score > (b?.score ?? -Infinity) ? r : b), null)?.title || null,
    };
  }
  return out;
}

/**
 * Refreshes metrics for our published posts and writes learn.json. Reads only
 * (GET /posts/:id per post; capped at 60 per run to stay inside the read budget).
 */
export async function runLearn({ client, cfg, state, logger }) {
  const posts = [...state.published].slice(-60);
  const rows = [];
  for (const p of posts) {
    if (!p.postId) continue;
    try {
      const res = await client.getPost(p.postId);
      const post = res?.post || res;
      const score = Number(post?.score ?? (post?.upvotes || 0) - (post?.downvotes || 0));
      const comments = Number(post?.comment_count || 0);
      const ageHours = Math.max(0.25, (Date.now() - new Date(p.postedAt).getTime()) / 3_600_000);
      const norm = score / (Math.min(ageHours, NORMALIZE_HOURS) / NORMALIZE_HOURS);
      const row = { ...p, score, comments, ageHours: Math.round(ageHours * 10) / 10, normScore: Math.round(norm * 100) / 100, removed: Boolean(post?.is_deleted || post?.is_spam) || ["pending", "failed"].includes(post?.verification_status), verification: post?.verification_status || null };
      rows.push(row);
      p.lastScore = score;
      p.lastComments = comments;
      p.lastCheckedAt = new Date().toISOString();
      if (row.removed) p.removed = true;
    } catch (err) {
      logger.warn("learn_fetch_failed", { postId: p.postId, err: err.message });
      if (err.status === 404) p.removed = true;
    }
  }
  const scored = rows.filter((r) => !r.removed);
  const overallMean = scored.length ? scored.reduce((s, r) => s + r.normScore, 0) / scored.length : 0;
  const learn = {
    updatedAt: new Date().toISOString(),
    posts: rows.length,
    removed: rows.filter((r) => r.removed).length,
    overallMean: Math.round(overallMean * 100) / 100,
    byFormat: aggregate(scored, (r) => r.format),
    bySubmolt: aggregate(scored, (r) => r.submolt),
    byTitlePattern: aggregate(scored, (r) => r.titlePattern),
    bySource: aggregate(scored, (r) => r.source),
    top: [...scored].sort((a, b) => b.normScore - a.normScore).slice(0, 10).map((r) => ({ title: r.title, format: r.format, submolt: r.submolt, score: r.score, comments: r.comments, ageHours: r.ageHours })),
    bottom: [...scored].sort((a, b) => a.normScore - b.normScore).slice(0, 5).map((r) => ({ title: r.title, format: r.format, submolt: r.submolt, score: r.score, comments: r.comments, ageHours: r.ageHours })),
  };
  const best = Object.entries(learn.byFormat).filter(([, v]) => v.n >= 2).sort((a, b) => b[1].meanScore - a[1].meanScore)[0];
  learn.bestFormat = best ? best[0] : null;
  const bestSub = Object.entries(learn.bySubmolt).filter(([, v]) => v.n >= 2).sort((a, b) => b[1].meanScore - a[1].meanScore)[0];
  learn.bestSubmolt = bestSub ? bestSub[0] : null;

  try {
    mkdirSync(cfg.dataDir, { recursive: true });
    writeFileSync(learnPath(cfg), JSON.stringify(learn, null, 2));
  } catch (err) {
    logger.warn("learn_write_failed", { err: err.message });
  }
  state.learn ||= {};
  state.learn.lastRunAt = new Date().toISOString();
  logger.info("learn_done", { posts: rows.length, removed: learn.removed, bestFormat: learn.bestFormat, bestSubmolt: learn.bestSubmolt, overallMean: learn.overallMean });
  return learn;
}
