#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJsonSha256, sha256File } from '../src/provenance.mjs';

const HARBOR_VERSION = '0.20.0';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TASK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'benchmark', 'harbor', 'mini-ledger-v4');
const PI_AGENT_PATH = path.join(REPO_ROOT, 'benchmark', 'harbor', 'pi_agent.py');
const HARBOR_BY_HARNESS = Object.freeze({
  'claude-code': { agent: 'claude-code', version: '2.1.211', kwargs: ['reasoning_effort=high'] },
  'codex-cli': { agent: 'codex', version: '0.144.0', kwargs: ['reasoning_effort=high', 'web_search=disabled'] },
  'pi-coding-agent': { agent: 'benchmark.harbor.pi_agent:AgentBattlerPi', version: '0.80.7', kwargs: [] },
});

export const harnesses = Object.freeze(Object.keys(HARBOR_BY_HARNESS));
let taskFingerprintPromise = null;

function invariant(condition, message) { if (!condition) throw new Error(message); }

async function taskRecords(relative = '') {
  const records = [];
  const entries = await readdir(path.join(TASK_ROOT, relative), { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) records.push(...await taskRecords(child));
    else if (entry.isFile()) records.push({ path: child, sha256: await sha256File(path.join(TASK_ROOT, child)) });
  }
  return records;
}

async function taskFingerprint() { return canonicalJsonSha256(await taskRecords()); }

function run(command, args, { cwd, env, stdoutPath, stderrPath, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = []; const stderr = []; let timedOut = false;
    const timer = timeoutMs ? setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, 15_000).unref();
    }, timeoutMs) : null;
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', async (exitCode, signal) => {
      if (timer) clearTimeout(timer);
      const out = Buffer.concat(stdout).toString('utf8'); const err = Buffer.concat(stderr).toString('utf8');
      await Promise.all([writeFile(stdoutPath, out), writeFile(stderrPath, err)]);
      resolve({ exitCode, signal, timedOut, stdout: out, stderr: err });
    });
  });
}

function proxyAgentEnv(harness) {
  const proxyHarnesses = new Set((process.env.AGENTBATTLER_CLIPROXY_HARNESSES ?? 'claude-code').split(',').map((value) => value.trim()).filter(Boolean));
  if (!proxyHarnesses.has(harness)) return [];
  const base = process.env.AGENTBATTLER_CLIPROXY_BASE_URL;
  const key = process.env.AGENTBATTLER_CLIPROXY_API_KEY;
  if (!base && !key) return [];
  invariant(base && key, 'Harbor requires both AGENTBATTLER_CLIPROXY_BASE_URL and AGENTBATTLER_CLIPROXY_API_KEY');
  const containerBase = base.replace(/^http:\/\/(?:127\.0\.0\.1|localhost)(?=[:/])/, 'http://host.docker.internal');
  const providerRoot = containerBase.replace(/\/v1\/?$/, '').replace(/\/$/, '');
  const openaiBase = `${providerRoot}/v1`;
  if (harness === 'claude-code') return [`ANTHROPIC_BASE_URL=${providerRoot}`, `ANTHROPIC_API_KEY=${key}`];
  return [`OPENAI_BASE_URL=${openaiBase}`, `OPENAI_API_KEY=${key}`];
}

function harborModel(harness, model) {
  return harness === 'pi-coding-agent' && !model.includes('/') ? `openai-codex/${model}` : model;
}

export function buildHarborArgs({ job, trialsDir, trialName }) {
  const config = HARBOR_BY_HARNESS[job.harness]; invariant(config, `Unsupported Harbor harness: ${job.harness}`);
  const args = ['--from', `harbor==${HARBOR_VERSION}`, 'harbor', 'trial', 'start', '--path', TASK_ROOT, '--agent', config.agent, '--model', harborModel(job.harness, job.model ?? job.modelRequested), '--trial-name', trialName, '--trials-dir', trialsDir, '--env', 'docker', '--resume-trajectory', '--delete'];
  for (const kwarg of [...config.kwargs, `version=${config.version}`]) args.push('--agent-kwarg', kwarg);
  const proxyEnv = proxyAgentEnv(job.harness);
  if (job.harness === 'codex-cli' && proxyEnv.length === 0) {
    // Do not use CODEX_FORCE_AUTH_JSON=true here. Harbor 0.20.0 registers
    // agent-env values as secrets, and redacting the generic value "true"
    // corrupts ordinary JSON booleans in results and trajectories.
    args.push('--agent-env', `CODEX_AUTH_JSON_PATH=${path.join(homedir(), '.codex', 'auth.json')}`);
  }
  if (job.harness === 'pi-coding-agent' && proxyEnv.length === 0) {
    args.push('--agent-env', `CODEX_AUTH_JSON_PATH=${path.join(homedir(), '.codex', 'auth.json')}`);
  }
  for (const value of proxyEnv) args.push('--agent-env', value);
  if (Number.isSafeInteger(job.maxWallTimeMs) && job.maxWallTimeMs > 0) args.push('--agent-timeout', String(job.maxWallTimeMs / 1000));
  return args;
}

