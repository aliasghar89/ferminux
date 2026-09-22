import { useState } from 'react';
import type { Mnemonic } from 'ethers';
import {
  generateMnemonic,
  walletFromPrivateKey,
  isValidMnemonic,
  looksLikeKeystore,
  keystoreAddress,
  encryptSeedKeystore,
  decryptKeyMaterial,
} from '../lib/wallet.ts';
import { deriveHdAccount, defaultHdLabel, defaultImportedLabel } from '../lib/accounts.ts';
import type { SessionAccount } from '../lib/accounts.ts';
import { newAccountId, type AccountSet } from '../lib/vault.ts';
import type { OpenOptions } from '../state/useAccounts.ts';
import { downloadKeystore } from '../state/download.ts';
import { MobileHandoff } from '../components/MobileHandoff.tsx';
import { CopyButton, ProgressBar, QrCanvas, Spinner } from '../components/ui.tsx';

export type OpenFn = (set: AccountSet, options?: OpenOptions) => Promise<void>;

/** One HD account 0 plus the phrase, ready to grow. */
function hdSetFromPhrase(phrase: string): AccountSet {
  const derived = deriveHdAccount(phrase, 0);
  const account: SessionAccount = {
    id: newAccountId(),
    kind: 'hd',
    index: 0,
    address: derived.address,
    label: defaultHdLabel(0),
    privateKey: derived.privateKey,
    origin: 'hd',
    backup: 'seed',
  };
  return { accounts: [account], activeId: account.id, mnemonic: phrase };
}

function importedSet(
  address: string,
  privateKey: string,
  origin: 'privateKey' | 'keystore',
): AccountSet {
  const account: SessionAccount = {
    id: newAccountId(),
    kind: 'imported',
    index: null,
    address,
    label: defaultImportedLabel(address),
    privateKey,
    origin,
    backup: origin === 'keystore' ? 'file' : 'none',
  };
  return { accounts: [account], activeId: account.id, mnemonic: null };
}

