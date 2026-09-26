// The Content-Security-Policy the edge nginx sends for the wallet
// (infra/compose/nginx/nginx.conf, the $fxw_* maps) must let through every
// endpoint the wallet code talks to, and nothing loose: a new RPC or API host
// in src/ that is missing from connect-src would be blocked in production
// while every local test (Vite dev server, no CSP) still passes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CHAINS } from '../src/lib/chains.ts';
import { EXPLORER_URL, RPC_URLS, WALLET_CONNECT_URLS } from '../src/config.ts';
import { KNOWN_COLLECTIONS } from '../src/lib/nft.ts';

const NGINX = readFileSync(new URL('../../infra/compose/nginx/nginx.conf', import.meta.url), 'utf8');

/** The value of one `map <source> <var> { … }` entry. */
function mapValue(variable, key) {
  const block = new RegExp(`map \\$\\S+ \\$${variable} \\{([\\s\\S]*?)\\n    \\}`).exec(NGINX);
  assert.ok(block, `map $${variable} is in nginx.conf`);
  const line = new RegExp(`\\n\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+"([^"]*)";`).exec(block[1]);
  assert.ok(line, `map $${variable} has a ${key} entry`);
  return line[1];
}

function directives(csp) {
  const out = new Map();
  for (const part of csp.split(';').map((s) => s.trim()).filter(Boolean)) {
    const [name, ...values] = part.split(/\s+/);
    assert.ok(!out.has(name), `${name} appears once`);
    out.set(name, values);
  }
  return out;
}

const CSP = directives(mapValue('fxw_csp', 'default'));
const origin = (u) => new URL(u).origin;

test('connect-src holds every endpoint the wallet uses', () => {
  const allowed = new Set(CSP.get('connect-src'));
  const needed = new Set([
    ...RPC_URLS.map(origin),
    origin(EXPLORER_URL),
    ...CHAINS.flatMap((c) => c.rpcUrls.map(origin)),
    // FRC-721 tokenURI documents of the scanned collections (baseURI on chain: https://ferminux.net/nft/…)
    'https://ferminux.net',
    // WalletConnect (lazy chunk): relay socket and the Verify API it trusts
    'wss://relay.walletconnect.org',
    'https://verify.walletconnect.org',
    'https://verify.walletconnect.com',
  ]);
  assert.ok(KNOWN_COLLECTIONS.length > 0);
  const missing = [...needed].filter((h) => !allowed.has(h));
  assert.deepEqual(missing, [], `connect-src is missing ${missing.join(' ')}`);
  // Nothing open-ended, and WalletConnect telemetry stays out (useWalletConnect.ts skips its INIT post).
  for (const v of allowed) assert.ok(v === "'self'" || /^(https|wss):\/\/[a-z0-9.-]+$/.test(v), `connect-src entry ${v} is one exact host`);
  assert.ok(!allowed.has('https://pulse.walletconnect.org'));
});

test('scripts and styles come from the wallet itself only', () => {
  assert.deepEqual(CSP.get('default-src'), ["'none'"]);
  assert.deepEqual(CSP.get('script-src'), ["'self'"]);
  assert.deepEqual(CSP.get('style-src'), ["'self'"]);
  assert.deepEqual(CSP.get('font-src'), ["'self'"]);
  assert.deepEqual(CSP.get('object-src'), ["'none'"]);
  assert.deepEqual(CSP.get('base-uri'), ["'none'"]);
  assert.deepEqual(CSP.get('form-action'), ["'none'"]);
  assert.deepEqual(CSP.get('img-src'), ["'self'", 'data:', 'blob:', 'https:']);
  assert.deepEqual(CSP.get('frame-src'), ['https://verify.walletconnect.org', 'https://verify.walletconnect.com']);
  assert.ok(CSP.has('upgrade-insecure-requests'));
  assert.ok(!/unsafe-(inline|eval)|'strict-dynamic'/.test(mapValue('fxw_csp', 'default')));
});

test('only connect.html may be framed, and only by the wallet site', () => {
  assert.deepEqual(CSP.get('frame-ancestors'), ['$fxw_frame_ancestors']);
  assert.equal(mapValue('fxw_frame_ancestors', 'default'), "'none'");
  assert.equal(mapValue('fxw_frame_ancestors', '1'), 'https://ferminux.net https://*.ferminux.net');
  // "connect page" = a URI ending in connect.html, at either origin (/connect.html, /wallet/connect.html).
  assert.match(NGINX, /map \$uri \$fxw_connect_page \{\s*"~\(\^\|\/\)connect\\\.html\$"\s+1;\s*default\s+0;\s*\}/);
  // connect.html talks to its opener: no COOP (an empty value makes nginx send none), no X-Frame-Options.
  assert.equal(mapValue('fxw_coop', '1'), '');
  assert.equal(mapValue('fxw_coop', 'default'), 'same-origin-allow-popups');
  assert.equal(mapValue('fxw_xfo', '1'), '');
  assert.equal(mapValue('fxw_xfo', 'default'), 'DENY');
  // The connect pages at both origins are the ones config.ts opens.
  for (const u of WALLET_CONNECT_URLS) assert.match(new URL(u).pathname, /(^|\/)connect\.html$/);
});

test('the camera is allowed on the wallet page only (web QR scanner)', () => {
  assert.match(mapValue('fxw_permissions', 'default'), /(^|, )camera=\(self\)(,|$)/);
  assert.match(mapValue('fxw_permissions', '1'), /(^|, )camera=\(\)(,|$)/);
});

test('both wallet origins send the headers, in every location that sets its own', () => {
  const lines = [
    'add_header Content-Security-Policy $fxw_csp always;',
    'add_header Permissions-Policy $fxw_permissions always;',
    'add_header Cross-Origin-Opener-Policy $fxw_coop always;',
    'add_header X-Frame-Options $fxw_xfo always;',
    'add_header Referrer-Policy no-referrer always;',
  ];
  const walletServer = NGINX.slice(NGINX.indexOf('server_name wallet.ferminux.net;'));
  const walletBlock = walletServer.slice(0, walletServer.indexOf('\n    }\n'));
  const apex = NGINX.slice(NGINX.indexOf('location ^~ /wallet/ {'));
  const apexBlock = apex.slice(0, apex.indexOf('\n        }\n'));
  for (const l of lines) {
    // wallet.ferminux.net: server level + the static-asset location (its add_header replaces the server set)
    assert.equal(walletBlock.split(l).length - 1, 2, `wallet.ferminux.net: ${l}`);
    assert.equal(apexBlock.split(l).length - 1, 1, `ferminux.net/wallet/: ${l}`);
  }
});
