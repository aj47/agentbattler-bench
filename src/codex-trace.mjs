function string(value) {
  return typeof value === 'string' ? value : '';
}

function integer(value) {
  return Number.isSafeInteger(value) ? value : null;
}

function summarize(event) {
  const item = event.item ?? {};
  if (item.type === 'agent_message') return string(item.text);
  if (item.type === 'command_execution') {
    const command = string(item.command);
    const output = string(item.aggregated_output);
    return [`$ ${command}`, output].filter(Boolean).join('\n\n');
  }
  if (item.type === 'file_change') {
    return (item.changes ?? [])
      .map((change) => `${string(change.kind) || 'change'} ${string(change.path)}`.trim())
      .join('\n');
  }
  if (event.type === 'thread.started') return `Thread ${string(event.thread_id)} started`.trim();
  if (event.type === 'turn.started') return 'Turn started';
  if (event.type === 'turn.completed') return 'Turn completed';
  return string(event.type);
}

export function normalizeCodexEvent(event, context) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Codex trace event must be an object');
  if (!Number.isSafeInteger(context?.sequence) || context.sequence < 1) throw new Error('Codex trace sequence must be a positive integer');
  const item = event.item ?? {};
  const usage = event.usage ?? {};
  return {
    snapshotId: context.snapshotId,
    runId: context.runId,
    sequence: context.sequence,
    agentId: context.agentId,
    displayName: context.displayName,
    harness: 'codex-cli',
    model: context.model,
    reasoningEffort: context.reasoningEffort,
    eventType: string(event.type),
    itemType: string(item.type),
    itemId: string(item.id),
    status: string(item.status),
    summary: summarize(event),
    message: string(item.text),
    command: string(item.command),
    output: string(item.aggregated_output),
    exitCode: integer(item.exit_code),
    fileChanges: JSON.stringify(item.changes ?? []),
    inputTokens: integer(usage.input_tokens),
    cachedInputTokens: integer(usage.cached_input_tokens),
    outputTokens: integer(usage.output_tokens),
    reasoningTokens: integer(usage.reasoning_output_tokens),
    rawEvent: JSON.stringify(event),
  };
}

export function parseCodexTrace(content, context) {
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return lines.map((line, index) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid Codex trace JSON on line ${index + 1}: ${error.message}`);
    }
    return normalizeCodexEvent(event, { ...context, sequence: index + 1 });
  });
}
