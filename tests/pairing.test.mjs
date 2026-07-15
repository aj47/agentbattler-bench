import test from 'node:test';
import assert from 'node:assert/strict';

import { comparisonPairs } from '../src/pairing.mjs';

function fivePerModelRoster() {
  return ['terra', 'sol', 'luna'].flatMap((model) => Array.from({ length: 5 }, (_, index) => ({
    id: `${model}-${String(index + 1).padStart(2, '0')}`,
    provenance: { modelRequested: `gpt-5.6-${model}` },
  })));
}

test('cross-model pairing schedules 900 unique games for five generations across three models', () => {
  const pairs = comparisonPairs(fivePerModelRoster(), 'cross-model');
  assert.equal(pairs.length, 75);
  assert.ok(pairs.every(([first, second]) => first.provenance.modelRequested !== second.provenance.modelRequested));
  assert.equal(pairs.length * 6 * 1 * 2, 900);
});

test('cross-harness pairs equal models across harnesses without within-harness games', () => {
  const agents = ['codex-cli', 'pi-coding-agent'].flatMap((harness) => ['terra', 'sol', 'luna'].flatMap((family) => (
    Array.from({ length: 5 }, (_, index) => ({
      id: `${harness}-${family}-${index + 1}`,
      provenance: { harness, modelRequested: `gpt-5.6-${family}` },
    }))
  )));
  const pairs = comparisonPairs(agents, 'cross-harness');
  assert.equal(pairs.length, 75);
  assert.ok(pairs.every(([first, second]) => (
    first.provenance.harness !== second.provenance.harness
    && first.provenance.modelRequested === second.provenance.modelRequested
  )));
});

test('cross-harness requires harness and model provenance', () => {
  assert.throws(() => comparisonPairs([
    { id: 'first', provenance: { harness: 'pi-coding-agent' } },
    { id: 'second', provenance: { harness: 'codex-cli', modelRequested: 'gpt-5.6-luna' } },
  ], 'cross-harness'), /requires modelRequested and harness provenance/);
});

test('all-pairs still includes the 30 within-model generation pairs', () => {
  assert.equal(comparisonPairs(fivePerModelRoster(), 'all-pairs').length, 105);
});
