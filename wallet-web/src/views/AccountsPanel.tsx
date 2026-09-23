import { useState } from 'react';
import type { AccountsApi } from '../state/useAccounts.ts';
import type { BalancesApi } from '../state/useBalances.ts';
import type { SessionAccount } from '../lib/accounts.ts';
import { MAX_LABEL_LENGTH } from '../lib/accounts.ts';
import { balanceOf, isTotalComplete, totalBalance } from '../lib/balances.ts';
import { formatAmount, formatAmountExact, shortAddress } from '../lib/validate.ts';
import { EXPLORER_URL, NATIVE_SYMBOL } from '../config.ts';
import { Modal, CopyButton, ProgressBar, Spinner } from '../components/ui.tsx';
import { Identicon } from '../components/Identicon.tsx';
import { downloadKeystore } from '../state/download.ts';
import { looksLikeKeystore, keystoreAddress } from '../lib/wallet.ts';

type Mode = 'list' | 'import' | 'remember';

/**
 * Accounts view: the total across every account, one row per account with its
 * own balance, and everything that changes the set — add, import, rename,
 * export, remove — in one place.
 */
export function AccountsPanel({
  api,
  balances,
  onClose,
}: {
  api: AccountsApi;
  balances: BalancesApi;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<Mode>('list');
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const total = totalBalance(balances.snapshot, api.addresses);
  const complete = isTotalComplete(balances.snapshot, api.addresses);

  function addHd() {
    setError(null);
    setNotice(null);
    const result = api.addHdAccount();
    if (!result.ok) setError(result.error);
    else
      setNotice({
        tone: 'ok',
        text: `${result.account.label} added at m/44'/60'/0'/0/${result.account.index} and made active.`,
      });
  }

  return (
    <Modal title="Accounts" onClose={onClose} wide>
      <div className="total-card">
        <div className="total-label">Total balance · {api.accounts.length} account{api.accounts.length === 1 ? '' : 's'}</div>
        <div className="total-figure num" title={`${formatAmountExact(total)} ${NATIVE_SYMBOL}`} data-testid="total-balance">
          {balances.snapshot === null ? (
            <span className="skeleton" style={{ minWidth: 160 }}>
              0.000000
            </span>
          ) : (
            <>
              {complete ? '' : <span className="total-approx">≥ </span>}
              {formatAmount(total)}
              <span className="balance-unit">{NATIVE_SYMBOL}</span>
            </>
          )}
        </div>
        <div className="total-note">
          {balances.snapshot === null
            ? 'Reading balances…'
            : complete
              ? 'All accounts read together in one batched request.'
              : `${balances.snapshot.failed.length} account${balances.snapshot.failed.length === 1 ? '' : 's'} could not be read — the total is a lower bound.`}
          <button className="btn btn-ghost btn-sm" style={{ marginLeft: 8 }} onClick={balances.refresh}>
            Refresh
          </button>
        </div>
      </div>

      {api.failed.length > 0 && (
        <div className="notice notice-warn">
          {api.failed.length} stored account{api.failed.length === 1 ? '' : 's'} could not be decrypted with this
          password and {api.failed.length === 1 ? 'is' : 'are'} not loaded:{' '}
          {api.failed.map((f) => `${f.label} (${shortAddress(f.address)})`).join(', ')}.
        </div>
      )}
      {error && <div className="notice notice-danger">{error}</div>}
      {notice && <div className={'notice' + (notice.tone === 'warn' ? ' notice-warn' : ' notice-success')}>{notice.text}</div>}

      {mode === 'list' && (
        <>
          <ul className="acct-manage-list">
            {api.accounts.map((account) => (
              <AccountRow
                key={account.id}
                account={account}
                api={api}
                balance={balanceOf(balances.snapshot, account.address)}
                onNotice={(text) => {
                  setError(null);
                  setNotice({ tone: 'ok', text });
                }}
                onError={(text) => {
                  setNotice(null);
                  setError(text);
                }}
              />
            ))}
          </ul>

          <div className="actions-row" style={{ marginTop: 16 }}>
            <button className="btn" data-testid="add-hd-account" onClick={addHd} disabled={!api.canDeriveHd}>
              Add account
            </button>
            <button className="btn" data-testid="open-import" onClick={() => { setMode('import'); setError(null); setNotice(null); }}>
              Import account
            </button>
            <span className="push" />
            <button className="btn btn-ghost btn-sm" onClick={() => { setMode('remember'); setError(null); setNotice(null); }}>
              {api.remembered ? 'Stored on this device' : 'Not stored on this device'}
            </button>
          </div>
          <p className="field-hint" style={{ marginTop: 10 }}>
            {api.canDeriveHd
              ? "Add account derives the next unused index at m/44'/60'/0'/0/N from your recovery phrase — the same phrase always regenerates the same accounts."
              : 'This wallet was opened from a private key or keystore file, so there is no recovery phrase to derive new accounts from. Import another key instead.'}
          </p>
        </>
      )}

      {mode === 'import' && (
        <ImportAccount
          api={api}
          onCancel={() => setMode('list')}
          onDone={(label) => {
            setMode('list');
            setError(null);
            setNotice({ tone: 'ok', text: `${label} imported and made active.` });
          }}
        />
      )}

      {mode === 'remember' && (
        <RememberSection
          api={api}
          onCancel={() => setMode('list')}
          onDone={(text, tone) => {
            setMode('list');
            setError(null);
            setNotice({ tone, text });
          }}
        />
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* One account row                                                     */
/* ------------------------------------------------------------------ */

type RowMode = 'idle' | 'rename' | 'export' | 'remove';

function AccountRow({
  account,
  api,
  balance,
  onNotice,
  onError,
}: {
  account: SessionAccount;
  api: AccountsApi;
  balance: bigint | null;
  onNotice: (text: string) => void;
  onError: (text: string) => void;
}) {
  const [mode, setMode] = useState<RowMode>('idle');
  const [label, setLabel] = useState(account.label);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [ack, setAck] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  const isActive = account.id === api.active.id;

  async function doExport() {
    setRowError(null);
    if (pw.length < 8) {
      setRowError('Password must be at least 8 characters.');
      return;
    }
    if (pw !== pw2) {
      setRowError('Passwords do not match.');
      return;
    }
    setBusy(true);
    setProgress(0);
    try {
      const json = await api.exportKeystore(account.id, pw, setProgress);
      downloadKeystore(json, account.address, account.label);
      setMode('idle');
      setPw('');
      setPw2('');
      onNotice(`Keystore for ${account.label} downloaded. It is encrypted with the password you just chose.`);
    } catch (e) {
      setRowError(e instanceof Error ? e.message : 'Export failed.');
    } finally {
      setBusy(false);
    }
  }

  function doRemove() {
    const result = api.remove(account.id);
    if (!result.ok) onError(result.error);
    else onNotice(`${account.label} removed from this session.`);
    setMode('idle');
  }

  return (
    <li className={isActive ? 'is-active' : undefined} data-testid={`manage-row-${account.address.toLowerCase()}`}>
      <div className="acct-manage-main">
        <Identicon address={account.address} size={32} />
        <div className="acct-manage-text">
          <div className="acct-manage-label">
            {account.label}
            {isActive && <span className="dir-badge dir-signed">ACTIVE</span>}
            <span className="acct-tag">{account.kind === 'hd' ? `HD #${account.index}` : 'IMPORTED'}</span>
            {account.backup === 'none' && (
              <span className="dir-badge dir-fail" title="This browser holds the only copy of this key.">
                NO BACKUP
              </span>
            )}
          </div>
          <div className="acct-manage-addr mono">
            {shortAddress(account.address)}
            <a
              href={`${EXPLORER_URL}/address/${account.address}`}
              target="_blank"
              rel="noreferrer noopener"
              title="Open on the explorer"
            >
              ↗
            </a>
          </div>
        </div>
        <div className="acct-manage-bal num">
          {balance === null ? (
            <span className="skeleton" style={{ minWidth: 60 }}>
              0.0000
            </span>
          ) : (
            <span title={`${formatAmountExact(balance)} ${NATIVE_SYMBOL}`}>
              {formatAmount(balance, 18, 4)} <span className="muted small">{NATIVE_SYMBOL}</span>
            </span>
          )}
        </div>
      </div>

      <div className="acct-manage-actions">
        {!isActive && (
          <button className="btn btn-sm" onClick={() => api.setActive(account.id)}>
            Use
          </button>
        )}
        <CopyButton text={account.address} label="Copy" />
        <button
          className="btn btn-ghost btn-sm"
          data-testid={`rename-${account.address.toLowerCase()}`}
          onClick={() => {
            setLabel(account.label);
            setRowError(null);
            setMode(mode === 'rename' ? 'idle' : 'rename');
          }}
        >
          Rename
        </button>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => {
            setRowError(null);
            setMode(mode === 'export' ? 'idle' : 'export');
          }}
        >
          Export
        </button>
        <button
          className="btn btn-danger-ghost btn-sm"
          onClick={() => {
            setAck(false);
            setRowError(null);
            setMode(mode === 'remove' ? 'idle' : 'remove');
          }}
        >
          Remove
        </button>
      </div>

      {mode === 'rename' && (
        <div className="acct-manage-form">
          <div className="input-row">
            <input
              className="input"
              value={label}
              maxLength={MAX_LABEL_LENGTH}
              autoFocus
              data-testid={`rename-input-${account.address.toLowerCase()}`}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  api.rename(account.id, label);
                  setMode('idle');
                }
                if (e.key === 'Escape') setMode('idle');
              }}
            />
            <button
              className="btn btn-primary"
              data-testid={`rename-save-${account.address.toLowerCase()}`}
              onClick={() => {
                api.rename(account.id, label);
                setMode('idle');
              }}
            >
              Save
            </button>
            <button className="btn" onClick={() => setMode('idle')}>
              Cancel
            </button>
          </div>
          <div className="field-hint">
            Labels are stored locally alongside the address — they are not secrets and never leave this device.
          </div>
        </div>
      )}

      {mode === 'export' && (
        <div className="acct-manage-form">
          <div className="field-hint" style={{ marginTop: 0, marginBottom: 8 }}>
            Downloads a scrypt-encrypted keystore for <span className="mono">{shortAddress(account.address)}</span>.
            Choose a password for the file — it is independent of the one that unlocks this device.
          </div>
          <div className="input-row">
            <input
              className="input"
              type="password"
              placeholder="File password"
              autoComplete="new-password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              disabled={busy}
            />
            <input
              className="input"
              type="password"
              placeholder="Confirm"
              autoComplete="new-password"
              value={pw2}
              onChange={(e) => setPw2(e.target.value)}
              disabled={busy}
            />
            <button className="btn btn-primary" onClick={() => void doExport()} disabled={busy || pw === ''}>
              {busy ? <Spinner /> : 'Download'}
            </button>
          </div>
          {busy && <ProgressBar fraction={progress} />}
          {rowError && <div className="field-error">{rowError}</div>}
        </div>
      )}

      {mode === 'remove' && (
        <div className="acct-manage-form">
          <div className={'notice ' + (account.backup === 'none' ? 'notice-danger' : 'notice-warn')} style={{ marginBottom: 10 }}>
            {account.backup === 'seed' && (
              <>
                <strong>{account.label}</strong> is derived from your recovery phrase. Restoring that phrase and
                adding accounts up to index {account.index} brings this address back — nothing on chain is
                affected.
              </>
            )}
            {account.backup === 'file' && (
              <>
                <strong>{account.label}</strong> was imported from — or exported to — a keystore file. Keep that
                file and its password: it is the only way back to this address.
              </>
            )}
            {account.backup === 'none' && (
              <>
                <strong>This browser holds the only copy of {account.label}’s key.</strong> It came from a raw
                private key and has never been exported. Removing it is permanent: any FMX or token at{' '}
                <span className="mono">{shortAddress(account.address)}</span> becomes unreachable. Export a
                keystore first.
              </>
            )}
          </div>
          {account.backup === 'none' && (
            <label className="check-row" style={{ marginBottom: 10 }}>
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              <span>I understand this key cannot be recovered.</span>
            </label>
          )}
          <div className="actions-row">
            <button
              className="btn btn-danger-ghost"
              data-testid={`confirm-remove-${account.address.toLowerCase()}`}
              disabled={account.backup === 'none' && !ack}
              onClick={doRemove}
            >
              Remove account
            </button>
            <button className="btn" onClick={() => setMode('idle')}>
              Keep
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

function ImportAccount({
  api,
  onCancel,
  onDone,
}: {
  api: AccountsApi;
  onCancel: () => void;
  onDone: (label: string) => void;
}) {
  const [tab, setTab] = useState<'key' | 'keystore'>('key');
  const [secret, setSecret] = useState('');
  const [json, setJson] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [filePw, setFilePw] = useState('');
  const [label, setLabel] = useState('');
  const [devicePw, setDevicePw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);

  const detected = json ? keystoreAddress(json) : null;

  async function onFile(file: File | undefined) {
    setError(null);
    setJson(null);
    setFileName(null);
    if (!file) return;
    try {
      const text = await file.text();
      if (!looksLikeKeystore(text)) {
        setError('This file is not a V3 keystore JSON.');
        return;
      }
      setJson(text);
      setFileName(file.name);
    } catch {
      setError('Could not read the file.');
    }
  }

  async function submit() {
    setError(null);
    if (api.remembered && devicePw === '') {
      setError('This device stores your accounts encrypted — enter its password so the new key can be encrypted too.');
      return;
    }
    setBusy(true);
    setProgress(0);
    try {
      const result =
        tab === 'key'
          ? await api.importPrivateKey({
              privateKey: secret,
              label,
              devicePassword: api.remembered ? devicePw : undefined,
              progress: setProgress,
            })
          : await api.importKeystoreFile({
              json: json ?? '',
              filePassword: filePw,
              label,
              devicePassword: api.remembered ? devicePw : undefined,
              progress: setProgress,
            });
      if (!result.ok) setError(result.error);
      else onDone(result.account.label);
    } finally {
      setBusy(false);
    }
  }

  const ready = tab === 'key' ? secret.trim() !== '' : json !== null && filePw !== '';

  return (
    <div>
      <div className="tabs" style={{ padding: 0, marginBottom: 16 }} role="tablist">
        {(
          [
            ['key', 'Private key'],
            ['keystore', 'Keystore file'],
          ] as const
        ).map(([id, text]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className="tab"
            onClick={() => {
              setTab(id);
              setError(null);
            }}
            disabled={busy}
          >
            {text}
          </button>
        ))}
      </div>

      {tab === 'key' ? (
        <div className="field">
          <label htmlFor="acct-import-key">Private key</label>
          <input
            id="acct-import-key"
            className="input input-mono"
            type="password"
            placeholder="0x…"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
          />
          <div className="field-hint">
            Stands alone beside your derived accounts — it has no relationship to your recovery phrase, so the
            phrase will not restore it.
          </div>
        </div>
      ) : (
        <>
          <div className="field">
            <label htmlFor="acct-import-file">Keystore JSON file</label>
            <input
              id="acct-import-file"
              className="input"
              type="file"
              accept=".json,application/json"
              onChange={(e) => void onFile(e.target.files?.[0])}
              disabled={busy}
            />
            {fileName && detected && (
              <div className="field-hint">
                {fileName} — address <span className="mono">{detected}</span>
              </div>
            )}
          </div>
          <div className="field">
            <label htmlFor="acct-import-filepw">Password for that file</label>
            <input
              id="acct-import-filepw"
              className="input"
              type="password"
              autoComplete="off"
              value={filePw}
              onChange={(e) => setFilePw(e.target.value)}
              disabled={busy || !json}
            />
          </div>
        </>
      )}

      <div className="field">
        <label htmlFor="acct-import-label">Label (optional)</label>
        <input
          id="acct-import-label"
          className="input"
          placeholder="Treasury, Cold storage, …"
          maxLength={MAX_LABEL_LENGTH}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          disabled={busy}
        />
      </div>

      {api.remembered && (
        <div className="field">
          <label htmlFor="acct-import-devicepw">Password for this device</label>
          <input
            id="acct-import-devicepw"
            className="input"
            type="password"
            autoComplete="current-password"
            value={devicePw}
            onChange={(e) => setDevicePw(e.target.value)}
            disabled={busy}
          />
          <div className="field-hint">
            Checked against your stored accounts first, then used to encrypt this one. It is never kept in memory
            after that.
          </div>
        </div>
      )}

      {error && <div className="field-error" style={{ marginBottom: 12 }}>{error}</div>}
      {busy ? (
        <>
          <ProgressBar fraction={progress} />
          <p className="small muted mb-0">Encrypting…</p>
        </>
      ) : (
        <div className="actions-row">
          <button className="btn" onClick={onCancel}>
            Back
          </button>
          <span className="push" />
          <button className="btn btn-primary" data-testid="do-import" onClick={() => void submit()} disabled={!ready}>
            Import account
          </button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Remember on this device                                             */
/* ------------------------------------------------------------------ */

function RememberSection({
  api,
  onCancel,
  onDone,
}: {
  api: AccountsApi;
  onCancel: () => void;
  onDone: (text: string, tone: 'ok' | 'warn') => void;
}) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [confirmOff, setConfirmOff] = useState(false);

  const unbacked = api.accounts.filter((a) => a.backup === 'none');

  async function enable() {
    setError(null);
    if (pw.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (pw !== pw2) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    setProgress(0);
    const failure = await api.enableRemember(pw, setProgress);
    setBusy(false);
    if (failure) setError(failure);
    else
      onDone(
        `All ${api.accounts.length} account${api.accounts.length === 1 ? '' : 's'} encrypted and stored on this device. One password unlocks the set.`,
        'ok',
      );
  }

  if (api.remembered) {
    return (
      <div>
        <div className="notice notice-success">
          This device holds an encrypted keystore for every account in this wallet. Unlocking decrypts the whole
          set with one password. Plaintext keys and your recovery phrase are never written to disk.
        </div>
        <p className="small muted">
          Labels, addresses and HD indices are stored alongside the encrypted keys as plain text — they are not
          secrets, and they are what makes the set reappear intact after a lock.
        </p>
        {!confirmOff ? (
          <div className="actions-row">
            <button className="btn" onClick={onCancel}>
              Back
            </button>
            <span className="push" />
            <button className="btn btn-danger-ghost" onClick={() => setConfirmOff(true)}>
              Stop storing on this device
            </button>
          </div>
        ) : (
          <>
            <div className="notice notice-danger">
              Removes every stored keystore from this browser. This session keeps working until you lock, but
              after that only your recovery phrase
              {unbacked.length > 0 && (
                <> — and it does not cover {unbacked.map((a) => a.label).join(', ')} —</>
              )}{' '}
              can restore these accounts.
            </div>
            <div className="actions-row">
              <button className="btn" onClick={() => setConfirmOff(false)}>
                Keep storing
              </button>
              <span className="push" />
              <button
                className="btn btn-danger-ghost"
                onClick={() => {
                  api.disableRemember();
                  onDone('This device no longer stores your accounts.', 'warn');
                }}
              >
                Remove stored accounts
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div>
      <p className="small muted">
        Encrypts every account in this session — the recovery phrase once, plus one keystore per imported key —
        and stores them in this browser. Unlocking then needs only the password.
      </p>
      <div className="field">
        <label htmlFor="remember-pw">Password</label>
        <input
          id="remember-pw"
          className="input"
          type="password"
          autoComplete="new-password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          disabled={busy}
        />
        <div className="field-hint">Minimum 8 characters. There is no reset.</div>
      </div>
      <div className="field">
        <label htmlFor="remember-pw2">Confirm password</label>
        <input
          id="remember-pw2"
          className="input"
          type="password"
          autoComplete="new-password"
          value={pw2}
          onChange={(e) => setPw2(e.target.value)}
          disabled={busy}
        />
      </div>
      {error && <div className="field-error" style={{ marginBottom: 12 }}>{error}</div>}
      {busy ? (
        <>
          <ProgressBar fraction={progress} />
          <p className="small muted mb-0">Encrypting {api.accounts.length} account(s)…</p>
        </>
      ) : (
        <div className="actions-row">
          <button className="btn" onClick={onCancel}>
            Back
          </button>
          <span className="push" />
          <button className="btn btn-primary" onClick={() => void enable()}>
            Store on this device
          </button>
        </div>
      )}
    </div>
  );
}
