import { useMemo, useState } from 'react';
import type { JsonRpcProvider } from 'ethers';
import { Modal, Notice, Spinner } from '../components/ui.tsx';
import { formatAmount, isAddress, shortAddress } from '../lib/amounts.ts';
import { fetchTokenMeta, tokenKey, type TokenInfo } from '../lib/tokens.ts';

/**
 * Token picker. Everything already known (native FMX, WFMX, the preloaded
 * list, every token in a pool, previously imported tokens) is listed; anything
 * else can be added by pasting its address.
 *
 * A pasted token is read from chain before it can be selected, and is labelled
 * as unverified — anyone can deploy a contract calling itself AZNT.
 */
export function TokenSelect({
  tokens,
  balances,
  provider,
  exclude,
  onSelect,
  onImport,
  onClose,
}: {
  tokens: TokenInfo[];
  balances: Map<string, bigint>;
  provider: JsonRpcProvider | null;
  exclude?: TokenInfo | null;
  onSelect: (token: TokenInfo) => void;
  onImport: (token: TokenInfo) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [importing, setImporting] = useState(false);
  const [found, setFound] = useState<TokenInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const excludeKey = exclude ? tokenKey(exclude) : null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = tokens.filter((t) => tokenKey(t) !== excludeKey);
    if (!q) return list;
    return list.filter(
      (t) =>
        t.symbol.toLowerCase().includes(q) ||
        t.name.toLowerCase().includes(q) ||
        t.address.toLowerCase().includes(q),
    );
  }, [tokens, query, excludeKey]);

  const knownAddress = useMemo(
    () => new Set(tokens.map((t) => t.address.toLowerCase())),
    [tokens],
  );

  const canLookUp = isAddress(query) && !knownAddress.has(query.trim().toLowerCase()) && filtered.length === 0;

  const lookUp = async () => {
    if (!provider) {
      setError('Not connected to an RPC endpoint — cannot read that contract.');
      return;
    }
    setImporting(true);
    setError(null);
    setFound(null);
    try {
      setFound(await fetchTokenMeta(provider, query.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  };

  return (
    <Modal title="Select a token" onClose={onClose}>
      <div className="field">
        <input
          className="input input-mono"
          placeholder="Search name, symbol, or paste an address"
          value={query}
          autoFocus
          onChange={(e) => {
            setQuery(e.target.value);
            setFound(null);
            setError(null);
          }}
        />
      </div>

      {canLookUp && !found && (
        <div className="actions-row" style={{ marginBottom: 14 }}>
          <button className="btn btn-sm" onClick={() => void lookUp()} disabled={importing}>
            {importing ? <Spinner /> : null} Look up this address
          </button>
        </div>
      )}

      {error && (
        <Notice kind="danger" role="alert">
          {error}
        </Notice>
      )}

      {found && (
        <div className="import-card">
          <div className="import-head">
            <span className="token-symbol">{found.symbol}</span>
            <span className="muted small">{found.name}</span>
          </div>
          <div className="mono small muted" style={{ wordBreak: 'break-all', marginBottom: 10 }}>
            {found.address} · {found.decimals} decimals
          </div>
          <Notice kind="warn">
            Anyone can deploy a token with any name. This one is not on any list — check the address against the
            project's own published address before you trade it.
          </Notice>
          <button
            className="btn btn-primary btn-block"
            onClick={() => {
              onImport(found);
              onSelect(found);
            }}
          >
            Import and select {found.symbol}
          </button>
        </div>
      )}

      {filtered.length === 0 && !found && !canLookUp && (
        <p className="muted small">
          {query.trim() === ''
            ? 'No tokens yet — no pools have been created on this network.'
            : 'Nothing matches. Paste a full contract address to import a token by hand.'}
        </p>
      )}

      <ul className="token-list">
        {filtered.map((token) => {
          const balance = balances.get(tokenKey(token));
          return (
            <li key={tokenKey(token)}>
              <button className="token-row" onClick={() => onSelect(token)}>
                <span className="token-mark" aria-hidden="true">
                  {token.symbol.slice(0, 2).toUpperCase()}
                </span>
                <span className="token-main">
                  <span className="token-symbol">
                    {token.symbol}
                    {token.kind === 'native' && <span className="tag">native</span>}
                    {token.metadataFailed && <span className="tag tag-warn">metadata unreadable</span>}
                  </span>
                  <span className="token-sub mono">
                    {token.kind === 'native' ? 'Ferminux coin' : shortAddress(token.address)}
                  </span>
                </span>
                <span className="token-balance num">
                  {balance === undefined ? '' : formatAmount(balance, token.decimals, 4)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}
