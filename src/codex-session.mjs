function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function parseLines(content) {
  return content.split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid native Codex session JSON on line ${index + 1}: ${error.message}`);
    }
  });
}

function userMessageText(event) {
  if (event?.type !== 'event_msg' || event.payload?.type !== 'user_message') return null;
  if (typeof event.payload.message === 'string') return event.payload.message;
  if (typeof event.payload.message?.text === 'string') return event.payload.message.text;
  return null;
}

export function validateNativeCodexSession(content, { sessionId, model, prompt } = {}) {
  const events = parseLines(content);
  invariant(events.length > 0, 'Native Codex session is empty');
  const sessionMeta = events.find((event) => event.type === 'session_meta');
  invariant(sessionMeta?.payload && typeof sessionMeta.payload === 'object', 'Native Codex session is missing session_meta');
  invariant(typeof sessionMeta.payload.id === 'string', 'Native Codex session_meta is missing its ID');
  if (sessionId) invariant(sessionMeta.payload.id === sessionId, 'Native Codex session ID does not match the JSON event stream');
  const turnContexts = events.filter((event) => event.type === 'turn_context');
  invariant(turnContexts.length > 0, 'Native Codex session is missing turn_context');
  if (model) invariant(turnContexts.some((event) => event.payload?.model === model), `Native Codex session does not record model ${model}`);
  const userMessages = events.map(userMessageText).filter((value) => typeof value === 'string');
  invariant(userMessages.length > 0, 'Native Codex session is missing an event_msg user prompt');
  if (prompt) invariant(userMessages.includes(prompt), 'Native Codex session does not contain the exact benchmark prompt');
  const responseItems = events.filter((event) => event.type === 'response_item');
  invariant(responseItems.length > 0, 'Native Codex session is missing response_item events');
  const toolCalls = responseItems.filter((event) => ['function_call', 'custom_tool_call'].includes(event.payload?.type));
  return {
    sessionId: sessionMeta.payload.id,
    eventCount: events.length,
    turnCount: turnContexts.length,
    userMessageCount: userMessages.length,
    toolCallCount: toolCalls.length,
    cliVersion: sessionMeta.payload.cli_version ?? null,
  };
}
