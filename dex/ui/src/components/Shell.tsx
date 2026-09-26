import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { CHAIN_ID, DEX_ADDRESSES, EXPLORER_URL, FMX_USD_E18, explorerAddressUrl, isConfigured } from '../config.ts';
import { formatAmount, shortAddress } from '../lib/amounts.ts';
import { formatUsdPrice } from '../lib/prices.ts';
import type { ChainState } from '../state/useChain.ts';
import type { Page } from '../state/useRoute.ts';
import type { WalletSession } from '../state/useWallet.ts';
import { chainName, isKnownChain } from '../../../../shared/fxwallet/chains.ts';
import { Brand } from './Brand.tsx';
import { CopyButton } from './ui.tsx';
import {
  IconActivity,
  IconAlert,
  IconChart,
  IconChevronDown,
  IconExternal,
  IconLiquidity,
  IconPools,
  IconPower,
  IconSwap,
} from './icons.tsx';

const NAV: Array<{ page: Page; label: string; icon: (p: { className?: string }) => ReactNode; also?: Page[] }> = [
  { page: 'swap', label: 'Swap', icon: IconSwap },
  { page: 'pools', label: 'Pools', icon: IconPools },
  { page: 'liquidity', label: 'Liquidity', icon: IconLiquidity },
  { page: 'charts', label: 'Charts', icon: IconChart, also: ['analytics'] },
  { page: 'activity', label: 'Activity', icon: IconActivity },
];

function hrefFor(page: Page): string {
  return page === 'swap' ? './' : `?tab=${page}`;
}

export function Shell({
  page,
  navigate,
  chain,
  wallet,
  fmxBalance,
  children,
  extraNav,
}: {
  page: Page;
  navigate: (page: Page) => void;
  chain: ChainState;
  wallet: WalletSession;
  fmxBalance: bigint | undefined;
  children: ReactNode;
  /** The Bridge entry, when this build carries it. */
  extraNav?: { page: Page; label: string } | null;
}) {
  const go = (p: Page) => (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(p);
  };
  const isActive = (item: (typeof NAV)[number]) => page === item.page || (item.also ?? []).includes(page);
  const nav = extraNav ? [...NAV, { page: extraNav.page, label: extraNav.label, icon: IconSwap }] : NAV;

  return (
    <div className="app">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <div className="topbar-inner">
          <a className="topbar-brand" href="./" onClick={go('swap')} aria-label="Ferminux DEX, swap">
            <Brand sub="DEX" />
          </a>
          <nav className="topnav" aria-label="Primary">
            {nav.map((item) => (
              <a
                key={item.page}
                href={hrefFor(item.page)}
                onClick={go(item.page)}
                className="topnav-link"
                aria-current={isActive(item) ? 'page' : undefined}
              >
                {item.label}
              </a>
            ))}
          </nav>
          <span className="spacer" />
          <NetPill chain={chain} />
          <WalletButton wallet={wallet} fmxBalance={fmxBalance} onActivity={() => navigate('activity')} />
        </div>
      </header>

      {wallet.wallet && wallet.wrongChain && (
        <div className="banner banner-warn" role="status">
          <IconAlert />
          <span>
            Your wallet is on {isKnownChain(wallet.wallet.chainId) ? `${chainName(wallet.wallet.chainId)} (${wallet.wallet.chainId})` : `chain ${wallet.wallet.chainId}`}, not Ferminux ({CHAIN_ID}).
            Reading works; signing on Ferminux does not.
          </span>
          <button className="btn btn-sm" onClick={() => void wallet.switchChain()}>
            Switch to Ferminux
          </button>
        </div>
      )}
      {chain.status === 'error' && (
        <div className="banner banner-warn" role="alert">
          <IconAlert />
          <span>Cannot reach a Ferminux RPC endpoint. Retrying on its own.</span>
          <button className="btn btn-sm" onClick={chain.retry}>
            Retry now
          </button>
        </div>
      )}

      <main id="main" className="content" tabIndex={-1}>
        {children}
      </main>

      <footer className="site-foot">
        <div className="site-foot-inner">
          <span className="foot-item">
            <span className={'dot ' + (chain.status === 'ok' ? 'dot-ok' : chain.status === 'error' ? 'dot-bad' : 'dot-wait')} />
            <span className="mono" data-testid="foot-block">
              {chain.blockNumber !== null ? `Block ${chain.blockNumber.toLocaleString('en-US')}` : chain.status === 'error' ? 'Offline' : 'Connecting'}
            </span>
          </span>
          {chain.rpcUrl && <span className="foot-item mono">{new URL(chain.rpcUrl).host}</span>}
          {isConfigured() && (
            <a className="foot-item" href={explorerAddressUrl(DEX_ADDRESSES.router)} target="_blank" rel="noreferrer noopener">
              Router <span className="mono">{shortAddress(DEX_ADDRESSES.router)}</span>
              <IconExternal />
            </a>
          )}
          <a className="foot-item" href={EXPLORER_URL} target="_blank" rel="noreferrer noopener">
            Explorer <IconExternal />
          </a>
          <a className="foot-item" href="https://ferminux.net/assets/brand/tokenlist.json" target="_blank" rel="noreferrer noopener">
            Token list <IconExternal />
          </a>
          <span className="foot-item foot-basis">
            USD values: FMX at the official {formatUsdPrice(FMX_USD_E18)}, 1 USDF = $1, 1 AZNT = 1 AZN at 1.70 AZN per USD.
          </span>
        </div>
      </footer>

      <nav className="tabbar" aria-label="Primary">
        {nav.slice(0, 5).map((item) => {
          const Icon = item.icon;
          return (
            <a
              key={item.page}
              href={hrefFor(item.page)}
              onClick={go(item.page)}
              className="tab-item"
              aria-current={isActive(item) ? 'page' : undefined}
            >
              <Icon />
              <span>{item.label}</span>
            </a>
          );
        })}
      </nav>
    </div>
  );
}

