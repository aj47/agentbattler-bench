import assert from 'node:assert/strict';
import test from 'node:test';

import { parseAmpEventStream } from '../src/amp-stream.mjs';
import { createInfrastructureInvalidRun } from '../src/terminal-runner.mjs';

const SESSION = 'T-12345678-1234-1234-1234-123456789abc';

function stream({ sessionId = SESSION, result = true, tools = ['Read', 'shell_command'], subtype = 'success', isError = false } = {}) {
  const events = [
    { type: 'system', subtype: 'init', session_id: sessionId, agent_mode: 'high', tools, mcp_servers: [] },
    { type: 'assistant', session_id: sessionId, message: { model: 'gpt-test', content: [{ type: 'tool_use', name: 'Read' }], usage: { input_tokens: 10, cache_creation_input_tokens: 3, cache_read_input_tokens: 4, output_tokens: 5, reasoning_tokens: 2 } } },
  ];
  if (result) events.push({ type: 'result', subtype, is_error: isError, session_id: sessionId, duration_ms: 123, result: subtype });
  return events.map(JSON.stringify).join('\n');
}

test('Amp stream captures native identity, model, tools, duration, and token usage', () => {
  assert.deepEqual(parseAmpEventStream(stream()), {
    sessionId: SESSION,
    eventCount: 3,
    toolCalls: 1,
    usage: { inputTokens: 17, cachedInputTokens: 4, outputTokens: 5, reasoningTokens: 2 },
    agentMode: 'high',
    models: ['gpt-test'],
    durationMs: 123,
    resultSubtype: 'success',
    complete: true,
  });
});

test('Amp stream fails closed on malformed output and authentication-style failures', () => {
  assert.throws(() => parseAmpEventStream(`${stream()}\nnot-json`), /JSON parse failed on line 4/);
  assert.throws(() => parseAmpEventStream(stream({ subtype: 'error', isError: true })), /Amp turn failed/);
  assert.throws(() => parseAmpEventStream(stream({ tools: ['Read', 'find_thread'] })), /forbidden tools: find_thread/);
  const invalid = createInfrastructureInvalidRun({ runKey: 'run', challengeId: 'challenge', challengeSha256: 'sha', comboId: 'combo', artifactId: 'artifact', generationIndex: 1, repeat: 1, seed: 1 }, new Error('AMP_API_KEY authentication failed'), { adapter: 'amp-code' });
  assert.equal(invalid.status, 'infrastructure-invalid');
  assert.match(invalid.error, /AMP_API_KEY/);
});

test('Amp stream proves resume and preserves partial timeout telemetry', () => {
  assert.equal(parseAmpEventStream(stream(), { expectedSessionId: SESSION }).sessionId, SESSION);
  assert.throws(() => parseAmpEventStream(stream(), { expectedSessionId: 'T-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }), /different native thread/);
  const partial = parseAmpEventStream(stream({ result: false }), { expectedSessionId: SESSION, allowIncomplete: true });
  assert.equal(partial.complete, false);
  assert.equal(partial.sessionId, SESSION);
  assert.throws(() => parseAmpEventStream(stream({ result: false })), /missing its terminal result/);
  assert.deepEqual(parseAmpEventStream('', { allowIncomplete: true }).sessionId, null);
  assert.equal(parseAmpEventStream('{"type":', { expectedSessionId: SESSION, allowIncomplete: true }).sessionId, SESSION);
});

test('Amp stream rejects malformed tool and numeric telemetry', () => {
  assert.throws(() => parseAmpEventStream(stream({ tools: null })), /tools are malformed/);
  const malformed = stream().replace('"input_tokens":10', '"input_tokens":"10"');
  assert.throws(() => parseAmpEventStream(malformed), /malformed numeric telemetry/);
});
