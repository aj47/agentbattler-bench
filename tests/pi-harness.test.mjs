import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPiDockerArgs,
  parsePiEventStream,
  PI_IMAGE,
  PI_TOOLS,
  piSubscriptionAuthFromCodex,
  validateNativePiSession,
  validatePiSubscriptionAuth,
} from '../src/pi-harness.mjs';

test('requires Pi and Codex to use the same ChatGPT subscription account', () => {
  const result = validatePiSubscriptionAuth(
    { auth_mode: 'chatgpt', tokens: { account_id: 'account-1' } },
    { 'openai-codex': { type: 'oauth', access: 'access', refresh: 'refresh', expires: 123, accountId: 'account-1' } },
  );
  assert.deepEqual(result, {
    method: 'chatgpt',
    provider: 'openai-codex',
    subscriptionAccess: true,
    sameAccountAsCodex: true,
  });
  assert.throws(() => validatePiSubscriptionAuth(
    { auth_mode: 'chatgpt', tokens: { account_id: 'account-1' } },
    { 'openai-codex': { type: 'oauth', access: 'access', refresh: 'refresh', expires: 123, accountId: 'account-2' } },
  ), /different ChatGPT accounts/);
});

test('creates an ephemeral Pi openai-codex credential from current Codex subscription auth', () => {
  const payload = Buffer.from(JSON.stringify({ exp: 2_000_000_000 })).toString('base64url');
  const codex = {
    auth_mode: 'chatgpt',
    tokens: { access_token: `header.${payload}.sig`, refresh_token: 'refresh', account_id: 'account-1' },
  };
  const result = piSubscriptionAuthFromCodex(codex, { now: 1_900_000_000_000 });
  assert.equal(result.document['openai-codex'].access, codex.tokens.access_token);
  assert.equal(result.document['openai-codex'].refresh, 'refresh');
  assert.equal(result.document['openai-codex'].expires, 2_000_000_000_000);
  assert.equal(result.authentication.sameAccountAsCodex, true);
  assert.throws(() => piSubscriptionAuthFromCodex(codex, { now: 1_999_999_000_000 }), /expires too soon/);
});

test('builds a read-only, capability-free Pi container with only ephemeral mounts', () => {
  const args = buildPiDockerArgs({
    model: 'gpt-5.6-luna',
    prompt: 'Build agent.js',
    workspace: '/tmp/workspace',
    piHome: '/tmp/pi-home',
    user: '501:20',
  });
  assert.equal(args[0], 'run');
  assert.ok(args.includes(PI_IMAGE));
  assert.ok(args.includes('--read-only'));
  assert.deepEqual(args.slice(args.indexOf('--cap-drop'), args.indexOf('--cap-drop') + 2), ['--cap-drop', 'ALL']);
  assert.deepEqual(args.filter((value) => value.endsWith(':rw')), ['/tmp/workspace:/workspace:rw', '/tmp/pi-home:/pi-home:rw']);
  assert.ok(args.includes('--no-extensions'));
  assert.ok(args.includes('--no-skills'));
  assert.ok(args.includes('--no-context-files'));
  assert.ok(!args.includes('--offline'));
  assert.deepEqual(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2), ['--tools', PI_TOOLS.join(',')]);
  assert.deepEqual(args.slice(args.indexOf('--provider'), args.indexOf('--provider') + 2), ['--provider', 'openai-codex']);
});

const nativeSession = [
  { type: 'session', version: 3, id: 'pi-run-1', timestamp: '2026-07-15T00:00:00Z', cwd: '/workspace' },
  { type: 'thinking_level_change', id: '00000001', parentId: null, timestamp: '2026-07-15T00:00:01Z', thinkingLevel: 'high' },
  { type: 'message', id: '00000002', parentId: '00000001', timestamp: '2026-07-15T00:00:02Z', message: { role: 'user', content: 'Build agent.js' } },
  { type: 'message', id: '00000003', parentId: '00000002', timestamp: '2026-07-15T00:00:03Z', message: {
    role: 'assistant', provider: 'openai-codex', model: 'gpt-5.6-luna',
    content: [{ type: 'toolCall', id: 'call-1', name: 'write', arguments: { path: 'agent.js' } }],
    usage: { input: 10, output: 20, cacheRead: 3, cacheWrite: 0, totalTokens: 33 },
  } },
  { type: 'message', id: '00000004', parentId: '00000003', timestamp: '2026-07-15T00:00:04Z', message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'write', content: [] } },
].map(JSON.stringify).join('\n');

test('validates a native Pi session and extracts comparable telemetry', () => {
  assert.deepEqual(validateNativePiSession(nativeSession, {
    sessionId: 'pi-run-1', model: 'gpt-5.6-luna', prompt: 'Build agent.js',
  }), {
    sessionId: 'pi-run-1', sessionVersion: 3, eventCount: 5, turnCount: 1, userMessageCount: 1,
    toolCallCount: 1, toolCallBreakdown: { write: 1 }, mcpCallCount: 0,
    provider: 'openai-codex', model: 'gpt-5.6-luna', extensionEntryCount: 0,
    inputTokens: 10, outputTokens: 20, cacheReadTokens: 3, cacheWriteTokens: 0, totalTokens: 33,
  });
});

test('rejects wrong providers, extension injection, unexpected tools, and host context', () => {
  assert.throws(() => validateNativePiSession(nativeSession.replace('openai-codex', 'openai')), /provider other than openai-codex/);
  assert.throws(() => validateNativePiSession(`${nativeSession}\n${JSON.stringify({ type: 'custom', id: '5', parentId: '4' })}`), /extension-injected/);
  assert.throws(() => validateNativePiSession(nativeSession.replace('"write"', '"mcp_call"')), /unexpected tools/);
  assert.throws(() => validateNativePiSession(nativeSession, { forbiddenText: ['Build agent.js'] }), /forbidden host context/);
});

test('parses Pi JSON events without double-counting streamed message updates', () => {
  const events = [
    { type: 'session', version: 3, id: 'pi-run-1', cwd: '/workspace' },
    { type: 'agent_start' },
    { type: 'turn_start' },
    { type: 'message_update', message: { role: 'assistant', usage: { totalTokens: 99 } } },
    { type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'write', args: {} },
    { type: 'message_end', message: { role: 'assistant', usage: { input: 10, output: 20, cacheRead: 3, cacheWrite: 0, totalTokens: 33 } } },
    { type: 'turn_end', message: { role: 'assistant' }, toolResults: [] },
    { type: 'agent_end', messages: [] },
  ].map(JSON.stringify).join('\n');
  const result = parsePiEventStream(events);
  assert.equal(result.sessionId, 'pi-run-1');
  assert.equal(result.turnCount, 1);
  assert.equal(result.toolCallCount, 1);
  assert.equal(result.totalTokens, 33);
  assert.equal(result.mcpCallCount, 0);
});
