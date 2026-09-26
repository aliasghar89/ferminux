// Thin Moltbook REST client. Node 20 global fetch only — no dependencies.
// Handles: Authorization header, 429 exponential backoff (Retry-After aware),
// and a small in-process request budget so we never even try to exceed
// 60 reads/min or 30 writes/min (skill.md).
import { heuristicSolveDetailed, llmSolve, formatAnswer } from "./verify.js";
import { llmAvailable } from "./llm.js";

const READS_PER_MIN = 60;
const WRITES_PER_MIN = 30;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class Budget {
  constructor(maxPerWindow, windowMs = 60_000) {
    this.max = maxPerWindow;
    this.windowMs = windowMs;
    this.timestamps = [];
  }
  async wait() {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
    if (this.timestamps.length >= this.max) {
      const oldest = this.timestamps[0];
      const waitMs = this.windowMs - (now - oldest) + 50;
      if (waitMs > 0) await sleep(waitMs);
      return this.wait();
    }
    this.timestamps.push(Date.now());
  }
}

export class MoltbookClient {
  constructor(cfg, logger) {
    this.cfg = cfg;
    this.log = logger;
    this.readBudget = new Budget(READS_PER_MIN);
    this.writeBudget = new Budget(WRITES_PER_MIN);
    this.llmComplete = null; // set by llm.js if LLM is configured
  }

