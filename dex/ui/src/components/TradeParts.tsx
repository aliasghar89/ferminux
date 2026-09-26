import type { ReactNode } from 'react';
import { DEX_ADDRESSES } from '../config.ts';
import { formatAmount } from '../lib/amounts.ts';
import { FEE_BPS } from '../lib/math.ts';
import type { TokenInfo } from '../lib/tokens.ts';
import { IconChevronDown } from './icons.tsx';
import { TokenLogo } from './TokenLogo.tsx';

/**
 * One side of a trade: the amount (typed, or quoted and read-only), the token
 * button, the balance with Max, and the USD value at the stated basis.
 */
export function TokenAmountField({
  label,
  token,
  onPickToken,
  value,
  onChange,
  readOnly,
  pending,
  balance,
  onMax,
  usd,
  error,
  testId,
}: {
  label: string;
  token: TokenInfo | null;
  onPickToken: () => void;
  value: string;
  onChange?: (text: string) => void;
  readOnly?: boolean;
  /** A quote is being fetched for this (read-only) field. */
  pending?: boolean;
  balance: bigint | undefined;
  onMax?: () => void;
  usd: string | null;
  error?: ReactNode;
  testId?: string;
}) {
  return (
    <div className={'field-box' + (error ? ' has-error' : '')} data-testid={testId}>
      <div className="field-box-head">
        <span className="field-box-label">{label}</span>
        {token && balance !== undefined && (
          <span className="field-box-balance">
            <span className="bal-word">Balance</span> <span className="mono">{formatAmount(balance, token.decimals, 4)}</span>
            {onMax && balance > 0n && (
              <button type="button" className="max-btn" onClick={onMax}>
                Max
              </button>
            )}
          </span>
        )}
      </div>
      <div className="field-box-row">
        {readOnly ? (
          <output className={'amount-input amount-output' + (pending ? ' is-pending' : '') + (value ? '' : ' is-empty')} aria-live="polite" aria-label={`${label} amount`}>
            {value || '0'}
          </output>
        ) : (
          <input
            className="amount-input"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            placeholder="0"
            value={value}
            onChange={(e) => onChange?.(e.target.value.replace(',', '.'))}
            aria-label={`${label} amount${token ? ` in ${token.symbol}` : ''}`}
          />
        )}
        <button type="button" className={'token-btn' + (token ? '' : ' is-empty')} onClick={onPickToken} aria-label={token ? `${label} token: ${token.symbol}. Change` : `Select the ${label.toLowerCase()} token`}>
          {token && <TokenLogo token={token} size={24} />}
          <span>{token ? token.symbol : 'Select token'}</span>
          <IconChevronDown />
        </button>
      </div>
      <div className="field-box-foot">
        <span className="mono faint">{usd ?? ' '}</span>
      </div>
      {error && <div className="field-error">{error}</div>}
    </div>
  );
}

/**
 * The route as it will execute: each token a node, each pool an edge carrying
 * its 0.30% fee, on the ferminux.net beam line.
 */
export function RouteTrace({ tokens, testId }: { tokens: Array<Pick<TokenInfo, 'kind' | 'address' | 'symbol'>>; testId?: string }) {
  return (
    <ol className="route" data-testid={testId} aria-label={`Route: ${tokens.map((t) => t.symbol).join(' to ')}`}>
      {tokens.map((t, i) => (
        <li key={`${t.symbol}-${i}`} className="route-step">
          {i > 0 && (
            <span className="route-edge" aria-hidden="true">
              <span className="route-beam" />
              <span className="route-fee mono">{(FEE_BPS / 100).toFixed(2)}%</span>
            </span>
          )}
          <span className="route-node">
            <TokenLogo token={t} size={18} />
            <span className="mono">{t.symbol}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Tokens along a route path (addresses), with native FMX at an end kept as FMX. */
export function routeTokens(path: string[], tokenIn: TokenInfo, tokenOut: TokenInfo, known: TokenInfo[]): TokenInfo[] {
  return path.map((address, i) => {
    if (i === 0) return tokenIn;
    if (i === path.length - 1) return tokenOut;
    const hit =
      known.find((t) => t.kind === 'erc20' && t.address.toLowerCase() === address.toLowerCase()) ??
      ({ kind: 'erc20', address, symbol: address.slice(0, 6), name: address, decimals: 18 } as TokenInfo);
    // An intermediate WFMX hop is FMX in the pool's own clothes.
    return hit.address.toLowerCase() === DEX_ADDRESSES.wfmx.toLowerCase() ? { ...hit, symbol: 'FMX' } : hit;
  });
}
