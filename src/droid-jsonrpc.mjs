import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

import {
  DROID_CONTEXT_POLICY,
  DROID_RESTRICTED_TOOLS,
  droidCustomModelId,
} from './droid-harness.mjs';

const JSON_RPC_VERSION = '2.0';
const FACTORY_API_VERSION = '1.0.0';
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

function invariant(condition, message) { if (!condition) throw new Error(message); }

function usage(value = {}) {
  return {
    inputTokens: Number(value.inputTokens ?? value.input_tokens ?? 0),
    outputTokens: Number(value.outputTokens ?? value.output_tokens ?? 0),
    cachedInputTokens: Number(value.cacheReadTokens ?? value.cache_read_input_tokens ?? 0),
    cacheCreationTokens: Number(value.cacheCreationTokens ?? value.cache_creation_input_tokens ?? 0),
    reasoningTokens: Number(value.thinkingTokens ?? value.reasoning_tokens ?? 0),
  };
}

function notificationOf(message) {
  return message?.type === 'notification' && message.method === 'droid.session_notification'
    ? message.params?.notification ?? null
    : null;
}

function toolUsesFromNotification(notification) {
  if (notification?.type === 'tool_call' && notification.toolUse) return [notification.toolUse];
  if (notification?.type !== 'create_message' || notification.message?.role !== 'assistant') return [];
  return (notification.message.content ?? []).filter((block) => block?.type === 'tool_use');
}

export function summarizeDroidRpcTurn(messages, { sessionId, startedAt = Date.now(), beforeContext = null, afterContext = null } = {}) {
  const notifications = messages.map(notificationOf).filter(Boolean);
  const completion = [...notifications].reverse().find((event) => event.type === 'agent_turn_completed') ?? null;
  const errors = notifications.filter((event) => event.type === 'error');
  const assistantMessages = notifications.filter((event) => event.type === 'create_message' && event.message?.role === 'assistant');
  const finalText = assistantMessages.at(-1)?.message?.content?.filter((block) => block?.type === 'text').map((block) => block.text).join('')
    ?? notifications.filter((event) => event.type === 'assistant_text_delta').map((event) => event.textDelta ?? '').join('');
  const toolUseMap = new Map();
  for (const notification of notifications) {
    for (const toolUse of toolUsesFromNotification(notification)) toolUseMap.set(toolUse.id ?? `${toolUse.name}:${toolUseMap.size}`, toolUse);
  }
  const toolUses = [...toolUseMap.values()];
  const compactionEvents = notifications.filter((event) => event.type === 'session_compacted');
  return {
    sessionId,
    success: errors.length === 0 && (!completion || completion.reason === 'completed'),
    stopReason: completion?.reason ?? (errors.length > 0 ? 'error' : null),
    finalText,
    durationMs: completion?.durationMs ?? Date.now() - startedAt,
    eventCount: messages.length,
    toolCallCount: toolUses.length,
    toolCallBreakdown: Object.fromEntries([...new Set(toolUses.map((toolUse) => toolUse.name ?? 'unknown'))]
      .map((name) => [name, toolUses.filter((toolUse) => (toolUse.name ?? 'unknown') === name).length])),
    usage: usage(completion?.tokenUsage ?? [...notifications].reverse().find((event) => event.type === 'session_token_usage_changed')?.tokenUsage),
    errors,
    compaction: {
      count: compactionEvents.length,
      boundaries: compactionEvents.map((event) => ({
        summaryId: event.summaryId ?? null,
        removedCount: event.removedCount ?? null,
        visibleBoundaryMessageId: event.visibleBoundaryMessageId ?? null,
        beforeTokens: beforeContext?.used ?? null,
        afterTokens: afterContext?.used ?? null,
      })),
    },
    beforeContext,
    afterContext,
  };
}

