import { useCallback, useEffect, useMemo, useState } from 'react';
import type { JsonRpcProvider } from 'ethers';
import { DEX_ADDRESSES, isCanonicalToken } from '../config.ts';
import { MobileHandoff } from '../components/MobileHandoff.tsx';
import { Notice, Spinner, StatRow, TxStatus, type TxPhase } from '../components/ui.tsx';
import {
  formatAmount,
  formatFull,
  formatPpmPercent,
  parseAmount,
  priceFromReserves,
} from '../lib/amounts.ts';
import { maxNativeSpendable } from '../lib/gas.ts';
import { addLiquidity, createPair, quoteAddLiquidity, type AddLiquidityQuote } from '../lib/liquidity.ts';
import { orientedReserves, pairKey, type PairSnapshot } from '../lib/pairs.ts';
import { isFactoryToken } from '../lib/registry.ts';
import { approveToken, fetchAllowance, sameToken, tokenKey, type TokenInfo } from '../lib/tokens.ts';
import { readableError } from '../lib/wallet.ts';
import type { PoolsState } from '../state/usePools.ts';
import type { WalletSession } from '../state/useWallet.ts';
import { TokenSelect } from './TokenSelect.tsx';
import { DEFAULT_TRADE_SETTINGS, TradeSettings, type TradeSettingsValue } from './TradeSettings.tsx';

/**
 * Add liquidity — into an existing pool at its current ratio, or into a new
 * one where the depositor sets the opening price.
 */
