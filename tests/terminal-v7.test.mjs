import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { canonicalJsonSha256 } from '../src/provenance.mjs';

import {
  analyzeTerminalV7PairedPacks,
  createTerminalV7Challenge,
  createTerminalV7InstanceDescriptor,
  createTerminalV7InstanceDescriptorFromPack,
  createTerminalV7Schedule,
  MINI_LEDGER_V7_FAMILIES,
  MINI_LEDGER_V7_INSTANCE_VARIANTS,
  MINI_LEDGER_V7_INSTANCES,
  MINI_LEDGER_V7_PHASE_IDS,
  scoreTerminalV7Run,
  TERMINAL_V7_BOOTSTRAP_RESAMPLES,
  TERMINAL_V7_RUN_SCHEMA,
  TERMINAL_V7_SEALED_PACK_SCHEMA,
  validateTerminalV7Challenge,
  validateTerminalV7InstanceDescriptor,
  validateTerminalV7Schedule,
} from '../src/terminal-v7.mjs';

const HASHES = {
  promptSha256: 'a'.repeat(64),
  publicVerifierSha256: 'b'.repeat(64),
  hiddenVerifierSha256: 'c'.repeat(64),
  adaptabilityVerifierSha256: 'd'.repeat(64),
};

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function releasePack(ordinal) {
  const instanceId = `release-${String(ordinal).padStart(2, '0')}`;
  const phases = MINI_LEDGER_V7_PHASE_IDS.map((id, index) => ({
    phase: index + 1,
    id,
    ticketSha256: sha256(`${instanceId}:ticket:${index + 1}`),
    publicSmokeSha256: sha256(`${instanceId}:smoke:${index + 1}`),
    phaseDeltaSha256: sha256(`${instanceId}:delta:${index + 1}`),
  }));
  const commitments = {
    packSha256: sha256(`${instanceId}:pack`),
    starterTreeSha256: sha256(`${instanceId}:starter`),
    phaseDeltaSha256: phases.map(({ phaseDeltaSha256 }) => phaseDeltaSha256),
    requirementsSha256: sha256('requirements'),
    requirementMapSha256: sha256('requirement-map'),
    perPhaseLimitMs: 1_500_000,
    artifactPolicy: {
      sourceAllowlist: ['package.json', 'bin/**', 'src/**', 'config/**'],
      declaredResponseAllowlist: ['incident-response.json'],
      maxFiles: 256,
      maxBytes: 4 * 1024 * 1024,
      regularFilesOnly: true,
    },
    verifierHashes: {
      public: sha256('public-verifier'),
      private: sha256('private-verifier'),
      adaptability: sha256('adaptability-verifier'),
    },
    rubricVersion: 'mini-ledger-v7-r1',
    feedbackPolicy: 'self-service-public-only',
    twinRelationSha256: sha256(`${instanceId}:twins`),
    hiddenMerkleRoot: sha256(`${instanceId}:hidden`),
  };
  return {
    schemaVersion: TERMINAL_V7_SEALED_PACK_SCHEMA,
    challengeId: 'terminal-mini-ledger-v7',
    instanceId,
    pool: 'release',
    variant: 'decoy',
    twinVariant: 'clean',
    scenarioId: `${instanceId}-scenario`,
    seedFingerprint: sha256(`${instanceId}:seed`),
    requirementsSha256: commitments.requirementsSha256,
    requirementMapSha256: commitments.requirementMapSha256,
    perPhaseLimitMs: commitments.perPhaseLimitMs,
    artifactPolicy: commitments.artifactPolicy,
    verifierHashes: commitments.verifierHashes,
    rubricVersion: commitments.rubricVersion,
    feedbackPolicy: commitments.feedbackPolicy,
    phases,
    phaseDeltaSha256: commitments.phaseDeltaSha256,
    twinRelationSha256: commitments.twinRelationSha256,
    hiddenMerkleRoot: commitments.hiddenMerkleRoot,
    hiddenCaseCount: 11,
    starterTreeSha256: commitments.starterTreeSha256,
    packSha256: commitments.packSha256,
    sealSha256: canonicalJsonSha256(commitments),
  };
}