export class DroidJsonRpcSession {
  constructor({
    workspace,
    model,
    env,
    timeoutMs = null,
    onMessage = null,
    reasoningEffort = 'high',
    launcher = null,
    allowedTools = DROID_RESTRICTED_TOOLS,
  }) {
    invariant(Array.isArray(allowedTools) && allowedTools.length > 0, 'Droid allowedTools must be a non-empty array');
    invariant(allowedTools.every((name) => typeof name === 'string' && DROID_RESTRICTED_TOOLS.includes(name)), 'Droid allowedTools contains an unsupported tool');
    invariant(new Set(allowedTools).size === allowedTools.length, 'Droid allowedTools contains duplicates');
    this.workspace = workspace;
    this.model = model;
    this.env = env;
    this.timeoutMs = timeoutMs;
    this.onMessage = onMessage;
    this.reasoningEffort = reasoningEffort;
    this.launcher = launcher;
    this.allowedTools = Object.freeze([...allowedTools]);
    this.messages = [];
    this.stderr = [];
    this.pending = new Map();
    this.turnWaiters = new Set();
    this.sessionId = null;
    this.protocolVersion = null;
    this.closed = false;
    this.child = null;
  }

  async start() {
    invariant(!this.child, 'Droid JSON-RPC session is already started');
    const command = this.launcher?.command ?? 'droid';
    const args = [...(this.launcher?.argsPrefix ?? []), 'exec', '--input-format', 'stream-jsonrpc', '--output-format', 'stream-jsonrpc'];
    this.child = spawn(command, args, {
      cwd: this.workspace,
      env: this.env,
      shell: false,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.on('data', (chunk) => this.stderr.push(chunk));
    this.child.once('error', (error) => this.#fail(error));
    this.child.once('exit', (code, signal) => {
      if (!this.closed) this.#fail(new Error(`Droid JSON-RPC process exited (code ${code}, signal ${signal ?? 'none'})`));
    });
    this.lines = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.lines.on('line', (line) => {
      if (!line.trim().startsWith('{')) return;
      let message;
      try { message = JSON.parse(line); } catch { return; }
      this.#handleMessage(message);
    });

    const init = await this.request('droid.initialize_session', {
      machineId: 'agentbattler',
      cwd: this.workspace,
      modelId: droidCustomModelId(this.model),
      interactionMode: 'auto',
      autonomyLevel: 'medium',
      reasoningEffort: this.reasoningEffort,
      compactionThresholdCheckEnabled: true,
      disableBuiltinSkills: true,
    });
    invariant(typeof init?.sessionId === 'string', 'Droid initialize_session returned no session ID');
    invariant(init.settings?.modelId === droidCustomModelId(this.model), `Droid initialized model ${init.settings?.modelId ?? 'missing'}`);
    this.sessionId = init.sessionId;

    const catalog = await this.request('droid.list_tools', {});
    const allowed = (catalog?.tools ?? []).filter((tool) => this.allowedTools.includes(tool.llmId));
    invariant(allowed.length === this.allowedTools.length, `Droid tool catalog is missing: ${this.allowedTools.filter((name) => !allowed.some((tool) => tool.llmId === name)).join(', ')} (available: ${(catalog?.tools ?? []).map((tool) => tool.llmId).join(', ')})`);
    const restrictToolIds = allowed.map((tool) => tool.id).sort();
    await this.request('droid.update_session_settings', {
      restrictToolIds,
      compactionTokenLimit: DROID_CONTEXT_POLICY.compactionTokenLimit,
      compactionThresholdCheckEnabled: true,
    });
    const settingsEvidence = await this.request('droid.get_context_stats', {});
    invariant(settingsEvidence?.limit === DROID_CONTEXT_POLICY.compactionTokenLimit, `Droid context limit is ${settingsEvidence?.limit ?? 'missing'}, expected ${DROID_CONTEXT_POLICY.compactionTokenLimit}`);
    this.settingsEvidence = { init: init.settings, allowedTools: [...this.allowedTools], restrictToolIds, context: settingsEvidence };
    return { sessionId: this.sessionId, settings: this.settingsEvidence };
  }

  request(method, params, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    invariant(this.child?.stdin?.writable, 'Droid JSON-RPC stdin is unavailable');
    const id = randomUUID();
    const message = {
      jsonrpc: JSON_RPC_VERSION,
      factoryApiVersion: FACTORY_API_VERSION,
      ...(this.protocolVersion ? { factoryProtocolVersion: this.protocolVersion } : {}),
      type: 'request', id, method, params,
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Droid JSON-RPC request ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer); this.pending.delete(id); reject(error);
      });
    });
  }

  async turn(prompt, timeoutMs = this.timeoutMs) {
    invariant(this.sessionId, 'Droid JSON-RPC session is not initialized');
    const beforeContext = await this.request('droid.get_context_stats', {});
    const startIndex = this.messages.length;
    const startedAt = Date.now();
    let sawWork = false;
    let fallbackTimer = null;
    let cancelWaiter = null;
    const completed = new Promise((resolve, reject) => {
      const deadline = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? setTimeout(() => {
        this.turnWaiters.delete(waiter);
        reject(new Error(`Droid turn timed out after ${timeoutMs} ms`));
      }, timeoutMs) : null;
      cancelWaiter = () => {
        if (deadline) clearTimeout(deadline);
        if (fallbackTimer) clearTimeout(fallbackTimer);
        this.turnWaiters.delete(waiter);
      };
      const finish = () => {
        cancelWaiter();
        resolve();
      };
      const waiter = (message) => {
        const event = notificationOf(message);
        if (!event) return;
        if (event.type === 'droid_working_state_changed') {
          if (event.newState !== 'idle') sawWork = true;
          else if (sawWork) fallbackTimer = setTimeout(finish, 500);
        }
        if (event.type === 'agent_turn_completed') finish();
        if (event.type === 'error') {
          cancelWaiter();
          reject(new Error(event.message ?? 'Droid emitted an error event'));
        }
      };
      this.turnWaiters.add(waiter);
    });
    try {
      await this.request('droid.add_user_message', { text: prompt });
      await completed;
    } catch (error) {
      cancelWaiter?.();
      throw error;
    }
    const afterContext = await this.request('droid.get_context_stats', {});
    const turnMessages = this.messages.slice(startIndex);
    const summary = summarizeDroidRpcTurn(turnMessages, { sessionId: this.sessionId, startedAt, beforeContext, afterContext });
    invariant(summary.success, `Droid turn failed: ${summary.errors.map((error) => error.message).join('; ') || 'unknown error'}`);
    return { summary, messages: turnMessages };
  }

  async close() {
    if (this.closed) return;
    try { if (this.sessionId && this.child?.stdin?.writable) await this.request('droid.close_session', { reason: 'other' }, 5_000).catch(() => {}); }
    finally {
      this.closed = true;
      this.lines?.close();
      await this.#terminateProcess();
    }
  }

  stderrText() { return Buffer.concat(this.stderr).toString('utf8'); }

  #handleMessage(message) {
    if (typeof message.factoryProtocolVersion === 'string') this.protocolVersion = message.factoryProtocolVersion;
    this.messages.push(message);
    this.onMessage?.(message);
    if (message.type === 'response' && typeof message.id === 'string') {
      const pending = this.pending.get(message.id);
      if (pending) {
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result);
      }
    } else if (message.type === 'request' && typeof message.id === 'string') {
      this.#handleServerRequest(message);
    }
    for (const waiter of this.turnWaiters) waiter(message);
  }

  #handleServerRequest(message) {
    let result;
    if (message.method === 'droid.request_permission') {
      const names = (message.params?.toolUses ?? []).map((entry) => entry.toolUse?.name).filter(Boolean);
      const allowed = names.length > 0 && names.every((name) => this.allowedTools.includes(name));
      result = { selectedOption: allowed ? 'proceed_once' : 'cancel' };
    } else if (message.method === 'droid.ask_user') {
      result = { cancelled: true, answers: [] };
    } else return;
    const response = {
      jsonrpc: JSON_RPC_VERSION,
      factoryApiVersion: FACTORY_API_VERSION,
      ...(this.protocolVersion ? { factoryProtocolVersion: this.protocolVersion } : {}),
      type: 'response', id: message.id, result,
    };
    this.child.stdin.write(`${JSON.stringify(response)}\n`);
  }

  #fail(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const waiter of this.turnWaiters) waiter({ type: 'notification', method: 'droid.session_notification', params: { notification: { type: 'error', message: error.message } } });
  }

  async #terminateProcess() {
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) return;
    const killGroup = (signal) => {
      try { process.kill(-this.child.pid, signal); } catch { try { this.child.kill(signal); } catch {} }
    };
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(forceTimer);
        clearTimeout(giveUpTimer);
        resolve();
      };
      this.child.once('exit', finish);
      const forceTimer = setTimeout(() => killGroup('SIGKILL'), 5_000);
      const giveUpTimer = setTimeout(finish, 7_000);
      killGroup('SIGTERM');
    });
  }
}
