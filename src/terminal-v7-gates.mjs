import { canonicalJsonSha256 } from './provenance.mjs';

export const TERMINAL_V7_GATE_SCHEMA = 'agentbattler.terminal-v7-release-gates.v1';
export const TERMINAL_V7_REVIEW_TOPICS = Object.freeze([
  'solvability',
  'prompt-verifier-correspondence',
  'alternate-solutions',
  'decoy-falsifiability',
  'infrastructure-cleanliness',
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function countByPool(packSeals) {
  const counts = new Map();
  for (const pack of packSeals) counts.set(pack.pool, (counts.get(pack.pool) ?? 0) + 1);
  return counts;
}

function check(condition, id, diagnostic, failures) {
  if (!condition) failures.push({ id, diagnostic });
}

export function evaluateTerminalV7ReleaseGates(evidence) {
  invariant(evidence && typeof evidence === 'object' && !Array.isArray(evidence), 'V7 release-gate evidence is required');
  const failures = [];
  const packSeals = Array.isArray(evidence.packSeals) ? evidence.packSeals : [];
  const counts = countByPool(packSeals);
  check(counts.get('dev') === 3 && counts.get('release') === 5 && counts.get('reserve') === 5, 'PACK-POOLS', 'Expected three development, five release, and five reserve pack seals.', failures);
  check(new Set(packSeals.map(({ instanceId }) => instanceId)).size === 13, 'PACK-NAMESPACES', 'Pack instance IDs must be unique across disjoint pools.', failures);
  check(packSeals.every(({ sealSha256, sealedBeforePilot }) => /^[0-9a-f]{64}$/.test(sealSha256 ?? '') && sealedBeforePilot === true), 'PACK-PRECOMMIT', 'Every pack must be sealed before frontier pilot results exist.', failures);

  const gold = evidence.gold ?? {};
  check(gold.independentImplementations === 2, 'GOLD-INDEPENDENCE', 'Exactly two independently written gold implementations are required.', failures);
  check(gold.verifierSeeds === 100 && gold.cleanMinCore === 100 && gold.decoyMinCore === 100, 'GOLD-CORRECTNESS', 'Both gold implementations must score 100 on clean and decoy twins across 100 verifier seeds.', failures);

  const flake = evidence.flake ?? {};
  check(flake.executionsPerFamily === 100 && flake.failures === 0, 'VERIFIER-FLAKES', 'Each capability family requires 100 repeated executions with zero flakes.', failures);

  const mutation = evidence.mutation ?? {};
  check(Number(mutation.killRate) >= 0.95, 'MUTATION-RATE', 'Mutation kill rate must be at least 95%.', failures);
  check(Array.isArray(mutation.criticalSurvivors) && mutation.criticalSurvivors.length === 0, 'MUTATION-CRITICAL', 'No critical data-loss, shortcut, test-tampering, or decoy-following mutant may survive.', failures);
  check(mutation.semanticAlternatesPassed === true, 'MUTATION-ALTERNATES', 'Semantics-preserving alternate implementations must pass.', failures);

  const map = evidence.requirementMap ?? {};
  check(map.scoredAssertionsMapped === true && map.normativeClausesVerified === true && Number(map.unmappedAssertions ?? 1) === 0 && Number(map.unverifiedClauses ?? 1) === 0, 'REQUIREMENT-MAP', 'Every scored assertion and normative contract clause must be mapped bidirectionally.', failures);

  const reviews = Array.isArray(evidence.reviews) ? evidence.reviews : [];
  const independentReviewers = new Set(reviews.filter(({ approved }) => approved === true).map(({ reviewerId }) => reviewerId));
  check(independentReviewers.size >= 3, 'REVIEWS-INDEPENDENT', 'Three independent approving reviews are required.', failures);
  for (const topic of TERMINAL_V7_REVIEW_TOPICS) {
    check(reviews.filter(({ approved, topics }) => approved === true && topics?.includes(topic)).length >= 3, `REVIEWS-${topic.toUpperCase()}`, `All three independent reviews must cover ${topic}.`, failures);
  }

  const tests = evidence.tests ?? {};
  check(tests.existing === true && tests.v7 === true && tests.m4Preflights === 5 && tests.failures === 0, 'TESTS', 'All existing and V7 tests plus five exact-policy M4 harness preflights must pass.', failures);

  const pilot = evidence.pilot ?? {};
  check(pilot.lunaMaxJobs === 12 && pilot.lunaHighJobs === 3, 'PILOT-MATRIX', 'Pilot evidence must contain 12 Luna/max twin jobs and three Luna/high anchors.', failures);
  check(Number(pilot.lunaMaxDecoyMedian) >= 50 && Number(pilot.lunaMaxDecoyMedian) <= 75, 'PILOT-MEDIAN', 'Luna/max decoy Core median must be between 50 and 75.', failures);
  check(Number(pilot.maximumCore) <= 95, 'PILOT-SATURATION', 'No pilot run may exceed 95 Core.', failures);
  check(Number(pilot.exactCompletions) <= 1, 'PILOT-EXACT', 'At most one of the six Luna/max decoy runs may reach Exact.', failures);
  check(Number(pilot.lunaMaxMinusHigh) >= 10, 'PILOT-ANCHOR', 'Luna/high must trail Luna/max by at least ten Core points.', failures);
  check(Number(pilot.scriptedTwinDifference) === 0, 'PILOT-SCRIPTED-TWINS', 'Scripted references must have zero clean/decoy difference.', failures);
  check(Math.abs(Number(pilot.humanTwinDifference)) < 5, 'PILOT-HUMAN-TWINS', 'Human validation clean/decoy difference must be under five points.', failures);
  check(Number(pilot.infrastructureInvalid) === 0, 'PILOT-INFRASTRUCTURE', 'The pilot may not contain an infrastructure-invalid run.', failures);

  const unsigned = {
    schemaVersion: TERMINAL_V7_GATE_SCHEMA,
    revision: evidence.revision ?? null,
    evaluatedAt: evidence.evaluatedAt ?? null,
    evidenceSha256: canonicalJsonSha256(evidence),
    releaseEvidenceSha256: evidence.releaseEvidenceSha256 ?? null,
    reviewedCommit: evidence.reviewedCommit ?? null,
    baseEvidenceSha256: evidence.baseEvidence?.baseEvidenceSha256 ?? evidence.baseEvidenceSha256 ?? null,
    pilotReportSha256: evidence.pilot?.pilotReportSha256 ?? null,
    passed: failures.length === 0,
    failures,
  };
  return { ...unsigned, gateSha256: canonicalJsonSha256(unsigned) };
}

export function assertTerminalV7ReleaseGates(evidence) {
  const result = evaluateTerminalV7ReleaseGates(evidence);
  invariant(result.passed, `V7 release gates failed: ${result.failures.map(({ id }) => id).join(', ')}`);
  return result;
}

export function evaluateTerminalV7BaseGates(evidence) {
  const pilot = {
    lunaMaxJobs: 12,
    lunaHighJobs: 3,
    lunaMaxDecoyMedian: 60,
    maximumCore: 95,
    exactCompletions: 0,
    lunaMaxMinusHigh: 10,
    scriptedTwinDifference: 0,
    humanTwinDifference: 0,
    infrastructureInvalid: 0,
  };
  const evaluated = evaluateTerminalV7ReleaseGates({ ...evidence, pilot });
  const unsigned = {
    schemaVersion: 'agentbattler.terminal-v7-base-gates.v1',
    revision: evidence.revision ?? null,
    reviewedCommit: evidence.reviewedCommit ?? null,
    baseEvidenceSha256: evidence.baseEvidenceSha256 ?? null,
    passed: evaluated.passed,
    failures: evaluated.failures,
  };
  return { ...unsigned, gateSha256: canonicalJsonSha256(unsigned) };
}

export function assertTerminalV7BaseGates(evidence) {
  const result = evaluateTerminalV7BaseGates(evidence);
  invariant(result.passed, `V7 base gates failed: ${result.failures.map(({ id }) => id).join(', ')}`);
  return result;
}

export function terminalV7SaturationAction(completedRuns) {
  invariant(Array.isArray(completedRuns), 'V7 completed runs must be an array');
  const saturated = completedRuns.find((run) => Number(run.score?.core?.points ?? run.score?.corePoints) === 100);
  return saturated
    ? { pauseAtNextSafeBoundary: true, reason: 'core-100-saturation-audit', runKey: saturated.runKey }
    : { pauseAtNextSafeBoundary: false, reason: null, runKey: null };
}

export function terminalV7RetirementAction({
  privatePackLeakage = false,
  frontierSystems = [],
} = {}) {
  invariant(typeof privatePackLeakage === 'boolean', 'V7 private-pack leakage flag must be boolean');
  invariant(Array.isArray(frontierSystems), 'V7 frontier-system retirement evidence must be an array');
  const systems = frontierSystems.map((system) => {
    invariant(typeof system?.systemId === 'string' && system.systemId.length > 0, 'V7 frontier retirement system ID is required');
    invariant(/^[0-9a-f]{64}$/.test(system.independenceKeySha256 ?? ''), `V7 ${system.systemId} independence binding is invalid`);
    invariant(Number.isFinite(system.meanCore) && system.meanCore >= 0 && system.meanCore <= 100, `V7 ${system.systemId} mean Core is invalid`);
    invariant(Number.isFinite(system.lowerConfidenceBound) && system.lowerConfidenceBound >= 0 && system.lowerConfidenceBound <= 100, `V7 ${system.systemId} lower confidence bound is invalid`);
    return system;
  });
  invariant(new Set(systems.map(({ systemId }) => systemId)).size === systems.length, 'V7 frontier retirement system IDs must be unique');
  invariant(new Set(systems.map(({ independenceKeySha256 }) => independenceKeySha256)).size === systems.length, 'V7 frontier retirement systems must be independently bound model families');
  if (privatePackLeakage) {
    return { retire: true, reason: 'private-pack-leakage', qualifyingSystems: [] };
  }
  const qualifyingSystems = systems
    .filter(({ meanCore, lowerConfidenceBound }) => meanCore > 85 && lowerConfidenceBound > 80)
    .map(({ systemId }) => systemId)
    .sort();
  return qualifyingSystems.length >= 2
    ? { retire: true, reason: 'frontier-saturation', qualifyingSystems }
    : { retire: false, reason: null, qualifyingSystems };
}
