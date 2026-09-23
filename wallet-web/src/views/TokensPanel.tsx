import { useState } from 'react';
import type { TokensApi } from '../state/useTokens.ts';
import type { TokenMeta } from '../lib/tokens.ts';
import { EXPLORER_URL } from '../config.ts';
import { formatAmount, formatAmountExact, shortAddress } from '../lib/validate.ts';
import { Spinner } from '../components/ui.tsx';
import { Identicon } from '../components/Identicon.tsx';

export function TokensPanel({
  api,
  connected,
  holderLabel,
  holderAddress,
  onSend,
}: {
  api: TokensApi;
  connected: boolean;
  /** Which account these balances belong to — the list is per-account. */
  holderLabel: string;
  holderAddress: string;
  onSend: (meta: TokenMeta) => void;
}) {
  const [addr, setAddr] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function add() {
    if (addr.trim() === '') return;
    setBusy(true);
    setError(null);
    const err = await api.addToken(addr);
    setBusy(false);
    if (err) {
      setError(err);
    } else {
      setAddr('');
    }
  }

  return (
    <div>
      <div className="panel-body" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="holder-line">
          <Identicon address={holderAddress} size={20} />
          <span>
            Balances for <strong>{holderLabel}</strong>{' '}
            <span className="mono muted">{shortAddress(holderAddress)}</span>
          </span>
        </div>
        <div className="field mb-0">
          <label htmlFor="token-addr">Add token by contract address</label>
          <div className="input-row">
            <input
              id="token-addr"
              className={'input input-mono' + (error ? ' input-error' : '')}
              placeholder="0x…"
              value={addr}
              onChange={(e) => {
                setAddr(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void add();
              }}
              disabled={busy}
              spellCheck={false}
              autoComplete="off"
            />
            <button className="btn" onClick={() => void add()} disabled={busy || !connected || addr.trim() === ''}>
              {busy ? <Spinner /> : 'Add'}
            </button>
          </div>
          {error && <div className="field-error">{error}</div>}
          {!connected && <div className="field-hint">Connect to the network to add tokens.</div>}
          <div className="field-hint">Symbol, name and decimals are read from the contract over RPC.</div>
        </div>
      </div>

      {api.tokens.length === 0 ? (
        <div className="empty-state">
          <div className="title">No tokens added</div>
          Track any FRC-20 token on Ferminux by pasting its contract address above.
        </div>
      ) : (
        <ul className="row-list">
          {api.tokens.map((t) => (
            <li key={t.address}>
              <div className="row-main">
                <div className="row-title">
                  {t.meta ? t.meta.symbol : shortAddress(t.address)}
                  {t.metaFailed && <span className="dir-badge dir-fail">metadata unavailable</span>}
                </div>
                <div className="row-sub">
                  {t.meta ? t.meta.name : 'Unresolved contract'} ·{' '}
                  <a href={`${EXPLORER_URL}/token/${t.address}`} target="_blank" rel="noreferrer noopener">
                    {shortAddress(t.address)} ↗
                  </a>
                </div>
              </div>
              <div className="row-value num">
                {t.balance === null ? (
                  <span className="skeleton" style={{ minWidth: 70 }}>
                    0.00
                  </span>
                ) : t.meta ? (
                  <span title={formatAmountExact(t.balance, t.meta.decimals)}>
                    {formatAmount(t.balance, t.meta.decimals)}
                  </span>
                ) : (
                  '—'
                )}
              </div>
              <div className="row-actions">
                <button className="btn btn-sm" disabled={!t.meta || !connected} onClick={() => t.meta && onSend(t.meta)}>
                  Send
                </button>
                <button
                  className="btn btn-danger-ghost btn-sm"
                  onClick={() => api.removeToken(t.address)}
                  title="Remove from list (does not affect the balance on chain)"
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
