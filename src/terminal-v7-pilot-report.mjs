import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  analyzeTerminalV7DevelopmentPilot,
  scoreTerminalV7CalibrationRun,
  validateTerminalV7CalibrationChallenge,
  validateTerminalV7CalibrationSchedule,
} from './terminal-v7-calibration.mjs';
import { evaluateTerminalV7ReleaseGates } from './terminal-v7-gates.mjs';
import { canonicalJson, canonicalJsonSha256 } from './provenance.mjs';
import {
  sealTerminalV7ReleaseGateEvidence,
  validateTerminalV7ReleaseGateEvidence,
} from './terminal-v7-release-evidence.mjs';
import { assertTerminalV7HumanTwinArtifacts } from './terminal-v7-human-twins.mjs';
import { loadV7Pack, materializeV7Starter } from '../benchmark/challenges/mini-ledger-v7/pack.mjs';
import { verifyFinal as verifyTerminalV7Final } from '../benchmark/challenges/mini-ledger-v7/verifier.mjs';
import { snapshotTerminalCandidateTree } from './terminal-candidate-tree.mjs';
import { assertTerminalV7CalibrationAttemptRecord } from './terminal-v7-calibration-runner.mjs';

export const TERMINAL_V7_PILOT_REPORT_SCHEMA = 'agentbattler.terminal-v7-development-pilot-report.v1';

