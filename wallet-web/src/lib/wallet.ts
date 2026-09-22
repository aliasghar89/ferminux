// Key creation / import / keystore encryption.
// No browser globals — runs under Node for the e2e suite.
// Keys produced here live only in page memory; the only persisted form is the
// scrypt-encrypted keystore JSON (and only when the user opts in).

import {
  HDNodeWallet,
  Mnemonic,
  Wallet,
  randomBytes,
  encryptKeystoreJson,
  decryptKeystoreJson,
  isKeystoreJson,
  getAddress,
} from 'ethers';

/** Canonical Ferminux derivation path (account 0). */
export const DERIVATION_PATH = "m/44'/60'/0'/0/0";

export type AnyWallet = Wallet | HDNodeWallet;

/** Generate a fresh 12-word mnemonic (128 bits of entropy). */
export function generateMnemonic(): Mnemonic {
  return Mnemonic.fromEntropy(randomBytes(16));
}

export function isValidMnemonic(phrase: string): boolean {
  return Mnemonic.isValidMnemonic(normalizePhrase(phrase));
}

export function normalizePhrase(phrase: string): string {
  return phrase.trim().toLowerCase().split(/\s+/).join(' ');
}

/** Derive account 0 (m/44'/60'/0'/0/0) from a mnemonic phrase. */
export function walletFromMnemonic(phrase: string): HDNodeWallet {
  return HDNodeWallet.fromPhrase(normalizePhrase(phrase), undefined, DERIVATION_PATH);
}

/** Import from a raw private key (with or without 0x prefix). */
export function walletFromPrivateKey(key: string): Wallet {
  let k = key.trim();
  if (!k.startsWith('0x')) k = '0x' + k;
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) {
    throw new Error('A private key is 64 hex characters (optionally 0x-prefixed).');
  }
  return new Wallet(k);
}

export function looksLikeKeystore(json: string): boolean {
  try {
    return isKeystoreJson(json);
  } catch {
    return false;
  }
}

/** Address stored inside a keystore file, checksummed — readable without the password. */
export function keystoreAddress(json: string): string | null {
  try {
    const parsed = JSON.parse(json) as { address?: string };
    if (typeof parsed.address !== 'string') return null;
    const raw = parsed.address.startsWith('0x') ? parsed.address : '0x' + parsed.address;
    return getAddress(raw.toLowerCase());
  } catch {
    return null;
  }
}

/**
 * Encrypt to a V3 keystore JSON with ethers' scrypt KDF.
 * `scryptN` is only lowered in tests; production uses the ethers default (2^17).
 */
export async function encryptToKeystore(
  wallet: AnyWallet,
  password: string,
  opts?: { progress?: (fraction: number) => void; scryptN?: number },
): Promise<string> {
  const account = { address: wallet.address, privateKey: wallet.privateKey };
  return encryptKeystoreJson(account, password, {
    progressCallback: opts?.progress,
    ...(opts?.scryptN ? { scrypt: { N: opts.scryptN } } : {}),
  });
}

/** Decrypt a keystore JSON. Throws on a wrong password or malformed file. */
export async function decryptFromKeystore(
  json: string,
  password: string,
  progress?: (fraction: number) => void,
): Promise<Wallet> {
  const account = await decryptKeystoreJson(json, password, progress);
  return new Wallet(account.privateKey);
}

/* ------------------------------------------------------------------ */
/* Seed keystores (multi-account)                                      */
/* ------------------------------------------------------------------ */

/**
 * Key material recovered from a keystore. `mnemonicPhrase` is present only for
 * a keystore that carries the BIP-39 entropy (the x-ethers extension) — that
 * is what lets a restored session keep deriving new HD accounts.
 */
export interface KeyMaterial {
  address: string;
  privateKey: string;
  mnemonicPhrase: string | null;
}

/**
 * True when this keystore carries an encrypted mnemonic. Readable without the
 * password (only the presence of the field, never its contents) — the vault
 * migration uses it to tell an HD seed from a bare imported key.
 */
export function keystoreHasMnemonic(json: string): boolean {
  try {
    const parsed = JSON.parse(json) as { 'x-ethers'?: { mnemonicCiphertext?: unknown } };
    return typeof parsed['x-ethers']?.mnemonicCiphertext === 'string';
  } catch {
    return false;
  }
}

/**
 * Encrypt the HD *seed*: account 0's key plus the BIP-39 entropy, both under
 * the same scrypt-derived key (ethers encrypts the entropy with a separate AES
 * key sliced from the same KDF output — it is never written in the clear).
 */
export async function encryptSeedKeystore(
  phrase: string,
  password: string,
  opts?: { progress?: (fraction: number) => void; scryptN?: number },
): Promise<string> {
  const mnemonic = Mnemonic.fromPhrase(normalizePhrase(phrase));
  const wallet = HDNodeWallet.fromMnemonic(mnemonic, DERIVATION_PATH);
  return encryptKeystoreJson(
    {
      address: wallet.address,
      privateKey: wallet.privateKey,
      mnemonic: { entropy: mnemonic.entropy, path: DERIVATION_PATH, locale: 'en' },
    },
    password,
    {
      progressCallback: opts?.progress,
      ...(opts?.scryptN ? { scrypt: { N: opts.scryptN } } : {}),
    },
  );
}

/** Encrypt a bare private key (no mnemonic) to a standard V3 keystore. */
export async function encryptKeyKeystore(
  address: string,
  privateKey: string,
  password: string,
  opts?: { progress?: (fraction: number) => void; scryptN?: number },
): Promise<string> {
  return encryptKeystoreJson({ address: getAddress(address), privateKey }, password, {
    progressCallback: opts?.progress,
    ...(opts?.scryptN ? { scrypt: { N: opts.scryptN } } : {}),
  });
}

/**
 * Decrypt a keystore and keep whatever it carried — including the mnemonic,
 * which `decryptFromKeystore` drops when it narrows to a plain Wallet.
 */
export async function decryptKeyMaterial(
  json: string,
  password: string,
  progress?: (fraction: number) => void,
): Promise<KeyMaterial> {
  const account = await decryptKeystoreJson(json, password, progress);
  let mnemonicPhrase: string | null = null;
  if (account.mnemonic?.entropy) {
    try {
      mnemonicPhrase = Mnemonic.fromEntropy(account.mnemonic.entropy).phrase;
    } catch {
      mnemonicPhrase = null; // corrupt entropy must not block the private key
    }
  }
  return { address: getAddress(account.address), privateKey: account.privateKey, mnemonicPhrase };
}
