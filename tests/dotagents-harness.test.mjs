import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  DOTAGENTS_IMAGE,
  DOTAGENTS_SANDBOX_REVISION,
  DOTAGENTS_V7_IMAGE,
  DOTAGENTS_V7_IMAGE_SCHEMA,
  DOTAGENTS_V7_IMAGE_SOURCE_SCHEMA,
  DOTAGENTS_V7_SANDBOX_REVISION,
  DOTAGENTS_V7_SOURCE_LABEL,
  DOTAGENTS_V7_SOURCE_PATHS,
  buildDotAgentsDockerArgs,
  createDotAgentsConfig,
  dotAgentsV7ImageSourceDescriptor,
  dotAgentsCumulativeUsageDelta,
  dotAgentsTerminalUsage,
  networkCommandReason,
  summarizeDotAgentsTrace,
  validateDotAgentsV7ImageInspection,
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
  assert.equal(mcp.mcpUnlimitedIterations, false);
  assert.deepEqual(profile.toolConfig.enabledRuntimeTools, ['execute_command']);
  assert.equal(profile.toolConfig.allServersDisabledByDefault, true);
  assert.equal(profile.skillsConfig.allSkillsDisabledByDefault, true);
});

test('can configure a stateful DotAgents benchmark profile', () => {
  const config = createDotAgentsConfig({ model: 'gpt-5.6-terra', remoteApiKey: 'a'.repeat(64), stateful: true });
  assert.match(config.files['agents/agentbattler-benchmark/agent.md'], /isStateful: true/);
  assert.equal(config.generationSettings.stateful, true);
  assert.equal(config.generationSettings.unlimitedIterations, false);
});

test('V6 DotAgents uses max reasoning, a larger turn budget, and explicit completion', () => {
  const config = createDotAgentsConfig({
    model: 'gpt-5.6-luna',
    remoteApiKey: 'a'.repeat(64),
    reasoningEffort: 'max',
    maxIterations: 32,
    enableCompletionTool: true,
  });
  const models = JSON.parse(config.files['models.json']);
  const mcp = JSON.parse(config.files['mcp.json']);
  const profile = JSON.parse(config.files['agents/agentbattler-benchmark/config.json']);
  assert.equal(models.openaiReasoningEffort, 'max');
  assert.equal(mcp.mcpMaxIterations, 32);
  assert.deepEqual(profile.toolConfig.enabledRuntimeTools, ['execute_command', 'mark_work_complete']);
  assert.equal(config.generationSettings.explicitCompletionTool, true);
});

test('can route DotAgents through a pinned OpenAI-compatible proxy', () => {
  const config = createDotAgentsConfig({
    model: 'gpt-5.6-luna',
    remoteApiKey: 'a'.repeat(64),
    openaiProxy: { baseUrl: 'http://agentbattler-cliproxy:8317/v1', apiKey: 'b'.repeat(64) },
  });
  const models = JSON.parse(config.files['models.json']);
  const profile = JSON.parse(config.files['agents/agentbattler-benchmark/config.json']);
  assert.equal(models.agentProviderId, 'openai');
  assert.equal(models.agentOpenaiModel, 'gpt-5.6-luna');
  assert.equal(models.openaiBaseUrl, 'http://agentbattler-cliproxy:8317/v1');
  assert.equal(models.openaiApiKey, 'b'.repeat(64));
  assert.equal(models.openaiCompatiblePromptCaching, 'cliproxy');
  assert.equal(models.currentModelPresetId, 'agentbattler-cliproxy');
  assert.equal(models.modelPresets[0].agentModel, 'gpt-5.6-luna');
  assert.equal(config.legacyConfig.openaiApiKey, 'b'.repeat(64));
  assert.equal(profile.modelConfig.agentProviderId, 'openai');
  assert.equal(config.generationSettings.transport, 'cliproxyapi');
  assert.equal(config.generationSettings.promptCaching, 'cliproxy');
});

