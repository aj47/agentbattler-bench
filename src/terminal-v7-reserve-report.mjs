import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadV7Pack, materializeV7Starter, sealV7Pack } from '../benchmark/challenges/mini-ledger-v7/pack.mjs';
import { verifyFinal as verifyTerminalV7Final } from '../benchmark/challenges/mini-ledger-v7/verifier.mjs';

import {
  scoreTerminalV7CalibrationRun,
  validateTerminalV7CalibrationChallenge,
  validateTerminalV7CalibrationSchedule,
  validateTerminalV7CalibrationTaskBinding,
} from './terminal-v7-calibration.mjs';
import {
  assertTerminalV7CalibrationAttemptRecord,
  validateTerminalV7CalibrationPersistedResult,
} from './terminal-v7-calibration-runner.mjs';
import { canonicalJson, canonicalJsonSha256 } from './provenance.mjs';
import { snapshotTerminalCandidateTree } from './terminal-candidate-tree.mjs';
import { validateTerminalV7CompletedRun } from '../scripts/verify-terminal-v7-results.mjs';
import { aggregateTerminalV7OperationalMetrics } from './terminal-v7-operational-metrics.mjs';
import {
  TERMINAL_V7_BOOTSTRAP_RESAMPLES,
  TERMINAL_V7_DEFAULT_BOOTSTRAP_SEED,
  TERMINAL_V7_PRACTICAL_WIN_POINTS,
} from './terminal-v7.mjs';

export const TERMINAL_V7_RESERVE_FINAL_REPORT_SCHEMA = 'agentbattler.terminal-v7-reserve-final-report.v2';

const REQUIREMENT_MAP_PATH = path.resolve(import.meta.dirname, '../benchmark/challenges/mini-ledger-v7/requirement-map.json');

const SHA256_RE = /^[0-9a-f]{64}$/;
const HARNESS_IDS = new Set(['claude-code', 'codex-cli', 'dotagents-mono', 'factory-droid', 'pi-coding-agent']);
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

function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function mixSeed(seed, label) {
  return Number.parseInt(canonicalJsonSha256({ seed, label }).slice(0, 8), 16) >>> 0;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function quantile(sorted, probability) {
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] * (1 - (position - lower)) + sorted[upper] * (position - lower);
}

function bootstrapInterval(differences, seed) {
  const random = mulberry32(seed);
  const distribution = new Array(TERMINAL_V7_BOOTSTRAP_RESAMPLES);
  for (let sample = 0; sample < distribution.length; sample += 1) {
    let total = 0;
    for (let draw = 0; draw < differences.length; draw += 1) total += differences[Math.floor(random() * differences.length)];
    distribution[sample] = total / differences.length;
  }
  distribution.sort((left, right) => left - right);
  return { low: round(quantile(distribution, 0.025)), high: round(quantile(distribution, 0.975)) };
}

function assertNoLeakageKeys(value, location = '$') {
  if (Array.isArray(value)) return value.forEach((child, index) => assertNoLeakageKeys(child, `${location}[${index}]`));
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    invariant(!FORBIDDEN_REPORT_KEYS.has(key), `V7 reserve report contains forbidden field ${location}.${key}`);
    assertNoLeakageKeys(child, `${location}.${key}`);
  }
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

function resultSetSha256(runs) {
  return canonicalJsonSha256(runs.map(({ runKey, resultSha256 }) => ({ runKey, resultSha256 }))
    .sort((left, right) => left.runKey.localeCompare(right.runKey)));
}

