import { useMemo } from 'react';
import { identicon, IDENTICON_GRID } from '../lib/identicon.ts';

/**
 * Address identicon: inline SVG built from a locally computed spec. Nothing is
 * fetched, so it renders offline and reveals no address to any third party.
 */
export function Identicon({ address, size = 26 }: { address: string; size?: number }) {
  const spec = useMemo(() => identicon(address), [address]);
  const unit = 100 / IDENTICON_GRID;

  return (
    <svg
      className="identicon"
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="img"
      aria-label={`Identicon for ${address}`}
      style={{ borderRadius: size <= 20 ? 3 : 4 }}
    >
      <rect x="0" y="0" width="100" height="100" fill={spec.background} />
      {spec.cells.map((on, i) =>
        on ? (
          <rect
            key={i}
            x={(i % IDENTICON_GRID) * unit}
            y={Math.floor(i / IDENTICON_GRID) * unit}
            width={unit}
            height={unit}
            fill={i === spec.spotIndex ? spec.spotColor : spec.color}
          />
        ) : null,
      )}
    </svg>
  );
}
