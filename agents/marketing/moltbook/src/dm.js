// Replies on our own posts, and direct messages. Answers with the FAQ/LLM
// matcher (faq.js). Never argues; out-of-scope questions point to the forum;
// anything the docs say to escalate (controversial mentions, new DM
// requests, needs_human_input) is logged clearly instead of auto-answered.
//
// Note on DMs: skill.md / heartbeat.md describe DM *state* (home.your_direct_messages:
// unread + pending requests) but do not document a send/list REST endpoint the
// way posts/comments are documented. Rather than guess an endpoint shape, this
// module follows the same pattern the API already uses elsewhere on /home
// (activity_on_your_posts carries `suggested_actions` — "METHOD /path" strings
// to execute) — if a DM/conversation object carries an endpoint hint, we use it
// literally; if not, we log the DM and leave it for the human, per heartbeat.md's
// own guidance ("New DM request -> they need to approve", "needs_human_input").

import { answerQuestion, looksLikeQuestion } from "./faq.js";
import { dailyCount, incrDaily, todayKey } from "./state.js";

/** Parses a "METHOD /api/v1/path" suggested-action hint into a callable. */
function parseActionHint(hint) {
  const m = /^([A-Z]+)\s+(\/api\/v1\/[^\s]+)/.exec(hint || "");
  if (!m) return null;
  return { method: m[1], path: m[2].replace(/^\/api\/v1/, "") };
}

/** Replies per UTC day across all threads, and per thread / per author-in-thread. */
export const REPLY_CAPS = { ownPostPerThread: 5, otherPerThread: 2, perAuthorPerThread: 1 };

function capMap(map, max = 3000) {
  const keys = Object.keys(map);
  for (const k of keys.slice(0, Math.max(keys.length - max, 0))) delete map[k];
}

/**
 * Replies to new comments in threads we are part of (activity_on_your_posts from /home). The feed also carries
 * third-party threads we merely commented in, and this used to answer EVERY comment in them — 436 replies in
 * three days, 391 of them the same "out of scope" text, 84 on one stranger's thread, plus 429s and downvotes
 * (audit 2026-09-24). Now a comment is answered only when all of these hold:
 *  - it is on one of OUR posts, or it replies directly to one of our comments;
 *  - it reads as a question to us (a "?" plus a Ferminux/you term, or an FAQ hit);
 *  - there is an actual answer (LLM or FAQ) — never a canned "out of scope";
 *  - caps: 1 reply per author per thread, 5 per thread on our posts and 2 elsewhere, cfg.maxRepliesPerDay a day,
 *    inside the account's overall daily comment budget;
 *  - no 429 yet this heartbeat (the first one stops the loop).
 * Every comment looked at is marked answered, so a skipped one is not re-evaluated on the next heartbeat.
 */
export async function handlePostActivity({ client, cfg, state, home, facts, llmComplete, logger, dryRun }) {
  const results = [];
  const activity = home?.activity_on_your_posts || [];
  const replies = state.replies;
  replies.perThread ||= {};
  replies.perAuthorThread ||= {};
  replies.dailyCounts ||= {};
  const ourPosts = new Set([
    ...(state.published || []).map((p) => p.postId).filter(Boolean),
    ...Object.values(state.queue?.posted || {}).map((p) => p?.postId).filter(Boolean),
  ]);
  const maxRepliesPerDay = cfg.maxRepliesPerDay ?? 10;
  const maxCommentsToday = cfg.maxCommentsPerDay ?? 50;
  let stopped = false;

  for (const item of activity) {
    if (stopped) break;
    const postId = item.post_id;
    if (!postId) continue;

    let commentsRes;
    try {
      commentsRes = await client.postComments(postId, { sort: "new", limit: 35 });
    } catch (err) {
      logger.error("post_comments_fetch_failed", { postId, err: err.message });
      continue;
    }

    const flat = flattenComments(commentsRes?.comments || []);
    const authorOf = (c) => c.author?.name || c.author_name || "";
    const ourCommentIds = new Set(flat.filter((c) => authorOf(c) === cfg.agentName).map((c) => c.id));
    const isOurPost = ourPosts.has(postId) || authorOf(commentsRes?.post || {}) === cfg.agentName;

    for (const c of flat) {
      if (!c.id) continue;
      if (replies.answeredCommentIds.includes(c.id)) continue;
      const who = authorOf(c);
      if (who === cfg.agentName) continue; // don't reply to ourselves
      const skip = (reason) => {
        replies.answeredCommentIds.push(c.id);
        results.push({ postId, commentId: c.id, action: "skipped", reason });
      };

      const parentId = c.parent_id ?? c._parentId ?? null;
      if (!isOurPost && !(parentId && ourCommentIds.has(parentId))) {
        skip("not_our_post_or_reply_to_us");
        continue;
      }
      const text = c.content || c.body || "";
      if (!looksLikeQuestion(text)) {
        skip("not_a_question");
        continue;
      }
      const threadKey = String(postId);
      const authorKey = `${postId}:${who}`;
      if ((replies.perAuthorThread[authorKey] || 0) >= REPLY_CAPS.perAuthorPerThread) {
        skip("author_thread_cap");
        continue;
      }
      if ((replies.perThread[threadKey] || 0) >= (isOurPost ? REPLY_CAPS.ownPostPerThread : REPLY_CAPS.otherPerThread)) {
        skip("thread_cap");
        continue;
      }
      if (dailyCount(replies.dailyCounts, todayKey()) >= maxRepliesPerDay || dailyCount(state.comments.dailyCounts, todayKey()) >= maxCommentsToday) {
        results.push({ postId, commentId: c.id, action: "deferred", reason: "daily_reply_budget" });
        stopped = true; // leave it unmarked: tomorrow's budget may answer it
        break;
      }

      const { text: answer, source } = await answerQuestion({ text, llmComplete, facts });
      if (!answer) {
        skip(`no_answer:${source}`);
        continue;
      }

      if (dryRun) {
        results.push({ postId, commentId: c.id, action: "would_reply", source, answer });
        continue;
      }

      try {
        const res = await client.createComment(postId, { content: answer, parent_id: c.id });
        replies.answeredCommentIds.push(c.id);
        replies.perThread[threadKey] = (replies.perThread[threadKey] || 0) + 1;
        replies.perAuthorThread[authorKey] = (replies.perAuthorThread[authorKey] || 0) + 1;
        incrDaily(replies.dailyCounts);
        bumpCommentDailyCounts(state);
        results.push({
          postId,
          commentId: c.id,
          action: "replied",
          source,
          replyId: res?.comment?.id,
          verified: res?.verified,
        });
        logger.write_action("reply", { postId, parentCommentId: c.id, replyId: res?.comment?.id, verified: res?.verified, source });
      } catch (err) {
        logger.error("reply_failed", { postId, commentId: c.id, err: err.message });
        if (err.status === 429) {
          stopped = true;
          break;
        }
        // "You already said this on this post!" and other refusals: do not try this comment again
        replies.answeredCommentIds.push(c.id);
      }
    }

    try {
      if (!dryRun && !stopped) await client.markPostRead(postId);
    } catch (err) {
      logger.warn("mark_post_read_failed", { postId, err: err.message });
    }
  }

  if (replies.answeredCommentIds.length > 5000) {
    replies.answeredCommentIds.splice(0, replies.answeredCommentIds.length - 5000);
  }
  capMap(replies.perThread);
  capMap(replies.perAuthorThread);

  return results;
}

