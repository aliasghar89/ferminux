// The multi-account storage layer: what "remember on this device" writes,
// what it refuses to write, and how a v1 single-account install upgrades.
//
// scryptN is lowered to 2^12 throughout — production uses the ethers default
// (2^17). The format under test is identical; only the KDF cost differs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VAULT_VERSION,
  VAULT_KEY,
  LEGACY_KEYSTORE_KEY,
  serializeVault,
  parseVault,
  migrateLegacyKeystore,
  encryptVault,
  decryptVault,
  verifyVaultPassword,
  vaultWithLabel,
  vaultWithActive,
  vaultWithExported,
  vaultWithoutAccount,
  vaultWithHdAccount,
  vaultWithImportedAccount,
  findPlaintextSecrets,
  newAccountId,
  WrongPasswordError,
} from '../src/lib/vault.ts';
import {
  encryptSeedKeystore,
  encryptKeyKeystore,
  encryptToKeystore,
  keystoreHasMnemonic,
  keystoreAddress,
} from '../src/lib/wallet.ts';
import { deriveHdAccount, defaultHdLabel } from '../src/lib/accounts.ts';
import { Wallet } from 'ethers';

const N = 1 << 12;
const PHRASE = 'test test test test test test test test test test test junk';
const HD0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const HD1 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const HD2 = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
// A standalone key that is NOT on the phrase's tree.
const LOOSE_KEY = '0x' + '11'.repeat(32);
const LOOSE = new Wallet(LOOSE_KEY);
const PASSWORD = 'correct horse battery 3961';

function hdAccount(index, label = defaultHdLabel(index)) {
  const d = deriveHdAccount(PHRASE, index);
  return {
    id: newAccountId(),
    kind: 'hd',
    index,
    address: d.address,
    label,
    privateKey: d.privateKey,
    origin: 'hd',
    backup: 'seed',
  };
}

function importedAccount(label = 'Cold storage', backup = 'none') {
  return {
    id: newAccountId(),
    kind: 'imported',
    index: null,
    address: LOOSE.address,
    label,
    privateKey: LOOSE.privateKey,
    origin: 'privateKey',
    backup,
  };
}

function mixedSet() {
  const accounts = [hdAccount(0), hdAccount(1), importedAccount()];
  return { accounts, activeId: accounts[1].id, mnemonic: PHRASE };
}

/* ---------------- round trip ---------------- */

test('vault: encrypts a mixed set and decrypts it back intact', async () => {
  const set = mixedSet();
  const vault = await encryptVault(set, PASSWORD, { scryptN: N });

  assert.equal(vault.version, VAULT_VERSION);
  assert.ok(vault.seed, 'the phrase is stored once, as an encrypted seed keystore');
  assert.equal(keystoreHasMnemonic(vault.seed), true);
  assert.equal(vault.accounts.length, 3);
  assert.equal(vault.activeId, set.activeId);
  // HD rows carry an index and NO keystore: the phrase regenerates them.
  const hdRows = vault.accounts.filter((a) => a.kind === 'hd');
  assert.equal(hdRows.length, 2);
  for (const row of hdRows) assert.equal('keystore' in row, false);
  assert.deepEqual(hdRows.map((r) => r.index), [0, 1]);
  // Imported rows carry their own standard keystore.
  const importedRows = vault.accounts.filter((a) => a.kind === 'imported');
  assert.equal(importedRows.length, 1);
  assert.equal(keystoreAddress(importedRows[0].keystore), LOOSE.address);

  const { set: restored, failed } = await decryptVault(vault, PASSWORD);
  assert.deepEqual(failed, []);
  assert.equal(restored.mnemonic, PHRASE, 'the phrase comes back so more accounts can be derived');
  assert.equal(restored.activeId, set.activeId);
  assert.deepEqual(restored.accounts.map((a) => a.address), [HD0, HD1, LOOSE.address]);
  assert.deepEqual(restored.accounts.map((a) => a.privateKey), set.accounts.map((a) => a.privateKey));
  assert.deepEqual(restored.accounts.map((a) => a.label), set.accounts.map((a) => a.label));
  assert.deepEqual(restored.accounts.map((a) => a.kind), ['hd', 'hd', 'imported']);
  assert.deepEqual(restored.accounts.map((a) => a.backup), ['seed', 'seed', 'none']);
});

