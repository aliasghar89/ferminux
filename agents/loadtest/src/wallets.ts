// The load-test wallets: one dedicated BIP-39 seed, BIP-32/44 path m/44'/60'/7'/0/i.
//   i = 0          the float: funded by the owner (or Wizrd), funds every other wallet, receives every sweep
//   i = 1 … N − 1  the load-test wallets, activated in waves
//
// The seed is generated here on first start (32 bytes of OS entropy → 24 words) into a 0600 file on the
// service's private volume, and is never logged, printed, published or sent anywhere. What IS published
// is the account-level extended PUBLIC key (xpub of m/44'/60'/7'/0): with it anyone can derive every
// load-test address and check that a wallet belongs to the test, and nobody can spend from any of them.
// (Standard BIP-32 caveat: an xpub plus ONE leaked child private key reveals the whole branch. Child keys
// exist only inside this process, like the seed itself; Wizrd's own key is not on this branch.)
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, openSync, fsyncSync, closeSync } from "node:fs";
import { dirname } from "node:path";
import { HDNodeWallet, Mnemonic, randomBytes } from "ethers";

export const DERIVATION_BASE = "m/44'/60'/7'/0";
export const derivationPath = (i: number) => `${DERIVATION_BASE}/${i}`;

/** Read the seed file, or create it (0600, directory 0700) when absent. Never returns the phrase to a logger. */
export function loadOrCreateSeed(file: string): { phrase: string; created: boolean } {
  if (existsSync(file)) {
    const mode = statSync(file).mode & 0o777;
    if (mode !== 0o600) chmodSync(file, 0o600);
    const phrase = readFileSync(file, "utf8").trim().split(/\s+/).join(" ");
    if (!Mnemonic.isValidMnemonic(phrase)) throw new Error(`seed file ${file} does not hold a valid BIP-39 phrase`);
    return { phrase, created: false };
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const phrase = Mnemonic.fromEntropy(randomBytes(32)).phrase;
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, phrase + "\n", { mode: 0o600, flag: "wx" });
  const fd = openSync(tmp, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
  chmodSync(file, 0o600);
  return { phrase, created: true };
}

/** Addresses and keys of the branch. Addresses are cached; signing wallets are derived on demand. */
export class Keyring {
  readonly xpub: string;
  private readonly base: HDNodeWallet;
  private readonly addrs: string[] = [];

  constructor(phrase: string) {
    this.base = HDNodeWallet.fromPhrase(phrase, undefined, DERIVATION_BASE);
    this.xpub = this.base.neuter().extendedKey;
  }

  /** Checksummed address of wallet i. */
  address(i: number): string {
    if (!Number.isInteger(i) || i < 0 || i >= 2 ** 31) throw new Error(`bad wallet index ${i}`);
    let a = this.addrs[i];
    if (a === undefined) {
      a = this.base.deriveChild(i).address;
      this.addrs[i] = a;
    }
    return a;
  }

  /** The signing wallet of index i. Keep it only as long as it is needed. */
  wallet(i: number): HDNodeWallet {
    if (!Number.isInteger(i) || i < 0 || i >= 2 ** 31) throw new Error(`bad wallet index ${i}`);
    return this.base.deriveChild(i);
  }

  /** Addresses of [from, to) (derives what is not cached yet). */
  range(from: number, to: number): string[] {
    const out: string[] = [];
    for (let i = from; i < to; i++) out.push(this.address(i));
    return out;
  }
}

/** Addresses derived from a published xpub alone (what the gateway and a verifier do). */
export function addressFromXpub(xpub: string, i: number): string {
  return HDNodeWallet.fromExtendedKey(xpub).deriveChild(i).address;
}
