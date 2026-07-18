#!/usr/bin/env node
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { verifyHoldout } from '../benchmark/challenges/mini-ledger-v2/holdout-verifier.mjs';
import { verifyPublicStage } from '../benchmark/challenges/mini-ledger-v2/public-verifier.mjs';
import {
  buildPiDockerArgs,
  parsePiEventStream,
  PI_HARNESS_VERSION,
  PI_IMAGE,
  piSubscriptionAuthFromCodex,
  validateNativePiSession,
} from '../src/pi-harness.mjs';
import { MINI_LEDGER_TURN_PROMPTS } from '../src/terminal-prompts.mjs';

const CODEX_AUTH = path.join(os.homedir(), '.codex', 'auth.json');
const PI_SESSION_CONTAINER_PATH = '/pi-home/sessions/terminal-session.jsonl';
const PI_SESSION_HOST_PATH = (runDirectory) => path.join(runDirectory, 'pi-home', 'sessions', 'terminal-session.jsonl');
const PI_IMAGE_OVERRIDE = process.env.AGENTBATTLER_PI_IMAGE ?? PI_IMAGE;
export const harnesses = ['pi-coding-agent'];

function invariant(condition, message) { if (!condition) throw new Error(message); }

function runProcess(command, args, { cwd, env, outputPath, errorPath, timeoutMs = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = []; const stderr = []; let timedOut = false;
    const timer = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, 15_000).unref();
    }, timeoutMs) : null;
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => { if (timer) clearTimeout(timer); reject(error); });
    child.on('close', async (exitCode, signal) => {
      if (timer) clearTimeout(timer);
      const stdoutText = Buffer.concat(stdout).toString('utf8');
      const stderrText = Buffer.concat(stderr).toString('utf8');
      if (outputPath) await writeFile(outputPath, stdoutText);
      if (errorPath) await writeFile(errorPath, stderrText);
      resolve({ exitCode, signal, timedOut, stdoutText, stderrText });
    });
  });
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

export async function runTerminalJob({ job, runDirectory }) {
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

  for (let index = 0; index < MINI_LEDGER_TURN_PROMPTS.length; index += 1) {
    const prompt = MINI_LEDGER_TURN_PROMPTS[index];
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
    const stream = parsePiEventStream(result.stdoutText);
    invariant(stream.sessionId, `Pi turn ${index + 1} emitted no session ID`);
    sessionIds.push(stream.sessionId); toolCalls += stream.toolCallCount;
    usage.inputTokens += stream.inputTokens; usage.cachedInputTokens += stream.cacheReadTokens; usage.outputTokens += stream.outputTokens;
    const stageId = ['append-get', 'query', 'export', 'import', 'recovery', 'compatibility', 'audit', 'performance'][index];
    stages.push(await verifyPublicStage({ workspace, stageId }));
    turns.push({ index: index + 1, sessionId: stream.sessionId, exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, startedAt, endedAt: new Date().toISOString(), durationMs: Date.now() - startedClock, usage: { inputTokens: stream.inputTokens, cachedInputTokens: stream.cacheReadTokens, outputTokens: stream.outputTokens, totalTokens: stream.totalTokens } });
  }

  const nativeSession = await readFile(sessionHostPath, 'utf8');
  const session = validateNativePiSession(nativeSession, { sessionId: sessionIds[0], model: job.model });
  invariant(sessionIds.every((sessionId) => sessionId === sessionIds[0]), 'Pi session changed across turns');
  const holdout = await verifyHoldout({ workspace });
  return {
    ...job,
    schemaVersion: 'agentbattler.terminal-run.v1', status: 'completed', validity: 'valid',
    harness: 'pi-coding-agent', harnessVersion: PI_HARNESS_VERSION, model: job.model,
    reasoningEffort: job.reasoningEffort ?? 'high', sessionId: sessionIds[0], sameSessionProof: sessionIds.length === 8 && sessionIds.every((id) => id === sessionIds[0]),
    nativeSession: { version: session.sessionVersion, eventCount: session.eventCount, path: '<ephemeral-pi-session>' },
    startedAt: runStartedAt, endedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(runStartedAt), turns, toolCalls, usage, stages, holdout,
    humanIntervention: 'none', workspace: { path: '<ephemeral-run-workspace>' },
  };
}
