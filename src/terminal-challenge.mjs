import { canonicalJsonSha256 } from './provenance.mjs';

export const TERMINAL_CHALLENGE_SCHEMA = 'agentbattler.terminal-challenge.v1';
export const TERMINAL_RUN_SCHEMA = 'agentbattler.terminal-run.v1';
export const TERMINAL_SCHEDULE_SCHEMA = 'agentbattler.terminal-schedule.v1';
export const TERMINAL_COMBO_SCHEMA = 'agentbattler.terminal-combo.v1';

const DEFAULT_STAGES = Object.freeze([
  ['append-get', 'Append and get records'],
  ['query', 'Deterministic filtered query'],
  ['export', 'Export the complete ledger'],
  ['import', 'Import and round-trip verification'],
  ['recovery', 'Atomic restart recovery'],
  ['compatibility', 'Malformed input and schema compatibility'],
  ['audit', 'Full contract audit and repair'],
  ['performance', 'Final performance and audit pass'],
].map(([id, title], index) => Object.freeze({ id, order: index + 1, title, points: 10 })));

export const MINI_LEDGER_V3_STAGES = Object.freeze([
  ['foundation', 'Append/get foundation', 6],
  ['batch', 'Atomic batches and idempotency', 6],
  ['pagination', 'Deterministic pagination', 6],
  ['migration', 'Legacy schema migration', 6],
  ['atomicity', 'Crash-safe writes', 6],
  ['recovery', 'Interrupted-write recovery', 6],
  ['concurrency', 'Multi-process concurrency', 6],
  ['compaction', 'Checksummed compaction', 6],
  ['roundtrip', 'Export/import round trip', 6],
  ['replay', 'Replay and integrity', 6],
  ['audit', 'Full regression audit', 10],
  ['scale', 'Scale and performance', 10],
].map(([id, title, points], index) => Object.freeze({ id, order: index + 1, title, points })));

export const MINI_LEDGER_V4_STAGES = Object.freeze([
  ['foundation', 'Append/get foundation', 3],
  ['batch', 'Atomic batches and idempotency', 3],
  ['pagination', 'Deterministic pagination', 3],
  ['migration', 'Legacy schema migration', 3],
  ['atomicity', 'Crash-safe writes', 3],
  ['recovery', 'Interrupted-write recovery', 3],
  ['concurrency', 'Multi-process concurrency', 3],
  ['compaction', 'Checksummed compaction', 3],
  ['roundtrip', 'Export/import round trip', 3],
  ['replay', 'Replay and integrity', 3],
  ['audit', 'Full regression audit', 5],
  ['scale', 'Scale and performance', 5],
  ['stress-concurrency', 'Adversarial concurrent batches', 10],
  ['validation', 'Fault injection and validation', 10],
  ['scale-stress', 'Large integrated stress run', 10],
].map(([id, title, points], index) => Object.freeze({ id, order: index + 1, title, points })));

export const MINI_LEDGER_STAGE_IDS = Object.freeze(DEFAULT_STAGES.map((stage) => stage.id));

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function seal(prefix, descriptor) {
  const hash = canonicalJsonSha256(descriptor);
  return { ...descriptor, [`${prefix}Sha256`]: hash, [`${prefix}Id`]: `${prefix}-${hash.slice(0, 16)}` };
}

function nonEmpty(value, label) {
  invariant(typeof value === 'string' && value.length > 0, `${label} is required`);
  return value;
}