const RELEASE_PACKS = [1, 2, 3, 4, 5].map(releasePack);

function challenge() {
  return createTerminalV7Challenge({ ...HASHES, instances: RELEASE_PACKS });
}

const HARNESSES = ['codex-cli', 'pi-coding-agent', 'factory-droid', 'dotagents-mono', 'claude-code']
  .map((id, index) => ({ id, version: `test-${index + 1}` }));

const MODEL = { id: 'gpt-5.6-luna', familyId: 'luna', reasoningEffort: 'max' };

test('V7 exports five independently sealed randomized instance descriptors', () => {
  assert.equal(MINI_LEDGER_V7_INSTANCES.length, 5);
  assert.deepEqual(new Set(MINI_LEDGER_V7_INSTANCES.map(({ ordinal }) => ordinal)), new Set([1, 2, 3, 4, 5]));
  assert.equal(new Set(MINI_LEDGER_V7_INSTANCES.map(({ instanceId }) => instanceId)).size, 5);
  assert.equal(new Set(MINI_LEDGER_V7_INSTANCES.map(({ generator }) => generator.seed)).size, 5);
  for (const instance of MINI_LEDGER_V7_INSTANCES) {
    assert.equal(validateTerminalV7InstanceDescriptor(instance), instance);
    assert.deepEqual(instance.phaseOrder, MINI_LEDGER_V7_PHASE_IDS);
    assert.equal(instance.disclosure, 'private-until-retirement');
    assert.deepEqual(instance.variants.release, MINI_LEDGER_V7_INSTANCE_VARIANTS.release);
    assert.deepEqual(instance.variants.cleanTwin, MINI_LEDGER_V7_INSTANCE_VARIANTS.cleanTwin);
  }

  const tampered = structuredClone(MINI_LEDGER_V7_INSTANCES[0]);
  tampered.generator.seed += 1;
  assert.throws(() => validateTerminalV7InstanceDescriptor(tampered), /hash mismatch/);
});

test('V7 instance commitments are hash-validated and covered by the instance seal', () => {
  const instance = createTerminalV7InstanceDescriptor({
    key: 'committed-pack',
    ordinal: 1,
    seed: 42,
    commitments: { publicFixture: 'e'.repeat(64), hiddenFixture: 'f'.repeat(64) },
  });
  assert.equal(validateTerminalV7InstanceDescriptor(instance), instance);
  assert.throws(() => createTerminalV7InstanceDescriptor({ key: 'bad', ordinal: 1, seed: 42, commitments: { hiddenFixture: 'not-a-hash' } }), /SHA-256/);
});

test('V7 adapts actual sealed release packs into challenge-bound instance descriptors', () => {
  const descriptor = createTerminalV7InstanceDescriptorFromPack(RELEASE_PACKS[0]);
  assert.equal(validateTerminalV7InstanceDescriptor(descriptor), descriptor);
  assert.equal(descriptor.instanceId, 'release-01');
  assert.equal(descriptor.packCommitments.packSha256, RELEASE_PACKS[0].packSha256);
  assert.equal(descriptor.packCommitments.seedFingerprint, RELEASE_PACKS[0].seedFingerprint);
  assert.equal(descriptor.packCommitments.starterTreeSha256, RELEASE_PACKS[0].starterTreeSha256);
  assert.deepEqual(descriptor.packCommitments.phases.map(({ ticketSha256 }) => ticketSha256), RELEASE_PACKS[0].phases.map(({ ticketSha256 }) => ticketSha256));
  assert.deepEqual(descriptor.packCommitments.phases.map(({ publicSmokeSha256 }) => publicSmokeSha256), RELEASE_PACKS[0].phases.map(({ publicSmokeSha256 }) => publicSmokeSha256));
  assert.equal(descriptor.packCommitments.hiddenMerkleRoot, RELEASE_PACKS[0].hiddenMerkleRoot);
  assert.equal(descriptor.packCommitments.requirementsSha256, RELEASE_PACKS[0].requirementsSha256);
  assert.equal(descriptor.packCommitments.requirementMapSha256, RELEASE_PACKS[0].requirementMapSha256);
  assert.deepEqual(descriptor.packCommitments.verifierHashes, RELEASE_PACKS[0].verifierHashes);
  assert.deepEqual(descriptor.packCommitments.artifactPolicy, RELEASE_PACKS[0].artifactPolicy);
  assert.equal(descriptor.packCommitments.twinRelationSha256, RELEASE_PACKS[0].twinRelationSha256);
});