test('vault: survives serialization to a string and back', async () => {
  const set = mixedSet();
  const vault = await encryptVault(set, PASSWORD, { scryptN: N });
  const parsed = parseVault(serializeVault(vault));
  assert.ok(parsed);
  const { set: restored } = await decryptVault(parsed, PASSWORD);
  assert.deepEqual(restored.accounts.map((a) => a.address), [HD0, HD1, LOOSE.address]);
});

test('vault: the same seed always regenerates the same accounts', async () => {
  const first = await encryptVault(mixedSet(), PASSWORD, { scryptN: N });
  const { set: a } = await decryptVault(first, PASSWORD);
  const second = await encryptVault(a, 'a different password entirely', { scryptN: N });
  const { set: b } = await decryptVault(second, 'a different password entirely');
  assert.deepEqual(b.accounts.map((x) => x.address), a.accounts.map((x) => x.address));
  assert.deepEqual(b.accounts.map((x) => x.privateKey), a.accounts.map((x) => x.privateKey));
});

test('vault: an imported-only set stores no seed and still unlocks', async () => {
  const account = importedAccount('Treasury', 'file');
  const vault = await encryptVault({ accounts: [account], activeId: account.id, mnemonic: null }, PASSWORD, {
    scryptN: N,
  });
  assert.equal(vault.seed, null);
  const { set } = await decryptVault(vault, PASSWORD);
  assert.equal(set.mnemonic, null, 'no phrase means HD accounts cannot be added');
  assert.equal(set.accounts[0].backup, 'file');
  assert.equal(set.accounts[0].privateKey, LOOSE.privateKey);
});

test('vault: seedKeystore is reused instead of re-running scrypt', async () => {
  const seed = await encryptSeedKeystore(PHRASE, PASSWORD, { scryptN: N });
  const set = { accounts: [hdAccount(0)], activeId: undefined, mnemonic: PHRASE };
  set.activeId = set.accounts[0].id;
  const vault = await encryptVault(set, PASSWORD, { scryptN: N, seedKeystore: seed });
  assert.equal(vault.seed, seed, 'the supplied keystore is stored verbatim');
  const { set: restored } = await decryptVault(vault, PASSWORD);
  assert.equal(restored.accounts[0].address, HD0);
});

/* ---------------- wrong password ---------------- */

test('vault: a wrong password is rejected, not partially applied', async () => {
  const vault = await encryptVault(mixedSet(), PASSWORD, { scryptN: N });
  await assert.rejects(decryptVault(vault, 'not the password'), WrongPasswordError);
  await assert.rejects(decryptVault(vault, ''), WrongPasswordError);
  await assert.rejects(decryptVault(vault, PASSWORD + ' '), WrongPasswordError);
});

test('vault: an imported-only vault also rejects a wrong password', async () => {
  const account = importedAccount();
  const vault = await encryptVault({ accounts: [account], activeId: account.id, mnemonic: null }, PASSWORD, {
    scryptN: N,
  });
  await assert.rejects(decryptVault(vault, 'wrong'), WrongPasswordError);
});

test('vault: verifyVaultPassword answers without unlocking', async () => {
  const vault = await encryptVault(mixedSet(), PASSWORD, { scryptN: N });
  assert.equal(await verifyVaultPassword(vault, PASSWORD), true);
  assert.equal(await verifyVaultPassword(vault, 'wrong'), false);
});