export function createMiniLedgerChallenge({
  challengeId = 'terminal-mini-ledger-v1',
  title = 'Mini Ledger v1',
  promptPath = 'benchmark/challenges/mini-ledger-v1.md',
  promptSha256,
  publicVerifierPath = 'benchmark/challenges/mini-ledger-v1/public-verifier.mjs',
  publicVerifierSha256,
  holdoutVerifierPath = 'benchmark/challenges/mini-ledger-v1/holdout-verifier.mjs',
  holdoutVerifierSha256,
  maxWallTimeMs = 20 * 60 * 1000,
  stages = DEFAULT_STAGES,
  turns = stages.length,
  holdoutCases = 5,
  scoring = null,
} = {}) {
  nonEmpty(promptSha256, 'promptSha256');
  nonEmpty(publicVerifierSha256, 'publicVerifierSha256');
  nonEmpty(holdoutVerifierSha256, 'holdoutVerifierSha256');
  invariant(maxWallTimeMs === null || (Number.isSafeInteger(maxWallTimeMs) && maxWallTimeMs > 0), 'maxWallTimeMs must be null or a positive integer');
  invariant(Array.isArray(stages) && stages.length > 0, 'stages are required');
  const normalizedStages = stages.map((stage, index) => Object.freeze({
    id: nonEmpty(stage.id, `stage[${index}].id`),
    order: index + 1,
    title: nonEmpty(stage.title, `stage[${index}].title`),
    points: stage.points,
  }));
  invariant(normalizedStages.every((stage) => Number.isSafeInteger(stage.points) && stage.points > 0), 'stage points must be positive integers');
  invariant(Number.isSafeInteger(turns) && turns >= normalizedStages.length, 'turns must cover all stages');
  invariant(Number.isSafeInteger(holdoutCases) && holdoutCases > 0, 'holdoutCases must be positive');
  const visibleStagePoints = normalizedStages.reduce((total, stage) => total + stage.points, 0);
  const score = scoring ?? {
    visibleStagePoints,
    holdoutPoints: 20,
    maxPoints: visibleStagePoints + 20,
    tieTolerancePoints: 1,
    regressionPenalty: 0,
    infrastructureInvalid: true,
  };
  invariant(score.visibleStagePoints === visibleStagePoints, 'visibleStagePoints must equal stage points');
  invariant(score.visibleStagePoints + score.holdoutPoints === score.maxPoints, 'terminal scoring must sum to maxPoints');
  return seal('challenge', {
    schemaVersion: TERMINAL_CHALLENGE_SCHEMA,
    kind: 'long-horizon-terminal-task',
    id: challengeId,
    title,
    prompt: { path: promptPath, sha256: promptSha256 },
    verifiers: {
      public: { path: publicVerifierPath, sha256: publicVerifierSha256 },
      holdout: { path: holdoutVerifierPath, sha256: holdoutVerifierSha256, cases: holdoutCases },
    },
    protocol: {
      turns,
      sameWorkspace: true,
      sameSession: true,
      maxWallTimeMs,
      maxWorkspaceBytes: 50 * 1024 * 1024,
      network: 'disabled',
      humanIntervention: 'invalidates-run',
    },
    stages: normalizedStages,
    scoring: score,
    fairness: {
      exhaustiveMatrixRequired: true,
      generationIndexIsArtifact: true,
      comparableFields: ['promptSha256', 'verifiers', 'protocol', 'reasoningEffort', 'generationSettings'],
      publish: ['challenge', 'schedule', 'manifests', 'run-results', 'pairwise-comparisons', 'checksums'],
      redact: ['credentials', 'hostPaths', 'privateTraces', 'unrelatedFiles'],
    },
  });
}

export function validateMiniLedgerChallenge(challenge) {
  invariant(challenge?.schemaVersion === TERMINAL_CHALLENGE_SCHEMA, 'Unsupported terminal challenge schema');
  const { challengeId, challengeSha256, ...descriptor } = challenge;
  const actual = canonicalJsonSha256(descriptor);
  invariant(challengeSha256 === actual, 'Terminal challenge hash mismatch');
  invariant(challengeId === `challenge-${actual.slice(0, 16)}`, 'Terminal challenge ID mismatch');
  invariant(/^terminal-mini-ledger-v\d+$/.test(challenge.id), 'Unexpected terminal challenge ID');
  invariant(challenge.stages.length > 0, 'Terminal challenge stage count is invalid');
  invariant(challenge.stages.every((stage, index) => stage.order === index + 1 && Number.isSafeInteger(stage.points) && stage.points > 0), 'Terminal challenge stage metadata changed');
  invariant(challenge.protocol.turns >= challenge.stages.length, 'Terminal challenge turns do not cover stages');
  invariant(challenge.scoring.visibleStagePoints === challenge.stages.reduce((total, stage) => total + stage.points, 0), 'Terminal challenge visible scoring mismatch');
  invariant(Number.isSafeInteger(challenge.verifiers.holdout.cases) && challenge.verifiers.holdout.cases > 0, 'Terminal holdout case count is invalid');
  return challenge;
}

export const validateTerminalChallenge = validateMiniLedgerChallenge;

export function terminalComboForAgent(agent, challenge) {
  validateMiniLedgerChallenge(challenge);
  const provenance = agent?.provenance ?? agent;
  invariant(provenance && typeof provenance === 'object', 'Agent provenance is required');
  const descriptor = {
    schemaVersion: TERMINAL_COMBO_SCHEMA,
    challengeId: challenge.challengeId,
    harness: {
      id: nonEmpty(provenance.harness, 'harness'),
      version: nonEmpty(provenance.harnessVersion, 'harnessVersion'),
    },
    model: {
      id: nonEmpty(provenance.modelRequested ?? provenance.modelFamilyId, 'model'),
      familyId: nonEmpty(provenance.modelFamilyId ?? provenance.modelRequested, 'modelFamilyId'),
      reasoningEffort: provenance.reasoningEffort ?? null,
    },
    generationSettings: provenance.generationSettings ?? {},
  };
  return seal('combo', descriptor);
}