async function findResult(trialDirectory) {
  const direct = path.join(trialDirectory, 'result.json');
  try { await access(direct); return direct; } catch { /* Harbor may append a generated suffix. */ }
  const entries = await import('node:fs/promises').then(({ readdir }) => readdir(path.dirname(trialDirectory), { withFileTypes: true }));
  const prefix = path.basename(trialDirectory);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const candidate = path.join(path.dirname(trialDirectory), entry.name, 'result.json');
    try { await access(candidate); return candidate; } catch { /* Keep looking. */ }
  }
  throw new Error(`Harbor produced no result.json for ${prefix}`);
}

function milliseconds(timing) {
  if (!timing?.started_at || !timing?.finished_at) return 0;
  return Math.max(0, Date.parse(timing.finished_at) - Date.parse(timing.started_at));
}

async function detailedStage(trialRoot, step, fallbackId) {
  const detailPath = path.join(trialRoot, 'steps', step.step_name, 'verifier', 'stage-result.json');
  try {
    const detail = JSON.parse(await readFile(detailPath, 'utf8'));
    return { stage: { ...detail.stage, id: detail.stage?.id ?? fallbackId }, holdout: detail.holdout ?? null };
  } catch {
    const rewards = step.verifier_result?.rewards ?? {};
    const passed = rewards.reward === 1;
    return {
      stage: { id: fallbackId, passed, regressions: Number(rewards.regressions ?? (passed ? 0 : 1)), exitCode: passed ? 0 : 1, durationMs: Number(rewards.stage_duration_ms ?? 0), diagnostic: passed ? null : 'Harbor verifier stage failed' },
      holdout: Number(rewards.holdout_total ?? 0) > 0 ? { passed: Number(rewards.holdout_passed ?? 0), total: Number(rewards.holdout_total), cases: [] } : null,
    };
  }
}

async function sessionIdForStep(trialRoot, stepName) {
  const trajectory = path.join(trialRoot, 'steps', stepName, 'agent', 'trajectory.json');
  try { return JSON.parse(await readFile(trajectory, 'utf8')).session_id ?? null; } catch { return null; }
}

function tokenCounts(context, trajectory) {
  const metrics = trajectory?.final_metrics ?? {};
  return {
    inputTokens: Number(metrics.total_prompt_tokens ?? context.n_input_tokens ?? 0),
    cachedInputTokens: Number(metrics.total_cached_tokens ?? context.n_cache_tokens ?? 0),
    outputTokens: Number(metrics.total_completion_tokens ?? context.n_output_tokens ?? 0),
    reasoningTokens: Number(metrics.extra?.reasoning_output_tokens ?? 0),
  };
}

function combineUsage(samples, cumulative) {
  const fields = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens'];
  return Object.fromEntries(fields.map((field) => [field, cumulative
    ? Number(samples.at(-1)?.[field] ?? 0)
    : samples.reduce((sum, sample) => sum + Number(sample[field] ?? 0), 0)]));
}

