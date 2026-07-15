/** Devin CLI generation harness helpers for AgentBattler. */

export const DEVIN_HARNESS_NAME = 'devin-cli';
export const DEVIN_PERMISSION_MODE = 'dangerous';
/** Pinned Devin CLI version installed into the harness image. */
export const DEVIN_HARNESS_VERSION = '3000.1.27';
export const DEVIN_IMAGE = `agentbattler-devin:${DEVIN_HARNESS_VERSION}`;
export const DEVIN_RUNTIME_DOCKER = 'docker';
export const DEVIN_RUNTIME_HOST = 'host';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

/** Resolve generation runtime: docker (default) or host XDG isolation. */
export function resolveDevinRuntime(value = process.env.AGENTBATTLER_DEVIN_RUNTIME) {
  const runtime = (value ?? DEVIN_RUNTIME_DOCKER).trim().toLowerCase();
  if (runtime === DEVIN_RUNTIME_DOCKER || runtime === DEVIN_RUNTIME_HOST) return runtime;
  throw new Error(`AGENTBATTLER_DEVIN_RUNTIME must be "${DEVIN_RUNTIME_DOCKER}" or "${DEVIN_RUNTIME_HOST}"`);
}

/** Stable id fragment for a Devin model name. */
export function modelSlug(model) {
  invariant(typeof model === 'string' && model.trim().length > 0, 'model is required');
  const slug = model
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  invariant(slug.length > 0, `model "${model}" does not produce a usable slug`);
  return slug;
}

/**
 * Minimal Devin user config used for isolated generation.
 * Disables MCP, hooks, and foreign tool-config imports. Skills and rules
 * outside this config root are avoided by pointing XDG_CONFIG_HOME at an
 * ephemeral directory that only contains this file (plus no skills tree).
 */
export function buildIsolatedDevinConfig({ model }) {
  invariant(typeof model === 'string' && model.length > 0, 'model is required');
  return {
    agent: {
      model,
      show_history_on_continue: false,
    },
    attribution: false,
    auto_update: false,
    notify: 'never',
    show_hints: false,
    mcpServers: {},
    hooks: {},
    permissions: {
      allow: [],
      deny: [],
      ask: [],
    },
    read_config_from: {
      cursor: false,
      windsurf: false,
      claude: false,
    },
  };
}

/**
 * Build the Devin CLI argv (without the binary) for one unattended generation.
 * The child should run with cwd=workspace and an isolated XDG_CONFIG_HOME /
 * XDG_DATA_HOME that holds only the stripped config and a copied credential.
 */
export function buildDevinCliArgs({
  model,
  promptFile,
  configPath,
  exportPath,
  permissionMode = DEVIN_PERMISSION_MODE,
}) {
  for (const [name, value] of Object.entries({ model, promptFile, configPath, exportPath, permissionMode })) {
    invariant(typeof value === 'string' && value.length > 0, `${name} is required to run Devin`);
  }
  return [
    '-p',
    '--permission-mode', permissionMode,
    '--model', model,
    '--config', configPath,
    '--prompt-file', promptFile,
    '--export', exportPath,
    '--respect-workspace-trust', 'false',
  ];
}

/**
 * Build docker run argv (without the `docker` binary) for Pi-grade isolation.
 * Writable mounts: workspace, ephemeral Devin home, export directory.
 * Prompt is mounted read-only. Image filesystem is read-only.
 */
export function buildDevinDockerArgs({
  image = DEVIN_IMAGE,
  model,
  workspace,
  devinHome,
  exportDir,
  promptFile,
  user,
  permissionMode = DEVIN_PERMISSION_MODE,
}) {
  for (const [name, value] of Object.entries({
    image, model, workspace, devinHome, exportDir, promptFile, user, permissionMode,
  })) {
    invariant(typeof value === 'string' && value.length > 0, `${name} is required to run Devin in Docker`);
  }

  const containerConfig = '/devin-home/xdg-config/devin/config.json';
  const containerPrompt = '/prompt/chess-agent-v1.md';
  const containerExport = '/export/devin-export.json';
  const cliArgs = buildDevinCliArgs({
    model,
    promptFile: containerPrompt,
    configPath: containerConfig,
    exportPath: containerExport,
    permissionMode,
  });

  return [
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
    '--env', 'HOME=/devin-home',
    '--env', 'XDG_CONFIG_HOME=/devin-home/xdg-config',
    '--env', 'XDG_DATA_HOME=/devin-home/xdg-data',
    '--env', 'XDG_CACHE_HOME=/devin-home/xdg-cache',
    '--env', `DEVIN_PERMISSION_MODE=${permissionMode}`,
    '--env', 'NO_COLOR=1',
    '--volume', `${workspace}:/workspace:rw`,
    '--volume', `${devinHome}:/devin-home:rw`,
    '--volume', `${exportDir}:/export:rw`,
    '--volume', `${promptFile}:${containerPrompt}:ro`,
    '--workdir', '/workspace',
    image,
    ...cliArgs,
  ];
}

