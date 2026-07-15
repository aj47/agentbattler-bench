import assert from 'node:assert/strict';
import test from 'node:test';

import { validateNativeCodexSession } from '../src/codex-session.mjs';

const fixture = [
  { type: 'session_meta', payload: { id: 'run-1', cli_version: '0.144.0' } },
  { type: 'turn_context', payload: { model: 'gpt-5.6-luna', effort: 'high' } },
  { type: 'event_msg', payload: { type: 'user_message', message: 'Build the agent.' } },
  { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [] } },
  { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'call-1' } },
].map(JSON.stringify).join('\n');

test('validates a native Codex session against its benchmark run', () => {
  assert.deepEqual(validateNativeCodexSession(fixture, {
    sessionId: 'run-1',
    model: 'gpt-5.6-luna',
    prompt: 'Build the agent.',
  }), {
    sessionId: 'run-1',
    eventCount: 5,
    turnCount: 1,
    userMessageCount: 1,
    toolCallCount: 1,
    cliVersion: '0.144.0',
  });
});

test('rejects a CLI event stream masquerading as a native session', () => {
  assert.throws(() => validateNativeCodexSession('{"type":"thread.started","thread_id":"run-1"}\n'), /session_meta/);
});

test('rejects mismatched session identity, model, or prompt', () => {
  assert.throws(() => validateNativeCodexSession(fixture, { sessionId: 'run-2' }), /ID does not match/);
  assert.throws(() => validateNativeCodexSession(fixture, { model: 'gpt-5.6-sol' }), /does not record model/);
  assert.throws(() => validateNativeCodexSession(fixture, { prompt: 'Different prompt.' }), /exact benchmark prompt/);
});
