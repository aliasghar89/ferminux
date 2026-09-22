// The multi-account vault: what "remember on this device" actually writes.
// No browser globals — this module only turns objects into strings and back,
// so the Node test suite exercises the exact bytes the browser stores.
//
// WHAT IS IN THE BLOB
//   • one scrypt-encrypted V3 keystore for the HD *seed* (account 0's key plus
//     the BIP-39 entropy, both encrypted)
//   • one scrypt-encrypted V3 keystore per *imported* account
//   • public metadata only: addresses, labels, HD indices, the active id
//
// HD accounts beyond index 0 store nothing but the integer N — the phrase
// regenerates them, so there is no second copy of a key to protect.
//
// WHAT IS NEVER IN THE BLOB
//   private keys, the mnemonic, the password. `assertNoPlaintextSecrets`
//   below is the executable form of that claim and the unit tests run it
//   against a real serialized vault.

import { getAddress, randomBytes, hexlify } from 'ethers';
import {
  encryptSeedKeystore,
  encryptKeyKeystore,
  decryptKeyMaterial,
  keystoreHasMnemonic,
  keystoreAddress,
  looksLikeKeystore,
} from './wallet.ts';
import {
  deriveHdAccounts,
  defaultHdLabel,
  defaultImportedLabel,
  normalizeLabel,
  type SessionAccount,
  type AccountOrigin,
} from './accounts.ts';

export const VAULT_VERSION = 2;

/** localStorage keys. v1 held a single bare keystore string. */
export const VAULT_KEY = 'ferminux.wallet.vault.v2';
export const LEGACY_KEYSTORE_KEY = 'ferminux.wallet.keystore.v1';

export interface StoredHdAccount {
  id: string;
  kind: 'hd';
  index: number;
  address: string;
  label: string;
}

export interface StoredImportedAccount {
  id: string;
  kind: 'imported';
  address: string;
  label: string;
  /** Standard V3 keystore, encrypted under the device password. */
  keystore: string;
  origin: 'privateKey' | 'keystore';
  /** The user holds a keystore file for this key (imported from one, or exported). */
  exported: boolean;
}

export type StoredAccount = StoredHdAccount | StoredImportedAccount;

export interface Vault {
  version: number;
  /** Encrypted HD seed keystore, or null when the session has no phrase. */
  seed: string | null;
  accounts: StoredAccount[];
  activeId: string | null;
}

/** An unlocked set of accounts plus the phrase needed to grow it. */
export interface AccountSet {
  accounts: SessionAccount[];
  activeId: string;
  /** In page memory only; null when no HD phrase is part of this session. */
  mnemonic: string | null;
}

export interface FailedAccount {
  id: string;
  address: string;
  label: string;
  reason: string;
}

export interface UnlockResult {
  set: AccountSet;
  /** Accounts whose stored keystore could not be decrypted with this password. */
  failed: FailedAccount[];
}

export class WrongPasswordError extends Error {
  constructor() {
    super('Wrong password — the stored accounts could not be decrypted.');
    this.name = 'WrongPasswordError';
  }
}

type ProgressFn = (fraction: number) => void;
export interface CryptoOpts {
  progress?: ProgressFn;
  /** Only lowered in tests; production uses the ethers default (2^17). */
  scryptN?: number;
  /**
   * A seed keystore already encrypted under the SAME password — reused instead
   * of running scrypt a second time (onboarding encrypts one for the download
   * anyway). Passing one encrypted under a different password would make the
   * vault un-unlockable, so only pass the value you just produced.
   */
  seedKeystore?: string;
}

/** Stable, non-secret identifier for an account row. */
export function newAccountId(): string {
  return hexlify(randomBytes(8)).slice(2);
}

/* ------------------------------------------------------------------ */
/* Serialization                                                       */
/* ------------------------------------------------------------------ */

export function serializeVault(vault: Vault): string {
  return JSON.stringify({
    version: VAULT_VERSION,
    seed: vault.seed,
    accounts: vault.accounts,
    activeId: vault.activeId,
  });
}

/** Parse a stored blob. Returns null for anything we do not recognise. */
export function parseVault(raw: string): Vault | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const obj = data as Record<string, unknown>;
  if (obj.version !== VAULT_VERSION) return null;
  if (!Array.isArray(obj.accounts)) return null;

  const seed = typeof obj.seed === 'string' && looksLikeKeystore(obj.seed) ? obj.seed : null;
  const accounts: StoredAccount[] = [];
  for (const item of obj.accounts) {
    const parsed = parseStoredAccount(item);
    if (parsed && !accounts.some((a) => a.id === parsed.id)) accounts.push(parsed);
  }
  // An HD row without a seed can never be derived — drop it rather than
  // showing an account the session cannot sign for.
  const usable = seed ? accounts : accounts.filter((a) => a.kind === 'imported');
  if (usable.length === 0) return null;
  const activeId =
    typeof obj.activeId === 'string' && usable.some((a) => a.id === obj.activeId)
      ? obj.activeId
      : (usable[0]?.id ?? null);
  return { version: VAULT_VERSION, seed, accounts: usable, activeId };
}