export function Onboarding({ notice, onOpen }: { notice?: string; onOpen: OpenFn }) {
  const [mode, setMode] = useState<'choice' | 'create' | 'import'>('choice');

  return (
    <div>
      {notice && <div className="notice">{notice}</div>}
      {mode === 'choice' && (
        <>
          <h1 className="page-title">Self-custody wallet for the Ferminux Network</h1>
          <p className="page-sub">
            Keys are generated and stored in this page only. Nothing is ever sent to a server. One recovery
            phrase can hold as many accounts as you need.
          </p>
          <div className="onboard-choice">
            <button className="choice-card" data-testid="create-wallet" onClick={() => setMode('create')}>
              <div className="choice-kicker">NEW</div>
              <h3>Create a wallet</h3>
              <p>Generate a 12-word recovery phrase and a password-encrypted keystore file.</p>
            </button>
            <button className="choice-card" data-testid="import-wallet" onClick={() => setMode('import')}>
              <div className="choice-kicker">EXISTING</div>
              <h3>Import a wallet</h3>
              <p>Restore from a recovery phrase, a raw private key, or a keystore JSON file.</p>
            </button>
          </div>
          {/* Hidden inside a wallet's in-app browser — this page IS the wallet there. */}
          <div style={{ marginTop: 16 }}>
            <MobileHandoff lede="Rather do this on your phone?" />
          </div>
        </>
      )}
      {mode === 'create' && <CreateFlow onBack={() => setMode('choice')} onOpen={onOpen} />}
      {mode === 'import' && <ImportFlow onBack={() => setMode('choice')} onOpen={onOpen} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Create                                                              */
/* ------------------------------------------------------------------ */

function CreateFlow({ onBack, onOpen }: { onBack: () => void; onOpen: OpenFn }) {
  const [mnemonic] = useState<Mnemonic>(() => generateMnemonic());
  const [step, setStep] = useState<'phrase' | 'password' | 'done'>('phrase');
  const [saved, setSaved] = useState(false);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [ready, setReady] = useState<{ set: AccountSet; options?: OpenOptions } | null>(null);

  const words = mnemonic.phrase.split(' ');

  async function encryptAndDownload() {
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
    try {
      // The seed keystore holds account 0's key AND the encrypted phrase, so
      // this one file restores the whole HD wallet, not just one address.
      const json = await encryptSeedKeystore(mnemonic.phrase, pw, { progress: setProgress });
      downloadKeystore(json, keystoreAddress(json) ?? '0x', 'account-1');
      // The same encrypted seed is reused for the vault, so opting into
      // "remember" costs no second scrypt run.
      setReady({
        set: hdSetFromPhrase(mnemonic.phrase),
        options: remember ? { rememberPassword: pw, seedKeystore: json } : undefined,
      });
      setStep('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Encryption failed.');
    } finally {
      setBusy(false);
    }
  }

  if (step === 'phrase') {
    return (
      <div className="panel">
        <div className="panel-head">
          <h2>Recovery phrase</h2>
        </div>
        <div className="panel-body">
          <div className="notice notice-warn">
            These 12 words are the only backup of your wallet. Write them down and store them offline.
            Anyone holding them controls your funds. They are shown once.
          </div>
          <div className="mnemonic-grid">
            {words.map((w, i) => (
              <span className="mnemonic-word" key={i}>
                <span className="idx">{i + 1}</span>
                {w}
              </span>
            ))}
          </div>
          <p className="field-hint">
            Every account you add later is derived from these words at m/44'/60'/0'/0/N — the phrase restores the
            whole set, not just the first address.
          </p>
          <label className="check-row" style={{ margin: '18px 0' }}>
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
            <span>I wrote down my 12-word recovery phrase and stored it in a safe place.</span>
          </label>
          <div className="actions-row">
            <button className="btn" onClick={onBack}>
              Back
            </button>
            <span className="push" />
            <CopyButton text={mnemonic.phrase} label="Copy phrase" />
            <button className="btn btn-primary" data-testid="phrase-continue" disabled={!saved} onClick={() => setStep('password')}>
              Continue
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (step === 'password') {
    return (
      <div className="panel">
        <div className="panel-head">
          <h2>Set a keystore password</h2>
        </div>
        <div className="panel-body">
          <p className="small muted">
            Your key is encrypted with this password (scrypt) and the keystore file downloads automatically.
            You need the file and the password — or the recovery phrase — to restore this wallet.
          </p>
          <div className="field">
            <label htmlFor="c-pw">Password</label>
            <input
              id="c-pw"
              className="input"
              type="password"
              autoComplete="new-password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              disabled={busy}
            />
            <div className="field-hint">Minimum 8 characters. There is no reset — losing it means restoring from the phrase.</div>
          </div>
          <div className="field">
            <label htmlFor="c-pw2">Confirm password</label>
            <input
              id="c-pw2"
              className="input"
              type="password"
              autoComplete="new-password"
              value={pw2}
              onChange={(e) => setPw2(e.target.value)}
              disabled={busy}
            />
          </div>
          <label className="check-row" style={{ margin: '4px 0 16px' }}>
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} disabled={busy} />
            <span>
              Remember on this device — stores the <em>encrypted</em> keystore of every account in this browser
              so one password unlocks the whole set. Never stores plaintext keys.
            </span>
          </label>
          {error && <div className="field-error">{error}</div>}
          {busy && (
            <>
              <ProgressBar fraction={progress} />
              <p className="small muted mb-0">Encrypting keystore…</p>
            </>
          )}
          {!busy && (
            <div className="actions-row" style={{ marginTop: 8 }}>
              <button className="btn" onClick={() => setStep('phrase')}>
                Back
              </button>
              <span className="push" />
              <button className="btn btn-primary" data-testid="encrypt-download" onClick={() => void encryptAndDownload()}>
                Encrypt &amp; download keystore
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // done
  const address = ready?.set.accounts[0].address ?? '';
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Wallet ready</h2>
      </div>
      <div className="panel-body" style={{ textAlign: 'center' }}>
        <div className="notice notice-success" style={{ textAlign: 'left' }}>
          Keystore file downloaded. Store it with your password — together they restore this wallet on any device.
          {remember && ' This browser will keep an encrypted copy so you can unlock with the password alone.'}
        </div>
        {ready && (
          <>
            <div className="qr-frame">
              <QrCanvas value={address} />
            </div>
            <p className="mono small" style={{ wordBreak: 'break-all' }}>
              {address}
            </p>
            <div className="actions-row" style={{ justifyContent: 'center', marginTop: 16 }}>
              <CopyButton text={address} label="Copy address" />
              <button
                className="btn btn-primary btn-lg"
                data-testid="open-wallet"
                onClick={() => void onOpen(ready.set, ready.options)}
              >
                Open wallet
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

type ImportTab = 'phrase' | 'key' | 'keystore';

function ImportFlow({ onBack, onOpen }: { onBack: () => void; onOpen: OpenFn }) {
  const [tab, setTab] = useState<ImportTab>('phrase');
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Import a wallet</h2>
        <span className="spacer" />
        <button className="btn btn-ghost btn-sm" onClick={onBack}>
          Back
        </button>
      </div>
      <div className="tabs" role="tablist" style={{ padding: '0 20px' }}>
        {(
          [
            ['phrase', 'Recovery phrase'],
            ['key', 'Private key'],
            ['keystore', 'Keystore file'],
          ] as const
        ).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className="tab" onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="panel-body">
        {tab === 'phrase' && <ImportSecret kind="phrase" onOpen={onOpen} />}
        {tab === 'key' && <ImportSecret kind="key" onOpen={onOpen} />}
        {tab === 'keystore' && <ImportKeystore onOpen={onOpen} />}
      </div>
    </div>
  );
}

/** Shared form for the two plaintext-secret tabs (phrase / raw key). */
function ImportSecret({ kind, onOpen }: { kind: 'phrase' | 'key'; onOpen: OpenFn }) {
  const [secret, setSecret] = useState('');
  const [remember, setRemember] = useState(false);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);

  async function submit() {
    setError(null);
    let set: AccountSet;
    try {
      if (kind === 'phrase') {
        if (!isValidMnemonic(secret)) {
          setError('Not a valid BIP-39 recovery phrase — check the words and their order.');
          return;
        }
        set = hdSetFromPhrase(secret);
      } else {
        const w = walletFromPrivateKey(secret);
        set = importedSet(w.address, w.privateKey, 'privateKey');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not import this secret.');
      return;
    }
    if (!remember) {
      await onOpen(set);
      return;
    }
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
    try {
      await onOpen(set, { rememberPassword: pw, progress: setProgress });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Encryption failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="field">
        <label htmlFor={`imp-${kind}`}>{kind === 'phrase' ? '12 or 24 word recovery phrase' : 'Private key'}</label>
        {kind === 'phrase' ? (
          <textarea
            id={`imp-${kind}`}
            className="input input-mono"
            placeholder="word1 word2 word3 …"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            disabled={busy}
            spellCheck={false}
            autoComplete="off"
          />
        ) : (
          <input
            id={`imp-${kind}`}
            className="input input-mono"
            type="password"
            placeholder="0x…"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
          />
        )}
        {kind === 'phrase' && (
          <div className="field-hint">
            Account 1 is derived at m/44'/60'/0'/0/0; add the rest from the Accounts panel once you are in.
          </div>
        )}
        {kind === 'key' && (
          <div className="field-hint">
            A standalone key: it has no recovery phrase, so you will not be able to derive further accounts from
            it. You can still import more keys later.
          </div>
        )}
      </div>
      <label className="check-row" style={{ margin: '4px 0 14px' }}>
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} disabled={busy} />
        <span>
          Remember on this device — encrypts the key with a password (scrypt) and stores only the encrypted
          keystore in this browser.
        </span>
      </label>
      {remember && (
        <>
          <div className="field">
            <label htmlFor={`imp-${kind}-pw`}>Password</label>
            <input
              id={`imp-${kind}-pw`}
              className="input"
              type="password"
              autoComplete="new-password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="field">
            <label htmlFor={`imp-${kind}-pw2`}>Confirm password</label>
            <input
              id={`imp-${kind}-pw2`}
              className="input"
              type="password"
              autoComplete="new-password"
              value={pw2}
              onChange={(e) => setPw2(e.target.value)}
              disabled={busy}
            />
          </div>
        </>
      )}
      {error && <div className="field-error" style={{ marginBottom: 12 }}>{error}</div>}
      {busy ? (
        <>
          <ProgressBar fraction={progress} />
          <p className="small muted mb-0">Encrypting keystore…</p>
        </>
      ) : (
        <button
          className="btn btn-primary"
          data-testid={`import-${kind}`}
          onClick={() => void submit()}
          disabled={secret.trim() === ''}
        >
          Import wallet
        </button>
      )}
    </div>
  );
}

function ImportKeystore({ onOpen }: { onOpen: OpenFn }) {
  const [json, setJson] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [pw, setPw] = useState('');
  const [remember, setRemember] = useState(false);
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
    if (!json) return;
    setError(null);
    setBusy(true);
    setProgress(0);
    try {
      const material = await decryptKeyMaterial(json, pw, (f) => setProgress(f * (remember ? 0.5 : 1)));
      // A keystore that carries the BIP-39 entropy restores the whole HD
      // wallet; one without it is a single standalone key.
      const set = material.mnemonicPhrase
        ? hdSetFromPhrase(material.mnemonicPhrase)
        : importedSet(material.address, material.privateKey, 'keystore');
      await onOpen(
        set,
        remember
          ? {
              rememberPassword: pw,
              // Same password, same phrase → the uploaded file is already the
              // vault's seed keystore; re-encrypting it would be pure waste.
              seedKeystore: material.mnemonicPhrase ? json : undefined,
              progress: (f) => setProgress(0.5 + f * 0.5),
            }
          : undefined,
      );
    } catch {
      setError('Wrong password — the keystore could not be decrypted.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="field">
        <label htmlFor="ks-file">Keystore JSON file</label>
        <input
          id="ks-file"
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
        <label htmlFor="ks-pw">Keystore password</label>
        <input
          id="ks-pw"
          className="input"
          type="password"
          autoComplete="current-password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          disabled={busy || !json}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && json && pw) void submit();
          }}
        />
      </div>
      <label className="check-row" style={{ margin: '4px 0 14px' }}>
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} disabled={busy} />
        <span>Remember on this device — stores this encrypted keystore in this browser.</span>
      </label>
      {error && <div className="field-error" style={{ marginBottom: 12 }}>{error}</div>}
      {busy ? (
        <>
          <ProgressBar fraction={progress} />
          <p className="small muted mb-0">
            <Spinner /> Decrypting…
          </p>
        </>
      ) : (
        <button className="btn btn-primary" onClick={() => void submit()} disabled={!json || pw === ''}>
          Unlock keystore
        </button>
      )}
    </div>
  );
}
