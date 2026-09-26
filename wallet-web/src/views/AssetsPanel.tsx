import { useEffect, useState } from 'react';
import type { PortfolioApi } from '../state/usePortfolio.ts';
import { buildPortfolio, type AssetRef, type PortfolioGroup } from '../lib/portfolio.ts';
import { CHAINS, FERMINUX_CHAIN, chainById } from '../lib/chains.ts';
import { formatAmount, formatAmountExact } from '../lib/validate.ts';
import { ageLabel } from '../lib/time.ts';
import type { ViewPrefs } from '../state/storage.ts';
import { Spinner, Switch } from '../components/ui.tsx';
import { AssetGlyph } from '../components/ChainBadge.tsx';
import { IconChevronRight, IconPlus, IconRefresh } from '../components/icons.tsx';

/**
 * Every balance the active account holds, on every supported network, in one
 * list grouped by network. Each network loads, fails and retries on its own;
 * a network with nothing to show folds into one "nothing held" line.
 */
export function AssetsPanel({
  portfolio,
  prefs,
  onPrefs,
  onOpen,
  onRefresh,
  held,
  down,
}: {
  portfolio: PortfolioApi;
  /** Networks this account holds something on / whose last read failed: lit on the filter chips. */
  held?: Set<number>;
  down?: Set<number>;
  prefs: ViewPrefs;
  onPrefs: (next: Partial<ViewPrefs>) => void;
  onOpen: (asset: AssetRef) => void;
  /** Also refresh what lives outside the portfolio (the balance panel's FMX figure). */
  onRefresh?: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  const filterId = prefs.chainFilter !== null && chainById(prefs.chainFilter) ? prefs.chainFilter : null;
  const groups = buildPortfolio(CHAINS, portfolio.assetsByChain, portfolio.latest, portfolio.lastGood, {
    hideZero: prefs.hideZero,
    chainId: filterId,
  });
  // Networks with rows, or with an error worth a Retry, get their own block;
  // one still on its first read waits in the folded line, so the list never
  // flashes eight blocks of placeholders that then collapse.
  const shown = groups.filter((g) => (g.status !== 'loading' && g.rows.length > 0) || (g.status === 'error' && !g.stale));
  const folded = groups.filter((g) => !shown.includes(g));
  const busy = portfolio.busy.size > 0;

  return (
    <div data-testid="assets-panel">
      <div className="section-head">
        <h2>Assets</h2>
        <span className="push" />
        <Switch checked={prefs.hideZero} onChange={(v) => onPrefs({ hideZero: v })} label="Hide zero" testId="hide-zero" />
        <button
          className="icon-btn"
          data-testid="assets-refresh"
          aria-label="Refresh balances"
          title="Refresh balances"
          onClick={() => {
            portfolio.refresh();
            onRefresh?.();
          }}
          disabled={busy}
        >
          {busy ? <Spinner /> : <IconRefresh />}
        </button>
      </div>

      <div className="chips" role="group" aria-label="Network filter" data-testid="assets-chain-filter" style={{ marginBottom: 14 }}>
        <button className="chip" aria-pressed={filterId === null} onClick={() => onPrefs({ chainFilter: null })}>
          All networks <span className="count">{CHAINS.length}</span>
        </button>
        {CHAINS.map((c) => (
          <button
            key={c.id}
            className="chip"
            aria-pressed={filterId === c.id}
            onClick={() => onPrefs({ chainFilter: c.id })}
            title={held?.has(c.id) ? `${c.name}: holding assets` : down?.has(c.id) ? `${c.name}: unreachable` : c.name}
          >
            <span className={'nd' + (held?.has(c.id) ? ' is-held' : down?.has(c.id) ? ' is-down' : '')} aria-hidden="true" />
            {c.name}
          </button>
        ))}
      </div>

      {shown.map((g) => (
        <ChainGroup key={g.chain.id} group={g} now={now} busy={portfolio.busy.has(g.chain.id)} onRetry={() => portfolio.refresh(g.chain.id)} onOpen={onOpen} />
      ))}

      {folded.length > 0 && (
        <div className="list empty-chains" data-testid="folded-chains">
          <span className="label">{folded.every((g) => g.status === 'loading') ? 'Reading' : 'Nothing held on'}</span>
          {folded.map((g) => (
            <span
              key={g.chain.id}
              className="empty-chain chain-group-folded"
              data-testid={`chain-group-${g.chain.id}`}
              data-status={g.status}
              title={
                g.status === 'loading'
                  ? `${g.chain.name}: reading…`
                  : g.updatedAt !== null
                    ? `${g.chain.name}: no balance · updated ${ageLabel(g.updatedAt, now)}`
                    : g.chain.name
              }
            >
              <span className={'dot ' + (g.status === 'loading' ? 'dot-wait' : g.status === 'error' ? 'dot-bad' : 'dot-ok')} aria-hidden="true" />
              {g.chain.name}
            </span>
          ))}
        </div>
      )}

      <p className="field-hint" style={{ margin: '12px 4px 0' }}>
        One address on all {CHAINS.length} networks. No fiat values: the wallet uses no price service.
      </p>

      <AddToken portfolio={portfolio} defaultChainId={prefs.chainFilter ?? FERMINUX_CHAIN.id} />
    </div>
  );
}

function ChainGroup({
  group,
  now,
  busy,
  onRetry,
  onOpen,
}: {
  group: PortfolioGroup;
  now: number;
  busy: boolean;
  onRetry: () => void;
  onOpen: (asset: AssetRef) => void;
}) {
  const { chain } = group;
  const home = chain.id === FERMINUX_CHAIN.id;
  return (
    <section className="list chain-group" data-testid={`chain-group-${chain.id}`} data-status={group.status}>
      <div className="chain-group-head">
        <span className="chain-group-name">{chain.name}</span>
        <span className="push" />
        <span className="chain-group-status">
          {group.status === 'loading' && (
            <>
              <Spinner /> Reading…
            </>
          )}
          {group.status === 'ok' && group.updatedAt !== null && (
            <span title={group.hiddenZero > 0 ? `${group.hiddenZero} zero ${group.hiddenZero === 1 ? 'balance' : 'balances'} hidden` : undefined}>
              {busy ? 'Refreshing…' : `Updated ${ageLabel(group.updatedAt, now)}`}
            </span>
          )}
          {group.status === 'error' && (
            <span className="chain-error" title={group.error ?? undefined}>
              {group.stale ? 'Unreachable · last reading' : 'Unreachable'}
              <button className="btn btn-ghost btn-sm" onClick={onRetry} disabled={busy}>
                {busy ? <Spinner /> : 'Retry'}
              </button>
            </span>
          )}
        </span>
      </div>
      {group.rows.length > 0 && (
        <ul className="row-list asset-list">
          {group.rows.map(({ asset, balance }) => (
            <li key={`${asset.chainId}:${asset.address ?? 'native'}`} className="asset-row" data-testid={`asset-${asset.chainId}-${asset.symbol}`}>
              <button className="asset-btn" onClick={() => onOpen(asset)}>
                <AssetGlyph symbol={asset.symbol} native={asset.address === null} home={home} chain={chain} />
                <span className="row-main">
                  <span className="row-title">
                    {asset.symbol}
                    {asset.source === 'custom' && <span className="acct-tag">ADDED</span>}
                  </span>
                  <span className="row-sub" style={{ display: 'block' }}>
                    {asset.address === null ? `${asset.name} · native coin` : asset.name}
                  </span>
                </span>
                <span className="row-value" data-testid="asset-balance">
                  {balance === null ? (
                    group.status === 'loading' ? (
                      <span className="skeleton" style={{ minWidth: 64 }}>
                        0.00
                      </span>
                    ) : (
                      <span className="muted" title="This balance could not be read.">
                        —
                      </span>
                    )
                  ) : (
                    <span title={`${formatAmountExact(balance, asset.decimals)} ${asset.symbol}`}>{formatAmount(balance, asset.decimals)}</span>
                  )}
                </span>
                <IconChevronRight className="chev" />
              </button>
            </li>
          ))}
          {group.hiddenZero > 0 && (
            <li className="asset-hidden-note">
              {group.hiddenZero} zero {group.hiddenZero === 1 ? 'balance' : 'balances'} hidden
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

function AddToken({ portfolio, defaultChainId }: { portfolio: PortfolioApi; defaultChainId: number }) {
  const [open, setOpen] = useState(false);
  const [chainId, setChainId] = useState(defaultChainId);
  const [addr, setAddr] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<string | null>(null);

  async function add() {
    if (addr.trim() === '') return;
    setBusy(true);
    setError(null);
    setAdded(null);
    const err = await portfolio.addToken(chainId, addr);
    setBusy(false);
    if (err) setError(err);
    else {
      setAdded(`Added on ${chainById(chainId)?.name ?? `chain ${chainId}`}.`);
      setAddr('');
    }
  }

  if (!open) {
    return (
      <button className="btn btn-ghost" style={{ marginTop: 12 }} onClick={() => setOpen(true)} data-testid="add-token-open">
        <IconPlus /> Add a token
      </button>
    );
  }

  return (
    <div className="panel add-token" style={{ marginTop: 16 }}>
      <div className="panel-body">
        <div className="field mb-0">
          <label htmlFor="token-addr">Add a token by contract address</label>
          <div className="input-row input-row-wrap">
            <select
              className="input input-compact"
              aria-label="Token network"
              data-testid="add-token-chain"
              value={chainId}
              onChange={(e) => {
                setChainId(Number(e.target.value));
                setError(null);
              }}
              disabled={busy}
            >
              {CHAINS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <input
              id="token-addr"
              className={'input input-mono input-compact' + (error ? ' input-error' : '')}
              placeholder="0x…"
              value={addr}
              onChange={(e) => {
                setAddr(e.target.value);
                setError(null);
                setAdded(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void add();
              }}
              disabled={busy}
              spellCheck={false}
              autoComplete="off"
              style={{ flex: '1 1 220px' }}
            />
            <button className="btn" onClick={() => void add()} disabled={busy || addr.trim() === ''}>
              {busy ? <Spinner /> : 'Add'}
            </button>
          </div>
          {error && <div className="field-error">{error}</div>}
          {added && <div className="field-hint copy-flash">{added}</div>}
          <div className="field-hint">Symbol, name and decimals are read from the contract on the network you choose.</div>
        </div>
      </div>
    </div>
  );
}
