import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeCodexEvent, parseCodexTrace } from '../src/codex-trace.mjs';

const context = {
  snapshotId: 'snapshot-1',
  runId: 'run-1',
  agentId: 'luna',
  displayName: 'GPT-5.6 Luna',
  model: 'gpt-5.6-luna',
  reasoningEffort: 'high',
  sequence: 3,
};

test('normalizes a command event into stable viewer columns', () => {
  const source = {
    type: 'item.completed',
    item: {
      id: 'item_2',
      type: 'command_execution',
      command: 'node --check agent.js',
      aggregated_output: 'ok\n',
      exit_code: 0,
      status: 'completed',
    },
  };
  const event = normalizeCodexEvent(source, context);
  assert.equal(event.summary, '$ node --check agent.js\n\nok\n');
  assert.equal(event.exitCode, 0);
  assert.equal(event.agentId, 'luna');
  assert.deepEqual(JSON.parse(event.rawEvent), source);
});

test('normalizes token usage and preserves one-based sequence', () => {
  const records = parseCodexTrace([
    '{"type":"turn.started"}',
    '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":4,"output_tokens":3,"reasoning_output_tokens":2}}',
    '',
  ].join('\n'), context);
  assert.equal(records.length, 2);
  assert.equal(records[0].sequence, 1);
  assert.equal(records[1].sequence, 2);
  assert.equal(records[1].inputTokens, 10);
  assert.equal(records[1].reasoningTokens, 2);
});

test('rejects malformed JSON with its source line', () => {
  assert.throws(() => parseCodexTrace('{"type":"ok"}\nnot-json\n', context), /line 2/);
});
