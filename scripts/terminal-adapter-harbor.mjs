#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { access, appendFile, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson, canonicalJsonSha256, sha256File } from '../src/provenance.mjs';
import { loadV7Pack, sealV7Pack } from '../benchmark/challenges/mini-ledger-v7/pack.mjs';
import { verifyFinal as verifyTerminalV7Final } from '../benchmark/challenges/mini-ledger-v7/verifier.mjs';
import { startAnthropicOverflowCompat } from '../src/anthropic-overflow-compat.mjs';
import { claudeCompactionPolicy, claudeCompactionTelemetry, compactionDelta } from '../src/claude-compaction.mjs';
import { terminalHarnessVersion } from '../src/terminal-harness-versions.mjs';
import {
  inspectTerminalV7HarborTaskImages,
  terminalV7HarborTaskImageReferences,
  terminalV7HarborTaskTreeIdentity,
} from '../src/terminal-v7-harbor-images.mjs';
import { writeTerminalV7VerifierEvaluationArtifact } from '../src/terminal-v7-verifier-evidence.mjs';
import {
  captureTerminalCandidateSnapshot,
  terminalTraceIsolationForChallenge,
  terminalTurnCompletion,
} from '../src/terminal-run-evidence.mjs';

const HARBOR_VERSION = '0.20.0';
const CLAUDE_MAX_TOOL_USE_CONCURRENCY = '4';
const RESOURCE_SAMPLE_INTERVAL_MS = 5_000;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODEX_AGENT_PATH = path.join(REPO_ROOT, 'benchmark', 'harbor', 'codex_agent.py');
const PI_AGENT_PATH = path.join(REPO_ROOT, 'benchmark', 'harbor', 'pi_agent.py');
const PI_SANDBOX_EXTENSION_PATH = path.join(REPO_ROOT, 'benchmark', 'harbor', 'pi_sandbox_extension.mjs');
const CLAUDE_AGENT_PATH = path.join(REPO_ROOT, 'benchmark', 'harbor', 'claude_agent.py');
const V7_CODEX_AGENT_PATH = path.join(REPO_ROOT, 'benchmark', 'harbor', 'v7_codex_agent.py');
const V7_PI_AGENT_PATH = path.join(REPO_ROOT, 'benchmark', 'harbor', 'v7_pi_agent.py');
const V7_CLAUDE_AGENT_PATH = path.join(REPO_ROOT, 'benchmark', 'harbor', 'v7_claude_agent.py');
const CLAUDE_COMPACTION_PATH = path.join(REPO_ROOT, 'src', 'claude-compaction.mjs');
const ANTHROPIC_OVERFLOW_COMPAT_PATH = path.join(REPO_ROOT, 'src', 'anthropic-overflow-compat.mjs');
const HARBOR_BY_HARNESS = Object.freeze({
  'claude-code': { agent: 'benchmark.harbor.claude_agent:AgentBattlerClaude', version: terminalHarnessVersion('claude-code'), kwargs: [] },
  'codex-cli': { agent: 'benchmark.harbor.codex_agent:AgentBattlerCodex', version: terminalHarnessVersion('codex-cli'), kwargs: ['web_search=disabled'] },
  'pi-coding-agent': { agent: 'benchmark.harbor.pi_agent:AgentBattlerPi', version: terminalHarnessVersion('pi-coding-agent'), kwargs: [] },
});
const HARBOR_V7_BY_HARNESS = Object.freeze({
  'claude-code': { agent: 'benchmark.harbor.v7_claude_agent:AgentBattlerV7Claude', version: terminalHarnessVersion('claude-code'), kwargs: [] },
  'codex-cli': { agent: 'benchmark.harbor.v7_codex_agent:AgentBattlerV7Codex', version: terminalHarnessVersion('codex-cli'), kwargs: ['web_search=disabled'] },
  'pi-coding-agent': { agent: 'benchmark.harbor.v7_pi_agent:AgentBattlerV7Pi', version: terminalHarnessVersion('pi-coding-agent'), kwargs: [] },
});

export const harnesses = Object.freeze(Object.keys(HARBOR_BY_HARNESS));

function invariant(condition, message) { if (!condition) throw new Error(message); }

