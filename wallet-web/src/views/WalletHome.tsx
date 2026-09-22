import { useState } from 'react';
import type { ChainState } from '../App.tsx';
import type { AccountsApi } from '../state/useAccounts.ts';
import type { BalancesApi } from '../state/useBalances.ts';
import { balanceOf, isTotalComplete, totalBalance } from '../lib/balances.ts';
import { CHAIN_ID, EXPLORER_URL, NATIVE_SYMBOL } from '../config.ts';
import { checkAmount, formatAmount, formatAmountExact, shortAddress } from '../lib/validate.ts';
import { buildEip681Uri } from '../lib/qr.ts';
import type { TokenMeta } from '../lib/tokens.ts';
import { Modal, QrCanvas, CopyButton } from '../components/ui.tsx';
import { Identicon } from '../components/Identicon.tsx';
import { useTokens } from '../state/useTokens.ts';
import { SendPanel } from './SendPanel.tsx';
import { TokensPanel } from './TokensPanel.tsx';
import { ActivityPanel } from './ActivityPanel.tsx';

type Tab = 'send' | 'tokens' | 'activity';

export function WalletHome({
  api,
  balances,
  chain,
  onManageAccounts,
}: {
  api: AccountsApi;
  balances: BalancesApi;
  chain: ChainState;
  onManageAccounts: () => void;
}) {
  const [tab, setTab] = useState<Tab>('send');
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [sendAsset, setSendAsset] = useState<TokenMeta | null>(null); // null = native FMX
  const [refreshKey, setRefreshKey] = useState(0);

  const active = api.active;
  const balance = balanceOf(balances.snapshot, active.address);
  const total = totalBalance(balances.snapshot, api.addresses);
  const totalExact = isTotalComplete(balances.snapshot, api.addresses);

  const tokensApi = useTokens(chain.provider, active.address);

  const afterSend = () => {
    setRefreshKey((k) => k + 1);
    balances.refresh();
    tokensApi.refresh();
  };

  return (
    <div>
      <div className="panel">
        <div className="panel-body">
          <div className="active-line">
            <Identicon address={active.address} size={28} />
            <span className="active-label">{active.label}</span>
            <span className="acct-tag">{active.kind === 'hd' ? `HD #${active.index}` : 'IMPORTED'}</span>
            {active.backup === 'none' && (
              <span className="dir-badge dir-fail" title="This browser holds the only copy of this key.">
                NO BACKUP
              </span>
            )}
            <span className="push" />
            <button className="btn btn-ghost btn-sm" data-testid="home-manage" onClick={onManageAccounts}>
              Accounts
            </button>
          </div>
          <div className="balance-row">
            <div>
              {balance === null ? (
                <span className="skeleton balance-figure" style={{ minWidth: 180 }}>
                  0.000000
                </span>
              ) : (
                <span
                  className="balance-figure"
                  data-testid="active-balance"
                  title={`${formatAmountExact(balance)} ${NATIVE_SYMBOL}`}
                >
                  {formatAmount(balance)}
                  <span className="balance-unit">{NATIVE_SYMBOL}</span>
                </span>
              )}
              {balances.stale && balance !== null && (
                <div className="small muted" style={{ marginTop: 4 }}>
                  Last known value — network unreachable.
                </div>
              )}
              {api.accounts.length > 1 && (
                <button className="total-inline" data-testid="total-inline" onClick={onManageAccounts}>
                  <span className="muted">Total across {api.accounts.length} accounts</span>
                  <span className="num" title={`${formatAmountExact(total)} ${NATIVE_SYMBOL}`}>
                    {totalExact ? '' : '≥ '}
                    {formatAmount(total)} {NATIVE_SYMBOL}
                  </span>
                </button>
              )}
            </div>
            <div className="balance-actions">
              <button className="btn" onClick={() => setReceiveOpen(true)}>
                Receive
              </button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  setSendAsset(null);
                  setTab('send');
                }}
              >
                Send
              </button>
            </div>
          </div>
          <hr className="divider" />
          <div className="addr-line">
            <span className="full" data-testid="active-address">{active.address}</span>
            <CopyButton text={active.address} />
            <a
              className="btn btn-ghost btn-sm"
              href={`${EXPLORER_URL}/address/${active.address}`}
              target="_blank"
              rel="noreferrer noopener"
            >
              Explorer ↗
            </a>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="tabs" role="tablist">
          {(
            [
              ['send', 'Send'],
              ['tokens', 'Tokens'],
              ['activity', 'Activity'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className="tab" onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
          <span className="tabs-context" title={active.address}>
            <Identicon address={active.address} size={16} />
            {active.label}
          </span>
        </div>
        {tab === 'send' && (
          <div className="panel-body">
            <SendPanel
              // Remount on account switch so a half-filled form never carries
              // over to a different sender.
              key={active.id}
              api={api}
              chain={chain}
              nativeBalance={balance}
              tokens={tokensApi.tokens}
              asset={sendAsset}
              onAssetChange={setSendAsset}
              onSent={afterSend}
            />
          </div>
        )}
        {tab === 'tokens' && (
          <TokensPanel
            api={tokensApi}
            holderLabel={active.label}
            holderAddress={active.address}
            connected={chain.status === 'ok'}
            onSend={(meta) => {
              setSendAsset(meta);
              setTab('send');
            }}
          />
        )}
        {tab === 'activity' && (
          <ActivityPanel
            key={active.id}
            address={active.address}
            label={active.label}
            refreshKey={refreshKey}
          />
        )}
      </div>

      {receiveOpen && (
        <ReceiveModal
          address={active.address}
          label={active.label}
          onClose={() => setReceiveOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * Receive screen. The QR encodes an EIP-681 URI (`ethereum:0x…@3961`) rather
 * than a bare address, so a wallet scanning it learns the chain — and, when a
 * request amount is set, the amount too. The plain address stays one click away
 * for anything that only understands 0x….
 */
function ReceiveModal({ address, label, onClose }: { address: string; label: string; onClose: () => void }) {
  const [wantAmount, setWantAmount] = useState(false);
  const [amount, setAmount] = useState('');

  const trimmed = amount.trim();
  const check = wantAmount && trimmed !== '' ? checkAmount(trimmed) : null;
  const amountWei = check?.ok ? check.wei : undefined;
  const amountError = check && !check.ok ? check.error : null;
  const uri = buildEip681Uri(address, { chainId: CHAIN_ID, amountWei });

  return (
    <Modal title={`Receive ${NATIVE_SYMBOL}`} onClose={onClose}>
      <div className="receive-account">
        <Identicon address={address} size={24} />
        <span>
          <strong>{label}</strong>
          <span className="muted mono small"> · {shortAddress(address)}</span>
        </span>
      </div>
      <div style={{ textAlign: 'center' }}>
        <div className="qr-frame">
          <QrCanvas value={uri} />
        </div>
        <p className="mono small" style={{ wordBreak: 'break-all' }}>
          {address}
        </p>
        {amountWei !== undefined && (
          <p className="small num" style={{ marginTop: -4 }}>
            Requesting <strong>{formatAmountExact(amountWei)} {NATIVE_SYMBOL}</strong>
          </p>
        )}
        <p className="small muted">
          Send only Ferminux Network (chain {CHAIN_ID}) assets to this address.
        </p>
      </div>

      <label className="check-row" style={{ marginTop: 4 }}>
        <input
          type="checkbox"
          checked={wantAmount}
          onChange={(e) => {
            setWantAmount(e.target.checked);
            if (!e.target.checked) setAmount('');
          }}
        />
        <span>
          Request a specific amount
          <span className="field-hint" style={{ marginTop: 2 }}>
            Encoded into the QR, so a Ferminux wallet scanning it fills the amount in too.
          </span>
        </span>
      </label>

      {wantAmount && (
        <div className="field" style={{ marginTop: 12, marginBottom: 12 }}>
          <label htmlFor="receive-amount">Amount ({NATIVE_SYMBOL})</label>
          <input
            id="receive-amount"
            className={'input num' + (amountError ? ' input-error' : '')}
            placeholder="0.0"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            autoComplete="off"
          />
          {amountError && <div className="field-error">{amountError}</div>}
          {!amountError && trimmed === '' && (
            <div className="field-hint">Leave blank for an open-ended request.</div>
          )}
        </div>
      )}

      <div className="uri-line mono">{uri}</div>

      <div className="actions-row" style={{ justifyContent: 'center', marginTop: 14 }}>
        <CopyButton text={address} label="Copy address" />
        <CopyButton text={uri} label="Copy payment link" />
      </div>
    </Modal>
  );
}
