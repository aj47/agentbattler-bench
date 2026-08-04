const THREAD_ID = /^T-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function numeric(value) {
  if (value === undefined || value === null) return 0;
  invariant(Number.isFinite(value) && value >= 0, 'Amp event stream has malformed numeric telemetry');
  return Number(value);
}

export const AMP_ALLOWED_TOOLS = Object.freeze([
  'Read',
  'apply_patch',
  'create_file',
  'edit_file',
  'finder',
  'multi_tool_use.parallel',
  'shell_command',
  'shell_command_status',
]);

export function parseAmpEventStream(content, { expectedSessionId = null, allowIncomplete = false } = {}) {
  const lines = String(content).split(/\r?\n/).filter((line) => line.trim());
  if (allowIncomplete && lines.length === 0) {
    return { sessionId: expectedSessionId, eventCount: 0, toolCalls: 0, usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 }, agentMode: null, models: [], durationMs: 0, resultSubtype: null, complete: false };
  }
  invariant(lines.length > 0, 'Amp event stream is empty');
  const events = [];
  for (const [index, line] of lines.entries()) {
    try {
      const event = JSON.parse(line);
      invariant(event && typeof event === 'object' && !Array.isArray(event), `Amp event ${index + 1} is not an object`);
      events.push(event);
    } catch (error) {
      if (allowIncomplete && index === lines.length - 1 && !String(content).endsWith('\n')) break;
      throw new Error(`Amp event stream JSON parse failed on line ${index + 1}: ${error.message}`);
    }
  }
  if (allowIncomplete && events.length === 0) {
    return { sessionId: expectedSessionId, eventCount: 0, toolCalls: 0, usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 }, agentMode: null, models: [], durationMs: 0, resultSubtype: null, complete: false };
  }
  const init = events.find((event) => event.type === 'system' && event.subtype === 'init');
  const result = [...events].reverse().find((event) => event.type === 'result');
  invariant(init, 'Amp event stream is missing its init event');
  invariant(result || allowIncomplete, 'Amp event stream is missing its terminal result event');
  invariant(!result || result.subtype === 'success' && result.is_error === false, `Amp turn failed: ${String(result?.result ?? result?.subtype ?? 'unknown error').slice(0, 500)}`);
  const sessionId = result?.session_id ?? init.session_id;
  invariant(typeof sessionId === 'string' && THREAD_ID.test(sessionId), 'Amp event stream has no valid thread ID');
  invariant(events.every((event) => !event.session_id || event.session_id === sessionId), 'Amp event stream changed thread ID');
  invariant(!expectedSessionId || sessionId === expectedSessionId, 'Amp resumed a different native thread');
  invariant(Array.isArray(init.mcp_servers) && init.mcp_servers.length === 0, 'Amp initialized MCP servers');
  invariant(Array.isArray(init.tools) && init.tools.every((tool) => typeof tool === 'string' && tool), 'Amp init tools are malformed');
  const tools = init.tools;
  const allowedTools = new Set(AMP_ALLOWED_TOOLS);
  invariant(tools.every((tool) => allowedTools.has(tool)), `Amp initialized forbidden tools: ${tools.filter((tool) => !allowedTools.has(tool)).join(', ')}`);

  const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  const models = new Set();
  let toolCalls = 0;
  for (const event of events) {
    if (event.type !== 'assistant') continue;
    const sample = event.message?.usage ?? {};
    const cached = numeric(sample.cache_read_input_tokens);
    usage.inputTokens += numeric(sample.input_tokens) + numeric(sample.cache_creation_input_tokens) + cached;
    usage.cachedInputTokens += cached;
    usage.outputTokens += numeric(sample.output_tokens);
    usage.reasoningTokens += numeric(sample.reasoning_tokens);
    if (typeof event.message?.model === 'string' && event.message.model) models.add(event.message.model);
    toolCalls += (Array.isArray(event.message?.content) ? event.message.content : []).filter((item) => item?.type === 'tool_use').length;
  }
  return {
    sessionId,
    eventCount: events.length,
    toolCalls,
    usage,
    agentMode: typeof init.agent_mode === 'string' ? init.agent_mode : null,
    models: [...models].sort(),
    durationMs: numeric(result?.duration_ms),
    resultSubtype: result?.subtype ?? null,
    complete: Boolean(result),
  };
}
