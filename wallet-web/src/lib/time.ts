// Relative time for status lines. Pure.

/** "12s ago", "4m ago", "3h ago", "2d ago", else the ISO date. */
export function ageLabel(thenMs: number, nowMs: number = Date.now()): string {
  const s = Math.max(0, Math.floor((nowMs - thenMs) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(thenMs).toISOString().slice(0, 10);
}
