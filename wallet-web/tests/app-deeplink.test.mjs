// Deep links the Ferminux Wallet app (and the web wallet's /wc page) accept:
// src/platform/deeplink.ts, the code the Android intent / iOS URL handler runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDeepLink, createDeduper, APP_SCHEME } from '../src/platform/deeplink.ts';
import { PROTECTED_KEYS, vaultMirror, isNativeApp, parseDeepLink as reexported } from '../src/platform/index.ts';

const TOPIC = 'a'.repeat(64);
const KEY = 'b'.repeat(64);
const PAIR = `wc:${TOPIC}@2?relay-protocol=irn&symKey=${KEY}&expiryTimestamp=9999999999`;

test('a bare wc: pairing code pairs', () => {
  assert.deepEqual(parseDeepLink(PAIR), { kind: 'wc-pair', uri: PAIR });
  assert.deepEqual(parseDeepLink(`  ${PAIR}\n`), { kind: 'wc-pair', uri: PAIR });
});

test('a wc: link without a key is a "bring the wallet forward" request link', () => {
  assert.deepEqual(parseDeepLink(`wc:${TOPIC}@2`), { kind: 'wc-request', requestId: null, sessionTopic: TOPIC });
  assert.deepEqual(parseDeepLink(`wc:${TOPIC}@2?requestId=17`), { kind: 'wc-request', requestId: '17', sessionTopic: TOPIC });
});

test('the app scheme and the app links carry the code in uri=, encoded once or twice', () => {
  const once = encodeURIComponent(PAIR);
  const twice = encodeURIComponent(once);
  for (const link of [
    `${APP_SCHEME}://wc?uri=${once}`,
    `${APP_SCHEME}://wc?uri=${twice}`,
    `https://wallet.ferminux.net/wc?uri=${once}`,
    `https://wallet.ferminux.net/wc/?uri=${twice}`,
    `https://ferminux.net/wallet/wc?uri=${once}`,
  ]) {
    assert.deepEqual(parseDeepLink(link), { kind: 'wc-pair', uri: PAIR }, link);
  }
});

test('request links from a dApp (requestId / sessionTopic) do not pair', () => {
  assert.deepEqual(parseDeepLink(`${APP_SCHEME}://wc?requestId=42&sessionTopic=${TOPIC}`), {
    kind: 'wc-request',
    requestId: '42',
    sessionTopic: TOPIC,
  });
  assert.deepEqual(parseDeepLink(`https://wallet.ferminux.net/wc?requestId=42`), { kind: 'wc-request', requestId: '42', sessionTopic: null });
});

test('the wallet link with nothing in it just opens the app', () => {
  assert.deepEqual(parseDeepLink(`${APP_SCHEME}://`), { kind: 'open' });
  assert.deepEqual(parseDeepLink(`${APP_SCHEME}://wc`), { kind: 'open' });
  assert.deepEqual(parseDeepLink('https://wallet.ferminux.net/wc'), { kind: 'open' });
});

test('anything else is ignored', () => {
  for (const link of [
    null,
    '',
    'hello',
    'https://evil.example/wc?uri=' + encodeURIComponent(PAIR), // not our host
    'http://wallet.ferminux.net/wc?uri=' + encodeURIComponent(PAIR), // app links are https only
    'https://wallet.ferminux.net/send?uri=' + encodeURIComponent(PAIR), // not the /wc path
    `${APP_SCHEME}://settings`,
    'wc:notatopic',
    'x'.repeat(5000),
  ]) {
    assert.equal(parseDeepLink(link), null, String(link).slice(0, 60));
  }
});

test('a staging origin can be allowed explicitly (the web wallet on localhost)', () => {
  const link = `http://localhost:5173/wc?uri=${encodeURIComponent(PAIR)}`;
  assert.equal(parseDeepLink(link), null);
  assert.deepEqual(parseDeepLink(link, ['localhost:5173']), { kind: 'wc-pair', uri: PAIR });
});

test('the same link delivered twice (launch intent + appUrlOpen) is handled once', () => {
  let t = 0;
  const fresh = createDeduper(5000, () => t);
  const link = { kind: 'wc-pair', uri: PAIR };
  assert.equal(fresh(link), true);
  assert.equal(fresh({ ...link }), false);
  t = 6000;
  assert.equal(fresh(link), true);
});

test('platform bridge is inert under Node / on the web: the vault stays in localStorage', () => {
  assert.equal(isNativeApp(), false);
  assert.equal(reexported, parseDeepLink);
  assert.ok(PROTECTED_KEYS.includes('ferminux.wallet.vault.v2'));
  for (const key of PROTECTED_KEYS) assert.equal(vaultMirror.handles(key), false);
});
