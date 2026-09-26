import { useId, useMemo } from 'react';
import { Notice } from '../components/ui.tsx';
import { NetTag, payAmount } from '../components/PayParts.tsx';
import { PAY_CHAINS, balanceOf, type PayBalances, type PayChainKey, type PaySelection } from '../lib/payin.ts';
import type { PayAssetsState } from '../state/usePayin.ts';

/**
 * The token picker's "Other networks": USDT, USDC and the network's own coin
 * on each of the seven networks the pay-in takes, with the connected wallet's
 * balance there when it can be read. Picking one turns Swap into "Buy FMX
 * with <coin> on <network>". A network the pay-in is not taking right now is
 * shown, paused, with its reason.
 */
export function PayNetworks({
  query,
  assets,
  balances,
  connected,
  selected,
  onSelect,
}: {
  query: string;
  assets: PayAssetsState;
  balances: Partial<Record<PayChainKey, PayBalances>>;
  connected: boolean;
  selected: PaySelection | null;
  onSelect: (s: PaySelection) => void;
}) {
  const headId = useId();
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (/^0x[0-9a-f]{4,}/.test(q)) return [];
    return PAY_CHAINS.map((chain) => {
      if (!q) return { chain, list: chain.assets };
      const netHit = chain.name.toLowerCase().includes(q) || chain.short.toLowerCase() === q || chain.key.includes(q);
      const list = netHit ? chain.assets : chain.assets.filter((a) => a.symbol.toLowerCase().includes(q) || a.name.toLowerCase().includes(q));
      return { chain, list };
    }).filter((r) => r.list.length > 0);
  }, [query]);

  if (rows.length === 0) return null;
  const info = assets.info;

  return (
    <section className="pay-networks" aria-labelledby={headId} data-testid="pay-networks">
      <div className="picker-section-head">
        <h3 id={headId} className="picker-section-title">
          Other networks
        </h3>
        <span className="faint small">buy FMX with them</span>
      </div>
      <p className="picker-section-sub">
        Pay with USDT, USDC or a network&rsquo;s own coin on that network. The FMX arrives on Ferminux, sent by the pay-in once your
        payment is confirmed.
      </p>
      {info && !info.enabled && (
        <Notice kind="warn" role="status">
          The pay-in is not taking payments right now. Swap on Ferminux, or try again later.
        </Notice>
      )}
      {!info && assets.error && (
        <p className="field-hint" role="status">
          The pay-in&rsquo;s status could not be read just now; the quote will say whether a network is open.
        </p>
      )}
      <ul className="pay-net-list">
        {rows.map(({ chain, list }) => {
          const state = info?.chains[chain.key];
          const paused = state ? !state.available : false;
          const read = balances[chain.key];
          return (
            <li key={chain.key} className={'pay-net' + (paused ? ' is-paused' : '')} data-network={chain.key}>
              <div className="pay-net-head">
                <NetTag chain={chain} />
                <span className="pay-net-name">{chain.name}</span>
                <span className="spacer" />
                {paused ? <span className="tag tag-warn">paused</span> : <span className="pay-net-conf mono">{state?.confirmations ?? chain.confirmations} conf.</span>}
              </div>
              <div className="pay-assets">
                {list.map((a) => {
                  const bal = balanceOf(read, a);
                  const isSel = selected?.chain === chain.key && selected.asset === a.symbol;
                  const balText = !connected ? null : bal !== undefined ? payAmount(bal, a, 4) : read ? '—' : '…';
                  return (
                    <button
                      key={a.symbol}
                      type="button"
                      className="pay-asset"
                      data-pay={`${chain.key}:${a.symbol}`}
                      aria-pressed={isSel}
                      disabled={paused}
                      onClick={() => onSelect({ chain: chain.key, asset: a.symbol })}
                      aria-label={`Pay with ${a.symbol} on ${chain.name}${bal !== undefined ? `, balance ${payAmount(bal, a, 4)}` : ''}${paused ? ', paused' : ''}`}
                    >
                      <span className="pay-asset-sym">{a.symbol}</span>
                      {balText !== null && <span className="pay-asset-bal mono">{balText}</span>}
                    </button>
                  );
                })}
              </div>
              {paused && state?.reason && <p className="pay-net-reason">Not taking payments: {state.reason}.</p>}
            </li>
          );
        })}
      </ul>
      {!connected && <p className="field-hint">Connect a wallet to see your balance on each network.</p>}
    </section>
  );
}
