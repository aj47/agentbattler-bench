import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createCandidateSubdirectory, withCandidateWorkspace } from '../benchmark/challenges/candidate-process.mjs';
import { validateIdempotencyRace, verifyPublicStage } from '../benchmark/challenges/mini-ledger-v4/public-verifier.mjs';
import { verifyHoldout } from '../benchmark/challenges/mini-ledger-v4/holdout-verifier.mjs';

test('verifier workspaces copy only the regular ledger source entry point', async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-source-'));
  const ledger = path.join(source, 'ledger.mjs');
  await writeFile(ledger, '#!/usr/bin/env node\n');
  await writeFile(path.join(source, 'ledger.json'), '{"stale":true}\n');
  await writeFile(path.join(source, 'ledger.json.snapshot'), '{"stale":true}\n');
  await withCandidateWorkspace(ledger, 'isolation-test', async ({ workspace, ledgerPath }) => {
    assert.deepEqual(await readdir(workspace), ['ledger.mjs']);
    assert.equal(await readFile(ledgerPath, 'utf8'), '#!/usr/bin/env node\n');
    const fresh = await createCandidateSubdirectory(workspace, 'fresh');
    await writeFile(path.join(fresh, 'candidate-write'), 'ok');
    assert.equal(await readFile(path.join(fresh, 'candidate-write'), 'utf8'), 'ok');
  });
});

test('verifier rejects a symlinked candidate entry point', async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-symlink-'));
  await writeFile(path.join(source, 'real.mjs'), '#!/usr/bin/env node\n');
  await import('node:fs/promises').then(({ symlink }) => symlink('real.mjs', path.join(source, 'ledger.mjs')));
  await assert.rejects(withCandidateWorkspace(path.join(source, 'ledger.mjs'), 'symlink-test', async () => {}), /regular source file/);
});

test('idempotency race accepts one commit with multiple successful retry responses', () => {
  assert.doesNotThrow(() => validateIdempotencyRace([
    { code: 0, signal: null, stdout: '{"idempotent":false}\n' },
    { code: 0, signal: null, stdout: '{"idempotent":true}\n' },
    { code: 0, signal: null, stdout: '{"idempotent":true}\n' },
    { code: 1, signal: null, stdout: '' },
  ]));
  assert.throws(() => validateIdempotencyRace([{ code: 1, signal: null, stdout: '' }]), /no successful caller/);
  assert.throws(() => validateIdempotencyRace([{ code: 0, signal: null, stdout: 'not-json' }]), /one JSON value/);
  assert.throws(() => validateIdempotencyRace([
    { code: 0, signal: null, stdout: '{"events":[]}\n' },
    { code: 0, signal: null, stdout: '{"events":[]}\n' },
  ]), /did not identify themselves as retries/);
});

test('reference candidate passes every independent visible stage and holdout case', { timeout: 240_000 }, async () => {
  const fixture = path.resolve(import.meta.dirname, 'fixtures', 'mini-ledger-reference.mjs');
  const source = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-reference-'));
  const ledger = path.join(source, 'ledger.mjs');
  await import('node:fs/promises').then(({ copyFile }) => copyFile(fixture, ledger));
  const stages = ['foundation', 'batch', 'pagination', 'migration', 'atomicity', 'recovery', 'concurrency', 'compaction', 'roundtrip', 'replay', 'audit', 'scale', 'stress-concurrency', 'validation', 'scale-stress'];
  const results = [];
  for (const stageId of stages) results.push(await verifyPublicStage({ workspace: source, ledgerPath: ledger, stageId }));
  assert.deepEqual(results.filter((result) => !result.passed), []);
  const holdout = await verifyHoldout({ workspace: source });
  assert.equal(holdout.total, 11);
  assert.deepEqual(holdout.cases.filter((result) => !result.passed), []);
});
