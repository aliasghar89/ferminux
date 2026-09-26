// NFTs → Mint: the two Ferminux collections, browsable and mintable from the
// active account without leaving the wallet (no WalletConnect, no browser).
//
// A mint is an ordinary transaction through the wallet's own pipeline
// (lib/tx.ts prepareTransaction → confirm screen → signAndBroadcast): mint(id)
// on the collection with exactly the contract's price attached, chain 3961.
// lib/nftMint.ts reads everything mint() checks in one batch before the
// confirm screen and again right before signing.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChainState } from '../App.tsx';
import type { AccountsApi } from '../state/useAccounts.ts';
import { useMintGallery } from '../state/useMintGallery.ts';
import { CHAIN_ID } from '../config.ts';
import { FERMINUX_CHAIN, explorerAddressUrl } from '../lib/chains.ts';
import { httpBatchTransport } from '../lib/balances.ts';
import {
  MINT_COLLECTIONS,
  MINT_METHOD,
  TIERS,
  artSources,
  buildMintCall,
  mintCollection,
  mintProblem,
  piecePrice,
  readMintPreflight,
  tierIndex,
  tierName,
  type ArtSources,
  type MintCollection,
  type MintKey,
  type MintPiece,
  type MintPreflight,
  type MintProblem,
  type PieceStatus,
  type TierName,
} from '../lib/nftMint.ts';
import { planImage } from '../lib/nft.ts';
import { formatAmount, formatAmountExact, formatGwei, shortAddress } from '../lib/validate.ts';
import { prepareTransaction, signAndBroadcast, type PreparedTx } from '../lib/tx.ts';
import { Modal, Spinner } from '../components/ui.tsx';
import { IconCheck, IconChevronDown, IconClose, IconExternal, IconReceive, IconRefresh } from '../components/icons.tsx';
import { ChainBanner, HashLine, shortenError } from './SendPanel.tsx';

const PAGE = 24;
type Avail = 'available' | 'all' | 'minted';

/** Session memory of the last collection and filters, so coming back to Mint keeps the place. */
const remembered: { key: MintKey; avail: Avail; tier: TierName | 'all' } = { key: 'citizens', avail: 'available', tier: 'all' };

const fmx = (wei: bigint, digits = 2) => `${formatAmount(wei, 18, digits)} FMX`;

/** The badge a piece carries: its live tier (Citizens), or the Agents set. */
function badgeOf(c: MintCollection, piece: MintPiece, status: PieceStatus | undefined): { text: string; cls: string } | null {
  if (c.pricing === 'tier') {
    const t = tierName(status?.tier !== undefined ? status.tier : tierIndex(piece.tier));
    return t ? { text: t, cls: `t-${t.toLowerCase()}` } : null;
  }
  if (!piece.set) return null;
  return { text: piece.set, cls: /legendary/i.test(piece.set) ? 't-legendary' : 't-common' };
}

/* ------------------------------------------------------------------ */
/* Artwork                                                             */
/* ------------------------------------------------------------------ */

/**
 * AVIF, then WebP, at 256/512 px, the canonical file last; lazy unless
 * `eager`. A missing gallery copy falls back to the canonical file, and a
 * missing canonical file to a plain tile — the card never stays broken.
 */
