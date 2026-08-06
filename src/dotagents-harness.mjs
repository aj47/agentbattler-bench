import path from 'node:path';

import { canonicalJsonSha256 } from './provenance.mjs';
import { terminalHarnessVersion } from './terminal-harness-versions.mjs';

export const DOTAGENTS_COMMIT = 'fd76e502e551d5266ce50a5ed4b1536ed7323e26';
export const DOTAGENTS_VERSION = terminalHarnessVersion('dotagents-mono');
export const DOTAGENTS_SANDBOX_REVISION = 'r4';
export const DOTAGENTS_IMAGE = `agentbattler-dotagents:${DOTAGENTS_COMMIT.slice(0, 12)}-${DOTAGENTS_SANDBOX_REVISION}`;
export const DOTAGENTS_PROFILE_ID = 'agentbattler-benchmark';
export const DOTAGENTS_RUNTIME_TOOLS = Object.freeze(['execute_command', 'mark_work_complete']);
export const DOTAGENTS_DEFAULT_MAX_ITERATIONS = 12;
export const DOTAGENTS_V6_MAX_ITERATIONS = 32;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function createDotAgentsConfig({
  model,
  remoteApiKey,
  remotePort = 3210,
  stateful = false,
  openaiProxy = null,
  reasoningEffort = 'high',
  maxIterations = DOTAGENTS_DEFAULT_MAX_ITERATIONS,
  enableCompletionTool = false,
}) {
  invariant(typeof model === 'string' && /^gpt-5\.6-(terra|sol|luna)$/.test(model), `Unsupported DotAgents benchmark model: ${model}`);
  invariant(typeof remoteApiKey === 'string' && remoteApiKey.length >= 32, 'DotAgents benchmark API key is missing');
  invariant(Number.isSafeInteger(remotePort) && remotePort > 0 && remotePort <= 65_535, 'Invalid DotAgents remote port');
  invariant(typeof reasoningEffort === 'string' && reasoningEffort.length > 0, 'DotAgents reasoning effort is required');
  invariant(Number.isSafeInteger(maxIterations) && maxIterations > 0, 'DotAgents max iterations must be a positive integer');
  invariant(typeof enableCompletionTool === 'boolean', 'DotAgents completion-tool policy must be boolean');
  if (openaiProxy) {
    invariant(typeof openaiProxy.baseUrl === 'string' && /^http:\/\/[^/]+(?::\d+)?\/v1\/?$/.test(openaiProxy.baseUrl), 'DotAgents proxy base URL must be an HTTP /v1 endpoint');
    invariant(typeof openaiProxy.apiKey === 'string' && openaiProxy.apiKey.length >= 32, 'DotAgents proxy API key is missing');
  }

  const providerId = openaiProxy ? 'openai' : 'chatgpt-web';

  const settings = {
    mainAgentMode: 'api',
    remoteServerEnabled: true,
    remoteServerPort: remotePort,
    remoteServerBindAddress: '127.0.0.1',
    remoteServerApiKey: remoteApiKey,
    remoteServerCorsOrigins: [],
    remoteServerAutoShowPanel: false,
    discordEnabled: false,
    whatsappEnabled: false,
  };
  const models = {
    agentProviderId: providerId,
    mcpToolsProviderId: providerId,
    ...(openaiProxy ? {
      agentOpenaiModel: model,
      mcpToolsOpenaiModel: model,
      openaiBaseUrl: openaiProxy.baseUrl.replace(/\/$/, ''),
      openaiApiKey: openaiProxy.apiKey,
      openaiCompatiblePromptCaching: 'cliproxy',
      currentModelPresetId: 'agentbattler-cliproxy',
      modelPresets: [{
        id: 'agentbattler-cliproxy',
        name: 'AgentBattler CLIProxyAPI',
        baseUrl: openaiProxy.baseUrl.replace(/\/$/, ''),
        apiKey: openaiProxy.apiKey,
        isBuiltIn: false,
        createdAt: 0,
        updatedAt: 0,
        agentModel: model,
        mcpToolsModel: model,
      }],
    } : {
      agentChatgptWebModel: model,
      mcpToolsChatgptWebModel: model,
      chatgptWebBaseUrl: 'https://chatgpt.com',
    }),
    openaiReasoningEffort: reasoningEffort,
    codexTextVerbosity: 'medium',
  };
  const mcp = {
    mcpConfig: { mcpServers: {} },
    mcpMaxIterations: maxIterations,
    mcpUnlimitedIterations: false,
    mcpVerifyCompletionEnabled: true,
    mcpVerifyRetryCount: 1,
    mcpFinalSummaryEnabled: false,
    mcpParallelToolExecution: false,
    mcpMessageQueueEnabled: false,
  };
  const profileMarkdown = `---\nkind: agent\nid: ${DOTAGENTS_PROFILE_ID}\nname: AgentBattler Benchmark\ndisplayName: AgentBattler Benchmark\nenabled: true\nrole: chat-agent\nconnection-type: internal\nisDefault: true\nisStateful: ${stateful}\ncreatedAt: 0\nupdatedAt: 0\n---\n`;
  const profile = {
    toolConfig: {
      allServersDisabledByDefault: true,
      enabledServers: [],
      disabledServers: [],
      disabledTools: [],
      enabledRuntimeTools: enableCompletionTool ? [...DOTAGENTS_RUNTIME_TOOLS] : ['execute_command'],
    },
    modelConfig: {
      agentProviderId: providerId,
      mcpToolsProviderId: providerId,
      ...(openaiProxy ? {
        agentOpenaiModel: model,
        mcpToolsOpenaiModel: model,
        currentModelPresetId: 'agentbattler-cliproxy',
      } : {
        agentChatgptWebModel: model,
        mcpToolsChatgptWebModel: model,
      }),
    },
    skillsConfig: {
      allSkillsDisabledByDefault: true,
      enabledSkillIds: [],
    },
  };

  return {
    files: {
      'dotagents-settings.json': json(settings),
      'models.json': json(models),
      'mcp.json': json(mcp),
      [`agents/${DOTAGENTS_PROFILE_ID}/agent.md`]: profileMarkdown,
      [`agents/${DOTAGENTS_PROFILE_ID}/config.json`]: json(profile),
    },
    legacyConfig: { ...settings, ...models, ...mcp },
    generationSettings: {
      provider: openaiProxy ? 'openai-compatible' : 'chatgpt-web',
      transport: openaiProxy ? 'cliproxyapi' : 'native',
      promptCaching: openaiProxy ? 'cliproxy' : 'native',
      reasoningEffort,
      textVerbosity: 'medium',
      maxIterations,
      unlimitedIterations: false,
      completionVerification: true,
      verificationRetries: 1,
      finalSummaryPass: false,
      parallelToolExecution: false,
      runtimeTools: enableCompletionTool ? [...DOTAGENTS_RUNTIME_TOOLS] : ['execute_command'],
      explicitCompletionTool: enableCompletionTool,
      stateful,
      externalMcpServers: 0,
      skillsEnabled: false,
    },
  };
}

