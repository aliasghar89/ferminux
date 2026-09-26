import fmxMark from '../assets/fmx-mark.svg';
import fmxToken from '../assets/brand/fmx-token.svg';
import type { ChainDef } from '../lib/chains.ts';
import { FERMINUX_CHAIN } from '../lib/chains.ts';

/**
 * A compact network tag. Ferminux carries its own mark (the official file from
 * brand/dist, never redrawn); other networks get a plain text tag — the wallet
 * ships no third-party logos and loads none.
 */
export function ChainBadge({ chain, withName = false }: { chain: ChainDef; withName?: boolean }) {
  const home = chain.id === FERMINUX_CHAIN.id;
  return (
    <span className={'chain-badge' + (withName ? ' chain-badge-named' : '')} title={`${chain.name} · chain ${chain.id}`}>
      {home ? <img src={fmxMark} alt="" className="chain-mark" width={12} height={12} /> : <span className="chain-short">{chain.short}</span>}
      {withName && <span className="chain-name">{chain.name}</span>}
    </span>
  );
}

/**
 * Round glyph for an asset (no remote token logos). FMX uses the brand coin;
 * everything else a monogram. `chain` adds the network tag at the corner, so a
 * USDC on Base never reads as the USDC on BNB Smart Chain.
 */
export function AssetGlyph({
  symbol,
  native,
  home,
  chain,
  large,
}: {
  symbol: string;
  native: boolean;
  home: boolean;
  chain?: ChainDef;
  large?: boolean;
}) {
  const size = large ? ' asset-glyph-lg' : '';
  const corner = chain ? (
    <span className="glyph-chain" aria-hidden="true">
      {chain.id === FERMINUX_CHAIN.id ? <img src={fmxMark} alt="" width={10} height={10} /> : chain.short}
    </span>
  ) : null;
  if (native && home) {
    return (
      <span className={'asset-glyph asset-glyph-mark' + size} aria-hidden="true">
        <img src={fmxToken} alt="" width={large ? 56 : 40} height={large ? 56 : 40} />
      </span>
    );
  }
  const letters = symbol.replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase() || '?';
  return (
    <span className={'asset-glyph' + (native ? ' asset-glyph-native' : '') + size} aria-hidden="true">
      {letters}
      {corner}
    </span>
  );
}