export function AddLiquidity({
  provider,
  pools,
  wallet,
  tokens,
  balances,
  onImportToken,
  onChainChanged,
}: {
  provider: JsonRpcProvider | null;
  pools: PoolsState;
  wallet: WalletSession;
  tokens: TokenInfo[];
  balances: Map<string, bigint>;
  onImportToken: (token: TokenInfo) => void;
  onChainChanged: () => void;
}) {
  const [tokenA, setTokenA] = useState<TokenInfo | null>(null);
  const [tokenB, setTokenB] = useState<TokenInfo | null>(null);
  const [textA, setTextA] = useState('');
  const [textB, setTextB] = useState('');
  const [side, setSide] = useState<'A' | 'B'>('A');
  const [settings, setSettings] = useState<TradeSettingsValue>(DEFAULT_TRADE_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selecting, setSelecting] = useState<'A' | 'B' | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [shortfallA, setShortfallA] = useState<bigint | null>(null);
  const [shortfallB, setShortfallB] = useState<bigint | null>(null);
  const [unverified, setUnverified] = useState<TokenInfo[]>([]);
  const [phase, setPhase] = useState<TxPhase>({ state: 'idle' });
  const [error, setError] = useState<string | null>(null);

  // Default to a pair that already has a pool, so the panel opens on the
  // ordinary "deposit at the current ratio" case rather than the new-pool one.
  useEffect(() => {
    if (tokenA || tokens.length === 0) return;
    const native = tokens.find((t) => t.kind === 'native') ?? tokens[0];
    setTokenA(native);
    const others = tokens.filter((t) => t.kind !== 'native' && t.symbol !== 'WFMX');
    const pooled = others.find((t) => pools.index.has(pairKey(native.address, t.address)));
    setTokenB(pooled ?? others[0] ?? null);
  }, [tokens, tokenA, pools.index]);

  const snapshot: PairSnapshot | null = useMemo(() => {
    if (!tokenA || !tokenB) return null;
    return pools.index.get(pairKey(tokenA.address, tokenB.address)) ?? null;
  }, [pools.index, tokenA, tokenB]);

  const poolIsEmpty = !snapshot || snapshot.reserve0 <= 0n || snapshot.reserve1 <= 0n || snapshot.totalSupply <= 0n;

  const parsedA = tokenA ? parseAmount(textA, tokenA.decimals) : null;
  const parsedB = tokenB ? parseAmount(textB, tokenB.decimals) : null;
  const amountA = parsedA?.ok ? parsedA.wei : 0n;
  const amountB = parsedB?.ok ? parsedB.wei : 0n;

  // ---- the counterpart amount is derived, never typed, in a live pool ----
  const quote: AddLiquidityQuote | null = useMemo(() => {
    if (!tokenA || !tokenB) return null;
    try {
      if (poolIsEmpty) {
        if (amountA <= 0n || amountB <= 0n) return null;
        return quoteAddLiquidity(snapshot, tokenA, tokenB, 'A', amountA, settings.slippageBps, amountB);
      }
      const typed = side === 'A' ? amountA : amountB;
      if (typed <= 0n) return null;
      return quoteAddLiquidity(snapshot, tokenA, tokenB, side, typed, settings.slippageBps);
    } catch {
      return null;
    }
  }, [snapshot, poolIsEmpty, tokenA, tokenB, side, amountA, amountB, settings.slippageBps]);

  // Mirror the derived side back into the input the user is not typing in.
  useEffect(() => {
    if (!quote || poolIsEmpty || !tokenA || !tokenB) return;
    if (side === 'A') {
      const next = formatFull(quote.amountB, tokenB.decimals);
      setTextB((current) => (current === next ? current : next));
    } else {
      const next = formatFull(quote.amountA, tokenA.decimals);
      setTextA((current) => (current === next ? current : next));
    }
  }, [quote, poolIsEmpty, side, tokenA, tokenB]);

  const refreshAllowances = useCallback(async () => {
    if (!provider || !wallet.address || !tokenA || !tokenB || !quote) {
      setShortfallA(null);
      setShortfallB(null);
      return;
    }
    try {
      const [allowA, allowB] = await Promise.all([
        fetchAllowance(provider, tokenA, wallet.address, DEX_ADDRESSES.router),
        fetchAllowance(provider, tokenB, wallet.address, DEX_ADDRESSES.router),
      ]);
      setShortfallA(allowA >= quote.amountA ? 0n : quote.amountA - allowA);
      setShortfallB(allowB >= quote.amountB ? 0n : quote.amountB - allowB);
    } catch {
      setShortfallA(null);
      setShortfallB(null);
    }
  }, [provider, wallet.address, tokenA, tokenB, quote]);

  useEffect(() => {
    void refreshAllowances();
  }, [refreshAllowances]);

  // Flag any deposited ERC-20 that is neither first-party nor TokenFactory-minted.
  // Everything else is a bring-your-own contract that could skim the asset you
  // pair against it. "unknown" (registry unreadable) is treated as NOT verified —
  // we never mark a token safe on a failed check.
  useEffect(() => {
    let cancelled = false;
    // First-party tokens are excluded from the check entirely rather than
    // failing it. AZNT, USDF and WFMX were deployed by this project and are
    // administered by its multisig; none came from the TokenFactory, so
    // isFactoryToken correctly returns false for all of them. Letting that
    // stand told users the chain's own stablecoin was an untrusted contract,
    // which is both wrong and the kind of warning that trains people to
    // dismiss warnings.
    const candidates = [tokenA, tokenB].filter(
      (t): t is TokenInfo => !!t && t.kind === 'erc20' && !isCanonicalToken(t.address),
    );
    if (!provider || candidates.length === 0) {
      setUnverified([]);
      return;
    }
    (async () => {
      const flags = await Promise.all(candidates.map((t) => isFactoryToken(provider, t.address)));
      if (cancelled) return;
      setUnverified(candidates.filter((_, i) => flags[i] !== true));
    })();
    return () => {
      cancelled = true;
    };
  }, [provider, tokenA, tokenB]);

  const balanceA = tokenA ? balances.get(tokenKey(tokenA)) : undefined;
  const balanceB = tokenB ? balances.get(tokenKey(tokenB)) : undefined;
  const shortA = balanceA !== undefined && quote ? quote.amountA > balanceA : false;
  const shortB = balanceB !== undefined && quote ? quote.amountB > balanceB : false;

  const currentPrice =
    snapshot && !poolIsEmpty && tokenA && tokenB
      ? priceFromReserves(
          orientedReserves(snapshot, tokenA.address).own,
          tokenA.decimals,
          orientedReserves(snapshot, tokenA.address).other,
          tokenB.decimals,
          6,
        )
      : null;

  const openingPrice =
    poolIsEmpty && quote && tokenA && tokenB
      ? priceFromReserves(quote.amountA, tokenA.decimals, quote.amountB, tokenB.decimals, 6)
      : null;

  const busy = phase.state === 'signing' || phase.state === 'pending';
  const canTrade = Boolean(wallet.wallet) && !wallet.wrongChain;

  const runTx = async (send: () => Promise<{ hash: string; wait: () => Promise<unknown> }>, doneMessage: string) => {
    setPhase({ state: 'signing' });
    setError(null);
    try {
      const tx = await send();
      setPhase({ state: 'pending', hash: tx.hash });
      await tx.wait();
      setPhase({ state: 'done', hash: tx.hash, message: doneMessage });
      onChainChanged();
      void refreshAllowances();
    } catch (err) {
      setPhase({ state: 'error', message: readableError(err) });
    }
  };

  const doApprove = async (which: 'A' | 'B') => {
    const token = which === 'A' ? tokenA : tokenB;
    const amount = which === 'A' ? quote?.amountA : quote?.amountB;
    if (!wallet.wallet || !token || !amount) return;
    await runTx(
      () => approveToken(wallet.wallet!.signer, token, DEX_ADDRESSES.router, amount),
      `Approved ${formatAmount(amount, token.decimals)} ${token.symbol} for the router.`,
    );
  };

  const doAdd = async () => {
    if (!wallet.wallet || !quote || !wallet.address) return;
    await runTx(
      () => addLiquidity(wallet.wallet!.signer, DEX_ADDRESSES, quote, wallet.address!, settings.deadlineMinutes),
      poolIsEmpty
        ? `Pool created and seeded with ${formatAmount(quote.amountA, quote.tokenA.decimals)} ${
            quote.tokenA.symbol
          } + ${formatAmount(quote.amountB, quote.tokenB.decimals)} ${quote.tokenB.symbol}.`
        : `Added ${formatAmount(quote.amountA, quote.tokenA.decimals)} ${quote.tokenA.symbol} + ${formatAmount(
            quote.amountB,
            quote.tokenB.decimals,
          )} ${quote.tokenB.symbol}.`,
    );
    setTextA('');
    setTextB('');
    setAcknowledged(false);
  };

  const doCreateEmptyPair = async () => {
    if (!wallet.wallet || !tokenA || !tokenB) return;
    await runTx(
      () => createPair(wallet.wallet!.signer, DEX_ADDRESSES, tokenA, tokenB),
      `Created an empty ${tokenA.symbol}/${tokenB.symbol} pool. It has no price until someone deposits.`,
    );
  };

  const needsApprovalA = shortfallA !== null && shortfallA > 0n;
  const needsApprovalB = shortfallB !== null && shortfallB > 0n;

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2>Add liquidity</h2>
          <span className="spacer" />
          <button className="btn btn-ghost btn-sm" onClick={() => setSettingsOpen((v) => !v)} aria-expanded={settingsOpen}>
            Settings
          </button>
        </div>

        {settingsOpen && (
          <div className="panel-inset">
            <TradeSettings value={settings} onChange={setSettings} idPrefix="liq" />
          </div>
        )}

        <div className="panel-body">
          <TxStatus phase={phase} onDismiss={() => setPhase({ state: 'idle' })} />
          {error && (
            <Notice kind="danger" role="alert">
              {error}
            </Notice>
          )}

          {unverified.length > 0 && (
            <Notice kind="warn" role="alert">
              <strong>
                {unverified.map((t) => t.symbol).join(' and ')}{' '}
                {unverified.length > 1 ? 'are not official tokens' : 'is not an official token'}.
              </strong>{' '}
              {unverified.length > 1 ? 'They were' : 'It was'} not created by the Ferminux TokenFactory, so the
              contract can behave however its author wrote it. The router will reject a deposit that would hand you
              dust LP for the asset you pair — but no router check can make an untrusted token safe to hold: the token
              controls its own side of the pool permanently, and can mint, tax, blacklist or freeze at any time after
              your deposit settles. Only add liquidity against a token you would trust holding outright.
            </Notice>
          )}

          <div className="amount-box">
            <div className="amount-head">
              <span>Deposit</span>
              <span className="push">
                {balanceA !== undefined && tokenA && (
                  <>
                    Balance <span className="num">{formatAmount(balanceA, tokenA.decimals, 6)}</span>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={async () => {
                        if (!tokenA || balanceA === undefined) return;
                        setSide('A');
                        if (tokenA.kind !== 'native') {
                          setTextA(formatFull(balanceA, tokenA.decimals));
                          return;
                        }
                        const fee = (await provider?.getFeeData())?.maxFeePerGas ?? null;
                        setTextA(formatFull(maxNativeSpendable(balanceA, fee), tokenA.decimals));
                      }}
                    >
                      Max
                    </button>
                  </>
                )}
              </span>
            </div>
            <div className="amount-row">
              <input
                className="amount-input num"
                inputMode="decimal"
                placeholder="0.0"
                value={textA}
                onChange={(e) => {
                  setSide('A');
                  setTextA(e.target.value);
                }}
                aria-label={`Amount of ${tokenA?.symbol ?? 'token A'}`}
              />
              <button className="token-button" onClick={() => setSelecting('A')}>
                {tokenA ? tokenA.symbol : 'Select'} <span className="caret">▾</span>
              </button>
            </div>
            {parsedA && !parsedA.ok && textA.trim() !== '' && <p className="field-error">{parsedA.error}</p>}
            {shortA && tokenA && <p className="field-error">More than your {tokenA.symbol} balance.</p>}
          </div>

          <div className="flip-row">
            <span className="plus-mark" aria-hidden="true">
              +
            </span>
          </div>

          <div className="amount-box">
            <div className="amount-head">
              <span>Deposit</span>
              <span className="push">
                {balanceB !== undefined && tokenB && (
                  <>
                    Balance <span className="num">{formatAmount(balanceB, tokenB.decimals, 6)}</span>
                  </>
                )}
              </span>
            </div>
            <div className="amount-row">
              <input
                className="amount-input num"
                inputMode="decimal"
                placeholder="0.0"
                value={textB}
                onChange={(e) => {
                  setSide('B');
                  setTextB(e.target.value);
                }}
                aria-label={`Amount of ${tokenB?.symbol ?? 'token B'}`}
              />
              <button className="token-button" onClick={() => setSelecting('B')}>
                {tokenB ? tokenB.symbol : 'Select'} <span className="caret">▾</span>
              </button>
            </div>
            {parsedB && !parsedB.ok && textB.trim() !== '' && <p className="field-error">{parsedB.error}</p>}
            {shortB && tokenB && <p className="field-error">More than your {tokenB.symbol} balance.</p>}
          </div>

          {/* ---------------- existing pool ---------------- */}
          {!poolIsEmpty && snapshot && tokenA && tokenB && (
            <div className="quote-box">
              <StatRow
                label="Pool price"
                value={`1 ${tokenA.symbol} = ${currentPrice ?? '—'} ${tokenB.symbol}`}
                hint="The pool's current ratio. Your deposit must match it exactly — the second amount is computed, not chosen."
              />
              <StatRow
                label="Pool depth"
                value={`${formatAmount(orientedReserves(snapshot, tokenA.address).own, tokenA.decimals, 4)} ${
                  tokenA.symbol
                } · ${formatAmount(orientedReserves(snapshot, tokenA.address).other, tokenB.decimals, 4)} ${tokenB.symbol}`}
              />
              {quote && (
                <>
                  <StatRow
                    label="LP tokens minted"
                    value={quote.lpMinted !== null ? formatAmount(quote.lpMinted, 18, 8) : '—'}
                    hint="Your claim on the pool. Burn them to take your share of the reserves back."
                  />
                  <StatRow
                    label="Minimum LP received"
                    value={formatAmount(quote.minLiquidity, 18, 8)}
                    hint="The router reverts unless it delivers at least this many LP tokens to you — your expected LP less slippage. It is what stops a hostile token taking your deposit and returning dust."
                  />
                  <StatRow label="Share of pool after deposit" value={formatPpmPercent(quote.shareOfPoolPpm, 4)} />
                  <StatRow
                    label="Minimum deposited"
                    value={`${formatAmount(quote.amountAMin, tokenA.decimals, 6)} ${tokenA.symbol} · ${formatAmount(
                      quote.amountBMin,
                      tokenB.decimals,
                      6,
                    )} ${tokenB.symbol}`}
                    hint="If the ratio moves further than your slippage tolerance before the transaction lands, the router reverts."
                  />
                </>
              )}
            </div>
          )}

          {/* ---------------- new pool ---------------- */}
          {poolIsEmpty && tokenA && tokenB && !sameToken(tokenA, tokenB) && (
            <div className="new-pool-box">
              <h3 className="new-pool-title">
                {snapshot ? 'This pool exists but is empty' : `No ${tokenA.symbol}/${tokenB.symbol} pool exists yet`}
              </h3>
              <p className="small">
                You would be the first depositor. <strong>The ratio you deposit becomes the price</strong> — there is no
                order book and no oracle behind it, only what the pool holds.
              </p>
              <p className="small">
                If that ratio is not the real market price, arbitrage traders will immediately buy the cheap side until
                the pool matches the market. That profit comes out of your deposit. Depositing at half the true price is
                not a discount you keep; it is a payment to whoever notices first.
              </p>
              {openingPrice && (
                <div className="quote-box" style={{ marginTop: 12 }}>
                  <StatRow label="Opening price you are setting" value={`1 ${tokenA.symbol} = ${openingPrice} ${tokenB.symbol}`} />
                  <StatRow
                    label="Inverse"
                    value={`1 ${tokenB.symbol} = ${
                      priceFromReserves(quote!.amountB, tokenB.decimals, quote!.amountA, tokenA.decimals, 6) ?? '—'
                    } ${tokenA.symbol}`}
                  />
                  <StatRow label="Your share of the pool" value="100%" hint="Until someone else deposits." />
                </div>
              )}
              <label className="check-row" style={{ marginTop: 12 }}>
                <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
                <span>
                  I understand that I am setting the opening price, and that a wrong ratio will be arbitraged away at my
                  expense.
                </span>
              </label>
            </div>
          )}

          {tokenA && tokenB && sameToken(tokenA, tokenB) && (
            <Notice kind="danger">A pool needs two different tokens.</Notice>
          )}

          {/* ---------------- actions ---------------- */}
          <div className="action-stack">
            {!wallet.hasInjected && (
              <MobileHandoff hasInjected={wallet.hasInjected} lede="Adding liquidity needs a wallet." />
            )}
            {!wallet.wallet && wallet.hasInjected && (
              <button className="btn btn-primary btn-block btn-lg" onClick={() => void wallet.connect()}>
                Connect wallet
              </button>
            )}
            {wallet.wallet && wallet.wrongChain && (
              <button className="btn btn-primary btn-block btn-lg" onClick={() => void wallet.switchChain()}>
                Switch to Ferminux (3961)
              </button>
            )}
            {canTrade && needsApprovalA && tokenA && (
              <button className="btn btn-block" disabled={busy} onClick={() => void doApprove('A')}>
                {busy ? <Spinner /> : null} Approve {tokenA.symbol}
              </button>
            )}
            {canTrade && needsApprovalB && tokenB && (
              <button className="btn btn-block" disabled={busy} onClick={() => void doApprove('B')}>
                {busy ? <Spinner /> : null} Approve {tokenB.symbol}
              </button>
            )}
            {canTrade && (
              <button
                className="btn btn-primary btn-block btn-lg"
                disabled={
                  busy ||
                  !quote ||
                  needsApprovalA ||
                  needsApprovalB ||
                  shortA ||
                  shortB ||
                  (poolIsEmpty && !acknowledged)
                }
                onClick={() => void doAdd()}
              >
                {busy ? <Spinner /> : null}
                {!quote
                  ? poolIsEmpty
                    ? 'Enter both amounts'
                    : 'Enter an amount'
                  : poolIsEmpty
                    ? 'Create pool and deposit'
                    : 'Add liquidity'}
              </button>
            )}
            {canTrade && poolIsEmpty && !snapshot && tokenA && tokenB && !sameToken(tokenA, tokenB) && (
              <button className="btn btn-ghost btn-block btn-sm" disabled={busy} onClick={() => void doCreateEmptyPair()}>
                Create the empty pool only (no deposit)
              </button>
            )}
          </div>
        </div>
      </section>

      {selecting && (
        <TokenSelect
          tokens={tokens}
          balances={balances}
          provider={provider}
          exclude={selecting === 'A' ? tokenB : tokenA}
          onImport={onImportToken}
          onSelect={(token) => {
            if (selecting === 'A') setTokenA(token);
            else setTokenB(token);
            setSelecting(null);
            setTextA('');
            setTextB('');
            setAcknowledged(false);
          }}
          onClose={() => setSelecting(null)}
        />
      )}
    </>
  );
}
