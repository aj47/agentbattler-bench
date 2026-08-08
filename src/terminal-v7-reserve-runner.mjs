import path from 'node:path';

import {
  scoreTerminalV7CalibrationRun,
  validateTerminalV7CalibrationChallenge,
  validateTerminalV7CalibrationSchedule,
} from './terminal-v7-calibration.mjs';
import {
  runTerminalV7CalibrationExecutionUnit,
  terminalV7CalibrationUnitForRunKey,
} from './terminal-v7-calibration-runner.mjs';
import { captureTerminalV7VerifierEvidence } from './terminal-v7-verifier-evidence.mjs';
import {
  ensureTerminalV7RevisionSaturationMarker,
  readTerminalV7RevisionStopState,
} from './terminal-v7-revision-control.mjs';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function safeAbsolute(value, label) {
  invariant(typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0'), `${label} must be an absolute path`);
  return path.resolve(value);
}

export async function runTerminalV7ReserveSchedule({
  challenge,
  schedule,
  resultRoot,
  challengeRoot,
  runTerminalJob,
  captureVerifierEvidence = captureTerminalV7VerifierEvidence,
  revisionControlRoot = null,
  retryInvalid = false,
  onProgress = () => {},
} = {}) {
  validateTerminalV7CalibrationChallenge(challenge, { requireExecution: true });
  validateTerminalV7CalibrationSchedule(schedule, challenge);
  invariant(schedule.campaign === 'reserve-extension' && schedule.jobs.length === 10, 'V7 reserve runner requires the sealed 10-job reserve extension');
  const destination = safeAbsolute(resultRoot, 'V7 reserve result root');
  const benchmarkRoot = safeAbsolute(challengeRoot, 'V7 reserve challenge root');
  const controlRoot = safeAbsolute(revisionControlRoot
    ?? path.join(path.dirname(destination), `terminal-mini-ledger-v7-control-${challenge.protocolRevision}`), 'V7 revision control root');
  invariant(typeof runTerminalJob === 'function' && typeof onProgress === 'function', 'V7 reserve runner callbacks are required');
  const stopState = await readTerminalV7RevisionStopState({ controlRoot, revision: challenge.protocolRevision });
  if (stopState.status === 'retired') return { status: 'retirement-paused', attemptedJobs: 0, retirement: stopState.retirement };
  if (stopState.status === 'saturation-pending') return { status: 'saturation-paused', attemptedJobs: 0, saturationAudit: stopState.saturation };

  let attemptedJobs = 0;
  let processedJobs = 0;
  for (const job of [...schedule.jobs].sort((left, right) => left.executionIndex - right.executionIndex)) {
    const boundaryStopState = await readTerminalV7RevisionStopState({ controlRoot, revision: challenge.protocolRevision });
    if (boundaryStopState.status === 'retired') {
      return { status: 'retirement-paused', attemptedJobs, processedJobs, retirement: boundaryStopState.retirement };
    }
    if (boundaryStopState.status === 'saturation-pending') {
      return { status: 'saturation-paused', attemptedJobs, processedJobs, saturationAudit: boundaryStopState.saturation };
    }
    const unit = terminalV7CalibrationUnitForRunKey({ challenge, schedule, runKey: job.runKey });
    const outcome = await runTerminalV7CalibrationExecutionUnit({
      challenge,
      schedule,
      unit,
      resultRoot: destination,
      challengeRoot: benchmarkRoot,
      runTerminalJob,
      captureVerifierEvidence,
      retryInvalid,
      onProgress,
    });
    processedJobs += 1;
    if (outcome.attempted) attemptedJobs += 1;
    if (outcome.result.status !== 'completed' || outcome.result.validity !== 'valid') continue;
    if (scoreTerminalV7CalibrationRun(outcome.result).corePoints !== 100) continue;
    const marker = await ensureTerminalV7RevisionSaturationMarker({
      controlRoot,
      revision: challenge.protocolRevision,
      campaign: 'reserve-extension',
      resultRoot: destination,
      job,
      run: outcome.result,
      scoreRun: scoreTerminalV7CalibrationRun,
    });
    onProgress({ runKey: job.runKey, status: 'saturation-paused', detectedCore: 100 });
    return { status: 'saturation-paused', attemptedJobs, processedJobs, saturationAudit: marker };
  }
  return { status: 'complete', attemptedJobs, processedJobs, saturationAudit: null };
}
