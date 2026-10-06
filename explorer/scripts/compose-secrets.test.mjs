// The explorer stack's secrets have no committed value.
//
// docker-compose.yml used to fall back to a fixed POSTGRES_PASSWORD and
// SECRET_KEY_BASE when .env did not set them, so every stack started without
// an .env ran on a password published in this repository. Each use must now
// be ${VAR:?...} (compose refuses to interpolate it unset or empty), in every
// compose file under explorer/, and .env.example must not supply a value.
//
//   node --test explorer/scripts/compose-secrets.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPLORER = join(dirname(fileURLToPath(import.meta.url)), '..');
const SECRETS = ['POSTGRES_PASSWORD', 'SECRET_KEY_BASE'];

function composeFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...composeFiles(path));
    else if (/^(docker-)?compose(\..+)?\.ya?ml$/.test(entry.name)) out.push(path);
  }
  return out;
}

test('every compose file interpolates the secrets as required, never with a default', () => {
  const files = composeFiles(EXPLORER);
  assert.ok(files.some((f) => f.endsWith(`${join('explorer', 'docker-compose.yml')}`)), 'docker-compose.yml is found');
  let uses = 0;
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const name of SECRETS) {
      for (const m of text.matchAll(new RegExp(`\\$\\{${name}([^}]*)\\}`, 'g'))) {
        uses++;
        assert.match(m[1], /^:\?\S/, `${relative(EXPLORER, file)}: ${m[0]} must be \${${name}:?message}, with no default`);
      }
      // A bare $NAME would interpolate to an empty string without complaint.
      assert.doesNotMatch(text, new RegExp(`\\$${name}\\b`), `${relative(EXPLORER, file)}: bare $${name}`);
    }
  }
  // db, backend (DATABASE_URL + SECRET_KEY_BASE) and the rewards sidecar.
  assert.ok(uses >= 4, `expected at least 4 uses of the secrets, found ${uses}`);
});

test('.env.example names the secrets but gives them no value', () => {
  const lines = readFileSync(join(EXPLORER, '.env.example'), 'utf8').split('\n');
  for (const name of SECRETS) {
    const set = lines.filter((l) => new RegExp(`^\\s*${name}\\s*=`).test(l));
    assert.deepEqual(set.map((l) => l.trim()), [`${name}=`], `${name} is listed once, empty`);
  }
});

test('docker compose refuses to render the stack from .env.example alone', (t) => {
  const probe = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    t.skip('docker compose is not installed here');
    return;
  }
  const env = { ...process.env };
  for (const name of SECRETS) delete env[name];
  const run = (envFile, extra = {}) =>
    spawnSync('docker', ['compose', '--env-file', envFile, 'config', '--quiet'], {
      cwd: EXPLORER,
      env: { ...env, ...extra },
      encoding: 'utf8',
    });

  const refused = run('.env.example');
  assert.notEqual(refused.status, 0, 'compose must not start without the secrets');
  assert.match(refused.stderr, /set (POSTGRES_PASSWORD|SECRET_KEY_BASE) in \.env/);

  const ok = run('.env.example', { POSTGRES_PASSWORD: 'a'.repeat(48), SECRET_KEY_BASE: 'b'.repeat(64) });
  assert.equal(ok.status, 0, ok.stderr);
});