test('normalizes cumulative DotAgents usage without double counting previous turns', () => {
  const first = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 60, cacheWriteTokens: 0, reasoningTokens: 10 };
  const second = { inputTokens: 250, outputTokens: 45, cacheReadTokens: 190, cacheWriteTokens: 0, reasoningTokens: 18 };
  assert.deepEqual(dotAgentsCumulativeUsageDelta(null, first), first);
  assert.deepEqual(dotAgentsCumulativeUsageDelta(first, second), {
    inputTokens: 150,
    outputTokens: 25,
    cacheReadTokens: 130,
    cacheWriteTokens: 0,
    reasoningTokens: 8,
  });
  assert.deepEqual(dotAgentsTerminalUsage(second), {
    inputTokens: 250,
    cachedInputTokens: 190,
    outputTokens: 45,
    reasoningTokens: 18,
  });
  assert.throws(() => dotAgentsCumulativeUsageDelta(second, first), /decreased/);
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
  const limited = summarizeDotAgentsTrace([
    { type: 'progress', data: { modelInfo: { model: 'gpt-5.6-sol' }, currentIteration: 32, steps: [] } },
    { type: 'done', data: { model: 'gpt-5.6-sol', content: 'maximum iterations reached', conversation_id: 'c1', conversation_history: [] } },
  ], 'gpt-5.6-sol', { maxIterations: 32 });
  assert.equal(limited.iterationLimitReached, true);
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
  assert.equal(DOTAGENTS_SANDBOX_REVISION, 'r5');
  assert.match(DOTAGENTS_IMAGE, /-r5$/);
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('no-new-privileges'));
  assert.ok(args.includes('seccomp=unconfined'));
  assert.deepEqual(args.slice(args.indexOf('--cap-add'), args.indexOf('--cap-add') + 2), ['--cap-add', 'SYS_ADMIN']);
  assert.ok(args.includes('NET_ADMIN'));
  assert.ok(args.includes('127.0.0.1:40123:3210'));
  assert.ok(args.includes('DOTAGENTS_WORKSPACE_DIR=/workspace'));
});

