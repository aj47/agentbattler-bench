#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { terminalChallengeRuntime } from '../src/terminal-challenge-runtime.mjs';
import {
  DOTAGENTS_COMMIT,
  DOTAGENTS_IMAGE,
  DOTAGENTS_PROFILE_ID,
  DOTAGENTS_VERSION,
  buildDotAgentsDockerArgs,
  createDotAgentsConfig,
  summarizeDotAgentsTrace,
} from '../src/dotagents-harness.mjs';
import { canonicalJson } from '../src/provenance.mjs';

const CODEX_AUTH = path.join(os.homedir(), '.codex', 'auth.json');
const IMAGE = process.env.AGENTBATTLER_DOTAGENTS_IMAGE ?? DOTAGENTS_IMAGE;
export const harnesses = ['dotagents-mono'];
const { prompts, publicVerifier, holdoutVerifier } = terminalChallengeRuntime;

function invariant(condition, message) { if (!condition) throw new Error(message); }

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function compactTraceEvent(event) {
  // DotAgents can include the entire stateful conversation in the final `done`
  // event. Keep the complete event on disk, but retain only the fields used by
  // the verifier in memory. This prevents a long run from hitting V8's string
  // limit while preserving the full trace artifact.
  if (event?.type === 'progress') {
    return {
      type: 'progress',
      data: {
        modelInfo: event.data?.modelInfo,
        steps: (event.data?.steps ?? []).filter((step) => step?.toolCall).map((step) => ({ toolCall: step.toolCall })),
        sessionCost: event.data?.sessionCost,
      },
    };
  }
  if (event?.type === 'done') {
    const conversationHistory = (event.data?.conversation_history ?? [])
      .filter((message) => Array.isArray(message?.toolCalls) && message.toolCalls.length > 0)
      .map((message) => ({ toolCalls: message.toolCalls }));
    return {
      type: 'done',
      data: {
        model: event.data?.model,
        content: '',
        conversation_id: event.data?.conversation_id,
        conversation_history: conversationHistory,
      },
    };
  }
  return null;
}