async function evaluatorV7SeedKey(pack, challenge) {
  if (pack.pool === 'dev') return null;
  if (typeof process.env.AGENTBATTLER_V7_SEED_KEY === 'string' && process.env.AGENTBATTLER_V7_SEED_KEY.length >= 16) return process.env.AGENTBATTLER_V7_SEED_KEY;
  const stateRoot = process.env.CODEX_HOME ?? path.join(homedir(), '.codex');
  const revision = challenge.execution?.protocolRevision ?? process.env.AGENTBATTLER_TERMINAL_PROTOCOL_REVISION ?? 'r2';
  const keyPath = process.env.AGENTBATTLER_V7_SEED_KEY_FILE ?? path.join(stateRoot, 'automations', 'mini-ledger-v6-scheduled-check', `mini-ledger-v7-${revision}.seed-key`);
  const key = (await readFile(keyPath, 'utf8')).trim();
  invariant(key.length >= 16, 'V7 evaluator seed key is invalid');
  return key;
}

async function aggregateHarborV7Final({ challenge, job, phaseResults }) {
  const descriptor = challenge.instances?.find(({ instanceSha256 }) => instanceSha256 === job.instanceSha256);
  invariant(descriptor, 'Harbor V7 job instance is not sealed into the challenge');
  const canonicalPack = loadV7Pack(job.instanceId, { variant: job.instanceVariant });
  const seedKey = await evaluatorV7SeedKey(canonicalPack, challenge);
  const pack = sealV7Pack(canonicalPack, { seedKey });
  invariant(pack.sealSha256 === descriptor.packCommitments?.sealSha256, 'Harbor V7 runtime pack seal does not match the challenge');
  invariant(pack.hiddenMerkleRoot === descriptor.packCommitments?.hiddenMerkleRoot, 'Harbor V7 hidden commitment does not match the challenge');
  return verifyTerminalV7Final({ instance: pack, pack, phaseResults, seedKey, verifierSeedIndex: 0 });
}

function resolveHarborV7PhaseFiveTrajectory(phaseResults, current, stage) {
  if (current?.phase !== 5) return { evaluation: current, stage };
  const markerCode = 'V7_PHASE4_TRAJECTORY_INFRASTRUCTURE';
  const errors = Array.isArray(current.infrastructureErrors) ? current.infrastructureErrors : [];
  const marker = errors.filter(({ code }) => code === markerCode);
  if (marker.length === 0) return { evaluation: current, stage };
  invariant(marker.length === 1 && current.regressionGate?.schemaVersion === 'agentbattler.mini-ledger-v7.regression-gate.v1', 'Harbor V7 phase-5 deferred trajectory marker is invalid');
  const phaseFour = phaseResults.find(({ phase }) => phase === 4);
  invariant(phaseFour && Array.isArray(phaseFour.infrastructureErrors), 'Harbor V7 phase-4 proof is unavailable for final trajectory resolution');
  const failedPhases = current.regressionGate.failedPhases.filter((phase) => phase !== 4);
  if (!phaseFour.passed || phaseFour.infrastructureErrors.length > 0) failedPhases.push(4);
  failedPhases.sort((left, right) => left - right);
  const remainingErrors = errors.filter(({ code }) => code !== markerCode);
  const passed = failedPhases.length === 0 && remainingErrors.length === 0;
  invariant(Array.isArray(current.trajectoryPhases) && current.trajectoryPhases.length === 5, 'Harbor V7 phase-5 trajectory outcomes are missing');
  const trajectoryPhases = current.trajectoryPhases.map((result) => result.phase === 4 ? phaseFour : result);
  const evaluation = {
    ...current,
    passed,
    infrastructureErrors: remainingErrors,
    adaptability: { passed: passed ? 1 : 0, total: 1 },
    regressions: failedPhases.filter((phase) => phase < 5).length,
    regressionGate: { ...current.regressionGate, failedPhases, passed },
    trajectoryPhases,
  };
  const publicRequirements = evaluation.requirements.filter(({ group }) => group === 'public');
  const publicPassed = publicRequirements.length > 0 && publicRequirements.every(({ passed: requirementPassed }) => requirementPassed);
  return {
    evaluation,
    stage: { ...stage, passed: publicPassed, regressions: evaluation.regressions, exitCode: publicPassed ? 0 : 1, diagnostic: publicPassed ? null : stage?.diagnostic ?? 'current public contract checks failed' },
  };
}