test('V7 challenge seals private packs, progressive disclosure, red-herring constraints, and scoring', () => {
  const descriptor = challenge();
  assert.equal(validateTerminalV7Challenge(descriptor), descriptor);
  assert.equal(descriptor.instances.length, 5);
  assert.ok(descriptor.instances.every(({ source }) => source === 'sealed-release-pack'));
  assert.deepEqual(descriptor.instances.map(({ instanceId }) => instanceId), ['release-01', 'release-02', 'release-03', 'release-04', 'release-05']);
  assert.equal(descriptor.protocol.phases, 5);
  assert.equal(descriptor.protocol.turns, 5);
  assert.equal(descriptor.protocol.maxPhaseTimeMs, 1_500_000);
  assert.deepEqual(descriptor.phases, MINI_LEDGER_V7_PHASE_IDS);
  assert.deepEqual(descriptor.scoringFamilies, MINI_LEDGER_V7_FAMILIES);
  assert.equal(descriptor.protocol.futureRequirementsWithheldUntilTurn, true);
  assert.equal(descriptor.guidance.releaseVariant, 'decoy');
  assert.equal(descriptor.guidance.cleanTwinUsage, 'calibration-only');
  assert.equal(descriptor.guidance.releaseInstanceBytesIdenticalAcrossHarnesses, true);
  assert.equal(descriptor.guidance.authoritativeRequirementsRemainTrue, true);
  assert.equal(descriptor.guidance.falseInformationRestrictedToAuxiliaryEvidence, true);
  assert.deepEqual(descriptor.scoring.core, { publicPoints: 20, hiddenPoints: 80, maxPoints: 100 });
  assert.deepEqual(descriptor.scoring.adaptability, { minPoints: 0, maxPoints: 15, leaderboardAxis: 'separate' });
  assert.throws(() => createTerminalV7Challenge({ ...HASHES, instances: MINI_LEDGER_V7_INSTANCES }), /placeholders are calibration-only/);

  const tampered = structuredClone(descriptor);
  tampered.protocol.turns = 14;
  assert.throws(() => validateTerminalV7Challenge(tampered), /hash mismatch/);
});

test('V7 schedule precommits five balanced rounds of byte-identical decoy packs with V1 run records', () => {
  const descriptor = challenge();
  const schedule = createTerminalV7Schedule({ challenge: descriptor, harnesses: HARNESSES, model: MODEL, seed: 20260808 });
  assert.equal(validateTerminalV7Schedule(schedule, descriptor), schedule);
  assert.equal(schedule.jobs.length, 25);
  assert.equal(new Set(schedule.jobs.map(({ runKey }) => runKey)).size, 25);
  assert.ok(schedule.jobs.every(({ schemaVersion, instanceId }) => schemaVersion === TERMINAL_V7_RUN_SCHEMA && instanceId.startsWith('release-')));
  assert.ok(schedule.jobs.every(({ instanceVariant }) => instanceVariant === 'decoy'));
  assert.equal(schedule.matrix.cleanTwinIncluded, false);

  for (const harness of HARNESSES) {
    const jobs = schedule.jobs.filter((job) => job.harness.id === harness.id);
    assert.equal(jobs.length, 5);
    assert.equal(new Set(jobs.map(({ instanceId }) => instanceId)).size, 5);
  }
  for (const instance of descriptor.instances) {
    const jobs = schedule.jobs.filter((job) => job.instanceId === instance.instanceId);
    assert.equal(jobs.length, 5);
    assert.ok(jobs.every((job) => job.instanceSha256 === instance.instanceSha256
      && job.instanceVariant === 'decoy'
      && job.seed === instance.generator.seedFingerprint
      && job.seedFingerprint === instance.generator.seedFingerprint));
  }
  for (let round = 1; round <= 5; round += 1) {
    const jobs = schedule.jobs.filter((job) => job.round === round);
    assert.equal(jobs.length, 5);
    assert.equal(new Set(jobs.map((job) => job.harness.id)).size, 5);
    assert.equal(new Set(jobs.map((job) => job.instanceId)).size, 5);
    assert.deepEqual(schedule.executionOrder.rounds[round - 1].runKeys, jobs.map(({ runKey }) => runKey));
  }

  const reordered = createTerminalV7Schedule({ challenge: descriptor, harnesses: [...HARNESSES].reverse(), model: MODEL, seed: 20260808 });
  assert.deepEqual(reordered, schedule);
});