test('vault: one account encrypted under another password does not lock out the rest', async () => {
  const set = mixedSet();
  const vault = await encryptVault(set, PASSWORD, { scryptN: N });
  // Simulate a row written under a different password.
  const stranger = new Wallet('0x' + '22'.repeat(32));
  vault.accounts.push({
    id: newAccountId(),
    kind: 'imported',
    address: stranger.address,
    label: 'Stranger',
    keystore: await encryptKeyKeystore(stranger.address, stranger.privateKey, 'other password', { scryptN: N }),
    origin: 'privateKey',
    exported: false,
  });

  const { set: restored, failed } = await decryptVault(vault, PASSWORD);
  assert.equal(restored.accounts.length, 3, 'the readable accounts still unlock');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].address, stranger.address);
  assert.match(failed[0].reason, /different password/i);
});

/* ---------------- no plaintext secrets ---------------- */

test('vault: the serialized blob contains no key, phrase or password', async () => {
  const set = mixedSet();
  const vault = await encryptVault(set, PASSWORD, { scryptN: N });
  const blob = serializeVault(vault);

  const leaks = findPlaintextSecrets(blob, {
    privateKeys: set.accounts.map((a) => a.privateKey),
    mnemonics: [PHRASE],
    passwords: [PASSWORD],
  });
  assert.deepEqual(leaks, [], `serialized vault leaked: ${leaks.join(', ')}`);

  // Belt and braces: assert directly against the string as well.
  const lower = blob.toLowerCase();
  for (const account of set.accounts) {
    assert.equal(lower.includes(account.privateKey.slice(2).toLowerCase()), false);
  }
  assert.equal(lower.includes(PHRASE), false);
  assert.equal(lower.includes('junk'), false, 'not even one word of the phrase');
  assert.equal(lower.includes(PASSWORD.toLowerCase()), false);
  // The BIP-39 entropy must not be there either.
  assert.equal(lower.includes('0xdcda0c'), false);

  // What IS there is public: addresses and labels, so the set reappears intact.
  assert.ok(blob.includes(HD0) && blob.includes(HD1) && blob.includes(LOOSE.address));
  assert.ok(blob.includes('Account 1'));
});

test('vault: the leak scanner actually detects a leak (it is not vacuous)', () => {
  const planted = JSON.stringify({ version: 2, note: `key ${LOOSE.privateKey} phrase ${PHRASE}` });
  const leaks = findPlaintextSecrets(planted, { privateKeys: [LOOSE.privateKey], mnemonics: [PHRASE] });
  assert.ok(leaks.some((l) => l.startsWith('private key')), 'must catch a plaintext key');
  assert.ok(leaks.includes('mnemonic phrase'), 'must catch a plaintext phrase');
});

test('vault: a structural key that happens to be a BIP-39 word is not a false positive', async () => {
  // "salt" is both a kdfparams field name and a BIP-39 word.
  const phraseWithSalt = 'salt salt salt salt salt salt salt salt salt salt salt salt';
  const blob = serializeVault({
    version: 2,
    seed: await encryptKeyKeystore(LOOSE.address, LOOSE.privateKey, PASSWORD, { scryptN: N }),
    accounts: [],
    activeId: null,
  });
  assert.ok(blob.includes('salt'), 'the kdfparams field is present');
  assert.deepEqual(findPlaintextSecrets(blob, { mnemonics: [phraseWithSalt] }), []);
});

/* ---------------- parsing ---------------- */

test('vault: parse rejects junk, wrong versions and unusable rows', () => {
  assert.equal(parseVault('not json'), null);
  assert.equal(parseVault('null'), null);
  assert.equal(parseVault('[]'), null);
  assert.equal(parseVault(JSON.stringify({ version: 1, accounts: [] })), null);
  assert.equal(parseVault(JSON.stringify({ version: 2, accounts: [] })), null);
  assert.equal(
    parseVault(JSON.stringify({ version: 2, seed: null, accounts: [{ id: 'a', kind: 'hd', index: 0, address: HD0 }] })),
    null,
    'an HD row with no seed can never be derived',
  );
  assert.equal(
    parseVault(JSON.stringify({ version: 2, seed: null, accounts: [{ id: 'a', kind: 'imported', address: HD0 }] })),
    null,
    'an imported row with no keystore is unusable',
  );
});