/** Public form of the CLI/docker command with ephemeral paths replaced. */
export function publicDevinCommand(args, {
  workspace,
  configHome,
  dataHome,
  promptFile,
  devinHome,
  exportDir,
  prefix = ['devin'],
} = {}) {
  const replacements = [
    [workspace, '<ephemeral-workspace>'],
    [configHome, '<ephemeral-xdg-config>'],
    [dataHome, '<ephemeral-xdg-data>'],
    [devinHome, '<ephemeral-devin-home>'],
    [exportDir, '<ephemeral-export>'],
    [promptFile, '<prompt-file>'],
  ].filter(([from]) => typeof from === 'string' && from.length > 0);

  return [...prefix, ...args.map((value) => {
    let next = value;
    for (const [from, to] of replacements) next = next.split(from).join(to);
    return next;
  })];
}

function countBy(values) {
  return Object.fromEntries(
    [...new Set(values)].sort().map((value) => [value, values.filter((item) => item === value).length]),
  );
}

/**
 * Best-effort telemetry from a Devin `--export` conversation document.
 * Supports ATIF-v1.x (`steps` + `final_metrics`) and looser message arrays.
 */
export function parseDevinExport(content) {
  const empty = {
    format: 'empty',
    sessionId: null,
    eventCount: 0,
    eventTypes: {},
    turnCount: 0,
    toolCallCount: 0,
    toolCallBreakdown: {},
    mcpCallCount: 0,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    totalTokens: null,
    model: null,
  };
  if (typeof content !== 'string' || content.trim().length === 0) return empty;

  let document;
  try {
    document = JSON.parse(content);
  } catch {
    const lines = content.split(/\r?\n/).filter((line) => line.trim());
    const events = [];
    for (const line of lines) {
      try {
        events.push(JSON.parse(line));
      } catch {
        // ignore non-JSON noise
      }
    }
    return summarizeExportEvents(events, 'jsonl');
  }

  if (Array.isArray(document)) return summarizeExportEvents(document, 'json-array');
  if (document && typeof document === 'object') {
    // ATIF-v1.x (Devin CLI --export)
    if (Array.isArray(document.steps) || document.schema_version || document.final_metrics) {
      return summarizeAtifDocument(document);
    }
    const candidates = [
      document.messages,
      document.turns,
      document.events,
      document.conversation,
      document.items,
    ].find((value) => Array.isArray(value));
    if (candidates) {
      const summary = summarizeExportEvents(candidates, document.format ?? document.schema ?? 'atif-object');
      summary.sessionId = summary.sessionId
        ?? document.session_id
        ?? document.sessionId
        ?? document.id
        ?? null;
      summary.model = summary.model
        ?? document.model
        ?? document.agent?.model
        ?? document.agent?.model_name
        ?? null;
      if (document.usage && typeof document.usage === 'object') {
        summary.inputTokens = numberOrNull(document.usage.input_tokens ?? document.usage.inputTokens ?? document.usage.input);
        summary.outputTokens = numberOrNull(document.usage.output_tokens ?? document.usage.outputTokens ?? document.usage.output);
        summary.totalTokens = numberOrNull(
          document.usage.total_tokens
          ?? document.usage.totalTokens
          ?? (
            Number.isFinite(summary.inputTokens) && Number.isFinite(summary.outputTokens)
              ? summary.inputTokens + summary.outputTokens
              : null
          ),
        );
      }
      return summary;
    }
    return summarizeExportEvents([document], document.format ?? 'atif-single');
  }

  return summarizeExportEvents([], 'unknown');
}

