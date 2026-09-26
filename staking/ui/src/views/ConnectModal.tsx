// Wallet connection: Ferminux Wallet (web, nothing to install), any injected
// wallet, WalletConnect when configured — or a session key imported from a
// private key / wallet-web keystore file. Session keys live in memory only.

import { useState } from 'react';
import type { WalletChoice } from '../../../../shared/fxwallet/connector.ts';
import type { WalletState } from '../state/useWallet.ts';
import { looksLikeKeystore } from '../lib/keys.ts';
import { Modal, Spinner } from '../components/ui.tsx';

function ChoiceIcon({ choice }: { choice: WalletChoice }) {
  if (choice.icon) return <img className="wallet-choice-icon" src={choice.icon} alt="" width={28} height={28} />;
  return (
    <span className="wallet-choice-icon wallet-choice-mono" aria-hidden="true">
      {choice.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function ConnectModal({
  wallet,
  onClose,
  onConnected,
}: {
  wallet: WalletState;
  onClose: () => void;
  onConnected: () => void;
}) {
  const [mode, setMode] = useState<'choice' | 'key'>('choice');
  const [secret, setSecret] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const isKeystore = looksLikeKeystore(secret);

  const connectWith = (id: string) => {
    setBusy(true);
    setError(null);
    // Called straight from the click so the Ferminux Wallet window may open.
    void wallet.connectWith(id).then((ok) => {
      setBusy(false);
      // useWallet keeps the reason in wallet.error; close only on success.
      if (ok) onConnected();
    });
  };

  const importKey = async () => {
    setBusy(true);
    setError(null);
    try {
      if (isKeystore) {
        await wallet.importKeystore(secret, password, setProgress);
      } else {
        wallet.importPrivateKey(secret);
      }
      setSecret('');
      setPassword('');
      onConnected();
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      setError(/password/i.test(msg) ? 'Wrong password for this keystore.' : msg);
    } finally {
      setBusy(false);
      setProgress(0);
    }
  };

  return (
    <Modal title="Connect wallet" onClose={onClose}>
      {mode === 'choice' ? (
        <>
          <ul className="wallet-choices" data-testid="wallet-choices">
            {wallet.choices.map((c) => (
              <li key={c.id}>
                <button className="wallet-choice" data-testid={`choice-${c.kind}`} onClick={() => connectWith(c.id)} disabled={busy}>
                  <ChoiceIcon choice={c} />
                  <span className="wallet-choice-main">
                    <span className="wallet-choice-name">
                      {c.name}
                      {c.featured && <span className="wallet-choice-tag">Recommended</span>}
                    </span>
                    <span className="wallet-choice-detail">{c.detail}</span>
                  </span>
                </button>
              </li>
            ))}
            <li>
              <button className="wallet-choice" data-testid="choice-session" onClick={() => setMode('key')} disabled={busy}>
                <span className="wallet-choice-icon wallet-choice-mono" aria-hidden="true">
                  K
                </span>
                <span className="wallet-choice-main">
                  <span className="wallet-choice-name">Session key</span>
                  <span className="wallet-choice-detail">A private key or wallet keystore file, kept in memory only</span>
                </span>
              </button>
            </li>
          </ul>
          {busy && (
            <p className="small muted wallet-choice-status">
              <Spinner /> Waiting for the wallet…
            </p>
          )}
          {wallet.error && !busy && (
            <div className="notice notice-danger" role="alert" style={{ marginTop: 12, marginBottom: 0 }}>
              {wallet.error}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="notice notice-warn">
            The key stays in this tab&apos;s memory only and is dropped on disconnect or close. Even so: prefer a
            browser wallet on machines you do not fully control.
          </div>
          <div className="field">
            <label htmlFor="connect-secret">Private key or keystore JSON</label>
            <textarea
              id="connect-secret"
              className="input input-mono"
              placeholder="0x… or {&quot;version&quot;:3,…}"
              spellCheck={false}
              autoComplete="off"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
            {isKeystore && <div className="field-hint">Keystore file detected — enter its password.</div>}
          </div>
          {isKeystore && (
            <div className="field">
              <label htmlFor="connect-password">Keystore password</label>
              <input
                id="connect-password"
                className="input"
                type="password"
                autoComplete="off"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          )}
          {error && (
            <div className="notice notice-danger" role="alert">
              {error}
            </div>
          )}
          <div className="actions-row">
            <button className="btn" onClick={() => setMode('choice')} disabled={busy}>
              Back
            </button>
            <button
              className="btn btn-primary push"
              disabled={busy || secret.trim() === '' || (isKeystore && password === '')}
              onClick={() => void importKey()}
            >
              {busy ? (
                <>
                  <Spinner />
                  {isKeystore ? ` Decrypting… ${Math.round(progress * 100)}%` : ' Importing…'}
                </>
              ) : (
                'Unlock'
              )}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
