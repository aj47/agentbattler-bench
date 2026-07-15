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

test('all-pairs still includes the 30 within-model generation pairs', () => {
  assert.equal(comparisonPairs(fivePerModelRoster(), 'all-pairs').length, 105);
});
