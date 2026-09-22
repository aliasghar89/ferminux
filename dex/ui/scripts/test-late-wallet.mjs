// Prove the DEX detects a wallet that injects AFTER React mounts —
// the exact behaviour of a real MetaMask extension.
import { chromium } from 'playwright-core';

const exe = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const url = process.argv[2] || 'https://dex.ferminux.net/';
const delay = Number(process.argv[3] ?? 1200); // how late the "extension" injects

const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e).slice(0, 120)));

// Inject a fake MetaMask AFTER the page has loaded and React has mounted,
// announcing itself the way a real extension does.
await page.addInitScript(({ d }) => {
  setTimeout(() => {
    const provider = {
      isMetaMask: true,
      request: async ({ method }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return ['0x7F16433359E4eF704E90cE08460c6238E45130f7'];
        if (method === 'eth_chainId') return '0xf79';
        if (method === 'net_version') return '3961';
        return null;
      },
      on: () => {},
      removeListener: () => {},
    };
    window.ethereum = provider;
    window.dispatchEvent(new Event('ethereum#initialized'));
  }, d);
}, { d: delay });

await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });

const before = await page.locator('button', { hasText: /Connect|No wallet/ }).first().innerText().catch(() => '(none)');
console.log(`immediately after load      : "${before.trim()}"`);

await page.waitForTimeout(delay + 2500);

const after = await page.locator('button', { hasText: /Connect|No wallet/ }).first().innerText().catch(() => '(none)');
const disabled = await page.locator('button', { hasText: /Connect|No wallet/ }).first().isDisabled().catch(() => null);
console.log(`after the wallet injects    : "${after.trim()}"  disabled=${disabled}`);

const noWalletNotice = await page.getByText('No browser wallet detected').count();
console.log(`"no wallet" notice showing  : ${noWalletNotice}`);
console.log(`page errors                 : ${errs.length ? errs.join(' | ') : 'none'}`);

const pass = after.trim() === 'Connect' && disabled === false && noWalletNotice === 0;
console.log(pass ? '\nPASS — the DEX now detects a late-injecting MetaMask' : '\nFAIL — still not detected');
await browser.close();
process.exit(pass ? 0 : 1);
