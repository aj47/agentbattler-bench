#!/usr/bin/env node
import { createServer } from 'node:net';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { terminalChallengeRuntime } from '../src/terminal-challenge-runtime.mjs';

const CLAUDE_VERSION = process.env.AGENTBATTLER_CLAUDE_VERSION ?? '2.1.211';
const REASONING = 'high';
const ADAPTER_BINARY = process.env.AGENTBATTLER_CLAUDE_ADAPTER_BIN;
export const harnesses = ['claude-code'];
const { prompts, publicVerifier, holdoutVerifier } = terminalChallengeRuntime;

function invariant(condition, message) { if (!condition) throw new Error(message); }

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(url, childState) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (childState.closed) throw new Error(`Claude gateway exited before health check (${childState.exitCode})`);
    try {
      if ((await fetch(`${url}/health`, { signal: AbortSignal.timeout(1_000) })).ok) return;
    } catch { /* wait for the loopback gateway */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Claude loopback gateway did not become healthy within 60 seconds');
}

function isolatedEnv(home, baseUrl) {
  const keep = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'SHELL'];
  return {
    ...Object.fromEntries(keep.flatMap((key) => typeof process.env[key] === 'string' ? [[key, process.env[key]]] : [])),
    HOME: home,
    TMPDIR: path.join(home, 'tmp'),
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_API_KEY: 'local-gateway-only',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_BUG_COMMAND: '1',
    DISABLE_AUTOUPDATER: '1',
  };
}

function parseEvents(content) {
  return content.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch (error) { throw new Error(`Claude JSONL parse failed on line ${index + 1}: ${error.message}`); }
  });
}

function networkCommandReason(command) {
  if (typeof command !== 'string') return null;
  if (/(^|[;&|()\s])(curl|wget|nc|ncat|netcat|telnet|ftp|sftp|ssh|scp|rsync)(?=\s|$)/i.test(command)) return 'network-capable command';
  if (/https?:\/\/|\/dev\/(tcp|udp)\//i.test(command)) return 'network address';
  if (/\b(fetch|XMLHttpRequest|WebSocket)\s*\(/i.test(command)) return 'programmatic network API';
  if (/\b(import|require)\s*\(?\s*['"](?:node:)?(?:http|https|net|tls|dns|dgram)['"]/i.test(command)) return 'network module';
  return null;
}

function summarize(events, expectedModel) {
  invariant(events.length > 0, 'Claude trace is empty');
  const init = events.find((event) => event.type === 'system' && event.subtype === 'init');
  const result = [...events].reverse().find((event) => event.type === 'result');
  invariant(init?.model === expectedModel, `Claude trace model is not ${expectedModel}`);
  invariant(Array.isArray(init.mcp_servers) && init.mcp_servers.length === 0, 'Claude trace has MCP servers');
  invariant(Array.isArray(init.plugins) && init.plugins.length === 0, 'Claude trace has plugins');
  invariant(Array.isArray(init.skills) && init.skills.length === 0, 'Claude trace has skills');
  invariant(result?.subtype === 'success' && result.is_error === false, 'Claude turn did not finish successfully');
  invariant(init.analytics_disabled === true && init.product_feedback_disabled === true, 'Claude nonessential traffic was not disabled');
  const uses = events.flatMap((event) => event.type === 'assistant' ? (event.message?.content ?? []) : [])
    .filter((item) => item.type === 'tool_use');
  const allowed = new Set(['Read', 'Edit', 'Write', 'Bash']);
  invariant(uses.every((item) => allowed.has(item.name)), `Claude used unexpected tools: ${[...new Set(uses.filter((item) => !allowed.has(item.name)).map((item) => item.name))].join(', ')}`);
  for (const use of uses) {
    const command = use.name === 'Bash' ? use.input?.command : null;
    invariant(!networkCommandReason(command), `Claude command violates the no-network contract: ${networkCommandReason(command)}`);
  }
  const usage = result.modelUsage?.[expectedModel] ?? {};
  return {
    sessionId: result.session_id ?? init.session_id ?? null,
    toolCallCount: uses.length,
    inputTokens: usage.inputTokens ?? 0,
    cachedInputTokens: usage.cacheReadInputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    reasoningTokens: usage.reasoningTokens ?? 0,
  };
}

function runClaude({ args, cwd, env, outputPath, errorPath, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd, env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = []; const stderr = []; let timedOut = false;
    const timer = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, 15_000).unref();
    }, timeoutMs) : null;
    child.stdout.on('data', (chunk) => stdout.push(chunk)); child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => { if (timer) clearTimeout(timer); reject(error); });
    child.on('close', async (exitCode, signal) => {
      if (timer) clearTimeout(timer);
      const out = Buffer.concat(stdout).toString('utf8'); const err = Buffer.concat(stderr).toString('utf8');
      await writeFile(outputPath, out); await writeFile(errorPath, err);
      resolve({ exitCode, signal, timedOut, out, err, events: parseEvents(out) });
    });
  });
}

