// Session signer import — private key or encrypted JSON keystore (the format
// wallet-web exports). Keys live in memory only, never in storage.
// No browser globals: the e2e suite uses these under Node.

import { Wallet, decryptKeystoreJson, isKeystoreJson, type Provider, type Signer } from 'ethers';

export interface SessionKey {
  address: string;
  privateKey: string;
}

export function looksLikeKeystore(text: string): boolean {
  try {
    return isKeystoreJson(text);
  } catch {
    return false;
  }
}

export function walletFromPrivateKey(privateKey: string): SessionKey {
  const key = privateKey.trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('A private key is 64 hex characters (with or without 0x).');
  }
  const w = new Wallet(key.startsWith('0x') ? key : `0x${key}`);
  return { address: w.address, privateKey: w.privateKey };
}

export async function walletFromKeystore(
  json: string,
  password: string,
  onProgress?: (fraction: number) => void,
): Promise<SessionKey> {
  const account = await decryptKeystoreJson(json, password, onProgress);
  const w = new Wallet(account.privateKey);
  return { address: w.address, privateKey: w.privateKey };
}

/** A connected ethers Signer for a session key. */
export function sessionSigner(key: SessionKey, provider: Provider): Signer {
  return new Wallet(key.privateKey, provider);
}
