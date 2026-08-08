import assert from 'node:assert/strict';
import test from 'node:test';

import { V7_PHASES, V7_REQUIREMENTS } from '../benchmark/challenges/mini-ledger-v7/requirements.mjs';
import { createTerminalV7AggregateTraceRecords } from '../scripts/export-terminal-v7-traces.mjs';
import {
  classifyTerminalV7OfficialFinalization,
  completeTerminalV7ReserveFinalization,
} from '../scripts/verify-terminal-v7-results.mjs';
import { MINI_LEDGER_V7_FAMILIES } from '../src/terminal-v7.mjs';

function fixture({ modelId = 'gpt-5.6-luna' } = {}) {
  const phaseResults = V7_PHASES.map((phase) => ({
    phase: phase.phase,
    id: phase.id,
    infrastructureErrors: [],
    requirements: phase.requirementIds.map((id) => {
      const requirement = V7_REQUIREMENTS.find((entry) => entry.id === id);
      if (requirement.group === 'public') return { id, points: requirement.weight, passed: true };
      const classes = Object.fromEntries(['atomic', 'composed'].map((caseClass) => {
        const passed = id !== 'V7-P3-PRIVATE-TERMINATION' || caseClass === 'atomic';
        const weight = requirement.privateClassWeights[caseClass];
        return [caseClass, { weight, points: passed ? weight : 0, passed }];
      }));
      const points = classes.atomic.points + classes.composed.points;
      return { id, points, passed: points === requirement.weight, classes };
    }),
  }));
  const turns = V7_PHASES.map((phase) => ({
    index: phase.phase,
    sessionId: 'must-not-be-exported',
    durationMs: phase.phase * 100,
    timedOut: false,
    isolation: phase.phase === 2 ? { observedAttemptCount: 5, observedAttempts: Array.from({ length: 5 }, () => ({ marker: 'aggregate-only' })) } : { observedAttemptCount: 0, observedAttempts: [] },
    usage: { inputTokens: phase.phase * 10, outputTokens: phase.phase, secret: 'must-not-be-exported' },
  }));
  const trees = V7_PHASES.map((phase) => ({
    turn: phase.phase,
    baseTreeSha256: 'a'.repeat(64),
    treeSha256: String(phase.phase).repeat(64),
    fileCount: 20,
    totalBytes: 1_000,
    changedFiles: phase.phase,
    deletions: 0,
  }));
  const families = MINI_LEDGER_V7_FAMILIES.map((id) => ({
    id,
    points: 20,
    exact: true,
    public: { points: 4 },
    hidden: { points: 16 },
    hiddenAtomic: { points: 6 },
    hiddenComposed: { points: 10 },
  }));
  return {
    challenge: { challengeId: 'challenge-test', challengeSha256: 'b'.repeat(64) },
    schedule: { scheduleId: 'schedule-test', scheduleSha256: 'c'.repeat(64) },
    entry: {
      job: {
        runKey: 'd'.repeat(64),
        harness: { id: 'codex-cli', version: 'test' },
        model: { id: modelId, reasoningEffort: 'max' },
        instanceId: 'release-01',
        instanceSha256: 'e'.repeat(64),
        instanceVariant: 'decoy',
        round: 1,
        executionIndex: 1,
      },
      run: {
        status: 'completed',
        validity: 'valid',
        durationMs: 1_500,
        sameSessionProof: true,
        toolCalls: 12,
        usage: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 30 },
        resources: { maxMemoryPeakBytes: 1_024, maxProcessCount: 3 },
        turns,
        phaseResults,
        evaluation: {
          families: MINI_LEDGER_V7_FAMILIES.map((id) => ({
            id,
            public: { passed: 4, total: 4 },
            hidden: { passed: 16, total: 16 },
            hiddenAtomic: { passed: 6, total: 6 },
            hiddenComposed: { passed: 10, total: 10 },
          })),
          adaptability: { passed: 5, total: 5 },
        },
        declaredArtifacts: [null, null, null, { path: 'private-name.md', archivePath: 'private-path', sizeBytes: 12, sha256: 'f'.repeat(64) }, null],
        prompt: 'must not be exported',
        modelResponse: 'must not be exported',
        command: 'must not be exported',
        authorization: 'Bearer must-not-be-exported',
      },
      score: {
        core: {
          points: 100,
          public: { points: 20, passed: 20, total: 20 },
          hidden: { points: 80, passed: 80, total: 80 },
          hiddenAtomic: { points: 30, passed: 30, total: 30 },
          hiddenComposed: { points: 50, passed: 50, total: 50 },
          families,
        },
        exact: true,
        adaptability: { points: 15 },
        proxyGap: 0,
      },
      trees,
      attemptCount: 1,
    },
  };
}

test('V7 aggregate traces omit prompts, responses, commands, auth, sessions, source paths, and artifact paths', () => {
  const records = createTerminalV7AggregateTraceRecords(fixture());
  assert.equal(records.length, 8);
  const text = JSON.stringify(records);
  for (const forbidden of ['must not be exported', 'private-name.md', 'private-path', 'sessionId', 'prompt', 'modelResponse', 'command', 'authorization']) {
    assert.equal(text.includes(forbidden), false, `trace leaked ${forbidden}`);
  }
  assert.equal(records.filter(({ type }) => type === 'phaseAggregate').length, 5);
  assert.deepEqual(records[0].instanceVariant, 'decoy');
  assert.equal(records.at(-1).core, 100);
  assert.equal(records[5].declaredArtifact.sha256, 'f'.repeat(64));
});