function sortedAgents(agents) {
  return [...agents].sort((left, right) => (
    (left.provenance?.harness ?? '').localeCompare(right.provenance?.harness ?? '')
    || (left.provenance?.modelRequested ?? '').localeCompare(right.provenance?.modelRequested ?? '')
    || ((left.generationIndex ?? left.provenance?.generationIndex ?? 0) - (right.generationIndex ?? right.provenance?.generationIndex ?? 0))
    || left.id.localeCompare(right.id)
  ));
}

export function createExhaustiveTerminalSchedule({
  challenge,
  agents,
  expectedHarnesses,
  expectedModels,
  generationsPerCombo,
  repeats = 1,
  seed = 1,
}) {
  validateMiniLedgerChallenge(challenge);
  invariant(Array.isArray(agents) && agents.length > 0, 'Terminal schedule requires agents');
  invariant(Array.isArray(expectedHarnesses) && expectedHarnesses.length > 0, 'Expected harnesses are required');
  invariant(Array.isArray(expectedModels) && expectedModels.length > 0, 'Expected models are required');
  invariant(Number.isSafeInteger(generationsPerCombo) && generationsPerCombo > 0, 'generationsPerCombo must be positive');
  invariant(Number.isSafeInteger(repeats) && repeats > 0, 'repeats must be positive');
  const groups = new Map();
  for (const agent of sortedAgents(agents)) {
    invariant(typeof agent.id === 'string' && agent.id.length > 0, 'Every terminal agent needs an ID');
    const combo = terminalComboForAgent(agent, challenge);
    const bucket = groups.get(combo.comboId) ?? { combo, agents: [] };
    bucket.agents.push({ id: agent.id, generationIndex: agent.generationIndex ?? agent.provenance?.generationIndex ?? null });
    groups.set(combo.comboId, bucket);
  }
  const expected = new Set(expectedHarnesses.flatMap((harness) => expectedModels.map((model) => `${harness}\u0000${model}`)));
  const actual = new Set([...groups.values()].map(({ combo }) => `${combo.harness.id}\u0000${combo.model.id}`));
  invariant(actual.size === expected.size && [...expected].every((key) => actual.has(key)), `Terminal schedule combo matrix mismatch: expected ${[...expected].sort().join(', ')}, got ${[...actual].sort().join(', ')}`);
  for (const group of groups.values()) invariant(group.agents.length === generationsPerCombo, `Combo ${group.combo.comboId} has ${group.agents.length} generations; expected ${generationsPerCombo}`);

  const jobs = [];
  for (const { combo, agents: comboAgents } of [...groups.values()].sort((left, right) => left.combo.comboId.localeCompare(right.combo.comboId))) {
    for (const artifact of comboAgents) {
      for (let repeat = 1; repeat <= repeats; repeat += 1) {
        const descriptor = {
          schemaVersion: TERMINAL_RUN_SCHEMA,
          challengeId: challenge.challengeId,
          challengeSha256: challenge.challengeSha256,
          comboId: combo.comboId,
          artifactId: artifact.id,
          generationIndex: artifact.generationIndex,
          repeat,
          seed,
        };
        jobs.push({ runKey: canonicalJsonSha256(descriptor), ...descriptor });
      }
    }
  }
  return seal('schedule', {
    schemaVersion: TERMINAL_SCHEDULE_SCHEMA,
    kind: 'exhaustive-terminal-combo-schedule',
    challenge: { id: challenge.challengeId, sha256: challenge.challengeSha256 },
    matrix: {
      harnesses: [...expectedHarnesses].sort(),
      models: [...expectedModels].sort(),
      generationsPerCombo,
      repeats,
      seeds: [seed],
      expectedRuns: expected.size * generationsPerCombo * repeats,
    },
    coverage: [...groups.values()]
      .sort((left, right) => left.combo.comboId.localeCompare(right.combo.comboId))
      .map(({ combo, agents: comboAgents }) => ({
        combo,
        artifacts: comboAgents.map((artifact) => ({ ...artifact })),
      })),
    jobs,
  });
}

export function validateTerminalSchedule(schedule, challenge) {
  validateMiniLedgerChallenge(challenge);
  invariant(schedule?.schemaVersion === TERMINAL_SCHEDULE_SCHEMA, 'Unsupported terminal schedule schema');
  const { scheduleId, scheduleSha256, ...unsigned } = schedule;
  const actual = canonicalJsonSha256(unsigned);
  invariant(scheduleSha256 === actual, 'Terminal schedule hash mismatch');
  invariant(scheduleId === `schedule-${actual.slice(0, 16)}`, 'Terminal schedule ID mismatch');
  invariant(schedule.challenge?.id === challenge.challengeId && schedule.challenge?.sha256 === challenge.challengeSha256, 'Schedule challenge mismatch');
  const keys = new Set();
  for (const job of schedule.jobs) {
    invariant(!keys.has(job.runKey), `Duplicate terminal run: ${job.runKey}`);
    keys.add(job.runKey);
    const { runKey, ...descriptor } = job;
    invariant(runKey === canonicalJsonSha256(descriptor), `Terminal run key mismatch: ${runKey}`);
  }
  invariant(schedule.jobs.length === schedule.matrix.expectedRuns, 'Terminal schedule run count mismatch');
  return schedule;
}

