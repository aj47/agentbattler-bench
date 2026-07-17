import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const NODE = process.execPath;
const CLI = path.join(ROOT, 'bin/agentbattler.mjs');
const output = (name) => `results/checkpoint-test-${name}`;
const invoke = (args) => spawnSync(NODE, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, AGENTBATTLER_CONCURRENCY: '6' } });
const fixtureArgs = (name) => ['run', '--manifest', 'agents/manifest.json', '--positions', 'benchmark/positions/v1.json', '--pairing', 'reference', '--output', output(name), '--fresh'];

test('checkpointed fixture replay is deterministic and fingerprint mismatches fail closed', async () => {
  const name = 'fingerprint'; await rm(path.join(ROOT, output(name)), { recursive: true, force: true }); await rm(path.join(ROOT, `${output(name)}.checkpoints`), { recursive: true, force: true });
  assert.equal(invoke(fixtureArgs(name)).status, 0);
  const first = await readFile(path.join(ROOT, output(name), 'result.json'), 'utf8');
  assert.equal(invoke(['replay', `${output(name)}/result.json`]).status, 0);
  const mismatch = invoke(['run', '--manifest', 'agents/manifest.json', '--positions', 'benchmark/positions/v2.json', '--pairing', 'reference', '--output', output(name), '--resume']);
  assert.notEqual(mismatch.status, 0); assert.match(mismatch.stderr, /Checkpoint inputs\/config/);
  assert.equal(await readFile(path.join(ROOT, output(name), 'result.json'), 'utf8'), first);
});

test('corrupt and stale checkpoint records fail closed', async () => {
  const name = 'corrupt'; await rm(path.join(ROOT, output(name)), { recursive: true, force: true }); await rm(path.join(ROOT, `${output(name)}.checkpoints`), { recursive: true, force: true });
  assert.equal(invoke(fixtureArgs(name)).status, 0);
  const games = path.join(ROOT, `${output(name)}.checkpoints`, 'games');
  const [entry] = (await (await import('node:fs/promises')).readdir(games));
  await writeFile(path.join(games, entry), '{bad');
  await rm(path.join(ROOT, output(name), 'result.json'));
  const corrupt = invoke(['run', '--manifest', 'agents/manifest.json', '--positions', 'benchmark/positions/v1.json', '--pairing', 'reference', '--output', output(name), '--resume']);
  assert.notEqual(corrupt.status, 0);
  await writeFile(path.join(games, 'stale.tmp'), 'partial');
  const stale = invoke(['run', '--manifest', 'agents/manifest.json', '--positions', 'benchmark/positions/v1.json', '--pairing', 'reference', '--output', output(name), '--resume']);
  assert.notEqual(stale.status, 0);
});
