import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { canonicalJson, canonicalJsonSha256 } from './provenance.mjs';
import { TERMINAL_RUN_SCHEMA, validateMiniLedgerChallenge, validateTerminalSchedule } from './terminal-challenge.mjs';
import {
  TERMINAL_V7_CHALLENGE_SCHEMA,
  validateTerminalV7Challenge,
  validateTerminalV7Schedule,
} from './terminal-v7.mjs';
import { captureTerminalV7VerifierEvidence } from './terminal-v7-verifier-evidence.mjs';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

async function atomicWriteJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporary, `${canonicalJson(value, { space: 2 })}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

export function terminalRunPath(resultRoot, runKey) {
  return path.join(resultRoot, 'runs', `${runKey}.json`);
}

function terminalAttemptPath(resultRoot, runKey, attemptId) {
  return path.join(resultRoot, 'attempts', runKey, `${attemptId}.json`);
}

function createAttemptId() {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`;
}

async function prepareAttemptWorkspace(resultRoot, runKey) {
  const runDirectory = path.join(resultRoot, 'work', runKey);
  if (await exists(runDirectory)) {
    const archive = path.join(resultRoot, 'work-attempts', runKey, createAttemptId());
    await mkdir(path.dirname(archive), { recursive: true });
    await rename(runDirectory, archive);
  }
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  return runDirectory;
}

export function validateTerminalJobIdentity(job, run) {
  invariant(run?.schemaVersion === TERMINAL_RUN_SCHEMA, 'Terminal result schema mismatch');
  const fields = job.instanceId
    ? ['runKey', 'challengeId', 'challengeSha256', 'instanceId', 'instanceSha256', 'generationIndex', 'repeat', 'seed']
    : ['runKey', 'challengeId', 'challengeSha256', 'comboId', 'artifactId', 'generationIndex', 'repeat', 'seed'];
  for (const field of fields) {
    invariant(run[field] === job[field], `Terminal result ${field} does not match its scheduled job`);
  }
  return run;
}

export function createInfrastructureInvalidRun(job, error, { adapter = null, startedAt = null, endedAt = null } = {}) {
  const reason = String(error?.message ?? error ?? 'unknown infrastructure failure').slice(0, 2_000);
  const protocolViolation = error?.code === 'TRACE_ISOLATION_VIOLATION';
  const status = protocolViolation ? 'protocol-invalid' : 'infrastructure-invalid';
  const identity = job.instanceId
    ? {
        instanceId: job.instanceId,
        instanceSha256: job.instanceSha256,
        generationIndex: job.generationIndex,
        repeat: job.repeat,
        seed: job.seed,
      }
    : {
        comboId: job.comboId,
        artifactId: job.artifactId,
        generationIndex: job.generationIndex,
        repeat: job.repeat,
        seed: job.seed,
      };
  const result = {
    schemaVersion: TERMINAL_RUN_SCHEMA,
    runKey: job.runKey,
    challengeId: job.challengeId,
    challengeSha256: job.challengeSha256,
    ...identity,
    status,
    validity: status,
    adapter,
    startedAt,
    endedAt,
    error: reason,
    ...(protocolViolation ? { stopReason: 'trace_isolation_violation', protocolViolation: error?.evidence ?? null } : {}),
  };
  return { ...result, resultSha256: canonicalJsonSha256(result) };
}

export function normalizeCompletedRun(job, result) {
  validateTerminalJobIdentity(job, result);
  invariant(result.status === 'completed', `Completed terminal result has status ${result.status}`);
  const unsigned = { ...result, status: 'completed', validity: 'valid' };
  return { ...unsigned, resultSha256: canonicalJsonSha256(unsigned) };
}

export function orderTerminalJobsBreadthFirst(jobs, coverage = []) {
  const comboOrder = new Map(coverage.map((entry, index) => [entry.combo.comboId, index]));
  return [...jobs].sort((left, right) => (
    left.generationIndex - right.generationIndex
    || (left.repeat ?? 1) - (right.repeat ?? 1)
    || (comboOrder.get(left.comboId) ?? Number.MAX_SAFE_INTEGER) - (comboOrder.get(right.comboId) ?? Number.MAX_SAFE_INTEGER)
    || (left.seed ?? 0) - (right.seed ?? 0)
    || left.artifactId.localeCompare(right.artifactId)
  ));
}

async function readExistingRun(file, job) {
  if (!await exists(file)) return null;
  const run = JSON.parse(await readFile(file, 'utf8'));
  validateTerminalJobIdentity(job, run);
  invariant(['completed', 'infrastructure-invalid', 'protocol-invalid'].includes(run.status), `Unsupported persisted terminal status ${run.status}`);
  return run;
}

/**
 * Execute a sealed schedule through a harness adapter.
 *
 * Adapter contract:
 *   async runTerminalJob({ challenge, job, challengeRoot, runDirectory }) => result
 *
 * The adapter must return a completed terminal run with the scheduled identity.
 * Agent failures remain completed, scored runs; infrastructure failures are
 * recorded by this orchestrator and never converted into agent scores.
 */