test('DotAgents images preserve R5 and add a separately tagged V7 control boundary', async () => {
  const [dockerfile, v7Dockerfile, dockerignore, sandboxPatch, v7SandboxPatch, maxReasoningPatch, packageDocument] = await Promise.all([
    readFile(path.resolve(import.meta.dirname, '..', 'harnesses', 'dotagents', 'Dockerfile'), 'utf8'),
    readFile(path.resolve(import.meta.dirname, '..', 'harnesses', 'dotagents', 'Dockerfile.v7'), 'utf8'),
    readFile(path.resolve(import.meta.dirname, '..', 'harnesses', 'dotagents', '.dockerignore'), 'utf8'),
    readFile(path.resolve(import.meta.dirname, '..', 'harnesses', 'dotagents', 'runtime-tools-sandbox.patch'), 'utf8'),
    readFile(path.resolve(import.meta.dirname, '..', 'harnesses', 'dotagents', 'runtime-tools-sandbox-v7.patch'), 'utf8'),
    readFile(path.resolve(import.meta.dirname, '..', 'harnesses', 'dotagents', 'enable-max-reasoning.mjs'), 'utf8'),
    readFile(path.resolve(import.meta.dirname, '..', 'package.json'), 'utf8').then(JSON.parse),
  ]);
  assert.match(dockerfile, /bubblewrap/);
  assert.match(dockerfile, /git -C \/opt\/dotagents apply --check/);
  assert.match(sandboxPatch, /--unshare-net/);
  assert.match(sandboxPatch, /--unshare-pid/);
  assert.match(sandboxPatch, /--cap-drop\", \"ALL/);
  assert.match(sandboxPatch, /--clearenv/);
  assert.match(sandboxPatch, /AGENTBATTLER_COMMAND_ENV/);
  const additions = sandboxPatch.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).join('\n');
  assert.doesNotMatch(additions, /\.\.\.process\.env/);
  assert.match(sandboxPatch, /--bind\", AGENTBATTLER_WORKSPACE, AGENTBATTLER_WORKSPACE/);
  assert.doesNotMatch(sandboxPatch, /readOnlyControlRoot/);
  assert.match(v7SandboxPatch, /--ro-bind\", readOnlyControlRoot, readOnlyControlRoot/);
  assert.equal(DOTAGENTS_V7_SANDBOX_REVISION, 'v7-r1');
  assert.match(DOTAGENTS_V7_IMAGE, /-v7-r1$/);
  assert.match(dockerfile, /io\.agentbattler\.command-sandbox="r5"/);
  assert.match(dockerfile, /COPY runtime-tools-sandbox\.patch/);
  assert.doesNotMatch(dockerfile, /runtime-tools-sandbox-v7|AGENTBATTLER_V7_SOURCE_SHA256/);
  assert.match(v7Dockerfile, /ARG AGENTBATTLER_V7_SOURCE_SHA256/);
  assert.match(v7Dockerfile, /io\.agentbattler\.v7\.source-sha256="\$\{AGENTBATTLER_V7_SOURCE_SHA256\}"/);
  assert.match(v7Dockerfile, /io\.agentbattler\.command-sandbox="v7-r1"/);
  assert.match(v7Dockerfile, /COPY runtime-tools-sandbox-v7\.patch/);
  assert.equal(packageDocument.scripts['dotagents:image:v7'], 'node scripts/build-dotagents-v7-image.mjs');
  assert.match(dockerignore, /^!Dockerfile\.v7$/m);
  assert.match(dockerignore, /^!runtime-tools-sandbox-v7\.patch$/m);
  assert.match(v7Dockerfile, /enable-max-reasoning\.mjs/);
  assert.match(maxReasoningPatch, /"xhigh", "max"/);
  assert.match(maxReasoningPatch, /reasoning_effort/);
});

test('can attach the DotAgents container to an isolated proxy network', () => {
  const args = buildDotAgentsDockerArgs({
    name: 'agentbattler-dotagents-test', hostPort: 40123,
    home: '/tmp/home', configRoot: '/tmp/config', workspace: '/tmp/workspace',
    network: 'agentbattler-cliproxy',
  });
  assert.deepEqual(args.slice(args.indexOf('--network'), args.indexOf('--network') + 2), ['--network', 'agentbattler-cliproxy']);
});

test('V7 can make its trusted current-control subtree read-only inside model commands', () => {
  const args = buildDotAgentsDockerArgs({
    name: 'agentbattler-dotagents-v7-test', hostPort: 40124,
    home: '/tmp/home', configRoot: '/tmp/config', workspace: '/tmp/workspace',
    readOnlyControl: true,
  });
  assert.ok(args.includes('AGENTBATTLER_V7_CONTROL_ROOT=/workspace/.agentbattler'));
  assert.throws(() => buildDotAgentsDockerArgs({
    name: 'agentbattler-dotagents-v7-test', hostPort: 40124,
    home: '/tmp/home', configRoot: '/tmp/config', workspace: '/tmp/workspace',
    readOnlyControl: 'yes',
  }), /readOnlyControl/);
});

test('V7 binds the mutable DotAgents tag to one reviewed, labeled Linux arm64 image ID', async () => {
  const source = await dotAgentsV7ImageSourceDescriptor({ repositoryRoot: path.resolve(import.meta.dirname, '..') });
  assert.equal(source.schemaVersion, DOTAGENTS_V7_IMAGE_SOURCE_SCHEMA);
  assert.deepEqual(source.files.map(({ path: sourcePath }) => sourcePath), DOTAGENTS_V7_SOURCE_PATHS);
  assert.match(source.sourceSha256, /^[0-9a-f]{64}$/);
  const imageId = `sha256:${'a'.repeat(64)}`;
  const inspection = [{
    Id: imageId,
    Os: 'linux',
    Architecture: 'arm64',
    RepoTags: [DOTAGENTS_V7_IMAGE],
    Config: { Labels: {
      'org.opencontainers.image.revision': 'fd76e502e551d5266ce50a5ed4b1536ed7323e26',
      'org.opencontainers.image.version': '1.1.9',
      'io.agentbattler.command-sandbox': DOTAGENTS_V7_SANDBOX_REVISION,
      [DOTAGENTS_V7_SOURCE_LABEL]: source.sourceSha256,
    } },
  }];
  const descriptor = validateDotAgentsV7ImageInspection(inspection, {
    expectedImageId: imageId,
    expectedSourceSha256: source.sourceSha256,
  });
  assert.equal(descriptor.schemaVersion, DOTAGENTS_V7_IMAGE_SCHEMA);
  assert.equal(descriptor.imageId, imageId);
  assert.equal(descriptor.sourceSha256, source.sourceSha256);
  assert.throws(
    () => validateDotAgentsV7ImageInspection(inspection, {
      expectedImageId: `sha256:${'b'.repeat(64)}`,
      expectedSourceSha256: source.sourceSha256,
    }),
    /does not match the sealed runtime/,
  );
  const retagged = structuredClone(inspection);
  retagged[0].RepoTags = ['agentbattler-dotagents:retagged'];
  assert.throws(() => validateDotAgentsV7ImageInspection(retagged, { expectedSourceSha256: source.sourceSha256 }), /tag does not resolve/);
  const relabeled = structuredClone(inspection);
  relabeled[0].Config.Labels['io.agentbattler.command-sandbox'] = 'r5';
  assert.throws(() => validateDotAgentsV7ImageInspection(relabeled, { expectedSourceSha256: source.sourceSha256 }), /sandbox label changed/);
  const sourceRelabeled = structuredClone(inspection);
  sourceRelabeled[0].Config.Labels[DOTAGENTS_V7_SOURCE_LABEL] = 'b'.repeat(64);
  assert.throws(() => validateDotAgentsV7ImageInspection(sourceRelabeled, { expectedSourceSha256: source.sourceSha256 }), /reviewed source label changed/);
});

test('V7 DotAgents adapter and strict verifier re-inspect the sealed image and run its immutable ID', async () => {
  const [adapter, verifier] = await Promise.all([
    readFile(path.resolve(import.meta.dirname, '..', 'scripts', 'terminal-adapter-dotagents.mjs'), 'utf8'),
    readFile(path.resolve(import.meta.dirname, '..', 'scripts', 'verify-terminal-v7-results.mjs'), 'utf8'),
  ]);
  assert.match(adapter, /const executionImage = imageIdentity\?\.imageId \?\? image/);
  assert.match(adapter, /startContainer\(runDirectory, job, \{ image: executionImage/);
  assert.match(verifier, /inspectDotAgentsV7Image\(\{/);
  assert.match(verifier, /inspectTerminalV7VerifierImage\(\{/);
  assert.match(verifier, /runtime image differs from the sealed descriptor/);
});