test('V7 aggregate traces retain weighted requirement outcomes and tree/resource aggregates', () => {
  const records = createTerminalV7AggregateTraceRecords(fixture());
  const phaseThree = records.find(({ type, phase }) => type === 'phaseAggregate' && phase === 3);
  assert.deepEqual(phaseThree.public, { passedWeight: 4, totalWeight: 4 });
  assert.deepEqual(phaseThree.private, { passedWeight: 19, totalWeight: 24 });
  assert.deepEqual(phaseThree.hiddenAtomic, { passedWeight: 9, totalWeight: 9 });
  assert.deepEqual(phaseThree.hiddenComposed, { passedWeight: 10, totalWeight: 15 });
  const finalScore = records.find(({ type }) => type === 'finalScore');
  assert.deepEqual(finalScore.hiddenAtomic, { points: 30, passed: 30, total: 30 });
  assert.deepEqual(finalScore.hiddenComposed, { points: 50, passed: 50, total: 50 });
  assert.ok(finalScore.families.every(({ hiddenAtomicPoints, hiddenComposedPoints }) => hiddenAtomicPoints === 6 && hiddenComposedPoints === 10));
  assert.equal(phaseThree.candidateTree.treeSha256, '3'.repeat(64));
  assert.deepEqual(records[1].resources, { maxMemoryPeakBytes: 1_024, maxProcessCount: 3 });
  assert.deepEqual(records[1].usage, { inputTokens: 100, cachedInputTokens: 20, outputTokens: 30 });
  assert.equal(records[1].blockedAttemptCount, 5);
  assert.equal(V7_REQUIREMENTS.length, 17);
});

test('V7 aggregate trace privacy audit fails closed on secret-shaped identity data', () => {
  assert.throws(
    () => createTerminalV7AggregateTraceRecords(fixture({ modelId: 'Bearer abcdefghijklmnopqrstuvwxyz' })),
    /forbidden string data/,
  );
});

test('V7 official finalization completes directly when the leading pair is resolved', () => {
  const state = classifyTerminalV7OfficialFinalization({
    complete: true,
    revisionStatus: 'active',
    saturationTriggered: false,
    standings: [{ harnessId: 'codex-cli' }, { harnessId: 'pi-coding-agent' }],
    pairedAnalysis: {
      comparisons: [{
        leftHarnessId: 'codex-cli',
        rightHarnessId: 'pi-coding-agent',
        decision: 'practical-win',
        confidenceExcludesZero: true,
      }],
    },
  });
  assert.equal(state.status, 'official-complete');
  assert.equal(state.officialMatrixVerified, true);
  assert.equal(state.reserveRequired, false);
  assert.equal(state.terminalVerified, true);
});

test('V7 strict finalization requires a saturation audit when Core 100 exists without a shared marker', () => {
  const state = classifyTerminalV7OfficialFinalization({
    complete: true,
    revisionStatus: 'active',
    saturationTriggered: true,
    standings: [{ harnessId: 'codex-cli' }, { harnessId: 'pi-coding-agent' }],
    pairedAnalysis: {
      comparisons: [{
        leftHarnessId: 'codex-cli',
        rightHarnessId: 'pi-coding-agent',
        decision: 'practical-win',
        confidenceExcludesZero: true,
      }],
    },
  });
  assert.equal(state.status, 'saturation-audit-required');
  assert.equal(state.officialMatrixVerified, false);
  assert.equal(state.reserveRequired, false);
  assert.equal(state.terminalVerified, false);
});

test('V7 unresolved official finalization requires the exact presealed reserve pair before terminal completion', () => {
  const official = classifyTerminalV7OfficialFinalization({
    complete: true,
    revisionStatus: 'active',
    saturationTriggered: false,
    standings: [{ harnessId: 'codex-cli' }, { harnessId: 'pi-coding-agent' }],
    pairedAnalysis: {
      comparisons: [{
        leftHarnessId: 'codex-cli',
        rightHarnessId: 'pi-coding-agent',
        decision: 'tie',
        confidenceExcludesZero: false,
      }],
    },
  });
  assert.equal(official.status, 'reserve-required');
  assert.equal(official.officialMatrixVerified, true);
  assert.equal(official.terminalVerified, false);
  const completed = completeTerminalV7ReserveFinalization(official, {
    reportSha256: 'a'.repeat(64),
    matrix: { selectedHarnesses: 2 },
    standings: [{ harnessId: 'pi-coding-agent' }, { harnessId: 'codex-cli' }],
    saturationAudit: { triggered: false },
    decision: 'tie',
    winnerHarnessId: null,
  });
  assert.equal(completed.status, 'reserve-complete');
  assert.equal(completed.terminalVerified, true);
  assert.throws(() => completeTerminalV7ReserveFinalization(official, {
    reportSha256: 'b'.repeat(64),
    matrix: { selectedHarnesses: 2 },
    standings: [{ harnessId: 'codex-cli' }, { harnessId: 'claude-code' }],
    saturationAudit: { triggered: false },
    decision: 'tie',
    winnerHarnessId: null,
  }), /exact unresolved leading pair/);
});

test('V7 reserve aggregate traces use calibration scores without exposing private records', () => {
  const value = fixture();
  value.entry.score = { corePoints: 100, exact: true };
  const records = createTerminalV7AggregateTraceRecords({ ...value, pool: 'reserve' });
  assert.equal(records[0].pool, 'reserve');
  assert.equal(records.at(-1).core, 100);
  assert.equal(records.at(-1).adaptability, 15);
  assert.equal(JSON.stringify(records).includes('must-not-be-exported'), false);
});