test('V7 schedule validation rejects job or Latin-square substitution', () => {
  const descriptor = challenge();
  const schedule = createTerminalV7Schedule({ challenge: descriptor, harnesses: HARNESSES, model: MODEL, seed: 9 });
  const tampered = structuredClone(schedule);
  tampered.jobs[0].instanceId = tampered.jobs.find((job) => job.instanceId !== tampered.jobs[0].instanceId).instanceId;
  assert.throws(() => validateTerminalV7Schedule(tampered, descriptor), /schedule hash mismatch/);
});

function completedRun(descriptor, evaluation) {
  const instance = descriptor.instances[0];
  return {
    schemaVersion: TERMINAL_V7_RUN_SCHEMA,
    challengeId: descriptor.challengeId,
    challengeSha256: descriptor.challengeSha256,
    instanceId: instance.instanceId,
    instanceSha256: instance.instanceSha256,
    status: 'completed',
    evaluation,
  };
}

function evaluationByFamily({ publicPassed, hiddenAtomicPassed, hiddenComposedPassed }, adaptability) {
  return {
    families: MINI_LEDGER_V7_FAMILIES.map((id) => ({
      id,
      public: { passed: publicPassed, total: 4 },
      hiddenAtomic: { passed: hiddenAtomicPassed, total: 6 },
      hiddenComposed: { passed: hiddenComposedPassed, total: 10 },
      hidden: { passed: hiddenAtomicPassed + hiddenComposedPassed, total: 16 },
    })),
    adaptability,
  };
}

test('V7 scoring reports Core 20+80, Exact, Adaptability 0-15, and proxy gap', () => {
  const descriptor = challenge();
  const score = scoreTerminalV7Run(completedRun(descriptor, evaluationByFamily({
    publicPassed: 2,
    hiddenAtomicPassed: 3,
    hiddenComposedPassed: 8,
  },
    { passed: 1, total: 3 },
  )), descriptor);
  assert.equal(score.core.public.points, 10);
  assert.equal(score.core.hiddenAtomic.points, 15);
  assert.equal(score.core.hiddenComposed.points, 40);
  assert.equal(score.core.hidden.points, 55);
  assert.equal(score.core.points, 65);
  assert.equal(score.core.maxPoints, 100);
  assert.equal(score.exact, false);
  assert.equal(score.adaptability.points, 5);
  assert.equal(score.adaptability.maxPoints, 15);
  assert.equal(score.proxyGap, -30);
  assert.deepEqual(score.core.families.map(({ id }) => id), MINI_LEDGER_V7_FAMILIES);
  assert.ok(score.core.families.every((family) => family.points === 13 && family.maxPoints === 20));

  const exact = scoreTerminalV7Run(completedRun(descriptor, evaluationByFamily({
    publicPassed: 4,
    hiddenAtomicPassed: 6,
    hiddenComposedPassed: 10,
  },
    { passed: 15, total: 15 },
  )), descriptor);
  assert.equal(exact.core.points, 100);
  assert.equal(exact.exact, true);
  assert.equal(exact.adaptability.points, 15);
  assert.equal(exact.proxyGap, 0);
});

