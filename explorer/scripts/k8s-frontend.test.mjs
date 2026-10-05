// The Kubernetes frontend config against the compose one.
//
// explorer/k8s/40-frontend.yaml loads every frontend variable from the
// explorer-frontend-env ConfigMap (15-configmaps.yaml), a hand-kept copy of
// explorer/envs/frontend.env plus the public origin. Nothing kept the two
// equal, and the copy fell behind: compose moved to
// NEXT_PUBLIC_NETWORK_VERIFICATION_TYPE=validation while k8s kept "mining",
// which is what makes Blockscout label every block "Mined by" its "Miner".
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