export async function runTerminalSchedule({
  challenge,
  schedule,
  resultRoot,
  challengeRoot,
  runTerminalJob,
  retryInvalid = false,
  onlyHarnesses = null,
  onlyModels = null,
  onlyGenerationIndices = null,
  concurrency = 1,
  onProgress = () => {},
  shouldStopBeforeJob = () => false,
  shouldStop = () => false,
}) {
  const isV7 = challenge?.schemaVersion === TERMINAL_V7_CHALLENGE_SCHEMA;
  if (isV7) {
    validateTerminalV7Challenge(challenge);
    validateTerminalV7Schedule(schedule, challenge);
  } else {
    validateMiniLedgerChallenge(challenge);
    validateTerminalSchedule(schedule, challenge);
  }
  invariant(typeof runTerminalJob === 'function', 'A terminal adapter is required');
  invariant(typeof shouldStopBeforeJob === 'function', 'Terminal before-job stop predicate must be a function');
  invariant(typeof shouldStop === 'function', 'Terminal stop predicate must be a function');
  invariant(Number.isSafeInteger(concurrency) && concurrency > 0, 'Terminal concurrency must be a positive integer');
  await mkdir(path.join(resultRoot, 'runs'), { recursive: true });

  const filtered = schedule.jobs.filter((job) => {
    const combo = isV7 ? { harness: job.harness, model: job.model } : schedule.coverage.find((entry) => entry.combo.comboId === job.comboId)?.combo;
    return (!onlyHarnesses?.length || onlyHarnesses.includes(combo?.harness.id))
      && (!onlyModels?.length || onlyModels.includes(combo?.model.id))
      && (!onlyGenerationIndices?.length || onlyGenerationIndices.includes(job.generationIndex));
  });
  const selected = isV7 ? filtered : orderTerminalJobsBreadthFirst(filtered, schedule.coverage);
  const summary = { expected: selected.length, skipped: 0, completed: 0, invalid: 0, failed: 0 };
  let stopRequested = false;
  async function executeJob(job) {
    const coverage = isV7 ? null : schedule.coverage.find((entry) => entry.combo.comboId === job.comboId);
    const scheduledHarness = isV7 ? job.harness : coverage?.combo.harness;
    const scheduledModel = isV7 ? job.model : coverage?.combo.model;
    const adapterJob = {
      ...job,
      harness: scheduledHarness?.id,
      harnessVersion: scheduledHarness?.version,
      model: scheduledModel?.id,
      modelFamilyId: scheduledModel?.familyId,
      reasoningEffort: scheduledModel?.reasoningEffort,
      generationSettings: isV7 ? {} : coverage?.combo.generationSettings ?? {},
      maxWallTimeMs: challenge.protocol.maxPhaseTimeMs ?? challenge.protocol.maxTurnTimeMs ?? challenge.protocol.maxWallTimeMs,
      executionConcurrency: concurrency,
    };
    const file = terminalRunPath(resultRoot, job.runKey);
    let existing = null;
    try { existing = await readExistingRun(file, job); } catch (error) {
      summary.failed += 1;
      onProgress({ job, status: 'invalid-persisted-result', error: error.message });
      return;
    }
    if (existing?.status === 'completed' || existing?.status === 'protocol-invalid' || (existing?.status === 'infrastructure-invalid' && !retryInvalid)) {
      summary.skipped += 1;
      if (existing.status === 'completed') summary.completed += 1;
      else summary.invalid += 1;
      onProgress({ job, status: 'skipped', result: existing });
      return;
    }

    // This check is deliberately adjacent to the runnable-job boundary. In
    // particular, do not prepare a new attempt workspace or invoke an adapter
    // after another V7 campaign has published a revision-wide stop. Existing
    // terminal records remain resumable evidence and do not count as adapter
    // boundaries.
    if (await shouldStopBeforeJob({ job })) {
      stopRequested = true;
      return;
    }
    if (stopRequested) return;

    const attemptId = createAttemptId();
    const runDirectory = await prepareAttemptWorkspace(resultRoot, job.runKey);
    const startedAt = new Date().toISOString();
    onProgress({ job, status: 'started', startedAt, attemptId });
    let normalized = null;
    try {
      const result = await runTerminalJob({ challenge, job: adapterJob, challengeRoot, runDirectory });
      const verifierEvidence = isV7 && challenge.execution?.verifierEvidencePolicy
        ? await captureTerminalV7VerifierEvidence({ runDirectory, run: result })
        : null;
      normalized = normalizeCompletedRun(job, { ...result, ...(verifierEvidence ? { verifierEvidence } : {}), attemptId });
      await atomicWriteJson(terminalAttemptPath(resultRoot, job.runKey, attemptId), normalized);
      await atomicWriteJson(file, normalized);
    } catch (error) {
      const invalid = createInfrastructureInvalidRun(job, error, {
        adapter: error?.adapter ?? null,
        startedAt,
        endedAt: new Date().toISOString(),
      });
      const { resultSha256: _discardedInvalidHash, ...invalidUnsigned } = invalid;
      const attempted = { ...invalidUnsigned, attemptId };
      const sealedAttempt = { ...attempted, resultSha256: canonicalJsonSha256(attempted) };
      await atomicWriteJson(terminalAttemptPath(resultRoot, job.runKey, attemptId), sealedAttempt);
      await atomicWriteJson(file, sealedAttempt);
      summary.invalid += 1;
      onProgress({ job, status: sealedAttempt.status, result: sealedAttempt });
      return;
    }
    // The completed attempt and current record are durable at this point.
    // Marker/scoring/progress callback failures are orchestrator failures, not
    // adapter failures: propagate them without rewriting the scored evidence.
    summary.completed += 1;
    onProgress({ job, status: 'completed', result: normalized });
    if (await shouldStop({ job, result: normalized })) stopRequested = true;
  }

  let cursor = 0;
  async function worker() {
    while (true) {
      if (stopRequested) return;
      const index = cursor;
      cursor += 1;
      if (index >= selected.length) return;
      const job = selected[index];
      await executeJob(job);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, () => worker()));
  return { ...summary, paused: stopRequested };
}