const SHA256_RE = /^[0-9a-f]{64}$/;
const FORBIDDEN_REPORT_KEYS = new Set([
  'prompt', 'prompts', 'session', 'sessionId', 'messages', 'response', 'responses',
  'trajectory', 'trajectories', 'transcript', 'command', 'commands', 'stdout', 'stderr',
  'toolCalls', 'auth', 'token', 'accessToken', 'refreshToken', 'apiKey', 'seedKey', 'hiddenSeed',
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function assertExactKeys(value, expected, label) {
  invariant(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  invariant(canonicalJson(Object.keys(value).sort()) === canonicalJson([...expected].sort()), `${label} keys changed`);
}

function safeAbsolute(value, label) {
  invariant(typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0'), `${label} must be an absolute path`);
  return path.resolve(value);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function atomicWriteJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporary, `${canonicalJson(value, { space: 2 })}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
}

function assertNoLeakageKeys(value, location = '$') {
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoLeakageKeys(child, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    invariant(!FORBIDDEN_REPORT_KEYS.has(key), `V7 pilot report contains forbidden field ${location}.${key}`);
    assertNoLeakageKeys(child, `${location}.${key}`);
  }
}

function validateRunSeal(run) {
  const { resultSha256, ...unsigned } = run ?? {};
  invariant(SHA256_RE.test(resultSha256 ?? '') && resultSha256 === canonicalJsonSha256(unsigned), 'V7 pilot run seal is invalid');
}

function evidenceIssue(runKey, code) {
  return { runKey, code, evidenceSha256: canonicalJsonSha256({ runKey, code }) };
}

async function validateAttemptEvidence(resultRoot, job, run) {
  if (typeof run.attemptId !== 'string' || run.attemptId.length === 0) return evidenceIssue(run.runKey, 'missing-attempt-id');
  try {
    await assertTerminalV7CalibrationAttemptRecord({ resultRoot, job, run });
    return null;
  } catch (error) {
    return evidenceIssue(run.runKey, error?.code === 'ENOENT' ? 'missing-attempt-record' : 'invalid-attempt-record');
  }
}

function validateCompletedEvidence(run) {
  if (run.status !== 'completed' || run.validity !== 'valid') return null;
  if (run.humanIntervention !== 'none') return 'human-intervention';
  if (run.sameSessionProof !== true || !Array.isArray(run.turns) || run.turns.length !== 5) return 'session-evidence-incomplete';
  if (!run.turns.every((turn, index) => turn.index === index + 1 && turn.candidateTree)) return 'turn-evidence-incomplete';
  if (!Array.isArray(run.stages) || run.stages.length !== 5) return 'stage-evidence-incomplete';
  if (!Array.isArray(run.phaseResults) || run.phaseResults.length !== 5) return 'phase-evidence-incomplete';
  if (run.phaseResults.some((phase) => !Array.isArray(phase.infrastructureErrors) || phase.infrastructureErrors.length > 0)) return 'phase-infrastructure-error';
  if (!run.evaluation || !Array.isArray(run.evaluation.infrastructureErrors) || run.evaluation.infrastructureErrors.length > 0) return 'final-infrastructure-error';
  return null;
}

export async function collectTerminalV7DevelopmentPilotEvidence({
  resultRoot,
  repositoryRoot = path.resolve(import.meta.dirname, '..'),
  completedRunValidator = null,
} = {}) {
  const destination = safeAbsolute(resultRoot, 'V7 pilot result root');
  const [challenge, schedule] = await Promise.all([
    readJson(path.join(destination, 'challenge.json')),
    readJson(path.join(destination, 'schedule.json')),
  ]);
  validateTerminalV7CalibrationChallenge(challenge, { requireExecution: true });
  validateTerminalV7CalibrationSchedule(schedule, challenge);
  invariant(schedule.campaign === 'development-pilot', 'V7 pilot collector received another campaign');
  const expectedNames = new Set(schedule.jobs.map(({ runKey }) => `${runKey}.json`));
  const entries = await readdir(path.join(destination, 'runs'), { withFileTypes: true }).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error));
  const observedNames = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map(({ name }) => name);
  const unexpected = observedNames.filter((name) => !expectedNames.has(name));
  invariant(unexpected.length === 0, 'V7 pilot result root contains an unscheduled run record');
  const runs = [];
  const evidenceIssues = [];
  const requirementMap = await readJson(path.join(repositoryRoot, 'benchmark', 'challenges', 'mini-ledger-v7', 'requirement-map.json'));
  const validator = completedRunValidator ?? (await import('../scripts/verify-terminal-v7-results.mjs')).validateTerminalV7CompletedRun;
  const baseTrees = new Map();
  const temporaryRoots = [];
  try {
  for (const job of schedule.jobs) {
    const file = path.join(destination, 'runs', `${job.runKey}.json`);
    let run;
    try { run = await readJson(file); } catch (error) {
      if (error?.code === 'ENOENT') continue;
      evidenceIssues.push(evidenceIssue(job.runKey, 'malformed-run-record'));
      continue;
    }
    try { validateRunSeal(run); } catch {
      evidenceIssues.push(evidenceIssue(job.runKey, 'invalid-run-seal'));
    }
    const attemptIssue = await validateAttemptEvidence(destination, job, run);
    if (attemptIssue) evidenceIssues.push(attemptIssue);
    const completedIssue = validateCompletedEvidence(run);
    if (completedIssue) evidenceIssues.push(evidenceIssue(job.runKey, completedIssue));
    if (!completedIssue && run.status === 'completed' && run.validity === 'valid') {
      try {
        const baseTreeKey = `${job.instanceId}\0${job.instanceVariant}`;
        if (!baseTrees.has(baseTreeKey)) {
          const temporary = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-v7-pilot-verify-'));
          temporaryRoots.push(temporary);
          const pack = loadV7Pack(job.instanceId, { variant: job.instanceVariant });
          await materializeV7Starter({ pack, destination: temporary });
          baseTrees.set(baseTreeKey, await snapshotTerminalCandidateTree({ root: temporary, policy: challenge.execution.candidateTree.policy }));
        }
        await validator({
          challenge,
          job,
          run,
          resultRoot: destination,
          baseTree: baseTrees.get(baseTreeKey),
          requirementMap,
          scoreRun: (candidateRun) => scoreTerminalV7CalibrationRun(candidateRun),
          recomputeFinal: async ({ instanceId, phaseResults }) => {
            const pack = loadV7Pack(instanceId, { variant: job.instanceVariant });
            return verifyTerminalV7Final({ instance: pack, pack, phaseResults, verifierSeedIndex: 0 });
          },
        });
      } catch {
        evidenceIssues.push(evidenceIssue(job.runKey, 'strict-completed-run-validation-failed'));
      }
    }
    runs.push(run);
  }
  } finally {
    await Promise.allSettled(temporaryRoots.map((temporary) => rm(temporary, { recursive: true, force: true })));
  }
  return { challenge, schedule, runs, evidenceIssues };
}

function runSetCommitment(runs) {
  return canonicalJsonSha256([...runs].map((run) => ({
    runKey: run.runKey,
    status: run.status,
    resultSha256: run.resultSha256,
  })).sort((left, right) => String(left.runKey).localeCompare(String(right.runKey))));
}

function pilotGateShape(analysis, evidenceIssues) {
  const infrastructureInvalid = analysis.infrastructureInvalid.length + evidenceIssues.length;
  return {
    lunaMaxJobs: analysis.population.maxRuns,
    lunaHighJobs: analysis.population.highAnchorRuns,
    lunaMaxDecoyMedian: analysis.observations.maxDecoyMedianCore,
    maximumCore: analysis.observations.maximumPilotCore,
    exactCompletions: analysis.observations.exactMaxDecoyRuns,
    lunaMaxMinusHigh: analysis.observations.pairedMeanMaxMinusHigh,
    scriptedTwinDifference: analysis.observations.scriptedTwinMaximumAbsoluteDifference,
    humanTwinDifference: analysis.observations.humanTwinMaximumAbsoluteDifference,
    infrastructureInvalid,
  };
}

export function createTerminalV7DevelopmentPilotReport({
  challenge,
  schedule,
  runs,
  evidenceIssues = [],
  scriptedReferences,
  humanTwinValidations,
  humanTwinArtifactClosure,
  createdAt,
} = {}) {
  invariant(typeof createdAt === 'string' && Number.isFinite(Date.parse(createdAt)), 'V7 pilot report timestamp is invalid');
  invariant(Array.isArray(evidenceIssues), 'V7 pilot evidence issues must be an array');
  evidenceIssues.forEach((issue) => {
    invariant(SHA256_RE.test(issue?.evidenceSha256 ?? '') && typeof issue.runKey === 'string' && typeof issue.code === 'string', 'V7 pilot evidence issue is invalid');
  });
  const analysis = analyzeTerminalV7DevelopmentPilot({ challenge, schedule, runs, scriptedReferences, humanTwinValidations });
  invariant(humanTwinArtifactClosure?.schemaVersion === 'agentbattler.terminal-v7-human-twin-artifact-closure.v1'
    && humanTwinArtifactClosure.rowsSha256 === canonicalJsonSha256(humanTwinValidations)
    && SHA256_RE.test(humanTwinArtifactClosure.artifactsSha256 ?? ''), 'V7 pilot report requires artifact-closed human twin evidence');
  const pilot = pilotGateShape(analysis, evidenceIssues);
  const checks = analysis.checks.map(({ id, passed }) => ({ id, passed }));
  if (evidenceIssues.length > 0) checks.push({ id: 'PILOT-IMMUTABLE-EVIDENCE', passed: false });
  else checks.push({ id: 'PILOT-IMMUTABLE-EVIDENCE', passed: true });
  const unsigned = {
    schemaVersion: TERMINAL_V7_PILOT_REPORT_SCHEMA,
    createdAt,
    revision: challenge.protocolRevision,
    challengeSha256: challenge.challengeSha256,
    scheduleSha256: schedule.scheduleSha256,
    sourceCommitments: {
      runSetSha256: runSetCommitment(runs),
      scriptedReferencesSha256: canonicalJsonSha256(scriptedReferences),
      humanTwinValidationsSha256: canonicalJsonSha256(humanTwinValidations),
      humanTwinArtifactsSha256: humanTwinArtifactClosure.artifactsSha256,
      analysisSha256: analysis.analysisSha256,
      evidenceIssuesSha256: canonicalJsonSha256(evidenceIssues),
    },
    matrix: { scheduledRuns: schedule.jobs.length, observedRuns: runs.length },
    pilot,
    checks,
    accepted: analysis.accepted && evidenceIssues.length === 0,
    decision: analysis.accepted && evidenceIssues.length === 0 ? 'accept-development-pilot' : 'reject-and-reseal-template',
    privacy: {
      aggregatesOnly: true,
      modelTextIncluded: false,
      promptsIncluded: false,
      sessionsIncluded: false,
      commandsIncluded: false,
    },
  };
  const report = { ...unsigned, reportSha256: canonicalJsonSha256(unsigned) };
  validateTerminalV7DevelopmentPilotReport(report);
  return report;
}

export function validateTerminalV7DevelopmentPilotReport(report) {
  invariant(report?.schemaVersion === TERMINAL_V7_PILOT_REPORT_SCHEMA, 'Unsupported V7 pilot report schema');
  assertExactKeys(report, [
    'schemaVersion', 'createdAt', 'revision', 'challengeSha256', 'scheduleSha256',
    'sourceCommitments', 'matrix', 'pilot', 'checks', 'accepted', 'decision', 'privacy', 'reportSha256',
  ], 'V7 pilot report');
  const { reportSha256, ...unsigned } = report;
  invariant(SHA256_RE.test(reportSha256 ?? '') && reportSha256 === canonicalJsonSha256(unsigned), 'V7 pilot report hash mismatch');
  invariant(/^r[1-9]\d*$/.test(report.revision ?? '') && SHA256_RE.test(report.challengeSha256 ?? '') && SHA256_RE.test(report.scheduleSha256 ?? ''), 'V7 pilot report identity is invalid');
  invariant(typeof report.createdAt === 'string' && Number.isFinite(Date.parse(report.createdAt)), 'V7 pilot report timestamp is invalid');
  assertExactKeys(report.sourceCommitments, [
    'runSetSha256', 'scriptedReferencesSha256', 'humanTwinValidationsSha256',
    'humanTwinArtifactsSha256', 'analysisSha256', 'evidenceIssuesSha256',
  ], 'V7 pilot report source commitments');
  invariant(Object.values(report.sourceCommitments).every((value) => SHA256_RE.test(value ?? '')), 'V7 pilot report source commitments are incomplete');
  assertExactKeys(report.matrix, ['scheduledRuns', 'observedRuns'], 'V7 pilot report matrix');
  assertExactKeys(report.pilot, [
    'lunaMaxJobs', 'lunaHighJobs', 'lunaMaxDecoyMedian', 'maximumCore', 'exactCompletions',
    'lunaMaxMinusHigh', 'scriptedTwinDifference', 'humanTwinDifference', 'infrastructureInvalid',
  ], 'V7 pilot gate projection');
  invariant(report.matrix?.scheduledRuns === 15 && Number.isSafeInteger(report.matrix.observedRuns) && report.matrix.observedRuns >= 0 && report.matrix.observedRuns <= 15, 'V7 pilot report matrix is invalid');
  const pilot = report.pilot;
  invariant(pilot && Object.values(pilot).every((value) => typeof value === 'number' && Number.isFinite(value)), 'V7 pilot gate projection is invalid');
  invariant(Array.isArray(report.checks) && report.checks.every((check) => {
    assertExactKeys(check, ['id', 'passed'], 'V7 pilot report check');
    return typeof check.id === 'string' && /^[A-Z0-9-]{1,100}$/.test(check.id) && (check.passed === true || check.passed === false);
  }), 'V7 pilot report checks are invalid');
  assertExactKeys(report.privacy, ['aggregatesOnly', 'modelTextIncluded', 'promptsIncluded', 'sessionsIncluded', 'commandsIncluded'], 'V7 pilot report privacy');
  invariant(report.privacy.aggregatesOnly === true && report.privacy.modelTextIncluded === false && report.privacy.promptsIncluded === false && report.privacy.sessionsIncluded === false && report.privacy.commandsIncluded === false, 'V7 pilot report privacy policy changed');
  invariant(report.accepted === report.checks.every(({ passed }) => passed === true), 'V7 pilot report acceptance does not match its checks');
  invariant(report.decision === (report.accepted ? 'accept-development-pilot' : 'reject-and-reseal-template'), 'V7 pilot report decision changed');
  assertNoLeakageKeys(report);
  return report;
}

export async function assertTerminalV7DevelopmentPilotReportSources({
  resultRoot,
  report,
  scriptedReferences,
  humanTwinValidations,
  humanTwinOptions = {},
  completedRunValidator = null,
  humanTwinArtifactValidator = assertTerminalV7HumanTwinArtifacts,
} = {}) {
  validateTerminalV7DevelopmentPilotReport(report);
  invariant(typeof humanTwinArtifactValidator === 'function', 'V7 human-twin artifact validator is required');
  const [collected, humanTwinArtifactClosure] = await Promise.all([
    collectTerminalV7DevelopmentPilotEvidence({ resultRoot, completedRunValidator }),
    humanTwinArtifactValidator({ evidenceRoot: resultRoot, rows: humanTwinValidations, options: humanTwinOptions }),
  ]);
  const rebuilt = createTerminalV7DevelopmentPilotReport({
    ...collected,
    scriptedReferences,
    humanTwinValidations,
    humanTwinArtifactClosure,
    createdAt: report.createdAt,
  });
  invariant(canonicalJson(rebuilt) === canonicalJson(report), 'V7 pilot report is not reproducible from its sealed run, scripted-reference, and human-twin evidence');
  return report;
}

export function createTerminalV7ReleaseGateEvidenceFromPilot({ baseEvidence, pilotReport, evaluatedAt } = {}) {
  validateTerminalV7DevelopmentPilotReport(pilotReport);
  const evidence = sealTerminalV7ReleaseGateEvidence({ baseEvidence, pilotReport, evaluatedAt });
  validateTerminalV7ReleaseGateEvidence(evidence);
  const evaluation = evaluateTerminalV7ReleaseGates(evidence);
  return { evidence, evaluation };
}

export async function writeTerminalV7PilotAndGateReports({
  resultRoot,
  pilotReport,
  gateEvidence,
} = {}) {
  const destination = safeAbsolute(resultRoot, 'V7 pilot report root');
  validateTerminalV7DevelopmentPilotReport(pilotReport);
  validateTerminalV7ReleaseGateEvidence(gateEvidence);
  invariant(gateEvidence.revision === pilotReport.revision && gateEvidence.pilot?.pilotReportSha256 === pilotReport.reportSha256, 'V7 release-gate evidence does not bind the pilot report');
  await Promise.all([
    atomicWriteJson(path.join(destination, 'pilot-report.json'), pilotReport),
    atomicWriteJson(path.join(destination, 'release-gates.json'), gateEvidence),
  ]);
}
