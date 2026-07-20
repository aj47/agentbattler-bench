#!/usr/bin/env node
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { finished } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { terminalChallengeRuntime } from '../src/terminal-challenge-runtime.mjs';
import {
  buildPiDockerArgs,
  PI_HARNESS_VERSION,
  PI_IMAGE,
  piSubscriptionAuthFromCodex,
  validateNativePiSession,
} from '../src/pi-harness.mjs';
const { prompts, publicVerifier, holdoutVerifier } = terminalChallengeRuntime;

const CODEX_AUTH = path.join(os.homedir(), '.codex', 'auth.json');
const PI_SESSION_CONTAINER_PATH = '/pi-home/sessions/terminal-session.jsonl';
const PI_SESSION_HOST_PATH = (runDirectory) => path.join(runDirectory, 'pi-home', 'sessions', 'terminal-session.jsonl');
const PI_IMAGE_OVERRIDE = process.env.AGENTBATTLER_PI_IMAGE ?? PI_IMAGE;
export const harnesses = ['pi-coding-agent'];

function invariant(condition, message) { if (!condition) throw new Error(message); }

function runProcess(command, args, { cwd, env, outputPath, errorPath, timeoutMs = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutFile = outputPath ? createWriteStream(outputPath) : null;
    const stderrFile = errorPath ? createWriteStream(errorPath) : null;
    if (stdoutFile) child.stdout.pipe(stdoutFile);
    if (stderrFile) child.stderr.pipe(stderrFile);
    let timedOut = false;
    const timer = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, 15_000).unref();
    }, timeoutMs) : null;
    child.on('error', (error) => { if (timer) clearTimeout(timer); reject(error); });
    child.on('close', async (exitCode, signal) => {
      if (timer) clearTimeout(timer);
      await Promise.all([stdoutFile && finished(stdoutFile), stderrFile && finished(stderrFile)]);
      resolve({ exitCode, signal, timedOut });
    });
  });
}

function addUsage(total, usage = {}) {
  total.input += Number.isFinite(usage.input) ? usage.input : 0;
  total.output += Number.isFinite(usage.output) ? usage.output : 0;
  total.cacheRead += Number.isFinite(usage.cacheRead) ? usage.cacheRead : 0;
  total.cacheWrite += Number.isFinite(usage.cacheWrite) ? usage.cacheWrite : 0;
  total.totalTokens += Number.isFinite(usage.totalTokens) ? usage.totalTokens : 0;
}

async function summarizePiEventFile(file) {
  const input = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const eventTypes = new Map(); const toolBreakdown = new Map();
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  let count = 0; let header = null; let agentEnd = false; let toolCallCount = 0; let mcpCallCount = 0;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch (error) { throw new Error(`Pi event stream JSON parse failed: ${error.message}`); }
      count += 1;
      eventTypes.set(event.type, (eventTypes.get(event.type) ?? 0) + 1);
      if (count === 1) header = event;
      if (event.type === 'agent_end') agentEnd = true;
      if (event.type === 'tool_execution_start') {
        toolCallCount += 1;
        const name = event.toolName ?? 'unknown';
        toolBreakdown.set(name, (toolBreakdown.get(name) ?? 0) + 1);
        if (/mcp/i.test(name)) mcpCallCount += 1;
      }
      if (event.type === 'message_end' && event.message?.role === 'assistant') addUsage(usage, event.message.usage);
    }
  } finally {
    lines.close();
  }
  invariant(count > 0, 'Pi event stream is empty');
  invariant(header?.type === 'session' && typeof header.id === 'string', 'Pi event stream is missing its session header');
  invariant(agentEnd, 'Pi event stream is missing agent_end');
  return {
    sessionId: header.id,
    eventCount: count,
    eventTypes: Object.fromEntries(eventTypes),
    turnCount: eventTypes.get('turn_start') ?? 0,
    toolCallCount,
    toolCallBreakdown: Object.fromEntries(toolBreakdown),
    mcpCallCount,
    inputTokens: usage.input,
    cachedInputTokens: usage.cacheRead,
    outputTokens: usage.output,
    reasoningTokens: 0,
    totalTokens: usage.totalTokens,
  };
}

