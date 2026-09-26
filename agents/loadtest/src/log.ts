// JSON-lines logger (docker json-file keeps it; compose caps the files). Nothing secret is ever passed to
// it; as a belt-and-braces check it also refuses to print a line containing a registered secret (the seed
// phrase), replacing the line with a warning instead.
export type Level = "debug" | "info" | "warn" | "error";
const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, f?: Record<string, unknown>): void;
  info(msg: string, f?: Record<string, unknown>): void;
  warn(msg: string, f?: Record<string, unknown>): void;
  error(msg: string, f?: Record<string, unknown>): void;
  /** register a string that must never appear in the log */
  secret(s: string): void;
}

const plain = (v: unknown): unknown => (typeof v === "bigint" ? v.toString() : v);

export function makeLogger(level: Level = "info", write: (line: string) => void = (l) => process.stdout.write(l + "\n")): Logger {
  const secrets: string[] = [];
  const emit = (lv: Level, msg: string, f?: Record<string, unknown>) => {
    if (RANK[lv] < RANK[level]) return;
    let line = JSON.stringify({ t: new Date().toISOString(), level: lv, msg, ...f }, (_k, v) => plain(v));
    if (secrets.some((s) => line.includes(s))) line = JSON.stringify({ t: new Date().toISOString(), level: "error", msg: "log line suppressed: it contained secret material" });
    write(line);
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    secret: (s) => {
      if (!s) return;
      secrets.push(s);
      // the first three words alone are distinctive enough to catch a partial leak
      const words = s.split(/\s+/);
      if (words.length >= 12) secrets.push(words.slice(0, 3).join(" "));
    },
  };
}
