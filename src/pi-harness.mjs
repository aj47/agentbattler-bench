const REQUIRED_PROVIDER = 'openai-codex';

export const PI_HARNESS_VERSION = '0.80.7';
export const PI_IMAGE = `agentbattler-pi:${PI_HARNESS_VERSION}`;
export const PI_TOOLS = ['read', 'bash', 'edit', 'write'];
const MINIMUM_ACCESS_LIFETIME_MS = 4 * 60 * 60 * 1000;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function validatePiSubscriptionAuth(codexAuth, piAuthDocument) {
  invariant(codexAuth?.auth_mode === 'chatgpt', 'Codex must be authenticated with a ChatGPT subscription');
  const codexAccountId = codexAuth?.tokens?.account_id;
  invariant(typeof codexAccountId === 'string' && codexAccountId.length > 0, 'Codex ChatGPT authentication is missing its account ID');

  const credential = piAuthDocument?.[REQUIRED_PROVIDER];
  invariant(credential?.type === 'oauth', 'Ephemeral Pi auth is missing its openai-codex OAuth credential');
  invariant(typeof credential.access === 'string' && credential.access.length > 0, 'Pi openai-codex OAuth is missing its access token');
  invariant(typeof credential.refresh === 'string' && credential.refresh.length > 0, 'Pi openai-codex OAuth is missing its refresh token');
  invariant(Number.isFinite(credential.expires), 'Pi openai-codex OAuth is missing its expiry');
  invariant(credential.accountId === codexAccountId, 'Pi and Codex are authenticated to different ChatGPT accounts');

  return {
    method: 'chatgpt',
    provider: REQUIRED_PROVIDER,
    subscriptionAccess: true,
    sameAccountAsCodex: true,
  };
}

function jwtExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export function piSubscriptionAuthFromCodex(codexAuth, { now = Date.now() } = {}) {
  invariant(codexAuth?.auth_mode === 'chatgpt', 'Codex must be authenticated with a ChatGPT subscription');
  const tokens = codexAuth?.tokens;
  invariant(typeof tokens?.access_token === 'string' && tokens.access_token.length > 0, 'Codex ChatGPT authentication is missing its access token');
  invariant(typeof tokens?.refresh_token === 'string' && tokens.refresh_token.length > 0, 'Codex ChatGPT authentication is missing its refresh token');
  invariant(typeof tokens?.account_id === 'string' && tokens.account_id.length > 0, 'Codex ChatGPT authentication is missing its account ID');
  const expires = jwtExpiry(tokens.access_token);
  invariant(Number.isFinite(expires), 'Codex ChatGPT access token has no readable expiry');
  invariant(expires - now >= MINIMUM_ACCESS_LIFETIME_MS, 'Codex ChatGPT access token expires too soon for a benchmark suite; run `codex login` again');

  const document = {
    [REQUIRED_PROVIDER]: {
      type: 'oauth',
      access: tokens.access_token,
      refresh: tokens.refresh_token,
      expires,
      accountId: tokens.account_id,
    },
  };
  return {
    authentication: validatePiSubscriptionAuth(codexAuth, document),
    document,
  };
}

export function buildPiDockerArgs({
  image = PI_IMAGE,
  model,
  prompt,
  workspace,
  piHome,
  user,
  sessionPath = null,
  continueSession = false,
}) {
  for (const [name, value] of Object.entries({ image, model, prompt, workspace, piHome, user })) {
    invariant(typeof value === 'string' && value.length > 0, `${name} is required to run Pi`);
  }

  const args = [
    'run', '--rm', '--init',
    '--network', 'bridge',
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', '256',
    '--memory', '4g',
    '--cpus', '2',
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=512m',
    '--user', user,
    '--env', 'HOME=/pi-home',
    '--env', 'PI_CODING_AGENT_DIR=/pi-home',
    '--env', 'PI_CODING_AGENT_SESSION_DIR=/pi-home/sessions',
    '--env', 'PI_SKIP_VERSION_CHECK=1',
    '--env', 'PI_TELEMETRY=0',
    '--volume', `${workspace}:/workspace:rw`,
    '--volume', `${piHome}:/pi-home:rw`,
    '--workdir', '/workspace',
    image,
    '--mode', 'json',
    '--provider', REQUIRED_PROVIDER,
    '--model', model,
    '--thinking', 'high',
    '--tools', PI_TOOLS.join(','),
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--no-context-files',
    '--no-approve',
  ];
  if (sessionPath) args.push('--session', sessionPath);
  if (continueSession) args.push('--continue');
  args.push(prompt);
  return args;
}

