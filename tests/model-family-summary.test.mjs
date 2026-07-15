import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { summarizeModelFamilies } from '../src/model-family-summary.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(ROOT, relativePath), 'utf8'));
}

test('five-engine model families aggregate the complete match schedule', async () => {
  const [suite, manifest, result] = await Promise.all([
    readJson('results/model-suite/generation-suite.json'),
    readJson('agents/model-suite/manifest.json'),
    readJson('results/model-suite/matches/result.json'),
  ]);
  const standings = new Map(result.summary.standings.map((row) => [row.agentId, row]));
  const agents = manifest.agents.map((entry) => {
    const standing = standings.get(entry.id);
    return {
      id: entry.id,
      displayName: entry.displayName,
      standing: {
        games: standing.gamesPlayed,
        wins: standing.wins,
        draws: standing.draws,
        losses: standing.losses,
        points: standing.points,
        elo: standing.provisionalElo,
      },
      generation: { totalTokens: 0, durationMs: 0, toolCalls: 0 },
    };
  });

  const families = summarizeModelFamilies({ families: suite.families, agents, games: result.games });
  assert.deepEqual(families.map(({ id, rank, scorePct }) => ({ id, rank, scorePct })), [
    { id: 'sol', rank: 1, scorePct: 62.25 },
    { id: 'terra', rank: 2, scorePct: 44.25 },
    { id: 'luna', rank: 3, scorePct: 43.5 },
  ]);
  assert.deepEqual(families.map(({ id, games }) => ({ id, games })), [
    { id: 'sol', games: 600 },
    { id: 'terra', games: 600 },
    { id: 'luna', games: 600 },
  ]);
  assert.equal(families.flatMap((family) => family.pairwise).every((pair) => pair.games === 300), true);
  assert.deepEqual(families.find((family) => family.id === 'sol').reliability, {
    failures: 20,
    timeouts: 20,
    illegalMoves: 0,
  });
  assert.deepEqual(families.find((family) => family.id === 'luna').reliability, {
    failures: 9,
    timeouts: 0,
    illegalMoves: 9,
  });
});
