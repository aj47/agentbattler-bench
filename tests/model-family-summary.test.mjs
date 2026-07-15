import assert from 'node:assert/strict';
import test from 'node:test';

import { summarizeModelFamilies } from '../src/model-family-summary.mjs';

const families = ['sol', 'terra', 'luna'].map((id) => ({
  id,
  displayName: id[0].toUpperCase() + id.slice(1),
  model: `model-${id}`,
}));

function game(id, whiteId, blackId, outcome, failure = null) {
  const agent = (agentId) => ({
    id: agentId,
    provenance: { modelFamilyId: agentId.replace(/-\d+$/, '') },
  });
  return {
    gameId: id,
    agents: { w: agent(whiteId), b: agent(blackId) },
    final: { outcome, failure },
  };
}

const games = [
  game('st-1', 'sol-01', 'terra-01', '1-0'),
  game('st-2', 'terra-01', 'sol-02', '0-1'),
  game('st-3', 'sol-01', 'terra-02', '1-0'),
  game('st-4', 'sol-02', 'terra-02', '0-1', { color: 'w', status: 'timeout' }),
  game('sl-1', 'sol-01', 'luna-01', '1-0'),
  game('sl-2', 'luna-01', 'sol-02', '0-1'),
  game('sl-3', 'sol-01', 'luna-02', '1-0'),
  game('sl-4', 'luna-02', 'sol-02', '0-1'),
  game('tl-1', 'terra-01', 'luna-01', '1/2-1/2'),
  game('tl-2', 'luna-01', 'terra-02', '1/2-1/2'),
  game('tl-3', 'terra-01', 'luna-02', '1/2-1/2'),
  game('tl-4', 'luna-02', 'terra-02', '0-1', { color: 'w', status: 'illegal' }),
];

function standingFor(agentId) {
  const relevant = games.filter((entry) => entry.agents.w.id === agentId || entry.agents.b.id === agentId);
  const scores = relevant.map((entry) => {
    if (entry.final.outcome === '1/2-1/2') return 0.5;
    const won = (entry.final.outcome === '1-0' && entry.agents.w.id === agentId)
      || (entry.final.outcome === '0-1' && entry.agents.b.id === agentId);
    return won ? 1 : 0;
  });
  const wins = scores.filter((score) => score === 1).length;
  const draws = scores.filter((score) => score === 0.5).length;
  return {
    games: relevant.length,
    wins,
    draws,
    losses: relevant.length - wins - draws,
    points: scores.reduce((sum, score) => sum + score, 0),
    elo: 1500,
  };
}

const agents = families.flatMap((family) => [1, 2].map((index) => ({
  id: `${family.id}-0${index}`,
  displayName: `${family.displayName} #${index}`,
  standing: standingFor(`${family.id}-0${index}`),
  generation: { totalTokens: index * 100, durationMs: index * 1000, toolCalls: index },
})));

test('model families aggregate games, pairwise records, variance, and attributed failures', () => {
  const summaries = summarizeModelFamilies({ families, agents, games });
  assert.deepEqual(summaries.map(({ id, rank, scorePct }) => ({ id, rank, scorePct })), [
    { id: 'sol', rank: 1, scorePct: 87.5 },
    { id: 'terra', rank: 2, scorePct: 43.75 },
    { id: 'luna', rank: 3, scorePct: 18.75 },
  ]);
  assert.equal(summaries.every((family) => family.games === 8), true);
  assert.equal(summaries.flatMap((family) => family.pairwise).every((pair) => pair.games === 4), true);
  assert.deepEqual(summaries.find((family) => family.id === 'sol').reliability, {
    failures: 1,
    timeouts: 1,
    illegalMoves: 0,
  });
  assert.deepEqual(summaries.find((family) => family.id === 'luna').reliability, {
    failures: 1,
    timeouts: 0,
    illegalMoves: 1,
  });
});
