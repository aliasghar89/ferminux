// The Kubernetes rewards seeder (explorer/k8s/50-rewards-cronjob.yaml).
//
// The CronJob runs emission-ranges.sql, seed-rewards.sql and seed-signers.sh
// in one /bin/sh -c. A script's status is its last command's, and
// seed-signers.sh exits 0 on every path, so with it last a failing reward
// script left the Job marked Succeeded: no failed Job, nothing in
// `kubectl get jobs`, while the explorer published stale reward figures. Each
// psql status must reach the Job's exit code, and seed-signers.sh must still
// run when a reward script fails.
//
// The script is taken from the manifest itself and run under /bin/sh with
// psql and seed-signers.sh stubbed, so what is tested is what is deployed.
//
//   node --test explorer/scripts/k8s-seeder.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPLORER = join(dirname(fileURLToPath(import.meta.url)), '..');
const CRONJOB = join(EXPLORER, 'k8s', '50-rewards-cronjob.yaml');

// The literal block scalar that starts after lines[at] (a line ending in `|`),
// with its indentation removed and clip chomping applied, as YAML reads it.
function blockScalar(lines, at) {
  const out = [];
  let indent = -1;
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') { out.push(''); continue; }
    const n = line.length - line.trimStart().length;
    if (indent < 0) indent = n;
    if (n < indent) break;
    out.push(line.slice(indent));
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n') + '\n';
}

function cronJobScript() {
  const lines = readFileSync(CRONJOB, 'utf8').split('\n');
  assert.ok(lines.some((l) => /^\s*command: \["\/bin\/sh", "-c"\]\s*$/.test(l)), 'the container runs /bin/sh -c');
  const args = lines.findIndex((l) => /^\s*args:\s*$/.test(l));
  assert.ok(args >= 0 && /^\s*- \|\s*$/.test(lines[args + 1]), 'args is a single literal block');
  return blockScalar(lines, args + 1);
}

// Runs the manifest's script with /seeder pointed at a stub directory. `fail`
// names the .sql files whose psql run exits 3, as psql does on an SQL error
// under ON_ERROR_STOP=1.
function runJob(fail = []) {
  const dir = mkdtempSync(join(tmpdir(), 'k8s-seeder-'));
  try {
    const bin = join(dir, 'bin');
    const seeder = join(dir, 'seeder');
    const log = join(dir, 'calls.log');
    mkdirSync(bin);
    mkdirSync(seeder);
    writeFileSync(log, '');
    writeFileSync(join(bin, 'psql'), [
      '#!/bin/sh',
      'f=; prev=',
      'for a in "$@"; do [ "$prev" = -f ] && f=$a; prev=$a; done',
      'echo "psql $*" >> "$SEEDER_LOG"',
      'name=$(basename "$f" .sql)',
      'if [ -e "$SEEDER_STUB/fail-$name" ]; then echo "psql:$f:1: ERROR: stub" >&2; exit 3; fi',
      'exit 0',
      '',
    ].join('\n'));
    chmodSync(join(bin, 'psql'), 0o755);
    // The real seed-signers.sh exits 0 whatever happens (no backlog, psql
    // down, RPC down), which is exactly what made it unsafe as the last line.
    writeFileSync(join(seeder, 'seed-signers.sh'), 'echo seed-signers >> "$SEEDER_LOG"\nexit 0\n');
    for (const name of fail) writeFileSync(join(dir, `fail-${name}`), '');

    const script = cronJobScript().replaceAll('/seeder/', `${seeder}/`);
    const run = spawnSync('/bin/sh', ['-c', script], {
      encoding: 'utf8',
      env: { PATH: `${bin}:${process.env.PATH}`, SEEDER_LOG: log, SEEDER_STUB: dir },
    });
    const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
    return { status: run.status, stderr: run.stderr, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ORDER = [/^psql .*emission-ranges\.sql$/, /^psql .*seed-rewards\.sql$/, /^seed-signers$/];

function assertRanAll(calls) {
  assert.equal(calls.length, ORDER.length, `expected three steps, got: ${calls.join(' | ')}`);
  ORDER.forEach((re, i) => assert.match(calls[i], re));
}

test('a clean pass runs all three steps and succeeds', () => {
  const r = runJob();
  assert.equal(r.status, 0, r.stderr);
  assertRanAll(r.calls);
  // Without ON_ERROR_STOP=1 psql exits 0 after an SQL error, and no exit code
  // handling here could notice.
  for (const call of r.calls.filter((c) => c.startsWith('psql '))) {
    assert.match(call, /-v ON_ERROR_STOP=1 /, call);
  }
});

for (const failing of [['emission-ranges'], ['seed-rewards'], ['emission-ranges', 'seed-rewards']]) {
  test(`${failing.join(' + ')}.sql failing fails the Job, and signers are still attributed`, () => {
    const r = runJob(failing);
    assert.notEqual(r.status, 0, 'the Job must be marked Failed when a reward script fails');
    assertRanAll(r.calls);
    for (const name of failing) assert.match(r.stderr, new RegExp(`${name}\\.sql:1: ERROR`));
  });
}
