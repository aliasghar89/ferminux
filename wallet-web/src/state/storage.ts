// localStorage persistence. Only two categories are EVER stored, both harmless
// without the user's password / already public:
//   1. the multi-account VAULT — scrypt-ENCRYPTED keystores (one for the HD
//      seed, one per imported account) plus public metadata (addresses,
//      labels, HD indices). Written only with the "remember on this device"
//      opt-in.
//   2. the list of added token contract addresses (public data)
// Plaintext keys, mnemonics and passwords are NEVER written anywhere.
//
// Nothing address-shaped is written when "remember" is off — locking or
// closing the tab then leaves no trace of which accounts were open.

import {
  VAULT_KEY,
  LEGACY_KEYSTORE_KEY,
  parseVault,
  serializeVault,
  migrateLegacyKeystore,
  type Vault,
} from '../lib/vault.ts';

const TOKENS_KEY = 'ferminux.wallet.tokens.v1';

function safeGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    // Storage full / blocked — remembering is best-effort, never fatal.
    return false;
  }
}

function safeRemove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/**
 * Read the stored vault, upgrading a v1 single-account install on the way.
 *
 * The migration re-uses the old keystore bytes verbatim — the user's existing
 * password keeps working and nothing is re-encrypted (we have no password at
 * load time). The v1 key is only removed once the v2 blob has been written AND
 * read back intact, so a failed write can never lose the wallet.
 */
export function loadVault(): Vault | null {
  const raw = safeGet(VAULT_KEY);
  if (raw) {
    const parsed = parseVault(raw);
    if (parsed) return parsed;
  }

  const legacy = safeGet(LEGACY_KEYSTORE_KEY);
  if (!legacy) return null;
  const migrated = migrateLegacyKeystore(legacy);
  if (!migrated) return null;

  if (safeSet(VAULT_KEY, serializeVault(migrated))) {
    const verify = safeGet(VAULT_KEY);
    if (verify && parseVault(verify)) safeRemove(LEGACY_KEYSTORE_KEY);
  }
  return migrated;
}

/** True when this device has something to unlock (used before any decryption). */
export function hasStoredVault(): boolean {
  return loadVault() !== null;
}

export function saveVault(vault: Vault): void {
  safeSet(VAULT_KEY, serializeVault(vault));
}

/** "Forget this device" — removes both the current and the legacy blob. */
export function clearVault(): void {
  safeRemove(VAULT_KEY);
  safeRemove(LEGACY_KEYSTORE_KEY);
}

export function loadTokenAddresses(): string[] {
  const raw = safeGet(TOKENS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function saveTokenAddresses(addresses: string[]): void {
  safeSet(TOKENS_KEY, JSON.stringify(addresses));
}
