// Key loading.
//
// The signing key is the bridge. Everything else in this service is replaceable;
// a leaked validator key is a 2-of-3 away from a drained bridge, and a leaked
// submitter key is only gas, which is why they are different keys on different
// machines.
//
// Rules enforced here, not by convention:
//   * the default and only supported production path is an encrypted V3 keystore
//     plus a password read from a file (mode 0400, outside the repo)
//   * FMX_RELAYER_PRIVATE_KEY exists for local anvil tests and refuses to load
//     unless FMX_RELAYER_ALLOW_PLAINTEXT_KEY=1 is also set — you cannot reach for
//     it by accident
//   * FMX_RELAYER_PASSWORD does NOT exist. There is no flag, no acknowledgement
//     sentence and no "I know what I'm doing" escape hatch, because there is no
//     configuration in which an environment variable is as safe as a 0400 file:
//     it is readable via /proc/<pid>/environ by anything running as this user,
//     it lands in core dumps and crash reports, `ps e` prints it, and every
//     child process inherits it. An opt-in flag only moved the decision to
//     whoever wrote the unit file. Setting the variable at all is a REFUSAL to
//     start — the same for --role check and --role keygen — because by then the
//     secret is already in the process environment and the only correct advice
//     is "unset it and rotate the password"
//   * if keystore.expectedAddress is configured, the decrypted key must match it,
//     so a swapped keystore file is a startup failure and not a silent identity change
//   * the password is zeroed from the local string reference as soon as it is used
//     (best effort in a GC'd runtime; the real control is file permissions)
//   * nothing here ever puts a password in a log line, an error message or an
//     alert field — see logger.ts REDACT_KEYS, and the test that proves it

import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { getAddress, HDNodeWallet, Wallet } from 'ethers';
import type { Logger } from './logger.ts';

/** Mirrors RelayerConfig['keystore'] so the config object can be passed straight in. */
export interface KeyOptions {
  path: string | null;
  passwordFile: string | null;
  expectedAddress: string | null;
}

export interface LoadedKey {
  wallet: Wallet | HDNodeWallet;
  address: string;
  source: 'keystore' | 'env-plaintext';
}

/**
 * Read a keystore password out of a file, enforcing the same permission rule
 * everywhere it is used — the loader AND `--role keygen`, which used to skip it
 * and so could create a key whose password file was world-readable.
 */
export function readPasswordFile(passwordFile: string): string {
  if (!existsSync(passwordFile)) throw new Error(`password file not found: ${passwordFile}`);
  const mode = statSync(passwordFile).mode & 0o777;
  if (mode & 0o077) {
    throw new Error(
      `password file ${passwordFile} is mode ${mode.toString(8)} — it must not be readable by group or other. ` +
        `Run: chmod 400 ${passwordFile}`,
    );
  }
  return readFileSync(passwordFile, 'utf8').replace(/\r?\n$/, '');
}

/** The variables that used to carry a password, or permission to carry one. */
const BANNED_PASSWORD_VARS = ['FMX_RELAYER_PASSWORD', 'FMX_RELAYER_ALLOW_ENV_PASSWORD'] as const;

/**
 * Refuse to run at all if a keystore password — or the old permission to pass
 * one — is in the environment.
 *
 * This is a startup gate, not a read-time check, and it is deliberately not
 * conditional on which key path is in use. By the time this process is running,
 * a password in `process.env` has already been through the shell, the unit
 * file, `/proc/<pid>/environ` and every child this process will ever spawn.
 * Reading it from somewhere else instead does not un-leak it, so the only
 * honest response is to stop and make a human unset it and rotate.
 *
 * Called from loadKey() AND from the very top of main(), so `--role check` and
 * `--role keygen` — neither of which necessarily touches a keystore — refuse on
 * the same rule.
 */
export function assertNoEnvPassword(env: NodeJS.ProcessEnv = process.env): void {
  const present = BANNED_PASSWORD_VARS.filter((name) => env[name] !== undefined);
  if (present.length === 0) return;
  throw new Error(
    `${present.join(' and ')} ${present.length > 1 ? 'are' : 'is'} set in the environment. The keystore password may ` +
      'ONLY come from a file: an environment variable cannot be mode 0400, it is readable through /proc/<pid>/environ ' +
      'by anything running as this user, it is captured in core dumps and crash reports, `ps e` prints it, and every ' +
      'child process inherits it. There is no override flag — FMX_RELAYER_ALLOW_ENV_PASSWORD was removed for the same ' +
      `reason. Unset ${present.join(' and ')}, treat that password as disclosed and rotate it, then point ` +
      'keystore.passwordFile (FMX_RELAYER_PASSWORD_FILE) at a chmod 400 file outside the repo — systemd LoadCredential ' +
      'and Docker secrets both give you one.',
  );
}

