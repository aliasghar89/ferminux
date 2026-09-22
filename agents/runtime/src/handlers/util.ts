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
