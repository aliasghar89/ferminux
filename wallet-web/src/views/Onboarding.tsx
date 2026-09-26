import { useMemo, useState } from 'react';
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
import { passwordProblem } from '../lib/password.ts';
import type { OpenOptions } from '../state/useAccounts.ts';
import { downloadKeystore } from '../state/download.ts';
import { isNativeApp, type SaveFileResult } from '../platform/index.ts';
import { Here, encryptButtonLabel, here, keystoreHandOver, keystoreResult, storedWhere } from '../platform/words.ts';
import { MobileHandoff } from '../components/MobileHandoff.tsx';
import { CopyButton, ProgressBar, QrCanvas, Spinner } from '../components/ui.tsx';
import { fmxMark } from '../components/Brand.tsx';
import { IconBack, IconCheck, IconChevronDown, IconEye, IconGlobe, IconLink, IconShield } from '../components/icons.tsx';
import { CHAINS } from '../lib/chains.ts';

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
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
      {notice && <div className="notice">{notice}</div>}
      {mode === 'choice' && (
        <div className="welcome view-enter">
          <div>
            <img className="welcome-mark" src={fmxMark} alt="" width={56} height={56} />
            <h1 className="welcome-title">A self-custody wallet for Ferminux</h1>
            <p className="welcome-sub">
              FMX, FRC-20 tokens and NFTs on Ferminux, and the same address on {CHAINS.length - 1} other networks. One
              recovery phrase holds as many accounts as you need.
            </p>
            <ul className="facts-line">
              <li>
                <IconShield />
                <span>Keys are generated and encrypted {isNativeApp() ? 'on' : 'in'} {here()}. Nothing is ever sent to a server.</span>
              </li>
              <li>
                <IconGlobe />
                <span>{CHAINS.map((c) => c.name).join(', ')}.</span>
              </li>
              <li>
                <IconLink />
                <span>Connects to sites through WalletConnect and Connect with Ferminux Wallet.</span>
              </li>
            </ul>
          </div>
          <div>
            <div className="welcome-actions">
              <button className="btn btn-primary" data-testid="create-wallet" onClick={() => setMode('create')}>
                Create a new wallet
              </button>
              <button className="btn" data-testid="import-wallet" onClick={() => setMode('import')}>
                I already have a wallet
              </button>
            </div>
            {/* Desktop web only (a phone is already the phone, and so is the app); hidden inside a wallet's in-app browser. */}
            {!isNativeApp() && (
              <details className="details handoff-details" style={{ marginTop: 16 }}>
                <summary>
                  Use it on your phone instead <IconChevronDown />
                </summary>
                <MobileHandoff lede="Rather do this on your phone?" />
              </details>
            )}
          </div>
        </div>
      )}
      {mode === 'create' && <CreateFlow onBack={() => setMode('choice')} onOpen={onOpen} />}
      {mode === 'import' && <ImportFlow onBack={() => setMode('choice')} onOpen={onOpen} />}
    </div>
  );
}

/** Progress through the create flow: three steps, then done. */
function Steps({ at }: { at: 1 | 2 | 3 }) {
  return (
    <>
      <div className="steps" aria-hidden="true">
        {[1, 2, 3].map((n) => (
          <span key={n} className={n <= at ? 'on' : ''} />
        ))}
      </div>
      <div className="label step-kicker">Step {at} of 3</div>
    </>
  );
}

/** Three positions to confirm, each with the right word and two others from the phrase. */
function makeQuiz(words: string[]): { index: number; options: string[] }[] {
  const rand = (n: number) => {
    const b = new Uint32Array(1);
    crypto.getRandomValues(b);
    return b[0]! % n;
  };
  const picked = new Set<number>();
  while (picked.size < 3) picked.add(rand(words.length));
  return [...picked]
    .sort((x, y) => x - y)
    .map((index) => {
      const others = words.filter((w, i) => i !== index && w !== words[index]);
      const distract = new Set<string>();
      while (distract.size < Math.min(2, new Set(others).size)) distract.add(others[rand(others.length)]!);
      const options = [words[index]!, ...distract];
      for (let i = options.length - 1; i > 0; i -= 1) {
        const j = rand(i + 1);
        [options[i], options[j]] = [options[j]!, options[i]!];
      }
      return { index, options };
    });
}

/* ------------------------------------------------------------------ */
/* Create                                                              */
/* ------------------------------------------------------------------ */

