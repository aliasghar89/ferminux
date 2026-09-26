import type { ChainState } from '../App.tsx';
import type { AccountsApi } from '../state/useAccounts.ts';
import type { BalancesApi } from '../state/useBalances.ts';
import { balanceOf } from '../lib/balances.ts';
import { CHAIN_ID, EXPLORER_URL, NATIVE_SYMBOL } from '../config.ts';
import { CHAINS } from '../lib/chains.ts';
import { formatAmount, formatGwei, shortAddress } from '../lib/validate.ts';
import { Identicon } from '../components/Identicon.tsx';
import { ChainBadge } from '../components/ChainBadge.tsx';
import { IconChevronRight, IconClock, IconExternal, IconKey, IconLock, IconShield, IconSun, IconUsers, IconAlert } from '../components/icons.tsx';
import type { AccountsMode } from './AccountsPanel.tsx';
import { LOCK_CHOICES, saveLockMinutes, saveTheme, useLockMs, useTheme } from './prefs.ts';
import { isNativeApp } from '../platform/index.ts';
import { Here, here, sessionOnlyWhere, storedWhere } from '../platform/words.ts';

function host(url: string | undefined): string {
  if (!url) return '—';
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Accounts, security, appearance, networks and the facts about this wallet. */
export function SettingsScreen({
  api,
  balances,
  chain,
  onManageAccounts,
  onLock,
}: {
  api: AccountsApi;
  balances: BalancesApi;
  chain: ChainState;
  onManageAccounts: (mode?: AccountsMode) => void;
  onLock: () => void;
}) {
  const theme = useTheme();
  const lockMs = useLockMs();
  const lockMin = Math.round(lockMs / 60_000);
  const unbacked = api.accounts.filter((a) => a.backup === 'none');

  return (
    <div data-testid="settings">
      <section className="set-group" aria-labelledby="set-accounts">
        <h2 id="set-accounts">Accounts</h2>
        <div className="set-list">
          {api.accounts.map((a) => {
            const v = balanceOf(balances.snapshot, a.address);
            const isActive = a.id === api.active.id;
            return (
              <button key={a.id} className="set-row" onClick={() => api.setActive(a.id)} aria-pressed={isActive} title={isActive ? 'Active account' : `Switch to ${a.label}`}>
                <Identicon address={a.address} size={36} />
                <span className="set-row-main">
                  <span className="set-row-title">
                    {a.label}
                    {isActive && <span className="dir-badge dir-signed">ACTIVE</span>}
                    {a.backup === 'none' && <span className="dir-badge dir-fail">NO BACKUP</span>}
                  </span>
                  <span className="set-row-sub mono">
                    {shortAddress(a.address)} · {a.kind === 'hd' ? `HD #${a.index}` : 'imported'}
                  </span>
                </span>
                <span className="set-row-value mono">{v === null ? '—' : `${formatAmount(v, 18, 4)} ${NATIVE_SYMBOL}`}</span>
              </button>
            );
          })}
          <button className="set-row" data-testid="settings-accounts" onClick={() => onManageAccounts('list')}>
            <span className="set-ic">
              <IconUsers />
            </span>
            <span className="set-row-main">
              <span className="set-row-title">Manage accounts</span>
              <span className="set-row-sub">Add, import, rename, export a keystore, remove</span>
            </span>
            <IconChevronRight className="chev" />
          </button>
        </div>
      </section>

      <section className="set-group" aria-labelledby="set-security">
        <h2 id="set-security">Security</h2>
        <div className="set-list">
          <button className="set-row" data-testid="settings-storage" onClick={() => onManageAccounts('remember')}>
            <span className="set-ic">{api.remembered ? <IconShield /> : <IconAlert />}</span>
            <span className="set-row-main">
              <span className="set-row-title">{api.remembered ? 'Stored on this device' : 'Not stored on this device'}</span>
              <span className="set-row-sub">
                {api.remembered
                  ? `Encrypted keystores (scrypt) ${storedWhere()}. One password unlocks every account.`
                  : sessionOnlyWhere()}
              </span>
            </span>
            <IconChevronRight className="chev" />
          </button>
          <div className="set-row set-row-ctl">
            <span className="set-ic">
              <IconClock />
            </span>
            <span className="set-row-main">
              <label className="set-row-title" htmlFor="lock-after">
                Lock after
              </label>
              <span className="set-row-sub">Without a tap, click or key press for this long, the wallet locks itself.</span>
            </span>
            <select
              id="lock-after"
              className="input input-compact"
              data-testid="lock-after"
              value={lockMin}
              onChange={(e) => saveLockMinutes(Number(e.target.value))}
            >
              {LOCK_CHOICES.map((m) => (
                <option key={m} value={m}>
                  {m} min
                </option>
              ))}
            </select>
          </div>
          {unbacked.length > 0 && (
            <button className="set-row" onClick={() => onManageAccounts('list')}>
              <span className="set-ic" style={{ color: 'var(--warn)' }}>
                <IconKey />
              </span>
              <span className="set-row-main">
                <span className="set-row-title">Back up {unbacked.map((a) => a.label).join(', ')}</span>
                <span className="set-row-sub">{Here()} holds the only copy of {unbacked.length === 1 ? 'that key' : 'those keys'}. Export a keystore file.</span>
              </span>
              <IconChevronRight className="chev" />
            </button>
          )}
          <button className="set-row" data-testid="settings-lock" onClick={onLock}>
            <span className="set-ic">
              <IconLock />
            </span>
            <span className="set-row-main">
              <span className="set-row-title">Lock now</span>
            </span>
            <IconChevronRight className="chev" />
          </button>
        </div>
      </section>

      <section className="set-group" aria-labelledby="set-appearance">
        <h2 id="set-appearance">Appearance</h2>
        <div className="set-list">
          <div className="set-row set-row-ctl">
            <span className="set-ic">
              <IconSun />
            </span>
            <span className="set-row-main">
              <span className="set-row-title">Theme</span>
              <span className="set-row-sub">Kept on this device only.</span>
            </span>
            <div className="seg" role="group" aria-label="Theme">
              <button aria-pressed={theme === 'dark'} onClick={() => saveTheme('dark')} data-testid="theme-dark">
                Dark
              </button>
              <button aria-pressed={theme === 'light'} onClick={() => saveTheme('light')} data-testid="theme-light">
                Light
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="set-group" aria-labelledby="set-networks">
        <h2 id="set-networks">Networks</h2>
        <div className="set-list" data-testid="settings-networks">
          {CHAINS.map((c) => (
            <a key={c.id} className="set-row" href={c.explorer.url} target="_blank" rel="noreferrer noopener" title={`Open ${c.explorer.name}`}>
              <ChainBadge chain={c} />
              <span className="set-row-main">
                <span className="set-row-title">
                  {c.name} <span className="mono faint" style={{ fontSize: 12 }}>· {c.id}</span>
                </span>
                <span className="set-row-sub mono">
                  {c.id === CHAIN_ID
                    ? `${host(chain.rpcUrl ?? c.rpcUrls[0])} · block ${chain.blockNumber !== null ? chain.blockNumber.toLocaleString('en-US') : '—'} · base fee ${chain.baseFee !== null ? `${formatGwei(chain.baseFee)} gwei` : '—'}`
                    : `${host(c.rpcUrls[0])} · fees in ${c.native.symbol}`}
                </span>
              </span>
              <IconExternal className="chev" />
            </a>
          ))}
        </div>
        <p className="field-hint" style={{ margin: '10px 4px 0' }}>
          Read through public, keyless endpoints. The same address holds assets on every network listed.
        </p>
      </section>

      <section className="set-group" aria-labelledby="set-about">
        <h2 id="set-about">About</h2>
        <div className="set-list">
          <div className="set-row">
            <span className="set-row-main">
              <span className="set-row-title">Ferminux Wallet</span>
              <span className="set-row-sub">
                Self-custody. Keys are generated and encrypted {isNativeApp() ? 'on' : 'in'} {here()} and never sent to a server. No
                analytics, no price service.
              </span>
            </span>
          </div>
          <a className="set-row" href={EXPLORER_URL} target="_blank" rel="noreferrer noopener">
            <span className="set-row-main">
              <span className="set-row-title">Ferminux Explorer</span>
              <span className="set-row-sub mono">{host(EXPLORER_URL)}</span>
            </span>
            <IconExternal className="chev" />
          </a>
          <a className="set-row" href="https://ferminux.net/" target="_blank" rel="noreferrer noopener">
            <span className="set-row-main">
              <span className="set-row-title">ferminux.net</span>
              <span className="set-row-sub">The network, its agents and the NFT collections</span>
            </span>
            <IconExternal className="chev" />
          </a>
        </div>
      </section>
    </div>
  );
}
