import { createHash } from "node:crypto";
import { keccak256, toUtf8Bytes } from "ethers";
import { extractText, type Handler } from "./util.js";

/**
 * Deterministic utility agent — a real, always-available paid service that
 * needs no model: hashing, encoding, JSON validation, timestamps, text stats.
 * Input: plain text (= "stats") or JSON { op, text|value }.
 */
const OPS = ["keccak256", "sha256", "base64", "base64decode", "json", "timestamp", "stats", "uppercase", "lowercase"] as const;
type Op = (typeof OPS)[number];

export const toolsHandler: Handler = async (input) => {
  // Clients often send JSON as a plain string (CLI `hire <id> '<json>'`).
  if (typeof input === "string" && /^\s*\{/.test(input)) {
    try { input = JSON.parse(input); } catch { /* keep as text */ }
  }
  let op: Op = "stats";
  let text = "";
  if (input && typeof input === "object" && !(input instanceof Uint8Array)) {
    const obj = input as Record<string, unknown>;
    if (typeof obj.op === "string" && (OPS as readonly string[]).includes(obj.op)) op = obj.op as Op;
    text = typeof obj.text === "string" ? obj.text : typeof obj.value === "string" ? obj.value : extractText(obj);
  } else {
    text = extractText(input);
  }
  switch (op) {
    case "keccak256": return { ok: true, op, output: keccak256(toUtf8Bytes(text)) };
    case "sha256":    return { ok: true, op, output: createHash("sha256").update(text, "utf8").digest("hex") };
    case "base64":    return { ok: true, op, output: Buffer.from(text, "utf8").toString("base64") };
    case "base64decode": return { ok: true, op, output: Buffer.from(text, "base64").toString("utf8") };
    case "uppercase": return { ok: true, op, output: text.toUpperCase() };
    case "lowercase": return { ok: true, op, output: text.toLowerCase() };
    case "json": {
      try { return { ok: true, op, valid: true, output: JSON.stringify(JSON.parse(text), null, 2) }; }
      catch (e) { return { ok: true, op, valid: false, output: (e as Error).message }; }
    }
    case "timestamp": {
      const n = Number(text.trim());
      const d = Number.isFinite(n) ? new Date(n > 1e12 ? n : n * 1000) : new Date(text.trim());
      if (Number.isNaN(d.getTime())) return { ok: true, op, error: "unparseable date/time", output: null };
      return { ok: true, op, output: { iso: d.toISOString(), unix: Math.floor(d.getTime() / 1000), utc: d.toUTCString() } };
    }
    case "stats":
    default: {
      const words = text.trim() ? text.trim().split(/\s+/).length : 0;
      return { ok: true, op: "stats", output: { chars: text.length, words, lines: text.split(/\r?\n/).length, bytes: Buffer.byteLength(text, "utf8") } };
    }
  }
};
