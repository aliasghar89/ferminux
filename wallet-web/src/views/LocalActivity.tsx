import type { ChainDef } from '../lib/chains.ts';
import { explorerTxUrl } from '../lib/chains.ts';
import { localTxFor, type LocalTx } from '../lib/localActivity.ts';
import { formatAmount, formatAmountExact, shortAddress } from '../lib/validate.ts';
import { ageLabel } from '../lib/time.ts';
import { Identicon } from '../components/Identicon.tsx';
import { IconAlert, IconExternal, IconSend } from '../components/icons.tsx';

/**
 * Activity on a chain other than Ferminux: the transactions THIS wallet sent
 * there, recorded on this device, each linking to the chain's own explorer.
 * Incoming transfers are not listed — reading them needs an explorer API key.
 */
export function LocalActivity({
  chain,
  list,
  address,
  label,
}: {
  chain: ChainDef;
  list: LocalTx[];
  address: string;
  label: string;
}) {
  const rows = localTxFor(list, address, chain.id);
  return (
    <>
      <div className="holder-line holder-line-inset">
        <Identicon address={address} size={20} />
        <span>
          Sent from <strong>{label}</strong> on {chain.name}{' '}
          <span className="mono muted">{shortAddress(address)}</span>
        </span>
      </div>
      <div className="notice local-note">
        Transactions this wallet sent on {chain.name} from this device. Incoming transfers and history from other
        wallets are on{' '}
        <a href={`${chain.explorer.url}/address/${address}`} target="_blank" rel="noreferrer noopener">
          {chain.explorer.name}
        </a>
        .
      </div>
      {rows.length === 0 ? (
        <div className="list empty-state">
          <div className="title">Nothing sent on {chain.name} yet</div>
          Transactions you send there from this wallet will appear here.
        </div>
      ) : (
        <div className="list">
        <ul className="row-list" data-testid={`local-activity-${chain.id}`}>
          {rows.map((t) => (
            <li key={t.hash}>
              <span className={'tx-ic' + (t.status === 'failed' ? ' fail' : '')} aria-hidden="true">
                {t.status === 'failed' ? <IconAlert /> : <IconSend />}
              </span>
              <div className="row-main">
                <div className="row-title">
                  {t.status === 'failed' ? 'Failed' : t.kind === 'call' ? 'Contract call' : 'Sent'}
                  {t.via && <span className="faint small" style={{ fontWeight: 400 }}>via {t.via}</span>}
                </div>
                <div className="row-sub">
                  to <span className="mono">{shortAddress(t.to)}</span> · {t.status === 'pending' ? 'pending · ' : ''}
                  {ageLabel(t.createdAt)}
                </div>
              </div>
              <div className="row-value num" title={`${formatAmountExact(BigInt(t.amount), t.decimals)} ${t.symbol}`}>
                {t.kind === 'call' && t.amount === '0' ? 'contract call' : `−${formatAmount(BigInt(t.amount), t.decimals)} ${t.symbol}`}
              </div>
              <div className="row-actions">
                <a
                  className="row-link"
                  href={explorerTxUrl(chain, t.hash)}
                  target="_blank"
                  rel="noreferrer noopener"
                  title={`View on ${chain.explorer.name}`}
                  aria-label={`View on ${chain.explorer.name}`}
                >
                  <IconExternal />
                </a>
              </div>
            </li>
          ))}
        </ul>
        </div>
      )}
    </>
  );
}
