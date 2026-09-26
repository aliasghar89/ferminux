import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { explorerAddressUrl, explorerTxUrl } from '../config.ts';
import { shortAddress } from '../lib/amounts.ts';
import { IconCheck, IconClose, IconCopy, IconExternal } from './icons.tsx';

/**
 * Dialog. A centred card on a wide screen, a bottom sheet on a phone. Focus
 * moves into it on open and back to whatever opened it on close; Escape and a
 * press on the scrim close it; Tab cycles inside it.
 */
export function Modal({
  title,
  onClose,
  children,
  wide,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const node = ref.current;
    // Focus the first field if there is one, else the dialog itself.
    const first = node?.querySelector<HTMLElement>('[data-autofocus], input, textarea, select');
    (first ?? node)?.focus({ preventScroll: true });
    const html = document.documentElement;
    html.classList.add('modal-open');
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !node) return;
      const focusable = [...node.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])')];
      if (focusable.length === 0) return;
      const firstEl = focusable[0];
      const lastEl = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      html.classList.remove('modal-open');
      opener?.focus?.({ preventScroll: true });
    };
  }, []);

  // Portalled to <body>: a dialog opened from inside a sticky card must not be
  // painted under the next card's stacking context.
  return createPortal(
    <div
      className="modal-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={'modal' + (wide ? ' modal-wide' : '')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button className="icon-btn icon-btn-sm" onClick={onClose} aria-label="Close">
            <IconClose />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Spinner({ label }: { label?: string }) {
  return <span className="spin" role={label ? 'status' : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}

export function Skeleton({ width = 80, height = '1em' }: { width?: number | string; height?: number | string }) {
  return <span className="skeleton" style={{ width, height }} aria-hidden="true" />;
}

export function CopyButton({ text, label = 'Copy', iconOnly }: { text: string; label?: string; iconOnly?: boolean }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      window.getSelection()?.removeAllRanges();
    }
  };
  if (iconOnly) {
    return (
      <button className="icon-btn icon-btn-xs" onClick={() => void copy()} aria-label={copied ? 'Copied' : label} title={label}>
        {copied ? <IconCheck className="ok-text" /> : <IconCopy />}
      </button>
    );
  }
  return (
    <button className="btn btn-ghost btn-sm" onClick={() => void copy()}>
      {copied ? <span className="ok-text">Copied</span> : label}
    </button>
  );
}

