import type { ReactNode } from 'react';
import type { ChainState } from '../App.tsx';
import type { AccountsApi } from '../state/useAccounts.ts';
import type { BalancesApi } from '../state/useBalances.ts';
import { CHAIN_ID, EXPLORER_URL } from '../config.ts';
import { formatGwei } from '../lib/validate.ts';
import { Brand } from '../components/Brand.tsx';
import { IconActivity, IconExternal, IconGrid, IconHome, IconLink, IconLock, IconSettings } from '../components/icons.tsx';
import { AccountSwitcher } from './AccountSwitcher.tsx';
import type { TopRoute } from './router.ts';

function statusDot(chain: ChainState): string {
  return 'dot ' + (chain.status === 'ok' ? 'dot-ok' : chain.status === 'error' ? 'dot-bad' : 'dot-wait');
}

function statusText(chain: ChainState): string {
  return chain.status === 'ok' ? `Ferminux · ${CHAIN_ID}` : chain.status === 'error' ? 'RPC unreachable' : 'Connecting…';
}

/** Every Ferminux RPC endpoint failed: said once, at the top of any screen. */
export function RpcNotice({ chain }: { chain: ChainState }) {
  if (chain.status !== 'error') return null;
  return (
    <div className="notice notice-danger" role="alert" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <span style={{ flex: '1 1 220px' }}>Cannot reach any Ferminux RPC endpoint. Retrying automatically…</span>
      <button className="btn btn-sm" onClick={chain.retry}>
        Retry now
      </button>
    </div>
  );
}

/** Onboarding and unlock: brand, network state, one centred column. */
export function GateFrame({ chain, banner, children }: { chain: ChainState; banner?: ReactNode; children: ReactNode }) {
  return (
    <div className="gate">
      <header className="gate-top">
        <Brand />
        <span className="push" />
        <span className="net-pill" title={chain.rpcUrl ?? 'not connected'}>
          <span className={statusDot(chain)} />
          <span className="net-label">{statusText(chain)}</span>
        </span>
      </header>
      <main className="gate-main" id="main">
        {banner}
        <RpcNotice chain={chain} />
        {children}
      </main>
    </div>
  );
}

const NAV: ReadonlyArray<{ id: TopRoute; label: string; icon: () => JSX.Element; testId: string }> = [
  { id: 'home', label: 'Home', icon: () => <IconHome />, testId: 'tab-assets' },
  { id: 'nfts', label: 'NFTs', icon: () => <IconGrid />, testId: 'tab-nfts' },
  { id: 'activity', label: 'Activity', icon: () => <IconActivity />, testId: 'tab-activity' },
  { id: 'connect', label: 'Connect', icon: () => <IconLink />, testId: 'tab-connect' },
  { id: 'settings', label: 'Settings', icon: () => <IconSettings />, testId: 'tab-settings' },
];

/**
 * The unlocked wallet: a sidebar with network facts on a desktop; a top bar
 * and a bottom tab bar (thumb zone) on a phone.
 */
export function AppLayout({
  current,
  onNavigate,
  connectCount,
  chain,
  api,
  balances,
  onManage,
  onLock,
  title,
  banner,
  children,
}: {
  current: TopRoute;
  onNavigate: (id: TopRoute) => void;
  connectCount: number;
  chain: ChainState;
  api: AccountsApi;
  balances: BalancesApi;
  onManage: () => void;
  onLock: () => void;
  /** Screen name for the desktop top bar; the home screen has none. */
  title: string | null;
  banner?: ReactNode;
  children: ReactNode;
}) {
  const rpcHost = (() => {
    try {
      return chain.rpcUrl ? new URL(chain.rpcUrl).host : null;
    } catch {
      return null;
    }
  })();

  return (
    <div className="shell">
      <aside className="side" aria-label="Wallet">
        <Brand />
        <nav className="side-nav" aria-label="Primary">
          {NAV.map((n) => (
            <button
              key={n.id}
              className="side-item"
              data-testid={n.testId}
              aria-current={current === n.id ? 'page' : undefined}
              onClick={() => onNavigate(n.id)}
            >
              {n.icon()}
              <span>{n.label}</span>
              {n.id === 'connect' && connectCount > 0 ? (
                <span className="side-count">{connectCount}</span>
              ) : (
                <span className="side-dot" aria-hidden="true" />
              )}
            </button>
          ))}
        </nav>
        <div className="side-foot" aria-label="Network status">
          <div className="side-stat">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <span className={statusDot(chain)} />
              {chain.status === 'ok' ? 'Connected' : chain.status === 'error' ? 'Offline' : 'Connecting'}
            </span>
            <span className="v">chain {CHAIN_ID}</span>
          </div>
          <div className="side-stat">
            <span>Block</span>
            <span className="v">{chain.blockNumber !== null ? chain.blockNumber.toLocaleString('en-US') : '—'}</span>
          </div>
          <div className="side-stat">
            <span>Base fee</span>
            <span className="v">{chain.baseFee !== null ? `${formatGwei(chain.baseFee)} gwei` : '—'}</span>
          </div>
          {rpcHost && (
            <div className="side-stat" title={chain.rpcUrl ?? undefined}>
              <span>RPC</span>
              <span className="v">{rpcHost}</span>
            </div>
          )}
          <div className="side-stat">
            <a href={EXPLORER_URL} target="_blank" rel="noreferrer noopener" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              Explorer <IconExternal />
            </a>
          </div>
        </div>
      </aside>

      <div className="shell-main">
        <header className="topbar">
          <span className="topbar-brand">
            <Brand markOnly />
          </span>
          <span className="net-dot-btn" title={statusText(chain)} role="img" aria-label={statusText(chain)}>
            <span className={statusDot(chain)} />
          </span>
          <span className="spacer" />
          <span className="net-pill num" title={chain.rpcUrl ?? 'not connected'}>
            <span className={statusDot(chain)} />
            <span className="net-label">{statusText(chain)}</span>
          </span>
          <AccountSwitcher api={api} balances={balances} onManage={onManage} />
          <button className="icon-btn" data-testid="lock" aria-label="Lock wallet" title="Lock" onClick={onLock}>
            <IconLock />
          </button>
        </header>

        <main className="content" id="main" aria-label={title ?? 'Home'}>
          {(banner || chain.status === 'error') && (
            <div className="page page-wide">
              {banner}
              <RpcNotice chain={chain} />
            </div>
          )}
          {children}
        </main>
      </div>

      <nav className="tabbar" aria-label="Primary">
        {NAV.map((n) => (
          <button
            key={n.id}
            className="tab-item"
            data-testid={n.testId}
            aria-current={current === n.id ? 'page' : undefined}
            onClick={() => onNavigate(n.id)}
          >
            {n.icon()}
            <span>{n.label}</span>
            {n.id === 'connect' && connectCount > 0 && <span className="tab-count">{connectCount}</span>}
          </button>
        ))}
      </nav>
    </div>
  );
}
