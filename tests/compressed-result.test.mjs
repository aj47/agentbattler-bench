import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CLI = path.join(ROOT, 'bin/agentbattler.mjs');
const output = 'results/compressed-result-test';
const invoke = (args) => spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, AGENTBATTLER_CONCURRENCY: '6' } });

test('deterministic gzip preserves the canonical bundle and replay works without result.json', async (t) => {
  t.after(async () => {
    await rm(path.join(ROOT, output), { recursive: true, force: true });
    await rm(path.join(ROOT, `${output}.checkpoints`), { recursive: true, force: true });
  });
  assert.equal(invoke(['run', '--manifest', 'agents/manifest.json', '--positions', 'benchmark/positions/v1.json', '--pairing', 'reference', '--output', output, '--fresh']).status, 0);
  const resultPath = path.join(ROOT, output, 'result.json');
  const canonical = await readFile(resultPath);
  assert.equal(invoke(['pack', `${output}/result.json`]).status, 0);
  const firstGzip = await readFile(`${resultPath}.gz`);
  assert.equal(invoke(['pack', `${output}/result.json`]).status, 0);
  assert.deepEqual(await readFile(`${resultPath}.gz`), firstGzip);
  assert.deepEqual(gunzipSync(firstGzip), canonical);
  await rm(resultPath);
  assert.equal(invoke(['replay', `${output}/result.json.gz`]).status, 0);
});