test('V7 scoring fails closed on invalid counts and mismatched pack identity', () => {
  const descriptor = challenge();
  const evaluation = evaluationByFamily({ publicPassed: 4, hiddenAtomicPassed: 6, hiddenComposedPassed: 10 }, { passed: 1, total: 1 });
  const mismatched = completedRun(descriptor, evaluation);
  mismatched.instanceId = 'instance-not-sealed';
  assert.throws(() => scoreTerminalV7Run(mismatched, descriptor), /instance identity mismatch/);
  const invalid = structuredClone(evaluation);
  invalid.families[0].hidden.passed -= 1;
  assert.throws(() => scoreTerminalV7Run(completedRun(descriptor, invalid), descriptor), /atomic and composed partitions/);
  const wrongTotal = structuredClone(evaluation);
  wrongTotal.families[0].hiddenComposed.total = 11;
  assert.throws(() => scoreTerminalV7Run(completedRun(descriptor, wrongTotal), descriptor), /hidden composed total must be 10/);
});

function pairedResults(descriptor, scoreByHarness) {
  return Object.entries(scoreByHarness).flatMap(([harnessId, scores]) => descriptor.instances.map((instance, index) => ({
    harnessId,
    instanceId: instance.instanceId,
    score: { core: { points: scores[index] } },
  })));
}

test('V7 paired analysis uses a deterministic 10,000-resample pack-cluster bootstrap', () => {
  const descriptor = challenge();
  const results = pairedResults(descriptor, {
    alpha: [80, 90, 70, 85, 75],
    beta: [70, 80, 60, 75, 65],
  });
  const first = analyzeTerminalV7PairedPacks(results, { challenge: descriptor, bootstrapSeed: 1234 });
  const second = analyzeTerminalV7PairedPacks([...results].reverse(), { challenge: descriptor, bootstrapSeed: 1234 });
  assert.deepEqual(first, second);
  assert.equal(first.bootstrap.resamples, TERMINAL_V7_BOOTSTRAP_RESAMPLES);
  assert.equal(first.comparisons.length, 1);
  assert.equal(first.comparisons[0].meanDifference, 10);
  assert.deepEqual(first.comparisons[0].confidenceInterval95, { low: 10, high: 10 });
  assert.equal(first.comparisons[0].winnerHarnessId, 'alpha');
  assert.equal(first.comparisons[0].decision, 'practical-win');
  assert.equal(first.comparisons[0].bootstrap.clusterUnit, 'sealed-instance-pack');
});

test('V7 practical wins require both a >=5-point mean and a CI excluding zero', () => {
  const descriptor = challenge();
  const belowThreshold = analyzeTerminalV7PairedPacks(pairedResults(descriptor, {
    alpha: [54, 54, 54, 54, 54],
    beta: [50, 50, 50, 50, 50],
  }), { challenge: descriptor });
  assert.equal(belowThreshold.comparisons[0].meanDifference, 4);
  assert.equal(belowThreshold.comparisons[0].confidenceExcludesZero, true);
  assert.equal(belowThreshold.comparisons[0].winnerHarnessId, null);
  assert.equal(belowThreshold.comparisons[0].decision, 'tie');

  const uncertain = analyzeTerminalV7PairedPacks(pairedResults(descriptor, {
    alpha: [50, 50, 50, 50, 100],
    beta: [50, 50, 50, 50, 50],
  }), { challenge: descriptor });
  assert.equal(uncertain.comparisons[0].meanDifference, 10);
  assert.equal(uncertain.comparisons[0].practicalMagnitude, true);
  assert.equal(uncertain.comparisons[0].confidenceInterval95.low, 0);
  assert.equal(uncertain.comparisons[0].winnerHarnessId, null);

  const threshold = analyzeTerminalV7PairedPacks(pairedResults(descriptor, {
    alpha: [55, 55, 55, 55, 55],
    beta: [50, 50, 50, 50, 50],
  }), { challenge: descriptor });
  assert.equal(threshold.comparisons[0].meanDifference, 5);
  assert.equal(threshold.comparisons[0].winnerHarnessId, 'alpha');
});

test('V7 paired analysis rejects missing or duplicate pack clusters', () => {
  const descriptor = challenge();
  const results = pairedResults(descriptor, {
    alpha: [60, 60, 60, 60, 60],
    beta: [50, 50, 50, 50, 50],
  });
  assert.throws(() => analyzeTerminalV7PairedPacks(results.slice(1), { challenge: descriptor }), /at least two harnesses|does not cover all five/);
  assert.throws(() => analyzeTerminalV7PairedPacks([...results, results[0]], { challenge: descriptor }), /Duplicate V7 paired result/);
});
