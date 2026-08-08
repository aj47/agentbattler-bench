#!/usr/bin/env node
import { open, mkdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJsonSha256 } from '../src/provenance.mjs';
import { runTerminalSchedule, terminalRunPath, validateTerminalJobIdentity } from '../src/terminal-runner.mjs';
import { scoreTerminalV7Run, validateTerminalV7Challenge, validateTerminalV7Schedule } from '../src/terminal-v7.mjs';
import {
  ensureTerminalV7RevisionSaturationMarker,
  readTerminalV7RevisionStopState,
  resolveTerminalV7RevisionControlRoot,
} from '../src/terminal-v7-revision-control.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REVISION = process.env.AGENTBATTLER_TERMINAL_PROTOCOL_REVISION ?? 'r2';
const RESULT_TAG = process.env.AGENTBATTLER_TERMINAL_RESULT_TAG ?? `v7-${REVISION}`;
const RESULT_ROOT = path.join(ROOT, `results/terminal-mini-ledger-${RESULT_TAG}`);
const REVISION_CONTROL_ROOT = resolveTerminalV7RevisionControlRoot({ root: ROOT, revision: REVISION });
const LOCK_PATH = path.join(RESULT_ROOT, 'runner.lock');
const RETRY_INVALID = process.argv.includes('--retry-invalid');

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function acquireRunnerLock() {
  await mkdir(RESULT_ROOT, { recursive: true });
  try {
    const handle = await open(LOCK_PATH, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), revision: REVISION, retryInvalid: RETRY_INVALID })}\n`);
    return handle;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = JSON.parse(await readFile(LOCK_PATH, 'utf8'));
    let live = false;
    if (Number.isSafeInteger(existing.pid) && existing.pid > 0) {
      try { process.kill(existing.pid, 0); live = true; } catch (probe) { if (probe?.code === 'EPERM') live = true; }
    }
    invariant(!live, `Refusing to launch a competing V7 runner; PID ${existing.pid} is live`);
    const history = path.join(RESULT_ROOT, 'runner-lock-history');
    await mkdir(history, { recursive: true, mode: 0o700 });
    await rename(LOCK_PATH, path.join(history, `stale-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
    const handle = await open(LOCK_PATH, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), revision: REVISION, retryInvalid: RETRY_INVALID })}\n`);
    return handle;
  }
}

async function persistedSaturation(challenge, schedule) {
  for (const job of schedule.jobs) {
    let run;
    try {
      run = JSON.parse(await readFile(terminalRunPath(RESULT_ROOT, job.runKey), 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    validateTerminalJobIdentity(job, run);
    const { resultSha256, ...unsigned } = run;
    invariant(resultSha256 === canonicalJsonSha256(unsigned), `Persisted V7 result hash mismatch for ${job.runKey}`);
    if (run.status !== 'completed') continue;
    const score = scoreTerminalV7Run(run, challenge);
    if (score.core.points === 100) return ensureTerminalV7RevisionSaturationMarker({
      controlRoot: REVISION_CONTROL_ROOT,
      revision: REVISION,
      campaign: 'official-release',
      resultRoot: RESULT_ROOT,
      job,
      run,
      scoreRun: (candidateRun) => scoreTerminalV7Run(candidateRun, challenge),
      detectedAt: run.endedAt ?? new Date().toISOString(),
    });
  }
  return null;
}

invariant(/^r[1-9]\d*$/.test(REVISION) && RESULT_TAG === `v7-${REVISION}`, 'V7 runner revision/result tag mismatch');
process.env.AGENTBATTLER_TERMINAL_CHALLENGE_VERSION = 'v7';
const [challenge, schedule, adapter] = await Promise.all([
  readFile(path.join(RESULT_ROOT, 'challenge.json'), 'utf8').then(JSON.parse),
  readFile(path.join(RESULT_ROOT, 'schedule.json'), 'utf8').then(JSON.parse),
  import('./terminal-adapter-all.mjs'),
]);
validateTerminalV7Challenge(challenge);
validateTerminalV7Schedule(schedule, challenge);
invariant(schedule.jobs.every(({ instanceVariant }) => instanceVariant === 'decoy'), 'V7 scored runner accepts decoy release packs only');

const lock = await acquireRunnerLock();
let saturation = null;
try {
  const stopState = await readTerminalV7RevisionStopState({ controlRoot: REVISION_CONTROL_ROOT, revision: REVISION });
  const retirement = stopState.retirement;
  saturation = stopState.saturation ?? (retirement ? null : await persistedSaturation(challenge, schedule));
  let boundaryStopState = stopState;
  const executionSummary = retirement
    ? { completed: 0, invalid: 0, skipped: 0, paused: true, retired: true }
    : saturation
      ? { completed: 0, invalid: 0, skipped: 0, paused: true, retired: false }
    : await runTerminalSchedule({
        challenge,
        schedule,
        resultRoot: RESULT_ROOT,
        challengeRoot: path.join(ROOT, 'benchmark', 'challenges', 'mini-ledger-v7'),
        runTerminalJob: adapter.runTerminalJob,
        retryInvalid: RETRY_INVALID,
        concurrency: 1,
        onProgress: ({ job, status }) => console.log(`[${status}] round ${job.round} ${job.harness?.id}/${job.instanceId}`),
        shouldStopBeforeJob: async () => {
          boundaryStopState = await readTerminalV7RevisionStopState({ controlRoot: REVISION_CONTROL_ROOT, revision: REVISION });
          saturation = boundaryStopState.saturation ?? saturation;
          if (boundaryStopState.status !== 'active') return true;
          saturation = saturation ?? await persistedSaturation(challenge, schedule);
          return saturation !== null;
        },
        shouldStop: async ({ job, result }) => {
          const score = scoreTerminalV7Run(result, challenge);
          if (score.core.points !== 100) return false;
          saturation = await ensureTerminalV7RevisionSaturationMarker({
            controlRoot: REVISION_CONTROL_ROOT,
            revision: REVISION,
            campaign: 'official-release',
            resultRoot: RESULT_ROOT,
            job,
            run: result,
            scoreRun: (candidateRun) => scoreTerminalV7Run(candidateRun, challenge),
          });
          return true;
        },
      });
  const summary = { ...executionSummary, retired: executionSummary.retired === true || boundaryStopState.status === 'retired' };
  console.log(`V7 runner: ${summary.completed} completed, ${summary.invalid} invalid, ${summary.skipped} skipped, paused=${summary.paused}, retired=${summary.retired === true}`);
} finally {
  await lock.close();
  await rm(LOCK_PATH, { force: true });
}