/**
 * Resolve the keystore password. A 0400 file is the only source: see
 * assertNoEnvPassword() for why there is no environment path to fall back to.
 */
export function readPassword(passwordFile: string | null): string {
  assertNoEnvPassword();
  if (!passwordFile) {
    throw new Error(
      'no keystore password configured: set keystore.passwordFile (or FMX_RELAYER_PASSWORD_FILE) to a chmod 400 file outside the repo',
    );
  }
  return readPasswordFile(passwordFile);
}

/**
 * Load the signing key. Async because scrypt keystore decryption is deliberately
 * slow — that slowness is the point, do not swap it for something faster.
 */
export async function loadKey(opts: KeyOptions, log: Logger): Promise<LoadedKey> {
  // Before ANY key path, including the plaintext devnet one: a password in the
  // environment is a disclosed password whether or not this run would have read it.
  assertNoEnvPassword();
  const plaintext = process.env.FMX_RELAYER_PRIVATE_KEY;
  if (plaintext) {
    if (process.env.FMX_RELAYER_ALLOW_PLAINTEXT_KEY !== '1') {
      throw new Error(
        'FMX_RELAYER_PRIVATE_KEY is set but FMX_RELAYER_ALLOW_PLAINTEXT_KEY=1 is not. ' +
          'Plaintext keys are for local anvil testing only — use an encrypted keystore in production.',
      );
    }
    const wallet = new Wallet(plaintext.startsWith('0x') ? plaintext : `0x${plaintext}`);
    log.warn('using a PLAINTEXT key from the environment — never do this outside a local devnet', {
      address: wallet.address,
    });
    assertExpected(wallet.address, opts.expectedAddress);
    return { wallet, address: getAddress(wallet.address), source: 'env-plaintext' };
  }

  if (!opts.path) {
    throw new Error('no signing key configured: set keystore.path (or FMX_RELAYER_KEYSTORE)');
  }
  if (!existsSync(opts.path)) throw new Error(`keystore not found: ${opts.path}`);
  const mode = statSync(opts.path).mode & 0o777;
  if (mode & 0o077) {
    throw new Error(
      `keystore ${opts.path} is mode ${mode.toString(8)} — it must not be readable by group or other. ` +
        `Run: chmod 400 ${opts.path}`,
    );
  }

  const json = readFileSync(opts.path, 'utf8');
  let password = readPassword(opts.passwordFile);
  let wallet: Wallet | HDNodeWallet;
  try {
    wallet = await Wallet.fromEncryptedJson(json, password);
  } catch (err) {
    throw new Error(`keystore decryption failed (wrong password?): ${(err as Error).message}`);
  } finally {
    password = '';
  }
  assertExpected(wallet.address, opts.expectedAddress);
  log.info('signing key loaded from keystore', { address: wallet.address, keystore: opts.path });
  return { wallet, address: getAddress(wallet.address), source: 'keystore' };
}

function assertExpected(actual: string, expected: string | null): void {
  if (!expected) return;
  if (getAddress(actual) !== getAddress(expected)) {
    throw new Error(
      `key address ${getAddress(actual)} does not match keystore.expectedAddress ${getAddress(expected)} — ` +
        'refusing to start with an unexpected identity',
    );
  }
}

/**
 * Generate a fresh key and write it as an encrypted V3 keystore, mode 0400.
 * Used by `--role keygen`. The private key never touches stdout or a log line.
 */
export async function createKeystore(outPath: string, password: string): Promise<{ address: string; path: string }> {
  if (password.length < 12) throw new Error('keystore password must be at least 12 characters');
  if (existsSync(outPath)) throw new Error(`refusing to overwrite existing keystore ${outPath}`);
  const wallet = Wallet.createRandom();
  const json = await wallet.encrypt(password);
  writeFileSync(outPath, json, { mode: 0o400 });
  chmodSync(outPath, 0o400);
  return { address: getAddress(wallet.address), path: outPath };
}
