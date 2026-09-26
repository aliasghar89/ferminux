// Minimal OpenAI-compatible chat completion client (fetch only, no SDK).
// Used for (a) solving verification challenges and (b) generating FAQ replies
// when LLM_BASE_URL + LLM_API_KEY + LLM_MODEL are all set. Falls back to
// nothing usable if not configured — callers check cfg.llmEnabled first.

// Circuit breaker: when the provider says the key is out of credit or invalid (HTTP 402 / 401 / 403), every
// later call in the same state fails the same way. From 2026-09-22 the DeepSeek key returned 402 "Insufficient
// Balance" on every call (≈400 failed calls logged) while the bot kept falling back to worse paths. After such
// an answer the client stays off for LLM_BACKOFF_HOURS (default 6) and callers see `available() === false`.
const KEY_FAILURE = new Set([401, 402, 403]);

export function makeLlmComplete(cfg, logger) {
  if (!cfg.llmEnabled) return null;

  const base = cfg.llmBaseUrl.replace(/\/+$/, "");
  const url = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
  const backoffMs = (Number(process.env.LLM_BACKOFF_HOURS) > 0 ? Number(process.env.LLM_BACKOFF_HOURS) : 6) * 3_600_000;
  let disabledUntil = 0;
  let disabledReason = "";

  async function llmComplete(system, user, { maxTokens = 300, temperature = 0.2 } = {}) {
    if (Date.now() < disabledUntil) throw new Error(`LLM disabled until ${new Date(disabledUntil).toISOString()} (${disabledReason})`);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.llmApiKey}`,
      },
      body: JSON.stringify({
        model: cfg.llmModel,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: maxTokens,
        temperature,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (KEY_FAILURE.has(res.status)) {
        disabledUntil = Date.now() + backoffMs;
        disabledReason = `HTTP ${res.status} ${text.slice(0, 120)}`;
        logger?.error?.("llm_disabled", { status: res.status, until: new Date(disabledUntil).toISOString(), hint: "top up / replace LLM_API_KEY (or point LLM_BASE_URL at a funded OpenAI-compatible endpoint)" });
      }
      throw new Error(`LLM request failed: HTTP ${res.status} ${text.slice(0, 300)}`);
    }
    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content;
    if (!content) throw new Error("LLM response had no content");
    return content.trim();
  }
  /** false while the circuit breaker is open — callers skip LLM-only paths instead of failing each time */
  llmComplete.available = () => Date.now() >= disabledUntil;
  return llmComplete;
}

/** True when an LLM is configured and not switched off by the circuit breaker. */
export function llmAvailable(llmComplete) {
  return Boolean(llmComplete) && (typeof llmComplete.available !== "function" || llmComplete.available());
}
