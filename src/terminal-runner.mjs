import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson, canonicalJsonSha256 } from './provenance.mjs';
import { TERMINAL_RUN_SCHEMA, validateMiniLedgerChallenge, validateTerminalSchedule } from './terminal-challenge.mjs';

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

export function validateTerminalJobIdentity(job, run) {
  invariant(run?.schemaVersion === TERMINAL_RUN_SCHEMA, 'Terminal result schema mismatch');
  for (const field of ['runKey', 'challengeId', 'challengeSha256', 'comboId', 'artifactId', 'generationIndex', 'repeat', 'seed']) {
    invariant(run[field] === job[field], `Terminal result ${field} does not match its scheduled job`);
  }
  return run;
}

export function createInfrastructureInvalidRun(job, error, { adapter = null, startedAt = null, endedAt = null } = {}) {
  const reason = String(error?.message ?? error ?? 'unknown infrastructure failure').slice(0, 2_000);
  const result = {
    schemaVersion: TERMINAL_RUN_SCHEMA,
    runKey: job.runKey,
    challengeId: job.challengeId,
    challengeSha256: job.challengeSha256,
    comboId: job.comboId,
    artifactId: job.artifactId,
    generationIndex: job.generationIndex,
    repeat: job.repeat,
    seed: job.seed,
    status: 'infrastructure-invalid',
    validity: 'infrastructure-invalid',
    adapter,
    startedAt,
    endedAt,
    error: reason,
  };
  return { ...result, resultSha256: canonicalJsonSha256(result) };
}

export function normalizeCompletedRun(job, result) {
  validateTerminalJobIdentity(job, result);
  invariant(result.status === 'completed', `Completed terminal result has status ${result.status}`);
  const unsigned = { ...result, status: 'completed', validity: 'valid' };
  return { ...unsigned, resultSha256: canonicalJsonSha256(unsigned) };
}

async function readExistingRun(file, job) {
  if (!await exists(file)) return null;
  const run = JSON.parse(await readFile(file, 'utf8'));
  validateTerminalJobIdentity(job, run);
  invariant(['completed', 'infrastructure-invalid'].includes(run.status), `Unsupported persisted terminal status ${run.status}`);
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
}) {
  validateMiniLedgerChallenge(challenge);
  validateTerminalSchedule(schedule, challenge);
  invariant(typeof runTerminalJob === 'function', 'A terminal adapter is required');
  invariant(Number.isSafeInteger(concurrency) && concurrency > 0, 'Terminal concurrency must be a positive integer');
  await mkdir(path.join(resultRoot, 'runs'), { recursive: true });

  const selected = schedule.jobs.filter((job) => {
    const combo = schedule.coverage.find((entry) => entry.combo.comboId === job.comboId)?.combo;
    return (!onlyHarnesses?.length || onlyHarnesses.includes(combo?.harness.id))
      && (!onlyModels?.length || onlyModels.includes(combo?.model.id))
      && (!onlyGenerationIndices?.length || onlyGenerationIndices.includes(job.generationIndex));
  });
  const summary = { expected: selected.length, skipped: 0, completed: 0, invalid: 0, failed: 0 };
  async function executeJob(job) {
    const coverage = schedule.coverage.find((entry) => entry.combo.comboId === job.comboId);
    const adapterJob = {
      ...job,
      harness: coverage?.combo.harness.id,
      harnessVersion: coverage?.combo.harness.version,
      model: coverage?.combo.model.id,
      modelFamilyId: coverage?.combo.model.familyId,
      reasoningEffort: coverage?.combo.model.reasoningEffort,
      generationSettings: coverage?.combo.generationSettings ?? {},
      maxWallTimeMs: challenge.protocol.maxWallTimeMs,
      executionConcurrency: concurrency,
    };
    const file = terminalRunPath(resultRoot, job.runKey);
    let existing = null;
    try { existing = await readExistingRun(file, job); } catch (error) {
      summary.failed += 1;
      onProgress({ job, status: 'invalid-persisted-result', error: error.message });
      return;
    }
    if (existing?.status === 'completed' || (existing?.status === 'infrastructure-invalid' && !retryInvalid)) {
      summary.skipped += 1;
      if (existing.status === 'completed') summary.completed += 1;
      else summary.invalid += 1;
      onProgress({ job, status: 'skipped', result: existing });
      return;
    }

    const runDirectory = path.join(resultRoot, 'work', job.runKey);
    const startedAt = new Date().toISOString();
    onProgress({ job, status: 'started', startedAt });
    try {
      const result = await runTerminalJob({ challenge, job: adapterJob, challengeRoot, runDirectory });
      const normalized = normalizeCompletedRun(job, result);
      await atomicWriteJson(file, normalized);
      summary.completed += 1;
      onProgress({ job, status: 'completed', result: normalized });
    } catch (error) {
      const invalid = createInfrastructureInvalidRun(job, error, {
        adapter: error?.adapter ?? null,
        startedAt,
        endedAt: new Date().toISOString(),
      });
      await atomicWriteJson(file, invalid);
      summary.invalid += 1;
      onProgress({ job, status: 'infrastructure-invalid', result: invalid });
    }
  }

  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= selected.length) return;
      await executeJob(selected[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, () => worker()));
  return summary;
}
