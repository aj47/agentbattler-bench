import assert from 'node:assert/strict';
import test from 'node:test';

import { summarizeHarnessComparison } from '../src/harness-summary.mjs';

function agent(harness, model) {
  return { provenance: { harness, modelRequested: model } };
}
function game(modelA, modelB, outcome, whiteHarness = 'codex-cli') {
  const blackHarness = whiteHarness === 'codex-cli' ? 'pi-coding-agent' : 'codex-cli';
  return { agents: { w: agent(whiteHarness, modelA), b: agent(blackHarness, modelB) }, final: { outcome } };
}

test('controlled harness score excludes cross-model games but reports their total', () => {
  const summary = summarizeHarnessComparison([
    game('gpt-5.6-terra', 'gpt-5.6-terra', '1-0'),
    game('gpt-5.6-terra', 'gpt-5.6-terra', '1/2-1/2', 'pi-coding-agent'),
    game('gpt-5.6-sol', 'gpt-5.6-sol', '0-1', 'pi-coding-agent'),
    game('gpt-5.6-luna', 'gpt-5.6-terra', '1-0'),
  ]);
  assert.equal(summary.allCrossHarnessGames, 4);
  assert.equal(summary.overall.games, 3);
  assert.deepEqual(summary.overall.codex, { games: 3, graded: 3, wins: 2, draws: 1, losses: 0, voids: 0, points: 2.5, scorePct: 83.33 });
  assert.deepEqual(summary.overall.pi, { games: 3, graded: 3, wins: 0, draws: 1, losses: 2, voids: 0, points: 0.5, scorePct: 16.67 });
});
