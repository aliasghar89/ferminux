import { useEffect, useRef, useState } from 'react';
import type { ChainState } from '../App.tsx';
import type { AccountsApi } from '../state/useAccounts.ts';
import { useNfts, type NftState } from '../state/useNfts.ts';
import { CHAIN_ID, EXPLORER_URL } from '../config.ts';
import { FERMINUX_CHAIN } from '../lib/chains.ts';
import { activeCollections, encodeNftTransfer, planImage, type NftItem } from '../lib/nft.ts';
import { balanceFor } from '../lib/portfolio.ts';
import type { PortfolioApi } from '../state/usePortfolio.ts';
import { checkAddress, formatAmount, shortAddress } from '../lib/validate.ts';
import { prepareTransaction, receiptOf, signAndBroadcast, type PreparedTx } from '../lib/tx.ts';
import { Modal, Spinner } from '../components/ui.tsx';
import { Identicon } from '../components/Identicon.tsx';
import { ChainBanner, HashLine, shortenError } from './SendPanel.tsx';
import { IconExternal, IconGrid, IconRefresh } from '../components/icons.tsx';
import { collectionArt } from '../lib/nftMint.ts';
import { Art, MintBrowser } from './NftMint.tsx';
import type { NftsView } from './router.ts';

/** A rarity tier named in the metadata's "Tier" trait (Ferminux Citizens), for the card's second line. */
const tierOf = (it: NftItem) => it.attributes.find((a) => a.trait.toLowerCase() === 'tier')?.value ?? null;

/** Hosts whose images load without asking: the project's own. */
const TRUSTED_IMAGE_HOSTS = ['ferminux.net'];

export function NftsPanel({
  api,
  chain,
  portfolio,
  refreshKey = 0,
  view = 'yours',
  onView,
  onReceive,
  onSent,
}: {
  api: AccountsApi;
  chain: ChainState;
  portfolio: PortfolioApi;
  /** Bumped when a transaction from another window of this wallet (a mint) may have changed the list. */
  refreshKey?: number;
  /** Your NFTs, or the Ferminux collections to mint from. */
  view?: NftsView;
  onView?: (view: NftsView) => void;
  /** Open Receive (a mint the balance does not cover: "Add FMX"). */
  onReceive?: () => void;
  /** A transaction from this panel confirmed on Ferminux (balances, activity). */
  onSent?: (chainId: number) => void;
}) {
  const holder = api.active.address;
  const { state, reload } = useNfts(holder, true);
  const seenKey = useRef(refreshKey);
  useEffect(() => {
    if (refreshKey === seenKey.current) return;
    seenKey.current = refreshKey;
    reload();
  }, [refreshKey, reload]);
  const [open, setOpen] = useState<NftItem | null>(null);
  const showView = (v: NftsView) => onView?.(v);

  const tabs = (
    <div className="seg nft-views" role="tablist" aria-label="NFTs">
      <button role="tab" aria-selected={view === 'yours'} data-testid="nfts-view-yours" onClick={() => showView('yours')}>
        Your NFTs
        {state.kind === 'ready' && state.items.length > 0 && <span className="seg-count num">{state.items.length}</span>}
      </button>
      <button role="tab" aria-selected={view === 'mint'} data-testid="nfts-view-mint" onClick={() => showView('mint')}>
        Mint
      </button>
    </div>
  );

  if (view === 'mint') {
    return (
      <>
        {tabs}
        <MintBrowser
          api={api}
          chain={chain}
          onAddFmx={() => onReceive?.()}
          onMinted={() => {
            reload();
            if (onSent) onSent(CHAIN_ID);
            else portfolio.refresh(CHAIN_ID);
          }}
          onSeeYours={() => {
            reload();
            showView('yours');
          }}
        />
      </>
    );
  }

  const context = (
    <div className="holder-line holder-line-inset">
      <Identicon address={holder} size={20} />
      <span style={{ flex: 1, minWidth: 0 }}>
        FRC-721 tokens on Ferminux held by <strong>{api.active.label}</strong>{' '}
        <span className="mono">{shortAddress(holder)}</span>
      </span>
      <button className="icon-btn" onClick={reload} disabled={state.kind === 'loading'} aria-label="Check again" title="Check again">
        {state.kind === 'loading' ? <Spinner /> : <IconRefresh />}
      </button>
    </div>
  );

  let body;
  if (state.kind === 'loading') {
    body = (
      <div className="nft-grid" aria-busy="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="nft-card">
            <span className="skeleton nft-img" />
            <span className="skeleton" style={{ width: '70%', margin: '10px 4px 0' }}>
              loading
            </span>
          </div>
        ))}
      </div>
    );
  } else if (state.kind === 'error') {
    body = (
      <div className="list empty-state">
        <div className="title">NFTs unavailable</div>
        {/abort|timed? ?out/i.test(state.message) ? 'The network or the explorer took too long to answer.' : state.message}
        <div style={{ marginTop: 14 }}>
          <button className="btn btn-sm" onClick={reload}>
            Retry
          </button>
        </div>
      </div>
    );
  } else {
    body = <ReadyList state={state} reload={reload} onOpen={setOpen} onBrowse={() => showView('mint')} />;
  }

  // One tree shape for every list state, so the detail modal keeps its place
  // (and its "Transfer confirmed" state) while a send reloads the list.
  return (
    <>
      {tabs}
      {context}
      {body}
      {open && (
        <NftModal
          key={`${open.contract}:${open.tokenId}`}
          item={open}
          api={api}
          chain={chain}
          nativeBalance={balanceFor(portfolio.lastGood, CHAIN_ID, null)}
          onClose={() => setOpen(null)}
          onSent={() => {
            reload();
            portfolio.refresh(CHAIN_ID);
          }}
        />
      )}
    </>
  );
}