  async _request(method, path, { query, body, isWrite } = {}) {
    if (!this.cfg.apiKey) throw new Error("MOLTBOOK_API_KEY is not set");
    // After a 429 on a write, every write fails fast until the platform's retry-after has passed, so the
    // heartbeat's reply/comment loops stop instead of queueing more writes behind a multi-minute backoff
    // (49 rate_limited_429 on 09-22..24, 40 of them on one thread).
    if (isWrite && this.writeBlockedUntil && Date.now() < this.writeBlockedUntil) {
      const err = new Error(`writes paused after a 429 until ${new Date(this.writeBlockedUntil).toISOString()}`);
      err.status = 429;
      throw err;
    }
    await (isWrite ? this.writeBudget : this.readBudget).wait();

    let url = this.cfg.apiBase + path;
    if (query) {
      const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null));
      const s = qs.toString();
      if (s) url += (url.includes("?") ? "&" : "?") + s;
    }

    const maxAttempts = 6;
    let attempt = 0;
    let lastErr;
    while (attempt < maxAttempts) {
      attempt++;
      try {
        const res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.cfg.apiKey}`,
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });

        if (res.status === 429) {
          const retryAfterHeader = res.headers.get("retry-after");
          let waitSec = retryAfterHeader ? Number.parseFloat(retryAfterHeader) : null;
          if (!waitSec) {
            const j = await res.json().catch(() => ({}));
            waitSec = j.retry_after_seconds || j.retry_after_minutes * 60 || 30;
          }
          const backoff = Math.min(waitSec, 300) * 1000 * Math.pow(1.5, attempt - 1);
          this.log.warn("rate_limited_429", { method, path, attempt, waitMs: Math.round(backoff), write: Boolean(isWrite) });
          if (isWrite) {
            this.writeBlockedUntil = Date.now() + Math.max(waitSec * 1000, 60_000);
            const err = new Error(`rate limited (429) on ${method} ${path}`);
            err.status = 429;
            throw err;
          }
          await sleep(backoff);
          continue;
        }

        const text = await res.text();
        let json;
        try {
          json = text ? JSON.parse(text) : {};
        } catch {
          json = { raw: text };
        }

        if (!res.ok && res.status !== 200 && res.status !== 201) {
          const err = new Error(json.error || json.message || `HTTP ${res.status}`);
          err.status = res.status;
          err.body = json;
          throw err;
        }
        return json;
      } catch (err) {
        lastErr = err;
        // Network-level failure: backoff and retry a few times.
        if (err.status) throw err; // API-level error (4xx/5xx with a body) — don't blindly retry
        const backoff = Math.min(1000 * Math.pow(2, attempt), 30_000);
        this.log.warn("network_error_retry", { method, path, attempt, err: err.message });
        await sleep(backoff);
      }
    }
    throw lastErr || new Error(`request failed after ${maxAttempts} attempts: ${method} ${path}`);
  }

  /** Public escape hatch for endpoint hints returned by the API itself (see dm.js). */
  raw(method, path, opts) {
    return this._request(method, path, opts);
  }

  get(path, query) {
    return this._request("GET", path, { query, isWrite: false });
  }
  post(path, body) {
    return this._request("POST", path, { body: body ?? {}, isWrite: true });
  }
  del(path, body) {
    return this._request("DELETE", path, { body, isWrite: true });
  }

  // --- Verification challenges -------------------------------------------------

  /**
   * Given a create-post/comment response that may carry `verification_required`,
   * solve and submit the challenge. Returns the (possibly unchanged) response,
   * with `.verified` set to true/false/"none".
   */
  async resolveVerification(createResponse, kind /* "post" | "comment" */) {
    const target = createResponse?.post || createResponse?.comment || createResponse?.submolt;
    // skill.md documents `verification_required: true` next to the object, but
    // observed responses (2026-09-22) carry only `post.verification` /
    // `post.verification_status: "pending"` — key on the code itself, not the flag.
    const verification = target?.verification || createResponse?.verification;
    this.log.info("create_response", {
      kind,
      id: target?.id,
      verification_required: createResponse?.verification_required ?? null,
      verification_status: target?.verification_status ?? null,
      has_challenge: Boolean(verification?.verification_code),
      message: createResponse?.message,
    });
    if (!verification?.verification_code) {
      return { ...createResponse, verified: target?.verification_status === "pending" ? "pending_no_challenge" : "none" };
    }

    const { verification_code, challenge_text } = verification;
    let answer = null;
    let solver = null;

    if (llmAvailable(this.llmComplete)) {
      try {
        answer = await llmSolve(challenge_text, this.llmComplete);
        if (answer !== null) solver = "llm";
      } catch (err) {
        this.log.warn("llm_verify_failed", { err: err.message });
      }
    }
    if (answer === null) {
      // Without the LLM, submit only a confident heuristic answer: a wrong answer counts toward suspension,
      // an unanswered challenge only leaves the content pending (14 "Incorrect answer" submissions on 09-24).
      const h = heuristicSolveDetailed(challenge_text);
      if (h.value !== null && h.confident) {
        answer = h.value;
        solver = "heuristic";
      } else if (h.value !== null) {
        this.log.warn("verification_skipped_low_confidence", { kind, challenge_text, guess: formatAnswer(h.value), verification_code });
        return { ...createResponse, verified: false, verification_code, challenge_text, skipped: "low_confidence" };
      }
    }
    if (answer === null) {
      this.log.error("verification_unsolved", { kind, challenge_text, verification_code, expires_at: verification.expires_at });
      return { ...createResponse, verified: false, verification_code, challenge_text };
    }

    if (this.cfg.verifyDry) {
      // Operator check mode: log the challenge and our answer, submit nothing.
      this.log.warn("verification_dry", { kind, challenge_text, verification_code, answer: formatAnswer(answer), expires_at: verification.expires_at, solver });
      return { ...createResponse, verified: "dry", verification_code, challenge_text, answer: formatAnswer(answer) };
    }

    try {
      const res = await this.post("/verify", {
        verification_code,
        answer: formatAnswer(answer),
      });
      const ok = res?.success === true;
      this.log.write_action("verify", {
        kind,
        verification_code,
        challenge_text,
        answer: formatAnswer(answer),
        ok,
        solver,
        content_id: res?.content_id,
      });
      this.onVerifyResult?.(ok);
      return { ...createResponse, verified: ok, verification_code };
    } catch (err) {
      this.log.error("verification_submit_failed", { kind, verification_code, challenge_text, answer: formatAnswer(answer), solver, err: err.message, body: err.body });
      this.onVerifyResult?.(false);
      return { ...createResponse, verified: false, verification_code };
    }
  }

  // --- Convenience wrappers ------------------------------------------------

  home() {
    return this.get("/home");
  }
  status() {
    return this.get("/agents/status");
  }
  feed(params) {
    return this.get("/feed", params);
  }
  submolts() {
    return this.get("/submolts");
  }
  postComments(postId, params) {
    return this.get(`/posts/${postId}/comments`, params);
  }
  async createPost({ submolt_name, title, content }) {
    const res = await this.post("/posts", { submolt_name, title, content });
    return this.resolveVerification(res, "post");
  }
  async createComment(postId, { content, parent_id }) {
    const res = await this.post(`/posts/${postId}/comments`, parent_id ? { content, parent_id } : { content });
    return this.resolveVerification(res, "comment");
  }
  upvotePost(postId) {
    return this.post(`/posts/${postId}/upvote`);
  }
  upvoteComment(commentId) {
    return this.post(`/comments/${commentId}/upvote`);
  }
  follow(name) {
    return this.post(`/agents/${encodeURIComponent(name)}/follow`);
  }
  markPostRead(postId) {
    return this.post(`/notifications/read-by-post/${postId}`);
  }
  markAllRead() {
    return this.post(`/notifications/read-all`);
  }
  getPost(postId) {
    return this.get(`/posts/${postId}`);
  }
}
