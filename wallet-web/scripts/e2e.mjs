#!/usr/bin/env node
// End-to-end data-layer test for the Ferminux web wallet.
//
// Starts a local anvil on port 8547 with --chain-id 3961, then drives the
// SAME modules the UI imports (src/lib/*, src/config.ts — no browser globals):
//   1. create a wallet from a fresh mnemonic (account 0, m/44'/60'/0'/0/0)
//   2. keystore encrypt → decrypt roundtrip + wrong-password rejection
//   3. fund the new address from an anvil account via the app's send module
//   4. EIP-1559 FMX transfer via the app's send module; assert recipient
//      balance and chainId 3961 inside the raw signed transaction
//   5. "Max" fee-headroom math sends the entire remaining balance
//   6. MULTI-ACCOUNT: derive HD accounts 0..2 from one phrase and check them
//      against the node's own m/44'/60'/0'/0/N accounts
//   7. batched balances — the whole account set in ONE round trip, each value
//      cross-checked against eth_getBalance and the total against their sum
//   8. a transfer between two of the user's own accounts
//   9. vault: encrypt a 3-account set under one password, serialize it, reload
//      it from the string, unlock it, scan the blob for plaintext secrets, and
//      sign a real transaction with a key recovered from it
//  10. migration: a v1 single-account keystore upgrades and still unlocks with
//      the ORIGINAL password
//  11. deploy the AZNT ERC-20 (forge artifact from ../contracts) and exercise
//      the app's token module: metadata read, balance, transfer
//  12. kill anvil and verify port 8547 is free again
//
// Usage: npm run e2e

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import assert from 'node:assert/strict';
import { Wallet, Transaction, ContractFactory, Contract, parseEther, parseUnits, formatEther } from 'ethers';

import { CHAIN_ID } from '../src/config.ts';
import { connectRpc, probeRpc } from '../src/lib/rpc.ts';
import {
  generateMnemonic,
  walletFromMnemonic,
  walletFromPrivateKey,
  encryptToKeystore,
  decryptFromKeystore,
  looksLikeKeystore,
  keystoreAddress,
  encryptSeedKeystore,
  DERIVATION_PATH,
} from '../src/lib/wallet.ts';
import { prepareTransaction, signAndBroadcast, getFeeInfo, NATIVE_TRANSFER_GAS } from '../src/lib/tx.ts';
import { fetchTokenMeta, fetchTokenBalance, prepareTokenTransfer } from '../src/lib/tokens.ts';
import { checkAmount, maxSendableWei } from '../src/lib/validate.ts';
import { deriveHdAccounts, nextHdIndex, defaultHdLabel } from '../src/lib/accounts.ts';
import {
  encryptVault,
  decryptVault,
  serializeVault,
  parseVault,
  migrateLegacyKeystore,
  findPlaintextSecrets,
  newAccountId,
} from '../src/lib/vault.ts';
import { fetchBalances, httpBatchTransport, totalBalance, isTotalComplete } from '../src/lib/balances.ts';

const PORT = 8547;
const RPC = `http://127.0.0.1:${PORT}`;
// Well-known anvil dev key #0 (public test key, holds 10000 test coins).
const ANVIL_KEY0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const AZNT_ARTIFACT = fileURLToPath(new URL('../../contracts/out/AZNT.sol/AZNT.json', import.meta.url));

let step = 0;
function ok(msg) {
  step += 1;
  console.log(`  ✓ ${String(step).padStart(2)}. ${msg}`);
}

function portFree(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    const done = (free) => {
      sock.destroy();
      resolve(free);
    };
    sock.once('connect', () => done(false));
    sock.once('error', () => done(true));
    setTimeout(() => done(true), 1500);
  });
}

