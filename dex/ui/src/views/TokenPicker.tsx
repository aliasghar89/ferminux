import { useMemo, useState } from 'react';
import type { JsonRpcProvider } from 'ethers';
import { DEX_ADDRESSES } from '../config.ts';
import { Modal, Notice, Spinner } from '../components/ui.tsx';
import { TokenLogo } from '../components/TokenLogo.tsx';
import { IconSearch } from '../components/icons.tsx';
import { formatAmount, isAddress, shortAddress } from '../lib/amounts.ts';
import { formatUsd, valueUsdE18, type PriceTable } from '../lib/prices.ts';
import { isListed, listedTokens, searchTokens, sortForPicker } from '../lib/tokenlist.ts';
import { fetchTokenMeta, tokenKey, type TokenInfo } from '../lib/tokens.ts';

/**
 * Token picker. Listed tokens (FMX and the registry's first-party tokens) head
 * the list as quick picks; then every token in a pool and every token this
 * browser imported. Balances and their USD value show when a wallet is
 * connected. Anything else can be imported by pasting its address: it is read
 * from the chain first and marked as unlisted, because anyone can deploy a
 * token with any name.
 */
export function TokenPicker({
  tokens,
  balances,
  prices,
  provider,
  selected,
  other,
  onSelect,
  onImport,
  onClose,
}: {
  tokens: TokenInfo[];
  balances: Map<string, bigint>;
  prices: PriceTable;
  provider: JsonRpcProvider | null;
  /** The token already in this slot. */
  selected: TokenInfo | null;
  /** The token in the other slot (picking it swaps the two). */
  other: TokenInfo | null;
  onSelect: (token: TokenInfo) => void;
  onImport: (token: TokenInfo) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [importing, setImporting] = useState(false);
  const [found, setFound] = useState<TokenInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const quick = useMemo(() => {
    const known = new Set(tokens.map(tokenKey));
    return listedTokens(DEX_ADDRESSES.wfmx).filter((t) => known.has(tokenKey(t)));
  }, [tokens]);
  const sorted = useMemo(() => sortForPicker(tokens, balances, DEX_ADDRESSES.wfmx), [tokens, balances]);
  const filtered = useMemo(() => searchTokens(sorted, query), [sorted, query]);
  const knownAddress = useMemo(() => new Set(tokens.map((t) => t.address.toLowerCase())), [tokens]);
  const canLookUp = isAddress(query) && !knownAddress.has(query.trim().toLowerCase());

  const lookUp = async () => {
    if (!provider) {
      setError('Not connected to an RPC endpoint, so that contract cannot be read.');
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

  const usdOf = (t: TokenInfo, amount: bigint | undefined) => {
    if (amount === undefined || amount === 0n) return null;
    const b = prices.get(t.address.toLowerCase());
    return b ? formatUsd(valueUsdE18(amount, t.decimals, b.usdE18)) : null;
  };

  return (
    <Modal title="Select a token" onClose={onClose}>
      <div className="search-field">
        <IconSearch />
        <input
          className="input input-search"
          placeholder="Search name or symbol, or paste an address"
          value={query}
          aria-label="Search tokens"
          data-testid="token-search"
          onChange={(e) => {
            setQuery(e.target.value);
            setFound(null);
            setError(null);
          }}
        />
      </div>

      {quick.length > 0 && query.trim() === '' && (
        <div className="chips quick-picks" aria-label="Common tokens">
          {quick.map((t) => (
            <button
              key={tokenKey(t)}
              className="chip"
              aria-pressed={selected ? tokenKey(selected) === tokenKey(t) : false}
              onClick={() => onSelect(t)}
            >
              <TokenLogo token={t} size={18} />
              {t.symbol}
            </button>
          ))}
        </div>
      )}

      {canLookUp && !found && (
        <button className="btn btn-block" onClick={() => void lookUp()} disabled={importing}>
          {importing ? <Spinner /> : null} Read this contract from the chain
        </button>
      )}

      {error && (
        <Notice kind="danger" role="alert">
          {error}
        </Notice>
      )}

      {found && (
        <div className="import-card">
          <div className="import-head">
            <TokenLogo token={found} size={32} />
            <div>
              <div className="token-symbol">{found.symbol}</div>
              <div className="muted small">{found.name}</div>
            </div>
          </div>
          <div className="mono small faint break">
            {found.address} · {found.decimals} decimals
          </div>
          <Notice kind="warn">
            Not on the Ferminux token list. Anyone can deploy a token with any name; check this address against the
            project's own published address before you trade it.
          </Notice>
          <button
            className="btn btn-primary btn-block"
            onClick={() => {
              onImport(found);
              onSelect(found);
            }}
          >
            Import {found.symbol}
          </button>
        </div>
      )}

      {filtered.length === 0 && !found && !canLookUp && (
        <p className="muted small picker-empty">
          {query.trim() === '' ? 'No tokens yet: no pools exist on this network.' : 'Nothing matches. Paste a contract address to import a token.'}
        </p>
      )}

      <ul className="token-list" data-testid="token-list">
        {filtered.map((token) => {
          const balance = balances.get(tokenKey(token));
          const isSel = selected ? tokenKey(selected) === tokenKey(token) : false;
          const isOther = other ? tokenKey(other) === tokenKey(token) : false;
          const usd = usdOf(token, balance);
          return (
            <li key={tokenKey(token)}>
              <button className={'token-row' + (isSel ? ' is-selected' : '')} onClick={() => onSelect(token)} data-symbol={token.symbol}>
                <TokenLogo token={token} size={32} />
                <span className="token-main">
                  <span className="token-symbol">
                    {token.symbol}
                    {token.kind === 'native' && <span className="tag">native</span>}
                    {token.kind === 'erc20' && token.address.toLowerCase() === DEX_ADDRESSES.wfmx.toLowerCase() && <span className="tag">wrapper</span>}
                    {!isListed(token) && <span className="tag tag-warn">unlisted</span>}
                    {token.metadataFailed && <span className="tag tag-warn">unreadable</span>}
                    {isOther && <span className="tag">other side</span>}
                  </span>
                  <span className="token-sub">
                    {token.name}
                    {token.kind === 'erc20' && <span className="mono"> · {shortAddress(token.address, 6, 4)}</span>}
                  </span>
                </span>
                <span className="token-balance">
                  {balance !== undefined && <span className="mono">{formatAmount(balance, token.decimals, 4)}</span>}
                  {usd && <span className="mono faint small">{usd}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}
