import assert from 'node:assert/strict';
import test from 'node:test';

import {
  comboForAgent,
  createBattleProtocol,
  createPlacementSchedule,
  createSeason,
  gameSpecification,
  groupAgentsByCombo,
  validateSchedule,
} from '../src/league.mjs';

const HASHES = {
  task: '1'.repeat(64),
  suite: '2'.repeat(64),
};

function agent(family, index) {
  return {
    id: `${family}-0${index}`,
    displayName: `${family} ${index}`,
    generationIndex: index,
    sourceSha256: String(index + family.charCodeAt(0)).padStart(64, '0'),
    provenance: {
      kind: 'generated',
      harness: 'codex-cli',
      harnessVersion: '1.0.0',
      modelRequested: `model-${family}`,
      modelFamilyId: family,
      prompt: 'task.md',
      promptSha256: HASHES.task,
      reasoningEffort: 'high',
      generationIndex: index,
    },
  };
}

test('combo identity groups generations but separates actual configurations', () => {
  const first = agent('sol', 1);
  const second = agent('sol', 2);
  assert.equal(comboForAgent(first).comboId, comboForAgent(second).comboId);
  second.provenance.reasoningEffort = 'medium';
  assert.notEqual(comboForAgent(first).comboId, comboForAgent(second).comboId);
});

test('game keys bind protocol, source hashes, colors, and position inputs', () => {
  const protocol = createBattleProtocol();
  const white = agent('sol', 1);
  const black = agent('terra', 1);
  const position = { id: 'p1', fen: 'fen', maxPlies: 10, seeds: [7] };
  const base = gameSpecification({ white, black, position, seed: 7, protocol });
  assert.match(base.gameKey, /^[0-9a-f]{64}$/);
  assert.notEqual(base.gameKey, gameSpecification({ white: black, black: white, position, seed: 7, protocol }).gameKey);
  assert.notEqual(base.gameKey, gameSpecification({ white, black, position, seed: 8, protocol }).gameKey);
});

test('placement schedules deterministic cyclic artifact matches across anchors and targets', () => {
  const agents = ['sol', 'terra', 'luna'].flatMap((family) => [agent(family, 1), agent(family, 2)]);
  const groups = groupAgentsByCombo(agents);
  const ids = Object.fromEntries([...groups.values()].map((group) => [group.agents[0].provenance.modelFamilyId, group.combo.comboId]));
  const protocol = createBattleProtocol();
  const season = createSeason({ suiteId: 'suite-v1', suiteSha256: HASHES.suite, protocol });
  const input = {
    agents,
    entrantComboId: ids.sol,
    anchorComboIds: [ids.terra],
    targetComboIds: [ids.luna],
    positions: [{ id: 'p1', fen: 'fen', maxPlies: 10, seeds: [7] }],
    season,
    protocol,
    tierId: 'contender',
    rotations: 1,
  };
  const first = createPlacementSchedule(input);
  const second = createPlacementSchedule(input);
  assert.deepEqual(first, second);
  assert.equal(first.jobs.length, 8);
  assert.equal(first.jobs.filter((job) => job.phase === 'anchor').length, 4);
  assert.equal(first.jobs.filter((job) => job.phase === 'targeted').length, 4);
  assert.equal(new Set(first.jobs.map((job) => job.gameKey)).size, first.jobs.length);
  assert.equal(validateSchedule(first), first);
});
