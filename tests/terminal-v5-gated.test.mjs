import assert from 'node:assert/strict';
import test from 'node:test';

import { selectLunaGateJobs } from '../scripts/run-terminal-v5-gated.mjs';

function fixtureSchedule() {
  const harnesses = ['codex-cli', 'pi-coding-agent', 'dotagents-mono', 'claude-code'];
  const coverage = harnesses.flatMap((harness) => ['gpt-5.6-luna', 'gpt-5.6-sol'].map((model) => {
    const comboId = `${harness}-${model}`;
    return {
      combo: { comboId, harness: { id: harness }, model: { id: model } },
      artifacts: [1, 2].map((generationIndex) => ({ id: `${comboId}-${generationIndex}`, generationIndex })),
    };
  }));
  const jobs = coverage.flatMap((entry) => entry.artifacts.map((artifact) => ({
    runKey: `run-${artifact.id}`,
    comboId: entry.combo.comboId,
    artifactId: artifact.id,
    generationIndex: artifact.generationIndex,
  })));
  return { coverage, jobs };
}

test('V5 infrastructure gates select exactly Luna generation one for each harness', () => {
  const gates = selectLunaGateJobs(fixtureSchedule());
  assert.deepEqual(gates.map(({ harness, model, generationIndex }) => ({ harness, model, generationIndex })), [
    { harness: 'codex-cli', model: 'gpt-5.6-luna', generationIndex: 1 },
    { harness: 'pi-coding-agent', model: 'gpt-5.6-luna', generationIndex: 1 },
    { harness: 'dotagents-mono', model: 'gpt-5.6-luna', generationIndex: 1 },
    { harness: 'claude-code', model: 'gpt-5.6-luna', generationIndex: 1 },
  ]);
  assert.ok(gates.every((gate) => gate.job.artifactId.endsWith('-1')));
});

test('V5 infrastructure gates fail closed when a harness lacks Luna', () => {
  const schedule = fixtureSchedule();
  schedule.coverage = schedule.coverage.filter((entry) => !(entry.combo.harness.id === 'claude-code' && entry.combo.model.id === 'gpt-5.6-luna'));
  assert.throws(() => selectLunaGateJobs(schedule), /no claude-code/);
});
