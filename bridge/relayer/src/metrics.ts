// Prometheus text-format metrics. No client library: the exposition format is
// four lines of code and a dependency here is a dependency in the process that
// holds the signing key.

export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly help = new Map<string, string>();
  readonly startedAt = Date.now();

  describe(name: string, help: string): void {
    this.help.set(name, help);
  }

  inc(name: string, labels: Record<string, string | number> = {}, by = 1): void {
    const key = seriesKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  set(name: string, value: number, labels: Record<string, string | number> = {}): void {
    this.gauges.set(seriesKey(name, labels), value);
  }

  /** Prometheus exposition text. */
  render(): string {
    const lines: string[] = [];
    const emitted = new Set<string>();
    const emit = (map: Map<string, number>, type: string): void => {
      for (const [key, value] of [...map.entries()].sort()) {
        const name = key.split('{')[0] as string;
        if (!emitted.has(name)) {
          emitted.add(name);
          const help = this.help.get(name);
          if (help) lines.push(`# HELP ${name} ${help}`);
          lines.push(`# TYPE ${name} ${type}`);
        }
        lines.push(`${key} ${value}`);
      }
    };
    emit(this.counters, 'counter');
    emit(this.gauges, 'gauge');
    return `${lines.join('\n')}\n`;
  }
}

function seriesKey(name: string, labels: Record<string, string | number>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return name;
  const rendered = entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${String(v).replace(/["\\\n]/g, '_')}"`)
    .join(',');
  return `${name}{${rendered}}`;
}
