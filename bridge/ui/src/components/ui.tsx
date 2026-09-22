import { useEffect, useRef, useState, type ReactNode } from 'react';

export function Spinner() {
  return <span className="spin" aria-hidden="true" />;
}

export function Skeleton({ width = 80 }: { width?: number | string }) {
  return (
    <span className="skeleton" style={{ width }} aria-hidden="true">
      &nbsp;
    </span>
  );
}

export function ProgressBar({ fraction, tone = 'normal' }: { fraction: number; tone?: 'normal' | 'done' | 'fail' }) {
  const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  return (
    <div className="progress-track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className={`progress-fill${tone === 'done' ? ' done' : tone === 'fail' ? ' fail' : ''}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Badge({ kind = 'default', children }: { kind?: 'default' | 'canonical' | 'wrapped' | 'ok' | 'bad' | 'wait'; children: ReactNode }) {
  const cls = kind === 'default' ? '' : ` badge-${kind}`;
  return <span className={`badge${cls}`}>{children}</span>;
}

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children} ↗
    </a>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <button
      className="btn btn-ghost btn-sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1600);
        } catch {
          // Clipboard blocked — the text stays selectable on the page.
        }
      }}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

/** Trim noisy provider/RPC error strings down to something actionable. */
export function shortenError(message: string): string {
  const cut = message.split(/\s*\(action=|\s*\[ See:|\s*\(reason=/)[0];
  return cut.length > 220 ? `${cut.slice(0, 220)}…` : cut;
}