async function prepareGateway(runDirectory) {
  invariant(typeof ADAPTER_BINARY === 'string' && ADAPTER_BINARY.length > 0, 'Set AGENTBATTLER_CLAUDE_ADAPTER_BIN to the audited loopback gateway binary');
  const auth = JSON.parse(await readFile(path.join(os.homedir(), '.codex', 'auth.json'), 'utf8'));
  invariant(auth?.auth_mode === 'chatgpt' && auth.tokens?.access_token && auth.tokens?.refresh_token, 'Codex ChatGPT auth is unavailable for Claude gateway');
  const home = path.join(runDirectory, 'claude-home'); const adapterHome = path.join(home, '.claude-adapter');
  const config = path.join(runDirectory, 'claude-gateway.toml'); const port = await availablePort(); const baseUrl = `http://127.0.0.1:${port}`;
  await Promise.all([home, adapterHome, path.join(home, 'tmp')].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
  const expiry = (() => { try { return JSON.parse(Buffer.from(auth.tokens.access_token.split('.')[1], 'base64url').toString('utf8')).exp; } catch { return null; } })();
  invariant(Number.isFinite(expiry), 'Claude gateway auth token has no readable expiry');
  await writeFile(path.join(adapterHome, 'tokens-chatgpt.json'), `${JSON.stringify({ access_token: auth.tokens.access_token, refresh_token: auth.tokens.refresh_token, expires_at: expiry }, null, 2)}\n`, { mode: 0o600 });
  await writeFile(config, `[server]\nhost = "127.0.0.1"\nport = ${port}\nlog_level = "error"\nlog_file_enabled = false\nclaude_stream_idle_timeout_ms = 0\n\n[providers.chatgpt]\ntype = "chatgpt"\n\n[models]\ndefault_provider = "chatgpt"\ndefault_model = "gpt-5.6-terra"\n\n[models.routing]\n"gpt-5.6-terra" = { provider = "chatgpt", model = "gpt-5.6-terra" }\n"gpt-5.6-sol" = { provider = "chatgpt", model = "gpt-5.6-sol" }\n"gpt-5.6-luna" = { provider = "chatgpt", model = "gpt-5.6-luna" }\n`, { mode: 0o600 });
  await chmod(config, 0o600);
  const env = { PATH: process.env.PATH, HOME: home, RUST_LOG: 'error' };
  const child = spawn(ADAPTER_BINARY, ['serve', '--config', config], { cwd: runDirectory, env, stdio: ['ignore', 'ignore', 'ignore'] });
  const state = { closed: false, exitCode: null }; child.on('close', (code) => { state.closed = true; state.exitCode = code; });
  await waitForHealth(baseUrl, state);
  return { home, baseUrl, env: isolatedEnv(home, baseUrl), child, state };
}

async function stopGateway(gateway) {
  if (!gateway?.child || gateway.state.closed) return;
  gateway.child.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  if (!gateway.state.closed) gateway.child.kill('SIGKILL');
}

function claudeArgs({ model, sessionId, prompt }) {
  const session = sessionId ? ['--resume', sessionId] : ['--session-id', randomUUID()];
  return [
    ...session, '--bare', '--print', '--verbose', '--output-format', 'stream-json', '--model', model,
    '--effort', REASONING, '--permission-mode', 'bypassPermissions', '--allow-dangerously-skip-permissions',
    '--tools', 'Read,Edit,Write,Bash', '--allowedTools', 'Read,Edit,Write,Bash',
    '--disable-slash-commands', '--mcp-config', '{"mcpServers":{}}', '--strict-mcp-config', prompt,
  ];
}

export async function runTerminalJob({ challenge, job, runDirectory }) {
  invariant(job.harness === 'claude-code', `Claude adapter received ${job.harness}`);
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  const workspace = path.join(runDirectory, 'workspace'); await mkdir(workspace, { recursive: true, mode: 0o700 });
  const gateway = await prepareGateway(runDirectory);
  const stages = []; const turns = []; const sessionIds = [];
  const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  const runStartedAt = new Date().toISOString(); let sessionId = null; let toolCalls = 0;
  try {
    for (let index = 0; index < prompts.length; index += 1) {
      const startedAt = new Date().toISOString(); const startedClock = Date.now();
      const outputPath = path.join(runDirectory, `turn-${index + 1}.jsonl`); const errorPath = path.join(runDirectory, `turn-${index + 1}.stderr`);
      const result = await runClaude({ args: claudeArgs({ model: job.model, sessionId, prompt: prompts[index] }), cwd: workspace, env: gateway.env, outputPath, errorPath, timeoutMs: job.maxWallTimeMs });
      invariant(!result.timedOut && result.exitCode === 0 && !result.signal, `Claude turn ${index + 1} failed (exit ${result.exitCode}, signal ${result.signal ?? 'none'})`);
      const telemetry = summarize(result.events, job.model);
      invariant(telemetry.sessionId, `Claude turn ${index + 1} emitted no session ID`);
      if (!sessionId) sessionId = telemetry.sessionId;
      invariant(telemetry.sessionId === sessionId, `Claude session changed on turn ${index + 1}`);
      sessionIds.push(telemetry.sessionId); toolCalls += telemetry.toolCallCount;
      for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens']) usage[key] += telemetry[key];
      const stage = await publicVerifier.verifyPublicStage({ workspace, stageId: job.challengeStageIds?.[index] ?? challenge?.stages?.[index]?.id });
      stages.push({ ...stage, id: stage.id ?? stage.stageId });
      turns.push({ index: index + 1, sessionId: telemetry.sessionId, exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, startedAt, endedAt: new Date().toISOString(), durationMs: Date.now() - startedClock, usage: telemetry });
    }
    const holdout = await holdoutVerifier.verifyHoldout({ workspace });
    return { ...job, schemaVersion: 'agentbattler.terminal-run.v1', status: 'completed', validity: 'valid', harness: 'claude-code', harnessVersion: CLAUDE_VERSION, model: job.model, reasoningEffort: REASONING, sessionId, sameSessionProof: sessionIds.length === 8 && sessionIds.every((id) => id === sessionId), startedAt: runStartedAt, endedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(runStartedAt), turns, toolCalls, usage, stages, holdout, humanIntervention: 'none', workspace: { path: '<ephemeral-run-workspace>' } };
  } finally {
    await stopGateway(gateway);
  }
}
