#!/usr/bin/env node
// Browser check for the MULTI-ACCOUNT wallet UI.
//
// Builds the real bundle against a local anvil, serves it, and drives it in a
// headless Chromium: create a wallet, add two HD accounts, import a third,
// rename one, switch accounts, verify per-account balances and the total,
// prove localStorage holds no secret, lock, unlock the whole set with one
// password, and check that Send / Receive / Tokens / Activity all follow the
// active account. Screenshots are written next to the temporary build.
//
//   node scripts/ui-check.mjs
//
// Requirements (both optional — the script SKIPS cleanly without them):
//   • anvil            (foundry)
//   • playwright-core  + a Chromium build
//     PLAYWRIGHT_DIR=/path/to/dir/containing/node_modules/playwright-core
//     CHROME_PATH=/path/to/chrome            (defaults to the ms-playwright cache)
//
// Ports: 8571 (static server) and 8547 (anvil), both released on exit.
// Read-only towards the real network: nothing here touches mainnet.

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdir, mkdtemp } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { JsonRpcProvider, Wallet, parseEther, formatEther } from 'ethers';
import { encryptSeedKeystore } from '../src/lib/wallet.ts';
import { LEGACY_KEYSTORE_KEY, VAULT_KEY } from '../src/lib/vault.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WEB_PORT = 8571;
const RPC_PORT = 8547;
const RPC = `http://127.0.0.1:${RPC_PORT}`;
// Deliberately dead: exercises the "explorer unreachable" degradation.
const DEAD_EXPLORER = 'http://127.0.0.1:9';

const CHROME =
  process.env.CHROME_PATH ??
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

// Well-known anvil dev keys (public test keys).
const KEY0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const KEY2 = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const ADDR2 = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const PASSWORD = 'ferminux multi 3961';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

let n = 0;
const ok = (m) => console.log(`  ✓ ${String(++n).padStart(2)}. ${m}`);
const info = (m) => console.log(`       · ${m}`);
const skip = (why) => {
  console.log(`ui-check SKIPPED: ${why}`);
  process.exit(0);
};

async function loadPlaywright() {
  const candidates = [
    'playwright-core',
    ...(process.env.PLAYWRIGHT_DIR ? [join(process.env.PLAYWRIGHT_DIR, 'node_modules/playwright-core/index.js')] : []),
  ];
  for (const specifier of candidates) {
    try {
      const mod = await import(specifier);
      // playwright-core is CommonJS: named exports may only exist on .default.
      const chromium = mod.chromium ?? mod.default?.chromium;
      if (chromium) return { chromium };
    } catch {
      /* try the next one */
    }
  }
  return null;
}

