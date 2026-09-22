import { useEffect, useRef, useState, type ReactNode } from 'react';
import { explorerAddressUrl, explorerTxUrl } from '../config.ts';
import { shortAddress } from '../lib/amounts.ts';

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={'modal' + (wide ? ' modal-wide' : '')} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function Spinner() {
  return <span className="spin" aria-hidden="true" />;
}

export function Skeleton({ width = 80 }: { width?: number | string }) {
  return <span className="skeleton" style={{ width, height: '1em' }} aria-hidden="true" />;
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
          window.getSelection()?.removeAllRanges();
        }
      }}
    >
      {copied ? <span className="copy-flash">Copied</span> : label}
    </button>
  );
}

export function Notice({
  kind = 'plain',
  children,
  role,
}: {
  kind?: 'plain' | 'warn' | 'danger' | 'success';
  children: ReactNode;
  role?: 'alert' | 'status';
}) {
  const cls = kind === 'plain' ? 'notice' : `notice notice-${kind}`;
  return (
    <div className={cls} role={role}>
      {children}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="title">{title}</div>
      {children}
    </div>
  );
}

/** key → value line used throughout the quote and confirmation panels. */
export function StatRow({
  label,
  value,
  hint,
  tone,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: string;
  tone?: 'warn' | 'danger' | 'success';
}) {
  return (
    <div className="stat-row">
      <span className="stat-label" title={hint}>
        {label}
      </span>
      <span className={'stat-value num' + (tone ? ` stat-${tone}` : '')}>{value}</span>
    </div>
  );
}

export function AddressLink({ address, label }: { address: string; label?: string }) {
  return (
    <a className="mono" href={explorerAddressUrl(address)} target="_blank" rel="noreferrer noopener" title={address}>
      {label ?? shortAddress(address)} ↗
    </a>
  );
}

export function TxLink({ hash }: { hash: string }) {
  return (
    <a className="mono" href={explorerTxUrl(hash)} target="_blank" rel="noreferrer noopener" title={hash}>
      {shortAddress(hash, 10, 8)} ↗
    </a>
  );
}

export type TxPhase = { state: 'idle' } | { state: 'signing' } | { state: 'pending'; hash: string } | { state: 'done'; hash: string; message: string } | { state: 'error'; message: string };

/** One consistent place for "signing / pending / done / failed". */
export function TxStatus({ phase, onDismiss }: { phase: TxPhase; onDismiss?: () => void }) {
  if (phase.state === 'idle') return null;
  if (phase.state === 'signing') {
    return (
      <Notice role="status">
        <Spinner /> Waiting for you to confirm in your wallet…
      </Notice>
    );
  }
  if (phase.state === 'pending') {
    return (
      <Notice role="status">
        <Spinner /> Submitted — waiting for a block. <TxLink hash={phase.hash} />
      </Notice>
    );
  }
  if (phase.state === 'done') {
    return (
      <Notice kind="success" role="status">
        {phase.message} <TxLink hash={phase.hash} />
        {onDismiss && (
          <button className="btn btn-ghost btn-sm" style={{ marginLeft: 8 }} onClick={onDismiss}>
            Dismiss
          </button>
        )}
      </Notice>
    );
  }
  return (
    <Notice kind="danger" role="alert">
      {phase.message}
      {onDismiss && (
        <button className="btn btn-ghost btn-sm" style={{ marginLeft: 8 }} onClick={onDismiss}>
          Dismiss
        </button>
      )}
    </Notice>
  );
}
