import type { ReactNode } from 'react';
import { formatAmount, shortAddress } from '../lib/amounts.ts';
import { payAddressUrl, payChain, payTxUrl, type PayAsset, type PayChain, type PayChainKey } from '../lib/payin.ts';
import { IconCheck, IconExternal } from './icons.tsx';

/**
 * A paying network's tag: its short name in mono on a hairline chip. The DEX,
 * like the Ferminux Wallet, ships no third-party logos and loads none, so a
 * network is always named in text.
 */
export function NetTag({ chain, named }: { chain: PayChain; named?: boolean }) {
  return (
    <span className={'net-tag' + (named ? ' net-tag-named' : '')} title={`${chain.name} · chain ${chain.chainId}`}>
      <span className="net-short">{chain.short}</span>
      {named && <span className="net-name">{chain.name}</span>}
    </span>
  );
}

/** A coin on another network: its symbol as a monogram, the network tag on its corner. */
export function PayCoin({ asset, chain, size = 32 }: { asset: PayAsset; chain: PayChain; size?: number }) {
  const letters = asset.symbol.slice(0, 4);
  return (
    <span className="pay-coin" style={{ width: size, height: size }} aria-hidden="true">
      <span className={'coin coin-mono pay-coin-face' + (asset.kind === 'native' ? ' is-native' : '')} style={{ width: size, height: size, fontSize: Math.max(8, Math.round(size / (letters.length + 1.2))) }}>
        {letters}
      </span>
      <span className="pay-coin-net">{chain.short}</span>
    </span>
  );
}

/** Amount of a coin on another network, truncated, never rounded up. */
export function payAmount(units: bigint, asset: Pick<PayAsset, 'decimals'>, digits = 6): string {
  return formatAmount(units, asset.decimals, digits);
}

export function PayTxLink({ chain, hash, label }: { chain: PayChainKey; hash: string; label?: ReactNode }) {
  const url = payTxUrl(chain, hash);
  if (!url) return <span className="mono">{shortAddress(hash, 8, 6)}</span>;
  return (
    <a className="mono ext-link" href={url} target="_blank" rel="noreferrer noopener" title={hash}>
      {label ?? shortAddress(hash, 8, 6)}
      <IconExternal />
    </a>
  );
}

export function PayAddressLink({ chain, address }: { chain: PayChainKey; address: string }) {
  const url = payAddressUrl(chain, address);
  const c = payChain(chain);
  if (!url || !c) return <span className="mono break">{address}</span>;
  return (
    <a className="mono ext-link break" href={url} target="_blank" rel="noreferrer noopener" title={`${address} on ${c.name}`}>
      {address}
      <IconExternal />
    </a>
  );
}

export interface StepItem {
  label: ReactNode;
  detail?: ReactNode;
  state: 'done' | 'current' | 'todo' | 'bad';
}

/** The pay-in's four steps, top to bottom, with what each one has to show. */
export function PaySteps({ items, label }: { items: StepItem[]; label: string }) {
  return (
    <ol className="pay-steps" aria-label={label}>
      {items.map((it, i) => (
        <li key={i} className={'pay-step is-' + it.state} aria-current={it.state === 'current' ? 'step' : undefined}>
          <span className="pay-step-dot mono" aria-hidden="true">
            {it.state === 'done' ? <IconCheck /> : i + 1}
          </span>
          <span className="pay-step-body">
            <span className="pay-step-label">{it.label}</span>
            {it.detail && <span className="pay-step-detail">{it.detail}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** mm:ss, or "0:00" once it has run out. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
