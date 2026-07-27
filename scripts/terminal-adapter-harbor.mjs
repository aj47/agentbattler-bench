#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { access, appendFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJsonSha256, sha256File } from '../src/provenance.mjs';
import { startAnthropicOverflowCompat } from '../src/anthropic-overflow-compat.mjs';
import { claudeCompactionPolicy, claudeCompactionTelemetry, compactionDelta } from '../src/claude-compaction.mjs';

const HARBOR_VERSION = '0.20.0';
const CLAUDE_MAX_TOOL_USE_CONCURRENCY = '4';
const RESOURCE_SAMPLE_INTERVAL_MS = 5_000;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PI_AGENT_PATH = path.join(REPO_ROOT, 'benchmark', 'harbor', 'pi_agent.py');
const CLAUDE_AGENT_PATH = path.join(REPO_ROOT, 'benchmark', 'harbor', 'claude_agent.py');
const CLAUDE_COMPACTION_PATH = path.join(REPO_ROOT, 'src', 'claude-compaction.mjs');
const ANTHROPIC_OVERFLOW_COMPAT_PATH = path.join(REPO_ROOT, 'src', 'anthropic-overflow-compat.mjs');
const HARBOR_BY_HARNESS = Object.freeze({
  'claude-code': { agent: 'benchmark.harbor.claude_agent:AgentBattlerClaude', version: '2.1.220', kwargs: ['reasoning_effort=high'] },
  'codex-cli': { agent: 'codex', version: '0.144.0', kwargs: ['reasoning_effort=high', 'web_search=disabled'] },
  'pi-coding-agent': { agent: 'benchmark.harbor.pi_agent:AgentBattlerPi', version: '0.80.7', kwargs: [] },
});

export const harnesses = Object.freeze(Object.keys(HARBOR_BY_HARNESS));

function invariant(condition, message) { if (!condition) throw new Error(message); }

function taskRootForChallenge(challenge) {
  const expectedPath = challenge.id === 'terminal-mini-ledger-v5'
    ? 'benchmark/harbor/mini-ledger-v5'
    : 'benchmark/harbor/mini-ledger-v4';
  invariant(challenge.execution?.taskPath === expectedPath, `Challenge task path must be ${expectedPath}`);
  return path.join(REPO_ROOT, expectedPath);
}

async function taskRecords(taskRoot, relative = '') {
  const records = [];
  const entries = await readdir(path.join(taskRoot, relative), { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) records.push(...await taskRecords(taskRoot, child));
    else if (entry.isFile()) records.push({ path: child, sha256: await sha256File(path.join(taskRoot, child)) });
  }
  return records;
}

async function taskFingerprint(taskRoot) { return canonicalJsonSha256(await taskRecords(taskRoot)); }

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

