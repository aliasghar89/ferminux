// localStorage persistence. Only these categories are EVER stored, all harmless
// without the user's password / already public:
//   1. the multi-account VAULT — scrypt-ENCRYPTED keystores (one for the HD
//      seed, one per imported account) plus public metadata (addresses,
//      labels, HD indices). Written only with the "remember on this device"
//      opt-in.
//   2. the tokens the user added (chain id, contract address, the metadata the
//      contract reports) — public data
//   3. the log of transactions this wallet sent on chains other than Ferminux
//      (hashes, addresses, amounts) — public on-chain data, but it names the
//      wallet's own address, so it is written only while the vault is
//      remembered and removed with it
//   4. view preferences (hide zero balances, chain filter)
// WalletConnect keeps its own store (IndexedDB): session metadata and the
// per-session relay encryption keys. It never sees a wallet key.
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
import {
  CUSTOM_TOKENS_KEY,
  LEGACY_TOKENS_KEY,
  parseCustomTokens,
  serializeCustomTokens,
} from '../lib/customTokens.ts';
import type { CustomToken } from '../lib/portfolio.ts';
import {
  LOCAL_ACTIVITY_KEY,
  parseLocalActivity,
  serializeLocalActivity,
  type LocalTx,
} from '../lib/localActivity.ts';

import { vaultMirror } from '../platform/index.ts';

const TOKENS_KEY = LEGACY_TOKENS_KEY;

function safeGet(key: string): string | null {
  // In the app the encrypted vault lives in the Keystore/Keychain store (platform/index.ts), not WebView storage.
  if (vaultMirror.handles(key)) return vaultMirror.get(key);
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): boolean {
  if (vaultMirror.handles(key)) return vaultMirror.set(key, value);
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    // Storage full / blocked — remembering is best-effort, never fatal.
    return false;
  }
}

function safeRemove(key: string): void {
  if (vaultMirror.handles(key)) {
    vaultMirror.remove(key);
    return;
  }
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

/**
 * "Forget this device" — removes both the current and the legacy blob, and the
 * sent-transaction log, which names the accounts too.
 */
export function clearVault(): void {
  safeRemove(VAULT_KEY);
  safeRemove(LEGACY_KEYSTORE_KEY);
  safeRemove(LOCAL_ACTIVITY_KEY);
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

/* ---- multi-chain additions: all public data (addresses, metadata, tx hashes) ---- */

export function loadCustomTokens(): CustomToken[] {
  return parseCustomTokens(safeGet(CUSTOM_TOKENS_KEY));
}

export function saveCustomTokens(tokens: CustomToken[]): void {
  safeSet(CUSTOM_TOKENS_KEY, serializeCustomTokens(tokens));
}

/** The pre-multi-chain token list (bare Ferminux addresses), read for migration. */
export function loadLegacyTokenList(): string | null {
  return safeGet(LEGACY_TOKENS_KEY);
}

export function loadLocalActivity(): LocalTx[] {
  return parseLocalActivity(safeGet(LOCAL_ACTIVITY_KEY));
}

export function saveLocalActivity(list: LocalTx[]): void {
  safeSet(LOCAL_ACTIVITY_KEY, serializeLocalActivity(list));
}

const PREFS_KEY = 'ferminux.wallet.prefs.v1';

/** Per-viewer display preferences. Losing them only resets the view. */
export interface ViewPrefs {
  hideZero: boolean;
  chainFilter: number | null;
}

export function loadViewPrefs(): ViewPrefs {
  const fallback: ViewPrefs = { hideZero: true, chainFilter: null };
  const raw = safeGet(PREFS_KEY);
  if (!raw) return fallback;
  try {
    const p = JSON.parse(raw) as Partial<ViewPrefs>;
    return {
      hideZero: typeof p.hideZero === 'boolean' ? p.hideZero : fallback.hideZero,
      chainFilter: typeof p.chainFilter === 'number' ? p.chainFilter : null,
    };
  } catch {
    return fallback;
  }
}

export function saveViewPrefs(prefs: ViewPrefs): void {
  safeSet(PREFS_KEY, JSON.stringify(prefs));
}

/** Set once WalletConnect has been used here, so a later unlock reconnects saved sessions. */
const WC_USED_KEY = 'ferminux.wallet.wc.used.v1';

export function wcWasUsed(): boolean {
  return safeGet(WC_USED_KEY) === '1';
}

export function markWcUsed(used: boolean): void {
  if (used) safeSet(WC_USED_KEY, '1');
  else safeRemove(WC_USED_KEY);
}
