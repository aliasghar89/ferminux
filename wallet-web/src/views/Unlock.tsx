import { useState } from 'react';
import type { Vault } from '../lib/vault.ts';
import { ProgressBar } from '../components/ui.tsx';
import { Identicon } from '../components/Identicon.tsx';
import { shortAddress } from '../lib/validate.ts';
import { BiometricUnlock } from '../platform/ui.tsx';
import { fmxMark } from '../components/Brand.tsx';

/**
 * Unlock the whole stored set with one password. The addresses and labels are
 * public metadata inside the vault, so we can show exactly what is about to be
 * restored before any decryption happens.
 */
export function Unlock({
  vault,
  notice,
  onUnlock,
  onForgotten,
}: {
  vault: Vault;
  notice?: string;
  onUnlock: (password: string, progress?: (f: number) => void) => Promise<void>;
  onForgotten: () => void;
}) {
  const [pw, setPw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [confirmForget, setConfirmForget] = useState(false);

  const count = vault.accounts.length;

  /** Decrypt with `password`, showing progress; throws on a wrong password. */
  async function unlockWith(password: string) {
    setError(null);
    setBusy(true);
    setProgress(0);
    try {
      await onUnlock(password, setProgress);
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (pw === '' || busy) return;
    try {
      await unlockWith(pw);
    } catch {
      setError('Wrong password — the stored accounts could not be decrypted.');
    }
  }

  return (
    <div className="unlock">
      <div className="unlock-head">
        <img className="welcome-mark" src={fmxMark} alt="" width={56} height={56} />
        <h1 className="flow-title">Welcome back</h1>
        <p className="flow-sub" style={{ marginBottom: 0 }}>
          {count === 1
            ? 'One encrypted account is stored on this device.'
            : `${count} encrypted accounts are stored on this device.`}{' '}
          One password unlocks the set.
        </p>
      </div>
      {notice && <div className="notice">{notice}</div>}

      <ul className="unlock-accounts">
        {vault.accounts.map((account) => (
          <li key={account.id}>
            <Identicon address={account.address} size={28} />
            <span className="unlock-label">{account.label}</span>
            <span className="acct-tag">{account.kind === 'hd' ? `HD #${account.index}` : 'IMPORTED'}</span>
            <span className="unlock-addr mono">{shortAddress(account.address)}</span>
          </li>
        ))}
      </ul>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="field">
          <label htmlFor="unlock-pw">Password</label>
          <input
            id="unlock-pw"
            className="input"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            disabled={busy}
            aria-invalid={error ? true : undefined}
          />
        </div>
        {error && <div className="field-error" role="alert" style={{ margin: '-6px 0 14px' }}>{error}</div>}
        {busy ? (
          <>
            <ProgressBar fraction={progress} />
            <p className="small muted mb-0" style={{ textAlign: 'center' }}>
              Decrypting {count === 1 ? 'account' : `${count} accounts`}…
            </p>
          </>
        ) : (
          <button type="submit" className="btn btn-primary btn-block btn-lg" data-testid="unlock-submit" disabled={pw === ''}>
            Unlock
          </button>
        )}
      </form>
      {/* App only: fingerprint / Face ID releases the stored password (platform/ui.tsx). */}
      <div style={{ marginTop: 10 }}>
        <BiometricUnlock onUnlock={unlockWith} disabled={busy} />
      </div>

      <div className="unlock-foot">
        {!confirmForget ? (
          <button className="btn btn-ghost btn-sm" onClick={() => setConfirmForget(true)} disabled={busy}>
            Forget this device…
          </button>
        ) : (
          <div className="notice notice-warn" style={{ width: '100%', textAlign: 'left' }}>
            Removes every stored keystore. You will need your recovery phrase or an exported keystore file to restore these
            accounts.
            <div className="actions-row" style={{ marginTop: 12, justifyContent: 'flex-end', gap: 6 }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setConfirmForget(false)}>
                Keep
              </button>
              <button className="btn btn-danger-ghost btn-sm" onClick={onForgotten}>
                Forget
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