async function preparePiHome(runDirectory) {
  const piHome = path.join(runDirectory, 'pi-home');
  const sessions = path.join(piHome, 'sessions');
  await mkdir(piHome, { recursive: true, mode: 0o700 });
  await mkdir(sessions, { recursive: true, mode: 0o700 });
  const codexAuth = JSON.parse(await readFile(CODEX_AUTH, 'utf8'));
  const { document } = piSubscriptionAuthFromCodex(codexAuth);
  const authPath = path.join(piHome, 'auth.json');
  await writeFile(authPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  await chmod(authPath, 0o600);
  return piHome;
}

function isolatedEnv(piHome) {
  const keep = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'SHELL'];
  return {
    ...Object.fromEntries(keep.flatMap((key) => typeof process.env[key] === 'string' ? [[key, process.env[key]]] : [])),
    PI_TELEMETRY: '0',
    PI_SKIP_VERSION_CHECK: '1',
    PI_CODING_AGENT_DIR: piHome,
    PI_CODING_AGENT_SESSION_DIR: path.join(piHome, 'sessions'),
  };
}

export async function runTerminalJob({ challenge, job, runDirectory }) {
  invariant(job.harness === 'pi-coding-agent', `Pi adapter received ${job.harness}`);
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  const workspace = path.join(runDirectory, 'workspace');
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const piHome = await preparePiHome(runDirectory);
  const env = isolatedEnv(piHome);
  const user = typeof process.getuid === 'function' && typeof process.getgid === 'function' ? `${process.getuid()}:${process.getgid()}` : '1000:1000';
  const sessionHostPath = PI_SESSION_HOST_PATH(runDirectory);
  const runStartedAt = new Date().toISOString();
  const sessionIds = []; const turns = []; const stages = [];
  const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  let toolCalls = 0;

  for (let index = 0; index < prompts.length; index += 1) {
    const prompt = prompts[index];
    const startedAt = new Date().toISOString(); const startedClock = Date.now();
    const args = buildPiDockerArgs({
      image: PI_IMAGE_OVERRIDE,
      model: job.model,
      prompt,
      workspace,
      piHome,
      user,
      sessionPath: PI_SESSION_CONTAINER_PATH,
      continueSession: index > 0,
    });
    const outputPath = path.join(runDirectory, `turn-${index + 1}.jsonl`);
    const errorPath = path.join(runDirectory, `turn-${index + 1}.stderr`);
    const result = await runProcess('docker', args, { cwd: workspace, env, outputPath, errorPath, timeoutMs: job.maxWallTimeMs });
    invariant(!result.timedOut && result.exitCode === 0 && !result.signal, `Pi turn ${index + 1} failed (exit ${result.exitCode}, signal ${result.signal ?? 'none'})`);
    const stream = await summarizePiEventFile(outputPath);
    invariant(stream.sessionId, `Pi turn ${index + 1} emitted no session ID`);
    sessionIds.push(stream.sessionId); toolCalls += stream.toolCallCount;
    usage.inputTokens += stream.inputTokens; usage.cachedInputTokens += stream.cacheReadTokens; usage.outputTokens += stream.outputTokens;
    const stageId = job.challengeStageIds?.[index] ?? challenge?.stages?.[index]?.id;
    stages.push(await publicVerifier.verifyPublicStage({ workspace, stageId }));
    turns.push({ index: index + 1, sessionId: stream.sessionId, exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, startedAt, endedAt: new Date().toISOString(), durationMs: Date.now() - startedClock, usage: { inputTokens: stream.inputTokens, cachedInputTokens: stream.cacheReadTokens, outputTokens: stream.outputTokens, totalTokens: stream.totalTokens } });
  }

  const nativeSession = await readFile(sessionHostPath, 'utf8');
  const session = validateNativePiSession(nativeSession, { sessionId: sessionIds[0], model: job.model });
  invariant(sessionIds.every((sessionId) => sessionId === sessionIds[0]), 'Pi session changed across turns');
  const holdout = await holdoutVerifier.verifyHoldout({ workspace });
  return {
    ...job,
    schemaVersion: 'agentbattler.terminal-run.v1', status: 'completed', validity: 'valid',
    harness: 'pi-coding-agent', harnessVersion: PI_HARNESS_VERSION, model: job.model,
    reasoningEffort: job.reasoningEffort ?? 'high', sessionId: sessionIds[0], sameSessionProof: sessionIds.length === prompts.length && sessionIds.every((id) => id === sessionIds[0]),
    nativeSession: { version: session.sessionVersion, eventCount: session.eventCount, path: '<ephemeral-pi-session>' },
    startedAt: runStartedAt, endedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(runStartedAt), turns, toolCalls, usage, stages, holdout,
    humanIntervention: 'none', workspace: { path: '<ephemeral-run-workspace>' },
  };
}