function NetPill({ chain }: { chain: ChainState }) {
  return (
    <span className="net-pill" title={chain.rpcUrl ?? 'not connected'} data-testid="net-pill">
      <span className={'dot ' + (chain.status === 'ok' ? 'dot-ok' : chain.status === 'error' ? 'dot-bad' : 'dot-wait')} />
      <span className="net-label">
        {chain.status === 'ok' ? `Ferminux ${CHAIN_ID}` : chain.status === 'error' ? 'RPC unreachable' : 'Connecting'}
      </span>
    </span>
  );
}

function WalletButton({
  wallet,
  fmxBalance,
  onActivity,
}: {
  wallet: WalletSession;
  fmxBalance: bigint | undefined;
  onActivity: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: globalThis.MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!wallet.address) {
    return (
      <button className="btn btn-primary btn-sm topbar-connect" data-testid="header-connect" onClick={wallet.connect} disabled={wallet.connecting}>
        {wallet.connecting ? 'Connecting' : 'Connect'}
      </button>
    );
  }
  return (
    <div className="acct" ref={ref}>
      <button className="acct-trigger" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((v) => !v)} data-testid="acct-trigger">
        <span className={'dot ' + (wallet.wrongChain ? 'dot-bad' : 'dot-ok')} aria-hidden="true" />
        <span className="mono acct-addr">{shortAddress(wallet.address, 6, 4)}</span>
        {fmxBalance !== undefined && <span className="mono acct-bal">{formatAmount(fmxBalance, 18, 2)} FMX</span>}
        <IconChevronDown />
      </button>
      {open && (
        <div className="acct-menu" role="menu">
          <div className="acct-menu-head">
            <span className="label">Connected{wallet.kind ? ` · ${wallet.kind === 'ferminux' ? 'Ferminux Wallet' : wallet.kind === 'walletconnect' ? 'WalletConnect' : 'browser wallet'}` : ''}</span>
            <div className="acct-menu-addr mono">{wallet.address}</div>
            <div className="acct-menu-row">
              <CopyButton text={wallet.address} label="Copy address" />
              <a className="btn btn-ghost btn-sm" href={explorerAddressUrl(wallet.address)} target="_blank" rel="noreferrer noopener">
                Explorer <IconExternal />
              </a>
            </div>
          </div>
          <button
            className="acct-menu-item"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onActivity();
            }}
          >
            <IconActivity /> Your activity
          </button>
          <button
            className="acct-menu-item acct-menu-danger"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              wallet.disconnect();
            }}
          >
            <IconPower /> Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