export function scoreTerminalRun(run, challenge) {
  validateMiniLedgerChallenge(challenge);
  invariant(run?.schemaVersion === TERMINAL_RUN_SCHEMA, 'Unsupported terminal run schema');
  invariant(run.challengeId === challenge.challengeId && run.challengeSha256 === challenge.challengeSha256, 'Terminal run challenge mismatch');
  invariant(run.status === 'completed', 'Only completed terminal runs receive a score');
  invariant(Array.isArray(run.stages), 'Terminal run stages are required');
  // Accept the original adapter spelling for already-completed v1 runs while
  // emitting the canonical `id` field for all new runs.
  const stageMap = new Map(run.stages.map((stage) => [stage.id ?? stage.stageId, stage]));
  invariant(stageMap.size === challenge.stages.length, 'Terminal run stage count mismatch');
  for (const stage of challenge.stages) invariant(stageMap.has(stage.id), `Missing terminal stage ${stage.id}`);
  const visiblePoints = challenge.stages.reduce((total, stage) => total + (stageMap.get(stage.id).passed === true ? stage.points : 0), 0);
  const holdout = run.holdout ?? {};
  invariant(Number.isSafeInteger(holdout.passed) && Number.isSafeInteger(holdout.total) && holdout.total === challenge.verifiers.holdout.cases, 'Terminal holdout result is invalid');
  invariant(holdout.passed >= 0 && holdout.passed <= holdout.total, 'Terminal holdout passed count is invalid');
  const holdoutPoints = (holdout.passed / holdout.total) * challenge.scoring.holdoutPoints;
  const regressions = run.stages.reduce((total, stage) => total + (Number.isSafeInteger(stage.regressions) ? stage.regressions : 0), 0);
  const scorePoints = visiblePoints + holdoutPoints;
  return {
    maxPoints: challenge.scoring.maxPoints,
    visiblePoints,
    holdoutPoints,
    scorePoints,
    scorePct: Math.round((scorePoints / challenge.scoring.maxPoints) * 10_000) / 100,
    passedStages: challenge.stages.filter((stage) => stageMap.get(stage.id).passed === true).length,
    totalStages: challenge.stages.length,
    holdoutPassed: holdout.passed,
    holdoutTotal: holdout.total,
    regressions,
  };
}

export function compareTerminalScores(left, right, tieTolerancePoints = 1) {
  const difference = left.scorePoints - right.scorePoints;
  if (Math.abs(difference) <= tieTolerancePoints) return 0.5;
  return difference > 0 ? 1 : 0;
}

export function computeTerminalElo(runs, { initialRating = 1500, kFactor = 32, tieTolerancePoints = 1 } = {}) {
  invariant(Array.isArray(runs) && runs.length > 0, 'Terminal Elo requires runs');
  const ordered = [...runs].sort((left, right) => left.runKey.localeCompare(right.runKey));
  const ratings = new Map(ordered.map((run) => [run.runKey, initialRating]));
  const comparisons = [];
  for (let leftIndex = 0; leftIndex < ordered.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < ordered.length; rightIndex += 1) {
      const left = ordered[leftIndex];
      const right = ordered[rightIndex];
      const leftRating = ratings.get(left.runKey);
      const rightRating = ratings.get(right.runKey);
      const expected = 1 / (1 + (10 ** ((rightRating - leftRating) / 400)));
      const actual = compareTerminalScores(left.score, right.score, tieTolerancePoints);
      const delta = kFactor * (actual - expected);
      ratings.set(left.runKey, leftRating + delta);
      ratings.set(right.runKey, rightRating - delta);
      comparisons.push({ leftRunKey: left.runKey, rightRunKey: right.runKey, leftScore: left.score.scorePoints, rightScore: right.score.scorePoints, result: actual, delta });
    }
  }
  return {
    method: 'pairwise-score-elo',
    initialRating,
    kFactor,
    tieTolerancePoints,
    comparisons,
    standings: ordered.map((run) => ({ runKey: run.runKey, comboId: run.comboId ?? null, scorePoints: run.score.scorePoints, rating: Math.round((ratings.get(run.runKey) ?? initialRating) * 100) / 100 }))
      .sort((left, right) => right.rating - left.rating || right.scorePoints - left.scorePoints || left.runKey.localeCompare(right.runKey))
      .map((row, index) => ({ rank: index + 1, ...row })),
  };
}