test('vault: parse repairs a dangling activeId', async () => {
  const vault = await encryptVault(mixedSet(), PASSWORD, { scryptN: N });
  const broken = { ...vault, activeId: 'nope' };
  const parsed = parseVault(serializeVault(broken));
  assert.equal(parsed.activeId, parsed.accounts[0].id);
});

/* ---------------- public-metadata edits ---------------- */

test('vault: label, active, exported and removal edits need no password', async () => {
  const set = mixedSet();
  let vault = await encryptVault(set, PASSWORD, { scryptN: N });
  const [a0, , a2] = vault.accounts;

  vault = vaultWithLabel(vault, a0.id, 'Treasury');
  vault = vaultWithActive(vault, a0.id);
  vault = vaultWithExported(vault, a2.id);
  const { set: restored } = await decryptVault(vault, PASSWORD);
  assert.equal(restored.accounts[0].label, 'Treasury');
  assert.equal(restored.activeId, a0.id);
  assert.equal(restored.accounts[2].backup, 'file', 'an exported key is marked as backed up');

  vault = vaultWithoutAccount(vault, a0.id);
  assert.equal(vault.accounts.length, 2);
  assert.notEqual(vault.activeId, a0.id, 'removing the active account moves the pointer');
  const after = await decryptVault(vault, PASSWORD);
  assert.deepEqual(after.set.accounts.map((x) => x.address), [HD1, LOOSE.address]);
});

test('vault: adding an HD account writes only an index, and it derives back', async () => {
  const set = mixedSet();
  let vault = await encryptVault(set, PASSWORD, { scryptN: N });
  const added = hdAccount(2, 'Account 3');
  vault = vaultWithHdAccount(vault, added);
  const row = vault.accounts.find((a) => a.id === added.id);
  assert.equal(row.kind, 'hd');
  assert.equal(row.index, 2);
  assert.equal('keystore' in row, false, 'no new ciphertext is written for a derived account');

  const { set: restored } = await decryptVault(vault, PASSWORD);
  assert.equal(restored.accounts[3].address, HD2);
  assert.equal(restored.accounts[3].privateKey, deriveHdAccount(PHRASE, 2).privateKey);
});

test('vault: adding an imported account stores its own keystore', async () => {
  const set = { accounts: [hdAccount(0)], activeId: null, mnemonic: PHRASE };
  set.activeId = set.accounts[0].id;
  let vault = await encryptVault(set, PASSWORD, { scryptN: N });
  const stranger = new Wallet('0x' + '33'.repeat(32));
  const account = {
    id: newAccountId(),
    kind: 'imported',
    index: null,
    address: stranger.address,
    label: 'Hot',
    privateKey: stranger.privateKey,
    origin: 'privateKey',
    backup: 'none',
  };
  const keystore = await encryptKeyKeystore(stranger.address, stranger.privateKey, PASSWORD, { scryptN: N });
  vault = vaultWithImportedAccount(vault, account, keystore, 'privateKey');

  const { set: restored, failed } = await decryptVault(vault, PASSWORD);
  assert.deepEqual(failed, []);
  assert.equal(restored.accounts.length, 2);
  assert.equal(restored.accounts[1].privateKey, stranger.privateKey);
  assert.equal(findPlaintextSecrets(serializeVault(vault), { privateKeys: [stranger.privateKey] }).length, 0);
});

/* ---------------- migration from the single-account format ---------------- */

test('migration: a v1 keystore WITH a mnemonic becomes the seed plus account 1', async () => {
  const legacy = await encryptSeedKeystore(PHRASE, PASSWORD, { scryptN: N });
  const vault = migrateLegacyKeystore(legacy);
  assert.ok(vault);
  assert.equal(vault.version, VAULT_VERSION);
  assert.equal(vault.seed, legacy, 'the encrypted bytes are carried over verbatim');
  assert.equal(vault.accounts.length, 1);
  assert.equal(vault.accounts[0].kind, 'hd');
  assert.equal(vault.accounts[0].index, 0);
  assert.equal(vault.accounts[0].address, HD0);
  assert.equal(vault.accounts[0].label, 'Account 1');
  assert.equal(vault.activeId, vault.accounts[0].id);

  // The old password still works, and the upgraded wallet can now grow.
  const { set } = await decryptVault(vault, PASSWORD);
  assert.equal(set.accounts[0].address, HD0);
  assert.equal(set.mnemonic, PHRASE);
});

