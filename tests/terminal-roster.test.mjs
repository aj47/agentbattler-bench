import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTerminalRuntimeRoster,
  DEFAULT_TERMINAL_GENERATIONS,
  DEFAULT_TERMINAL_MODELS,
  TERMINAL_RUNTIME_ROSTER_SCHEMA,
} from '../src/terminal-roster.mjs';
import { SEALED_TERMINAL_HARNESS_VERSIONS } from '../src/terminal-harness-versions.mjs';

test('terminal runtime roster covers every sealed harness and model with five fresh replicates', () => {
  const roster = createTerminalRuntimeRoster();
  const harnesses = Object.keys(SEALED_TERMINAL_HARNESS_VERSIONS);
  assert.equal(roster.schemaVersion, TERMINAL_RUNTIME_ROSTER_SCHEMA);
  assert.equal(roster.agents.length, harnesses.length * DEFAULT_TERMINAL_MODELS.length * DEFAULT_TERMINAL_GENERATIONS);
  assert.equal(new Set(roster.agents.map((agent) => agent.id)).size, roster.agents.length);
  assert.ok(roster.agents.every((agent) => agent.provenance.harnessVersion === SEALED_TERMINAL_HARNESS_VERSIONS[agent.provenance.harness]));
  assert.ok(roster.agents.every((agent) => agent.provenance.generationSettings.identity === 'fresh-independent-terminal-run'));
  assert.ok(roster.agents.every((agent) => agent.provenance.generationSettings.sourceArtifact === false));
  assert.ok(roster.agents.every((agent) => !('source' in agent) && !('sourceSha256' in agent)));
});

test('terminal runtime roster can select the Droid lane without chess artifacts', () => {
  const roster = createTerminalRuntimeRoster({ harnesses: ['factory-droid'] });
  assert.equal(roster.agents.length, 15);
  assert.deepEqual(new Set(roster.agents.map((agent) => agent.provenance.modelRequested)), new Set(DEFAULT_TERMINAL_MODELS));
  assert.deepEqual(new Set(roster.agents.map((agent) => agent.provenance.generationIndex)), new Set([1, 2, 3, 4, 5]));
});

test('terminal runtime roster rejects unknown harnesses and duplicate selections', () => {
  assert.throws(() => createTerminalRuntimeRoster({ harnesses: ['unknown'] }), /No sealed terminal runtime version/);
  assert.throws(() => createTerminalRuntimeRoster({ models: ['gpt-5.6-sol', 'gpt-5.6-sol'] }), /unique/);
});