function capture(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = []; const stderr = [];
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ exitCode: null, stdout: Buffer.concat(stdout).toString('utf8'), stderr: 'diagnostic command timed out' });
    }, 10_000);
    timer.unref();
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => finish({ exitCode: null, stdout: '', stderr: String(error) }));
    child.on('close', (exitCode) => finish({
      exitCode,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

function parseMemoryEvents(value) {
  return Object.fromEntries(value.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [name, count] = line.trim().split(/\s+/, 2);
    return [name, Number(count)];
  }));
}

function parseJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

async function resourceSample(project) {
  const listed = await capture('docker', ['ps', '-a', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}']);
  const containerIds = listed.exitCode === 0 ? listed.stdout.trim().split(/\s+/).filter(Boolean) : [];
  const containers = [];
  for (const id of containerIds) {
    const [inspect, stats, cgroup, processCount] = await Promise.all([
      capture('docker', ['inspect', '--format', '{{json .State}}', id]),
      capture('docker', ['stats', '--no-stream', '--format', '{{json .}}', id]),
      capture('docker', ['exec', id, 'sh', '-c', 'cat /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.peak /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.events']),
      capture('docker', ['exec', id, 'sh', '-c', 'ps -e | wc -l']),
    ]);
    const cgroupLines = cgroup.stdout.trim().split(/\r?\n/);
    containers.push({
      id,
      state: inspect.exitCode === 0 ? parseJson(inspect.stdout) : null,
      stats: stats.exitCode === 0 ? parseJson(stats.stdout) : null,
      cgroup: cgroup.exitCode === 0 && cgroupLines.length >= 4 ? {
        memoryCurrentBytes: Number(cgroupLines[0]),
        memoryPeakBytes: Number(cgroupLines[1]),
        memoryMaxBytes: cgroupLines[2] === 'max' ? null : Number(cgroupLines[2]),
        memoryEvents: parseMemoryEvents(cgroupLines.slice(3).join('\n')),
      } : null,
      processCount: processCount.exitCode === 0 ? Number(processCount.stdout.trim()) : null,
    });
  }
  return { capturedAt: new Date().toISOString(), project, containers, discoveryError: listed.exitCode === 0 ? null : listed.stderr.slice(-500) };
}

function startResourceMonitor({ trialName, runDirectory }) {
  const project = `${trialName}__env`;
  const samplesPath = path.join(runDirectory, 'harbor-resource-samples.jsonl');
  const summaryPath = path.join(runDirectory, 'harbor-resource-summary.json');
  let stopped = false;
  let sampling = false;
  const summary = { schemaVersion: 'agentbattler.harbor-resources.v1', project, sampleIntervalMs: RESOURCE_SAMPLE_INTERVAL_MS, samples: 0, maxMemoryCurrentBytes: 0, maxMemoryPeakBytes: 0, maxProcessCount: 0, oomEvents: 0, oomKillEvents: 0, errors: [] };
  const sample = async () => {
    if (sampling) return;
    sampling = true;
    try {
      const observed = await resourceSample(project);
      await appendFile(samplesPath, `${JSON.stringify(observed)}\n`);
      summary.samples += 1;
      for (const container of observed.containers) {
        summary.maxMemoryCurrentBytes = Math.max(summary.maxMemoryCurrentBytes, Number(container.cgroup?.memoryCurrentBytes ?? 0));
        summary.maxMemoryPeakBytes = Math.max(summary.maxMemoryPeakBytes, Number(container.cgroup?.memoryPeakBytes ?? 0));
        summary.maxProcessCount = Math.max(summary.maxProcessCount, Number(container.processCount ?? 0));
        summary.oomEvents = Math.max(summary.oomEvents, Number(container.cgroup?.memoryEvents?.oom ?? 0));
        summary.oomKillEvents = Math.max(summary.oomKillEvents, Number(container.cgroup?.memoryEvents?.oom_kill ?? 0));
      }
      if (observed.discoveryError && summary.errors.length < 20) summary.errors.push(observed.discoveryError);
    } catch (error) {
      if (summary.errors.length < 20) summary.errors.push(String(error?.stack ?? error).slice(0, 1000));
    } finally { sampling = false; }
  };
  void sample();
  const timer = setInterval(() => { void sample(); }, RESOURCE_SAMPLE_INTERVAL_MS);
  timer.unref();
  return async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    while (sampling) await new Promise((resolve) => setTimeout(resolve, 50));
    await sample();
    summary.finishedAt = new Date().toISOString();
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  };
}

function proxyConnection(harness) {
  const proxyHarnesses = new Set((process.env.AGENTBATTLER_CLIPROXY_HARNESSES ?? 'claude-code').split(',').map((value) => value.trim()).filter(Boolean));
  if (!proxyHarnesses.has(harness)) return null;
  const base = process.env.AGENTBATTLER_CLIPROXY_BASE_URL;
  const key = process.env.AGENTBATTLER_CLIPROXY_API_KEY;
  if (!base && !key) return null;
  invariant(base && key, 'Harbor requires both AGENTBATTLER_CLIPROXY_BASE_URL and AGENTBATTLER_CLIPROXY_API_KEY');
  const containerBase = base.replace(/^http:\/\/(?:127\.0\.0\.1|localhost)(?=[:/])/, 'http://host.docker.internal');
  const providerRoot = containerBase.replace(/\/v1\/?$/, '').replace(/\/$/, '');
  return { providerRoot, key };
}

function proxyAgentEnv(harness, providerRootOverride = null) {
  const proxy = proxyConnection(harness);
  if (!proxy) return [];
  const providerRoot = providerRootOverride ?? proxy.providerRoot;
  if (harness === 'claude-code') return [`ANTHROPIC_BASE_URL=${providerRoot}`, `ANTHROPIC_API_KEY=${proxy.key}`];
  return [`OPENAI_BASE_URL=${providerRoot}/v1`, `OPENAI_API_KEY=${proxy.key}`];
}

function harborModel(harness, model) {
  return harness === 'pi-coding-agent' && !model.includes('/') ? `openai-codex/${model}` : model;
}

export function buildHarborArgs({ job, taskRoot = path.join(REPO_ROOT, 'benchmark', 'harbor', 'mini-ledger-v4'), trialsDir, trialName, claudeProviderRoot = null }) {
  const config = HARBOR_BY_HARNESS[job.harness]; invariant(config, `Unsupported Harbor harness: ${job.harness}`);
  const args = ['--from', `harbor==${HARBOR_VERSION}`, 'harbor', 'trial', 'start', '--path', taskRoot, '--agent', config.agent, '--model', harborModel(job.harness, job.model ?? job.modelRequested), '--trial-name', trialName, '--trials-dir', trialsDir, '--env', 'docker', '--resume-trajectory', '--delete'];
  for (const kwarg of [...config.kwargs, `version=${config.version}`]) args.push('--agent-kwarg', kwarg);
  const proxyEnv = proxyAgentEnv(job.harness, claudeProviderRoot);
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
  if (job.harness === 'claude-code') {
    const compaction = claudeCompactionPolicy(job.model ?? job.modelRequested);
    args.push('--agent-env', `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY=${CLAUDE_MAX_TOOL_USE_CONCURRENCY}`);
    for (const [name, value] of Object.entries(compaction.environmentVariables)) args.push('--agent-env', `${name}=${value}`);
  }
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

async function nativePiEvidence(trialRoot, stepName) {
  const eventFile = path.join(trialRoot, 'steps', stepName, 'agent', 'pi.txt');
  try {
    const events = (await readFile(eventFile, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
    for (const event of events) {
      if (event.type !== 'message_end' || event.message?.role !== 'assistant') continue;
      const sample = event.message.usage ?? {};
      usage.inputTokens += Number(sample.input ?? 0) + Number(sample.cacheRead ?? 0);
      usage.cachedInputTokens += Number(sample.cacheRead ?? 0);
      usage.outputTokens += Number(sample.output ?? 0);
      usage.reasoningTokens += Number(sample.reasoning ?? 0);
    }
    return {
      sessionId: events.find((event) => event.type === 'session')?.id ?? null,
      toolCalls: events.filter((event) => event.type === 'tool_execution_start').length,
      usage,
    };
  } catch { return { sessionId: null, toolCalls: 0, usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 } }; }
}

async function nativeClaudeEvidence(trialRoot, stepName) {
  const projectRoot = path.join(trialRoot, 'steps', stepName, 'agent', 'sessions', 'projects');
  try {
    const projects = await readdir(projectRoot, { withFileTypes: true });
    const transcripts = [];
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const files = await readdir(path.join(projectRoot, project.name), { withFileTypes: true });
      for (const file of files) {
        if (file.isFile() && file.name.endsWith('.jsonl')) transcripts.push(path.join(projectRoot, project.name, file.name));
      }
    }
    const events = [];
    for (const transcript of transcripts) {
      for (const line of (await readFile(transcript, 'utf8')).split(/\r?\n/).filter(Boolean)) events.push(JSON.parse(line));
    }
    return claudeCompactionTelemetry(events);
  } catch { return { count: 0, boundaries: [] }; }
}

async function sessionIdForStep(trialRoot, stepName, nativeSessionId = null) {
  const trajectory = path.join(trialRoot, 'steps', stepName, 'agent', 'trajectory.json');
  try { return JSON.parse(await readFile(trajectory, 'utf8')).session_id ?? null; }
  catch { return nativeSessionId; }
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
  const stages = []; const turns = []; const sessionIds = []; const trajectories = []; const usageSamples = []; const compactionSamples = []; let holdout = null; let nativeToolCalls = 0;
  for (let index = 0; index < raw.step_results.length; index += 1) {
    const step = raw.step_results[index];
    const timedOut = step.exception_info?.exception_type === 'AgentTimeoutError';
    invariant(!step.exception_info || timedOut, `Harbor step ${step.step_name} failed: ${step.exception_info?.exception_message ?? 'unknown error'}`);
    const detail = await detailedStage(trialRoot, step, expectedStages[index]);
    stages.push(detail.stage); if (detail.holdout) holdout = detail.holdout;
    const context = step.agent_result ?? {};
    const nativeEvidence = await nativePiEvidence(trialRoot, step.step_name);
    const nativeCompaction = job.harness === 'claude-code' ? await nativeClaudeEvidence(trialRoot, step.step_name) : { count: 0, boundaries: [] };
    compactionSamples.push(nativeCompaction);
    const sessionId = await sessionIdForStep(trialRoot, step.step_name, nativeEvidence.sessionId); sessionIds.push(sessionId);
    nativeToolCalls += nativeEvidence.toolCalls;
    let trajectory = null;
    try {
      trajectory = JSON.parse(await readFile(path.join(trialRoot, 'steps', step.step_name, 'agent', 'trajectory.json'), 'utf8'));
    } catch { /* ATIF is optional for a custom Harbor agent. */ }
    trajectories.push(trajectory);
    const turnUsage = job.harness === 'pi-coding-agent' ? nativeEvidence.usage : tokenCounts(context, trajectory); usageSamples.push(turnUsage);
    turns.push({ index: index + 1, sessionId, exitCode: timedOut ? null : 0, signal: null, timedOut, startedAt: step.agent_execution?.started_at ?? null, endedAt: step.agent_execution?.finished_at ?? null, durationMs: milliseconds(step.agent_execution), usage: turnUsage, ...(job.harness === 'claude-code' ? { compaction: nativeCompaction } : {}) });
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
  if (job.harness === 'claude-code') {
    for (let index = compactionSamples.length - 1; index >= 0; index -= 1) turns[index].compaction = compactionDelta(compactionSamples[index], compactionSamples[index - 1]);
  }
  const countToolCalls = (trajectory) => (trajectory?.steps ?? []).reduce((sum, item) => sum + (item.tool_calls?.length ?? 0), 0);
  const toolCalls = nativeToolCalls + (cumulativeTrajectories ? countToolCalls(trajectories.at(-1)) : trajectories.reduce((sum, trajectory) => sum + countToolCalls(trajectory), 0));
  const compaction = job.harness === 'claude-code' ? compactionSamples.at(-1) : null;
  const compactionPolicy = job.harness === 'claude-code' ? claudeCompactionPolicy(job.model ?? job.modelRequested) : null;
  return {
    ...job,
    schemaVersion: 'agentbattler.terminal-run.v1', status: 'completed', validity: 'valid',
    harness: job.harness, harnessVersion, model: job.model ?? job.modelRequested, reasoningEffort: 'high',
    sessionId: observedSessions[0], sameSessionProof,
    startedAt: raw.started_at, endedAt: raw.finished_at,
    durationMs: Math.max(0, Date.parse(raw.finished_at) - Date.parse(raw.started_at)),
    turns, toolCalls, usage, stages, holdout, humanIntervention: 'none',
    workspace: { path: '<harbor-isolated-workspace>' },
    ...(compaction ? { compaction } : {}),
    adapter: { name: 'harbor', version: HARBOR_VERSION, environment: 'docker', verifierEnvironment: 'separate', resumeTrajectory: true, cumulativeTrajectories, timedOutTurns: turns.filter((turn) => turn.timedOut).length, trialUri: raw.trial_uri, resourcePolicy: job.harness === 'claude-code' ? { maxToolUseConcurrency: Number(CLAUDE_MAX_TOOL_USE_CONCURRENCY), compaction: compactionPolicy } : null },
  };
}

export async function runTerminalJob({ challenge, job, runDirectory }) {
  invariant(challenge.id === 'terminal-mini-ledger-v4' || challenge.id === 'terminal-mini-ledger-v5', `Harbor adapter only supports terminal-mini-ledger-v4/v5, received ${challenge.id}`);
  invariant(challenge.execution?.substrate === 'harbor' && challenge.execution?.version === HARBOR_VERSION, 'Challenge does not bind the expected Harbor execution substrate');
  invariant(challenge.execution?.adapters?.harbor?.sha256 === await sha256File(fileURLToPath(import.meta.url)), 'Harbor adapter source does not match the sealed challenge');
  if (job.harness === 'pi-coding-agent') invariant(challenge.execution?.adapters?.piHarbor?.sha256 === await sha256File(PI_AGENT_PATH), 'Harbor Pi agent source does not match the sealed challenge');
  invariant(challenge.execution?.adapters?.claudeCompaction?.sha256 === await sha256File(CLAUDE_COMPACTION_PATH), 'Claude compaction policy source does not match the sealed challenge');
  invariant(challenge.execution?.adapters?.anthropicOverflowCompat?.sha256 === await sha256File(ANTHROPIC_OVERFLOW_COMPAT_PATH), 'Anthropic overflow compatibility source does not match the sealed challenge');
  if (job.harness === 'claude-code') invariant(challenge.execution?.adapters?.claudeHarbor?.sha256 === await sha256File(CLAUDE_AGENT_PATH), 'Harbor Claude agent source does not match the sealed challenge');
  const taskRoot = taskRootForChallenge(challenge);
  invariant((await taskFingerprint(taskRoot)) === challenge.execution.taskSha256, 'Generated Harbor task does not match the sealed challenge hash');
  const config = HARBOR_BY_HARNESS[job.harness]; invariant(config, `Unsupported Harbor harness: ${job.harness}`);
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  const trialsDir = path.join(runDirectory, 'harbor-trials'); await rm(trialsDir, { recursive: true, force: true }); await mkdir(trialsDir, { recursive: true });
  const trialName = `agentbattler-${job.runKey.slice(0, 16)}`;
  const proxy = proxyConnection(job.harness);
  let overflowCompat = null;
  if (job.harness === 'claude-code' && proxy) {
    overflowCompat = await startAnthropicOverflowCompat({
      upstreamBaseUrl: process.env.AGENTBATTLER_CLIPROXY_BASE_URL.replace(/\/v1\/?$/, ''),
      listenHost: '0.0.0.0',
      advertisedHost: 'host.docker.internal',
    });
  }
  const args = buildHarborArgs({ job, taskRoot, trialsDir, trialName, claudeProviderRoot: overflowCompat?.baseUrl });
  const pythonPath = [REPO_ROOT, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  const stopResourceMonitor = startResourceMonitor({ trialName, runDirectory });
  let result;
  try {
    result = await run('uvx', args, { cwd: REPO_ROOT, env: { ...process.env, PYTHONPATH: pythonPath }, stdoutPath: path.join(runDirectory, 'harbor.stdout'), stderrPath: path.join(runDirectory, 'harbor.stderr'), timeoutMs: Number.isSafeInteger(job.maxWallTimeMs) && job.maxWallTimeMs > 0 ? job.maxWallTimeMs * 16 : null });
  } finally {
    await stopResourceMonitor();
    if (overflowCompat) await overflowCompat.close();
  }
  invariant(!result.timedOut && result.exitCode === 0 && !result.signal, `Harbor trial failed (exit ${result.exitCode}, signal ${result.signal ?? 'none'}): ${result.stderr.slice(-1000)}`);
  const resultPath = await findResult(path.join(trialsDir, trialName)); const raw = JSON.parse(await readFile(resultPath, 'utf8'));
  const imported = await importHarborResult({ raw, trialRoot: path.dirname(resultPath), challenge, job, harnessVersion: config.version });
  imported.resources = JSON.parse(await readFile(path.join(runDirectory, 'harbor-resource-summary.json'), 'utf8'));
  if (overflowCompat) imported.adapter.overflowCompatibility = { name: 'agentbattler-anthropic-overflow-compat', normalizedStatus: 400, normalizedType: 'invalid_request_error', ...overflowCompat.stats };
  return imported;
}
