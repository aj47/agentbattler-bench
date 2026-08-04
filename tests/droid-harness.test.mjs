import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDroidSettings,
  DROID_BINARY_SHA256,
  DROID_CONTEXT_POLICY,
  DROID_MODEL_FAMILIES,
  DROID_RESTRICTED_TOOLS,
  droidCompactionTelemetry,
  droidCustomModelId,
  droidExecArgs,
  droidUpstreamModel,
  normalizeDroidBaseUrl,
  parseDroidEventStream,
  summarizeDroidEvents,
} from '../src/droid-harness.mjs';

test('Droid settings pin the 9Router model IDs, output budget, and compaction policy', () => {
  const settings = createDroidSettings({ baseUrl: 'http://127.0.0.1:20128' });
  assert.equal(DROID_CONTEXT_POLICY.contextWindowTokens, 272_000);
  assert.equal(DROID_BINARY_SHA256, 'e7b078bd61d3850ec21095719721d0bda808212abfa5076da270975b62e4fa68');
  assert.equal(DROID_CONTEXT_POLICY.effectiveContextWindowTokens, 258_400);
  assert.equal(DROID_CONTEXT_POLICY.compactionTokenLimit, 206_720);
  assert.equal(settings.compactionTokenLimit, 206_720);
  assert.equal(settings.compactionModel, 'same');
  assert.deepEqual(settings.modelFallbacks, {});
  assert.equal(settings.cloudSessionSync, false);
  assert.equal(settings.hooksDisabled, true);
  assert.deepEqual(settings.customModels.map((model) => model.model), DROID_MODEL_FAMILIES.map((family) => family.upstreamModel));
  assert.ok(settings.customModels.every((model) => model.baseUrl === 'http://127.0.0.1:20128/v1'));
  assert.ok(settings.customModels.every((model) => model.apiKey === '${AGENTBATTLER_DROID_API_KEY}'));
  assert.ok(settings.customModels.every((model) => model.maxContextLimit === 272_000));
  assert.ok(settings.customModels.every((model) => model.maxOutputTokens === 32_768));
  assert.ok(settings.customModels.every((model) => model.extraArgs.reasoning_effort === undefined));
  assert.ok(settings.customModels.every((model) => model.extraArgs.max_output_tokens === 32_768));
  assert.ok(settings.customModels.every((model) => model.provider === 'openai'));
  assert.equal(droidUpstreamModel('gpt-5.6-sol'), 'cx/gpt-5.6-sol');
  assert.deepEqual(createDroidSettings({ baseUrl: 'http://127.0.0.1:8317', upstreamModelPrefix: '' }).customModels.map((model) => model.model), [
    'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.6-luna',
  ]);
});

test('Droid compaction telemetry records native boundaries and nearby usage', () => {
  const telemetry = droidCompactionTelemetry([
    { type: 'usage', usage: { input_tokens: 190_000, cache_read_input_tokens: 10_000 } },
    { type: 'system', subtype: 'compaction_boundary', timestamp: 1_785_800_000_000, metadata: { trigger: 'auto' } },
    { type: 'completion', usage: { input_tokens: 24_000 } },
  ]);
  assert.deepEqual(telemetry, {
    count: 1,
    boundaries: [{ index: 1, timestamp: 1_785_800_000_000, trigger: 'auto', beforeTokens: 200_000, afterTokens: 24_000, summaryId: null, removedCount: null, visibleBoundaryMessageId: null }],
  });
});

test('Droid compaction telemetry recognizes nested JSON-RPC notifications', () => {
  const telemetry = droidCompactionTelemetry([
    { type: 'notification', params: { notification: { type: 'session_token_usage_changed', tokenUsage: { inputTokens: 205_000, cacheReadTokens: 500 } } } },
    { type: 'notification', params: { notification: { type: 'session_compacted', summaryId: 'summary-1', removedCount: 20 } } },
    { type: 'notification', params: { notification: { type: 'session_token_usage_changed', tokenUsage: { inputTokens: 28_000 } } } },
  ]);
  assert.equal(telemetry.count, 1);
  assert.equal(telemetry.boundaries[0].beforeTokens, 205_500);
  assert.equal(telemetry.boundaries[0].afterTokens, 28_000);
  assert.equal(telemetry.boundaries[0].summaryId, 'summary-1');
  assert.equal(telemetry.boundaries[0].removedCount, 20);
});

test('Droid custom aliases and exec arguments are deterministic and restricted', () => {
  assert.equal(droidCustomModelId('gpt-5.6-sol'), 'custom:AgentBattler-GPT-5.6-Sol-0');
  const args = droidExecArgs({ workspace: '/tmp/workspace', model: 'gpt-5.6-sol', sessionId: 'session-1', promptFile: '/tmp/prompt.txt' });
  assert.equal(args[0], 'exec');
  assert.equal(args[args.indexOf('--model') + 1], 'custom:AgentBattler-GPT-5.6-Sol-0');
  assert.equal(args[args.indexOf('--reasoning-effort') + 1], 'high');
  assert.equal(args[args.indexOf('--restrict-tools') + 1], DROID_RESTRICTED_TOOLS.join(','));
  assert.equal(args[args.indexOf('--session-id') + 1], 'session-1');
  assert.equal(args[args.indexOf('--file') + 1], '/tmp/prompt.txt');
  assert.equal(args.includes('-'), false);
});

test('Droid base URL normalization rejects credentials and non-HTTP protocols', () => {
  assert.equal(normalizeDroidBaseUrl('https://router.example.test/openai/'), 'https://router.example.test/openai/v1');
  assert.throws(() => normalizeDroidBaseUrl('file:///tmp/router'), /HTTP or HTTPS/);
  assert.throws(() => normalizeDroidBaseUrl('https://user:secret@example.test/v1'), /must not contain credentials/);
});

test('Droid event summary proves success, session continuity fields, tools, and usage', () => {
  const events = parseDroidEventStream([
    JSON.stringify({ type: 'system', session_id: 'session-1' }),
    JSON.stringify({ type: 'tool_call', tool: 'Read' }),
    JSON.stringify({ type: 'usage', input_tokens: 100, cached_input_tokens: 20, output_tokens: 10, reasoning_tokens: 4 }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'session-1' }),
    '',
  ].join('\n'));
  assert.deepEqual(summarizeDroidEvents(events), {
    sessionId: 'session-1',
    result: events[3],
    eventCount: 4,
    toolCallCount: 1,
    toolCallBreakdown: { Read: 1 },
    usage: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 10, reasoningTokens: 4 },
  });
});