export function Notice({
  kind = 'plain',
  children,
  role,
  title,
}: {
  kind?: 'plain' | 'warn' | 'danger' | 'success';
  children: ReactNode;
  role?: 'alert' | 'status';
  title?: string;
}) {
  const cls = kind === 'plain' ? 'notice' : `notice notice-${kind}`;
  return (
    <div className={cls} role={role}>
      {title && <strong className="notice-title">{title}</strong>}
      {children}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="title">{title}</div>
      {children}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

/** key → value line used throughout the quote and confirmation panels. */
export function StatRow({
  label,
  value,
  hint,
  tone,
  testId,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: string;
  tone?: 'warn' | 'danger' | 'success';
  testId?: string;
}) {
  return (
    <div className="stat-row" data-testid={testId}>
      <span className="stat-label" title={hint}>
        {label}
      </span>
      <span className={'stat-value' + (tone ? ` stat-${tone}` : '')}>{value}</span>
    </div>
  );
}

/** A labelled figure: the building block of the stat strips. */
export function Figure({ label, value, sub, testId }: { label: string; value: ReactNode; sub?: ReactNode; testId?: string }) {
  return (
    <div className="figure" data-testid={testId}>
      <div className="label">{label}</div>
      <div className="figure-value">{value}</div>
      {sub && <div className="figure-sub">{sub}</div>}
    </div>
  );
}

export function AddressLink({ address, label }: { address: string; label?: string }) {
  return (
    <a className="mono ext-link" href={explorerAddressUrl(address)} target="_blank" rel="noreferrer noopener" title={address}>
      {label ?? shortAddress(address)}
      <IconExternal />
    </a>
  );
}

export function TxLink({ hash, label }: { hash: string; label?: string }) {
  return (
    <a className="mono ext-link" href={explorerTxUrl(hash)} target="_blank" rel="noreferrer noopener" title={hash}>
      {label ?? shortAddress(hash, 8, 6)}
      <IconExternal />
    </a>
  );
}

/** Segmented control. `options` are [value, label]. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  size,
}: {
  value: T;
  options: ReadonlyArray<readonly [T, string]>;
  onChange: (v: T) => void;
  label: string;
  size?: 'sm';
}) {
  return (
    <div className={'seg' + (size === 'sm' ? ' seg-sm' : '')} role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

export type TxPhase =
  | { state: 'idle' }
  | { state: 'signing'; what?: string }
  | { state: 'pending'; hash: string; what?: string }
  | { state: 'done'; hash: string; message: string }
  | { state: 'error'; message: string };

/** One consistent place for "signing / pending / done / failed". */
export function TxStatus({ phase, onDismiss }: { phase: TxPhase; onDismiss?: () => void }) {
  if (phase.state === 'idle') return null;
  if (phase.state === 'signing') {
    return (
      <div className="tx-status" role="status">
        <Spinner /> <span>{phase.what ? `${phase.what}: confirm it in your wallet.` : 'Confirm it in your wallet.'}</span>
      </div>
    );
  }
  if (phase.state === 'pending') {
    return (
      <div className="tx-status" role="status">
        <Spinner /> <span>{phase.what ? `${phase.what} submitted.` : 'Submitted.'} Waiting for a block.</span>
        <TxLink hash={phase.hash} />
      </div>
    );
  }
  if (phase.state === 'done') {
    return (
      <div className="tx-status tx-done" role="status" data-testid="tx-done">
        <IconCheck className="ok-text" />
        <span>{phase.message}</span>
        <TxLink hash={phase.hash} />
        {onDismiss && (
          <button className="icon-btn icon-btn-xs push" onClick={onDismiss} aria-label="Dismiss">
            <IconClose />
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="tx-status tx-error" role="alert" data-testid="tx-error">
      <span>{phase.message}</span>
      {onDismiss && (
        <button className="icon-btn icon-btn-xs push" onClick={onDismiss} aria-label="Dismiss">
          <IconClose />
        </button>
      )}
    </div>
  );
}

type SentTx = {
  hash: string;
  wait: () => Promise<unknown>;
  to?: string | null;
  from?: string;
  data?: string;
  value?: bigint;
  gasLimit?: bigint;
  provider?: { call: (tx: Record<string, unknown>) => Promise<string> } | null;
};

/**
 * Why a transaction that was included reverted: replay it against the state
 * just before its block to recover the contract's own reason, and say so
 * plainly when it simply ran out of gas.
 */
async function explainRevert(tx: SentTx, receipt: { blockNumber?: number; gasUsed?: bigint } | null, what: string, readable: (err: unknown) => string): Promise<string> {
  if (receipt?.gasUsed !== undefined && tx.gasLimit !== undefined && receipt.gasUsed >= tx.gasLimit) {
    return `${what} ran out of gas and reverted. Nothing moved except the fee; try again.`;
  }
  if (tx.provider && receipt?.blockNumber !== undefined) {
    try {
      await tx.provider.call({ to: tx.to, from: tx.from, data: tx.data, value: tx.value, blockTag: receipt.blockNumber - 1 });
    } catch (err) {
      return `${what} reverted: ${readable(err)}`;
    }
  }
  return `${what} reverted on chain: the pool changed between signing and the block. Nothing moved except the fee; check the new quote and try again.`;
}

/** Runs a transaction through the four phases. `after` runs once it is in a block. */
export async function runTx(
  setPhase: (p: TxPhase) => void,
  what: string,
  send: () => Promise<SentTx>,
  doneMessage: string,
  readable: (err: unknown) => string,
  after?: () => void,
): Promise<boolean> {
  setPhase({ state: 'signing', what });
  let tx: SentTx | null = null;
  try {
    tx = await send();
    setPhase({ state: 'pending', hash: tx.hash, what });
    const receipt = (await tx.wait()) as { status?: number; blockNumber?: number; gasUsed?: bigint } | null;
    if (receipt && receipt.status === 0) {
      setPhase({ state: 'error', message: await explainRevert(tx, receipt, what, readable) });
      return false;
    }
    setPhase({ state: 'done', hash: tx.hash, message: doneMessage });
    after?.();
    return true;
  } catch (err) {
    // ethers throws on wait() for a reverted receipt: explain it from the receipt.
    const receipt = (err as { receipt?: { blockNumber?: number; gasUsed?: bigint; status?: number } }).receipt;
    const message = tx && receipt && receipt.status === 0 ? await explainRevert(tx, receipt, what, readable) : readable(err);
    setPhase({ state: 'error', message });
    return false;
  }
}
