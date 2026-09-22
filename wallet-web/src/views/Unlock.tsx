import { useState } from 'react';
import type { Vault } from '../lib/vault.ts';
import { ProgressBar } from '../components/ui.tsx';
import { Identicon } from '../components/Identicon.tsx';
import { shortAddress } from '../lib/validate.ts';

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

  async function submit() {
    if (pw === '' || busy) return;
    setError(null);
    setBusy(true);
    setProgress(0);
    try {
      await onUnlock(pw, setProgress);
    } catch {
      setError('Wrong password — the stored accounts could not be decrypted.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 460, margin: '40px auto 0' }}>
      {notice && <div className="notice">{notice}</div>}
      <div className="panel">
        <div className="panel-head">
          <h2>Unlock wallet</h2>
        </div>
        <div className="panel-body">
          <p className="small muted">
            {count === 1
              ? 'One encrypted account is stored on this device.'
              : `${count} encrypted accounts are stored on this device.`}{' '}
            One password unlocks the set.
          </p>

          <ul className="unlock-accounts">
            {vault.accounts.map((account) => (
              <li key={account.id}>
                <Identicon address={account.address} size={22} />
                <span className="unlock-label">{account.label}</span>
                <span className="unlock-addr mono">{shortAddress(account.address)}</span>
                <span className="acct-tag">{account.kind === 'hd' ? `HD #${account.index}` : 'IMPORTED'}</span>
              </li>
            ))}
          </ul>

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
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
              }}
            />
          </div>
          {error && <div className="field-error" style={{ marginBottom: 12 }}>{error}</div>}
          {busy ? (
            <>
              <ProgressBar fraction={progress} />
              <p className="small muted mb-0">
                Decrypting {count === 1 ? 'account' : `${count} accounts`}…
              </p>
            </>
          ) : (
            <button className="btn btn-primary btn-block" data-testid="unlock-submit" onClick={() => void submit()} disabled={pw === ''}>
              Unlock
            </button>
          )}
        </div>
      </div>
      <div className="actions-row" style={{ marginTop: 14, justifyContent: 'center' }}>
        {!confirmForget ? (
          <button className="btn btn-ghost btn-sm" onClick={() => setConfirmForget(true)} disabled={busy}>
            Forget this device…
          </button>
        ) : (
          <>
            <span className="small muted">
              Removes every stored keystore. You will need your recovery phrase or an exported keystore file to
              restore these accounts.
            </span>
            <button className="btn btn-danger-ghost btn-sm" onClick={onForgotten}>
              Forget
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setConfirmForget(false)}>
              Keep
            </button>
          </>
        )}
      </div>
    </div>
  );
}
