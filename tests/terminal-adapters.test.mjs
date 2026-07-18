import assert from 'node:assert/strict';
import test from 'node:test';

import * as all from '../scripts/terminal-adapter-all.mjs';
import * as claude from '../scripts/terminal-adapter-claude.mjs';
import * as dotagents from '../scripts/terminal-adapter-dotagents.mjs';

test('all terminal harness adapters advertise the exhaustive matrix roster', () => {
  assert.deepEqual(all.harnesses, ['claude-code', 'codex-cli', 'dotagents-mono', 'pi-coding-agent']);
  assert.deepEqual(claude.harnesses, ['claude-code']);
  assert.deepEqual(dotagents.harnesses, ['dotagents-mono']);
});