function CreateFlow({ onBack, onOpen }: { onBack: () => void; onOpen: OpenFn }) {
  const [mnemonic] = useState<Mnemonic>(() => generateMnemonic());
  const [step, setStep] = useState<'phrase' | 'confirm' | 'password' | 'done'>('phrase');
  const [revealed, setRevealed] = useState(false);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [ready, setReady] = useState<{ set: AccountSet; options?: OpenOptions; json: string } | null>(null);
  const [saved, setSaved] = useState<SaveFileResult | 'failed' | null>(null);
  const [saving, setSaving] = useState(false);

  const words = mnemonic.phrase.split(' ');
  const quiz = useMemo(() => makeQuiz(words), [mnemonic.phrase]);
  const quizDone = quiz.every((q) => answers[q.index] === words[q.index]);

  async function encryptAndDownload() {
    setError(null);
    const weak = passwordProblem(pw);
    if (weak) {
      setError(weak);
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
      // The same encrypted seed is reused for the vault, so opting into
      // "remember" costs no second scrypt run.
      setReady({
        set: hdSetFromPhrase(mnemonic.phrase),
        options: remember ? { rememberPassword: pw, seedKeystore: json } : undefined,
        json,
      });
      setStep('done');
      // Web: a download. App: the share sheet, which the user may close without saving — the done screen says which.
      setSaved(await downloadKeystore(json, keystoreAddress(json) ?? '0x', 'account-1'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Encryption failed.');
    } finally {
      setBusy(false);
    }
  }

  if (step === 'phrase') {
    return (
      <div className="view-enter">
        <button className="back-btn" onClick={onBack}>
          <IconBack /> Back
        </button>
        <div className="flow-card">
          <Steps at={1} />
          <h1 className="flow-title">Your recovery phrase</h1>
          <p className="flow-sub">
            These 12 words are the only backup of this wallet. Write them down in order and keep them offline. Anyone
            who has them controls the funds.
          </p>
          <div className="mnemonic-wrap">
            <div className={'mnemonic-grid' + (revealed ? '' : ' is-veiled')} aria-hidden={!revealed}>
              {words.map((w, i) => (
                <span className="mnemonic-word" key={i}>
                  <span className="idx">{i + 1}</span>
                  {w}
                </span>
              ))}
            </div>
            {!revealed && (
              <button className="veil" data-testid="reveal-phrase" onClick={() => setRevealed(true)}>
                <IconEye />
                <strong>Reveal the phrase</strong>
                <span>Make sure nobody can see your screen.</span>
              </button>
            )}
          </div>
          <p className="field-hint">
            Every account you add later is derived from these words at m/44'/60'/0'/0/N, so the phrase restores the whole
            set, not just the first address.
          </p>
          {revealed && (
            <div className="actions-row" style={{ marginTop: 8, alignItems: 'center' }}>
              <CopyButton text={mnemonic.phrase} label="Copy phrase" secret />
              <span className="small muted">A copied phrase is wiped from the clipboard a minute later.</span>
            </div>
          )}
        </div>
        <div className="cta-bar cta-bar-flat">
          <button className="btn btn-primary btn-block" data-testid="phrase-continue" disabled={!revealed} onClick={() => setStep('confirm')}>
            I wrote it down
          </button>
        </div>
      </div>
    );
  }

  if (step === 'confirm') {
    return (
      <div className="view-enter">
        <button className="back-btn" onClick={() => setStep('phrase')}>
          <IconBack /> Back to the phrase
        </button>
        <div className="flow-card" data-secure-screen="">
          <Steps at={2} />
          <h1 className="flow-title">Confirm the phrase</h1>
          <p className="flow-sub">Pick the right word for each position, from what you wrote down.</p>
          <div className="quiz">
            {quiz.map((q) => {
              const chosen = answers[q.index];
              return (
                <div key={q.index} className="quiz-q" role="group" aria-label={`Word ${q.index + 1}`} data-quiz-index={q.index + 1}>
                  <div className="field-label">Word #{q.index + 1}</div>
                  <div className="quiz-opts">
                    {q.options.map((o) => (
                      <button
                        key={o}
                        className={'quiz-opt' + (chosen === o && o !== words[q.index] ? ' is-wrong' : '')}
                        aria-pressed={chosen === o}
                        onClick={() => setAnswers((a) => ({ ...a, [q.index]: o }))}
                      >
                        {o}
                      </button>
                    ))}
                  </div>
                  {chosen && chosen !== words[q.index] && (
                    <div className="field-error">That is not word #{q.index + 1}. Check what you wrote down.</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <div className="cta-bar cta-bar-flat">
          <button className="btn btn-primary btn-block" data-testid="confirm-continue" disabled={!quizDone} onClick={() => setStep('password')}>
            {quizDone ? (
              <>
                <IconCheck /> Continue
              </>
            ) : (
              'Continue'
            )}
          </button>
        </div>
      </div>
    );
  }

  if (step === 'password') {
    return (
      <div className="view-enter">
        <button className="back-btn" onClick={() => setStep('confirm')} disabled={busy}>
          <IconBack /> Back
        </button>
        <div className="flow-card">
          <Steps at={3} />
          <h1 className="flow-title">Set a keystore password</h1>
          <p className="flow-sub">
            Your key is encrypted with this password (scrypt) and {keystoreHandOver()}. The file and the password, or the
            recovery phrase, restore this wallet.
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
            <div className="field-hint">At least 8 characters, and not a common password. There is no reset: losing it means restoring from the phrase.</div>
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
          <label className="check-row">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} disabled={busy} />
            <span>
              Remember on this device
              <span className="field-hint" style={{ marginTop: 2 }}>
                Stores the <em>encrypted</em> keystore of every account {storedWhere()}, so one password unlocks the set.
                Never stores plaintext keys.
              </span>
            </span>
          </label>
          {error && <div className="field-error" style={{ marginTop: 14 }}>{error}</div>}
          {busy && (
            <>
              <ProgressBar fraction={progress} />
              <p className="small muted mb-0">Encrypting keystore…</p>
            </>
          )}
        </div>
        {!busy && (
          <div className="cta-bar cta-bar-flat">
            <button className="btn btn-primary btn-block" data-testid="encrypt-download" onClick={() => void encryptAndDownload()}>
              {encryptButtonLabel()}
            </button>
          </div>
        )}
      </div>
    );
  }

  // done
  const address = ready?.set.accounts[0].address ?? '';
  return (
    <div className="view-enter">
      <div className="flow-card" style={{ textAlign: 'center' }}>
        <div className="done-mark">
          <IconCheck />
        </div>
        <h1 className="flow-title">Wallet ready</h1>
        <p className="flow-sub" data-testid="keystore-saved" data-result={saved ?? 'pending'}>
          {saved === null
            ? isNativeApp()
              ? 'Save the keystore file from the share sheet.'
              : 'Downloading the keystore file…'
            : keystoreResult(saved).text}{' '}
          Keep the file with your password: together they restore this wallet on any device.
          {remember && ` ${Here()} keeps an encrypted copy, so the password alone unlocks it here.`}
        </p>
        {ready && (saved === 'cancelled' || saved === 'failed') && (
          <div className="actions-row" style={{ justifyContent: 'center', marginBottom: 12 }}>
            <button
              className="btn btn-sm"
              data-testid="keystore-save-again"
              disabled={saving}
              onClick={() => {
                setSaving(true);
                void downloadKeystore(ready.json, keystoreAddress(ready.json) ?? '0x', 'account-1').then((r) => {
                  setSaved(r);
                  setSaving(false);
                });
              }}
            >
              {saving ? <Spinner /> : isNativeApp() ? 'Save the keystore file again' : 'Download it again'}
            </button>
          </div>
        )}
        {ready && (
          <>
            <div className="qr-frame">
              <QrCanvas value={address} size={168} />
            </div>
            <p className="receive-addr">{address}</p>
            <div className="actions-row" style={{ justifyContent: 'center', marginTop: 4 }}>
              <CopyButton text={address} label="Copy address" />
            </div>
          </>
        )}
      </div>
      {ready && (
        <div className="cta-bar cta-bar-flat">
          <button className="btn btn-primary btn-block" data-testid="open-wallet" onClick={() => void onOpen(ready.set, ready.options)}>
            Open wallet
          </button>
        </div>
      )}
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
    <div className="view-enter">
      <button className="back-btn" onClick={onBack}>
        <IconBack /> Back
      </button>
      <div className="flow-card" data-secure-screen="">
        <h1 className="flow-title">Import a wallet</h1>
        <p className="flow-sub">Restore from a recovery phrase, a raw private key or a keystore JSON file. It stays {isNativeApp() ? 'on' : 'in'} {here()}.</p>
        <div className="seg import-tabs" role="tablist" aria-label="Import from">
          {(
            [
              ['phrase', 'Phrase'],
              ['key', 'Private key'],
              ['keystore', 'Keystore'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} data-testid={`import-tab-${id}`} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
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
    const weak = passwordProblem(pw);
    if (weak) {
      setError(weak);
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
            Account 1 is derived at m/44'/60'/0'/0/0. Add the rest from Accounts once you are in.
          </div>
        )}
        {kind === 'key' && (
          <div className="field-hint">
            A standalone key: it has no recovery phrase, so you will not be able to derive further accounts from
            it. You can still import more keys later.
          </div>
        )}
      </div>
      <label className="check-row" style={{ margin: '4px 0 16px' }}>
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} disabled={busy} />
        <span>
          Remember on this device
          <span className="field-hint" style={{ marginTop: 2 }}>
            Encrypts the key with a password (scrypt) and stores only the encrypted keystore {storedWhere()}.
          </span>
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
          className="btn btn-primary btn-block"
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
    // Remembered, the file's password becomes this device's password.
    const weak = remember ? passwordProblem(pw) : null;
    if (weak) {
      setError(
        `This file's password is too weak to guard a wallet stored on this device: ${weak} Import it without "Remember on this device", then store it from Settings → Security with a stronger password.`,
      );
      return;
    }
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
      <label className="check-row" style={{ margin: '4px 0 16px' }}>
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} disabled={busy} />
        <span>
          Remember on this device
          <span className="field-hint" style={{ marginTop: 2 }}>Stores this encrypted keystore {storedWhere()}.</span>
        </span>
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
        <button className="btn btn-primary btn-block" data-testid="import-keystore" onClick={() => void submit()} disabled={!json || pw === ''}>
          Unlock keystore
        </button>
      )}
    </div>
  );
}