function validateCompletedEvidence(run) {
  invariant(run.status === 'completed' && run.validity === 'valid', `V7 reserve run ${run.runKey} is not valid and completed`);
  invariant(run.humanIntervention === 'none', `V7 reserve run ${run.runKey} has human intervention`);
  invariant(run.sameSessionProof === true && typeof run.sessionId === 'string' && run.sessionId.length > 0, `V7 reserve run ${run.runKey} lacks same-session proof`);
  invariant(Array.isArray(run.turns) && run.turns.length === 5, `V7 reserve run ${run.runKey} lacks five turns`);
  invariant(run.turns.every((turn, index) => turn.index === index + 1 && turn.sessionId === run.sessionId && turn.candidateTree), `V7 reserve run ${run.runKey} has invalid turn evidence`);
  invariant(Array.isArray(run.stages) && run.stages.length === 5, `V7 reserve run ${run.runKey} lacks five stage records`);
  invariant(Array.isArray(run.phaseResults) && run.phaseResults.length === 5, `V7 reserve run ${run.runKey} lacks five phase results`);
  invariant(run.phaseResults.every((phase) => Array.isArray(phase.infrastructureErrors) && phase.infrastructureErrors.length === 0), `V7 reserve run ${run.runKey} has a phase infrastructure error`);
  invariant(Array.isArray(run.evaluation?.infrastructureErrors) && run.evaluation.infrastructureErrors.length === 0, `V7 reserve run ${run.runKey} has a final infrastructure error`);
}

