// Unit tests for the phone hand-off (QR / deep-link) logic.
//
// Also enforces the sharing contract: src/lib/handoff.ts and
// src/components/MobileHandoff.tsx are byte-identical between dex/ui and
// wallet-web. This test file is itself identical in both apps and locates the
// repo root by walking upward, so the same bytes run from either side.
//
// Run: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  METAMASK_DEEPLINK_BASE,
  buildMetaMaskDeepLink,
  classifyHandoff,
  isMobileUserAgent,
} from '../src/lib/handoff.ts';

const UA = {
  macChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  winChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  // MetaMask Mobile's in-app browser
  metamaskMobile:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36 MetaMaskMobile',
  // iPadOS 13+ masquerading as a Mac; the touch screen is the tell
  ipadDesktopMode:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
};

/* ------------------------------------------------------------------ *
 * Deep link building
 * ------------------------------------------------------------------ */

test('deep link: plain page', () => {
  assert.equal(
    buildMetaMaskDeepLink('https://dex.ferminux.net/'),
    `${METAMASK_DEEPLINK_BASE}dex.ferminux.net/`,
  );
});

test('deep link: path, query and port survive; hash does not', () => {
  assert.equal(
    buildMetaMaskDeepLink('https://wallet.ferminux.net/app?tab=send#frag'),
    `${METAMASK_DEEPLINK_BASE}wallet.ferminux.net/app?tab=send`,
  );
  assert.equal(
    buildMetaMaskDeepLink('http://localhost:8666/index.html'),
    `${METAMASK_DEEPLINK_BASE}localhost:8666/index.html`,
  );
});

test('deep link: non-http(s) pages cannot be expressed', () => {
  assert.equal(buildMetaMaskDeepLink('file:///Users/x/dist/index.html'), null);
  assert.equal(buildMetaMaskDeepLink('chrome-extension://abc/page.html'), null);
  assert.equal(buildMetaMaskDeepLink('not a url'), null);
  assert.equal(buildMetaMaskDeepLink(''), null);
});

/* ------------------------------------------------------------------ *
 * Environment classification
 * ------------------------------------------------------------------ */

test('mobile detection: phones yes, desktops no', () => {
  assert.equal(isMobileUserAgent(UA.iphone), true);
  assert.equal(isMobileUserAgent(UA.androidChrome), true);
  assert.equal(isMobileUserAgent(UA.metamaskMobile), true);
  assert.equal(isMobileUserAgent(UA.macChrome), false);
  assert.equal(isMobileUserAgent(UA.winChrome), false);
});

test('mobile detection: iPad in desktop mode is caught by touch points', () => {
  assert.equal(isMobileUserAgent(UA.ipadDesktopMode, 5), true);
  // a real Mac has no touch screen
  assert.equal(isMobileUserAgent(UA.macChrome, 0), false);
});

test('classify: injected provider always wins — no hand-off inside a wallet', () => {
  assert.equal(classifyHandoff({ hasInjected: true, userAgent: UA.metamaskMobile }), 'wallet');
  assert.equal(classifyHandoff({ hasInjected: true, userAgent: UA.macChrome }), 'wallet');
});

test('classify: phone without a provider gets the tap target', () => {
  assert.equal(classifyHandoff({ hasInjected: false, userAgent: UA.iphone }), 'phone');
  assert.equal(classifyHandoff({ hasInjected: false, userAgent: UA.androidChrome }), 'phone');
});

test('classify: desktop without a provider gets the QR', () => {
  assert.equal(classifyHandoff({ hasInjected: false, userAgent: UA.macChrome }), 'desktop');
  assert.equal(classifyHandoff({ hasInjected: false, userAgent: UA.winChrome }), 'desktop');
});

/* ------------------------------------------------------------------ *
 * Sharing contract: the two apps carry identical copies
 * ------------------------------------------------------------------ */

function findRepoRoot(from) {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'wallet-web')) && existsSync(join(dir, 'dex', 'ui'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

test('shared files have not drifted between dex/ui and wallet-web', (t) => {
  const root = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
  if (!root) {
    t.skip('sibling app not present — nothing to compare');
    return;
  }
  for (const rel of [
    join('src', 'lib', 'handoff.ts'),
    join('src', 'components', 'MobileHandoff.tsx'),
    join('tests', 'handoff.test.mjs'),
  ]) {
    const a = join(root, 'wallet-web', rel);
    const b = join(root, 'dex', 'ui', rel);
    assert.ok(existsSync(a), `missing ${a}`);
    assert.ok(existsSync(b), `missing ${b}`);
    assert.equal(
      readFileSync(a, 'utf8'),
      readFileSync(b, 'utf8'),
      `${rel} differs between wallet-web and dex/ui — the component is shared; apply the change to both`,
    );
  }
});
