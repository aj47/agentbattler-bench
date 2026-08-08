import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadV7Pack, materializeV7Starter } from '../benchmark/challenges/mini-ledger-v7/pack.mjs';
import { captureTerminalCandidateTree } from '../src/terminal-candidate-tree.mjs';
import { MINI_LEDGER_V7_CANDIDATE_TREE_POLICY } from '../src/terminal-v7-runtime.mjs';
import { materializeTerminalV7Candidate } from '../src/terminal-v7-overlay.mjs';

test('V7 grading applies only the normalized candidate overlay to a fresh starter', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-v7-overlay-'));
  try {
    const pack = loadV7Pack('dev-01', { variant: 'decoy' });
    const baseline = path.join(root, 'baseline');
    const workspace = path.join(root, 'workspace');
    const runDirectory = path.join(root, 'run');
    await Promise.all([mkdir(baseline), mkdir(workspace), mkdir(runDirectory)]);
    await materializeV7Starter({ pack, destination: baseline });
    await materializeV7Starter({ pack, destination: workspace });
    await writeFile(path.join(workspace, 'src', 'candidate-only.mjs'), 'export const candidate = true;\n');
    await writeFile(path.join(workspace, 'tests', 'tamper.test.mjs'), 'throw new Error("ignored");\n').catch(async () => {
      await mkdir(path.join(workspace, 'tests'));
      await writeFile(path.join(workspace, 'tests', 'tamper.test.mjs'), 'throw new Error("ignored");\n');
    });
    await mkdir(path.join(workspace, 'var', 'live'), { recursive: true });
    await writeFile(path.join(workspace, 'var', 'live', 'state.json'), '{"candidateRuntime":true}\n');
    const candidateTree = await captureTerminalCandidateTree({ workspace, baseDirectory: baseline, runDirectory, turn: 1, policy: MINI_LEDGER_V7_CANDIDATE_TREE_POLICY });
    const graded = path.join(root, 'graded');
    const result = await materializeTerminalV7Candidate({ pack, candidateTree, runDirectory, destination: graded, baselineDirectory: baseline, policy: MINI_LEDGER_V7_CANDIDATE_TREE_POLICY });
    assert.ok(result.fullTree.files.some(({ path: file }) => file === 'src/candidate-only.mjs'));
    assert.equal(await readFile(path.join(graded, 'src', 'candidate-only.mjs'), 'utf8'), 'export const candidate = true;\n');
    await assert.rejects(readFile(path.join(graded, 'var', 'live', 'state.json')), /ENOENT/);
    await assert.rejects(readFile(path.join(graded, 'tests', 'tamper.test.mjs')), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