function v7TaskDescriptor(challenge, job) {
  const tasks = challenge.execution?.tasks;
  invariant(tasks && typeof tasks === 'object' && !Array.isArray(tasks), 'Challenge has no sealed V7 task map');
  const descriptor = tasks[job?.instanceSha256]
    ?? tasks[`${job?.instanceId}:${job?.instanceVariant}`]
    ?? tasks[job?.instanceId];
  invariant(descriptor, `Challenge has no sealed V7 task for ${job?.instanceId ?? 'missing instance'}/${job?.instanceVariant ?? 'missing variant'}`);
  invariant(descriptor.instanceId === undefined || descriptor.instanceId === job.instanceId, 'V7 task instance identity changed');
  invariant(descriptor.variant === undefined || descriptor.variant === job.instanceVariant, 'V7 task variant identity changed');
  return descriptor;
}

function containedTaskPath(root, relative, label) {
  invariant(typeof relative === 'string' && relative.length > 0 && !path.isAbsolute(relative) && !relative.includes('\0'), `${label} is invalid`);
  const resolved = path.resolve(root, relative);
  const relation = path.relative(root, resolved);
  invariant(relation && relation !== '..' && !relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation), `${label} escapes its sealed root`);
  return resolved;
}

function taskRootForChallenge(challenge, job = null, runDirectory = null) {
  if (challenge.id === 'terminal-mini-ledger-v7') {
    const descriptor = v7TaskDescriptor(challenge, job);
    const taskPath = descriptor.taskPath ?? descriptor.path;
    const base = descriptor.taskPathBase ?? 'repository';
    if (base === 'repository') return containedTaskPath(REPO_ROOT, taskPath, 'V7 repository task path');
    invariant(base === 'result-root', `Unsupported V7 task path base: ${base}`);
    invariant(typeof runDirectory === 'string' && path.isAbsolute(runDirectory), 'V7 result-root task resolution requires an absolute run directory');
    const workRoot = path.dirname(runDirectory);
    invariant(path.basename(workRoot) === 'work', 'V7 run directory is not under the sealed result work root');
    return containedTaskPath(path.dirname(workRoot), taskPath, 'V7 private task path');
  }
  const allowedPaths = challenge.id === 'terminal-mini-ledger-v5'
    ? new Set(['benchmark/harbor/mini-ledger-v5', 'benchmark/harbor/mini-ledger-v5-r2', 'benchmark/harbor/mini-ledger-v5-r3', 'benchmark/harbor/mini-ledger-v5-r4'])
    : challenge.id === 'terminal-mini-ledger-v6'
      ? new Set(['benchmark/harbor/mini-ledger-v6'])
      : new Set(['benchmark/harbor/mini-ledger-v4']);
  const expectedPath = challenge.execution?.taskPath;
  invariant(allowedPaths.has(expectedPath), `Challenge task path is not an allowed sealed task: ${expectedPath ?? 'missing'}`);
  return path.join(REPO_ROOT, expectedPath);
}

