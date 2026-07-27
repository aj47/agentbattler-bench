export const CLAUDE_COMPACTION_POLICY_VERSION = 'model-window-v2';
export const CLAUDE_AUTOCOMPACT_PERCENT = 80;

// Claude Code's compaction threshold is a model contract, not a universal
// constant. Add each newly scheduled model here only after calibrating its
// effective context window through the configured gateway.
const MODEL_CONTEXT_WINDOWS = Object.freeze({
  'gpt-5.6-terra': 200_000,
  'gpt-5.6-sol': 200_000,
  'gpt-5.6-luna': 200_000,
});

export function claudeCompactionPolicy(model) {
  const contextWindowTokens = MODEL_CONTEXT_WINDOWS[model];
  if (!Number.isSafeInteger(contextWindowTokens)) {
    throw new Error(`No calibrated Claude Code compaction window for model ${model}; calibrate the model and update MODEL_CONTEXT_WINDOWS`);
  }
  return {
    version: CLAUDE_COMPACTION_POLICY_VERSION,
    model,
    contextWindowTokens,
    autoCompactWindowTokens: contextWindowTokens,
    autoCompactPercent: CLAUDE_AUTOCOMPACT_PERCENT,
    autoCompactTriggerTokens: Math.floor(contextWindowTokens * CLAUDE_AUTOCOMPACT_PERCENT / 100),
    environmentVariables: {
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(contextWindowTokens),
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(contextWindowTokens),
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(CLAUDE_AUTOCOMPACT_PERCENT),
    },
  };
}

function usageTokens(event) {
  const usage = event?.message?.usage ?? event?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const direct = usage.input_tokens ?? usage.inputTokens;
  const cacheRead = usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? 0;
  const cacheCreation = usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? 0;
  const total = Number(direct ?? 0) + Number(cacheRead) + Number(cacheCreation);
  return Number.isFinite(total) && total > 0 ? total : null;
}

function numericMetadata(value, names) {
  if (!value || typeof value !== 'object') return null;
  for (const name of names) {
    const candidate = Number(value[name]);
    if (Number.isFinite(candidate) && candidate >= 0) return candidate;
  }
  return null;
}

function isCompactBoundary(event) {
  return event?.type === 'compact_boundary'
    || event?.subtype === 'compact_boundary'
    || event?.type === 'system' && event?.subtype === 'compact_boundary';
}

export function claudeCompactionTelemetry(events) {
  const boundaries = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!isCompactBoundary(event)) continue;
    const metadata = event.compact_metadata ?? event.compactMetadata ?? event.metadata ?? {};
    let beforeTokens = numericMetadata(metadata, ['pre_tokens', 'preTokens', 'tokens_before', 'tokensBefore', 'input_tokens', 'inputTokens']);
    let afterTokens = numericMetadata(metadata, ['post_tokens', 'postTokens', 'tokens_after', 'tokensAfter']);
    if (beforeTokens === null) {
      for (let cursor = index - 1; cursor >= 0 && beforeTokens === null; cursor -= 1) beforeTokens = usageTokens(events[cursor]);
    }
    if (afterTokens === null) {
      for (let cursor = index + 1; cursor < events.length && afterTokens === null; cursor += 1) afterTokens = usageTokens(events[cursor]);
    }
    boundaries.push({
      index,
      timestamp: event.timestamp ?? null,
      trigger: metadata.trigger ?? event.trigger ?? null,
      beforeTokens,
      afterTokens,
    });
  }
  return { count: boundaries.length, boundaries };
}

export function compactionDelta(current, previous = { count: 0, boundaries: [] }) {
  const previousCount = Math.min(previous.count ?? 0, current.count ?? 0);
  return {
    count: Math.max(0, current.count - previousCount),
    boundaries: current.boundaries.slice(previousCount),
  };
}
