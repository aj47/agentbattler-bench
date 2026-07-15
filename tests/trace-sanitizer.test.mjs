import assert from 'node:assert/strict';
import test from 'node:test';

import { sanitizePublicTrace } from '../src/trace-sanitizer.mjs';

test('redacts host home paths and standalone account names deterministically', () => {
  const result = sanitizePublicTrace('/Users/alice/work\n-rw-r--r-- 1 alice staff\n', {
    homeDirectory: '/Users/alice',
    username: 'alice',
  });
  assert.equal(result.content, '<redacted-home>/work\n-rw-r--r-- 1 <redacted-user> staff\n');
  assert.deepEqual(result.replacements, { hostHomeDirectory: 1, hostUsername: 1 });
  assert.equal(result.totalReplacements, 2);
});

test('is a no-op when host identifiers are absent', () => {
  const result = sanitizePublicTrace('public trace', { homeDirectory: '/Users/alice', username: 'alice' });
  assert.equal(result.content, 'public trace');
  assert.equal(result.totalReplacements, 0);
});