async function main() {
  if (spawnSync('anvil', ['--version'], { stdio: 'ignore' }).error) skip('anvil is not installed');
  const pw = await loadPlaywright();
  if (!pw) skip('playwright-core is not resolvable (set PLAYWRIGHT_DIR)');
  const { existsSync } = await import('node:fs');
  if (!existsSync(CHROME)) skip(`no Chromium at ${CHROME} (set CHROME_PATH)`);

  const work = await mkdtemp(join(tmpdir(), 'ferminux-wallet-ui-'));
  const dist = join(work, 'dist');
  const shots = join(work, 'shots');
  await mkdir(shots, { recursive: true });

  const build = spawnSync('npx', ['vite', 'build', '--outDir', dist, '--emptyOutDir'], {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env, VITE_RPC_URLS: RPC, VITE_EXPLORER_URL: DEAD_EXPLORER },
  });
  if (build.status !== 0) throw new Error('vite build failed');

  const anvil = spawn('anvil', ['--port', String(RPC_PORT), '--chain-id', '3961', '--silent'], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const server = createServer(async (req, res) => {
    const path = (req.url || '/').split('?')[0];
    if (path === '/favicon.ico') return void res.writeHead(204).end();
    try {
      const file = join(dist, path === '/' ? 'index.html' : path);
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  let browser;

  try {
    await new Promise((r) => server.listen(WEB_PORT, '127.0.0.1', r));
    const provider = new JsonRpcProvider(RPC, { chainId: 3961, name: 'ferminux' }, { staticNetwork: true, cacheTimeout: -1 });
    for (let i = 0; i < 80; i++) {
      try {
        await provider.getBlockNumber();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    ok(`anvil on :${RPC_PORT}; wallet bundle served on http://127.0.0.1:${WEB_PORT}`);

    browser = await pw.chromium.launch({ executablePath: CHROME, headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, acceptDownloads: true });
    const page = await ctx.newPage();
    const jsErrors = [];
    const consoleErrors = [];
    page.on('pageerror', (e) => jsErrors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      // The explorer points at a dead port on purpose; Chrome logs the failed
      // request even though the app handles it and says "History unavailable".
      if (/ERR_UNSAFE_PORT|ERR_CONNECTION_REFUSED|Failed to fetch/.test(m.text())) return;
      consoleErrors.push(m.text());
    });

    await page.goto(`http://127.0.0.1:${WEB_PORT}/`, { waitUntil: 'load' });
    await page.waitForSelector('[data-testid=create-wallet]');
    ok('wallet loaded, onboarding shown');

    /* --- MIGRATION: an existing v1 single-account install upgrades on load --- */
    // Exactly what the previous wallet wrote: one bare keystore string.
    const LEGACY_PHRASE = 'test test test test test test test test test test test junk';
    const LEGACY_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
    const LEGACY_PASSWORD = 'the old password';
    const legacyJson = await encryptSeedKeystore(LEGACY_PHRASE, LEGACY_PASSWORD, { scryptN: 1 << 12 });
    await page.evaluate(
      ([key, json]) => window.localStorage.setItem(key, json),
      [LEGACY_KEYSTORE_KEY, legacyJson],
    );
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('[data-testid=unlock-submit]', { timeout: 20000 });
    const migratedRows = await page.$$eval('.unlock-accounts li', (els) => els.map((e) => e.textContent));
    assert.equal(migratedRows.length, 1, 'the migrated wallet shows exactly one account');
    assert.ok(migratedRows[0].includes('Account 1') && migratedRows[0].includes('HD #0'));
    const storageAfterMigration = await page.evaluate(
      ([vaultKey, legacyKey]) => ({
        vault: window.localStorage.getItem(vaultKey),
        legacy: window.localStorage.getItem(legacyKey),
      }),
      [VAULT_KEY, LEGACY_KEYSTORE_KEY],
    );
    assert.ok(storageAfterMigration.vault, 'a v2 vault was written');
    assert.equal(storageAfterMigration.legacy, null, 'the v1 key is removed once the v2 blob reads back');
    assert.equal(JSON.parse(storageAfterMigration.vault).seed, legacyJson, 'the ciphertext is carried over verbatim');

    await page.fill('#unlock-pw', LEGACY_PASSWORD);
    await page.click('[data-testid=unlock-submit]');
    await page.waitForSelector('[data-testid=active-address]', { timeout: 60000 });
    assert.equal(await page.getAttribute('[data-testid=active-address]', 'data-address'), LEGACY_ADDRESS);
    // The upgraded wallet can now grow: "Add account" is live because the
    // migrated keystore carried the phrase.
    await page.click('[data-testid=home-manage]');
    await page.waitForSelector('[data-testid=add-hd-account]');
    assert.equal(await (await page.$('[data-testid=add-hd-account]')).isDisabled(), false);
    await page.click('[data-testid=add-hd-account]');
    await page.waitForFunction(() => document.querySelectorAll('.acct-manage-list > li').length === 2, { timeout: 10000 });
    const grown = await page.$$eval('.acct-manage-list > li', (els) =>
      els.map((e) => e.getAttribute('data-testid').replace('manage-row-', '')),
    );
    assert.deepEqual(grown, [LEGACY_ADDRESS.toLowerCase(), '0x70997970c51812dc3a010c7d01b50e0d17dc79c8']);
    await page.screenshot({ path: join(shots, '00-migrated.png') });
    ok('a v1 single-account install upgraded on load, unlocked with its ORIGINAL password, and grew a second HD account');

    // Back to a clean slate for the rest of the run.
    await page.click('[data-testid=modal-close]');
    await page.click('[data-testid=lock]');
    await page.waitForSelector('.btn-ghost.btn-sm');
    await page.click('text=Forget this device…');
    await page.click('.btn-danger-ghost');
    await page.waitForSelector('[data-testid=create-wallet]');
    ok('"Forget this device" cleared the stored vault and returned to onboarding');

    /* --- create a wallet, remembered on this device --- */
    await page.click('[data-testid=create-wallet]');
    await page.waitForSelector('.mnemonic-grid');
    const words = await page.$$eval('.mnemonic-word', (els) => els.map((e) => e.textContent.replace(/^\d+/, '')));
    assert.equal(words.length, 12);
    await page.click('[data-testid=reveal-phrase]');
    await page.click('[data-testid=phrase-continue]');
    // Confirm the phrase: pick the right word for each position asked.
    await page.waitForSelector('[data-quiz-index]');
    for (const group of await page.$$('[data-quiz-index]')) {
      const want = words[Number(await group.getAttribute('data-quiz-index')) - 1].trim();
      for (const opt of await group.$$('.quiz-opt')) if ((await opt.textContent()).trim() === want) await opt.click();
    }
    await page.click('[data-testid=confirm-continue]');
    await page.fill('#c-pw', PASSWORD);
    await page.fill('#c-pw2', PASSWORD);
    await page.click('.check-row input[type=checkbox]'); // remember on this device
    const download = page.waitForEvent('download', { timeout: 60000 }).catch(() => null);
    await page.click('[data-testid=encrypt-download]');
    await page.waitForSelector('[data-testid=open-wallet]', { timeout: 120000 });
    const dl = await download;
    ok(`created a wallet; keystore downloaded as ${dl ? dl.suggestedFilename() : '(download event missed)'}`);
    await page.click('[data-testid=open-wallet]');
    await page.waitForSelector('[data-testid=active-address]');
    const addr1 = await page.getAttribute('[data-testid=active-address]', 'data-address');
    info(`Account 1 = ${addr1}`);

    /* --- fund it so a real balance appears --- */
    const funder = new Wallet(KEY0, provider);
    await (await funder.sendTransaction({ to: addr1, value: parseEther('3.5') })).wait();
    await page.waitForFunction(
      () => document.querySelector('[data-testid=active-balance]')?.textContent.trim().startsWith('3.5'),
      { timeout: 30000 },
    );
    ok('funded Account 1 with 3.5 FMX; the balance appeared without a reload');

    /* --- add two HD accounts --- */
    await page.click('[data-testid=home-manage]');
    await page.waitForSelector('[data-testid=add-hd-account]');
    await page.click('[data-testid=add-hd-account]');
    await page.click('[data-testid=add-hd-account]');
    await page.waitForFunction(() => document.querySelectorAll('.acct-manage-list > li').length === 3, { timeout: 10000 });
    const hdAddrs = await page.$$eval('.acct-manage-list > li', (els) =>
      els.map((e) => e.getAttribute('data-testid').replace('manage-row-', '')),
    );
    assert.equal(new Set(hdAddrs).size, 3, 'three distinct addresses');
    ok(`added 2 HD accounts — now 3: ${hdAddrs.map((a) => a.slice(0, 8)).join(', ')}`);

    /* --- import a funded standalone key as a fourth account --- */
    await page.click('[data-testid=open-import]');
    await page.fill('#acct-import-key', KEY2);
    await page.fill('#acct-import-label', 'Cold storage');
    await page.fill('#acct-import-devicepw', PASSWORD);
    await page.click('[data-testid=do-import]');
    await page.waitForFunction(() => document.querySelectorAll('.acct-manage-list > li').length === 4, { timeout: 180000 });
    assert.ok(await page.$(`[data-testid="manage-row-${ADDR2.toLowerCase()}"]`));
    ok('imported a raw private key as a 4th account (device password verified, then re-encrypted)');

    /* --- rename --- */
    const second = hdAddrs[1];
    await page.click(`[data-testid="rename-${second}"]`);
    await page.fill(`[data-testid="rename-input-${second}"]`, 'Payroll');
    await page.click(`[data-testid="rename-save-${second}"]`);
    await page.waitForFunction(
      (sel) => document.querySelector(sel)?.textContent.includes('Payroll'),
      `[data-testid="manage-row-${second}"]`,
      { timeout: 10000 },
    );
    ok('renamed HD account 2 to "Payroll"');

    /* --- total balance --- */
    await page.waitForFunction(
      () => {
        const t = document.querySelector('[data-testid=total-balance]');
        return t && !t.querySelector('.skeleton') && t.textContent.includes(',');
      },
      { timeout: 30000 },
    );
    const totalText = (await page.textContent('[data-testid=total-balance]')).trim();
    const rowBalances = await page.$$eval('.acct-manage-bal', (els) => els.map((e) => e.textContent.trim()));
    let expectedTotal = 0n;
    for (const a of [...hdAddrs, ADDR2.toLowerCase()]) expectedTotal += await provider.getBalance(a);
    const shownTotal = Number(totalText.replace(/[^\d.]/g, ''));
    assert.ok(
      Math.abs(shownTotal - Number(formatEther(expectedTotal))) < 0.001,
      `total shown ${shownTotal} vs chain ${formatEther(expectedTotal)}`,
    );
    ok(`total balance ${totalText} matches the chain sum ${formatEther(expectedTotal)} FMX`);
    info(`per-account rows: ${rowBalances.join(' | ')}`);
    await page.screenshot({ path: join(shots, '01-accounts-panel.png') });

    /* --- nothing secret in localStorage --- */
    const stored = await page.evaluate(() => JSON.stringify(window.localStorage));
    assert.equal(stored.toLowerCase().includes(KEY2.slice(2).toLowerCase()), false, 'imported key stored in the clear');
    // Checked as the phrase and as adjacent word pairs, not word by word: the
    // mnemonic is random, and single BIP-39 words such as "address", "account"
    // or "cold" also occur in the vault's own field names and account labels,
    // which failed this gate at random with nothing leaked. A stored phrase in
    // any separator still puts two of its words next to each other.
    const lowerStored = stored.toLowerCase();
    const phrase = words.map((w) => w.trim().toLowerCase());
    assert.equal(lowerStored.includes(phrase.join(' ')), false, 'mnemonic phrase stored in the clear');
    for (let i = 0; i + 1 < phrase.length; i++) {
      assert.equal(
        new RegExp(`\\b${phrase[i]}\\W{1,4}${phrase[i + 1]}\\b`).test(lowerStored),
        false,
        `mnemonic words "${phrase[i]} ${phrase[i + 1]}" leaked in sequence`,
      );
    }
    assert.equal(stored.includes(PASSWORD), false, 'password stored');
    assert.ok(stored.includes('ferminux.wallet.vault.v2'));
    ok('localStorage holds the vault but no private key, no run of mnemonic words and no password');

    /* --- switch accounts from the header --- */
    await page.click('[data-testid=modal-close]');
    await page.click('[data-testid=account-trigger]');
    await page.waitForSelector('[data-testid=account-menu]');
    await page.screenshot({ path: join(shots, '02-switcher.png') });
    await page.click(`[data-testid="account-row-${ADDR2.toLowerCase()}"]`);
    await page.waitForFunction(
      (want) => document.querySelector('[data-testid=active-address]')?.getAttribute('data-address')?.toLowerCase() === want,
      ADDR2.toLowerCase(),
      { timeout: 10000 },
    );
    const coldBalance = (await page.textContent('[data-testid=active-balance]')).trim();
    ok(`switched to "Cold storage": active address ${ADDR2}, balance ${coldBalance}`);
    await page.screenshot({ path: join(shots, '03-active-cold.png') });

    /* --- one-click send to an own account --- */
    await page.click('[data-testid=send-open]');
    await page.click('[data-testid=own-accounts-open]');
    await page.waitForSelector('[data-testid=own-picker]');
    assert.equal(await page.$$eval('[data-testid=own-picker] li', (e) => e.length), 3, 'lists the other accounts only');
    await page.screenshot({ path: join(shots, '04-own-picker.png') });
    await page.click(`[data-testid="own-pick-${hdAddrs[0]}"]`);
    assert.equal((await page.inputValue('#send-to')).toLowerCase(), hdAddrs[0]);
    ok('one click in "My accounts" filled the recipient with another own account');

    /* --- the QR scanner still opens beside the new picker --- */
    await page.click('[data-testid=scan-open]');
    await page.waitForSelector('.scan-stage', { timeout: 20000 });
    await page.waitForFunction(
      () => /scan from image|paste|camera/i.test(document.querySelector('.modal')?.textContent ?? ''),
      { timeout: 20000 },
    );
    await page.click('[data-testid=modal-close]');
    ok('the QR scanner still opens and offers its no-camera fallbacks');

    /* --- lock, then unlock the whole set with one password --- */
    await page.click('[data-testid=lock]');
    await page.waitForSelector('[data-testid=unlock-submit]');
    const preview = await page.$$eval('.unlock-accounts li', (els) => els.map((e) => e.textContent));
    assert.equal(preview.length, 4);
    assert.ok(preview.some((t) => t.includes('Payroll')) && preview.some((t) => t.includes('Cold storage')));
    await page.screenshot({ path: join(shots, '05-locked.png') });
    ok(`locked; the stored set (${preview.length} accounts) is listed before unlocking`);

    await page.fill('#unlock-pw', PASSWORD);
    await page.click('[data-testid=unlock-submit]');
    await page.waitForSelector('[data-testid=account-trigger]', { timeout: 180000 });
    await page.click('[data-testid=tab-assets] >> visible=true');
    await page.click('[data-testid=home-manage]');
    await page.waitForFunction(() => document.querySelectorAll('.acct-manage-list > li').length === 4, { timeout: 20000 });
    const afterAddrs = await page.$$eval('.acct-manage-list > li', (els) =>
      els.map((e) => e.getAttribute('data-testid').replace('manage-row-', '')),
    );
    assert.deepEqual(afterAddrs, [...hdAddrs, ADDR2.toLowerCase()], 'same four accounts, same order');
    const afterLabels = await page.$$eval('.acct-manage-label', (els) => els.map((e) => e.textContent));
    assert.ok(afterLabels.some((l) => l.includes('Payroll')), 'the rename survived the lock');
    assert.ok(afterLabels.some((l) => l.includes('Cold storage')));
    await page.waitForFunction(
      () => {
        const t = document.querySelector('[data-testid=total-balance]');
        return t && !t.querySelector('.skeleton');
      },
      { timeout: 30000 },
    );
    assert.equal((await page.textContent('[data-testid=total-balance]')).trim(), totalText, 'total unchanged');
    ok(`one password unlocked all 4 accounts; labels and total (${totalText}) survived the lock`);
    await page.screenshot({ path: join(shots, '06-after-unlock.png') });

    /* --- existing features follow the active account --- */
    await page.click('[data-testid=modal-close]');
    await page.click('[data-testid=tab-assets] >> visible=true');
    await page.waitForSelector('[data-testid=assets-panel]');
    const holder = await page.textContent('[data-testid=account-trigger]');
    assert.ok(holder.includes('Cold storage'), 'the Home screen belongs to the active account');
    // This anvil has no AZNT contract: the preloaded token stays listed, and
    // its unreadable balance shows as "—" rather than being hidden as zero.
    await page.waitForSelector('[data-testid="chain-group-3961"][data-status=ok]', { timeout: 30000 });
    const aznt = await page.textContent('[data-testid="asset-3961-AZNT"]');
    assert.match(aznt, /AZNT/, 'the preloaded AZNT token is still listed');
    assert.equal((await page.textContent('[data-testid="asset-3961-AZNT"] [data-testid=asset-balance]')).trim(), '—');
    ok('Assets tab is scoped to the active account; preloaded AZNT still listed, unreadable balance shown as —');

    await page.click('[data-testid=tab-activity] >> visible=true');
    await page.waitForSelector('.empty-state, .row-list', { timeout: 30000 });
    assert.ok((await page.textContent('.holder-line')).includes('Cold storage'));
    assert.match(await page.textContent('.empty-state'), /History unavailable/i);
    ok('Activity tab names the active account and degrades to "History unavailable"');

    await page.click('[data-testid=tab-assets] >> visible=true');
    await page.click('[data-testid=receive-open]');
    await page.waitForSelector('.receive-account');
    assert.ok((await page.textContent('.receive-account')).includes('Cold storage'));
    const uri = (await page.textContent('.uri-line')).trim();
    assert.equal(uri, `ethereum:${ADDR2}@3961`, 'the receive QR still encodes EIP-681 for chain 3961');
    await page.screenshot({ path: join(shots, '07-receive.png') });
    await page.click('[data-testid=modal-close]');
    ok(`Receive modal is scoped to the active account; EIP-681 URI = ${uri}`);

    /* --- narrow viewport: nothing overflows, everything stays reachable --- */
    const noOverflow = async (label) => {
      const m = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
      assert.ok(m.doc <= m.win, `${label}: the page scrolls horizontally (${m.doc} > ${m.win})`);
    };
    await page.setViewportSize({ width: 390, height: 844 });
    await noOverflow('dashboard');
    await page.click('[data-testid=account-trigger]');
    await page.waitForSelector('[data-testid=account-menu]');
    await noOverflow('account switcher menu');
    await page.screenshot({ path: join(shots, '09-mobile-switcher.png') });
    await page.keyboard.press('Escape');
    await page.click('[data-testid=home-manage]');
    await page.waitForSelector('.acct-manage-list');
    await noOverflow('accounts panel');
    const closeBox = await (await page.$('[data-testid=modal-close]')).boundingBox();
    assert.ok(closeBox.y >= 0 && closeBox.y + closeBox.height <= 844, 'the modal Close button stays on screen');
    await page.screenshot({ path: join(shots, '10-mobile-accounts.png') });
    await page.click('[data-testid=modal-close]');
    await page.setViewportSize({ width: 1280, height: 1000 });
    ok('at 390 px wide the header, the switcher menu and the Accounts panel all fit — no horizontal page scroll');

    /* --- removing a key with no backup is gated --- */
    await page.click('[data-testid=home-manage]');
    await page.waitForSelector(`[data-testid="manage-row-${ADDR2.toLowerCase()}"]`);
    await page.click(`[data-testid="manage-row-${ADDR2.toLowerCase()}"] .btn-danger-ghost`);
    await page.waitForSelector('.notice-danger');
    assert.match(await page.textContent(`[data-testid="manage-row-${ADDR2.toLowerCase()}"] .notice-danger`), /only copy/i);
    const removeBtn = await page.$(`[data-testid="confirm-remove-${ADDR2.toLowerCase()}"]`);
    assert.equal(await removeBtn.isDisabled(), true, 'removal blocked until acknowledged');
    await page.screenshot({ path: join(shots, '08-remove-warning.png') });
    await page.click(`[data-testid="manage-row-${ADDR2.toLowerCase()}"] .check-row input`);
    assert.equal(await removeBtn.isDisabled(), false);
    await removeBtn.click();
    await page.waitForFunction(() => document.querySelectorAll('.acct-manage-list > li').length === 3, { timeout: 10000 });
    ok('removing a key with no backup warns, requires an acknowledgement, then removes it');
    await page.click('[data-testid=modal-close]');

    /* --- a wrong password is refused --- */
    await page.click('[data-testid=lock]');
    await page.waitForSelector('#unlock-pw');
    await page.fill('#unlock-pw', 'not the password');
    await page.click('[data-testid=unlock-submit]');
    await page.waitForSelector('.field-error', { timeout: 180000 });
    const errText = (await page.textContent('.field-error')).trim();
    assert.match(errText, /wrong password/i);
    ok(`a wrong password is refused: "${errText}"`);

    assert.deepEqual(jsErrors, [], `uncaught JS errors: ${jsErrors.join(' | ')}`);
    assert.deepEqual(consoleErrors, [], `console errors: ${consoleErrors.join(' | ')}`);
    ok('no uncaught JS exceptions and no unexpected console errors throughout');

    console.log(`\nUI CHECK: all ${n} checks passed.\nScreenshots: ${shots}`);
  } finally {
    if (browser) await browser.close();
    server.close();
    anvil.kill('SIGKILL');
  }
}

main().catch((e) => {
  console.error('\nUI CHECK FAILED:', e);
  process.exit(1);
});