function summarizeAtifDocument(document) {
  const steps = Array.isArray(document.steps) ? document.steps : [];
  const toolNames = [];
  let mcpCallCount = 0;
  for (const step of steps) {
    const toolCalls = Array.isArray(step?.tool_calls) ? step.tool_calls
      : Array.isArray(step?.tools) ? step.tools
        : Array.isArray(step?.toolCalls) ? step.toolCalls
          : [];
    for (const call of toolCalls) {
      // ATIF uses function_name; some dumps nest under function.name.
      const name = call?.function_name
        ?? call?.function?.name
        ?? call?.name
        ?? call?.tool_name
        ?? call?.toolName
        ?? null;
      if (typeof name === 'string' && name.length > 0) {
        toolNames.push(name);
        if (/mcp/i.test(name)) mcpCallCount += 1;
      }
    }
    // Some ATIF exports nest tool use inside message content.
    const content = step?.message?.content ?? step?.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part?.type === 'toolCall' || part?.type === 'tool_use' || part?.type === 'tool_call') {
          const name = part.name ?? part.toolName ?? part.tool_name;
          if (typeof name === 'string' && name.length > 0) {
            toolNames.push(name);
            if (/mcp/i.test(name)) mcpCallCount += 1;
          }
        }
      }
    }
  }

  const metrics = document.final_metrics ?? document.metrics ?? {};
  const inputTokens = numberOrNull(
    metrics.total_prompt_tokens ?? metrics.prompt_tokens ?? metrics.input_tokens,
  );
  const outputTokens = numberOrNull(
    metrics.total_completion_tokens ?? metrics.completion_tokens ?? metrics.output_tokens,
  );
  const cachedInputTokens = numberOrNull(
    metrics.total_cached_tokens ?? metrics.cached_tokens ?? metrics.cache_read_tokens,
  );
  const totalTokens = numberOrNull(
    metrics.total_tokens
    ?? (
      Number.isFinite(inputTokens) && Number.isFinite(outputTokens)
        ? inputTokens + outputTokens
        : null
    ),
  );

  return {
    format: document.schema_version ?? 'atif',
    sessionId: document.session_id ?? document.sessionId ?? null,
    eventCount: steps.length,
    eventTypes: countBy(steps.map((step) => step?.type ?? step?.role ?? step?.kind ?? 'step')),
    turnCount: numberOrNull(metrics.total_steps) ?? steps.length,
    toolCallCount: toolNames.length,
    toolCallBreakdown: countBy(toolNames),
    mcpCallCount,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    totalTokens,
    model: document.agent?.model_name ?? document.agent?.model ?? document.model ?? null,
  };
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function summarizeExportEvents(events, format) {
  const toolNames = [];
  let turnCount = 0;
  let sessionId = null;
  let model = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let sawTokens = false;
  let mcpCallCount = 0;

  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    sessionId = sessionId
      ?? event.session_id
      ?? event.sessionId
      ?? event.thread_id
      ?? event.id
      ?? null;
    model = model
      ?? event.model
      ?? event.message?.model
      ?? null;

    const type = event.type ?? event.role ?? event.kind ?? 'event';
    if (type === 'turn' || type === 'turn_start' || type === 'assistant' || event.role === 'assistant') {
      turnCount += 1;
    }

    const usage = event.usage ?? event.message?.usage ?? event.telemetry?.usage;
    if (usage && typeof usage === 'object') {
      const input = numberOrNull(usage.input_tokens ?? usage.inputTokens ?? usage.input);
      const output = numberOrNull(usage.output_tokens ?? usage.outputTokens ?? usage.output);
      if (input !== null) {
        inputTokens += input;
        sawTokens = true;
      }
      if (output !== null) {
        outputTokens += output;
        sawTokens = true;
      }
    }

    const toolCandidates = [
      event.tool_name,
      event.toolName,
      event.name,
      event.tool?.name,
      ...(Array.isArray(event.content)
        ? event.content.flatMap((part) => (part?.type === 'toolCall' || part?.type === 'tool_use' ? [part.name ?? part.toolName] : []))
        : []),
    ].filter((value) => typeof value === 'string' && value.length > 0);

    for (const name of toolCandidates) {
      toolNames.push(name);
      if (/mcp/i.test(name)) mcpCallCount += 1;
    }

    if (type === 'tool_use' || type === 'tool_call' || type === 'tool_execution_start') {
      const name = event.tool_name ?? event.toolName ?? event.name ?? 'tool';
      if (!toolCandidates.includes(name)) toolNames.push(name);
    }
  }

  return {
    format,
    sessionId: typeof sessionId === 'string' ? sessionId : null,
    eventCount: events.length,
    eventTypes: countBy(events.map((event) => event?.type ?? event?.role ?? event?.kind ?? 'event')),
    turnCount: turnCount || events.filter((event) => event?.role === 'assistant' || event?.type === 'assistant').length,
    toolCallCount: toolNames.length,
    toolCallBreakdown: countBy(toolNames),
    mcpCallCount,
    inputTokens: sawTokens ? inputTokens : null,
    outputTokens: sawTokens ? outputTokens : null,
    cachedInputTokens: null,
    totalTokens: sawTokens ? inputTokens + outputTokens : null,
    model: typeof model === 'string' ? model : null,
  };
}

/**
 * Validate host preflight identity from `devin auth status` text / exit.
 * Does not parse secrets — only requires a successful login.
 */
export function requireDevinAuthentication({ exitCode, stdoutText = '', stderrText = '' }) {
  invariant(exitCode === 0, 'Devin authentication failed; run `devin auth login`');
  const text = `${stdoutText}\n${stderrText}`;
  invariant(/Logged in/i.test(text), 'Devin authentication status did not report Logged in; run `devin auth login`');
  return {
    method: 'devin-account',
    subscriptionAccess: /Devin Pro|Plan:\s*Pro|Tier:\s*Devin/i.test(text),
    provider: 'devin',
  };
}

/** Parse `devin --version` into a stable harness version string. */
export function parseDevinVersion(text) {
  const match = String(text).match(/devin\s+([0-9]+(?:\.[0-9]+){1,3}(?:-[0-9a-z.]+)?)/i)
    ?? String(text).match(/\b([0-9]+\.[0-9]+\.[0-9]+)\b/);
  invariant(match, `Could not parse Devin CLI version from: ${text}`);
  return match[1];
}
