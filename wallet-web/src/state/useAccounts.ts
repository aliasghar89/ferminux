// The unlocked multi-account session.
//
// Keys live here — in React state, in page memory — and nowhere else. Locking
// drops the whole set; only the encrypted vault survives in localStorage, and
// only when the user opted into "remember on this device".
//
// The device password is NEVER held. Operations that must write a new
// encrypted keystore ask for it, verify it against the vault first (encrypting
// under the wrong password would quietly make the whole set un-unlockable),
// use it, and let it go.

import { useCallback, useMemo, useState } from 'react';
import {
  deriveHdAccount,
  defaultHdLabel,
  defaultImportedLabel,
  findByAddress,
  nextHdIndex,
  normalizeLabel,
  uniqueLabel,
  type SessionAccount,
} from '../lib/accounts.ts';
import {
  decryptVault,
  encryptVault,
  newAccountId,
  vaultWithActive,
  vaultWithExported,
  vaultWithHdAccount,
  vaultWithImportedAccount,
  vaultWithLabel,
  vaultWithoutAccount,
  verifyVaultPassword,
  WrongPasswordError,
  type AccountSet,
  type FailedAccount,
  type Vault,
} from '../lib/vault.ts';
import {
  decryptKeyMaterial,
  encryptKeyKeystore,
  encryptSeedKeystore,
  walletFromPrivateKey,
  looksLikeKeystore,
} from '../lib/wallet.ts';
import { loadVault, saveVault, clearVault } from './storage.ts';

export type Progress = (fraction: number) => void;

export interface OpenOptions {
  /** Persist immediately under this password ("remember on this device"). */
  rememberPassword?: string;
  /** Seed keystore already encrypted under `rememberPassword` — saves one scrypt run. */
  seedKeystore?: string;
  progress?: Progress;
}

export interface AccountsApi {
  accounts: SessionAccount[];
  active: SessionAccount;
  /** True when the session holds a recovery phrase, so HD accounts can be added. */
  canDeriveHd: boolean;
  /** True when an encrypted vault is stored on this device. */
  remembered: boolean;
  /** Accounts a stored vault held but could not decrypt (reported, not hidden). */
  failed: FailedAccount[];
  addresses: string[];

  setActive: (id: string) => void;
  rename: (id: string, label: string) => void;
  addHdAccount: () => { ok: true; account: SessionAccount } | { ok: false; error: string };
  importPrivateKey: (input: ImportKeyInput) => Promise<ImportResult>;
  importKeystoreFile: (input: ImportKeystoreInput) => Promise<ImportResult>;
  exportKeystore: (id: string, password: string, progress?: Progress) => Promise<string>;
  remove: (id: string) => { ok: true } | { ok: false; error: string };
  enableRemember: (password: string, progress?: Progress) => Promise<string | null>;
  disableRemember: () => void;
}

export interface ImportKeyInput {
  privateKey: string;
  label: string;
  /** Required while remembered — used once, verified, then dropped. */
  devicePassword?: string;
  progress?: Progress;
}

export interface ImportKeystoreInput {
  json: string;
  filePassword: string;
  label: string;
  devicePassword?: string;
  progress?: Progress;
}

export type ImportResult = { ok: true; account: SessionAccount } | { ok: false; error: string };

export interface AccountSessionApi {
  set: AccountSet | null;
  vault: Vault | null;
  api: AccountsApi | null;
  /** Open a freshly created / imported session. */
  open: (set: AccountSet, options?: OpenOptions) => Promise<void>;
  /** Decrypt the stored vault. Throws WrongPasswordError on a bad password. */
  unlock: (password: string, progress?: Progress) => Promise<void>;
  /** Drop all key material; the encrypted vault (if any) stays. */
  lock: () => void;
  /** Remove the stored vault entirely. */
  forget: () => void;
}

