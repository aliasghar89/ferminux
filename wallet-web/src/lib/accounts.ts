// Multi-account model: BIP-44 derivation, account records, label handling.
// No browser globals — runs under Node for the unit/e2e suites.
//
// Two kinds of account live side by side in one session:
//   'hd'       — derived from the session mnemonic at m/44'/60'/0'/0/N.
//                Nothing but the integer N has to be stored: the same phrase
//                always regenerates the same address.
//   'imported' — a standalone key (raw private key or keystore file) that has
//                no relationship to the phrase and must be stored as its own
//                encrypted keystore.

import { HDNodeWallet, Mnemonic, getAddress } from 'ethers';
import { normalizePhrase } from './wallet.ts';

/** BIP-44 account branch for Ferminux (same coin type as Ethereum). */
export const HD_BRANCH = "m/44'/60'/0'/0";

/** Full derivation path for HD account `index`. */
export function hdPath(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > 0x7fffffff) {
    throw new Error('HD account index must be a non-negative integer below 2^31.');
  }
  return `${HD_BRANCH}/${index}`;
}

export type AccountKind = 'hd' | 'imported';

/** Where the key came from — drives the backup warning on removal. */
export type AccountOrigin = 'hd' | 'privateKey' | 'keystore';

/**
 * Whether a copy of this key exists outside the browser.
 *   'seed' — recoverable from the recovery phrase (any HD account)
 *   'file' — the user downloaded a keystore for it (imported or exported here)
 *   'none' — this browser holds the only copy
 */
export type BackupState = 'seed' | 'file' | 'none';

/** An unlocked account. `privateKey` exists in page memory only. */
export interface SessionAccount {
  id: string;
  kind: AccountKind;
  /** HD index, or null for imported accounts. */
  index: number | null;
  address: string;
  label: string;
  privateKey: string;
  origin: AccountOrigin;
  backup: BackupState;
}

export interface DerivedAccount {
  index: number;
  path: string;
  address: string;
  privateKey: string;
}

/** Derive the HD branch node once so N children cost one PBKDF2, not N. */
export function hdBranchNode(phrase: string): HDNodeWallet {
  return HDNodeWallet.fromPhrase(normalizePhrase(phrase), undefined, HD_BRANCH);
}

/** Derive one HD account. `deriveHdAccount(p, 0)` equals walletFromMnemonic(p). */
export function deriveHdAccount(phrase: string, index: number): DerivedAccount {
  return childOf(hdBranchNode(phrase), index);
}

/** Derive many HD accounts from a single branch node (one seed computation). */
export function deriveHdAccounts(phrase: string, indices: number[]): DerivedAccount[] {
  if (indices.length === 0) return [];
  const branch = hdBranchNode(phrase);
  return indices.map((i) => childOf(branch, i));
}

function childOf(branch: HDNodeWallet, index: number): DerivedAccount {
  const path = hdPath(index); // validates the index
  const child = branch.deriveChild(index);
  return { index, path, address: getAddress(child.address), privateKey: child.privateKey };
}

/**
 * The index "Add account" should use: the smallest non-negative integer not
 * already in use. Deterministic, and gap-filling so removing account 2 and
 * adding again gives account 2 back rather than drifting upward forever.
 */
export function nextHdIndex(used: Iterable<number>): number {
  const taken = new Set<number>();
  for (const n of used) if (Number.isInteger(n) && n >= 0) taken.add(n);
  let i = 0;
  while (taken.has(i)) i += 1;
  return i;
}

/** Human default for an HD account: index 0 → "Account 1". */
export function defaultHdLabel(index: number): string {
  return `Account ${index + 1}`;
}

/** Human default for an imported account, disambiguated by address. */
export function defaultImportedLabel(address: string): string {
  return `Imported ${address.slice(2, 6).toLowerCase()}`;
}

export const MAX_LABEL_LENGTH = 40;

/**
 * Clean a user-supplied label: strip control characters, collapse runs of
 * whitespace, trim, cap the length. An empty result falls back so an account
 * is never nameless. Labels are display data, never a secret.
 */
export function normalizeLabel(raw: string, fallback: string): string {
  const cleaned = (raw ?? '')
    // C0/C1 controls plus zero-width / bidi marks — a label is plain text.
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned === '') return fallback;
  return cleaned.length > MAX_LABEL_LENGTH ? cleaned.slice(0, MAX_LABEL_LENGTH).trimEnd() : cleaned;
}

/**
 * Make `label` unique among `existing` by appending a counter. Duplicate
 * labels are not an error — but two identical rows in the switcher are a way
 * to send to the wrong account, so we disambiguate.
 */
export function uniqueLabel(label: string, existing: Iterable<string>): string {
  const taken = new Set<string>();
  for (const l of existing) taken.add(l.toLowerCase());
  if (!taken.has(label.toLowerCase())) return label;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${label} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return label;
}

/** Case-insensitive address lookup across a session set. */
export function findByAddress<T extends { address: string }>(accounts: T[], address: string): T | undefined {
  const want = address.trim().toLowerCase();
  return accounts.find((a) => a.address.toLowerCase() === want);
}

/** Recover the phrase from stored BIP-39 entropy. */
export function phraseFromEntropy(entropy: string): string {
  return Mnemonic.fromEntropy(entropy).phrase;
}
