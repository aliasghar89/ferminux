import { useRef, useState } from 'react';
import type { AccountsApi } from '../state/useAccounts.ts';
import type { BalancesApi } from '../state/useBalances.ts';
import type { PortfolioApi } from '../state/usePortfolio.ts';
import { balanceOf, isTotalComplete, totalBalance } from '../lib/balances.ts';
import { NATIVE_SYMBOL } from '../config.ts';
import { CHAINS, FERMINUX_CHAIN, explorerAddressUrl } from '../lib/chains.ts';
import { formatAmount, formatAmountExact, shortAddress } from '../lib/validate.ts';
import type { AssetRef } from '../lib/portfolio.ts';
import { loadViewPrefs, saveViewPrefs, type ViewPrefs } from '../state/storage.ts';
import { CopyButton, QrCanvas } from '../components/ui.tsx';
import { IconExternal, IconReceive, IconScan, IconSend, IconShield, IconAlert, IconUsers } from '../components/icons.tsx';
import { fmxMark } from '../components/Brand.tsx';
import { AssetsPanel } from './AssetsPanel.tsx';
import { useLockMs } from './prefs.ts';
import { Here } from '../platform/words.ts';

/** Long figures step down a size so a big balance never breaks mid-number on a phone. */
export function fitClass(text: string): string {
  return text.length > 15 ? ' balance-xl' : text.length > 12 ? ' balance-l' : '';
}