export function useAccountSession(): AccountSessionApi {
  const [set, setSet] = useState<AccountSet | null>(null);
  const [vault, setVault] = useState<Vault | null>(() => loadVault());
  const [failed, setFailed] = useState<FailedAccount[]>([]);

  const persist = useCallback((next: Vault | null) => {
    setVault(next);
    if (next) saveVault(next);
  }, []);

  const open = useCallback(
    async (next: AccountSet, options?: OpenOptions) => {
      setFailed([]);
      if (options?.rememberPassword) {
        const encrypted = await encryptVault(next, options.rememberPassword, {
          progress: options.progress,
          seedKeystore: options.seedKeystore,
        });
        persist(encrypted);
      }
      setSet(next);
    },
    [persist],
  );

  const unlock = useCallback(
    async (password: string, progress?: Progress) => {
      const stored = vault ?? loadVault();
      if (!stored) throw new WrongPasswordError();
      const result = await decryptVault(stored, password, { progress });
      setVault(stored);
      setFailed(result.failed);
      setSet(result.set);
    },
    [vault],
  );

  const lock = useCallback(() => {
    setSet(null);
    setFailed([]);
    setVault(loadVault());
  }, []);

  const forget = useCallback(() => {
    clearVault();
    setVault(null);
    setSet(null);
    setFailed([]);
  }, []);

  const api = useMemo<AccountsApi | null>(() => {
    if (!set) return null;
    const active = set.accounts.find((a) => a.id === set.activeId) ?? set.accounts[0];

    const updateSet = (accounts: SessionAccount[], activeId = set.activeId) =>
      setSet({ accounts, activeId, mnemonic: set.mnemonic });

    const setActive = (id: string) => {
      if (!set.accounts.some((a) => a.id === id)) return;
      setSet({ ...set, activeId: id });
      if (vault) persist(vaultWithActive(vault, id));
    };

    const rename = (id: string, raw: string) => {
      const target = set.accounts.find((a) => a.id === id);
      if (!target) return;
      const fallback =
        target.kind === 'hd' && target.index !== null
          ? defaultHdLabel(target.index)
          : defaultImportedLabel(target.address);
      const others = set.accounts.filter((a) => a.id !== id).map((a) => a.label);
      const label = uniqueLabel(normalizeLabel(raw, fallback), others);
      updateSet(set.accounts.map((a) => (a.id === id ? { ...a, label } : a)));
      if (vault) persist(vaultWithLabel(vault, id, label));
    };

    const addHdAccount = (): { ok: true; account: SessionAccount } | { ok: false; error: string } => {
      if (!set.mnemonic) {
        return {
          ok: false,
          error:
            'This session has no recovery phrase, so there is nothing to derive from. Import another key instead, or restore from a phrase.',
        };
      }
      const used = set.accounts.filter((a) => a.kind === 'hd' && a.index !== null).map((a) => a.index as number);
      const index = nextHdIndex(used);
      let derived;
      try {
        derived = deriveHdAccount(set.mnemonic, index);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : 'Could not derive the next account.' };
      }
      if (findByAddress(set.accounts, derived.address)) {
        return { ok: false, error: 'That account is already in this wallet.' };
      }
      const account: SessionAccount = {
        id: newAccountId(),
        kind: 'hd',
        index,
        address: derived.address,
        label: uniqueLabel(defaultHdLabel(index), set.accounts.map((a) => a.label)),
        privateKey: derived.privateKey,
        origin: 'hd',
        backup: 'seed',
      };
      updateSet([...set.accounts, account], account.id);
      if (vault) persist(vaultWithActive(vaultWithHdAccount(vault, account), account.id));
      return { ok: true, account };
    };

    /** Encrypt a new key into a remembered vault, verifying the password first. */
    const storeImported = async (
      account: SessionAccount,
      devicePassword: string | undefined,
      progress: Progress | undefined,
      span: [number, number],
    ): Promise<string | null> => {
      if (!vault) return null; // not remembered — nothing to write
      if (!devicePassword) {
        return 'Enter the password for this device — new accounts have to be encrypted before they are stored.';
      }
      const [from, to] = span;
      const half = from + (to - from) / 2;
      const ok = await verifyVaultPassword(vault, devicePassword, {
        progress: (f) => progress?.(from + (half - from) * f),
      });
      if (!ok) return 'That is not the password this device was remembered with.';
      const keystore = await encryptKeyKeystore(account.address, account.privateKey, devicePassword, {
        progress: (f) => progress?.(half + (to - half) * f),
      });
      persist(vaultWithActive(vaultWithImportedAccount(vault, account, keystore, account.origin), account.id));
      return null;
    };

    const importPrivateKey = async (input: ImportKeyInput): Promise<ImportResult> => {
      let wallet;
      try {
        wallet = walletFromPrivateKey(input.privateKey);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : 'Not a valid private key.' };
      }
      const clash = findByAddress(set.accounts, wallet.address);
      if (clash) return { ok: false, error: `That key is already in this wallet as "${clash.label}".` };
      const account: SessionAccount = {
        id: newAccountId(),
        kind: 'imported',
        index: null,
        address: wallet.address,
        label: uniqueLabel(
          normalizeLabel(input.label, defaultImportedLabel(wallet.address)),
          set.accounts.map((a) => a.label),
        ),
        privateKey: wallet.privateKey,
        origin: 'privateKey',
        backup: 'none',
      };
      const error = await storeImported(account, input.devicePassword, input.progress, [0, 1]);
      if (error) return { ok: false, error };
      updateSet([...set.accounts, account], account.id);
      input.progress?.(1);
      return { ok: true, account };
    };

    const importKeystoreFile = async (input: ImportKeystoreInput): Promise<ImportResult> => {
      if (!looksLikeKeystore(input.json)) return { ok: false, error: 'This file is not a V3 keystore JSON.' };
      let material;
      try {
        material = await decryptKeyMaterial(input.json, input.filePassword, (f) => input.progress?.(f * 0.4));
      } catch {
        return { ok: false, error: 'Wrong password — the keystore file could not be decrypted.' };
      }
      const clash = findByAddress(set.accounts, material.address);
      if (clash) return { ok: false, error: `That account is already in this wallet as "${clash.label}".` };
      const account: SessionAccount = {
        id: newAccountId(),
        kind: 'imported',
        index: null,
        address: material.address,
        label: uniqueLabel(
          normalizeLabel(input.label, defaultImportedLabel(material.address)),
          set.accounts.map((a) => a.label),
        ),
        privateKey: material.privateKey,
        origin: 'keystore',
        // The user already holds this file, so the key is backed up.
        backup: 'file',
      };
      const error = await storeImported(account, input.devicePassword, input.progress, [0.4, 1]);
      if (error) return { ok: false, error };
      updateSet([...set.accounts, account], account.id);
      input.progress?.(1);
      return { ok: true, account };
    };

    /**
     * Encrypt one account to a fresh keystore file. The export password is
     * independent of the device password — the file has to survive on its own.
     */
    const exportKeystore = async (id: string, password: string, progress?: Progress): Promise<string> => {
      const account = set.accounts.find((a) => a.id === id);
      if (!account) throw new Error('Unknown account.');
      // HD account 0 exports with the phrase attached, matching what the
      // original single-account wallet downloaded; every other account exports
      // its key alone (a phrase belongs to the whole wallet, not to one row).
      const json =
        account.kind === 'hd' && account.index === 0 && set.mnemonic
          ? await encryptSeedKeystore(set.mnemonic, password, { progress })
          : await encryptKeyKeystore(account.address, account.privateKey, password, { progress });
      updateSet(set.accounts.map((a) => (a.id === id ? { ...a, backup: 'file' as const } : a)));
      if (vault) persist(vaultWithExported(vault, id));
      return json;
    };

    const remove = (id: string): { ok: true } | { ok: false; error: string } => {
      if (set.accounts.length <= 1) {
        return { ok: false, error: 'This is the only account — lock or forget the wallet instead.' };
      }
      const accounts = set.accounts.filter((a) => a.id !== id);
      const activeId = accounts.some((a) => a.id === set.activeId) ? set.activeId : accounts[0].id;
      updateSet(accounts, activeId);
      if (vault) persist(vaultWithoutAccount(vault, id));
      return { ok: true };
    };

    const enableRemember = async (password: string, progress?: Progress): Promise<string | null> => {
      try {
        const encrypted = await encryptVault(set, password, { progress });
        persist(encrypted);
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : 'Could not encrypt the accounts.';
      }
    };

    const disableRemember = () => {
      clearVault();
      setVault(null);
    };

    return {
      accounts: set.accounts,
      active,
      canDeriveHd: set.mnemonic !== null,
      remembered: vault !== null,
      failed,
      addresses: set.accounts.map((a) => a.address),
      setActive,
      rename,
      addHdAccount,
      importPrivateKey,
      importKeystoreFile,
      exportKeystore,
      remove,
      enableRemember,
      disableRemember,
    };
  }, [set, vault, failed, persist]);

  return { set, vault, api, open, unlock, lock, forget };
}
