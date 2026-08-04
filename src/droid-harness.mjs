export const DROID_HARNESS_ID = 'factory-droid';
export const DROID_VERSION = '0.186.0';
export const DROID_BINARY_SHA256 = 'e7b078bd61d3850ec21095719721d0bda808212abfa5076da270975b62e4fa68';
export const DROID_REASONING_EFFORT = 'high';

// The GPT-5.6 model catalog advertises a 272k window and a 95% effective
// context budget. Compact at 80% of that effective budget so the next model
// response and Droid's tool schemas remain below the usable ceiling.
export const DROID_CONTEXT_POLICY = Object.freeze({
  version: 'gpt-5.6-effective-window-v1',
  contextWindowTokens: 272_000,
  effectiveContextPercent: 95,
  effectiveContextWindowTokens: 258_400,
  compactionPercent: 80,
  compactionTokenLimit: 206_720,
  maxOutputTokens: 32_768,
});

export const DROID_MODEL_FAMILIES = Object.freeze([
  Object.freeze({ id: 'terra', model: 'gpt-5.6-terra', upstreamModel: 'cx/gpt-5.6-terra', displayName: 'AgentBattler GPT-5.6 Terra' }),
  Object.freeze({ id: 'sol', model: 'gpt-5.6-sol', upstreamModel: 'cx/gpt-5.6-sol', displayName: 'AgentBattler GPT-5.6 Sol' }),
  Object.freeze({ id: 'luna', model: 'gpt-5.6-luna', upstreamModel: 'cx/gpt-5.6-luna', displayName: 'AgentBattler GPT-5.6 Luna' }),
]);

export const DROID_RESTRICTED_TOOLS = Object.freeze(['Read', 'ApplyPatch', 'Execute', 'Glob', 'Grep', 'LS']);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function droidModelFamily(model) {
  const family = DROID_MODEL_FAMILIES.find((entry) => entry.model === model);
  invariant(family, `Unsupported Droid benchmark model: ${model ?? 'missing'}`);
  return family;
}

export function droidUpstreamModel(model, prefix = 'cx/') {
  const family = droidModelFamily(model);
  invariant(typeof prefix === 'string' && !/\s/.test(prefix), 'Droid upstream model prefix must not contain whitespace');
  return `${prefix}${family.model}`;
}

export function droidCustomModelId(model) {
  const family = droidModelFamily(model);
  // Droid 0.186 assigns the user-level custom-model suffix independently for
  // each model definition, so every entry is exposed with the `-0` suffix.
  return `custom:${family.displayName.replaceAll(' ', '-')}-0`;
}

export function normalizeDroidBaseUrl(baseUrl) {
  invariant(typeof baseUrl === 'string' && baseUrl.length > 0, 'Droid base URL is required');
  let parsed;
  try { parsed = new URL(baseUrl); } catch { throw new Error('Droid base URL must be an absolute HTTP(S) URL'); }
  invariant(['http:', 'https:'].includes(parsed.protocol), 'Droid base URL must use HTTP or HTTPS');
  invariant(!parsed.username && !parsed.password, 'Droid base URL must not contain credentials');
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  if (!parsed.pathname.endsWith('/v1')) parsed.pathname = `${parsed.pathname}/v1`.replace(/\/+/g, '/');
  return parsed.toString().replace(/\/$/, '');
}

export function createDroidSettings({
  baseUrl,
  apiKeyEnvironmentVariable = 'AGENTBATTLER_DROID_API_KEY',
  upstreamModelPrefix = 'cx/',
} = {}) {
  invariant(/^[A-Z][A-Z0-9_]*$/.test(apiKeyEnvironmentVariable), 'Droid API key environment variable is invalid');
  const normalizedBaseUrl = normalizeDroidBaseUrl(baseUrl);
  const customModels = DROID_MODEL_FAMILIES.map((family) => ({
    model: droidUpstreamModel(family.model, upstreamModelPrefix),
    displayName: family.displayName,
    baseUrl: normalizedBaseUrl,
    apiKey: `\${${apiKeyEnvironmentVariable}}`,
    provider: 'openai',
    maxContextLimit: DROID_CONTEXT_POLICY.contextWindowTokens,
    maxOutputTokens: DROID_CONTEXT_POLICY.maxOutputTokens,
    noImageSupport: true,
    extraArgs: {
      max_output_tokens: DROID_CONTEXT_POLICY.maxOutputTokens,
    },
  }));
  return {
    model: droidCustomModelId('gpt-5.6-terra'),
    reasoningEffort: DROID_REASONING_EFFORT,
    sessionDefaultSettings: { interactionMode: 'auto', autonomyLevel: 'medium' },
    cloudSessionSync: false,
    completionSound: 'off',
    awaitingInputSound: 'off',
    hooksDisabled: true,
    disabledSkills: [],
    ideAutoConnect: false,
    includeCoAuthoredByDroid: false,
    compactionTokenLimit: DROID_CONTEXT_POLICY.compactionTokenLimit,
    compactionTokenLimitPerModel: Object.fromEntries(DROID_MODEL_FAMILIES.map((family) => [
      droidCustomModelId(family.model),
      DROID_CONTEXT_POLICY.compactionTokenLimit,
    ])),
    compactionModel: 'same',
    modelFallbacks: {},
    llmRequestTimeout: 1_800_000,
    customModels,
  };
}

