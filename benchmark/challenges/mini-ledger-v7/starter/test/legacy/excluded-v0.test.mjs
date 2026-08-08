import assert from 'node:assert/strict';
import test from 'node:test';

// This archived compatibility test is deliberately outside the package.json
// test selection. Its superseded expectation documents the retired v0 tool.
test('v0 printed a bare array', { skip: 'v0 retired; see config/test-policy.json' }, () => {
  assert.deepEqual(JSON.parse('[{"type":"memo"}]'), [{ type: 'memo' }]);
});
