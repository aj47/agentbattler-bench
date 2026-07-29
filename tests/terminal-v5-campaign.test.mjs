import assert from 'node:assert/strict';
import test from 'node:test';

import { createExhaustiveTerminalSchedule, createMiniLedgerChallenge } from '../src/terminal-challenge.mjs';
import {
  configureTerminalV5RuntimeEnvironment,
  reconcileTerminalV5Campaign,
  selectTerminalV5CampaignBatch,
} from '../src/terminal-v5-campaign.mjs';

test('V5 campaign pins the R4 verifier runtime before adapter import', () => {
  const environment = {
    AGENTBATTLER_TERMINAL_CHALLENGE_VERSION: 'v2',
    AGENTBATTLER_TERMINAL_PROTOCOL_REVISION: 'r2',
    AGENTBATTLER_TERMINAL_RESULT_TAG: 'v5-r2',
  };
  configureTerminalV5RuntimeEnvironment(environment);
  assert.deepEqual(environment, {
    AGENTBATTLER_TERMINAL_CHALLENGE_VERSION: 'v5',
    AGENTBATTLER_TERMINAL_PROTOCOL_REVISION: 'r4',
    AGENTBATTLER_TERMINAL_RESULT_TAG: 'v5-r4-reliability',
  });
});

function challenge(seed) {
  return createMiniLedgerChallenge({ challengeId: 'terminal-mini-ledger-v5', promptSha256: seed.repeat(64), publicVerifierSha256: 'b'.repeat(64), holdoutVerifierSha256: 'c'.repeat(64) });
}
function agent(harness, model, generationIndex) {
  return { id: `${harness}-${model}-${generationIndex}`, generationIndex, provenance: { harness, harnessVersion: 'test', modelRequested: model, modelFamilyId: model, reasoningEffort: 'high' } };
}
function scheduleFor(challengeValue) {
  return createExhaustiveTerminalSchedule({
    challenge: challengeValue,
    agents: ['dotagents-mono', 'pi-coding-agent'].flatMap((harness) => [1, 2].map((generation) => agent(harness, 'gpt-sol', generation))),
    expectedHarnesses: ['dotagents-mono', 'pi-coding-agent'],
    expectedModels: ['gpt-sol'],
    generationsPerCombo: 2,
  });
}
function record(schedule, harness, generation, status, attemptCount = 1) {
  const combo = schedule.coverage.find((entry) => entry.combo.harness.id === harness).combo;
  const job = schedule.jobs.find((entry) => entry.comboId === combo.comboId && entry.generationIndex === generation);
  return { job, combo, run: { ...job, status, runKey: job.runKey }, attemptCount, file: `/results/${job.runKey}.json` };
}

test('V5 campaign preserves accepted legacy evidence and finishes first coverage before retries', () => {
  const target = scheduleFor(challenge('a'));
  const legacy = scheduleFor(challenge('d'));
  const sources = [
    { id: 'R4', protocolRevision: 'r4', records: [] },
    { id: 'R3', protocolRevision: 'r3', harnesses: ['dotagents-mono'], records: [record(legacy, 'dotagents-mono', 1, 'completed')] },
    { id: 'R2', protocolRevision: 'r2', harnesses: ['pi-coding-agent'], records: [record(legacy, 'pi-coding-agent', 1, 'infrastructure-invalid')] },
  ];
  const campaign = reconcileTerminalV5Campaign({ targetSchedule: target, sources });
  assert.deepEqual(campaign.counts, { expected: 4, accepted: 1, infrastructureInvalid: 1, unstarted: 2, outstanding: 3 });
  assert.equal(campaign.phase, 'first-coverage');
  assert.equal(campaign.next.job.generationIndex, 2);
  assert.equal(campaign.next.combo.harness.id, 'dotagents-mono');
  assert.equal(campaign.entries.find((entry) => entry.combo.harness.id === 'dotagents-mono' && entry.job.generationIndex === 1).acceptedSource.sourceId, 'R3');
});

test('bounded retry passes choose the unresolved job with the fewest attempts', () => {
  const target = scheduleFor(challenge('e'));
  const records = target.coverage.flatMap(({ combo }) => [1, 2].map((generation) => record(target, combo.harness.id, generation, 'infrastructure-invalid', combo.harness.id === 'dotagents-mono' ? 2 : 1)));
  const campaign = reconcileTerminalV5Campaign({ targetSchedule: target, sources: [{ id: 'R4', protocolRevision: 'r4', records }] });
  assert.equal(campaign.phase, 'bounded-retries');
  assert.equal(campaign.next.combo.harness.id, 'pi-coding-agent');
  assert.equal(campaign.next.attemptCount, 1);
});

test('two-lane batches select one DotAgents and one legacy job behind the same generation barrier', () => {
  const target = scheduleFor(challenge('f'));
  const records = [
    record(target, 'dotagents-mono', 1, 'completed'),
    record(target, 'pi-coding-agent', 1, 'completed'),
  ];
  const campaign = reconcileTerminalV5Campaign({ targetSchedule: target, sources: [{ id: 'R4', protocolRevision: 'r4', records }] });
  const batch = selectTerminalV5CampaignBatch(campaign, { lanes: 2 });
  assert.deepEqual(batch.map((entry) => [entry.combo.harness.id, entry.job.generationIndex]), [
    ['dotagents-mono', 2],
    ['pi-coding-agent', 2],
  ]);
});

test('bounded retry batches respect lane isolation and the attempt ceiling', () => {
  const target = scheduleFor(challenge('1'));
  const records = target.coverage.flatMap(({ combo }) => [1, 2].map((generation) => (
    record(target, combo.harness.id, generation, 'infrastructure-invalid', generation === 1 ? 3 : 1)
  )));
  const campaign = reconcileTerminalV5Campaign({ targetSchedule: target, sources: [{ id: 'R4', protocolRevision: 'r4', records }] });
  const batch = selectTerminalV5CampaignBatch(campaign, { lanes: 2, maxAttempts: 3 });
  assert.deepEqual(batch.map((entry) => [entry.combo.harness.id, entry.job.generationIndex]), [
    ['dotagents-mono', 2],
    ['pi-coding-agent', 2],
  ]);
});