async function strictReserveRunEvidence({ destination, challenge, job, run, requirementMap, seedKey }) {
  invariant(typeof seedKey === 'string' && seedKey.length >= 16, 'V7 reserve strict verification requires the evaluator-held seed key');
  const instance = challenge.instances.find((entry) => entry.instanceId === job.instanceId && entry.variant === 'decoy');
  invariant(instance, `V7 reserve instance is missing for ${job.instanceId}`);
  const pack = sealV7Pack(loadV7Pack(job.instanceId, { variant: 'decoy' }), { seedKey });
  invariant(pack.packSha256 === instance.packCommitments.packSha256, `V7 reserve starter changed for ${job.instanceId}`);
  invariant(pack.sealSha256 === instance.packCommitments.sealSha256
    && pack.hiddenMerkleRoot === instance.packCommitments.hiddenMerkleRoot, `V7 reserve sealed verifier inputs changed for ${job.instanceId}`);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-v7-reserve-verify-'));
  try {
    await materializeV7Starter({ pack, destination: temporary });
    const baseTree = await snapshotTerminalCandidateTree({ root: temporary, policy: challenge.execution.candidateTree.policy });
    return await validateTerminalV7CompletedRun({
      challenge,
      job,
      run,
      resultRoot: destination,
      baseTree,
      requirementMap,
      scoreRun: (candidateRun) => {
        const score = scoreTerminalV7CalibrationRun(candidateRun);
        return { core: { points: score.corePoints }, exact: score.exact };
      },
      recomputeFinal: ({ phaseResults }) => verifyTerminalV7Final({
        instance: pack,
        pack,
        phaseResults,
        seedKey,
        verifierSeedIndex: 0,
      }),
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function collectTerminalV7ReserveEvidence({
  resultRoot,
  seedKey = null,
  validateCompletedRun = null,
} = {}) {
  const destination = safeAbsolute(resultRoot, 'V7 reserve result root');
  const [challenge, schedule, taskBinding, control] = await Promise.all([
    readJson(path.join(destination, 'challenge.json')),
    readJson(path.join(destination, 'schedule.json')),
    readJson(path.join(destination, 'control', 'task-binding.json')),
    readJson(path.join(destination, 'control', 'calibration-control.json')),
  ]);
  validateTerminalV7CalibrationChallenge(challenge, { requireExecution: true });
  validateTerminalV7CalibrationSchedule(schedule, challenge);
  validateTerminalV7CalibrationTaskBinding(taskBinding, challenge);
  invariant(schedule.campaign === 'reserve-extension' && schedule.jobs.length === 10, 'V7 reserve collector requires the complete 10-job reserve extension');
  const completedRunValidator = validateCompletedRun ?? ((options) => strictReserveRunEvidence({ ...options, seedKey }));
  invariant(typeof completedRunValidator === 'function', 'V7 reserve completed-run validator is required');
  const { controlSha256, ...unsignedControl } = control;
  invariant(controlSha256 === canonicalJsonSha256(unsignedControl), 'V7 reserve control record hash mismatch');
  invariant(control.campaign === 'reserve-extension'
    && control.challenge?.sha256 === challenge.challengeSha256
    && control.schedule?.sha256 === schedule.scheduleSha256
    && control.taskBindingSha256 === taskBinding.taskBindingSha256
    && control.sealManifestSha256 === challenge.packSelection.sourceManifestSha256,
  'V7 reserve control record is not cross-bound to the sealed campaign');

  const expectedNames = new Set(schedule.jobs.map(({ runKey }) => `${runKey}.json`));
  const entries = await readdir(path.join(destination, 'runs'), { withFileTypes: true }).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error));
  invariant(entries.every((entry) => entry.isFile() && expectedNames.has(entry.name)), 'V7 reserve result root contains an unscheduled or non-regular run record');
  invariant(entries.length === 10, 'V7 reserve final report requires all 10 scheduled run records');
  const requirementMap = JSON.parse(await readFile(REQUIREMENT_MAP_PATH, 'utf8'));
  const scoredRuns = [];
  for (const job of schedule.jobs) {
    const run = validateTerminalV7CalibrationPersistedResult(await readJson(path.join(destination, 'runs', `${job.runKey}.json`)), job);
    validateCompletedEvidence(run);
    await assertTerminalV7CalibrationAttemptRecord({ resultRoot: destination, job, run });
    const validated = await completedRunValidator({ destination, challenge, job, run, requirementMap });
    scoredRuns.push({
      job,
      run,
      score: scoreTerminalV7CalibrationRun(run),
      trees: Array.isArray(validated?.trees) ? validated.trees : null,
    });
  }
  return {
    challenge,
    schedule,
    taskBinding,
    control,
    scoredRuns,
    resultSetSha256: resultSetSha256(scoredRuns.map(({ run }) => run)),
  };
}

function normalizedReleaseRows(releaseVerification, selectedHarnessIds) {
  invariant(releaseVerification?.officialMatrixVerified === true && releaseVerification.scoredRuns?.length === 25, 'V7 reserve report requires strict verification of all 25 release jobs');
  return releaseVerification.scoredRuns
    .filter(({ job }) => selectedHarnessIds.includes(job.harness.id))
    .map(({ job, run, score }) => ({ pool: 'release', harnessId: job.harness.id, instanceId: job.instanceId, corePoints: score.core.points, run }));
}

export function analyzeTerminalV7ReserveCompletion({ releaseVerification, reserveEvidence, bootstrapSeed = TERMINAL_V7_DEFAULT_BOOTSTRAP_SEED } = {}) {
  invariant(Number.isSafeInteger(bootstrapSeed) && bootstrapSeed >= 0 && bootstrapSeed <= 0xffff_ffff, 'V7 reserve bootstrap seed must be a uint32');
  const { challenge, schedule, scoredRuns } = reserveEvidence ?? {};
  validateTerminalV7CalibrationSchedule(schedule, challenge);
  invariant(schedule.campaign === 'reserve-extension' && scoredRuns?.length === 10, 'V7 reserve analysis requires 10 strictly collected reserve runs');
  const selectedHarnessIds = [...challenge.selection.leadingPairHarnessIds].sort();
  invariant(challenge.selection.releaseChallengeSha256 === releaseVerification.challenge.challengeSha256
    && challenge.selection.releaseScheduleSha256 === releaseVerification.schedule.scheduleSha256,
  'V7 reserve selection is not bound to the verified release campaign');
  invariant(challenge.selection.releaseResultSetSha256 === resultSetSha256(releaseVerification.scoredRuns.map(({ run }) => run)), 'V7 reserve selection release result-set commitment mismatch');
  invariant(challenge.selection.releaseAnalysisSha256 === canonicalJsonSha256(releaseVerification.summary.pairedAnalysis), 'V7 reserve selection release-analysis commitment mismatch');
  const releaseRows = normalizedReleaseRows(releaseVerification, selectedHarnessIds);
  const reserveRows = scoredRuns.map(({ job, score }) => ({ pool: 'reserve', harnessId: job.harness.id, instanceId: job.instanceId, corePoints: score.corePoints }));
  invariant(releaseRows.length === 10 && reserveRows.length === 10, 'V7 reserve combined analysis must contain two harnesses across five release and five reserve packs');
  const rows = [...releaseRows, ...reserveRows];
  const values = new Map();
  for (const row of rows) {
    invariant(selectedHarnessIds.includes(row.harnessId) && Number.isFinite(row.corePoints) && row.corePoints >= 0 && row.corePoints <= 100, 'V7 reserve combined score row is invalid');
    const clusterId = `${row.pool}:${row.instanceId}`;
    const key = `${row.harnessId}\0${clusterId}`;
    invariant(!values.has(key), `Duplicate V7 reserve combined result ${key}`);
    values.set(key, row.corePoints);
  }
  const clusterIds = [...new Set(rows.map(({ pool, instanceId }) => `${pool}:${instanceId}`))].sort();
  invariant(clusterIds.length === 10 && selectedHarnessIds.every((id) => clusterIds.every((clusterId) => values.has(`${id}\0${clusterId}`))), 'V7 reserve combined result matrix is not two harnesses by 10 pack clusters');
  const [leftHarnessId, rightHarnessId] = selectedHarnessIds;
  const packDifferences = clusterIds.map((clusterId) => ({ clusterId, difference: round(values.get(`${leftHarnessId}\0${clusterId}`) - values.get(`${rightHarnessId}\0${clusterId}`)) }));
  const differences = packDifferences.map(({ difference }) => difference);
  const mean = (harnessId) => round(clusterIds.reduce((total, clusterId) => total + values.get(`${harnessId}\0${clusterId}`), 0) / clusterIds.length);
  const meanDifference = round(differences.reduce((total, value) => total + value, 0) / differences.length);
  const pairSeed = mixSeed(bootstrapSeed, `${leftHarnessId}\0${rightHarnessId}\0release+reserve`);
  const confidenceInterval95 = bootstrapInterval(differences, pairSeed);
  const confidenceExcludesZero = confidenceInterval95.low > 0 || confidenceInterval95.high < 0;
  const practicalMagnitude = Math.abs(meanDifference) >= TERMINAL_V7_PRACTICAL_WIN_POINTS;
  const winnerHarnessId = practicalMagnitude && confidenceExcludesZero ? (meanDifference > 0 ? leftHarnessId : rightHarnessId) : null;
  return {
    metric: 'Core',
    harnesses: selectedHarnessIds,
    clusterCounts: { release: 5, reserve: 5, combined: 10 },
    standings: selectedHarnessIds.map((harnessId) => ({ harnessId, meanCore: mean(harnessId) })).sort((a, b) => b.meanCore - a.meanCore || a.harnessId.localeCompare(b.harnessId)),
    comparison: {
      leftHarnessId,
      rightHarnessId,
      meanDifference,
      packDifferences,
      confidenceInterval95,
      practicalMagnitude,
      confidenceExcludesZero,
      winnerHarnessId,
      decision: winnerHarnessId ? 'practical-win' : 'tie',
      bootstrap: { method: 'paired-cluster-percentile', clusterUnit: 'sealed-instance-pack', clusters: 10, resamples: TERMINAL_V7_BOOTSTRAP_RESAMPLES, seed: pairSeed },
    },
  };
}

export function createTerminalV7ReserveFinalReport({ releaseVerification, reserveEvidence, createdAt, bootstrapSeed = TERMINAL_V7_DEFAULT_BOOTSTRAP_SEED } = {}) {
  invariant(typeof createdAt === 'string' && Number.isFinite(Date.parse(createdAt)), 'V7 reserve report timestamp is invalid');
  invariant(SHA256_RE.test(releaseVerification?.officialEvidenceSha256 ?? ''), 'V7 reserve report requires the stable official evidence commitment');
  const analysis = analyzeTerminalV7ReserveCompletion({ releaseVerification, reserveEvidence, bootstrapSeed });
  const saturated = [...releaseVerification.scoredRuns.map(({ score }) => score.core.points), ...reserveEvidence.scoredRuns.map(({ score }) => score.corePoints)].includes(100);
  const releaseRuns = releaseVerification.scoredRuns.map(({ run }) => run);
  const reserveRuns = reserveEvidence.scoredRuns.map(({ run }) => run);
  const operational = {
    release: aggregateTerminalV7OperationalMetrics(releaseRuns, { expectedRuns: 25, infrastructureInvalid: 0, missing: 0 }),
    reserve: aggregateTerminalV7OperationalMetrics(reserveRuns, { expectedRuns: 10, infrastructureInvalid: 0, missing: 0 }),
    combined: aggregateTerminalV7OperationalMetrics([...releaseRuns, ...reserveRuns], { expectedRuns: 35, infrastructureInvalid: 0, missing: 0 }),
  };
  const unsigned = {
    schemaVersion: TERMINAL_V7_RESERVE_FINAL_REPORT_SCHEMA,
    createdAt,
    revision: reserveEvidence.challenge.protocolRevision,
    sourceCommitments: {
      releaseChallengeSha256: releaseVerification.challenge.challengeSha256,
      releaseScheduleSha256: releaseVerification.schedule.scheduleSha256,
      releaseResultSetSha256: resultSetSha256(releaseVerification.scoredRuns.map(({ run }) => run)),
      releaseOfficialEvidenceSha256: releaseVerification.officialEvidenceSha256,
      reserveChallengeSha256: reserveEvidence.challenge.challengeSha256,
      reserveScheduleSha256: reserveEvidence.schedule.scheduleSha256,
      reserveResultSetSha256: reserveEvidence.resultSetSha256,
      reserveTaskBindingSha256: reserveEvidence.taskBinding.taskBindingSha256,
      reserveControlSha256: reserveEvidence.control.controlSha256,
    },
    matrix: { selectedHarnesses: 2, releaseClusters: 5, reserveClusters: 5, combinedClusters: 10, combinedRuns: 20 },
    operational,
    standings: analysis.standings,
    comparison: Object.fromEntries(Object.entries(analysis.comparison).filter(([key]) => key !== 'packDifferences')),
    saturationAudit: { triggered: saturated, pauseRequired: saturated, reason: saturated ? 'core-100-saturation-audit' : null },
    decision: saturated ? 'pause-for-saturation-audit' : analysis.comparison.decision,
    winnerHarnessId: saturated ? null : analysis.comparison.winnerHarnessId,
    privacy: { aggregatesOnly: true, modelTextIncluded: false, promptsIncluded: false, sessionsIncluded: false, commandsIncluded: false },
  };
  const report = { ...unsigned, reportSha256: canonicalJsonSha256(unsigned) };
  validateTerminalV7ReserveFinalReport(report);
  return report;
}

export function validateTerminalV7ReserveFinalReport(report) {
  invariant(report?.schemaVersion === TERMINAL_V7_RESERVE_FINAL_REPORT_SCHEMA, 'Unsupported V7 reserve final-report schema');
  assertExactKeys(report, [
    'schemaVersion', 'createdAt', 'revision', 'sourceCommitments', 'matrix', 'standings',
    'operational', 'comparison', 'saturationAudit', 'decision', 'winnerHarnessId', 'privacy', 'reportSha256',
  ], 'V7 reserve final report');
  const { reportSha256, ...unsigned } = report;
  invariant(SHA256_RE.test(reportSha256 ?? '') && reportSha256 === canonicalJsonSha256(unsigned), 'V7 reserve final-report hash mismatch');
  invariant(typeof report.createdAt === 'string' && Number.isFinite(Date.parse(report.createdAt)) && /^r[1-9]\d*$/.test(report.revision ?? ''), 'V7 reserve final-report identity is invalid');
  invariant(report.matrix?.selectedHarnesses === 2 && report.matrix?.releaseClusters === 5 && report.matrix?.reserveClusters === 5 && report.matrix?.combinedClusters === 10 && report.matrix?.combinedRuns === 20, 'V7 reserve final-report matrix changed');
  assertExactKeys(report.matrix, ['selectedHarnesses', 'releaseClusters', 'reserveClusters', 'combinedClusters', 'combinedRuns'], 'V7 reserve final-report matrix');
  invariant(Array.isArray(report.standings) && report.standings.length === 2, 'V7 reserve final-report standings are incomplete');
  report.standings.forEach((standing) => assertExactKeys(standing, ['harnessId', 'meanCore'], 'V7 reserve final-report standing'));
  invariant(new Set(report.standings.map(({ harnessId }) => harnessId)).size === 2
    && report.standings.every(({ harnessId, meanCore }) => HARNESS_IDS.has(harnessId) && Number.isFinite(meanCore) && meanCore >= 0 && meanCore <= 100), 'V7 reserve final-report standings are invalid');
  assertExactKeys(report.comparison, [
    'leftHarnessId', 'rightHarnessId', 'meanDifference', 'confidenceInterval95', 'practicalMagnitude',
    'confidenceExcludesZero', 'winnerHarnessId', 'decision', 'bootstrap',
  ], 'V7 reserve final-report comparison');
  assertExactKeys(report.comparison.confidenceInterval95, ['low', 'high'], 'V7 reserve final-report confidence interval');
  assertExactKeys(report.comparison.bootstrap, ['method', 'clusterUnit', 'clusters', 'resamples', 'seed'], 'V7 reserve final-report bootstrap');
  assertExactKeys(report.saturationAudit, ['triggered', 'pauseRequired', 'reason'], 'V7 reserve final-report saturation audit');
  invariant(HARNESS_IDS.has(report.comparison.leftHarnessId)
    && HARNESS_IDS.has(report.comparison.rightHarnessId)
    && report.comparison.leftHarnessId !== report.comparison.rightHarnessId
    && Number.isFinite(report.comparison.meanDifference)
    && Number.isFinite(report.comparison.confidenceInterval95.low)
    && Number.isFinite(report.comparison.confidenceInterval95.high), 'V7 reserve final-report comparison values are invalid');
  invariant(report.comparison.bootstrap.method === 'paired-cluster-percentile'
    && report.comparison.bootstrap.clusterUnit === 'sealed-instance-pack'
    && Number.isSafeInteger(report.comparison.bootstrap.seed), 'V7 reserve final-report bootstrap identity changed');
  invariant((report.saturationAudit.triggered === true || report.saturationAudit.triggered === false)
    && report.saturationAudit.pauseRequired === report.saturationAudit.triggered
    && report.saturationAudit.reason === (report.saturationAudit.triggered ? 'core-100-saturation-audit' : null), 'V7 reserve final-report saturation audit is invalid');
  invariant(report.comparison?.bootstrap?.resamples === 10_000 && report.comparison?.bootstrap?.clusters === 10, 'V7 reserve final-report bootstrap policy changed');
  invariant(report.comparison?.practicalMagnitude === (Math.abs(report.comparison.meanDifference) >= 5), 'V7 reserve final-report practical threshold changed');
  invariant(report.comparison?.confidenceExcludesZero === (report.comparison.confidenceInterval95.low > 0 || report.comparison.confidenceInterval95.high < 0), 'V7 reserve final-report confidence decision changed');
  const expectedWinner = report.comparison.practicalMagnitude && report.comparison.confidenceExcludesZero
    ? (report.comparison.meanDifference > 0 ? report.comparison.leftHarnessId : report.comparison.rightHarnessId) : null;
  invariant(report.comparison.winnerHarnessId === expectedWinner && report.comparison.decision === (expectedWinner ? 'practical-win' : 'tie'), 'V7 reserve final-report paired decision changed');
  assertExactKeys(report.sourceCommitments, [
    'releaseChallengeSha256', 'releaseScheduleSha256', 'releaseResultSetSha256', 'releaseOfficialEvidenceSha256',
    'reserveChallengeSha256', 'reserveScheduleSha256', 'reserveResultSetSha256',
    'reserveTaskBindingSha256', 'reserveControlSha256',
  ], 'V7 reserve final-report source commitments');
  invariant(Object.values(report.sourceCommitments).every((digest) => SHA256_RE.test(digest ?? '')), 'V7 reserve final-report source commitments are incomplete');
  assertExactKeys(report.operational, ['release', 'reserve', 'combined'], 'V7 reserve final-report operational pools');
  for (const [pool, expectedRuns] of [['release', 25], ['reserve', 10], ['combined', 35]]) {
    const aggregate = report.operational[pool];
    assertExactKeys(aggregate, ['runs', 'wallTimeMs', 'tokens', 'timeouts', 'blockedAttempts', 'cost', 'infrastructureValidity'], `V7 reserve final-report ${pool} operational aggregate`);
    assertExactKeys(aggregate.tokens, ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens', 'totalTokens'], `V7 reserve final-report ${pool} tokens`);
    assertExactKeys(aggregate.cost, ['status', 'reportedUsd', 'reportedRuns', 'totalRuns'], `V7 reserve final-report ${pool} cost`);
    assertExactKeys(aggregate.infrastructureValidity, ['expectedRuns', 'validRuns', 'invalidRuns', 'missingRuns'], `V7 reserve final-report ${pool} infrastructure validity`);
    invariant(aggregate.runs === expectedRuns
      && aggregate.infrastructureValidity.expectedRuns === expectedRuns
      && aggregate.infrastructureValidity.validRuns === expectedRuns
      && aggregate.infrastructureValidity.invalidRuns === 0
      && aggregate.infrastructureValidity.missingRuns === 0,
    `V7 reserve final-report ${pool} operational coverage is incomplete`);
    invariant([aggregate.wallTimeMs, aggregate.timeouts, aggregate.blockedAttempts, aggregate.cost.reportedUsd, aggregate.cost.reportedRuns, aggregate.cost.totalRuns, ...Object.values(aggregate.tokens)]
      .every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0), `V7 reserve final-report ${pool} operational values are invalid`);
  }
  assertExactKeys(report.privacy, ['aggregatesOnly', 'modelTextIncluded', 'promptsIncluded', 'sessionsIncluded', 'commandsIncluded'], 'V7 reserve final-report privacy');
  invariant(report.privacy.aggregatesOnly === true && report.privacy.modelTextIncluded === false && report.privacy.promptsIncluded === false && report.privacy.sessionsIncluded === false && report.privacy.commandsIncluded === false, 'V7 reserve final-report privacy policy changed');
  invariant(report.decision === (report.saturationAudit?.triggered ? 'pause-for-saturation-audit' : report.comparison.decision), 'V7 reserve final-report saturation decision changed');
  invariant(report.winnerHarnessId === (report.saturationAudit?.triggered ? null : expectedWinner), 'V7 reserve final-report winner projection changed');
  assertNoLeakageKeys(report);
  return report;
}

export async function writeTerminalV7ReserveFinalReport({ resultRoot, report } = {}) {
  const destination = safeAbsolute(resultRoot, 'V7 reserve report root');
  validateTerminalV7ReserveFinalReport(report);
  await atomicWriteJson(path.join(destination, 'final-report.json'), report);
  return report;
}