async function waitForHealth(port, apiKey, childState) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (childState.closed) throw new Error(`DotAgents container exited before health check (${childState.error?.code ?? childState.exitCode ?? 'unknown'})`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/v1/operator/health`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(1_000) })).ok) return;
    } catch { /* wait for the container */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('DotAgents container did not become healthy within 60 seconds');
}

async function streamTurn({ port, apiKey, prompt, conversationId, timeoutMs, outputPath }) {
  const body = {
    model: `agent:${DOTAGENTS_PROFILE_ID}`,
    profile_id: DOTAGENTS_PROFILE_ID,
    messages: [{ role: 'user', content: prompt }],
    stream: true,
    send_push_notification: false,
  };
  if (conversationId) body.conversation_id = conversationId;
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
  });
  invariant(response.ok, `DotAgents request failed (${response.status})`);
  invariant(response.body, 'DotAgents response has no streaming body');
  const trace = createWriteStream(outputPath, { mode: 0o600 });
  const events = [];
  const decoder = new TextDecoder();
  let pending = '';
  const writeEvent = async (event) => {
    const line = `${canonicalJson(event)}\n`;
    if (!trace.write(line)) await new Promise((resolve, reject) => {
      trace.once('drain', resolve);
      trace.once('error', reject);
    });
    const compact = compactTraceEvent(event);
    if (compact) events.push(compact);
  };
  const consumeLine = async (line) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    await writeEvent(JSON.parse(payload));
  };
  try {
    for await (const chunk of response.body) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) await consumeLine(line);
    }
    pending += decoder.decode();
    if (pending) await consumeLine(pending);
  } finally {
    trace.end();
    await finished(trace).catch(() => {});
  }
  invariant(events.some((event) => event?.type === 'done'), 'DotAgents stream ended without a done event');
  return { events };
}

async function writeConfig(configRoot, config) {
  const agentsRoot = path.join(configRoot, '.agents');
  for (const [relative, content] of Object.entries(config.files)) {
    const destination = path.join(agentsRoot, relative);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, content, { mode: 0o600 });
  }
}

async function startContainer(runDirectory, job) {
  const auth = JSON.parse(await readFile(CODEX_AUTH, 'utf8'));
  invariant(auth?.auth_mode === 'chatgpt' && auth.tokens?.access_token && auth.tokens?.refresh_token && auth.tokens?.account_id, 'Codex ChatGPT auth is unavailable for DotAgents');
  const home = path.join(runDirectory, 'dotagents-home'); const configRoot = path.join(runDirectory, 'config-workspace'); const workspace = path.join(runDirectory, 'workspace');
  await Promise.all([home, configRoot, workspace].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
  await mkdir(path.join(home, '.codex'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(home, '.codex', 'auth.json'), `${canonicalJson(auth, { space: 2 })}\n`, { mode: 0o600 });
  await chmod(path.join(home, '.codex', 'auth.json'), 0o600);
  const apiKey = randomBytes(32).toString('hex'); const port = await availablePort();
  await writeConfig(configRoot, createDotAgentsConfig({ model: job.model, remoteApiKey: apiKey, remotePort: 3210, stateful: true }));
  const name = `agentbattler-terminal-${job.runKey.slice(0, 12)}`.toLowerCase();
  const args = buildDotAgentsDockerArgs({ image: IMAGE, name, hostPort: port, home, configRoot, workspace });
  const child = spawn('docker', args, { cwd: runDirectory, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = []; const stderr = []; const state = { closed: false, exitCode: null };
  child.stdout.on('data', (chunk) => stdout.push(chunk)); child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.on('error', (error) => { state.closed = true; state.error = error; });
  child.on('close', (code) => { state.closed = true; state.exitCode = code; });
  const container = { port, apiKey, workspace, child, name, state, stdout, stderr };
  try {
    await waitForHealth(port, apiKey, state);
    return container;
  } catch (error) {
    await stopContainer(container);
    await writeFile(path.join(runDirectory, 'container-stdout.txt'), Buffer.concat(stdout));
    await writeFile(path.join(runDirectory, 'container-stderr.txt'), Buffer.concat(stderr));
    throw error;
  }
}

async function stopContainer(container) {
  if (!container) return;
  if (container.state.closed) return;
  if (container.child.stdin?.writable) container.child.stdin.write('/quit\n');
  for (let attempt = 0; attempt < 20 && !container.state.closed; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (container.state.closed) return;
  await new Promise((resolve) => {
    const stopper = spawn('docker', ['stop', '--time', '5', container.name], { stdio: 'ignore' });
    stopper.once('error', resolve);
    stopper.once('close', resolve);
  });
  if (!container.state.closed) container.child.kill('SIGKILL');
}

export async function runTerminalJob({ challenge, job, runDirectory }) {
  invariant(job.harness === 'dotagents-mono', `DotAgents adapter received ${job.harness}`);
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  const container = await startContainer(runDirectory, job);
  const stages = []; const turns = []; const sessionIds = [];
  const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  const runStartedAt = new Date().toISOString(); let conversationId = null; let toolCalls = 0;
  try {
    for (let index = 0; index < prompts.length; index += 1) {
      const startedAt = new Date().toISOString(); const startedClock = Date.now();
      const result = await streamTurn({
        port: container.port,
        apiKey: container.apiKey,
        prompt: prompts[index],
        conversationId,
        timeoutMs: job.maxWallTimeMs,
        outputPath: path.join(runDirectory, `turn-${index + 1}.jsonl`),
      });
      const telemetry = summarizeDotAgentsTrace(result.events, job.model);
      invariant(telemetry.conversationId, `DotAgents turn ${index + 1} emitted no conversation ID`);
      if (!conversationId) conversationId = telemetry.conversationId;
      invariant(telemetry.conversationId === conversationId, `DotAgents conversation changed on turn ${index + 1}`);
      sessionIds.push(telemetry.conversationId); toolCalls += telemetry.toolCallCount;
      usage.inputTokens += telemetry.sessionCost?.inputTokens ?? 0;
      usage.cachedInputTokens += telemetry.sessionCost?.cacheReadTokens ?? 0;
      usage.outputTokens += telemetry.sessionCost?.outputTokens ?? 0;
      usage.reasoningTokens += telemetry.sessionCost?.reasoningTokens ?? 0;
      const stage = await publicVerifier.verifyPublicStage({ workspace: container.workspace, stageId: job.challengeStageIds?.[index] ?? challenge?.stages?.[index]?.id });
      stages.push({ ...stage, id: stage.id ?? stage.stageId });
      turns.push({ index: index + 1, sessionId: telemetry.conversationId, startedAt, endedAt: new Date().toISOString(), durationMs: Date.now() - startedClock, usage: telemetry.sessionCost ?? {} });
    }
    const holdout = await holdoutVerifier.verifyHoldout({ workspace: container.workspace });
    await writeFile(path.join(runDirectory, 'container-stdout.txt'), Buffer.concat(container.stdout));
    await writeFile(path.join(runDirectory, 'container-stderr.txt'), Buffer.concat(container.stderr));
    return { ...job, schemaVersion: 'agentbattler.terminal-run.v1', status: 'completed', validity: 'valid', harness: 'dotagents-mono', harnessVersion: DOTAGENTS_VERSION, model: job.model, reasoningEffort: job.reasoningEffort ?? 'high', sessionId: conversationId, sameSessionProof: sessionIds.length === prompts.length && sessionIds.every((id) => id === conversationId), startedAt: runStartedAt, endedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(runStartedAt), turns, toolCalls, usage, stages, holdout, humanIntervention: 'none', workspace: { path: '<ephemeral-run-workspace>' }, adapter: { image: IMAGE, commit: DOTAGENTS_COMMIT } };
  } finally {
    await stopContainer(container);
  }
}
