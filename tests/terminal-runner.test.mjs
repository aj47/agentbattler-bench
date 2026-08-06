import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createExhaustiveTerminalSchedule, createMiniLedgerChallenge } from '../src/terminal-challenge.mjs';
import { orderTerminalJobsBreadthFirst, runTerminalSchedule, terminalRunPath } from '../src/terminal-runner.mjs';

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

test('terminal runner rejects trace-isolation violations without retrying them as infrastructure', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'terminal-runner-protocol-invalid-'));
  const s = createExhaustiveTerminalSchedule({ challenge, agents: [agent('codex-cli', 'terra', 1)], expectedHarnesses: ['codex-cli'], expectedModels: ['terra'], generationsPerCombo: 1 });
  let calls = 0;
  const violation = new Error('attempted to inspect sealed verifier source');
  violation.code = 'TRACE_ISOLATION_VIOLATION';
  violation.evidence = { schemaVersion: 'agentbattler.terminal-trace-isolation.v1', turn: 1, passed: false, violations: [{ tool: 'Read', marker: 'public-verifier.mjs' }] };
  await runTerminalSchedule({ challenge, schedule: s, resultRoot: root, challengeRoot: root, runTerminalJob: async () => { calls += 1; throw violation; } });
  const retry = await runTerminalSchedule({ challenge, schedule: s, resultRoot: root, challengeRoot: root, retryInvalid: true, runTerminalJob: async ({ job }) => { calls += 1; return completed(job); } });
  const saved = JSON.parse(await readFile(terminalRunPath(root, s.jobs[0].runKey), 'utf8'));
  assert.equal(saved.status, 'protocol-invalid');
  assert.equal(saved.validity, 'protocol-invalid');
  assert.equal(saved.stopReason, 'trace_isolation_violation');
  assert.deepEqual(saved.protocolViolation, violation.evidence);
  assert.equal(retry.skipped, 1);
  assert.equal(calls, 1);
});

test('terminal retries archive the failed workspace and start from an empty attempt', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'terminal-runner-attempts-'));
  const s = createExhaustiveTerminalSchedule({ challenge, agents: [agent('codex-cli', 'terra', 1)], expectedHarnesses: ['codex-cli'], expectedModels: ['terra'], generationsPerCombo: 1 });
  await runTerminalSchedule({
    challenge, schedule: s, resultRoot: root, challengeRoot: root,
    runTerminalJob: async ({ runDirectory }) => {
      await writeFile(path.join(runDirectory, 'stale-runtime-state'), 'must not survive');
      throw new Error('transient infrastructure failure');
    },
  });
  const result = await runTerminalSchedule({
    challenge, schedule: s, resultRoot: root, challengeRoot: root, retryInvalid: true,
    runTerminalJob: async ({ job, runDirectory }) => {
      await assert.rejects(access(path.join(runDirectory, 'stale-runtime-state')), /ENOENT/);
      await writeFile(path.join(runDirectory, 'accepted-attempt'), 'ok');
      return completed(job);
    },
  });
  assert.equal(result.completed, 1);
  assert.equal((await readdir(path.join(root, 'attempts', s.jobs[0].runKey))).length, 2);
  assert.equal((await readdir(path.join(root, 'work-attempts', s.jobs[0].runKey))).length, 1);
  assert.equal(await readFile(path.join(root, 'work', s.jobs[0].runKey, 'accepted-attempt'), 'utf8'), 'ok');
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

test('terminal runner can select one model and generation for calibration', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'terminal-runner-selection-'));
  const calibrationSchedule = createExhaustiveTerminalSchedule({
    challenge,
    agents: [agent('codex-cli', 'terra', 1), agent('codex-cli', 'terra', 2), agent('codex-cli', 'sol', 1), agent('codex-cli', 'sol', 2)],
    expectedHarnesses: ['codex-cli'], expectedModels: ['terra', 'sol'], generationsPerCombo: 2,
  });
  const result = await runTerminalSchedule({
    challenge, schedule: calibrationSchedule, resultRoot: root, challengeRoot: root,
    onlyModels: ['sol'], onlyGenerationIndices: [1],
    runTerminalJob: async ({ job }) => completed(job),
  });
  assert.equal(result.expected, 1);
  assert.equal(result.completed, 1);
});

test('terminal runner gives every combo first coverage before later generations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'terminal-runner-breadth-'));
  const breadthSchedule = createExhaustiveTerminalSchedule({
    challenge,
    agents: [agent('codex-cli', 'terra', 1), agent('codex-cli', 'terra', 2), agent('codex-cli', 'sol', 1), agent('codex-cli', 'sol', 2)],
    expectedHarnesses: ['codex-cli'], expectedModels: ['terra', 'sol'], generationsPerCombo: 2,
  });
  const calls = [];
  await runTerminalSchedule({
    challenge, schedule: breadthSchedule, resultRoot: root, challengeRoot: root,
    runTerminalJob: async ({ job }) => { calls.push({ comboId: job.comboId, generationIndex: job.generationIndex }); return completed(job); },
  });
  assert.deepEqual(calls.map((job) => job.generationIndex), [1, 1, 2, 2]);
  assert.equal(new Set(calls.slice(0, 2).map((job) => job.comboId)).size, 2);
  assert.deepEqual(orderTerminalJobsBreadthFirst([...breadthSchedule.jobs].reverse(), breadthSchedule.coverage).map((job) => job.generationIndex), [1, 1, 2, 2]);
});
