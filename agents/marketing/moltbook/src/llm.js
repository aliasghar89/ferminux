// Minimal OpenAI-compatible chat completion client (fetch only, no SDK).
// Used for (a) solving verification challenges and (b) generating FAQ replies
// when LLM_BASE_URL + LLM_API_KEY + LLM_MODEL are all set. Falls back to
// nothing usable if not configured — callers check cfg.llmEnabled first.

export function makeLlmComplete(cfg, logger) {
  if (!cfg.llmEnabled) return null;

  const base = cfg.llmBaseUrl.replace(/\/+$/, "");
  const url = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;

  return async function llmComplete(system, user, { maxTokens = 300, temperature = 0.2 } = {}) {
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
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`LLM request failed: HTTP ${res.status} ${text.slice(0, 300)}`);
    }
    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content;
    if (!content) throw new Error("LLM response had no content");
    return content.trim();
  };
}
