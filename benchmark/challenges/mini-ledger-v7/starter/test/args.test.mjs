import assert from 'node:assert/strict';
import test from 'node:test';

import { parseArgs, requireFlags, requirePositionals } from '../src/args.mjs';

test('argument parsing separates flags from positionals', () => {
  assert.deepEqual(parseArgs(['append', '--id', 'a-1', '--kind', 'task', '--payload', '{}']), {
    command: 'append',
    flags: { id: 'a-1', kind: 'task', payload: '{}' },
    positionals: [],
  });
  assert.deepEqual(parseArgs(['export', 'output.json']), {
    command: 'export',
    flags: {},
    positionals: ['output.json'],
  });
});

test('argument validation rejects ambiguous inputs', () => {
  assert.throws(() => parseArgs(['append', '--id']), /invalid argument/);
  assert.throws(() => parseArgs(['append', '--id', 'a', '--id', 'b']), /duplicate --id/);
  assert.throws(() => requireFlags({ id: 'a', extra: 'b' }, ['id']), /unexpected --extra/);
  assert.throws(() => requirePositionals(['one', 'two'], 1), /expected 1 positional/);
});
