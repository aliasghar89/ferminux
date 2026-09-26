import { DEX_ADDRESSES } from '../config.ts';
import { logoFor, type LogoKey } from '../lib/tokenlist.ts';
import type { TokenInfo } from '../lib/tokens.ts';
import fmxLogo from '../assets/tokens/fmx-round.svg';
import azntLogo from '../assets/tokens/aznt-round.svg';
import usdfLogo from '../assets/tokens/usdf-round.svg';

const FILES: Record<LogoKey, string> = { fmx: fmxLogo, aznt: azntLogo, usdf: usdfLogo };

/**
 * A token's coin: the registry's logo for listed tokens, a two-letter
 * monogram for anything else. WFMX shows the FMX coin with a small ring, so
 * the wrapper is never mistaken for the coin itself.
 */
export function TokenLogo({ token, size = 24 }: { token: Pick<TokenInfo, 'kind' | 'address' | 'symbol'>; size?: number }) {
  const key = logoFor(token, DEX_ADDRESSES.wfmx);
  const wrapped = token.kind === 'erc20' && token.address.toLowerCase() === DEX_ADDRESSES.wfmx.toLowerCase();
  const style = { width: size, height: size };
  if (key) {
    return (
      <span className={'coin' + (wrapped ? ' coin-wrapped' : '')} style={style} aria-hidden="true">
        <img src={FILES[key]} alt="" width={size} height={size} draggable={false} />
      </span>
    );
  }
  return (
    <span className="coin coin-mono" style={{ ...style, fontSize: Math.max(9, Math.round(size * 0.38)) }} aria-hidden="true">
      {token.symbol.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?'}
    </span>
  );
}

/** Two coins overlapping, for a pool. */
export function PairLogos({ a, b, size = 24 }: { a: Pick<TokenInfo, 'kind' | 'address' | 'symbol'>; b: Pick<TokenInfo, 'kind' | 'address' | 'symbol'>; size?: number }) {
  return (
    <span className="pair-coins" style={{ width: size * 1.7, height: size }} aria-hidden="true">
      <TokenLogo token={a} size={size} />
      <TokenLogo token={b} size={size} />
    </span>
  );
}