export function Art({
  sources,
  image,
  alt,
  sizes,
  large,
  eager,
  label,
}: {
  sources: ArtSources | null;
  /** Used when `sources` is null (an image the collection does not host). */
  image?: string | null;
  alt: string;
  sizes: string;
  large?: boolean;
  eager?: boolean;
  /** Text for the empty tile. */
  label: string;
}) {
  const [stage, setStage] = useState<'sources' | 'plain' | 'failed'>('sources');
  const [loaded, setLoaded] = useState(false);
  const cls = 'nft-img' + (large ? ' nft-img-large' : '') + (loaded ? ' ld' : ' is-loading');
  const plain = !sources ? planImage(image ?? null, ['ferminux.net']) : null;
  if (stage === 'failed' || (!sources && (!plain || !plain.autoload))) {
    return (
      <span className={'nft-img nft-img-empty' + (large ? ' nft-img-large' : '')} aria-label="No image">
        {label}
      </span>
    );
  }
  const img = (
    <img
      className={cls}
      src={sources ? sources.src : plain!.url}
      alt={alt}
      width={512}
      height={512}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      referrerPolicy="no-referrer"
      onLoad={() => setLoaded(true)}
      onError={() => setStage((s) => (s === 'sources' && sources ? 'plain' : 'failed'))}
    />
  );
  if (!sources || stage === 'plain') return img;
  return (
    <picture className="nft-picture">
      <source type="image/avif" srcSet={sources.avif} sizes={sizes} />
      <source type="image/webp" srcSet={sources.webp} sizes={sizes} />
      {img}
    </picture>
  );
}

const CARD_SIZES = '(min-width: 1200px) 220px, (min-width: 640px) 30vw, 46vw';
const SHEET_SIZES = '(min-width: 641px) 240px, 320px';

/* ------------------------------------------------------------------ */
/* Gallery                                                             */
/* ------------------------------------------------------------------ */

