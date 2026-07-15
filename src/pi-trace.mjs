function string(value) {
  return typeof value === 'string' ? value : '';
}
function integer(value) {
  return Number.isSafeInteger(value) ? value : null;
}
function textContent(content) {
  if (!Array.isArray(content)) return '';
  return content.filter((item) => item?.type === 'text').map((item) => string(item.text)).join('\n');
}
function summarize(event) {
  if (event.type === 'session') return `Session ${string(event.id)} started`;
  if (event.type === 'turn_start') return 'Turn started';
  if (event.type === 'turn_end') return 'Turn completed';
  if (event.type === 'agent_start') return 'Agent started';
  if (event.type === 'agent_end') return 'Agent completed';
  if (event.type === 'tool_execution_start') return `${string(event.toolName)} ${JSON.stringify(event.args ?? {})}`.trim();
  if (event.type === 'tool_execution_end') return [string(event.toolName), string(event.result?.content?.[0]?.text)].filter(Boolean).join('\n\n');
  if (event.type === 'message_end') return textContent(event.message?.content) || `${string(event.message?.role)} message`;
  return string(event.type);
}

export function normalizePiEvent(event, context) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Pi trace event must be an object');
  if (!Number.isSafeInteger(context?.sequence) || context.sequence < 1) throw new Error('Pi trace sequence must be a positive integer');
  const usage = event.message?.usage ?? event.usage ?? {};
  return {
    snapshotId: context.snapshotId,
    runId: context.runId,
    sequence: context.sequence,
    agentId: context.agentId,
    displayName: context.displayName,
    harness: 'pi-coding-agent',
    model: context.model,
    reasoningEffort: context.reasoningEffort,
    eventType: string(event.type),
    itemType: string(event.assistantMessageEvent?.type),
    itemId: string(event.toolCallId),
    status: event.isError === true ? 'error' : '',
    summary: summarize(event),
    message: textContent(event.message?.content),
    command: event.toolName === 'bash' ? string(event.args?.command) : '',
    output: event.type === 'tool_execution_end' ? string(event.result?.content?.[0]?.text) : '',
    exitCode: integer(event.result?.details?.exitCode),
    fileChanges: '[]',
    inputTokens: integer(usage.input),
    cachedInputTokens: integer(usage.cacheRead),
    outputTokens: integer(usage.output),
    reasoningTokens: null,
    rawEvent: JSON.stringify(event),
  };
}

export function parsePiTrace(content, context) {
  const records = [];
  let start = 0;
  let sourceIndex = 0;
  while (start <= content.length) {
    const end = content.indexOf('\n', start);
    const line = (end === -1 ? content.slice(start) : content.slice(start, end)).replace(/\r$/, '');
    start = end === -1 ? content.length + 1 : end + 1;
    if (!line.trim()) continue;
    sourceIndex += 1;
    if (line.startsWith('{"type":"message_update"') || line.startsWith('{"type":"tool_execution_update"')) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid Pi trace JSON on line ${sourceIndex}: ${error.message}`);
    }
    if (event.type === 'message_update' || event.type === 'tool_execution_update') continue;
    records.push(normalizePiEvent(event, { ...context, sequence: sourceIndex }));
  }
  return records;
}

export async function parsePiTraceFile(file, context) {
  const records = [];
  let sourceIndex = 0;
  const lines = readline.createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    sourceIndex += 1;
    if (line.startsWith('{"type":"message_update"') || line.startsWith('{"type":"tool_execution_update"')) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid Pi trace JSON on line ${sourceIndex}: ${error.message}`);
    }
    if (event.type === 'message_update' || event.type === 'tool_execution_update') continue;
    records.push(normalizePiEvent(event, { ...context, sequence: sourceIndex }));
  }
  return records;
}
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
