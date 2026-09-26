// App-only pieces of UI, rendered by the views and invisible on the web:
//   <BiometricUnlock>   the "Unlock with fingerprint" button on the unlock screen
//   <BiometricSetting>  turn fingerprint / Face ID unlock on or off (device settings area)
// Class names are the wallet's own (styles.css), so a redesign restyles these too.

import { useEffect, useRef, useState } from 'react';
import { verifyVaultPassword, WrongPasswordError } from '../lib/vault.ts';
import { loadVault } from '../state/storage.ts';
import { ProgressBar } from '../components/ui.tsx';
import { biometric, BiometricInvalidatedError, isNativeApp } from './index.ts';
import { useBiometric } from './react.ts';

/** Prompt automatically once per app start; after that only on a tap. */
let autoPrompted = false;

export function BiometricUnlock({
  onUnlock,
  disabled,
}: {
  /** The unlock screen's own password path: throws on a wrong password. */
  onUnlock: (password: string) => Promise<void>;
  disabled?: boolean;
}) {
  const { status, enabled } = useBiometric();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  async function run() {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const password = await biometric.unlock();
      if (password === null) return; // cancelled, or "Use password"
      try {
        await onUnlock(password);
      } catch (e) {
        if (e instanceof WrongPasswordError || /password/i.test(e instanceof Error ? e.message : '')) {
          // The stored password no longer opens this vault: stop offering it.
          await biometric.disable();
          setError('The saved password no longer opens this wallet, so biometric unlock was turned off. Use your password.');
        } else throw e;
      }
    } catch (e) {
      setError(e instanceof BiometricInvalidatedError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!isNativeApp() || !enabled || started.current || autoPrompted || disabled) return;
    started.current = true;
    autoPrompted = true;
    void run();
  }, [enabled, disabled]);

  if (!isNativeApp()) return null;
  if (!enabled) {
    // Biometric unlock was just switched off (the saved password is gone or no longer opens the wallet): say why.
    return error ? (
      <div className="field-error" data-testid="biometric-unlock-off" style={{ marginTop: 8 }}>
        {error}
      </div>
    ) : null;
  }
  const label = status?.label ?? 'Biometrics';
  return (
    <div className="biometric-unlock" data-testid="biometric-unlock">
      <button className="btn btn-block" onClick={() => void run()} disabled={busy || disabled}>
        {busy ? 'Waiting for ' + label.toLowerCase() + '…' : `Unlock with ${label.toLowerCase()}`}
      </button>
      {error && (
        <div className="field-error" style={{ marginTop: 8 }}>
          {error}
        </div>
      )}
    </div>
  );
}

export function BiometricSetting() {
  const { status, enabled, refresh } = useBiometric();
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (!isNativeApp()) return null;
  const label = status?.label ?? 'Biometrics';
  const lower = label.toLowerCase();

  async function turnOn() {
    setError(null);
    setDone(null);
    const vault = loadVault();
    if (!vault) {
      setError('Store the wallet on this device first: biometric unlock opens the stored, encrypted wallet.');
      return;
    }
    setBusy(true);
    setProgress(0);
    try {
      // Checked before it is kept: a wrong password behind the fingerprint would only fail later.
      const ok = await verifyVaultPassword(vault, pw, { progress: setProgress });
      if (!ok) {
        setError('Wrong password — it does not open the accounts stored on this device.');
        return;
      }
      await biometric.enable(pw);
      setPw('');
      setDone(`${label} unlock is on. Your password still works, and is needed after the device’s biometrics change.`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(/cancel/i.test(msg) ? `${label} unlock was not turned on.` : msg);
    } finally {
      setBusy(false);
      refresh();
    }
  }

  async function turnOff() {
    setError(null);
    await biometric.disable();
    setDone(`${label} unlock is off. Unlock with your password.`);
  }

  return (
    <div className="biometric-setting" data-testid="biometric-setting" style={{ marginTop: 16 }}>
      <h3 className="small" style={{ margin: '0 0 6px' }}>
        {label} unlock
      </h3>
      {status && !status.available && !enabled ? (
        <p className="small muted mb-0">{status.reason ?? `${label} is not available on this device.`}</p>
      ) : enabled ? (
        <>
          <p className="small muted">
            On. The wallet password is kept in this device’s secure hardware and released only to your {lower}.
          </p>
          <button className="btn" data-testid="biometric-off" onClick={() => void turnOff()}>
            Turn off {lower} unlock
          </button>
        </>
      ) : (
        <>
          <p className="small muted">
            Unlock with your {lower} instead of typing the password. The password is kept in this device’s secure
            hardware (Android Keystore / iOS Keychain) and released only after a {lower} check.
          </p>
          <div className="field">
            <label htmlFor="bio-pw">Wallet password</label>
            <input
              id="bio-pw"
              className="input"
              type="password"
              autoComplete="current-password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              disabled={busy}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && pw) void turnOn();
              }}
            />
          </div>
          {busy ? (
            <ProgressBar fraction={progress} />
          ) : (
            <button className="btn btn-primary" data-testid="biometric-on" onClick={() => void turnOn()} disabled={pw === ''}>
              Turn on {lower} unlock
            </button>
          )}
        </>
      )}
      {error && (
        <div className="field-error" style={{ marginTop: 8 }}>
          {error}
        </div>
      )}
      {done && (
        <div className="notice notice-success" style={{ marginTop: 10 }}>
          {done}
        </div>
      )}
    </div>
  );
}
