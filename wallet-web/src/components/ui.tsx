import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import QRCode from 'qrcode';
import { IconCheck, IconClose, IconCopy } from './icons.tsx';
import { noteCopied } from '../lib/secretClipboard.ts';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Dialog: centred on a desktop, a bottom sheet on a phone (styles.css).
 * Focus moves in on open, Tab stays inside, Escape closes, and focus returns
 * to whatever opened it.
 */
export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Wider shell for list-style content (the Accounts panel). */
  wide?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const el = box.current;
    // Focus the dialog itself: a phone keyboard should not pop up unasked.
    el?.focus({ preventScroll: true });
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !box.current) return;
      const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null);
      if (items.length === 0) return;
      const a = items[0]!;
      const z = items[items.length - 1]!;
      if (e.shiftKey && (document.activeElement === a || document.activeElement === box.current)) {
        e.preventDefault();
        z.focus();
      } else if (!e.shiftKey && document.activeElement === z) {
        e.preventDefault();
        a.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, []);

  // Portalled to <body>: a screen's entrance animation must never trap the
  // dialog under the sticky bars.
  return createPortal(
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={box}
        tabIndex={-1}
        className={'modal' + (wide ? ' modal-wide' : '')}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" data-testid="modal-close" aria-label="Close" onClick={onClose}>
            <IconClose />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/** QR rendered locally to a canvas — no network involved. Always dark on white. */
export function QrCanvas({ value, size = 200 }: { value: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!ref.current) return;
    QRCode.toCanvas(ref.current, value, {
      width: size,
      margin: 0,
      color: { dark: '#000000', light: '#ffffff' },
    }).catch(() => setFailed(true));
  }, [value, size]);
  if (failed) return <p className="muted small">QR could not be rendered.</p>;
  return <canvas ref={ref} width={size} height={size} aria-label={`QR code for ${value}`} />;
}

/**
 * Copy to clipboard. `iconOnly` renders a 36 px icon button (the label becomes
 * its accessible name); otherwise a small ghost button with icon and label.
 * `secret` wipes the clipboard again a minute later (lib/secretClipboard.ts).
 */
export function CopyButton({
  text,
  label = 'Copy',
  iconOnly = false,
  secret = false,
}: {
  text: string;
  label?: string;
  iconOnly?: boolean;
  secret?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      noteCopied(text, secret);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard blocked — leave the text selectable instead.
      window.getSelection()?.removeAllRanges();
    }
  };
  if (iconOnly) {
    return (
      <button className={'icon-btn icon-btn-sm' + (copied ? ' copy-flash' : '')} aria-label={copied ? 'Copied' : label} title={label} onClick={() => void onClick()}>
        {copied ? <IconCheck /> : <IconCopy />}
      </button>
    );
  }
  return (
    <button className="btn btn-ghost btn-sm" onClick={() => void onClick()}>
      {copied ? (
        <span className="copy-flash" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <IconCheck /> Copied
        </span>
      ) : (
        <>
          <IconCopy /> {label}
        </>
      )}
    </button>
  );
}

export function Spinner() {
  return <span className="spin" aria-hidden="true" />;
}

export function ProgressBar({ fraction }: { fraction: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  return (
    <div className="progress-track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className="progress-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

/** On/off switch with a visible label. */
export function Switch({
  checked,
  onChange,
  label,
  testId,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  testId?: string;
}) {
  return (
    <label className="switch">
      <input type="checkbox" role="switch" data-testid={testId} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}
