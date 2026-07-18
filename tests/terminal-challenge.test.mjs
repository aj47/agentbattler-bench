import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compareTerminalScores,
  computeTerminalElo,
  createExhaustiveTerminalSchedule,
  createMiniLedgerChallenge,
  scoreTerminalRun,
  terminalComboForAgent,
  validateTerminalChallenge,
  validateTerminalSchedule,
} from '../src/terminal-challenge.mjs';

const HASH = 'a'.repeat(64);
const challenge = createMiniLedgerChallenge({ promptSha256: HASH, publicVerifierSha256: 'b'.repeat(64), holdoutVerifierSha256: 'c'.repeat(64) });

function agent(harness, model, index) {
  return {
    id: `${harness}-${model}-${index}`,
    generationIndex: index,
    provenance: {
      harness,
      harnessVersion: '1.0.0',
      modelRequested: `gpt-${model}`,
      modelFamilyId: model,
      reasoningEffort: 'high',
      generationIndex: index,
    },
  };
}

test('mini-ledger challenge is sealed and validates', () => {
  assert.equal(validateTerminalChallenge(challenge), challenge);
  assert.equal(challenge.stages.length, 8);
  assert.equal(challenge.scoring.maxPoints, 100);
});

test('challenge validation accepts the corrected v2 challenge identity', () => {
  const v2 = createMiniLedgerChallenge({ challengeId: 'terminal-mini-ledger-v2', title: 'Mini Ledger v2', promptSha256: HASH, publicVerifierSha256: 'b'.repeat(64), holdoutVerifierSha256: 'c'.repeat(64) });
  assert.equal(validateTerminalChallenge(v2), v2);
});

test('challenge can seal an unbounded turn policy', () => {
  const unbounded = createMiniLedgerChallenge({ promptSha256: HASH, publicVerifierSha256: 'b'.repeat(64), holdoutVerifierSha256: 'c'.repeat(64), maxWallTimeMs: null });
  assert.equal(validateTerminalChallenge(unbounded), unbounded);
  assert.equal(unbounded.protocol.maxWallTimeMs, null);
});

test('terminal combo identity separates harness/model but groups generations', () => {
  const first = terminalComboForAgent(agent('codex', 'terra', 1), challenge);
  const second = terminalComboForAgent(agent('codex', 'terra', 2), challenge);
  const other = terminalComboForAgent(agent('pi', 'terra', 1), challenge);
  assert.equal(first.comboId, second.comboId);
  assert.notEqual(first.comboId, other.comboId);
});

test('exhaustive schedule includes every harness/model/generation exactly once', () => {
  const agents = ['codex', 'pi'].flatMap((harness) => ['terra', 'sol'].flatMap((model) => [1, 2].map((index) => agent(harness, model, index))));
  const schedule = createExhaustiveTerminalSchedule({ challenge, agents, expectedHarnesses: ['codex', 'pi'], expectedModels: ['gpt-sol', 'gpt-terra'], generationsPerCombo: 2 });
  assert.equal(schedule.jobs.length, 8);
  assert.equal(new Set(schedule.jobs.map((job) => job.runKey)).size, 8);
  assert.equal(validateTerminalSchedule(schedule, challenge).scheduleId, schedule.scheduleId);
});

test('schedule refuses missing or unbalanced combos', () => {
  const agents = ['codex', 'pi'].flatMap((harness) => ['terra', 'sol'].flatMap((model) => [1, 2].map((index) => agent(harness, model, index))));
  assert.throws(() => createExhaustiveTerminalSchedule({ challenge, agents: agents.slice(1), expectedHarnesses: ['codex', 'pi'], expectedModels: ['gpt-sol', 'gpt-terra'], generationsPerCombo: 2 }), /matrix mismatch|generations/);
});

function run(score, holdoutPassed = 4) {
  return {
    schemaVersion: 'agentbattler.terminal-run.v1',
    challengeId: challenge.challengeId,
    challengeSha256: challenge.challengeSha256,
    status: 'completed',
    stages: challenge.stages.map((stage, index) => ({ id: stage.id, passed: index < score, regressions: 0 })),
    holdout: { passed: holdoutPassed, total: 5 },
  };
}

test('terminal score is transparent and deterministic', () => {
  const scored = scoreTerminalRun(run(6), challenge);
  assert.equal(scored.visiblePoints, 60);
  assert.equal(scored.holdoutPoints, 16);
  assert.equal(scored.scorePoints, 76);
  assert.equal(scored.scorePct, 76);
});

test('terminal score accepts legacy stageId results from the v1 adapter', () => {
  const legacy = run(6);
  legacy.stages = legacy.stages.map(({ id, ...stage }) => ({ stageId: id, ...stage }));
  assert.equal(scoreTerminalRun(legacy, challenge).scorePoints, 76);
});

test('score-derived Elo publishes all pairwise comparisons and ties', () => {
  assert.equal(compareTerminalScores({ scorePoints: 70 }, { scorePoints: 70 }), 0.5);
  const result = computeTerminalElo([
    { runKey: 'b', comboId: 'pi-sol', score: { scorePoints: 60 } },
    { runKey: 'a', comboId: 'codex-terra', score: { scorePoints: 80 } },
    { runKey: 'c', comboId: 'pi-terra', score: { scorePoints: 80 } },
  ]);
  assert.equal(result.comparisons.length, 3);
  assert.equal(result.standings.length, 3);
  assert.equal(result.comparisons.filter((comparison) => comparison.result === 0.5).length, 1);
});
