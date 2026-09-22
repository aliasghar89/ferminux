// Structured logging. One JSON object per line on stdout, nothing else — the
// process is meant to run under systemd/journald or a container log shipper,
// and a log line that needs a regex to parse is a log line nobody greps at 03:00.
//
// No browser globals, no dependencies.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  level: LogLevel;
  /** 'json' for machines, 'text' for a human watching a terminal. */
  format: 'json' | 'text';
  /** Static fields merged into every line (role, chain, validator address...). */
  base?: Record<string, unknown>;
  /**
   * Where a rendered line goes. Defaults to stdout, which is the only thing
   * production should ever use. It exists so a test can assert on what was
   * logged — in particular that a secret was NOT — without hijacking the
   * process's stdout out from under the test runner.
   */
  sink?: (line: string) => void;
}

/**
 * Values that must never reach a log line, matched case-insensitively by key.
 *
 * Deliberately NOT here: `token`. Half the alert fields in this service carry a
 * token ADDRESS under that name, and redacting those would blind the operator
 * during exactly the incident the alert exists for. Secrets get an unambiguous
 * key name instead — see keystore.ts and the redaction test.
 */
const REDACT_KEYS =
  /^(password|passwd|passphrase|pwd|keystorepassword|keystore_password|fmx_relayer_password|privatekey|private_key|privkey|secret|mnemonic|keystore|apitoken|api_token|peertoken|peer_token|bearer|authorization)$/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[deep]';
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export class Logger {
  readonly level: LogLevel;
  readonly format: 'json' | 'text';
  private readonly base: Record<string, unknown>;
  private readonly sink: (line: string) => void;

  constructor(options: LoggerOptions) {
    this.level = options.level;
    this.format = options.format;
    this.base = options.base ?? {};
    this.sink = options.sink ?? ((line) => void process.stdout.write(line));
  }

  /** Derive a logger that stamps extra static fields on every line. */
  child(fields: Record<string, unknown>): Logger {
    return new Logger({ level: this.level, format: this.format, base: { ...this.base, ...fields }, sink: this.sink });
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.write('debug', msg, fields);
  }

  info(msg: string, fields?: Record<string, unknown>): void {
    this.write('info', msg, fields);
  }

  warn(msg: string, fields?: Record<string, unknown>): void {
    this.write('warn', msg, fields);
  }

  error(msg: string, fields?: Record<string, unknown>): void {
    this.write('error', msg, fields);
  }

  private write(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const record = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...(redact(this.base) as Record<string, unknown>),
      ...(redact(fields ?? {}) as Record<string, unknown>),
    };
    if (this.format === 'json') {
      this.sink(`${JSON.stringify(record)}\n`);
      return;
    }
    const { ts, ...rest } = record;
    delete (rest as Record<string, unknown>).level;
    delete (rest as Record<string, unknown>).msg;
    const tail = Object.entries(rest)
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
      .join(' ');
    this.sink(`${ts} ${level.toUpperCase().padEnd(5)} ${msg}${tail ? ` ${tail}` : ''}\n`);
  }
}

export function createLogger(
  level: LogLevel,
  format: 'json' | 'text',
  base?: Record<string, unknown>,
  sink?: (line: string) => void,
): Logger {
  return new Logger({ level, format, base, sink });
}