export function MintBrowser({
  api,
  chain,
  onAddFmx,
  onMinted,
  onSeeYours,
}: {
  api: AccountsApi;
  chain: ChainState;
  /** The balance does not cover a mint: take the user to Receive. */
  onAddFmx: () => void;
  /** A mint confirmed: refresh Your NFTs and the balances. */
  onMinted: () => void;
  onSeeYours: () => void;
}) {
  const [key, setKey] = useState<MintKey>(remembered.key);
  const [avail, setAvail] = useState<Avail>(remembered.avail);
  const [tier, setTier] = useState<TierName | 'all'>(remembered.tier);
  const [limit, setLimit] = useState(PAGE);
  const [openId, setOpenId] = useState<number | null>(null);
  remembered.key = key;
  remembered.avail = avail;
  remembered.tier = tier;

  const c = mintCollection(key);
  const { gallery, reload, setStatus } = useMintGallery(c, chain.rpcUrl);
  const me = api.active.address.toLowerCase();

  // A new collection or filter starts from the top of its list.
  useEffect(() => setLimit(PAGE), [key, avail, tier]);

  // One render can still hold the previous collection's list, before the effect resets it.
  const ready = gallery.kind === 'ready' && gallery.key === key ? gallery : null;
  const loading = gallery.kind === 'loading' || (gallery.kind === 'ready' && !ready);
  const state = ready?.state ?? null;
  const statusOf = (id: number) => state?.statuses.get(id);
  const liveTier = (p: MintPiece): TierName | null => {
    const s = statusOf(p.id);
    return tierName(s?.tier !== undefined ? s.tier : tierIndex(p.tier));
  };
  const pieces = ready?.pieces ?? [];
  const byAvail = (p: MintPiece, a: Avail) => {
    if (a === 'all') return true;
    const minted = !!statusOf(p.id)?.minted;
    return a === 'minted' ? minted : !minted;
  };
  const shown = pieces.filter((p) => byAvail(p, avail) && (c.pricing !== 'tier' || tier === 'all' || liveTier(p) === tier));
  const count = (a: Avail) => pieces.filter((p) => byAvail(p, a) && (c.pricing !== 'tier' || tier === 'all' || liveTier(p) === tier)).length;
  const mintedCount = state ? [...state.statuses.values()].filter((s) => s.minted).length : null;
  const open = openId !== null ? pieces.find((p) => p.id === openId) ?? null : null;

  let body: JSX.Element;
  if (loading) {
    body = (
      <div className="nft-grid" aria-busy="true">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="nft-card">
            <span className="skeleton nft-img" />
            <span className="skeleton" style={{ width: '70%', margin: '10px 4px 0' }}>
              loading
            </span>
          </div>
        ))}
      </div>
    );
  } else if (gallery.kind === 'error') {
    body = (
      <div className="list empty-state" data-testid="mint-error">
        <div className="title">Collection unavailable</div>
        {gallery.message}
        <div style={{ marginTop: 14 }}>
          <button className="btn btn-sm" onClick={reload}>
            Retry
          </button>
        </div>
      </div>
    );
  } else {
    body = (
      <>
        {ready?.stateError && <div className="notice notice-warn">{ready.stateError}</div>}
        {state?.paused && <div className="notice notice-warn">Minting {c.name} is paused by the contract right now.</div>}
        {shown.length === 0 ? (
          <div className="list empty-state" data-testid="mint-empty">
            <div className="title">Nothing here</div>
            {avail === 'available' ? `Every ${c.noun} matching these filters has been minted.` : `No ${c.noun} matches these filters.`}
          </div>
        ) : (
          <>
            <div className="nft-grid" data-testid="mint-grid">
              {shown.slice(0, limit).map((p) => {
                const s = statusOf(p.id);
                const price = piecePrice(c, state, { id: p.id, tier: p.tier });
                const badge = badgeOf(c, p, s);
                const mine = !!s?.owner && s.owner.toLowerCase() === me;
                return (
                  <button
                    key={p.id}
                    className={'nft-card mint-card' + (badge ? ` ${badge.cls}` : '') + (s?.minted ? ' is-minted' : '')}
                    data-testid={`mint-card-${p.id}`}
                    data-minted={s?.minted ? 'true' : 'false'}
                    onClick={() => setOpenId(p.id)}
                  >
                    <span className="mint-art">
                      <Art sources={artSources(p.image, c.base, p.id, c.ext)} image={p.image} alt="" sizes={CARD_SIZES} label={c.symbol} />
                      {badge && <span className={`tier tier-on-art ${badge.cls}`}>{badge.text}</span>}
                    </span>
                    <span className="nft-name">{p.name.replace(/\s*#\d+$/, '')}</span>
                    <span className="mint-meta">
                      <span className="num faint">#{p.id}</span>
                      {s?.minted ? (
                        <span className={'nft-pill' + (mine ? ' is-yours' : '')}>{mine ? 'Yours' : 'Minted'}</span>
                      ) : (
                        <span className="mint-price num">{price !== null ? fmx(price) : '—'}</span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
            {shown.length > limit && (
              <div style={{ textAlign: 'center', marginTop: 16 }}>
                <button className="btn btn-sm" data-testid="mint-more" onClick={() => setLimit((l) => l + PAGE)}>
                  Show more · {shown.length - limit} left
                </button>
              </div>
            )}
          </>
        )}
      </>
    );
  }

  return (
    <div data-testid="mint-browser" data-collection={key}>
      <div className="mint-head">
        <div className="seg" role="tablist" aria-label="Collection">
          {MINT_COLLECTIONS.map((col) => (
            <button
              key={col.key}
              role="tab"
              aria-selected={key === col.key}
              data-testid={`mint-col-${col.key}`}
              onClick={() => {
                setKey(col.key);
                setTier('all');
              }}
            >
              {col.name.replace(/^Ferminux /, '')}
            </button>
          ))}
        </div>
        <span className="mint-facts small muted" data-testid="mint-facts">
          {ready ? (
            <>
              <span className="num">{pieces.length}</span> {c.noun}s
              {mintedCount !== null && (
                <>
                  {' · '}
                  <span className="num">{mintedCount}</span> minted
                </>
              )}
              {state && (c.pricing === 'fixed' ? <> · {fmx(state.prices[0] ?? 0n)} each</> : null)}
            </>
          ) : (
            'Reading the collection…'
          )}
        </span>
        <button className="icon-btn" onClick={reload} disabled={loading} aria-label="Check again" title="Check again">
          {loading ? <Spinner /> : <IconRefresh />}
        </button>
      </div>

      <div className="chips" role="group" aria-label="Availability" style={{ marginBottom: 10 }}>
        {(
          [
            ['available', 'Available'],
            ['all', 'All'],
            ['minted', 'Minted'],
          ] as const
        ).map(([id, label]) => (
          <button key={id} className="chip" aria-pressed={avail === id} data-testid={`mint-avail-${id}`} onClick={() => setAvail(id)}>
            {label} {ready && <span className="count">{count(id)}</span>}
          </button>
        ))}
      </div>
      {c.pricing === 'tier' && (
        <div className="chips" role="group" aria-label="Tier" style={{ marginBottom: 16 }}>
          <button className="chip" aria-pressed={tier === 'all'} data-testid="mint-tier-all" onClick={() => setTier('all')}>
            All tiers
          </button>
          {TIERS.map((t, i) => (
            <button key={t} className="chip" aria-pressed={tier === t} data-testid={`mint-tier-${t.toLowerCase()}`} onClick={() => setTier(t)}>
              <span className={`tier-dot t-${t.toLowerCase()}`} aria-hidden="true" />
              {t}
              {state && state.prices[i] !== undefined && <span className="count">{formatAmount(state.prices[i]!, 18, 2)} FMX</span>}
            </button>
          ))}
        </div>
      )}
      {c.pricing !== 'tier' && <div style={{ height: 6 }} />}

      {body}

      {open && (
        <MintSheet
          key={`${key}:${open.id}`}
          c={c}
          piece={open}
          status={statusOf(open.id)}
          price={piecePrice(c, state, { id: open.id, tier: open.tier })}
          paused={state?.paused ?? false}
          api={api}
          chain={chain}
          onClose={() => setOpenId(null)}
          onFresh={(pf) => setStatus(pf.tokenId, { minted: pf.minted, owner: pf.owner, ...(pf.tier !== null ? { tier: pf.tier } : {}) })}
          onAddFmx={() => {
            setOpenId(null);
            onAddFmx();
          }}
          onMinted={(id) => {
            setStatus(id, { minted: true, owner: api.active.address });
            onMinted();
          }}
          onSeeYours={() => {
            setOpenId(null);
            onSeeYours();
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Detail sheet + mint                                                 */
/* ------------------------------------------------------------------ */

type Phase =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'problem'; problem: MintProblem; hash?: string }
  | { kind: 'confirm'; prepared: PreparedTx; pf: MintPreflight }
  | { kind: 'submitting'; prepared: PreparedTx; pf: MintPreflight; step: 'checking' | 'signing' }
  | { kind: 'pending'; hash: string }
  | { kind: 'done'; hash: string | null }
  | { kind: 'failed'; message: string; hash?: string };

function MintSheet({
  c,
  piece,
  status,
  price,
  paused,
  api,
  chain,
  onClose,
  onFresh,
  onAddFmx,
  onMinted,
  onSeeYours,
}: {
  c: MintCollection;
  piece: MintPiece;
  status: PieceStatus | undefined;
  price: bigint | null;
  paused: boolean;
  api: AccountsApi;
  chain: ChainState;
  onClose: () => void;
  onFresh: (pf: MintPreflight) => void;
  onAddFmx: () => void;
  onMinted: (id: number) => void;
  onSeeYours: () => void;
}) {
  const wallet = api.active;
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const busy = phase.kind === 'checking' || phase.kind === 'submitting' || phase.kind === 'pending';
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const set = (p: Phase) => {
    if (alive.current) setPhase(p);
  };
  const badge = badgeOf(c, piece, status);
  const mine = !!status?.owner && status.owner.toLowerCase() === wallet.address.toLowerCase();
  const sources = useMemo(() => artSources(piece.image, c.base, piece.id, c.ext), [piece.image, c.base, piece.id, c.ext]);

  const transport = () => {
    if (!chain.provider || !chain.rpcUrl) throw new Error('Not connected to the Ferminux Network.');
    return httpBatchTransport(chain.rpcUrl, 12_000);
  };
  const preflight = async (): Promise<MintPreflight> => {
    const pf = await readMintPreflight(transport(), c, piece.id, wallet.address);
    onFresh(pf);
    return pf;
  };

  /** Pre-check → prepare (nonce, gas, fees) → confirm screen. */
  async function review() {
    set({ kind: 'checking' });
    try {
      const pf = await preflight();
      const early = mintProblem(c, pf, wallet.address);
      if (early) return set({ kind: 'problem', problem: early });
      const call = buildMintCall(c, piece.id, pf.price, CHAIN_ID);
      let prepared: PreparedTx;
      try {
        prepared = await prepareTransaction(chain.provider!, CHAIN_ID, wallet.address, call.to, call.value, call.data);
      } catch (e) {
        // The estimate says it would revert. Something changed since the batch: read again and say what.
        const again = await preflight().catch(() => null);
        const why = again && mintProblem(c, again, wallet.address);
        return set(why ? { kind: 'problem', problem: why } : { kind: 'failed', message: e instanceof Error ? shortenError(e.message) : 'Could not prepare the mint.' });
      }
      const withFee = mintProblem(c, pf, wallet.address, { feeWei: prepared.maxFeeWei });
      if (withFee) return set({ kind: 'problem', problem: withFee });
      set({ kind: 'confirm', prepared, pf });
    } catch (e) {
      set({ kind: 'failed', message: e instanceof Error ? shortenError(e.message) : 'Could not check the mint.' });
    }
  }

  /** Check again (another wallet may have minted it, or the price or sale changed), then sign and broadcast. */
  async function submit(prepared: PreparedTx, pf: MintPreflight) {
    set({ kind: 'submitting', prepared, pf, step: 'checking' });
    let fresh: MintPreflight;
    try {
      fresh = await preflight();
    } catch (e) {
      return set({ kind: 'failed', message: `${e instanceof Error ? shortenError(e.message) : 'The mint could not be checked again.'} Nothing was signed.` });
    }
    const late = mintProblem(c, fresh, wallet.address, { feeWei: prepared.maxFeeWei, expectPrice: prepared.valueWei });
    if (late) return set({ kind: 'problem', problem: late });
    set({ kind: 'submitting', prepared, pf: fresh, step: 'signing' });
    let hash: string | undefined;
    try {
      const sent = await signAndBroadcast(wallet.privateKey, chain.provider!, prepared);
      hash = sent.hash;
    } catch (e) {
      return set({ kind: 'failed', message: e instanceof Error ? shortenError(e.message) : 'Broadcast failed.' });
    }
    set({ kind: 'pending', hash });
    // waitForTransaction hands back a reverted receipt as it is (TransactionResponse.wait() throws on one).
    const receipt = await chain.provider!.waitForTransaction(hash, 1, 180_000).catch(() => null);
    if (receipt?.status === 1) {
      onMinted(piece.id);
      return set({ kind: 'done', hash });
    }
    // Reverted, or the receipt could not be read: the chain decides what happened.
    const after = await preflight().catch(() => null);
    if (after?.minted && after.owner?.toLowerCase() === wallet.address.toLowerCase()) {
      onMinted(piece.id);
      return set({ kind: 'done', hash });
    }
    const lost = after ? mintProblem(c, after, wallet.address) : null;
    const reverted = receipt?.status === 0;
    if (lost?.code === 'taken') {
      return set({
        kind: 'problem',
        hash,
        problem: {
          code: 'taken',
          message: reverted
            ? `#${piece.id} was minted by another wallet first. Your transaction reverted: the ${fmx(prepared.valueWei)} was not taken, only the network fee was spent.`
            : `#${piece.id} was minted by another wallet first.`,
        },
      });
    }
    set({
      kind: 'failed',
      hash,
      message: reverted
        ? 'The mint was included in a block but reverted. The price was not taken; only the network fee was spent.'
        : 'The mint was sent but its confirmation could not be read. Check it on the explorer before trying again.',
    });
  }

  const title = piece.name;
  return (
    <Modal title={title} onClose={busy ? () => undefined : onClose} wide>
      <div data-testid="mint-sheet" data-id={piece.id} data-collection={c.key}>
        {(phase.kind === 'idle' || phase.kind === 'checking' || phase.kind === 'problem') && (
          <div className="nft-detail">
            <span className="mint-art">
              <Art sources={sources} image={piece.image} alt={piece.name} sizes={SHEET_SIZES} large eager label={c.symbol} />
            </span>
            <div className="nft-detail-main">
              <div className="label">
                {c.name} · #{piece.id}
              </div>
              {badge && (
                <div style={{ marginTop: 8 }}>
                  <span className={`tier ${badge.cls}`}>{badge.text}</span>
                </div>
              )}
              {piece.description && <p className="small muted" style={{ marginTop: 10, lineHeight: 1.6 }}>{piece.description}</p>}
              {piece.attributes.length > 0 && (
                <details className="details">
                  <summary>
                    Traits <IconChevronDown />
                  </summary>
                  <dl className="nft-attrs">
                    {piece.attributes.map((a) => (
                      <div key={a.trait}>
                        <dt>{a.trait}</dt>
                        <dd>{a.value}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              )}
            </div>
          </div>
        )}

        {(phase.kind === 'idle' || phase.kind === 'checking') && (
          <>
            <hr className="divider" />
            {status?.minted ? (
              <div className="mint-owned" data-testid="mint-owned">
                {mine ? (
                  <>
                    <div className="notice notice-success">This {c.noun} is in {wallet.label}.</div>
                    <button className="btn btn-block" onClick={onSeeYours}>
                      See it in Your NFTs
                    </button>
                  </>
                ) : (
                  <div className="price-line">
                    <span>Owner</span>
                    <a href={explorerAddressUrl(FERMINUX_CHAIN, status.owner ?? '')} target="_blank" rel="noreferrer noopener" className="mono">
                      {shortAddress(status.owner ?? '')} <IconExternal />
                    </a>
                  </div>
                )}
              </div>
            ) : (
              <>
                <div className="price-line" data-testid="mint-price">
                  <span>Price{badge && c.pricing === 'tier' ? ` · ${badge.text}` : ''}</span>
                  <strong className="num">{price !== null ? fmx(price) : '—'}</strong>
                </div>
                {paused && <div className="notice notice-warn">Minting is paused by the contract right now.</div>}
                <p className="small muted">
                  Sent as <span className="mono">mint({piece.id})</span> from {wallet.label} with exactly the price attached, on
                  Ferminux (chain {CHAIN_ID}). The price, the sale and your balance are read again first.
                </p>
                <div className="mint-cta">
                  <button className="btn btn-primary btn-block" data-testid="mint-start" disabled={phase.kind === 'checking' || !chain.provider} onClick={() => void review()}>
                    {phase.kind === 'checking' ? (
                      <>
                        <Spinner /> Checking…
                      </>
                    ) : (
                      `Mint #${piece.id}${price !== null ? ` · ${fmx(price)}` : ''}`
                    )}
                  </button>
                </div>
                {!chain.provider && <div className="field-hint">Minting is disabled while the wallet cannot reach the Ferminux Network.</div>}
              </>
            )}
          </>
        )}

        {phase.kind === 'problem' && (
          <>
            <hr className="divider" />
            <div className={'notice ' + (phase.problem.code === 'yours' ? 'notice-success' : 'notice-warn')} data-testid="mint-problem" data-code={phase.problem.code}>
              {phase.problem.message}
              {phase.problem.code === 'funds' && phase.problem.shortWei !== undefined && (
                <>
                  {' '}
                  Add at least <strong className="num">{fmx(phase.problem.shortWei, 4)}</strong> to {wallet.label}.
                </>
              )}
            </div>
            {phase.hash && <HashLine chain={FERMINUX_CHAIN} hash={phase.hash} />}
            <div className="actions-split">
              {phase.problem.code === 'funds' ? (
                <>
                  <button className="btn" data-testid="mint-retry" onClick={() => void review()}>
                    Check again
                  </button>
                  <button className="btn btn-primary" data-testid="mint-add-fmx" onClick={onAddFmx}>
                    <IconReceive /> Add FMX
                  </button>
                </>
              ) : phase.problem.code === 'yours' ? (
                <button className="btn btn-primary btn-block" style={{ gridColumn: '1 / -1' }} onClick={onSeeYours}>
                  See it in Your NFTs
                </button>
              ) : phase.problem.code === 'taken' || phase.problem.code === 'missing' ? (
                <button className="btn btn-block" style={{ gridColumn: '1 / -1' }} data-testid="mint-back" onClick={onClose}>
                  Back to the collection
                </button>
              ) : (
                <>
                  <button className="btn" onClick={onClose}>
                    Close
                  </button>
                  <button className="btn btn-primary" data-testid="mint-retry" onClick={() => void review()}>
                    {phase.problem.code === 'price-changed' ? 'Review the new price' : 'Check again'}
                  </button>
                </>
              )}
            </div>
          </>
        )}

        {(phase.kind === 'confirm' || phase.kind === 'submitting') && (
          <MintConfirm
            c={c}
            piece={piece}
            wallet={wallet}
            prepared={phase.prepared}
            pf={phase.pf}
            submitting={phase.kind === 'submitting' ? phase.step : null}
            onBack={() => set({ kind: 'idle' })}
            onSign={() => void submit(phase.prepared, phase.pf)}
          />
        )}

        {phase.kind === 'pending' && (
          <div className="tx-state">
            <div className="state-ic">
              <Spinner />
            </div>
            <h3>Mint submitted</h3>
            <p>Waiting for a block on the Ferminux Network (about 7 s)…</p>
            <HashLine chain={FERMINUX_CHAIN} hash={phase.hash} />
          </div>
        )}

        {phase.kind === 'done' && (
          <div data-testid="mint-done">
            <div className="tx-state">
              <div className="state-ic ok">
                <IconCheck />
              </div>
              <h3>Minted</h3>
              <p>
                {piece.name} is now in {wallet.label}.
              </p>
              {phase.hash && (
                <div data-testid="mint-tx">
                  <HashLine chain={FERMINUX_CHAIN} hash={phase.hash} />
                </div>
              )}
            </div>
            <div className="actions-split">
              <button className="btn" onClick={onClose}>
                Keep browsing
              </button>
              <button className="btn btn-primary" data-testid="mint-see-yours" onClick={onSeeYours}>
                See it in Your NFTs
              </button>
            </div>
          </div>
        )}

        {phase.kind === 'failed' && (
          <div data-testid="mint-failed">
            <div className="tx-state">
              <div className="state-ic bad">
                <IconClose />
              </div>
              <h3>Not minted</h3>
              <p style={{ overflowWrap: 'anywhere' }}>{phase.message}</p>
              {phase.hash && <HashLine chain={FERMINUX_CHAIN} hash={phase.hash} />}
            </div>
            <button className="btn btn-block" onClick={() => set({ kind: 'idle' })}>
              Back
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}

/** The confirm screen: the same shape as Send's, plus what was checked. */
function MintConfirm({
  c,
  piece,
  wallet,
  prepared: p,
  pf,
  submitting,
  onBack,
  onSign,
}: {
  c: MintCollection;
  piece: MintPiece;
  wallet: { label: string; address: string };
  prepared: PreparedTx;
  pf: MintPreflight;
  submitting: 'checking' | 'signing' | null;
  onBack: () => void;
  onSign: () => void;
}) {
  const fee = `${formatAmount(p.maxFeeWei, 18, 8)} FMX`;
  const tier = tierName(pf.tier);
  return (
    <div data-testid="mint-review">
      <ChainBanner chain={FERMINUX_CHAIN} />
      <div className="confirm-amount">
        <div className="label">You pay</div>
        <div className="v num" data-testid="mint-confirm-value">
          {formatAmountExact(p.valueWei, 18)}
          <span className="u">FMX</span>
        </div>
        <div className="to">
          to mint <strong>{piece.name}</strong> · {c.name} #{piece.id}
        </div>
      </div>
      <table className="confirm-table">
        <tbody>
          <tr>
            <th>From</th>
            <td>
              {wallet.label} <span className="mono muted">{shortAddress(wallet.address)}</span>
            </td>
          </tr>
          <tr>
            <th>Contract</th>
            <td className="mono" data-testid="mint-confirm-contract">
              {p.to}
            </td>
          </tr>
          <tr>
            <th>Method</th>
            <td className="mono" data-testid="mint-confirm-method">
              {MINT_METHOD} · tokenId {piece.id}
            </td>
          </tr>
          <tr>
            <th>Value</th>
            <td className="num">
              {fmx(p.valueWei, 18)} <span className="muted">· exactly {c.pricing === 'tier' ? `price(${piece.id})` : 'price()'}</span>
            </td>
          </tr>
          <tr>
            <th>Network fee (max)</th>
            <td className="num" data-testid="mint-confirm-fee">
              {fee}
            </td>
          </tr>
          <tr>
            <th>Max total debit</th>
            <td className="em num">{formatAmountExact(p.valueWei + p.maxFeeWei, 18)} FMX</td>
          </tr>
        </tbody>
      </table>
      <ul className="check-list" data-testid="mint-checks" aria-label="Checked just now">
        <li>
          <IconCheck />
          <span>
            #{piece.id} exists on chain{pf.totalIds ? <span className="muted"> · ids 1–{pf.totalIds}</span> : null}
          </span>
        </li>
        <li>
          <IconCheck />
          <span>Not minted yet</span>
        </li>
        <li>
          <IconCheck />
          <span>Sale open</span>
        </li>
        <li>
          <IconCheck />
          <span>
            Price read from the contract: {fmx(pf.price)}
            {tier ? <span className="muted"> · {tier}</span> : null}
          </span>
        </li>
        <li>
          <IconCheck />
          <span>Balance {fmx(pf.balance, 4)} covers the price and the worst-case fee</span>
        </li>
      </ul>
      <details className="details">
        <summary>
          Transaction details <IconChevronDown />
        </summary>
        <table className="confirm-table">
          <tbody>
            <tr>
              <th>Chain ID</th>
              <td className="num">{p.chainId}</td>
            </tr>
            <tr>
              <th>Nonce</th>
              <td className="num">{p.nonce}</td>
            </tr>
            <tr>
              <th>Gas limit</th>
              <td className="num">{p.gasLimit.toString()}</td>
            </tr>
            <tr>
              <th>Fee type</th>
              <td className="num">
                EIP-1559 · max {formatGwei(p.maxFeePerGas)} gwei, tip {formatGwei(p.maxPriorityFeePerGas)} gwei
              </td>
            </tr>
            <tr>
              <th>Calldata</th>
              <td className="mono">{p.data}</td>
            </tr>
          </tbody>
        </table>
      </details>
      <p className="small muted">Review carefully: these are exactly the values that will be signed. The sale is checked once more before signing.</p>
      <div className="actions-split">
        <button className="btn" onClick={onBack} disabled={submitting !== null}>
          Back
        </button>
        <button className="btn btn-primary" data-testid="mint-confirm" onClick={onSign} disabled={submitting !== null}>
          {submitting ? (
            <>
              <Spinner /> {submitting === 'checking' ? 'Checking…' : 'Signing…'}
            </>
          ) : (
            'Sign & mint on Ferminux'
          )}
        </button>
      </div>
    </div>
  );
}