export function HomeScreen({
  api,
  balances,
  portfolio,
  onSend,
  onReceive,
  onScan,
  onOpenAsset,
  onManageAccounts,
}: {
  api: AccountsApi;
  balances: BalancesApi;
  portfolio: PortfolioApi;
  onSend: () => void;
  onReceive: () => void;
  onScan: () => void;
  onOpenAsset: (a: AssetRef) => void;
  onManageAccounts: () => void;
}) {
  const active = api.active;
  const balance = balanceOf(balances.snapshot, active.address);
  const total = totalBalance(balances.snapshot, api.addresses);
  const totalExact = isTotalComplete(balances.snapshot, api.addresses);
  const [prefs, setPrefs] = useState<ViewPrefs>(() => loadViewPrefs());
  const assetsRef = useRef<HTMLElement>(null);
  const lockMs = useLockMs();

  const updatePrefs = (next: Partial<ViewPrefs>) => {
    const merged = { ...prefs, ...next };
    setPrefs(merged);
    saveViewPrefs(merged);
  };

  // Which networks this account holds anything on, from the last good reading.
  const held = new Set<number>();
  const down = new Set<number>();
  for (const c of CHAINS) {
    const r = portfolio.lastGood.get(c.id);
    if (r && [...r.balances.values()].some((v) => v > 0n)) held.add(c.id);
    const l = portfolio.latest.get(c.id);
    if (l && !l.ok) down.add(c.id);
  }
  const heldNames = CHAINS.filter((c) => held.has(c.id)).map((c) => c.name);

  const showChain = (id: number | null) => {
    updatePrefs({ chainFilter: id });
    assetsRef.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  };

  return (
    <div className="home-grid">
      <div style={{ minWidth: 0 }}>
        <section className="hero" aria-label="Balance">
          <div className="hero-top">
            <span className="addr-chip" data-testid="active-address" data-address={active.address} title={active.address}>
              {shortAddress(active.address)}
            </span>
            <CopyButton text={active.address} label="Copy address" iconOnly />
            {active.backup === 'none' && (
              <span className="dir-badge dir-fail" title={`${Here()} holds the only copy of this key. Export a keystore from Accounts.`}>
                NO BACKUP
              </span>
            )}
            <span className="push" />
            <button
              className="btn btn-ghost btn-sm hero-accounts"
              data-testid="home-manage"
              onClick={onManageAccounts}
              aria-label="Accounts"
              title="Add, import, rename, export or remove accounts"
            >
              <IconUsers /> <span className="hero-accounts-label">Accounts</span>
            </button>
          </div>

          <div className="hero-label">
            <img src={fmxMark} alt="" width={14} height={14} />
            <span className="label">FMX on Ferminux</span>
          </div>
          {balance === null ? (
            <span className="skeleton balance-figure" aria-label="Loading balance">
              0.000000
            </span>
          ) : (
            <div className={'balance-figure' + fitClass(formatAmount(balance))} data-testid="active-balance" title={`${formatAmountExact(balance)} ${NATIVE_SYMBOL}`}>
              {formatAmount(balance)}
              <span className="balance-unit">{NATIVE_SYMBOL}</span>
            </div>
          )}
          {balances.stale && balance !== null && <div className="stale-note">Last known value — the network is unreachable.</div>}

          <div className="hero-sub">
            {api.accounts.length > 1 && (
              <button className="total-inline" data-testid="total-inline" onClick={onManageAccounts}>
                <span>Total across {api.accounts.length} accounts</span>
                <span className="num" title={`${formatAmountExact(total)} ${NATIVE_SYMBOL}`}>
                  {totalExact ? '' : '≥ '}
                  {formatAmount(total)} {NATIVE_SYMBOL}
                </span>
              </button>
            )}
            <button className="total-inline" data-testid="other-networks" onClick={() => showChain(null)}>
              {heldNames.length === 0
                ? `One address on ${CHAINS.length} networks`
                : heldNames.length === 1
                  ? `Holding assets on ${heldNames[0]}`
                  : `Holding assets on ${heldNames.length} of ${CHAINS.length} networks`}
            </button>
          </div>

          <div className="hero-actions">
            <button className="btn btn-primary" data-testid="send-open" onClick={onSend}>
              <IconSend /> Send
            </button>
            <button className="btn" data-testid="receive-open" onClick={onReceive}>
              <IconReceive /> Receive
            </button>
            <button className="btn" data-testid="home-scan" onClick={onScan}>
              <IconScan /> Scan
            </button>
          </div>
        </section>

        <section className="section" ref={assetsRef} aria-label="Assets" style={{ scrollMarginTop: 72 }}>
          <AssetsPanel portfolio={portfolio} prefs={prefs} onPrefs={updatePrefs} onOpen={onOpenAsset} onRefresh={balances.refresh} held={held} down={down} />
        </section>
      </div>

      <aside className="home-rail" aria-label="Account">
        <RailAddress address={active.address} onReceive={onReceive} />
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="panel-body">
            <div className="label" style={{ marginBottom: 12 }}>
              Security
            </div>
            <div className="holder-line" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
              {api.remembered ? <IconShield /> : <IconAlert />}
              <span>
                {api.remembered
                  ? 'Encrypted on this device. One password unlocks every account.'
                  : 'Session only: nothing is stored, so locking forgets these keys.'}
              </span>
            </div>
            <div className="holder-line" style={{ marginTop: 10 }}>
              <span>Locks after {Math.round(lockMs / 60_000)} min idle.</span>
            </div>
            {api.accounts.some((a) => a.backup === 'none') && (
              <div className="holder-line" style={{ marginTop: 10, color: 'var(--warn)' }}>
                <span>
                  {api.accounts.filter((a) => a.backup === 'none').length} account(s) have no backup. Export a keystore from
                  Accounts.
                </span>
              </div>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}

/** Desktop rail: this account's address as a scannable code. */
function RailAddress({ address, onReceive }: { address: string; onReceive: () => void }) {
  return (
    <div className="panel rail-address">
      <div className="panel-body" style={{ display: 'grid', gap: 12 }}>
        <div className="label">Your address</div>
        <div className="qr-frame" style={{ margin: 0 }}>
          <QrCanvas value={address} size={148} />
        </div>
        <div className="mono small" style={{ wordBreak: 'break-all', color: 'var(--ink)', lineHeight: 1.55 }}>
          {address}
        </div>
        <div className="small faint">The same address on all {CHAINS.length} networks.</div>
        <div className="actions-row" style={{ gap: 4 }}>
          <CopyButton text={address} label="Copy" />
          <a className="btn btn-ghost btn-sm" href={explorerAddressUrl(FERMINUX_CHAIN, address)} target="_blank" rel="noreferrer noopener">
            Explorer <IconExternal />
          </a>
          <span className="push" />
          <button className="btn btn-ghost btn-sm" onClick={onReceive}>
            Request
          </button>
        </div>
      </div>
    </div>
  );
}