function parseJsonLines(content, label) {
  return content.split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid ${label} JSON on line ${index + 1}: ${error.message}`);
    }
  });
}

function countBy(values) {
  return Object.fromEntries([...new Set(values)].sort().map((value) => [value, values.filter((item) => item === value).length]));
}

function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
}

function addUsage(total, usage = {}) {
  total.inputTokens += Number.isFinite(usage.input) ? usage.input : 0;
  total.outputTokens += Number.isFinite(usage.output) ? usage.output : 0;
  total.cacheReadTokens += Number.isFinite(usage.cacheRead) ? usage.cacheRead : 0;
  total.cacheWriteTokens += Number.isFinite(usage.cacheWrite) ? usage.cacheWrite : 0;
  total.totalTokens += Number.isFinite(usage.totalTokens)
    ? usage.totalTokens
    : (Number.isFinite(usage.input) ? usage.input : 0) + (Number.isFinite(usage.output) ? usage.output : 0);
  return total;
}

export function parsePiEventStream(content) {
  const events = parseJsonLines(content, 'Pi event stream');
  invariant(events.length > 0, 'Pi event stream is empty');
  const header = events[0];
  invariant(header.type === 'session' && typeof header.id === 'string', 'Pi event stream is missing its session header');
  invariant(events.some((event) => event.type === 'agent_end'), 'Pi event stream is missing agent_end');

  const toolCalls = events.filter((event) => event.type === 'tool_execution_start');
  const toolNames = toolCalls.map((event) => event.toolName ?? 'unknown');
  const assistantMessages = events.filter((event) => event.type === 'message_end' && event.message?.role === 'assistant');
  const usage = assistantMessages.reduce((total, event) => addUsage(total, event.message?.usage), emptyUsage());

  return {
    sessionId: header.id,
    eventCount: events.length,
    eventTypes: countBy(events.map((event) => event.type)),
    turnCount: events.filter((event) => event.type === 'turn_start').length,
    toolCallCount: toolCalls.length,
    toolCallBreakdown: countBy(toolNames),
    mcpCallCount: toolNames.filter((name) => /mcp/i.test(name)).length,
    ...usage,
  };
}

function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content.filter((item) => item?.type === 'text').map((item) => item.text ?? '').join('');
}

export function validateNativePiSession(content, {
  sessionId,
  model,
  prompt,
  cwd = '/workspace',
  forbiddenText = [],
} = {}) {
  const entries = parseJsonLines(content, 'native Pi session');
  invariant(entries.length > 0, 'Native Pi session is empty');
  const header = entries[0];
  invariant(header.type === 'session' && typeof header.id === 'string', 'Native Pi session is missing its session header');
  invariant(Number.isSafeInteger(header.version) && header.version >= 3, 'Native Pi session uses an unsupported schema version');
  if (sessionId) invariant(header.id === sessionId, 'Native Pi session ID does not match the JSON event stream');
  if (cwd) invariant(header.cwd === cwd, `Native Pi session cwd is not ${cwd}`);

  const messages = entries.filter((entry) => entry.type === 'message').map((entry) => entry.message);
  const users = messages.filter((message) => message?.role === 'user');
  const assistants = messages.filter((message) => message?.role === 'assistant');
  invariant(users.length > 0, 'Native Pi session is missing its user prompt');
  invariant(assistants.length > 0, 'Native Pi session is missing assistant messages');
  if (prompt) invariant(users.some((message) => messageText(message) === prompt), 'Native Pi session does not contain the exact benchmark prompt');
  invariant(assistants.every((message) => message.provider === REQUIRED_PROVIDER), 'Native Pi session used a provider other than openai-codex');
  if (model) invariant(assistants.every((message) => message.model === model), `Native Pi session does not consistently record model ${model}`);

  const forbiddenEntryTypes = entries.filter((entry) => ['custom', 'custom_message'].includes(entry.type));
  invariant(forbiddenEntryTypes.length === 0, 'Native Pi session contains extension-injected entries');
  const toolCalls = assistants.flatMap((message) => message.content ?? []).filter((item) => item?.type === 'toolCall');
  const toolNames = toolCalls.map((item) => item.name ?? 'unknown');
  const unexpectedTools = toolNames.filter((name) => !PI_TOOLS.includes(name));
  invariant(unexpectedTools.length === 0, `Native Pi session used unexpected tools: ${[...new Set(unexpectedTools)].join(', ')}`);
  const usage = assistants.reduce((total, message) => addUsage(total, message.usage), emptyUsage());

  for (const value of forbiddenText) {
    if (value) invariant(!content.includes(value), `Native Pi session contains forbidden host context: ${value}`);
  }

  return {
    sessionId: header.id,
    sessionVersion: header.version,
    eventCount: entries.length,
    turnCount: assistants.length,
    userMessageCount: users.length,
    toolCallCount: toolCalls.length,
    toolCallBreakdown: countBy(toolNames),
    mcpCallCount: toolNames.filter((name) => /mcp/i.test(name)).length,
    provider: REQUIRED_PROVIDER,
    model: assistants.at(-1)?.model ?? null,
    extensionEntryCount: 0,
    ...usage,
  };
}