function parseStoredAccount(item: unknown): StoredAccount | null {
  if (typeof item !== 'object' || item === null) return null;
  const o = item as Record<string, unknown>;
  if (typeof o.id !== 'string' || o.id === '') return null;
  if (typeof o.address !== 'string') return null;
  let address: string;
  try {
    address = getAddress(o.address);
  } catch {
    return null;
  }
  const label = typeof o.label === 'string' ? o.label : '';
  if (o.kind === 'hd') {
    if (typeof o.index !== 'number' || !Number.isInteger(o.index) || o.index < 0) return null;
    return { id: o.id, kind: 'hd', index: o.index, address, label: normalizeLabel(label, defaultHdLabel(o.index)) };
  }
  if (o.kind === 'imported') {
    if (typeof o.keystore !== 'string' || !looksLikeKeystore(o.keystore)) return null;
    return {
      id: o.id,
      kind: 'imported',
      address,
      label: normalizeLabel(label, defaultImportedLabel(address)),
      keystore: o.keystore,
      origin: o.origin === 'keystore' ? 'keystore' : 'privateKey',
      exported: o.exported === true,
    };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Migration from the single-account format                            */
/* ------------------------------------------------------------------ */

/**
 * Upgrade a v1 install: one bare keystore string under
 * `ferminux.wallet.keystore.v1`. The encrypted bytes are carried over
 * verbatim, so the user's existing password keeps working and nothing is
 * re-encrypted (which would need a password we do not have at load time).
 *
 * A keystore carrying a mnemonic becomes the HD *seed* plus account 0, so the
 * upgraded wallet can immediately add more accounts. One without a mnemonic
 * (imported from a raw key or a foreign keystore file) becomes a standalone
 * imported account.
 */
export function migrateLegacyKeystore(json: string): Vault | null {
  if (typeof json !== 'string' || !looksLikeKeystore(json)) return null;
  const address = keystoreAddress(json);
  if (!address) return null;
  const id = newAccountId();
  if (keystoreHasMnemonic(json)) {
    return {
      version: VAULT_VERSION,
      seed: json,
      accounts: [{ id, kind: 'hd', index: 0, address, label: defaultHdLabel(0) }],
      activeId: id,
    };
  }
  return {
    version: VAULT_VERSION,
    seed: null,
    accounts: [
      {
        id,
        kind: 'imported',
        address,
        label: defaultHdLabel(0),
        keystore: json,
        origin: 'keystore',
        exported: true,
      },
    ],
    activeId: id,
  };
}

/* ------------------------------------------------------------------ */
/* Encrypt / decrypt a whole set                                       */
/* ------------------------------------------------------------------ */

/**
 * Encrypt an unlocked set for storage. One scrypt run for the seed and one per
 * imported account; `progress` reports across the whole job, not per account.
 */
export async function encryptVault(set: AccountSet, password: string, opts?: CryptoOpts): Promise<Vault> {
  // An HD account is stored as its index only — but only when the session
  // actually holds the phrase that regenerates it. Without one, its key is
  // encrypted like any standalone key rather than silently dropped.
  const derivable = (a: SessionAccount) => a.kind === 'hd' && a.index !== null && set.mnemonic !== null;
  const reuseSeed = set.mnemonic && opts?.seedKeystore && looksLikeKeystore(opts.seedKeystore) ? opts.seedKeystore : null;
  const total = (set.mnemonic && !reuseSeed ? 1 : 0) + set.accounts.filter((a) => !derivable(a)).length;
  let done = 0;
  const step = (f: number) => opts?.progress?.(total === 0 ? 1 : (done + f) / total);

  let seed: string | null = reuseSeed;
  if (set.mnemonic && !reuseSeed) {
    seed = await encryptSeedKeystore(set.mnemonic, password, { progress: step, scryptN: opts?.scryptN });
    done += 1;
  }

  const accounts: StoredAccount[] = [];
  for (const account of set.accounts) {
    if (derivable(account)) {
      accounts.push({
        id: account.id,
        kind: 'hd',
        index: account.index as number,
        address: account.address,
        label: account.label,
      });
      continue;
    }
    const keystore = await encryptKeyKeystore(account.address, account.privateKey, password, {
      progress: step,
      scryptN: opts?.scryptN,
    });
    done += 1;
    accounts.push({
      id: account.id,
      kind: 'imported',
      address: account.address,
      label: account.label,
      keystore,
      origin: account.origin === 'privateKey' ? 'privateKey' : 'keystore',
      exported: account.backup === 'file',
    });
  }
  opts?.progress?.(1);
  const activeId = accounts.some((a) => a.id === set.activeId) ? set.activeId : (accounts[0]?.id ?? null);
  return { version: VAULT_VERSION, seed, accounts, activeId };
}

/**
 * Decrypt a stored vault with one password.
 *
 * The first keystore decides whether the password is right: if it fails, the
 * password is wrong and nothing else is attempted. If a *later* keystore fails
 * (a vault written across a password change, or a corrupted row) the rest of
 * the set still unlocks and the failure is reported — losing one account must
 * not lock the user out of the others.
 */
export async function decryptVault(vault: Vault, password: string, opts?: CryptoOpts): Promise<UnlockResult> {
  const importedRows = vault.accounts.filter((a): a is StoredImportedAccount => a.kind === 'imported');
  const total = (vault.seed ? 1 : 0) + importedRows.length;
  if (total === 0) throw new WrongPasswordError();
  let done = 0;
  const step = (f: number) => opts?.progress?.((done + f) / total);

  let mnemonic: string | null = null;
  let seedKey: { address: string; privateKey: string } | null = null;
  let first = true;

  if (vault.seed) {
    try {
      const material = await decryptKeyMaterial(vault.seed, password, step);
      mnemonic = material.mnemonicPhrase;
      seedKey = { address: material.address, privateKey: material.privateKey };
    } catch {
      throw new WrongPasswordError();
    }
    first = false;
    done += 1;
  }

  const accounts: SessionAccount[] = [];
  const failed: FailedAccount[] = [];

  // HD rows: derived from the phrase in one pass.
  const hdRows = vault.accounts.filter((a): a is StoredHdAccount => a.kind === 'hd');
  if (hdRows.length > 0) {
    if (mnemonic) {
      const derived = deriveHdAccounts(
        mnemonic,
        hdRows.map((r) => r.index),
      );
      hdRows.forEach((row, i) => {
        const d = derived[i];
        if (d.address.toLowerCase() !== row.address.toLowerCase()) {
          failed.push({
            id: row.id,
            address: row.address,
            label: row.label,
            reason: 'Stored address does not match the address this phrase derives at that index.',
          });
          return;
        }
        accounts.push({
          id: row.id,
          kind: 'hd',
          index: row.index,
          address: d.address,
          label: row.label,
          privateKey: d.privateKey,
          origin: 'hd',
          backup: 'seed',
        });
      });
    } else if (seedKey) {
      // Seed keystore without recoverable entropy: index 0 still works.
      for (const row of hdRows) {
        if (row.index === 0 && seedKey.address.toLowerCase() === row.address.toLowerCase()) {
          accounts.push({
            id: row.id,
            kind: 'hd',
            index: 0,
            address: seedKey.address,
            label: row.label,
            privateKey: seedKey.privateKey,
            origin: 'hd',
            backup: 'seed',
          });
        } else {
          failed.push({
            id: row.id,
            address: row.address,
            label: row.label,
            reason: 'The stored seed no longer carries a recovery phrase, so this account cannot be derived.',
          });
        }
      }
    }
  }

  for (const row of importedRows) {
    try {
      const material = await decryptKeyMaterial(row.keystore, password, step);
      if (material.address.toLowerCase() !== row.address.toLowerCase()) {
        failed.push({ id: row.id, address: row.address, label: row.label, reason: 'Keystore address mismatch.' });
      } else {
        accounts.push({
          id: row.id,
          kind: 'imported',
          index: null,
          address: material.address,
          label: row.label,
          privateKey: material.privateKey,
          origin: row.origin,
          backup: row.exported ? 'file' : 'none',
        });
      }
    } catch {
      if (first) throw new WrongPasswordError();
      failed.push({
        id: row.id,
        address: row.address,
        label: row.label,
        reason: 'This account is encrypted under a different password.',
      });
    }
    first = false;
    done += 1;
  }

  if (accounts.length === 0) throw new WrongPasswordError();
  // Keep the stored order so the switcher never reshuffles between unlocks.
  const order = new Map(vault.accounts.map((a, i) => [a.id, i]));
  accounts.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const activeId = accounts.some((a) => a.id === vault.activeId) ? vault.activeId! : accounts[0].id;
  opts?.progress?.(1);
  return { set: { accounts, activeId, mnemonic }, failed };
}

/**
 * Check a password against the vault without unlocking it — one scrypt run
 * against whichever keystore is cheapest to reach. Used before writing a new
 * account into a remembered vault: encrypting under the wrong password would
 * silently make the whole set un-unlockable.
 */
export async function verifyVaultPassword(vault: Vault, password: string, opts?: CryptoOpts): Promise<boolean> {
  const target = vault.seed ?? vault.accounts.find((a) => a.kind === 'imported')?.keystore ?? null;
  if (!target) return true; // nothing encrypted yet — any password is the new one
  try {
    await decryptKeyMaterial(target, password, opts?.progress);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Public-metadata edits (no password, no re-encryption)               */
/* ------------------------------------------------------------------ */

export function vaultWithLabel(vault: Vault, id: string, label: string): Vault {
  return { ...vault, accounts: vault.accounts.map((a) => (a.id === id ? { ...a, label } : a)) };
}

export function vaultWithActive(vault: Vault, id: string): Vault {
  return vault.accounts.some((a) => a.id === id) ? { ...vault, activeId: id } : vault;
}

export function vaultWithExported(vault: Vault, id: string): Vault {
  return {
    ...vault,
    accounts: vault.accounts.map((a) => (a.id === id && a.kind === 'imported' ? { ...a, exported: true } : a)),
  };
}

export function vaultWithoutAccount(vault: Vault, id: string): Vault {
  const accounts = vault.accounts.filter((a) => a.id !== id);
  const activeId = accounts.some((a) => a.id === vault.activeId) ? vault.activeId : (accounts[0]?.id ?? null);
  return { ...vault, accounts, activeId };
}

/** Append an HD row. Costs no cryptography — the index is all that is stored. */
export function vaultWithHdAccount(vault: Vault, account: SessionAccount): Vault {
  if (account.kind !== 'hd' || account.index === null) return vault;
  return {
    ...vault,
    accounts: [
      ...vault.accounts,
      { id: account.id, kind: 'hd', index: account.index, address: account.address, label: account.label },
    ],
  };
}

/** Append an already-encrypted imported row. */
export function vaultWithImportedAccount(
  vault: Vault,
  account: SessionAccount,
  keystore: string,
  origin: AccountOrigin,
): Vault {
  return {
    ...vault,
    accounts: [
      ...vault.accounts,
      {
        id: account.id,
        kind: 'imported',
        address: account.address,
        label: account.label,
        keystore,
        origin: origin === 'keystore' ? 'keystore' : 'privateKey',
        exported: account.backup === 'file',
      },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* The security claim, as an assertion                                 */
/* ------------------------------------------------------------------ */

export interface SecretsToScan {
  privateKeys?: string[];
  mnemonics?: string[];
  passwords?: string[];
}

/**
 * Scan a serialized vault for anything that must never be written to disk.
 * Returns the list of secrets that leaked (empty = clean). Private keys are
 * checked with and without the 0x prefix and in both hex cases; mnemonics are
 * checked whole and word by word.
 */
export function findPlaintextSecrets(serialized: string, secrets: SecretsToScan): string[] {
  const hay = serialized.toLowerCase();
  // Per-word scanning runs against the blob with JSON *keys* removed, so a
  // structural name that happens to be a BIP-39 word ("salt" in kdfparams) is
  // not reported as a leaked mnemonic word. Values are left untouched.
  const values = hay.replace(/\\?"[a-z0-9_$-]+\\?"\s*:/g, ':');
  const leaks: string[] = [];
  for (const key of secrets.privateKeys ?? []) {
    const bare = key.replace(/^0x/i, '').toLowerCase();
    if (bare.length >= 8 && hay.includes(bare)) leaks.push(`private key ${key.slice(0, 10)}…`);
  }
  for (const phrase of secrets.mnemonics ?? []) {
    const words = phrase.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length > 0 && hay.includes(words.join(' '))) leaks.push('mnemonic phrase');
    for (const word of new Set(words)) {
      // Word-boundary match: hex/base64 ciphertext must not be read as a word.
      if (new RegExp(`\\b${word}\\b`).test(values)) leaks.push(`mnemonic word "${word}"`);
    }
  }
  for (const password of secrets.passwords ?? []) {
    if (password.length >= 4 && hay.includes(password.toLowerCase())) leaks.push('password');
  }
  return [...new Set(leaks)];
}
