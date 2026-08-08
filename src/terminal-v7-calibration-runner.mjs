import { randomBytes } from 'node:crypto';
import { access, lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  createTerminalV7CalibrationExecutionUnit,
  terminalV7CalibrationAdapterJob,
  validateTerminalV7CalibrationChallenge,
  validateTerminalV7CalibrationExecutionUnit,
  validateTerminalV7CalibrationSchedule,
} from './terminal-v7-calibration.mjs';
import { canonicalJson, canonicalJsonSha256 } from './provenance.mjs';
import {
  createInfrastructureInvalidRun,
  normalizeCompletedRun,
  terminalRunPath,
  validateTerminalJobIdentity,
} from './terminal-runner.mjs';
import { captureTerminalV7VerifierEvidence } from './terminal-v7-verifier-evidence.mjs';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function safeAbsolute(value, label) {
  invariant(typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0'), `${label} must be an absolute path`);
  return path.resolve(value);
}

async function exists(file) {
  try { await access(file); return true; } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function atomicWriteJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporary, `${canonicalJson(value, { space: 2 })}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
}

function attemptId() {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`;
}

async function prepareAttemptWorkspace(resultRoot, runKey, id) {
  const runDirectory = path.join(resultRoot, 'work', runKey);
  if (await exists(runDirectory)) {
    const archive = path.join(resultRoot, 'work-attempts', runKey, id);
    await mkdir(path.dirname(archive), { recursive: true, mode: 0o700 });
    await rename(runDirectory, archive);
  }
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  return runDirectory;
}

export function validateTerminalV7CalibrationPersistedResult(run, job) {
  validateTerminalJobIdentity(job, run);
  invariant(['completed', 'infrastructure-invalid', 'protocol-invalid'].includes(run.status), 'Unsupported persisted V7 calibration result status');
  const { resultSha256, ...unsigned } = run;
  invariant(typeof resultSha256 === 'string' && resultSha256 === canonicalJsonSha256(unsigned), 'Persisted V7 calibration result hash mismatch');
  return run;
}

export async function assertTerminalV7ImmutableEvidenceFile(file, label = 'V7 immutable evidence file') {
  invariant(typeof file === 'string' && path.isAbsolute(file), `${label} path must be absolute`);
  const stat = await lstat(file);
  invariant(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, `${label} must be one regular single-link file`);
  return stat;
}

export async function assertTerminalV7ImmutableAttemptPair({ currentFile, attemptFile } = {}) {
  const [currentStat, attemptStat] = await Promise.all([
    assertTerminalV7ImmutableEvidenceFile(currentFile, 'V7 current run record'),
    assertTerminalV7ImmutableEvidenceFile(attemptFile, 'V7 immutable attempt record'),
  ]);
  invariant(currentStat.dev !== attemptStat.dev || currentStat.ino !== attemptStat.ino, 'V7 current run and immutable attempt records must be distinct files');
  return { currentStat, attemptStat };
}

export async function assertTerminalV7CalibrationAttemptRecord({ resultRoot, job, run } = {}) {
  const destination = safeAbsolute(resultRoot, 'V7 calibration attempt root');
  validateTerminalV7CalibrationPersistedResult(run, job);
  invariant(typeof run.attemptId === 'string' && run.attemptId.length > 0 && !run.attemptId.includes('/') && !run.attemptId.includes('\\'), 'Persisted V7 calibration result has no safe attempt ID');
  const currentFile = terminalRunPath(destination, job.runKey);
  const attemptFile = path.join(destination, 'attempts', job.runKey, `${run.attemptId}.json`);
  await assertTerminalV7ImmutableAttemptPair({ currentFile, attemptFile });
  const current = validateTerminalV7CalibrationPersistedResult(JSON.parse(await readFile(currentFile, 'utf8')), job);
  const attempt = validateTerminalV7CalibrationPersistedResult(JSON.parse(await readFile(attemptFile, 'utf8')), job);
  invariant(canonicalJson(current) === canonicalJson(run), `Persisted V7 current run differs from the collected run ${job.runKey}`);
  invariant(canonicalJson(attempt) === canonicalJson(run), `Persisted V7 calibration attempt differs from current run ${job.runKey}`);
  return attempt;
}

async function directoryEntries(directory, label) {
  let stat;
  try {
    stat = await lstat(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw new Error(`${label} could not be inspected: ${error.message}`, { cause: error });
  }
  invariant(stat.isDirectory() && !stat.isSymbolicLink(), `${label} must be a real directory`);
  return readdir(directory, { withFileTypes: true });
}

function projectedCorePoints(score) {
  const points = score?.corePoints ?? score?.core?.points;
  invariant(Number.isFinite(points) && points >= 0 && points <= 100, 'V7 calibration saturation score projection is invalid');
  return points;
}

function orderedCalibrationJobs(schedule) {
  return [...schedule.jobs].sort((left, right) => left.executionIndex - right.executionIndex);
}

export async function inspectTerminalV7CalibrationScheduleProgress({
  challenge,
  schedule,
  resultRoot,
  retryInvalid = false,
  scoreRun,
} = {}) {
  validateTerminalV7CalibrationChallenge(challenge, { requireExecution: true });
  validateTerminalV7CalibrationSchedule(schedule, challenge);
  const destination = safeAbsolute(resultRoot, 'V7 calibration progress root');
  invariant(typeof scoreRun === 'function', 'V7 calibration progress inspection requires a scorer');
  const jobs = orderedCalibrationJobs(schedule);
  const jobsByRunKey = new Map(jobs.map((job) => [job.runKey, job]));
  const runEntries = await directoryEntries(path.join(destination, 'runs'), 'V7 calibration current-result directory');
  for (const entry of runEntries) {
    invariant(entry.isFile() && entry.name.endsWith('.json'), `V7 calibration runs contains an unsupported entry: ${entry.name}`);
    invariant(jobsByRunKey.has(entry.name.slice(0, -5)), `V7 calibration runs contains an unscheduled result: ${entry.name}`);
  }
  const attemptRootEntries = await directoryEntries(path.join(destination, 'attempts'), 'V7 calibration attempt directory');
  for (const entry of attemptRootEntries) {
    invariant(entry.isDirectory() && jobsByRunKey.has(entry.name), `V7 calibration attempts contains an unscheduled entry: ${entry.name}`);
  }

  const persisted = new Map();
  let saturation = null;
  for (const job of jobs) {
    const currentFile = terminalRunPath(destination, job.runKey);
    let current = null;
    if (await exists(currentFile)) {
      await assertTerminalV7ImmutableEvidenceFile(currentFile, 'V7 calibration current result');
      current = validateTerminalV7CalibrationPersistedResult(JSON.parse(await readFile(currentFile, 'utf8')), job);
      if (current.status === 'completed') invariant(current.validity === 'valid', `Completed V7 calibration result is not valid: ${job.runKey}`);
      persisted.set(job.runKey, current);
    }

    const attemptDirectory = path.join(destination, 'attempts', job.runKey);
    const attemptEntries = await directoryEntries(attemptDirectory, `V7 calibration attempts for ${job.runKey}`);
    const attempts = new Map();
    for (const entry of attemptEntries) {
      invariant(entry.isFile() && entry.name.endsWith('.json'), `V7 calibration attempt directory contains an unsupported entry for ${job.runKey}: ${entry.name}`);
      const attemptFile = path.join(attemptDirectory, entry.name);
      await assertTerminalV7ImmutableEvidenceFile(attemptFile, 'V7 calibration immutable attempt');
      const attempt = validateTerminalV7CalibrationPersistedResult(JSON.parse(await readFile(attemptFile, 'utf8')), job);
      invariant(typeof attempt.attemptId === 'string' && `${attempt.attemptId}.json` === entry.name, `V7 calibration attempt filename changed for ${job.runKey}`);
      invariant(!attempts.has(attempt.attemptId), `V7 calibration attempt ID is duplicated for ${job.runKey}`);
      attempts.set(attempt.attemptId, attempt);
      if (attempt.status === 'completed') {
        invariant(attempt.validity === 'valid', `Completed V7 calibration attempt is not valid: ${job.runKey}`);
        if (projectedCorePoints(await scoreRun(attempt)) === 100) {
          invariant(current !== null && current.attemptId === attempt.attemptId && canonicalJson(current) === canonicalJson(attempt), `V7 calibration has an unresolved immutable Core-100 attempt that is not the current result: ${job.runKey}`);
          saturation ??= { job, run: current };
        }
      }
    }
    if (current === null) {
      invariant(attempts.size === 0, `V7 calibration has orphan immutable attempts without a current result: ${job.runKey}`);
      continue;
    }
    const declared = attempts.get(current.attemptId);
    invariant(declared && canonicalJson(declared) === canonicalJson(current), `V7 calibration current result does not match its declared immutable attempt: ${job.runKey}`);
    await assertTerminalV7CalibrationAttemptRecord({ resultRoot: destination, job, run: current });
    for (const attempt of attempts.values()) {
      invariant(attempt.status !== 'completed' || attempt.attemptId === current.attemptId, `V7 calibration has a superseded completed attempt: ${job.runKey}`);
    }
  }

  const earliestOutstanding = jobs.find((job) => {
    const current = persisted.get(job.runKey);
    return current === undefined || (retryInvalid && current.status === 'infrastructure-invalid');
  }) ?? null;
  return { jobs, persisted, earliestOutstanding, saturation };
}

export async function assertTerminalV7CalibrationInvocationReady({
  challenge,
  schedule,
  resultRoot,
  runKey,
  retryInvalid = false,
  scoreRun,
  onSaturation,
} = {}) {
  invariant(typeof runKey === 'string' && runKey.length > 0, 'V7 calibration invocation run key is required');
  invariant(typeof onSaturation === 'function', 'V7 calibration invocation saturation callback is required');
  const progress = await inspectTerminalV7CalibrationScheduleProgress({ challenge, schedule, resultRoot, retryInvalid, scoreRun });
  if (progress.saturation) {
    await onSaturation(progress.saturation);
    throw new Error('V7 calibration has a pending Core-100 saturation audit and refuses another invocation');
  }
  invariant(progress.earliestOutstanding !== null, 'V7 calibration schedule has no outstanding execution unit');
  invariant(progress.earliestOutstanding.runKey === runKey, `V7 calibration invocation must use the earliest outstanding scheduled run ${progress.earliestOutstanding.runKey}`);
  return progress;
}

function sealInvalidAttempt(invalid, id) {
  const { resultSha256: _oldHash, ...unsigned } = invalid;
  const attempted = { ...unsigned, attemptId: id };
  return { ...attempted, resultSha256: canonicalJsonSha256(attempted) };
}

export async function runTerminalV7CalibrationExecutionUnit({
  challenge,
  schedule,
  unit,
  resultRoot,
  challengeRoot,
  runTerminalJob,
  captureVerifierEvidence = captureTerminalV7VerifierEvidence,
  retryInvalid = false,
  onProgress = () => {},
  shouldStopBeforeRun = () => false,
} = {}) {
  validateTerminalV7CalibrationChallenge(challenge, { requireExecution: true });
  validateTerminalV7CalibrationSchedule(schedule, challenge);
  validateTerminalV7CalibrationExecutionUnit(unit, { challenge, schedule });
  const destination = safeAbsolute(resultRoot, 'V7 calibration result root');
  const benchmarkRoot = safeAbsolute(challengeRoot, 'V7 calibration challenge root');
  invariant(typeof runTerminalJob === 'function', 'V7 calibration adapter is required');
  invariant(typeof captureVerifierEvidence === 'function', 'V7 calibration verifier-evidence collector is required');
  invariant(typeof onProgress === 'function', 'V7 calibration progress callback must be a function');
  invariant(typeof shouldStopBeforeRun === 'function', 'V7 calibration before-run stop predicate must be a function');
  const job = unit.job;
  const file = terminalRunPath(destination, job.runKey);
  let existing = null;
  if (await exists(file)) existing = validateTerminalV7CalibrationPersistedResult(JSON.parse(await readFile(file, 'utf8')), job);
  if (existing?.status === 'completed' || existing?.status === 'protocol-invalid' || (existing?.status === 'infrastructure-invalid' && !retryInvalid)) {
    onProgress({ runKey: job.runKey, status: 'skipped', persistedStatus: existing.status });
    return { status: 'skipped', result: existing, attempted: false };
  }

  invariant(await shouldStopBeforeRun({ job }) !== true, 'V7 calibration invocation paused before its adapter boundary');

  const id = attemptId();
  const runDirectory = await prepareAttemptWorkspace(destination, job.runKey, id);
  const startedAt = new Date().toISOString();
  onProgress({ runKey: job.runKey, status: 'started', attemptId: id });
  let sealed;
  try {
    const adapterJob = terminalV7CalibrationAdapterJob(unit, challenge);
    const result = await runTerminalJob({ challenge, job: adapterJob, challengeRoot: benchmarkRoot, runDirectory });
    const verifierEvidence = challenge.execution?.verifierEvidencePolicy
      ? await captureVerifierEvidence({ runDirectory, run: result })
      : null;
    sealed = normalizeCompletedRun(job, { ...result, ...(verifierEvidence ? { verifierEvidence } : {}), attemptId: id });
  } catch (error) {
    sealed = sealInvalidAttempt(createInfrastructureInvalidRun(job, error, {
      adapter: error?.adapter ?? null,
      startedAt,
      endedAt: new Date().toISOString(),
    }), id);
  }
  validateTerminalV7CalibrationPersistedResult(sealed, job);
  await Promise.all([
    atomicWriteJson(path.join(destination, 'attempts', job.runKey, `${id}.json`), sealed),
    atomicWriteJson(file, sealed),
  ]);
  onProgress({ runKey: job.runKey, status: sealed.status, attemptId: id });
  return { status: sealed.status, result: sealed, attempted: true };
}

async function acquireLock(resultRoot) {
  const lockPath = path.join(resultRoot, 'runner.lock');
  await mkdir(resultRoot, { recursive: true, mode: 0o700 });
  try {
    const handle = await open(lockPath, 'wx', 0o600);
    await handle.writeFile(`${canonicalJson({ pid: process.pid, startedAt: new Date().toISOString(), policy: 'one-calibration-unit' })}\n`);
    return { handle, lockPath };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = JSON.parse(await readFile(lockPath, 'utf8'));
    let live = false;
    if (Number.isSafeInteger(existing.pid) && existing.pid > 0) {
      try { process.kill(existing.pid, 0); live = true; } catch (probe) { if (probe?.code === 'EPERM') live = true; }
    }
    invariant(!live, `Refusing to launch a competing V7 calibration runner for live PID ${existing.pid}`);
    const history = path.join(resultRoot, 'runner-lock-history');
    await mkdir(history, { recursive: true, mode: 0o700 });
    await rename(lockPath, path.join(history, `stale-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
    const handle = await open(lockPath, 'wx', 0o600);
    await handle.writeFile(`${canonicalJson({ pid: process.pid, startedAt: new Date().toISOString(), policy: 'one-calibration-unit' })}\n`);
    return { handle, lockPath };
  }
}

export async function withTerminalV7CalibrationRunnerLock({ resultRoot, callback } = {}) {
  const destination = safeAbsolute(resultRoot, 'V7 calibration lock root');
  invariant(typeof callback === 'function', 'V7 calibration locked callback is required');
  const lock = await acquireLock(destination);
  try {
    return await callback();
  } finally {
    await lock.handle.close();
    await rm(lock.lockPath, { force: true });
  }
}

export function terminalV7CalibrationUnitForRunKey({ challenge, schedule, runKey } = {}) {
  return createTerminalV7CalibrationExecutionUnit({ challenge, schedule, runKey });
}