export async function importHarborResult({ raw, trialRoot, challenge, job, harnessVersion }) {
  invariant(!raw.exception_info, `Harbor trial failed: ${raw.exception_info?.exception_message ?? 'unknown error'}`);
  const expectedStages = job.challengeStageIds ?? challenge.stages.map((stage) => stage.id);
  invariant(raw.step_results?.length === expectedStages.length, `Harbor returned ${raw.step_results?.length ?? 0}/${expectedStages.length} steps`);
  const stages = []; const turns = []; const sessionIds = []; const trajectories = []; const usageSamples = []; let holdout = null;
  for (let index = 0; index < raw.step_results.length; index += 1) {
    const step = raw.step_results[index];
    invariant(!step.exception_info, `Harbor step ${step.step_name} failed: ${step.exception_info?.exception_message ?? 'unknown error'}`);
    const detail = await detailedStage(trialRoot, step, expectedStages[index]);
    stages.push(detail.stage); if (detail.holdout) holdout = detail.holdout;
    const context = step.agent_result ?? {};
    const sessionId = await sessionIdForStep(trialRoot, step.step_name); sessionIds.push(sessionId);
    let trajectory = null;
    try {
      trajectory = JSON.parse(await readFile(path.join(trialRoot, 'steps', step.step_name, 'agent', 'trajectory.json'), 'utf8'));
    } catch { /* ATIF is optional for a custom Harbor agent. */ }
    trajectories.push(trajectory);
    const turnUsage = tokenCounts(context, trajectory); usageSamples.push(turnUsage);
    turns.push({ index: index + 1, sessionId, exitCode: 0, signal: null, timedOut: false, startedAt: step.agent_execution?.started_at ?? null, endedAt: step.agent_execution?.finished_at ?? null, durationMs: milliseconds(step.agent_execution), usage: turnUsage });
  }
  invariant(holdout?.total === challenge.verifiers.holdout.cases, 'Harbor final holdout result is missing or incomplete');
  const observedSessions = sessionIds.filter(Boolean);
  const sameSessionProof = observedSessions.length === expectedStages.length && new Set(observedSessions).size === 1;
  invariant(sameSessionProof, 'Harbor did not prove one resumed native session across all steps');
  const stepCounts = trajectories.map((trajectory) => trajectory?.steps?.length ?? 0);
  const cumulativeTrajectories = stepCounts.every((count, index) => index === 0 || count >= stepCounts[index - 1])
    && stepCounts.some((count, index) => index > 0 && count > stepCounts[index - 1]);
  const usage = combineUsage(usageSamples, cumulativeTrajectories);
  if (cumulativeTrajectories) {
    for (let index = usageSamples.length - 1; index >= 0; index -= 1) {
      const previous = usageSamples[index - 1] ?? {};
      turns[index].usage = Object.fromEntries(Object.entries(usageSamples[index]).map(([field, value]) => [field, Math.max(0, value - Number(previous[field] ?? 0))]));
    }
  }
  const countToolCalls = (trajectory) => (trajectory?.steps ?? []).reduce((sum, item) => sum + (item.tool_calls?.length ?? 0), 0);
  const toolCalls = cumulativeTrajectories ? countToolCalls(trajectories.at(-1)) : trajectories.reduce((sum, trajectory) => sum + countToolCalls(trajectory), 0);
  return {
    ...job,
    schemaVersion: 'agentbattler.terminal-run.v1', status: 'completed', validity: 'valid',
    harness: job.harness, harnessVersion, model: job.model ?? job.modelRequested, reasoningEffort: 'high',
    sessionId: observedSessions[0], sameSessionProof,
    startedAt: raw.started_at, endedAt: raw.finished_at,
    durationMs: Math.max(0, Date.parse(raw.finished_at) - Date.parse(raw.started_at)),
    turns, toolCalls, usage, stages, holdout, humanIntervention: 'none',
    workspace: { path: '<harbor-isolated-workspace>' },
    adapter: { name: 'harbor', version: HARBOR_VERSION, environment: 'docker', verifierEnvironment: 'separate', resumeTrajectory: true, cumulativeTrajectories, trialUri: raw.trial_uri },
  };
}

export async function runTerminalJob({ challenge, job, runDirectory }) {
  invariant(challenge.id === 'terminal-mini-ledger-v4', `Harbor adapter only supports terminal-mini-ledger-v4, received ${challenge.id}`);
  invariant(challenge.execution?.substrate === 'harbor' && challenge.execution?.version === HARBOR_VERSION, 'Challenge does not bind the expected Harbor execution substrate');
  invariant(challenge.execution?.adapters?.harbor?.sha256 === await sha256File(fileURLToPath(import.meta.url)), 'Harbor adapter source does not match the sealed challenge');
  if (job.harness === 'pi-coding-agent') invariant(challenge.execution?.adapters?.piHarbor?.sha256 === await sha256File(PI_AGENT_PATH), 'Harbor Pi agent source does not match the sealed challenge');
  taskFingerprintPromise ??= taskFingerprint();
  invariant((await taskFingerprintPromise) === challenge.execution.taskSha256, 'Generated Harbor task does not match the sealed challenge hash');
  const config = HARBOR_BY_HARNESS[job.harness]; invariant(config, `Unsupported Harbor harness: ${job.harness}`);
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  const trialsDir = path.join(runDirectory, 'harbor-trials'); await rm(trialsDir, { recursive: true, force: true }); await mkdir(trialsDir, { recursive: true });
  const trialName = `agentbattler-${job.runKey.slice(0, 16)}`;
  const args = buildHarborArgs({ job, trialsDir, trialName });
  const pythonPath = [REPO_ROOT, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  const result = await run('uvx', args, { cwd: REPO_ROOT, env: { ...process.env, PYTHONPATH: pythonPath }, stdoutPath: path.join(runDirectory, 'harbor.stdout'), stderrPath: path.join(runDirectory, 'harbor.stderr'), timeoutMs: Number.isSafeInteger(job.maxWallTimeMs) && job.maxWallTimeMs > 0 ? job.maxWallTimeMs * 16 : null });
  invariant(!result.timedOut && result.exitCode === 0 && !result.signal, `Harbor trial failed (exit ${result.exitCode}, signal ${result.signal ?? 'none'}): ${result.stderr.slice(-1000)}`);
  const resultPath = await findResult(path.join(trialsDir, trialName)); const raw = JSON.parse(await readFile(resultPath, 'utf8'));
  return importHarborResult({ raw, trialRoot: path.dirname(resultPath), challenge, job, harnessVersion: config.version });
}
