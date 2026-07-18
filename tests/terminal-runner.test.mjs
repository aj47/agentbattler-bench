import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createExhaustiveTerminalSchedule, createMiniLedgerChallenge } from '../src/terminal-challenge.mjs';
import { runTerminalSchedule, terminalRunPath } from '../src/terminal-runner.mjs';

const challenge = createMiniLedgerChallenge({ promptSha256: 'p'.repeat(64), publicVerifierSha256: 'u'.repeat(64), holdoutVerifierSha256: 'h'.repeat(64) });
function agent(harness, model, generationIndex) {
  return { id: `${harness}-${model}-${generationIndex}`, generationIndex, provenance: { harness, harnessVersion: 'test', modelRequested: model, modelFamilyId: model, reasoningEffort: 'high' } };
}
function schedule() {
  return createExhaustiveTerminalSchedule({ challenge, agents: [agent('codex-cli', 'terra', 1), agent('pi-coding-agent', 'terra', 1)], expectedHarnesses: ['codex-cli', 'pi-coding-agent'], expectedModels: ['terra'], generationsPerCombo: 1 });
}
function completed(job) {
  return { schemaVersion: 'agentbattler.terminal-run.v1', ...job, status: 'completed', stages: challenge.stages.map((stage) => ({ id: stage.id, passed: true, regressions: 0 })), holdout: { passed: 5, total: 5 } };
}

test('terminal runner persists exact identities and resumes completed jobs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'terminal-runner-'));
  const s = schedule(); let calls = 0;
  const first = await runTerminalSchedule({ challenge, schedule: s, resultRoot: root, challengeRoot: root, runTerminalJob: async ({ job }) => { calls += 1; return completed(job); } });
  assert.equal(calls, 2); assert.equal(first.completed, 2);
  const second = await runTerminalSchedule({ challenge, schedule: s, resultRoot: root, challengeRoot: root, runTerminalJob: async () => { calls += 1; throw new Error('must not run'); } });
  assert.equal(second.skipped, 2); assert.equal(calls, 2);
  const saved = JSON.parse(await readFile(terminalRunPath(root, s.jobs[0].runKey), 'utf8'));
  assert.equal(saved.runKey, s.jobs[0].runKey); assert.equal(saved.status, 'completed');
});

test('terminal runner records infrastructure-invalid and retries it explicitly', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'terminal-runner-invalid-'));
  const s = schedule(); let calls = 0;
  const first = await runTerminalSchedule({ challenge, schedule: s, resultRoot: root, challengeRoot: root, runTerminalJob: async () => { calls += 1; throw new Error('adapter unavailable'); } });
  assert.equal(first.invalid, 2);
  const second = await runTerminalSchedule({ challenge, schedule: s, resultRoot: root, challengeRoot: root, runTerminalJob: async ({ job }) => { calls += 1; return completed(job); }, retryInvalid: true });
  assert.equal(second.completed, 2); assert.equal(calls, 4);
});

test('terminal runner bounds independent job concurrency without parallelizing turns', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'terminal-runner-concurrency-'));
  const s = schedule(); let active = 0; let peak = 0;
  const result = await runTerminalSchedule({
    challenge, schedule: s, resultRoot: root, challengeRoot: root, concurrency: 2,
    runTerminalJob: async ({ job }) => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return completed(job);
    },
  });
  assert.equal(result.completed, 2);
  assert.equal(peak, 2);
});
