#!/usr/bin/env node
import { chmod, mkdir, mkdtemp, readFile, writeFile, copyFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { terminalChallengeRuntime } from '../src/terminal-challenge-runtime.mjs';

const CODEX_VERSION = '0.144.0';
const REASONING = 'high';
export const harnesses = ['codex-cli'];
const { prompts, publicVerifier, holdoutVerifier } = terminalChallengeRuntime;

function invariant(condition, message) { if (!condition) throw new Error(message); }

function isolatedEnv(home) {
  const keep = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'SHELL', 'NO_COLOR'];
  return {
    ...Object.fromEntries(keep.flatMap((key) => typeof process.env[key] === 'string' ? [[key, process.env[key]]] : [])),
    HOME: home, CODEX_HOME: home, CODEX_SQLITE_HOME: home,
    XDG_CONFIG_HOME: path.join(home, 'xdg-config'), XDG_DATA_HOME: path.join(home, 'xdg-data'),
    XDG_CACHE_HOME: path.join(home, 'xdg-cache'), TMPDIR: path.join(home, 'tmp'), CODEX_NON_INTERACTIVE: '1',
  };
}

function parseEvents(stdout) {
  return stdout.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch (error) { throw new Error(`Codex JSONL parse failed on line ${index + 1}: ${error.message}`); }
  });
}

function usageFor(events) {
  return [...events].reverse().find((event) => event.type === 'turn.completed')?.usage ?? {};
}

function runCodex({ args, prompt, cwd, env, outputPath, errorPath, timeoutMs = null }) {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', args, { cwd, env, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
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
      resolve({ exitCode, signal, timedOut, stdout: out, stderr: err, events: parseEvents(out) });
    });
    child.stdin.end(prompt, 'utf8');
  });
}

async function prepareHome(runDirectory) {
  const home = path.join(runDirectory, 'codex-home');
  await mkdir(home, { recursive: true, mode: 0o700 });
  const auth = path.join(os.homedir(), '.codex', 'auth.json');
  try { await copyFile(auth, path.join(home, 'auth.json')); await chmod(path.join(home, 'auth.json'), 0o600); }
  catch { throw new Error('Codex ChatGPT auth.json is unavailable for the isolated terminal run'); }
  await Promise.all(['xdg-config', 'xdg-data', 'xdg-cache', 'tmp'].map((name) => mkdir(path.join(home, name), { recursive: true })));
  return home;
}

export async function runTerminalJob({ challenge, job, runDirectory }) {
  invariant(job.harness === undefined || job.harness === 'codex-cli', 'Codex adapter received a non-Codex job');
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  const workspace = path.join(runDirectory, 'workspace'); await mkdir(workspace, { recursive: true });
  const home = await prepareHome(runDirectory); const env = isolatedEnv(home);
  const runStartedAt = new Date().toISOString();
  const timeoutMs = job.maxWallTimeMs ?? null;
  const stages = []; const sessionIds = []; const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  let sessionId = null; let toolCalls = 0; const turns = [];
  for (let index = 0; index < prompts.length; index += 1) {
    const prompt = prompts[index];
    const turnStartedAt = new Date().toISOString();
    const turnStartedClock = Date.now();
    const common = ['--model', job.model ?? job.modelRequested, '--skip-git-repo-check', '--json', '-c', `model_reasoning_effort=${JSON.stringify(REASONING)}`, '-c', 'approval_policy="never"', '-c', 'web_search="disabled"', '-c', 'features.apps=false', '-c', 'features.multi_agent=false', '-c', 'features.hooks=false', '-c', 'features.shell_snapshot=false', '-c', 'mcp_servers={}'];
    // Codex 0.144 parses resume as `exec resume [OPTIONS] <SESSION_ID> [PROMPT]`.
    // Resume does not accept --sandbox or -C; it inherits the original session's
    // sandbox and working directory. The child is still spawned with cwd=workspace.
    const args = sessionId
      ? ['exec', 'resume', ...common, sessionId]
      : ['exec', '--sandbox', 'workspace-write', '-C', workspace, ...common];
    const outputPath = path.join(runDirectory, `turn-${index + 1}.jsonl`); const errorPath = path.join(runDirectory, `turn-${index + 1}.stderr`);
    const result = await runCodex({ args, prompt, cwd: workspace, env, outputPath, errorPath, timeoutMs });
    invariant(!result.timedOut && result.exitCode === 0 && !result.signal, `Codex turn ${index + 1} failed (exit ${result.exitCode}, signal ${result.signal ?? 'none'})`);
    const started = result.events.find((event) => event.type === 'thread.started');
    const observedSession = started?.thread_id ?? null;
    invariant(observedSession, `Codex turn ${index + 1} emitted no thread.started event`);
    if (!sessionId) sessionId = observedSession;
    invariant(observedSession === sessionId, `Codex session changed on turn ${index + 1}`);
    invariant(result.events.some((event) => event.type === 'turn.completed'), `Codex turn ${index + 1} emitted no turn.completed event`);
    sessionIds.push(observedSession); toolCalls += result.events.filter((event) => event.type === 'item.started' && !['agent_message', 'reasoning'].includes(event.item?.type)).length;
    const u = usageFor(result.events); for (const [source, target] of [['input_tokens', 'inputTokens'], ['cached_input_tokens', 'cachedInputTokens'], ['output_tokens', 'outputTokens'], ['reasoning_output_tokens', 'reasoningTokens']]) usage[target] += Number.isFinite(u[source]) ? u[source] : 0;
    const stage = await publicVerifier.verifyPublicStage({ workspace, stageId: job.challengeStageIds?.[index] ?? challenge?.stages?.[index]?.id });
    turns.push({ index: index + 1, sessionId: observedSession, exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, startedAt: turnStartedAt, endedAt: new Date().toISOString(), durationMs: Date.now() - turnStartedClock, usage: u });
    stages.push({ ...stage, id: stage.id ?? stage.stageId });
  }
  const holdout = await holdoutVerifier.verifyHoldout({ workspace });
  return { ...job, schemaVersion: 'agentbattler.terminal-run.v1', status: 'completed', validity: 'valid', harness: 'codex-cli', harnessVersion: CODEX_VERSION, model: job.model ?? job.modelRequested, reasoningEffort: REASONING, sessionId, sameSessionProof: sessionIds.length === 8 && sessionIds.every((id) => id === sessionId), startedAt: runStartedAt, endedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(runStartedAt), turns, toolCalls, usage, stages, holdout, humanIntervention: 'none', workspace: { path: '<ephemeral-run-workspace>' } };
}