function harborConfig(challenge, harness) {
  return (challenge?.id === 'terminal-mini-ledger-v7' ? HARBOR_V7_BY_HARNESS : HARBOR_BY_HARNESS)[harness];
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

export function buildHarborArgs({ challenge = null, job, taskRoot = path.join(REPO_ROOT, 'benchmark', 'harbor', 'mini-ledger-v4'), trialsDir, trialName, claudeProviderRoot = null }) {
  const config = harborConfig(challenge, job.harness); invariant(config, `Unsupported Harbor harness: ${job.harness}`);
  const reasoningEffort = job.reasoningEffort ?? 'high';
  invariant(['low', 'medium', 'high', 'xhigh', 'max'].includes(reasoningEffort), `Unsupported Harbor reasoning effort: ${reasoningEffort}`);
  const args = ['--from', `harbor==${HARBOR_VERSION}`, 'harbor', 'trial', 'start', '--path', taskRoot, '--agent', config.agent, '--model', harborModel(job.harness, job.model ?? job.modelRequested), '--trial-name', trialName, '--trials-dir', trialsDir, '--env', 'docker', '--resume-trajectory', '--delete'];
  const effortKwarg = job.harness === 'pi-coding-agent' ? `thinking=${reasoningEffort}` : `reasoning_effort=${reasoningEffort}`;
  for (const kwarg of [...config.kwargs, effortKwarg, `version=${config.version}`]) args.push('--agent-kwarg', kwarg);
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
    // The Claude wrapper owns public numeric resource settings. Passing them
    // via --agent-env makes Harbor register values such as 200000 as secrets;
    // literal redaction can then corrupt unrelated JSON number fields.
    claudeCompactionPolicy(job.model ?? job.modelRequested);
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
  let detail = null;
  try {
    detail = JSON.parse(await readFile(detailPath, 'utf8'));
  } catch { /* Fall back to Harbor's scalar rewards when detailed output is absent. */ }
  if (detail) {
    const infrastructureErrors = [
      ...(Array.isArray(detail.infrastructureErrors) ? detail.infrastructureErrors : []),
      ...(detail.infrastructureError ? [detail.infrastructureError] : []),
    ].filter(Boolean);
    invariant(infrastructureErrors.length === 0, `Verifier infrastructure failed for ${step.step_name}: ${infrastructureErrors.join('; ')}`);
    return {
      stage: { ...detail.stage, id: detail.stage?.id ?? fallbackId },
      holdout: detail.holdout ?? null,
      finalPublic: detail.finalPublic ?? null,
      candidateSnapshot: detail.candidateSnapshot ?? null,
      candidateTree: detail.candidateTree ?? null,
      candidateTreeRejection: detail.candidateTreeRejection ?? null,
      phaseEvaluation: detail.phaseEvaluation ?? detail.phaseResult ?? null,
      finalEvaluation: detail.finalEvaluation ?? detail.evaluation ?? null,
      declaredArtifact: detail.declaredArtifact ?? null,
      declaredArtifactRejection: detail.declaredArtifactRejection ?? null,
      candidateCapabilityMask: detail.candidateCapabilityMask ?? null,
      candidateNativeBoundary: detail.candidateNativeBoundary ?? null,
      sourceArtifactSha256: await sha256File(detailPath),
      sourceArtifactBytes: await readFile(detailPath),
    };
  } else {
    const rewards = step.verifier_result?.rewards ?? {};
    const passed = rewards.reward === 1;
    return {
      stage: { id: fallbackId, passed, regressions: Number(rewards.regressions ?? (passed ? 0 : 1)), exitCode: passed ? 0 : 1, durationMs: Number(rewards.stage_duration_ms ?? 0), diagnostic: passed ? null : 'Harbor verifier stage failed' },
      holdout: Number(rewards.holdout_total ?? 0) > 0 ? { passed: Number(rewards.holdout_passed ?? 0), total: Number(rewards.holdout_total), cases: [] } : null,
      finalPublic: null,
      candidateSnapshot: null,
    };
  }
}

async function importHarborV7CandidateTree({ trialRoot, stepName, runDirectory, phase, expected, rejection = null }) {
  if (!expected) {
    invariant(typeof rejection === 'string' && rejection.length > 0, `Harbor V7 candidate-tree evidence is missing for ${stepName}`);
    return {
      schemaVersion: 'agentbattler.terminal-candidate-tree-rejection.v1',
      kind: 'rejected',
      turn: phase,
      code: 'candidate-tree-policy-rejection',
      diagnostic: rejection.split('/app').join('<workspace>').slice(0, 500),
    };
  }
  invariant(expected?.schemaVersion === 'agentbattler.terminal-candidate-tree.v1' && expected.kind === 'overlay', `Harbor V7 candidate tree is missing for ${stepName}`);
  const turnName = `turn-${String(phase).padStart(2, '0')}`;
  const source = path.join(trialRoot, 'steps', stepName, 'verifier', 'candidate-trees', turnName);
  const destination = path.join(runDirectory, 'candidate-trees', turnName);
  await rm(destination, { recursive: true, force: true });
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
  const archived = JSON.parse(await readFile(path.join(destination, 'metadata.json'), 'utf8'));
  invariant(archived.treeSha256 === expected.treeSha256 && archived.archivePath === expected.archivePath, `Harbor V7 candidate-tree archive differs from metadata for ${stepName}`);
  return archived;
}

async function nativePiEvidence(trialRoot, stepName) {
  const eventFile = path.join(trialRoot, 'steps', stepName, 'agent', 'pi.txt');
  try {
    const events = (await readFile(eventFile, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
    const providerErrors = [];
    let stopReason = null;
    for (const event of events) {
      const messages = [event.message, ...(Array.isArray(event.messages) ? event.messages : [])].filter(Boolean);
      for (const message of messages) {
        if (message.stopReason === 'error') providerErrors.push(String(message.errorMessage ?? message.error ?? 'provider error').slice(0, 500));
        if (typeof message.stopReason === 'string') stopReason = message.stopReason;
      }
      if (event.type === 'message_end' && event.message?.role === 'assistant') {
        const sample = event.message.usage ?? {};
        usage.inputTokens += Number(sample.input ?? 0) + Number(sample.cacheRead ?? 0);
        usage.cachedInputTokens += Number(sample.cacheRead ?? 0);
        usage.outputTokens += Number(sample.output ?? 0);
        usage.reasoningTokens += Number(sample.reasoning ?? 0);
      }
    }
    return {
      sessionId: events.find((event) => event.type === 'session')?.id ?? null,
      toolCalls: events.filter((event) => event.type === 'tool_execution_start').length,
      usage,
      providerErrors: [...new Set(providerErrors)],
      stopReason,
      events,
    };
  } catch { return { sessionId: null, toolCalls: 0, usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 }, providerErrors: [], stopReason: null, events: [] }; }
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

export async function importHarborResult({ raw, trialRoot, challenge, job, harnessVersion, runDirectory = null, runtimeImages = null, taskImageReferences = null }) {
  invariant(!raw.exception_info, `Harbor trial failed: ${raw.exception_info?.exception_message ?? 'unknown error'}`);
  const isV7 = challenge.id === 'terminal-mini-ledger-v7';
  const expectedStages = isV7
    ? challenge.instances.find(({ instanceSha256 }) => instanceSha256 === job.instanceSha256)?.packCommitments?.phases?.map(({ id }) => id)
    : job.challengeStageIds ?? challenge.stages.map((stage) => stage.id);
  invariant(Array.isArray(expectedStages) && expectedStages.length > 0, 'Harbor challenge has no expected stages');
  invariant(raw.step_results?.length === expectedStages.length, `Harbor returned ${raw.step_results?.length ?? 0}/${expectedStages.length} steps`);
  const stages = []; const turns = []; const sessionIds = []; const trajectories = []; const usageSamples = []; const compactionSamples = []; const phaseResults = []; const declaredArtifacts = []; const declaredArtifactRejections = []; const verifierBoundaries = []; let holdout = null; let finalPublic = null; let finalEvaluation = null; let nativeToolCalls = 0;
  for (let index = 0; index < raw.step_results.length; index += 1) {
    const step = raw.step_results[index];
    const timedOut = step.exception_info?.exception_type === 'AgentTimeoutError';
    invariant(!step.exception_info || timedOut, `Harbor step ${step.step_name} failed: ${step.exception_info?.exception_message ?? 'unknown error'}`);
    const detail = await detailedStage(trialRoot, step, expectedStages[index]);
    if (challenge.execution?.candidateSnapshotsRequired === true) invariant(detail.candidateSnapshot, `Harbor candidate snapshot evidence is missing for ${step.step_name}`);
    const candidateTree = isV7 ? await importHarborV7CandidateTree({ trialRoot, stepName: step.step_name, runDirectory, phase: index + 1, expected: detail.candidateTree, rejection: detail.candidateTreeRejection }) : null;
    if (isV7) {
      invariant(detail.phaseEvaluation && Array.isArray(detail.phaseEvaluation.infrastructureErrors), `Harbor V7 phase evaluation is missing for ${step.step_name}`);
      invariant(/^0+$/.test(detail.candidateCapabilityMask ?? '') && detail.candidateNativeBoundary === 'bubblewrap-v1', `Harbor V7 phase ${index + 1} did not prove the zero-capability native verifier boundary`);
      verifierBoundaries.push({ phase: index + 1, candidateCapabilityMask: detail.candidateCapabilityMask, candidateNativeBoundary: detail.candidateNativeBoundary });
      const resolved = resolveHarborV7PhaseFiveTrajectory(phaseResults, detail.phaseEvaluation, detail.stage);
      detail.phaseEvaluation = resolved.evaluation;
      detail.stage = resolved.stage;
      await writeTerminalV7VerifierEvaluationArtifact({
        runDirectory,
        phase: index + 1,
        source: 'harbor-separate-verifier',
        sourceArtifactBytes: detail.sourceArtifactBytes,
        sourceArtifactSha256: detail.sourceArtifactSha256,
        evaluation: detail.phaseEvaluation,
        boundary: {
          modelCommandCapabilities: 'exactly-zero',
          candidateCapabilityMask: detail.candidateCapabilityMask,
          candidateNativeBoundary: detail.candidateNativeBoundary,
          network: 'denied',
          candidateFilesystem: 'native-sandbox',
          verifierEnvironment: 'separate',
        },
      });
      phaseResults.push(detail.phaseEvaluation);
      declaredArtifacts.push(detail.declaredArtifact ?? null);
      declaredArtifactRejections.push(detail.declaredArtifactRejection ?? null);
      if (detail.finalEvaluation) finalEvaluation = detail.finalEvaluation;
    }
    stages.push(detail.stage); if (detail.holdout) holdout = detail.holdout; if (detail.finalPublic) finalPublic = detail.finalPublic;
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
    const isolation = challenge.execution?.traceIsolationRequired === true
      ? terminalTraceIsolationForChallenge({ challenge, sandboxPolicy: `${job.harness}-sealed-command-sandbox`, trace: { trajectory, nativeEvents: nativeEvidence.events }, repositoryRoot: REPO_ROOT, workspace: '/app', turn: index + 1 })
      : null;
    const candidate = challenge.execution?.candidateSnapshotsRequired === true
      ? await captureTerminalCandidateSnapshot({
          sourcePath: path.join(trialRoot, 'steps', step.step_name, 'verifier', 'candidate-ledger.mjs'),
          runDirectory,
          turn: index + 1,
          expected: detail.candidateSnapshot,
        })
      : null;
    trajectories.push(trajectory);
    const turnUsage = job.harness === 'pi-coding-agent' ? nativeEvidence.usage : tokenCounts(context, trajectory); usageSamples.push(turnUsage);
    turns.push({ index: index + 1, sessionId, exitCode: timedOut ? null : 0, signal: null, timedOut, startedAt: step.agent_execution?.started_at ?? null, endedAt: step.agent_execution?.finished_at ?? null, durationMs: milliseconds(step.agent_execution), usage: turnUsage, completion: terminalTurnCompletion({ nativeReason: nativeEvidence.stopReason ?? trajectory?.extra?.stopReason ?? trajectory?.extra?.stop_reason, timedOut, providerError: nativeEvidence.providerErrors.length > 0 }), ...(candidate ? { candidate } : {}), ...(candidateTree ? { candidateTree, declaredArtifact: detail.declaredArtifact ?? null } : {}), ...(isolation ? { isolation } : {}), ...(job.harness === 'pi-coding-agent' && nativeEvidence.providerErrors.length ? { providerErrors: nativeEvidence.providerErrors } : {}), ...(job.harness === 'claude-code' ? { compaction: nativeCompaction } : {}) });
  }
  if (isV7) {
    finalEvaluation = await aggregateHarborV7Final({ challenge, job, phaseResults });
    invariant(finalEvaluation && Array.isArray(finalEvaluation.infrastructureErrors) && finalEvaluation.infrastructureErrors.length === 0, 'Harbor V7 final evaluation is missing or infrastructure-invalid');
    await writeTerminalV7VerifierEvaluationArtifact({
      runDirectory,
      phase: null,
      source: 'trusted-final-aggregator',
      sourceArtifactBytes: Buffer.from(canonicalJson(phaseResults)),
      sourceArtifactSha256: canonicalJsonSha256(phaseResults),
      evaluation: finalEvaluation.evaluation ?? finalEvaluation,
      boundary: {
        modelCommandCapabilities: 'exactly-zero',
        network: 'denied',
        candidateFilesystem: 'native-sandbox',
        verifierEnvironment: 'separate',
      },
    });
  }
  else invariant(holdout?.total === challenge.verifiers.holdout.cases, 'Harbor final holdout result is missing or incomplete');
  if (challenge.execution?.finalPublicEvaluationRequired === true) invariant(finalPublic?.total === challenge.stages.length, 'Harbor final public evaluation is missing or incomplete');
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
    harness: job.harness, harnessVersion, model: job.model ?? job.modelRequested, reasoningEffort: job.reasoningEffort ?? 'high',
    sessionId: observedSessions[0], sameSessionProof,
    startedAt: raw.started_at, endedAt: raw.finished_at,
    durationMs: Math.max(0, Date.parse(raw.finished_at) - Date.parse(raw.started_at)),
    turns, toolCalls, usage, stages, ...(finalPublic ? { finalPublic } : {}), holdout, ...(isV7 ? { phaseResults, declaredArtifacts, declaredArtifactRejections, evaluation: finalEvaluation.evaluation ?? finalEvaluation } : {}), humanIntervention: 'none',
    workspace: { path: '<harbor-isolated-workspace>' },
    ...(compaction ? { compaction } : {}),
    adapter: { name: 'harbor', version: HARBOR_VERSION, environment: 'docker', verifierEnvironment: 'separate', verifierWorkspacePolicy: isV7 ? 'terminal-candidate-tree-v1-fresh-starter-overlay' : 'source-only-per-stage-and-holdout-case', protocolRevision: challenge.execution?.protocolRevision ?? null, ...(isV7 ? { modelCommandCapabilities: 'exactly-zero', verifierBoundaries, runtimeImages, taskImageReferences, imageExecutionPolicy: 'sealed-prebuilt-task-images' } : {}), resumeTrajectory: true, cumulativeTrajectories, timedOutTurns: turns.filter((turn) => turn.timedOut).length, providerErrorTurns: turns.filter((turn) => turn.providerErrors?.length).length, trialUri: raw.trial_uri, resourcePolicy: job.harness === 'claude-code' ? { maxToolUseConcurrency: Number(CLAUDE_MAX_TOOL_USE_CONCURRENCY), compaction: compactionPolicy } : null },
  };
}

export async function runTerminalJob({ challenge, job, runDirectory }) {
  const isV7 = challenge.id === 'terminal-mini-ledger-v7';
  invariant(['terminal-mini-ledger-v4', 'terminal-mini-ledger-v5', 'terminal-mini-ledger-v6', 'terminal-mini-ledger-v7'].includes(challenge.id), `Harbor adapter does not support ${challenge.id}`);
  invariant(isV7
    ? challenge.execution?.substrate === 'harbor-with-sealed-direct-fallbacks' && challenge.execution?.harborVersion === HARBOR_VERSION
    : challenge.execution?.substrate === 'harbor' && challenge.execution?.version === HARBOR_VERSION, 'Challenge does not bind the expected Harbor execution substrate');
  invariant(challenge.execution?.adapters?.harbor?.sha256 === await sha256File(fileURLToPath(import.meta.url)), 'Harbor adapter source does not match the sealed challenge');
  if (isV7) {
    const v7Path = job.harness === 'codex-cli' ? V7_CODEX_AGENT_PATH : job.harness === 'pi-coding-agent' ? V7_PI_AGENT_PATH : V7_CLAUDE_AGENT_PATH;
    const descriptor = challenge.execution?.adapters?.[job.harness === 'codex-cli' ? 'v7CodexHarbor' : job.harness === 'pi-coding-agent' ? 'v7PiHarbor' : 'v7ClaudeHarbor'];
    invariant(descriptor?.sha256 === await sha256File(v7Path), `V7 ${job.harness} Harbor adapter source does not match the sealed challenge`);
  }
  if (job.harness === 'codex-cli') invariant(challenge.execution?.adapters?.codexHarbor?.sha256 === await sha256File(CODEX_AGENT_PATH), 'Harbor Codex agent source does not match the sealed challenge');
  if (job.harness === 'pi-coding-agent') {
    invariant(challenge.execution?.adapters?.piHarbor?.sha256 === await sha256File(PI_AGENT_PATH), 'Harbor Pi agent source does not match the sealed challenge');
    invariant(challenge.execution?.adapters?.piSandboxExtension?.sha256 === await sha256File(PI_SANDBOX_EXTENSION_PATH), 'Harbor Pi sandbox extension does not match the sealed challenge');
  }
  invariant(challenge.execution?.adapters?.claudeCompaction?.sha256 === await sha256File(CLAUDE_COMPACTION_PATH), 'Claude compaction policy source does not match the sealed challenge');
  invariant(challenge.execution?.adapters?.anthropicOverflowCompat?.sha256 === await sha256File(ANTHROPIC_OVERFLOW_COMPAT_PATH), 'Anthropic overflow compatibility source does not match the sealed challenge');
  if (job.harness === 'claude-code') invariant(challenge.execution?.adapters?.claudeHarbor?.sha256 === await sha256File(CLAUDE_AGENT_PATH), 'Harbor Claude agent source does not match the sealed challenge');
  const taskRoot = taskRootForChallenge(challenge, job, runDirectory);
  const expectedTaskSha256 = isV7 ? v7TaskDescriptor(challenge, job).sha256 : challenge.execution.taskSha256;
  const observedTaskSha256 = isV7
    ? (await terminalV7HarborTaskTreeIdentity({ taskRoot })).sha256
    : await taskFingerprint(taskRoot);
  invariant(observedTaskSha256 === expectedTaskSha256, 'Generated Harbor task does not match the sealed challenge hash');
  const runtimeImages = isV7 ? await inspectTerminalV7HarborTaskImages({ taskRoot, expected: v7TaskDescriptor(challenge, job).images }) : null;
  const taskImageReferences = isV7 ? await terminalV7HarborTaskImageReferences({ taskRoot }) : null;
  if (isV7) invariant(canonicalJson(taskImageReferences) === canonicalJson(v7TaskDescriptor(challenge, job).imageReferences), 'V7 Harbor task image references differ from the sealed challenge');
  const config = harborConfig(challenge, job.harness); invariant(config, `Unsupported Harbor harness: ${job.harness}`);
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
  const args = buildHarborArgs({ challenge, job, taskRoot, trialsDir, trialName, claudeProviderRoot: overflowCompat?.baseUrl });
  const pythonPath = [REPO_ROOT, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  const stopResourceMonitor = startResourceMonitor({ trialName, runDirectory });
  let result;
  try {
    result = await run('uvx', args, { cwd: REPO_ROOT, env: { ...process.env, PYTHONPATH: pythonPath }, stdoutPath: path.join(runDirectory, 'harbor.stdout'), stderrPath: path.join(runDirectory, 'harbor.stderr'), timeoutMs: Number.isSafeInteger(job.maxWallTimeMs) && job.maxWallTimeMs > 0 ? job.maxWallTimeMs * (isV7 ? 6 : 16) : null });
  } finally {
    await stopResourceMonitor();
    if (overflowCompat) await overflowCompat.close();
  }
  invariant(!result.timedOut && result.exitCode === 0 && !result.signal, `Harbor trial failed (exit ${result.exitCode}, signal ${result.signal ?? 'none'}): ${result.stderr.slice(-1000)}`);
  const resultPath = await findResult(path.join(trialsDir, trialName)); const raw = JSON.parse(await readFile(resultPath, 'utf8'));
  const imported = await importHarborResult({ raw, trialRoot: path.dirname(resultPath), challenge, job, harnessVersion: config.version, runDirectory, runtimeImages, taskImageReferences });
  imported.resources = JSON.parse(await readFile(path.join(runDirectory, 'harbor-resource-summary.json'), 'utf8'));
  if (overflowCompat) imported.adapter.overflowCompatibility = { name: 'agentbattler-anthropic-overflow-compat', normalizedStatus: 400, normalizedType: 'invalid_request_error', ...overflowCompat.stats };
  return imported;
}
