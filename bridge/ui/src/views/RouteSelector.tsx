import { CHAINS, isChainLive, type ChainConfig } from '../config.ts';

/**
 * From / To chain selection. A chain with no configured bridge address is
 * listed but disabled and labelled "coming soon" — hiding it would be less
 * honest than showing that the route exists in the design but not on chain yet.
 */
export function RouteSelector({
  src,
  dst,
  disabled,
  onChange,
}: {
  src: ChainConfig;
  dst: ChainConfig;
  disabled?: boolean;
  onChange: (src: ChainConfig, dst: ChainConfig) => void;
}) {
  const live = CHAINS.filter(isChainLive);
  const canSwap = live.length >= 2;

  function pick(side: 'src' | 'dst', key: string) {
    const chosen = CHAINS.find((c) => c.key === key);
    if (!chosen || !isChainLive(chosen)) return;
    if (side === 'src') {
      // Picking the current destination as the source swaps the route rather
      // than producing an impossible same-chain pair.
      onChange(chosen, chosen.key === dst.key ? src : dst);
    } else {
      onChange(chosen.key === src.key ? dst : src, chosen);
    }
  }

  return (
    <div className="route">
      <ChainSelect id="route-from" label="From" value={src.key} disabled={disabled} onPick={(k) => pick('src', k)} />
      <button
        type="button"
        className="route-swap"
        aria-label={`Swap direction — send from ${dst.name} to ${src.name}`}
        title="Swap direction"
        disabled={disabled || !canSwap}
        onClick={() => onChange(dst, src)}
      >
        <span className="swap-glyph" aria-hidden="true">
          ⇄
        </span>
      </button>
      <ChainSelect id="route-to" label="To" value={dst.key} disabled={disabled} onPick={(k) => pick('dst', k)} />
    </div>
  );
}

function ChainSelect({
  id,
  label,
  value,
  disabled,
  onPick,
}: {
  id: string;
  label: string;
  value: string;
  disabled?: boolean;
  onPick: (key: string) => void;
}) {
  return (
    <div className="field mb-0">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        className="input"
        value={value}
        disabled={disabled}
        onChange={(e) => onPick(e.target.value)}
      >
        {CHAINS.map((c) => (
          <option key={c.key} value={c.key} disabled={!isChainLive(c)}>
            {isChainLive(c) ? `${c.name} · ${c.chainId}` : `${c.name} — coming soon`}
          </option>
        ))}
      </select>
    </div>
  );
}