async function waitForAnvil() {
  for (let i = 0; i < 60; i++) {
    if (await probeRpc(RPC, CHAIN_ID, 1000)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('anvil did not become ready on port 8547');
}

async function main() {
  assert.equal(CHAIN_ID, 3961, 'config CHAIN_ID must be 3961');
  assert.equal(DERIVATION_PATH, "m/44'/60'/0'/0/0");

  assert.equal(await portFree(PORT), true, `port ${PORT} must be free before the test`);
  ok(`port ${PORT} is free`);

  const anvil = spawn('anvil', ['--port', String(PORT), '--chain-id', String(CHAIN_ID), '--silent'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let anvilErr = '';
  anvil.stderr.on('data', (d) => (anvilErr += d));
  const anvilExit = new Promise((resolve) => anvil.once('exit', resolve));

  try {
    await waitForAnvil();
    ok(`anvil up on :${PORT} (chain-id ${CHAIN_ID})`);

    // --- RPC fallback: first URL is dead, connectRpc must fall through ---
    const { provider, url } = await connectRpc(['http://127.0.0.1:9', RPC], CHAIN_ID, 1500);
    assert.equal(url, RPC);
    provider.pollingInterval = 150;
    assert.equal((await provider.getNetwork()).chainId, BigInt(CHAIN_ID));
    ok('connectRpc skipped the dead endpoint and health-probed the live one');

    // --- 1. create wallet from a fresh mnemonic ---
    const mnemonic = generateMnemonic();
    assert.equal(mnemonic.phrase.split(' ').length, 12, 'mnemonic must be 12 words');
    const alice = walletFromMnemonic(mnemonic.phrase);
    assert.match(alice.address, /^0x[0-9a-fA-F]{40}$/);
    assert.equal(alice.path, DERIVATION_PATH);
    assert.equal(walletFromMnemonic(mnemonic.phrase).address, alice.address, 'derivation must be deterministic');
    ok(`created wallet from fresh 12-word mnemonic → ${alice.address}`);

    // --- 2. keystore roundtrip + wrong password ---
    const password = 'correct horse battery 3961';
    const keystore = await encryptToKeystore(alice, password, { scryptN: 1 << 14 });
    assert.equal(looksLikeKeystore(keystore), true);
    assert.equal(keystoreAddress(keystore), alice.address);
    const restored = await decryptFromKeystore(keystore, password);
    assert.equal(restored.address, alice.address);
    assert.equal(restored.privateKey, alice.privateKey);
    ok('keystore encrypt → decrypt roundtrip restores the same key');
    await assert.rejects(decryptFromKeystore(keystore, 'wrong-password-123'), /password|invalid|incorrect/i);
    ok('keystore decryption rejects a wrong password');

    // --- 3. fund alice from anvil key0, via the app's own send module ---
    const funder = walletFromPrivateKey(ANVIL_KEY0);
    const fundPrep = await prepareTransaction(provider, CHAIN_ID, funder.address, alice.address, parseEther('5'));
    const fundSent = await signAndBroadcast(funder.privateKey, provider, fundPrep);
    const fundReceipt = await fundSent.response.wait();
    assert.equal(fundReceipt.status, 1);
    assert.equal(await provider.getBalance(alice.address), parseEther('5'));
    ok('funded the new address with 5 FMX from an anvil account');

    // --- 4. EIP-1559 FMX transfer via the app's send module ---
    const bob = walletFromMnemonic(generateMnemonic().phrase);
    const amount = checkAmount('1.25');
    assert.equal(amount.ok, true);
    const prep = await prepareTransaction(provider, CHAIN_ID, alice.address, bob.address, amount.wei);
    assert.equal(prep.gasLimit, NATIVE_TRANSFER_GAS);
    assert.equal(prep.chainId, CHAIN_ID);
    assert.ok(prep.maxFeePerGas > 0n && prep.maxFeeWei === prep.gasLimit * prep.maxFeePerGas);
    const sent = await signAndBroadcast(alice.privateKey, provider, prep);
    const parsed = Transaction.from(sent.raw);
    assert.equal(parsed.chainId, 3961n, 'raw signed tx must carry chainId 3961');
    assert.equal(parsed.type, 2, 'must be an EIP-1559 (type 2) transaction');
    assert.equal(parsed.to, bob.address);
    assert.equal(parsed.value, amount.wei);
    assert.equal(parsed.from, alice.address, 'signature must recover the sender');
    const receipt = await sent.response.wait();
    assert.equal(receipt.status, 1);
    assert.equal(await provider.getBalance(bob.address), amount.wei);
    ok(`sent 1.25 FMX; recipient balance verified; chainId 3961 verified in raw signed tx (${sent.hash.slice(0, 10)}…)`);

    // --- 5. "Max" fee-headroom math: drain bob completely ---
    const carol = walletFromMnemonic(generateMnemonic().phrase);
    const bobBalance = await provider.getBalance(bob.address);
    const fees = await getFeeInfo(provider);
    const maxWei = maxSendableWei(bobBalance, NATIVE_TRANSFER_GAS, fees.maxFeePerGas);
    assert.ok(maxWei > 0n && maxWei < bobBalance);
    const maxPrep = await prepareTransaction(provider, CHAIN_ID, bob.address, carol.address, maxWei);
    const maxSent = await signAndBroadcast(bob.privateKey, provider, maxPrep);
    const maxReceipt = await maxSent.response.wait();
    assert.equal(maxReceipt.status, 1);
    assert.equal(await provider.getBalance(carol.address), maxWei);
    const bobLeft = await provider.getBalance(bob.address);
    assert.ok(bobLeft >= 0n && bobLeft <= maxPrep.maxFeeWei, 'leftover must be within the reserved fee headroom');
    ok(`Max math sent ${formatEther(maxWei)} FMX and left only unused fee headroom (${formatEther(bobLeft)})`);

    // --- 6. multi-account: HD derivation matches the chain's own accounts ---
    // anvil derives its dev accounts from this very phrase at m/44'/60'/0'/0/N,
    // so agreeing with it is an independent check of our derivation.
    const PHRASE = 'test test test test test test test test test test test junk';
    const hd = deriveHdAccounts(PHRASE, [0, 1, 2]);
    assert.equal(hd[0].privateKey, ANVIL_KEY0, 'HD index 0 must equal anvil account #0');
    const chainAccounts = await provider.send('eth_accounts', []);
    hd.forEach((account, i) => {
      assert.equal(account.address.toLowerCase(), chainAccounts[i], `HD index ${i} must equal anvil account #${i}`);
    });
    assert.equal(nextHdIndex(hd.map((a) => a.index)), 3);
    ok(`derived 3 HD accounts from one phrase; all match the node's own m/44'/60'/0'/0/N accounts`);

    // --- 7. batched balances: one HTTP round trip for the whole set ---
    const watched = [...hd.map((a) => a.address), alice.address, carol.address];
    let batchCalls = 0;
    const countingTransport = (calls) => {
      batchCalls += 1;
      assert.equal(calls.length, watched.length, 'every account travels in one batch');
      return httpBatchTransport(RPC)(calls);
    };
    const snapshot = await fetchBalances(countingTransport, watched);
    assert.equal(batchCalls, 1, `${watched.length} balances must cost exactly one round trip`);
    assert.equal(isTotalComplete(snapshot, watched), true);
    let expectedTotal = 0n;
    for (const address of watched) {
      const direct = await provider.getBalance(address);
      assert.equal(snapshot.balances.get(address.toLowerCase()), direct, `batched balance for ${address}`);
      expectedTotal += direct;
    }
    assert.equal(totalBalance(snapshot, watched), expectedTotal, 'the total is the exact sum');
    ok(`batched ${watched.length} balances in 1 request; each matches eth_getBalance and the total is exact`);

    // --- 8. send between two of the user's own accounts ---
    const ownAmount = checkAmount('0.75');
    const beforeOwn = await provider.getBalance(hd[2].address);
    const ownPrep = await prepareTransaction(provider, CHAIN_ID, hd[1].address, hd[2].address, ownAmount.wei);
    const ownSent = await signAndBroadcast(hd[1].privateKey, provider, ownPrep);
    assert.equal(Transaction.from(ownSent.raw).chainId, 3961n);
    assert.equal((await ownSent.response.wait()).status, 1);
    assert.equal(await provider.getBalance(hd[2].address), beforeOwn + ownAmount.wei);
    ok('own-account transfer (HD #1 → HD #2) confirmed on chain');

    // --- 9. vault: encrypt a mixed set, serialize, reload, unlock ---
    const session = {
      accounts: [
        { id: newAccountId(), kind: 'hd', index: 0, address: hd[0].address, label: defaultHdLabel(0), privateKey: hd[0].privateKey, origin: 'hd', backup: 'seed' },
        { id: newAccountId(), kind: 'hd', index: 1, address: hd[1].address, label: 'Ops', privateKey: hd[1].privateKey, origin: 'hd', backup: 'seed' },
        { id: newAccountId(), kind: 'imported', index: null, address: alice.address, label: 'Imported alice', privateKey: alice.privateKey, origin: 'privateKey', backup: 'none' },
      ],
      activeId: null,
      mnemonic: PHRASE,
    };
    session.activeId = session.accounts[1].id;
    const vault = await encryptVault(session, 'vault password 3961', { scryptN: 1 << 14 });
    const blob = serializeVault(vault);
    const leaks = findPlaintextSecrets(blob, {
      privateKeys: session.accounts.map((a) => a.privateKey),
      mnemonics: [PHRASE],
      passwords: ['vault password 3961'],
    });
    assert.deepEqual(leaks, [], `the stored blob leaked: ${leaks.join(', ')}`);
    const reloaded = parseVault(blob);
    const unlocked = await decryptVault(reloaded, 'vault password 3961');
    assert.deepEqual(unlocked.failed, []);
    assert.deepEqual(unlocked.set.accounts.map((a) => a.address), session.accounts.map((a) => a.address));
    assert.deepEqual(unlocked.set.accounts.map((a) => a.privateKey), session.accounts.map((a) => a.privateKey));
    assert.equal(unlocked.set.activeId, session.activeId);
    await assert.rejects(decryptVault(reloaded, 'wrong password'), /could not be decrypted/i);
    ok('vault: 3 accounts encrypted under one password, reloaded from a string, unlocked; no plaintext secret in the blob');

    // A key recovered through the vault still signs a real transaction.
    const revived = unlocked.set.accounts[1];
    const revivedPrep = await prepareTransaction(provider, CHAIN_ID, revived.address, carol.address, checkAmount('0.1').wei);
    const revivedSent = await signAndBroadcast(revived.privateKey, provider, revivedPrep);
    assert.equal((await revivedSent.response.wait()).status, 1);
    ok('a key restored from the encrypted vault signs and broadcasts a real transaction');

    // --- 10. migration from the v1 single-account keystore ---
    const legacy = await encryptSeedKeystore(PHRASE, 'legacy password', { scryptN: 1 << 14 });
    const migrated = migrateLegacyKeystore(legacy);
    assert.equal(migrated.accounts.length, 1);
    assert.equal(migrated.accounts[0].address, hd[0].address);
    const migratedSet = await decryptVault(migrated, 'legacy password');
    assert.equal(migratedSet.set.accounts[0].privateKey, hd[0].privateKey);
    assert.equal(migratedSet.set.mnemonic, PHRASE, 'the upgraded wallet can derive further accounts');
    ok('v1 single-account keystore upgraded to a multi-account vault with the ORIGINAL password');

    // --- 11. ERC-20 via the app's token module (AZNT forge artifact) ---
    const artifact = JSON.parse(readFileSync(AZNT_ARTIFACT, 'utf8'));
    const deployer = new Wallet(ANVIL_KEY0, provider);
    const factory = new ContractFactory(artifact.abi, artifact.bytecode.object, deployer);
    const deployed = await factory.deploy(deployer.address);
    await deployed.waitForDeployment();
    const tokenAddress = await deployed.getAddress();
    const admin = new Contract(tokenAddress, artifact.abi, deployer);
    await (await admin.grantRole(await admin.MINTER(), deployer.address)).wait();
    const meta = await fetchTokenMeta(provider, tokenAddress);
    assert.equal(meta.address.toLowerCase(), tokenAddress.toLowerCase());
    assert.ok(meta.symbol.length > 0 && meta.name.length > 0);
    assert.ok(Number.isInteger(meta.decimals));
    const minted = parseUnits('250', meta.decimals);
    await (await admin.mint(alice.address, minted)).wait();
    ok(`deployed ${meta.symbol} (${meta.name}, ${meta.decimals} decimals) at ${tokenAddress} and minted 250 to alice`);

    assert.equal(await fetchTokenBalance(provider, tokenAddress, alice.address), minted, 'token balance read');
    const tokenAmountCheck = checkAmount('99.5', meta.decimals);
    assert.equal(tokenAmountCheck.ok, true);
    const tokenPrep = await prepareTokenTransfer(provider, CHAIN_ID, alice.address, tokenAddress, bob.address, tokenAmountCheck.wei);
    assert.equal(tokenPrep.valueWei, 0n);
    assert.equal(tokenPrep.to, tokenAddress);
    const tokenSent = await signAndBroadcast(alice.privateKey, provider, tokenPrep);
    const tokenParsed = Transaction.from(tokenSent.raw);
    assert.equal(tokenParsed.chainId, 3961n, 'token transfer must also sign chainId 3961');
    const tokenReceipt = await tokenSent.response.wait();
    assert.equal(tokenReceipt.status, 1);
    assert.equal(await fetchTokenBalance(provider, tokenAddress, bob.address), tokenAmountCheck.wei);
    assert.equal(await fetchTokenBalance(provider, tokenAddress, alice.address), minted - tokenAmountCheck.wei);
    ok('token transfer via the app token module verified (sender and recipient balances)');

    // --- 12. token module error paths ---
    await assert.rejects(fetchTokenMeta(provider, carol.address), /no contract/i);
    ok('fetchTokenMeta rejects an address with no contract code');

    provider.destroy();
  } finally {
    anvil.kill('SIGTERM');
    await Promise.race([anvilExit, new Promise((r) => setTimeout(r, 5000))]);
    if (anvil.exitCode === null) anvil.kill('SIGKILL');
    await anvilExit;
  }

  // --- 13. anvil down, port free again ---
  for (let i = 0; i < 20 && !(await portFree(PORT)); i++) await new Promise((r) => setTimeout(r, 250));
  assert.equal(await portFree(PORT), true, `port ${PORT} must be free after the test`);
  ok(`anvil stopped; port ${PORT} is free again`);

  console.log('\nE2E: all checks passed.');
  if (anvilErr.trim()) console.log(`(anvil stderr: ${anvilErr.trim().slice(0, 200)})`);
}

main().catch((err) => {
  console.error('\nE2E FAILED:', err);
  process.exit(1);
});
