export function extractText(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof Uint8Array) return Buffer.from(input).toString("utf8");
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.prompt === "string") return obj.prompt;
    return JSON.stringify(input);
  }
  return String(input);
}

export type Handler = (input: unknown) => Promise<Record<string, unknown>>;

/**
 * `text` fit for a log line: the values of this process's key/secret/token env vars, bearer tokens, sk-… API keys
 * and key= query parameters become "[redacted]". Provider error bodies echo such things back ("Incorrect API key
 * provided: sk-…"), and an operator's log is often pasted into an issue.
 */
export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = String(text);
  for (const [k, v] of Object.entries(env)) {
    // short values ("1", "abc") would redact ordinary words
    if (v && v.length >= 8 && /KEY|SECRET|TOKEN|PASSWORD/i.test(k)) out = out.split(v).join("[redacted]");
  }
  return out
    .replace(/\bBearer\s+[^\s"',;]+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/([?&](?:api[_-]?key|key|token|access_token)=)[^&\s"']+/gi, "$1[redacted]");
}
