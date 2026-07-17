import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DOTAGENTS_IMAGE,
  buildDotAgentsDockerArgs,
  createDotAgentsConfig,
  networkCommandReason,
  summarizeDotAgentsTrace,
} from '../src/dotagents-harness.mjs';

test('creates an isolated DotAgents configuration for the requested model', () => {
  const config = createDotAgentsConfig({ model: 'gpt-5.6-terra', remoteApiKey: 'a'.repeat(64) });
  const models = JSON.parse(config.files['models.json']);
  const mcp = JSON.parse(config.files['mcp.json']);
  const profile = JSON.parse(config.files['agents/agentbattler-benchmark/config.json']);
  assert.equal(models.agentChatgptWebModel, 'gpt-5.6-terra');
  assert.equal(models.openaiReasoningEffort, 'high');
  assert.deepEqual(mcp.mcpConfig, { mcpServers: {} });
  assert.equal(mcp.mcpParallelToolExecution, false);
  assert.deepEqual(profile.toolConfig.enabledRuntimeTools, ['execute_command']);
  assert.equal(profile.toolConfig.allServersDisabledByDefault, true);
  assert.equal(profile.skillsConfig.allSkillsDisabledByDefault, true);
});

test('summarizes a sealed trace and rejects model, tool, and network drift', () => {
  const events = [
    { type: 'progress', data: { modelInfo: { model: 'gpt-5.6-sol' }, steps: [{ toolCall: { id: 'one', name: 'execute_command', arguments: { command: 'node --check agent.js' } } }], sessionCost: { inputTokens: 10, outputTokens: 5 } } },
    { type: 'done', data: { model: 'gpt-5.6-sol', content: 'done', conversation_id: 'c1', conversation_history: [{ role: 'assistant', toolCalls: [{ id: 'one', name: 'execute_command', arguments: { command: 'node --check agent.js' } }] }] } },
  ];
  const summary = summarizeDotAgentsTrace(events, 'gpt-5.6-sol');
  assert.equal(summary.toolCallCount, 1);
  assert.deepEqual(summary.toolCallBreakdown, { execute_command: 1 });
  assert.equal(summary.sessionCost.inputTokens, 10);
  assert.throws(() => summarizeDotAgentsTrace(events, 'gpt-5.6-luna'), /model mismatch/);
  assert.throws(() => summarizeDotAgentsTrace([
    { type: 'progress', data: { modelInfo: { model: 'gpt-5.6-sol' }, steps: [{ toolCall: { name: 'execute_command', arguments: { command: 'curl https:\/\/example.com' } } }] } },
    events[1],
  ], 'gpt-5.6-sol'), /no-network/);
  assert.equal(networkCommandReason('node --check agent.js'), null);
  assert.equal(networkCommandReason('wget example.com'), 'network-capable command');
});

test('builds a locked-down loopback-only Docker invocation', () => {
  const args = buildDotAgentsDockerArgs({
    name: 'agentbattler-dotagents-test', hostPort: 40123,
    home: '/tmp/home', configRoot: '/tmp/config', workspace: '/tmp/workspace',
  });
  assert.equal(args.at(-1), DOTAGENTS_IMAGE);
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('no-new-privileges'));
  assert.ok(args.includes('127.0.0.1:40123:3210'));
  assert.ok(args.includes('DOTAGENTS_WORKSPACE_DIR=/config-workspace'));
});
