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

import { answerQuestion } from "./faq.js";
import { incrDaily } from "./state.js";

/** Parses a "METHOD /api/v1/path" suggested-action hint into a callable. */
function parseActionHint(hint) {
  const m = /^([A-Z]+)\s+(\/api\/v1\/[^\s]+)/.exec(hint || "");
  if (!m) return null;
  return { method: m[1], path: m[2].replace(/^\/api\/v1/, "") };
}

/**
 * Replies to new comments on our own posts (activity_on_your_posts from /home).
 * Returns a list of planned/executed reply actions for logging.
 */
export async function handlePostActivity({ client, cfg, state, home, facts, llmComplete, logger, dryRun }) {
  const results = [];
  const activity = home?.activity_on_your_posts || [];

  for (const item of activity) {
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
    for (const c of flat) {
      if (!c.id) continue;
      if (state.replies.answeredCommentIds.includes(c.id)) continue;
      if ((c.author?.name || c.author_name) === cfg.agentName) continue; // don't reply to ourselves

      const text = c.content || c.body || "";
      const { text: answer, source } = await answerQuestion({ text, llmComplete, facts });

      if (dryRun) {
        results.push({ postId, commentId: c.id, action: "would_reply", source, answer });
        continue;
      }

      try {
        const res = await client.createComment(postId, { content: answer, parent_id: c.id });
        state.replies.answeredCommentIds.push(c.id);
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
      }
    }

    try {
      if (!dryRun) await client.markPostRead(postId);
    } catch (err) {
      logger.warn("mark_post_read_failed", { postId, err: err.message });
    }
  }

  if (state.replies.answeredCommentIds.length > 5000) {
    state.replies.answeredCommentIds.splice(0, state.replies.answeredCommentIds.length - 5000);
  }

  return results;
}

function flattenComments(comments, out = []) {
  for (const c of comments) {
    out.push(c);
    if (Array.isArray(c.replies) && c.replies.length) flattenComments(c.replies, out);
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
