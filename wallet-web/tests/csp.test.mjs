// The Content-Security-Policy and the other response headers the edge nginx
// sends for the wallet (deploy/csp.conf, the $fxw_* maps, and
// deploy/security-headers.inc, the add_header lines) must let through every
// endpoint the wallet code talks to, and nothing loose: a new RPC or API host
// in src/ that is missing from connect-src would be blocked in production
// while every local test (Vite dev server, no CSP) still passes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAINS } from '../src/lib/chains.ts';
import { EXPLORER_URL, PAYIN_API_URL, RPC_URLS, WALLET_CONNECT_URLS } from '../src/config.ts';
import { KNOWN_COLLECTIONS } from '../src/lib/nft.ts';

// Committed with the wallet; the edge nginx includes both (README, "Deploy").
// Before these files existed the checks ran against a config outside this
// repository and were skipped in every checkout, CI included.
const MAPS_PATH = fileURLToPath(new URL('../deploy/csp.conf', import.meta.url));
const HEADERS_PATH = fileURLToPath(new URL('../deploy/security-headers.inc', import.meta.url));
const NGINX = readFileSync(MAPS_PATH, 'utf8');
const HEADERS = readFileSync(HEADERS_PATH, 'utf8');

/** The value of one `map <source> <var> { … }` entry. */
function mapValue(variable, key) {
  const block = new RegExp(`map \\$\\S+ \\$${variable} \\{([\\s\\S]*?)\\n\\s*\\}`).exec(NGINX);
  assert.ok(block, `map $${variable} is in deploy/csp.conf`);
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
    // the pay-in (Swap → Other networks: buy FMX with USDT/USDC/native coins), on that same host
    origin(PAYIN_API_URL),
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

test('the header include sends every header, each once, from the maps', () => {
  const lines = [
    'add_header Content-Security-Policy $fxw_csp always;',
    'add_header Permissions-Policy $fxw_permissions always;',
    'add_header Cross-Origin-Opener-Policy $fxw_coop always;',
    'add_header X-Frame-Options $fxw_xfo always;',
    'add_header Referrer-Policy no-referrer always;',
    'add_header X-Content-Type-Options nosniff always;',
    'add_header Strict-Transport-Security "max-age=31536000" always;',
  ];
  const directives = HEADERS.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  assert.deepEqual([...directives].sort(), [...lines].sort());
  // Every variable the include reads is one the maps define.
  for (const v of HEADERS.matchAll(/\$(fxw_\w+)/g)) assert.match(NGINX, new RegExp(`map \\$\\S+ \\$${v[1]} \\{`), `$${v[1]} is defined`);
});

// The same files, served: an nginx on this machine loads them exactly as the
// edge does (maps in http {}, the include in a server and in a location that
// sets its own add_header) and the headers on the wire are the ones above.
const NGINX_BIN = spawnSync('nginx', ['-v'], { encoding: 'utf8' }).error ? null : 'nginx';

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

test('nginx serves those headers at both origins, and connect.html gets its own', { skip: NGINX_BIN === null && 'nginx is not installed here' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fxw-csp-'));
  chmodSync(dir, 0o755); // run as root, nginx serves files as an unprivileged worker
  const port = await freePort();
  mkdirSync(join(dir, 'root', 'wallet'), { recursive: true });
  mkdirSync(join(dir, 'tmp'));
  for (const f of ['index.html', 'connect.html']) {
    writeFileSync(join(dir, 'root', f), 'ok');
    writeFileSync(join(dir, 'root', 'wallet', f), 'ok');
  }
  const temp = ['client_body', 'proxy', 'fastcgi', 'uwsgi', 'scgi'].map((k) => `${k}_temp_path ${join(dir, 'tmp')};`).join(' ');
  writeFileSync(
    join(dir, 'nginx.conf'),
    `daemon off; pid ${join(dir, 'nginx.pid')}; error_log ${join(dir, 'error.log')};
events {}
http {
  access_log off; ${temp}
  include ${MAPS_PATH};
  server {
    listen 127.0.0.1:${port};
    root ${join(dir, 'root')};
    include ${HEADERS_PATH};
    location ^~ /wallet/ {
      include ${HEADERS_PATH};
      add_header Cache-Control no-cache always;
    }
  }
}
`,
  );
  const proc = spawn(NGINX_BIN, ['-p', dir, '-e', join(dir, 'error.log'), '-c', join(dir, 'nginx.conf')], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (c) => (stderr += c));
  try {
    const get = async (path) => {
      for (let i = 0; i < 50; i++) {
        let res;
        try {
          res = await fetch(`http://127.0.0.1:${port}${path}`);
        } catch {
          if (proc.exitCode !== null) assert.fail(`nginx exited: ${stderr}`);
          await new Promise((r) => setTimeout(r, 100));
          continue;
        }
        assert.equal(res.status, 200, path);
        return res.headers;
      }
      assert.fail(`nginx did not answer: ${stderr}`);
    };
    for (const prefix of ['', '/wallet']) {
      const page = await get(`${prefix}/index.html`);
      assert.equal(page.get('content-security-policy'), mapValue('fxw_csp', 'default').replace('$fxw_frame_ancestors', "'none'"));
      assert.equal(page.get('x-frame-options'), 'DENY');
      assert.equal(page.get('cross-origin-opener-policy'), 'same-origin-allow-popups');
      assert.match(page.get('permissions-policy'), /camera=\(self\)/);
      assert.equal(page.get('referrer-policy'), 'no-referrer');
      assert.equal(page.get('x-content-type-options'), 'nosniff');

      const connect = await get(`${prefix}/connect.html`);
      assert.match(connect.get('content-security-policy'), /frame-ancestors https:\/\/ferminux\.net https:\/\/\*\.ferminux\.net;/);
      assert.equal(connect.get('x-frame-options'), null, 'no X-Frame-Options on the connect page');
      assert.equal(connect.get('cross-origin-opener-policy'), null, 'no COOP on the connect page: it answers window.opener');
      assert.match(connect.get('permissions-policy'), /camera=\(\)/);
    }
  } finally {
    proc.kill('SIGTERM');
    await new Promise((r) => (proc.exitCode !== null ? r() : proc.once('exit', r)));
    rmSync(dir, { recursive: true, force: true });
  }
});
