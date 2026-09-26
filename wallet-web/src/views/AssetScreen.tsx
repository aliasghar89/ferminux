import { useEffect, useState } from 'react';
import type { PortfolioApi } from '../state/usePortfolio.ts';
import { balanceFor, type AssetRef } from '../lib/portfolio.ts';
import { FERMINUX_CHAIN, chainById, explorerAddressUrl, explorerTokenUrl } from '../lib/chains.ts';
import { formatAmount, formatAmountExact, shortAddress } from '../lib/validate.ts';
import { ageLabel } from '../lib/time.ts';
import { AssetGlyph, ChainBadge } from '../components/ChainBadge.tsx';
import { CopyButton, Spinner } from '../components/ui.tsx';
import { IconExternal, IconReceive, IconRefresh, IconSend } from '../components/icons.tsx';
import { BackButton } from './ScreenHead.tsx';
import { fitClass } from './HomeScreen.tsx';

/** One asset on one network: its balance, what it is, and what to do with it. */
export function AssetScreen({
  portfolio,
  chainId,
  address,
  onBack,
  onSend,
  onReceive,
  onRemoved,
  onRefresh,
}: {
  portfolio: PortfolioApi;
  chainId: number;
  address: string | null;
  onBack: () => void;
  onSend: (a: AssetRef) => void;
  onReceive: () => void;
  onRemoved: () => void;
  onRefresh: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  const chain = chainById(chainId);
  const asset = chain
    ? (portfolio.assetsByChain.get(chain.id) ?? []).find((a) => (a.address ?? null)?.toLowerCase() === address?.toLowerCase())
    : undefined;

  if (!chain || !asset) {
    return (
      <>
        <BackButton onClick={onBack} />
        <div className="list empty-state">
          <div className="title">Asset not in your list</div>
          It may have been removed, or the link names a network this wallet does not support.
        </div>
      </>
    );
  }

  const home = chain.id === FERMINUX_CHAIN.id;
  const balance = balanceFor(portfolio.lastGood, chain.id, asset.address);
  const native = balanceFor(portfolio.lastGood, chain.id, null);
  const reading = portfolio.latest.get(chain.id);
  const good = portfolio.lastGood.get(chain.id);
  const busy = portfolio.busy.has(chain.id);
  const isToken = asset.address !== null;

  return (
    <>
      <BackButton onClick={onBack} label="Assets" />
      <section className="hero" aria-label={`${asset.symbol} on ${chain.name}`}>
        <div className="asset-hero">
          <div className="asset-hero-id">
            <AssetGlyph symbol={asset.symbol} native={!isToken} home={home} chain={chain} large />
            <div style={{ minWidth: 0 }}>
              <h1 className="asset-hero-name">{asset.symbol}</h1>
              <div className="asset-hero-sub">
                <span>{isToken ? asset.name : `${asset.name} · native coin`}</span>
                <ChainBadge chain={chain} withName />
                {asset.source === 'custom' && <span className="acct-tag" style={{ marginLeft: 0 }}>ADDED</span>}
              </div>
            </div>
          </div>
          <div>
            <div className="label" style={{ marginBottom: 8 }}>
              Balance
            </div>
            {balance === null ? (
              reading && !reading.ok ? (
                <div className="balance-figure muted">—</div>
              ) : (
                <span className="skeleton balance-figure">0.000000</span>
              )
            ) : (
              <div className={'balance-figure' + fitClass(formatAmount(balance, asset.decimals))} data-testid="asset-page-balance" title={`${formatAmountExact(balance, asset.decimals)} ${asset.symbol}`}>
                {formatAmount(balance, asset.decimals)}
                <span className="balance-unit">{asset.symbol}</span>
              </div>
            )}
          </div>
        </div>
        <div className="hero-actions" style={{ gridTemplateColumns: 'repeat(2,minmax(0,1fr))', maxWidth: 360 }}>
          <button className="btn btn-primary" data-testid="asset-send" onClick={() => onSend(asset)} disabled={balance === 0n}>
            <IconSend /> Send
          </button>
          <button className="btn" onClick={onReceive}>
            <IconReceive /> Receive
          </button>
        </div>
      </section>

      {isToken && native === 0n && (
        <div className="notice notice-warn" style={{ marginTop: 16 }}>
          No {chain.native.symbol} on {chain.name}, so a transfer of {asset.symbol} cannot pay its network fee there.
        </div>
      )}

      <div className="section-head section">
        <h2>Details</h2>
        <span className="push" />
        <button
          className="icon-btn"
          aria-label={`Refresh ${chain.name}`}
          title="Refresh"
          disabled={busy}
          onClick={() => {
            portfolio.refresh(chain.id);
            if (home) onRefresh();
          }}
        >
          {busy ? <Spinner /> : <IconRefresh />}
        </button>
      </div>
      <dl className="list facts">
        <div>
          <dt>Network</dt>
          <dd>
            {chain.name} <span className="mono faint">· chain {chain.id}</span>
          </dd>
        </div>
        <div>
          <dt>Type</dt>
          <dd>{isToken ? (home ? 'FRC-20 token' : 'Token') : `Native coin · pays ${chain.name} fees`}</dd>
        </div>
        {isToken && (
          <div>
            <dt>Contract</dt>
            <dd>
              <span className="mono" title={asset.address ?? undefined}>
                {shortAddress(asset.address!)}
              </span>
              <CopyButton text={asset.address!} label="Copy contract address" iconOnly />
              <a className="row-link" href={explorerTokenUrl(chain, asset.address!)} target="_blank" rel="noreferrer noopener" aria-label={`Open on ${chain.explorer.name}`}>
                <IconExternal />
              </a>
            </dd>
          </div>
        )}
        <div>
          <dt>Decimals</dt>
          <dd className="mono">{asset.decimals}</dd>
        </div>
        {isToken && (
          <div>
            <dt>Fee coin</dt>
            <dd>
              {native === null ? '—' : <span className="mono">{formatAmount(native, chain.native.decimals)}</span>} {chain.native.symbol}
            </dd>
          </div>
        )}
        <div>
          <dt>Updated</dt>
          <dd>
            {reading && !reading.ok ? (
              <span style={{ color: 'var(--warn)' }}>Unreachable{good ? ` · last reading ${ageLabel(good.at, now)}` : ''}</span>
            ) : good ? (
              ageLabel(good.at, now)
            ) : (
              'Reading…'
            )}
          </dd>
        </div>
        <div>
          <dt>Explorer</dt>
          <dd>
            <a href={explorerAddressUrl(chain, portfolio.holder)} target="_blank" rel="noreferrer noopener" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              Your address on {chain.explorer.name} <IconExternal />
            </a>
          </dd>
        </div>
      </dl>

      {asset.source === 'custom' && (
        <button
          className="btn btn-danger-ghost"
          style={{ marginTop: 16 }}
          onClick={() => {
            if (asset.address) portfolio.removeToken(asset.chainId, asset.address);
            onRemoved();
          }}
          title="Remove from the list (does not affect the balance on chain)"
        >
          Remove from list
        </button>
      )}
    </>
  );
}
