import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalJson, sha256 } from '../src/domain/canonical.mjs';
import { normalizeEvent } from '../src/domain/event.mjs';

test('canonical JSON is independent of object insertion order', () => {
  const left = canonicalJson({ beta: [2, { z: true, a: false }], alpha: 1 });
  const right = canonicalJson({ alpha: 1, beta: [2, { a: false, z: true }] });
  assert.equal(left, right);
  assert.equal(sha256(left), sha256(right));
});

test('event normalization preserves JSON payload values', () => {
  assert.deepEqual(normalizeEvent({ id: 'evt-1', kind: 'task', payload: { nested: [null, 1, 'x'] } }, 3), {
    id: 'evt-1',
    kind: 'task',
    payload: { nested: [null, 1, 'x'] },
    sequence: 3,
  });
  assert.throws(() => normalizeEvent({ id: '', kind: 'task', payload: {} }, 1), /invalid id/);
});