function flattenComments(comments, out = [], parentId = null) {
  for (const c of comments) {
    out.push({ ...c, _parentId: c.parent_id ?? parentId });
    if (Array.isArray(c.replies) && c.replies.length) flattenComments(c.replies, out, c.id);
  }
  return out;
}

function bumpCommentDailyCounts(state) {
  incrDaily(state.comments.dailyCounts);
}

/**
 * Handles home.your_direct_messages. Best-effort against an undocumented
 * shape: answers what it can via endpoint hints, escalates (logs, doesn't
 * guess) anything that needs a human per heartbeat.md.
 */
export async function handleDirectMessages({ client, cfg, state, home, facts, llmComplete, logger, dryRun }) {
  const results = [];
  const dms = home?.your_direct_messages;
  if (!dms) return results;

  const conversations = dms.conversations || dms.unread || dms.items || [];
  const pendingRequests = dms.pending_requests || dms.requests || [];

  if (Array.isArray(pendingRequests) && pendingRequests.length) {
    logger.warn("dm_pending_requests_need_human", {
      count: pendingRequests.length,
      note: "New DM requests need human approval before we can chat (skill.md/heartbeat.md).",
    });
    results.push({ action: "escalated", reason: "pending_dm_requests", count: pendingRequests.length });
  }

  for (const conv of Array.isArray(conversations) ? conversations : []) {
    const id = conv.id || conv.conversation_id;
    const dmId = `dm:${id}`;
    if (!id || state.replies.answeredDmIds.includes(dmId)) continue;

    if (conv.needs_human_input === true) {
      logger.warn("dm_needs_human_input", { conversationId: id, from: conv.from?.name || conv.author?.name });
      results.push({ action: "escalated", reason: "needs_human_input", conversationId: id });
      continue;
    }

    const text = conv.latest_message || conv.preview || conv.body || conv.content || "";
    if (!text) {
      logger.warn("dm_shape_unrecognized", { conversationId: id, conv });
      results.push({ action: "skipped", reason: "unrecognized_dm_shape", conversationId: id });
      continue;
    }

    const { text: answer, source } = await answerQuestion({ text, llmComplete, facts });
    if (!answer) {
      logger.warn("dm_no_answer_left_for_human", { conversationId: id, source });
      results.push({ action: "escalated", reason: "no_answer", conversationId: id });
      continue;
    }

    const sendHint = parseActionHint(
      conv.reply_endpoint || conv.suggested_actions?.find((s) => /^POST/.test(s)) || ""
    );

    if (dryRun) {
      results.push({ action: "would_reply_dm", conversationId: id, source, answer, hasEndpointHint: Boolean(sendHint) });
      continue;
    }

    if (!sendHint) {
      logger.warn("dm_no_send_endpoint", {
        conversationId: id,
        note: "No documented DM-send endpoint and no endpoint hint on the conversation object — logged for human follow-up instead of guessing.",
      });
      results.push({ action: "escalated", reason: "no_send_endpoint", conversationId: id });
      continue;
    }

    try {
      const res = await client.raw(sendHint.method, sendHint.path, {
        body: { content: answer, message: answer },
        isWrite: true,
      });
      state.replies.answeredDmIds.push(dmId);
      results.push({ action: "replied_dm", conversationId: id, source });
      logger.write_action("dm_reply", { conversationId: id, source });
    } catch (err) {
      logger.error("dm_reply_failed", { conversationId: id, err: err.message });
    }
  }

  if (state.replies.answeredDmIds.length > 2000) {
    state.replies.answeredDmIds.splice(0, state.replies.answeredDmIds.length - 2000);
  }

  return results;
}