function ReadyList({
  state,
  reload,
  onOpen,
  onBrowse,
}: {
  state: Extract<NftState, { kind: 'ready' }>;
  reload: () => void;
  onOpen: (item: NftItem) => void;
  onBrowse: () => void;
}) {
  const [collection, setCollection] = useState<string | null>(null);
  const names = [...new Set([...activeCollections().map((c) => c.name), ...state.items.map((i) => i.collection)])];
  const count = (name: string) => state.items.filter((i) => i.collection === name).length;
  const items = collection === null ? state.items : state.items.filter((i) => i.collection === collection);
  return (
    <>
      {state.notes.map((n) => (
        <div key={n} className="notice">
          {n}
        </div>
      ))}
      {state.items.length === 0 ? (
        <div className="list empty-state" data-testid="nfts-empty">
          <div className="ic-wrap">
            <IconGrid />
          </div>
          <div className="title">No NFTs on this account</div>
          {activeCollections().map((c) => c.name).join(' and ')} {activeCollections().length === 1 ? 'is' : 'are'} checked on-chain, and other collections through the explorer. Mint one here, from this account.
          <div className="actions-row" style={{ marginTop: 16, justifyContent: 'center' }}>
            <button className="btn btn-sm btn-primary" data-testid="nfts-browse" onClick={onBrowse}>
              Browse &amp; mint
            </button>
            <button className="btn btn-sm" onClick={reload}>
              Check again
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="chips" role="group" aria-label="Collection" style={{ marginBottom: 16 }}>
            <button className="chip" aria-pressed={collection === null} onClick={() => setCollection(null)}>
              All <span className="count">{state.items.length}</span>
            </button>
            {names.map((n) => (
              <button key={n} className="chip" aria-pressed={collection === n} onClick={() => setCollection(n)}>
                {n} <span className="count">{count(n)}</span>
              </button>
            ))}
          </div>
          {items.length === 0 ? (
            <div className="list empty-state">
              <div className="title">None from {collection}</div>
              This account holds no token from this collection.
            </div>
          ) : (
            <div className="nft-grid" data-testid="nft-grid">
              {items.map((it) => (
                <button key={`${it.contract}:${it.tokenId}`} className="nft-card" onClick={() => onOpen(it)} data-testid={`nft-${it.tokenId}`}>
                  <NftImage item={it} />
                  <span className="nft-name">{it.name}</span>
                  <span className="nft-sub">
                    {it.collection} · #{it.tokenId}
                    {tierOf(it) ? ` · ${tierOf(it)}` : ''}
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}

function NftImage({ item, large }: { item: NftItem; large?: boolean }) {
  // The two Ferminux collections: their AVIF/WebP copies, not the full-size file.
  const art = collectionArt(item.image);
  if (art) return <Art sources={art} alt={item.name} sizes={large ? '(min-width: 641px) 240px, 320px' : '(min-width: 1200px) 220px, (min-width: 640px) 30vw, 46vw'} large={large} eager={large} label={item.symbol || 'NFT'} />;
  return <PlainNftImage item={item} large={large} />;
}

function PlainNftImage({ item, large }: { item: NftItem; large?: boolean }) {
  const plan = planImage(item.image, TRUSTED_IMAGE_HOSTS);
  const [allowed, setAllowed] = useState(false);
  const [failed, setFailed] = useState(false);
  const cls = 'nft-img' + (large ? ' nft-img-large' : '');
  if (!plan || failed) {
    return (
      <span className={cls + ' nft-img-empty'} aria-label="No image">
        {item.symbol || 'NFT'}
      </span>
    );
  }
  if (!plan.autoload && !allowed) {
    return (
      <span className={cls + ' nft-img-empty'}>
        <span className="small">Image hosted on {plan.host}</span>
        <span
          className="btn btn-sm"
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            setAllowed(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              setAllowed(true);
            }
          }}
        >
          Load image
        </span>
      </span>
    );
  }
  return (
    <img
      className={cls}
      src={plan.url}
      alt={item.name}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

type SendPhase =
  | { kind: 'idle' }
  | { kind: 'preparing' }
  | { kind: 'confirm'; prepared: PreparedTx; to: string }
  | { kind: 'submitting'; prepared: PreparedTx; to: string }
  | { kind: 'pending'; hash: string }
  | { kind: 'done'; hash: string; ok: boolean }
  | { kind: 'error'; message: string };

function NftModal({
  item,
  api,
  chain,
  nativeBalance,
  onClose,
  onSent,
}: {
  item: NftItem;
  api: AccountsApi;
  chain: ChainState;
  nativeBalance: bigint | null;
  onClose: () => void;
  onSent: () => void;
}) {
  const wallet = api.active;
  const [to, setTo] = useState('');
  const [toError, setToError] = useState<string | null>(null);
  const [phase, setPhase] = useState<SendPhase>({ kind: 'idle' });
  const busy = phase.kind === 'preparing' || phase.kind === 'submitting' || phase.kind === 'pending';

  async function review() {
    const addr = checkAddress(to);
    setToError(addr.ok ? null : addr.error);
    if (!addr.ok) return;
    if (addr.address.toLowerCase() === wallet.address.toLowerCase()) {
      setToError('That is this account — choose a different recipient.');
      return;
    }
    if (!chain.provider) {
      setPhase({ kind: 'error', message: 'Not connected to the Ferminux Network.' });
      return;
    }
    setPhase({ kind: 'preparing' });
    try {
      const prepared = await prepareTransaction(
        chain.provider,
        CHAIN_ID,
        wallet.address,
        item.contract,
        0n,
        encodeNftTransfer(wallet.address, addr.address, item.tokenId),
      );
      if (nativeBalance !== null && prepared.maxFeeWei > nativeBalance) {
        setPhase({
          kind: 'error',
          message: `Not enough FMX for the network fee: up to ${formatAmount(prepared.maxFeeWei, 18, 8)} FMX is needed.`,
        });
        return;
      }
      setPhase({ kind: 'confirm', prepared, to: addr.address });
    } catch (e) {
      setPhase({ kind: 'error', message: e instanceof Error ? shortenError(e.message) : 'Could not prepare the transfer.' });
    }
  }

  async function submit(prepared: PreparedTx, recipient: string) {
    if (!chain.provider) return;
    setPhase({ kind: 'submitting', prepared, to: recipient });
    try {
      const sent = await signAndBroadcast(wallet.privateKey, chain.provider, prepared);
      setPhase({ kind: 'pending', hash: sent.hash });
      const receipt = await receiptOf(sent.response);
      setPhase({ kind: 'done', hash: sent.hash, ok: !!receipt && receipt.status === 1 });
      onSent();
    } catch (e) {
      setPhase({ kind: 'error', message: e instanceof Error ? shortenError(e.message) : 'Broadcast failed.' });
    }
  }

  return (
    <Modal title={item.name} onClose={busy ? () => undefined : onClose} wide>
      <div className="nft-detail">
        <NftImage item={item} large />
        <div className="nft-detail-main">
          <div className="label">
            {item.collection} · #{item.tokenId}
          </div>
          {item.description && <p className="small muted" style={{ marginTop: 10, lineHeight: 1.6 }}>{item.description}</p>}
          {item.attributes.length > 0 && (
            <dl className="nft-attrs">
              {item.attributes.map((a) => (
                <div key={a.trait}>
                  <dt>{a.trait}</dt>
                  <dd>{a.value}</dd>
                </div>
              ))}
            </dl>
          )}
          <div className="small faint" style={{ marginTop: 12 }}>
            Contract{' '}
            <a
              href={`${EXPLORER_URL}/token/${item.contract}/instance/${item.tokenId}`}
              target="_blank"
              rel="noreferrer noopener"
              className="hit-44"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              <span className="mono">{shortAddress(item.contract)}</span> <IconExternal />
            </a>
            {item.metadataSource === 'explorer' && ' · metadata via the explorer'}
            {item.metadataSource === 'none' && ' · metadata unavailable'}
          </div>
        </div>
      </div>

      <hr className="divider" />

      {(phase.kind === 'idle' || phase.kind === 'preparing' || phase.kind === 'error') && (
        <div className="field mb-0">
          <label htmlFor="nft-to">Send this NFT to</label>
          <div className="input-row">
            <input
              id="nft-to"
              className={'input input-mono' + (toError ? ' input-error' : '')}
              placeholder="0x…"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setToError(null);
                if (phase.kind === 'error') setPhase({ kind: 'idle' });
              }}
              disabled={phase.kind === 'preparing'}
              spellCheck={false}
              autoComplete="off"
            />
            <button className="btn btn-primary" data-testid="nft-review" onClick={() => void review()} disabled={phase.kind === 'preparing' || to.trim() === ''}>
              {phase.kind === 'preparing' ? <Spinner /> : 'Review'}
            </button>
          </div>
          {toError && <div className="field-error">{toError}</div>}
          {phase.kind === 'error' && <div className="field-error">{phase.message}</div>}
          <div className="field-hint">
            Uses safeTransferFrom, so a contract that cannot hold FRC-721 tokens is refused before anything is signed.
          </div>
        </div>
      )}

      {(phase.kind === 'confirm' || phase.kind === 'submitting') && (
        <div>
          <ChainBanner chain={FERMINUX_CHAIN} />
          <table className="confirm-table">
            <tbody>
              <tr>
                <th>From</th>
                <td>
                  {wallet.label} <span className="mono muted">{shortAddress(wallet.address)}</span>
                </td>
              </tr>
              <tr>
                <th>NFT</th>
                <td>
                  {item.collection} #{item.tokenId}
                </td>
              </tr>
              <tr>
                <th>Contract</th>
                <td className="mono">{item.contract}</td>
              </tr>
              <tr>
                <th>To</th>
                <td className="mono">{phase.to}</td>
              </tr>
              <tr>
                <th>Network fee (max)</th>
                <td className="num">{formatAmount(phase.prepared.maxFeeWei, 18, 8)} FMX</td>
              </tr>
              <tr>
                <th>Chain ID</th>
                <td className="num">{phase.prepared.chainId}</td>
              </tr>
              <tr>
                <th>Nonce</th>
                <td className="num">{phase.prepared.nonce}</td>
              </tr>
            </tbody>
          </table>
          <div className="actions-split">
            <button className="btn" onClick={() => setPhase({ kind: 'idle' })} disabled={phase.kind === 'submitting'}>
              Back
            </button>
            <button
              className="btn btn-primary"
              data-testid="nft-confirm"
              onClick={() => void submit(phase.prepared, phase.to)}
              disabled={phase.kind === 'submitting'}
            >
              {phase.kind === 'submitting' ? (
                <>
                  <Spinner /> Signing…
                </>
              ) : (
                'Sign & send on Ferminux'
              )}
            </button>
          </div>
        </div>
      )}

      {phase.kind === 'pending' && (
        <div className="tx-state">
          <div className="state-ic">
            <Spinner />
          </div>
          <h3>Transfer submitted</h3>
          <p>Waiting for confirmation on the Ferminux Network…</p>
          <HashLine chain={FERMINUX_CHAIN} hash={phase.hash} />
        </div>
      )}
      {phase.kind === 'done' && (
        <div>
          <div className={'notice ' + (phase.ok ? 'notice-success' : 'notice-danger')}>
            {phase.ok ? 'Transfer confirmed. The NFT has left this account.' : 'The transfer was included in a block but reverted.'}
          </div>
          <HashLine chain={FERMINUX_CHAIN} hash={phase.hash} />
          <button className="btn btn-block" onClick={onClose}>
            Close
          </button>
        </div>
      )}
    </Modal>
  );
}
