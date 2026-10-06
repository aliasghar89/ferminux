// The Kubernetes frontend config against the compose one.
//
// explorer/k8s/40-frontend.yaml loads every frontend variable from the
// explorer-frontend-env ConfigMap (15-configmaps.yaml), a hand-kept copy of
// explorer/envs/frontend.env plus the public origin. Nothing kept the two
// equal, and the copy fell behind twice: compose moved to
// NEXT_PUBLIC_NETWORK_VERIFICATION_TYPE=validation while k8s kept "mining",
// which is what makes Blockscout label every block "Mined by" its "Miner";
// and compose turned the gas tracker off while k8s kept showing its 0.01 gwei
// figure, a tip no signer includes. Every key frontend.env sets must now be in
// the ConfigMap too, with the same value.
//
//   node --test explorer/scripts/k8s-frontend.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPLORER = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIGMAPS = join(EXPLORER, 'k8s', '15-configmaps.yaml');
const FRONTEND_ENV = join(EXPLORER, 'envs', 'frontend.env');

function setOnce(map, key, value, where) {
  assert.ok(!map.has(key), `${where}: ${key} is set twice`);
  map.set(key, value);
}

// key -> value of the explorer-frontend-env ConfigMap, as Kubernetes reads it.
// Only the scalar forms the file uses: "double", 'single' and plain.
function k8sFrontendEnv() {
  const docs = readFileSync(CONFIGMAPS, 'utf8').split(/^---$/m);
  const doc = docs.filter((d) => /^  name: explorer-frontend-env$/m.test(d));
  assert.equal(doc.length, 1, 'one explorer-frontend-env ConfigMap');
  const lines = doc[0].split('\n');
  const data = lines.indexOf('data:');
  assert.ok(data >= 0, 'the ConfigMap has data');
  const env = new Map();
  for (const line of lines.slice(data + 1)) {
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const m = /^  ([A-Z0-9_]+): (.*)$/.exec(line);
    assert.ok(m, `unexpected line in explorer-frontend-env: ${line}`);
    let value = m[2];
    if (value.startsWith('"')) value = JSON.parse(value);
    else if (value.startsWith("'")) {
      assert.match(value, /^'.*'$/, `${m[1]}: unterminated single-quoted value`);
      value = value.slice(1, -1).replaceAll("''", "'");
    } else value = value.replace(/\s+#.*$/, '').trim();
    setOnce(env, m[1], value, 'explorer-frontend-env');
  }
  return env;
}

// key -> value of envs/frontend.env, as compose's env_file reads it.
function composeFrontendEnv() {
  const env = new Map();
  for (const line of readFileSync(FRONTEND_ENV, 'utf8').split('\n')) {
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    assert.ok(m, `unexpected line in envs/frontend.env: ${line}`);
    const quoted = /^(["'])(.*)\1$/.exec(m[2]);
    setOnce(env, m[1], quoted ? quoted[2] : m[2].replace(/\s+#.*$/, '').trim(), 'envs/frontend.env');
  }
  return env;
}

// AGENTS.md, Terminology: blocks are confirmed by signers, never mined. In the
// Blockscout frontend this value picks the block-producer labels: "mining"
// gives "Miner" and "Mined by", "validation" gives "Validator" and
// "Validated by".
test('both deployments label the block producer as a validator, never a miner', () => {
  for (const [where, env] of [['k8s explorer-frontend-env', k8sFrontendEnv()], ['envs/frontend.env', composeFrontendEnv()]]) {
    assert.equal(env.get('NEXT_PUBLIC_NETWORK_VERIFICATION_TYPE'), 'validation', where);
  }
});

// envs/frontend.env has the full reason: with so few transactions Blockscout's
// oracle falls back to 0.01 gwei, and signers only include a tip of at least
// 1 gwei, so a user who copies the tracker's number sends a transaction that
// stays pending for ever.
test('both deployments keep the gas tracker off', () => {
  for (const [where, env] of [['k8s explorer-frontend-env', k8sFrontendEnv()], ['envs/frontend.env', composeFrontendEnv()]]) {
    assert.equal(env.get('NEXT_PUBLIC_GAS_TRACKER_ENABLED'), 'false', where);
  }
});

// The public origin and the favicon master are compose `environment:` entries,
// not frontend.env, so they are outside this comparison.
test('every key the k8s ConfigMap shares with envs/frontend.env has the same value', () => {
  const k8s = k8sFrontendEnv();
  const compose = composeFrontendEnv();
  const shared = [...compose.keys()].filter((key) => k8s.has(key));
  // Guards the parsers: an empty intersection would pass vacuously.
  for (const key of ['NEXT_PUBLIC_NETWORK_ID', 'NEXT_PUBLIC_NETWORK_VERIFICATION_TYPE', 'NEXT_PUBLIC_GAS_TRACKER_ENABLED', 'NEXT_PUBLIC_HOMEPAGE_HERO_BANNER_CONFIG']) {
    assert.ok(shared.includes(key), `${key} is set in both files`);
  }
  const differ = shared
    .filter((key) => k8s.get(key) !== compose.get(key))
    .map((key) => `${key}: k8s ${JSON.stringify(k8s.get(key))}, compose ${JSON.stringify(compose.get(key))}`);
  assert.deepEqual(differ, []);
});

// The value check above only sees keys both files have. A key that never
// reached the ConfigMap is the same drift, and for these keys Blockscout's
// default is what frontend.env sets them to avoid: third-party ad providers,
// a POST to bigs.services.blockscout.com for the social preview, "| Blockscout"
// in every title. The ConfigMap may set more (the origin, the RPC URL and
// FAVICON_MASTER_URL, which compose sets under `environment:`), never less.
test('every key envs/frontend.env sets is also set in the k8s ConfigMap', () => {
  const k8s = k8sFrontendEnv();
  const missing = [...composeFrontendEnv().keys()].filter((key) => !k8s.has(key));
  assert.deepEqual(missing, []);
});