test('migration: a v1 keystore WITHOUT a mnemonic becomes a standalone account', async () => {
  const legacy = await encryptToKeystore(LOOSE, PASSWORD, { scryptN: N });
  assert.equal(keystoreHasMnemonic(legacy), false);
  const vault = migrateLegacyKeystore(legacy);
  assert.ok(vault);
  assert.equal(vault.seed, null);
  assert.equal(vault.accounts[0].kind, 'imported');
  assert.equal(vault.accounts[0].keystore, legacy);
  assert.equal(vault.accounts[0].address, LOOSE.address);
  assert.equal(vault.accounts[0].exported, true, 'the user already downloaded this file in v1');

  const { set } = await decryptVault(vault, PASSWORD);
  assert.equal(set.accounts[0].privateKey, LOOSE.privateKey);
  assert.equal(set.mnemonic, null);
});

test('migration: rejects anything that is not a keystore', () => {
  assert.equal(migrateLegacyKeystore(''), null);
  assert.equal(migrateLegacyKeystore('{}'), null);
  assert.equal(migrateLegacyKeystore('not json'), null);
  assert.equal(migrateLegacyKeystore(null), null);
});

/* ---------------- migration through real localStorage ---------------- */

test('migration: a seeded v1 localStorage upgrades on load and then unlocks', async () => {
  const store = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
  };
  const storage = await import('../src/state/storage.ts');

  // Seed exactly what the single-account wallet wrote.
  const legacy = await encryptSeedKeystore(PHRASE, PASSWORD, { scryptN: N });
  store.set(LEGACY_KEYSTORE_KEY, legacy);
  assert.equal(storage.hasStoredVault(), true, 'the old install is recognised as unlockable');

  const vault = storage.loadVault();
  assert.ok(vault, 'the old keystore is upgraded, not ignored');
  assert.equal(vault.accounts.length, 1);
  assert.equal(vault.accounts[0].address, HD0);

  // v2 written, v1 removed only after the new blob read back intact.
  assert.ok(store.has(VAULT_KEY));
  assert.equal(store.has(LEGACY_KEYSTORE_KEY), false);
  assert.ok(parseVault(store.get(VAULT_KEY)));

  // The user's existing password unlocks the migrated account.
  const { set } = await decryptVault(storage.loadVault(), PASSWORD);
  assert.equal(set.accounts[0].address, HD0);
  assert.equal(set.accounts[0].label, 'Account 1');
  assert.equal(set.mnemonic, PHRASE);

  // Second load is a no-op: it reads v2 directly.
  const again = storage.loadVault();
  assert.equal(again.accounts[0].id, vault.accounts[0].id);

  // Growing the migrated wallet persists, and re-unlocks with the same password.
  const grown = vaultWithHdAccount(again, hdAccount(1));
  storage.saveVault(grown);
  const reloaded = storage.loadVault();
  assert.equal(reloaded.accounts.length, 2);
  const { set: bigger } = await decryptVault(reloaded, PASSWORD);
  assert.deepEqual(bigger.accounts.map((a) => a.address), [HD0, HD1]);

  storage.clearVault();
  assert.equal(storage.loadVault(), null);
  assert.equal(store.size, 0);
  delete globalThis.window;
});

test('migration: a broken localStorage write leaves the v1 keystore in place', async () => {
  const store = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: (k) => store.delete(k),
    },
  };
  const storage = await import('../src/state/storage.ts');
  const legacy = await encryptSeedKeystore(PHRASE, PASSWORD, { scryptN: N });
  store.set(LEGACY_KEYSTORE_KEY, legacy);

  const vault = storage.loadVault();
  assert.ok(vault, 'the session still opens from the in-memory upgrade');
  assert.equal(store.get(LEGACY_KEYSTORE_KEY), legacy, 'nothing is deleted when the write failed');
  delete globalThis.window;
});
