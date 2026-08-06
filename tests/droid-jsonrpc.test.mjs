import assert from 'node:assert/strict';
import test from 'node:test';

import { summarizeDroidRpcTurn } from '../src/droid-jsonrpc.mjs';

function notification(event) {
  return { type: 'notification', method: 'droid.session_notification', params: { notification: event } };
}

test('Droid JSON-RPC summary records native tools, token usage, and compaction', () => {
  const messages = [
    notification({ type: 'droid_working_state_changed', newState: 'thinking' }),
    notification({ type: 'create_message', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Read' }] } }),
    notification({ type: 'session_compacted', summaryId: 'summary-1', removedCount: 12, visibleBoundaryMessageId: 'message-4' }),
    notification({ type: 'create_message', message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] } }),
    notification({ type: 'agent_turn_completed', reason: 'completed', durationMs: 42, tokenUsage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 4, thinkingTokens: 5 } }),
  ];
  assert.deepEqual(summarizeDroidRpcTurn(messages, {
    sessionId: 'session-1',
    beforeContext: { used: 200_000, limit: 206_720 },
    afterContext: { used: 25_000, limit: 206_720 },
  }), {
    sessionId: 'session-1', success: true, stopReason: 'completed', finalText: 'Done', durationMs: 42, eventCount: 5,
    toolCallCount: 1, toolCallBreakdown: { Read: 1 },
    usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 30, cacheCreationTokens: 4, reasoningTokens: 5 },
    errors: [],
    compaction: { count: 1, boundaries: [{ summaryId: 'summary-1', removedCount: 12, visibleBoundaryMessageId: 'message-4', beforeTokens: 200_000, afterTokens: 25_000 }] },
    beforeContext: { used: 200_000, limit: 206_720 },
    afterContext: { used: 25_000, limit: 206_720 },
  });
});
