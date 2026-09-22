// Append-only JSONL logger. Never logs secrets (the API key is never passed in).
import { mkdirSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function createLogger(cfg) {
  const path = cfg.logPath || join(cfg.dataDir, "log.jsonl");
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // best effort; fall through to console-only logging if /data isn't writable
  }

  function write(entry) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    try {
      appendFileSync(path, line + "\n");
    } catch (err) {
      console.error("log write failed:", err?.message ?? err);
    }
    console.log(line);
  }

  return {
    info: (msg, extra = {}) => write({ level: "info", msg, ...extra }),
    warn: (msg, extra = {}) => write({ level: "warn", msg, ...extra }),
    error: (msg, extra = {}) => write({ level: "error", msg, ...extra }),
    // Dedicated helper for anything that writes to Moltbook — always carries an id.
    write_action: (action, extra = {}) => write({ level: "write", action, ...extra }),
  };
}