export function droidExecArgs({ workspace, model, sessionId = null, promptFile = null, outputFormat = 'stream-json' }) {
  invariant(typeof workspace === 'string' && workspace.length > 0, 'Droid workspace is required');
  const args = [
    'exec',
    '--auto', 'medium',
    '--disable-builtin-skills',
    '--restrict-tools', DROID_RESTRICTED_TOOLS.join(','),
    '--model', droidCustomModelId(model),
    '--reasoning-effort', DROID_REASONING_EFFORT,
    '--output-format', outputFormat,
    '--cwd', workspace,
  ];
  if (promptFile) args.push('--file', promptFile);
  if (sessionId) args.push('--session-id', sessionId);
  return args;
}

export function parseDroidEventStream(content) {
  return content.split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
    try { return JSON.parse(line); } catch (error) { throw new Error(`Droid JSONL parse failed on line ${index + 1}: ${error.message}`); }
  });
}

function numeric(value) {
  return Number.isFinite(value) ? value : 0;
}

function eventUsageTokens(event) {
  const subject = event?.params?.notification ?? event;
  const value = subject?.usage ?? subject?.tokenUsage ?? subject?.message?.usage;
  if (!value || typeof value !== 'object') return null;
  const total = Number(value.input_tokens ?? value.inputTokens ?? 0)
    + Number(value.cache_read_input_tokens ?? value.cacheReadTokens ?? value.cached_input_tokens ?? value.cachedInputTokens ?? 0)
    + Number(value.cache_creation_input_tokens ?? value.cacheCreationInputTokens ?? 0);
  return Number.isFinite(total) && total > 0 ? total : null;
}

function metadataTokens(value, names) {
  if (!value || typeof value !== 'object') return null;
  for (const name of names) {
    const candidate = Number(value[name]);
    if (Number.isFinite(candidate) && candidate >= 0) return candidate;
  }
  return null;
}

function isDroidCompactionBoundary(event) {
  const subject = event?.params?.notification ?? event;
  return [subject?.type, subject?.subtype, subject?.event, subject?.name]
    .some((value) => typeof value === 'string' && /compact(?:ion)?(?:_boundary|_complete|ed)?/i.test(value));
}

export function droidCompactionTelemetry(events) {
  const boundaries = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!isDroidCompactionBoundary(event)) continue;
    const subject = event?.params?.notification ?? event;
    const metadata = subject.compact_metadata ?? subject.compactMetadata ?? subject.compaction ?? subject.metadata ?? subject;
    let beforeTokens = metadataTokens(metadata, ['pre_tokens', 'preTokens', 'tokens_before', 'tokensBefore', 'input_tokens', 'inputTokens']);
    let afterTokens = metadataTokens(metadata, ['post_tokens', 'postTokens', 'tokens_after', 'tokensAfter']);
    if (beforeTokens === null) {
      for (let cursor = index - 1; cursor >= 0 && beforeTokens === null; cursor -= 1) beforeTokens = eventUsageTokens(events[cursor]);
    }
    if (afterTokens === null) {
      for (let cursor = index + 1; cursor < events.length && afterTokens === null; cursor += 1) afterTokens = eventUsageTokens(events[cursor]);
    }
    boundaries.push({
      index,
      timestamp: subject.timestamp ?? null,
      trigger: metadata.trigger ?? subject.trigger ?? null,
      beforeTokens,
      afterTokens,
      summaryId: subject.summaryId ?? null,
      removedCount: subject.removedCount ?? null,
      visibleBoundaryMessageId: subject.visibleBoundaryMessageId ?? null,
    });
  }
  return { count: boundaries.length, boundaries };
}

export function summarizeDroidEvents(events) {
  invariant(Array.isArray(events) && events.length > 0, 'Droid event stream is empty');
  const result = [...events].reverse().find((event) => ['result', 'completion'].includes(event.type));
  invariant(result && result.is_error !== true && result.subtype !== 'error' && !result.error, `Droid turn did not finish successfully (event types: ${events.map((event) => event.type ?? 'missing').join(', ')})`);
  const sessionId = result.session_id
    ?? events.find((event) => typeof event.session_id === 'string')?.session_id
    ?? null;
  invariant(sessionId, 'Droid event stream has no session ID');
  const toolEvents = events.filter((event) => ['tool_call', 'tool_use', 'tool_started', 'tool_start'].includes(event.type));
  const usageEvent = [...events].reverse().find((event) => event.type === 'usage' || event.usage);
  const value = usageEvent?.usage ?? usageEvent ?? {};
  const usage = {
    inputTokens: numeric(value.input_tokens ?? value.inputTokens),
    cachedInputTokens: numeric(value.cached_input_tokens ?? value.cachedInputTokens ?? value.cache_read_input_tokens),
    outputTokens: numeric(value.output_tokens ?? value.outputTokens),
    reasoningTokens: numeric(value.reasoning_tokens ?? value.reasoningTokens ?? value.reasoning_output_tokens),
  };
  return {
    sessionId,
    result,
    eventCount: events.length,
    toolCallCount: toolEvents.length,
    toolCallBreakdown: Object.fromEntries([...new Set(toolEvents.map((event) => event.tool ?? event.name ?? event.tool_name ?? 'unknown'))]
      .map((name) => [name, toolEvents.filter((event) => (event.tool ?? event.name ?? event.tool_name ?? 'unknown') === name).length])),
    usage,
  };
}