const DOTAGENTS_USAGE_FIELDS = Object.freeze([
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
]);

function usageCounter(usage, field) {
  const value = Number(usage?.[field] ?? 0);
  invariant(Number.isFinite(value) && value >= 0, `DotAgents ${field} telemetry is invalid`);
  return value;
}

export function dotAgentsCumulativeUsageDelta(previous, current) {
  return Object.fromEntries(DOTAGENTS_USAGE_FIELDS.map((field) => {
    const before = usageCounter(previous, field);
    const after = usageCounter(current, field);
    invariant(after >= before, `DotAgents cumulative ${field} decreased`);
    return [field, after - before];
  }));
}

export function dotAgentsTerminalUsage(cumulative) {
  return {
    inputTokens: usageCounter(cumulative, 'inputTokens'),
    cachedInputTokens: usageCounter(cumulative, 'cacheReadTokens'),
    outputTokens: usageCounter(cumulative, 'outputTokens'),
    reasoningTokens: usageCounter(cumulative, 'reasoningTokens'),
  };
}

function normalizedArguments(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function collectToolCalls(events) {
  const collected = [];
  for (const event of events) {
    if (event?.type === 'progress') {
      for (const step of event.data?.steps ?? []) {
        if (step?.toolCall?.name) collected.push(step.toolCall);
      }
    }
    if (event?.type === 'done') {
      for (const message of event.data?.conversation_history ?? []) {
        for (const toolCall of message?.toolCalls ?? []) collected.push(toolCall);
      }
    }
  }
  const unique = new Map();
  for (const call of collected) {
    const normalized = {
      id: typeof call.id === 'string' ? call.id : null,
      name: call.name,
      arguments: normalizedArguments(call.arguments),
    };
    const key = normalized.id ?? canonicalJsonSha256(normalized);
    if (!unique.has(key)) unique.set(key, normalized);
  }
  return [...unique.values()];
}

export function networkCommandReason(command) {
  if (typeof command !== 'string' || command.trim().length === 0) return null;
  if (/(^|[;&|()\s])(curl|wget|nc|ncat|netcat|telnet|ftp|sftp|ssh|scp|rsync)(?=\s|$)/i.test(command)) return 'network-capable command';
  if (/https?:\/\/|\/dev\/(tcp|udp)\//i.test(command)) return 'network address';
  if (/\b(fetch|XMLHttpRequest|WebSocket)\s*\(/i.test(command)) return 'programmatic network API';
  if (/\b(import|require)\s*\(?\s*['"](?:node:)?(?:http|https|net|tls|dns|dgram)['"]/i.test(command)) return 'network module';
  return null;
}

export function summarizeDotAgentsTrace(events, expectedModel, { maxIterations = null } = {}) {
  invariant(Array.isArray(events) && events.length > 0, 'DotAgents trace is empty');
  const doneEvents = events.filter((event) => event?.type === 'done');
  invariant(doneEvents.length === 1, `DotAgents trace requires exactly one done event; found ${doneEvents.length}`);
  const done = doneEvents[0];
  invariant(typeof done.data?.content === 'string', 'DotAgents done event has no final content');

  const modelIds = new Set();
  if (typeof done.data?.model === 'string') modelIds.add(done.data.model);
  for (const event of events) {
    if (typeof event?.data?.modelInfo?.model === 'string') modelIds.add(event.data.modelInfo.model);
  }
  invariant(modelIds.size > 0, 'DotAgents trace did not identify its model');
  invariant([...modelIds].every((model) => model === expectedModel), `DotAgents trace model mismatch: ${[...modelIds].join(', ')}`);

  const toolCalls = collectToolCalls(events);
  const allowed = new Set(DOTAGENTS_RUNTIME_TOOLS);
  invariant(toolCalls.every((call) => allowed.has(call.name)), `DotAgents used unexpected tools: ${[...new Set(toolCalls.filter((call) => !allowed.has(call.name)).map((call) => call.name))].join(', ')}`);
  const commands = toolCalls.filter((call) => call.name === 'execute_command').map((call) => call.arguments.command).filter((command) => typeof command === 'string');
  for (const command of commands) {
    const reason = networkCommandReason(command);
    invariant(!reason, `DotAgents command violates the no-network generation contract (${reason})`);
  }

  const costs = events.map((event) => event?.data?.sessionCost).filter(Boolean);
  const sessionCost = costs.sort((left, right) => (
    (right.inputTokens ?? 0) + (right.outputTokens ?? 0) - (left.inputTokens ?? 0) - (left.outputTokens ?? 0)
  ))[0] ?? null;
  const history = done.data.conversation_history ?? [];
  const maxIterationObserved = Math.max(0, ...events.map((event) => Number(event?.data?.currentIteration ?? 0)).filter(Number.isFinite));
  const completionToolCalled = toolCalls.some((call) => call.name === 'mark_work_complete');
  const nativeStopReason = done.data.stop_reason ?? done.data.stopReason ?? done.data.finish_reason ?? null;
  const iterationLimitReached = Number.isSafeInteger(maxIterations) && maxIterations > 0
    && (maxIterationObserved >= maxIterations || /max(?:imum)?[ -]iterations?|iteration[ -]limit/i.test(done.data.content ?? ''))
    && !completionToolCalled;
  return {
    eventCount: events.length,
    modelIds: [...modelIds].sort(),
    toolCallCount: toolCalls.length,
    toolCallBreakdown: Object.fromEntries([...new Set(toolCalls.map((call) => call.name))].sort().map((name) => [name, toolCalls.filter((call) => call.name === name).length])),
    commands,
    conversationMessageCount: history.length,
    assistantMessageCount: history.filter((message) => message?.role === 'assistant').length,
    sessionCost,
    finalContent: done.data.content,
    conversationId: done.data.conversation_id ?? null,
    maxIterationObserved,
    completionToolCalled,
    nativeStopReason,
    iterationLimitReached,
  };
}

export function buildDotAgentsDockerArgs({ image = DOTAGENTS_IMAGE, name, hostPort, home, configRoot, workspace, network = null }) {
  invariant(typeof name === 'string' && /^[a-z0-9][a-z0-9_.-]+$/.test(name), 'Invalid DotAgents container name');
  invariant(Number.isSafeInteger(hostPort) && hostPort > 0 && hostPort <= 65_535, 'Invalid DotAgents host port');
  for (const [label, value] of Object.entries({ home, configRoot, workspace })) {
    invariant(typeof value === 'string' && path.isAbsolute(value), `${label} must be an absolute path`);
  }
  if (network !== null) invariant(typeof network === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(network), 'Invalid DotAgents Docker network');
  return [
    'run', '--rm', '--interactive',
    '--name', name,
    '--read-only',
    '--cap-drop', 'ALL',
    '--cap-add', 'SYS_ADMIN',
    '--cap-add', 'NET_ADMIN',
    '--security-opt', 'no-new-privileges',
    '--security-opt', 'seccomp=unconfined',
    '--pids-limit', '256',
    '--memory', '4g',
    '--cpus', '2',
    '--shm-size', '256m',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=512m',
    '--tmpfs', '/run:rw,nosuid,nodev,size=64m',
    '--publish', `127.0.0.1:${hostPort}:3210`,
    ...(network ? ['--network', network] : []),
    '--env', 'HOME=/home/benchmark',
    '--env', 'XDG_CONFIG_HOME=/home/benchmark/.config',
    '--env', 'XDG_CACHE_HOME=/home/benchmark/.cache',
    '--env', 'XDG_DATA_HOME=/home/benchmark/.local/share',
    '--env', 'DOTAGENTS_WORKSPACE_DIR=/workspace',
    '--env', 'APP_ID=app.dotagents.agentbattler',
    '--env', 'DEBUG_LLM=0',
    '--env', 'DEBUG_TOOLS=0',
    '--volume', `${home}:/home/benchmark:rw`,
    '--volume', `${configRoot}:/config-workspace:rw`,
    '--volume', `${workspace}:/workspace:rw`,
    '--workdir', '/workspace',
    image,
  ];
}
