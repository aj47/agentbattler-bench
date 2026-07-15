import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizePiEvent, parsePiTrace } from '../src/pi-trace.mjs';

const context = { snapshotId: 'snapshot-1', runId: 'run-1', agentId: 'pi-luna-01', displayName: 'Pi Luna #1', model: 'gpt-5.6-luna', reasoningEffort: 'high', sequence: 2 };

test('normalizes Pi tool execution into stable viewer columns', () => {
  const source = { type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'bash', args: { command: 'node --check agent.js' } };
  const event = normalizePiEvent(source, context);
  assert.equal(event.harness, 'pi-coding-agent');
  assert.equal(event.command, 'node --check agent.js');
  assert.equal(event.itemId, 'tool-1');
  assert.deepEqual(JSON.parse(event.rawEvent), source);
});

test('drops high-volume streaming deltas while retaining source sequence', () => {
  const events = parsePiTrace([
    '{"type":"session","id":"run-1"}',
    '{"type":"message_update","assistantMessageEvent":{"type":"text_delta"}}',
    '{"type":"turn_start"}',
    '{"type":"agent_end"}',
  ].join('\n'), context);
  assert.deepEqual(events.map((event) => event.sequence), [1, 3, 4]);
});

test('rejects malformed Pi JSON with its source line', () => {
  assert.throws(() => parsePiTrace('{"type":"ok"}\nnope\n', context), /line 2/);
});
