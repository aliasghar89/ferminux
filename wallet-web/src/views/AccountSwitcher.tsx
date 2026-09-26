import { useEffect, useRef, useState } from 'react';
import type { AccountsApi } from '../state/useAccounts.ts';
import type { BalancesApi } from '../state/useBalances.ts';
import { balanceOf, isTotalComplete, totalBalance } from '../lib/balances.ts';
import { formatAmount, formatAmountExact, shortAddress } from '../lib/validate.ts';
import { NATIVE_SYMBOL } from '../config.ts';
import { Identicon } from '../components/Identicon.tsx';
import { IconCheck, IconChevronDown } from '../components/icons.tsx';

/**
 * Header account switcher. Shows which account is active at all times, and
 * opens a list of every account in the session with its own live balance plus
 * the total across all of them.
 */
export function AccountSwitcher({
  api,
  balances,
  onManage,
}: {
  api: AccountsApi;
  balances: BalancesApi;
  onManage: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const activeBalance = balanceOf(balances.snapshot, api.active.address);
  const total = totalBalance(balances.snapshot, api.addresses);
  const complete = isTotalComplete(balances.snapshot, api.addresses);

  return (
    <div className="acct-switch" ref={wrap}>
      <button
        className="acct-trigger"
        data-testid="account-trigger"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((o) => !o)}
        title={`${api.active.label} — ${api.active.address}`}
      >
        <Identicon address={api.active.address} size={30} />
        <span className="acct-trigger-text">
          <span className="acct-trigger-label">{api.active.label}</span>
          <span className="acct-trigger-addr mono">{shortAddress(api.active.address)}</span>
        </span>
        <span className="acct-trigger-bal num">
          {activeBalance === null ? '—' : formatAmount(activeBalance, 18, 4)}
        </span>
        <IconChevronDown />
      </button>

      {open && (
        <div className="acct-menu" role="menu" data-testid="account-menu">
          <div className="acct-menu-head">
            <span>Accounts ({api.accounts.length})</span>
            <span className="acct-total num" title={`${formatAmountExact(total)} ${NATIVE_SYMBOL}`}>
              {complete ? '' : '≥ '}
              {formatAmount(total, 18, 4)} {NATIVE_SYMBOL}
            </span>
          </div>
          <ul className="acct-list">
            {api.accounts.map((account) => {
              const value = balanceOf(balances.snapshot, account.address);
              const isActive = account.id === api.active.id;
              return (
                <li key={account.id}>
                  <button
                    className={'acct-row' + (isActive ? ' is-active' : '')}
                    role="menuitemradio"
                    aria-checked={isActive}
                    data-testid={`account-row-${account.address.toLowerCase()}`}
                    onClick={() => {
                      api.setActive(account.id);
                      setOpen(false);
                    }}
                  >
                    <Identicon address={account.address} size={32} />
                    <span className="acct-row-main">
                      <span className="acct-row-label">
                        {account.label}
                        <span className="acct-tag">
                          {account.kind === 'hd' ? `HD #${account.index}` : 'IMPORTED'}
                        </span>
                      </span>
                      <span className="acct-row-addr mono">{shortAddress(account.address)}</span>
                    </span>
                    <span className="acct-row-bal num">
                      {value === null ? (
                        <span className="skeleton" style={{ minWidth: 54 }}>
                          0.0000
                        </span>
                      ) : (
                        <span title={`${formatAmountExact(value)} ${NATIVE_SYMBOL}`}>
                          {formatAmount(value, 18, 4)}
                        </span>
                      )}
                    </span>
                    <span className="acct-check" aria-hidden="true">
                      {isActive ? <IconCheck /> : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {balances.stale && (
            <div className="acct-menu-note">Some balances could not be refreshed — showing the last reading.</div>
          )}
          <div className="acct-menu-foot">
            <button
              className="btn btn-sm"
              data-testid="manage-accounts"
              onClick={() => {
                setOpen(false);
                onManage();
              }}
            >
              Manage accounts
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
