// Persistent JSON state under /data. Tracks the post queue cursor, per-day
// counters (comments, follows), which posts/comments we've already replied
// to, and DM/notification bookkeeping — so a restarted container resumes
// safely without re-doing (or skipping) anything.
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

function defaultState() {
  return {
    version: 1,
    // Index into the post queue (queue.js). 0 = "Ferminux: a chain where agents
    // register..." in agenteconomy, already published before this bot existed —
    // seeded as done in index.js on first run so it's never re-posted.
    queue: {
      nextIndex: 0,
      posted: {}, // { [index]: { postId, submolt, postedAt } }
    },
    posts: {
      lastPostAt: null, // ISO string; used with the platform's post cooldown
      dailyCounts: {}, // posts per UTC day (MAX_POSTS_PER_DAY)
    },
    // Content engine bookkeeping (content.js).
    content: {
      lastFormats: [],
      formatDailyCounts: {}, // { [day]: { [format]: n } }
      submoltDailyCounts: {}, // { [day]: { [submolt]: n } }
      usedTitles: [],
      publishedHashes: [], // sha256 of normalised title+body of every post we published (dedupe)
      replyAuthors: {}, // { [thread author]: ISO time of our last reply-as-post to them }
      repliedThreadIds: [], // threads already answered with a reply-as-post
      templateCursor: {}, // { [format]: nextVariantIndex }
      lastBountyDigestAt: null,
    },
    // Every post this bot published: { postId, format, submolt, title, source, score, postedAt, titlePattern, lastScore, lastComments }
    published: [],
    research: { lastRunAt: null, sample: 0 },
    verification: { consecutiveFailures: 0, total: 0, ok: 0 },
    learn: { lastRunAt: null },
    comments: {
      seenPostIds: [], // posts we've already decided about (commented or skipped) — cap to bound memory
      lastCommentAt: null,
      dailyCounts: {}, // ALL comment-type writes (outreach + replies) — checked against the platform's hard 50/20 per-day limit
      outreachDailyCounts: {}, // just the allowlisted outreach comments (task's own stricter 8/4 cap)
    },
    follows: {
      followedNames: [],
      dailyCounts: {},
    },
    upvotes: {
      postedIds: [],
    },
    replies: {
      // For replies/DMs we've already answered, keyed by comment id / dm id.
      answeredCommentIds: [],
      answeredDmIds: [],
      perThread: {}, // { [postId]: replies we posted there }
      perAuthorThread: {}, // { ["postId:author"]: replies to that author there }
      dailyCounts: {}, // replies per UTC day
    },
    notifications: {
      lastReadAt: null,
    },
    meta: {
      lastHeartbeatAt: null,
      createdAt: new Date().toISOString(),
    },
  };
}

function mergeDefaults(loaded) {
  const base = defaultState();
  return {
    ...base,
    ...loaded,
    queue: { ...base.queue, ...loaded.queue, posted: { ...base.queue.posted, ...loaded.queue?.posted } },
    posts: { ...base.posts, ...loaded.posts },
    content: { ...base.content, ...loaded.content },
    published: Array.isArray(loaded.published) ? loaded.published : base.published,
    research: { ...base.research, ...loaded.research },
    verification: { ...base.verification, ...loaded.verification },
    learn: { ...base.learn, ...loaded.learn },
    comments: { ...base.comments, ...loaded.comments },
    follows: { ...base.follows, ...loaded.follows },
    upvotes: { ...base.upvotes, ...loaded.upvotes },
    replies: { ...base.replies, ...loaded.replies },
    notifications: { ...base.notifications, ...loaded.notifications },
    meta: { ...base.meta, ...loaded.meta },
  };
}

export function loadState(cfg) {
  const path = cfg.statePath || join(cfg.dataDir, "state.json");
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, "utf8");
      return { path, data: mergeDefaults(JSON.parse(raw)) };
    } catch (err) {
      console.error(`state file at ${path} is unreadable/corrupt (${err?.message ?? err}); starting fresh`);
    }
  }
  return { path, data: defaultState() };
}

export function saveState(path, data) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    // Write to a temp file then swap in, so a crash mid-write never corrupts state.
    const tmp = path + ".tmp";
    const json = JSON.stringify(data, null, 2);
    writeFileSync(tmp, json);
    writeFileSync(path, json);
    try {
      unlinkSync(tmp);
    } catch {
      // ignore — not fatal
    }
  } catch (err) {
    console.error(`failed to save state to ${path}:`, err?.message ?? err);
  }
}

export function todayKey(d = new Date()) {
  return d.toISOString().slice(0, 10); // UTC date, e.g. 2026-09-22
}

export function dailyCount(counts, key = todayKey()) {
  return counts[key] || 0;
}

export function incrDaily(counts, key = todayKey()) {
  counts[key] = (counts[key] || 0) + 1;
  // prune old days so the file doesn't grow forever
  const keys = Object.keys(counts).sort();
  while (keys.length > 30) {
    delete counts[keys.shift()];
  }
  return counts[key];
}
