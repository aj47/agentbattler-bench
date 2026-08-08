import assert from 'node:assert/strict';
import test from 'node:test';

import { listV7Packs, sealV7Pack } from '../benchmark/challenges/mini-ledger-v7/pack.mjs';
import {
  analyzeTerminalV7DevelopmentPilot,
  createTerminalV7CalibrationChallenge,
  createTerminalV7CalibrationExecutionUnit,
  createTerminalV7CalibrationTaskBinding,
  createTerminalV7DevelopmentPilotSchedule,
  createTerminalV7ReserveExtension,
  scoreTerminalV7CalibrationRun,
  terminalV7CalibrationAdapterJob,
  TERMINAL_V7_PILOT_POLICY,
  validateTerminalV7CalibrationChallenge,
  validateTerminalV7CalibrationChallengeAgainstManifest,
  validateTerminalV7CalibrationExecutionUnit,
  validateTerminalV7CalibrationSchedule,
  validateTerminalV7CalibrationTaskBinding,
} from '../src/terminal-v7-calibration.mjs';
import {
  createTerminalV7Challenge,
  createTerminalV7Schedule,
  MINI_LEDGER_V7_FAMILIES,
} from '../src/terminal-v7.mjs';
import { createTerminalV7SealManifest } from '../src/terminal-v7-seals.mjs';
import { canonicalJsonSha256 } from '../src/provenance.mjs';
import { sealTerminalV7ScriptedReferenceReport } from '../src/terminal-v7-scripted-references.mjs';
import { sealTerminalV7HumanTwinValidation } from '../src/terminal-v7-human-twins.mjs';

const KEY = 'terminal-v7-calibration-test-key';
const SEALED_AT = '2026-08-08T08:00:00.000Z';
const HARNESSES = [
  { id: 'codex-cli', version: 'test-codex' },
  { id: 'pi-coding-agent', version: 'test-pi' },
];

function manifest() {
  return createTerminalV7SealManifest({ revision: 'r1', seedKey: KEY, sealedAt: SEALED_AT });
}

function evaluation(corePoints) {
  assert.ok(Number.isInteger(corePoints) && corePoints >= 0 && corePoints <= 100);
  return {
    families: MINI_LEDGER_V7_FAMILIES.map((id, index) => {
      const familyPoints = Math.max(0, Math.min(20, corePoints - (index * 20)));
      const publicPassed = Math.min(4, familyPoints);
      const hiddenAtomicPassed = Math.min(6, Math.max(0, familyPoints - 4));
      const hiddenComposedPassed = Math.min(10, Math.max(0, familyPoints - 10));
      return {
        id,
        public: { passed: publicPassed, total: 4 },
        hiddenAtomic: { passed: hiddenAtomicPassed, total: 6 },
        hiddenComposed: { passed: hiddenComposedPassed, total: 10 },
        hidden: { passed: hiddenAtomicPassed + hiddenComposedPassed, total: 16 },
      };
    }),
    adaptability: { passed: 0, total: 5 },
  };
}

function completed(job, corePoints) {
  const unsigned = {
    ...job,
    status: 'completed',
    validity: 'valid',
    evaluation: evaluation(corePoints),
  };
  return { ...unsigned, resultSha256: canonicalJsonSha256(unsigned) };
}

function pilotFixture() {
  const challenge = createTerminalV7CalibrationChallenge({ sealManifest: manifest(), pool: 'dev', seedKey: KEY });
  const schedule = createTerminalV7DevelopmentPilotSchedule({ challenge, harnesses: HARNESSES, seed: 101 });
  return { challenge, schedule };
}

function passingPilotRuns(schedule) {
  const codexMax = new Map([['dev-01', 70], ['dev-02', 72], ['dev-03', 68]]);
  const piMax = new Map([['dev-01', 60], ['dev-02', 65], ['dev-03', 64]]);
  const high = new Map([['dev-01', 55], ['dev-02', 57], ['dev-03', 53]]);
  return schedule.jobs.map((job) => {
    let score = 67;
    if (job.model.reasoningEffort === 'high') score = high.get(job.instanceId);
    else if (job.instanceVariant === 'decoy') score = (job.harness.id === 'codex-cli' ? codexMax : piMax).get(job.instanceId);
    return completed(job, score);
  });
}

function references() {
  const verifierImage = { imageId: `sha256:${'a'.repeat(64)}`, sourceSha256: 'b'.repeat(64) };
  const implementations = ['gold-a', 'gold-b'].map((implementationId, index) => ({
    implementationId,
    sourceRoot: `test/${implementationId}`,
    fileCount: 1,
    sourceSha256: String(index + 1).repeat(64),
  }));
  const rows = implementations.flatMap((implementation) => ['dev-01', 'dev-02', 'dev-03'].flatMap((instanceId) => ['clean', 'decoy'].map((variant) => {
    const key = `${implementation.implementationId}-${instanceId}-${variant}`;
    return {
      implementationId: implementation.implementationId,
      instanceId,
      variant,
      status: 'completed',
      validity: 'valid',
      corePoints: 100,
      exact: true,
      implementationSourceSha256: implementation.sourceSha256,
      executableSourceSha256: canonicalJsonSha256({ key, field: 'source' }),
      packSha256: canonicalJsonSha256({ key, field: 'pack' }),
      sealSha256: canonicalJsonSha256({ key, field: 'seal' }),
      verifierImageId: verifierImage.imageId,
      verifierSourceSha256: verifierImage.sourceSha256,
      verifierSeedIndex: 0,
      evaluationSha256: canonicalJsonSha256({ key, field: 'evaluation' }),
      verifierArtifactsSha256: canonicalJsonSha256({ key, field: 'artifacts' }),
      goldResultsSha256: canonicalJsonSha256({ key, field: 'gold' }),
      evidencePath: `control/scripted-reference-evidence/rows/${implementation.implementationId}/${instanceId}-${variant}.json`,
      evidenceFileSha256: canonicalJsonSha256({ key, field: 'evidence' }),
    };
  })));
  return sealTerminalV7ScriptedReferenceReport({
    schemaVersion: 'agentbattler.terminal-v7-scripted-reference-report.v1',
    challengeId: 'terminal-mini-ledger-v7',
    revision: 'r1',
    createdAt: '2026-08-08T09:00:00.000Z',
    sealManifestSha256: 'c'.repeat(64),
    goldReportSha256: 'd'.repeat(64),
    policy: { implementations: 2, developmentPacks: 3, variants: ['clean', 'decoy'], verifierSeedIndex: 0, verifierBoundary: 'sealed-linux-strace-container', reporting: 'aggregate-scores-and-commitments-only' },
    verifierImage,
    implementations,
    rows,
    summary: { rows: 12, independentImplementations: 2, minimumCore: 100, exactRows: 12, infrastructureInvalid: 0, maximumAbsoluteTwinDifference: 0 },
    privacy: { aggregateOnly: true, privateSeedsIncluded: false, verifierCasesIncluded: false, promptsIncluded: false, sessionsIncluded: false, modelTextIncluded: false },
  });
}

function humanTwins() {
  return ['dev-01', 'dev-02', 'dev-03'].map((instanceId, index) => {
    const twin = (variant, corePoints) => ({
      variant,
      status: 'completed',
      validity: 'valid',
      corePoints,
      exact: false,
      candidateTreeSha256: canonicalJsonSha256({ instanceId, variant, kind: 'tree' }),
      evaluationSha256: canonicalJsonSha256({ instanceId, variant, kind: 'evaluation' }),
      evidencePath: `control/human-twin-evidence/${instanceId}-${variant}.json`,
      evidenceFileSha256: canonicalJsonSha256({ instanceId, variant, kind: 'evidence-file' }),
    });
    const clean = twin('clean', 82 + index);
    const decoy = twin('decoy', 85 + index);
    return sealTerminalV7HumanTwinValidation({
      schemaVersion: 'agentbattler.terminal-v7-human-twin-validation.v1',
      revision: 'r1',
      reviewedCommit: 'a'.repeat(40),
      sealManifestSha256: 'b'.repeat(64),
      verifierImage: { imageId: `sha256:${'c'.repeat(64)}`, sourceSha256: 'd'.repeat(64) },
      validatorId: 'human-01',
      validatorIdentitySha256: 'e'.repeat(64),
      independenceDeclaration: true,
      validationMethod: 'human-executable-twin-validation',
      validatedAt: '2026-08-08T09:00:00.000Z',
      instanceId,
      clean,
      decoy,
      cleanCorePoints: clean.corePoints,
      decoyCorePoints: decoy.corePoints,
    });
  });
}

test('V7 development pilot seals six variant-specific instances and a deterministic 15-job matrix', () => {
  const seals = manifest();
  const challenge = createTerminalV7CalibrationChallenge({ sealManifest: seals, pool: 'dev', seedKey: KEY });
  assert.equal(validateTerminalV7CalibrationChallenge(challenge), challenge);
  assert.equal(validateTerminalV7CalibrationChallengeAgainstManifest(challenge, seals, { seedKey: KEY }), challenge);
  assert.equal(challenge.instances.length, 6);
  assert.equal(new Set(challenge.instances.map(({ instanceSha256 }) => instanceSha256)).size, 6);
  for (const instanceId of ['dev-01', 'dev-02', 'dev-03']) {
    const twins = challenge.instances.filter((instance) => instance.instanceId === instanceId);
    assert.deepEqual(twins.map(({ variant }) => variant).sort(), ['clean', 'decoy']);
    assert.notEqual(twins[0].packCommitments.packSha256, twins[1].packCommitments.packSha256);
    assert.equal(twins[0].packCommitments.hiddenMerkleRoot, twins[1].packCommitments.hiddenMerkleRoot);
  }

  const schedule = createTerminalV7DevelopmentPilotSchedule({ challenge, harnesses: HARNESSES, seed: 101 });
  assert.equal(validateTerminalV7CalibrationSchedule(schedule, challenge), schedule);
  assert.equal(schedule.jobs.length, 15);
  assert.equal(schedule.jobs.filter((job) => job.model.reasoningEffort === 'max').length, 12);
  assert.equal(schedule.jobs.filter((job) => job.model.reasoningEffort === 'high').length, 3);
  for (let round = 1; round <= 5; round += 1) {
    const jobs = schedule.jobs.filter((job) => job.round === round);
    assert.equal(jobs.length, 3);
    assert.deepEqual(new Set(jobs.map(({ instanceId }) => instanceId)), new Set(['dev-01', 'dev-02', 'dev-03']));
  }
  for (const instanceId of ['dev-01', 'dev-02', 'dev-03']) {
    const lanes = schedule.jobs
      .filter((job) => job.instanceId === instanceId && job.model.reasoningEffort === 'max')
      .map((job) => `${job.harness.id}/${job.instanceVariant}`);
    assert.deepEqual(new Set(lanes), new Set(['codex-cli/clean', 'codex-cli/decoy', 'pi-coding-agent/clean', 'pi-coding-agent/decoy']));
  }

  const reordered = createTerminalV7DevelopmentPilotSchedule({ challenge, harnesses: [...HARNESSES].reverse(), seed: 101 });
  assert.deepEqual(reordered, schedule);
  const tampered = structuredClone(schedule);
  tampered.jobs[0].instanceVariant = tampered.jobs[0].instanceVariant === 'clean' ? 'decoy' : 'clean';
  assert.throws(() => validateTerminalV7CalibrationSchedule(tampered, challenge), /schedule hash mismatch/);
});

test('V7 calibration execution units preserve one-job adapter compatibility', () => {
  const { challenge, schedule } = pilotFixture();
  const job = schedule.jobs[4];
  const unit = createTerminalV7CalibrationExecutionUnit({ challenge, schedule, runKey: job.runKey });
  assert.equal(validateTerminalV7CalibrationExecutionUnit(unit, { challenge, schedule }), unit);
  const adapterJob = terminalV7CalibrationAdapterJob(unit, challenge);
  assert.equal(adapterJob.runKey, job.runKey);
  assert.equal(adapterJob.harness, job.harness.id);
  assert.equal(adapterJob.harnessVersion, job.harness.version);
  assert.equal(adapterJob.model, 'gpt-5.6-luna');
  assert.equal(adapterJob.reasoningEffort, job.model.reasoningEffort);
  assert.equal(adapterJob.maxWallTimeMs, 1_500_000);
  assert.equal(adapterJob.executionConcurrency, 1);
});

test('V7 calibration task bindings cover every variant-specific pack under the private result root', () => {
  const seals = manifest();
  const challenge = createTerminalV7CalibrationChallenge({ sealManifest: seals, pool: 'dev', seedKey: KEY });
  const taskSets = ['clean', 'decoy'].map((variant) => ({
    schemaVersion: 'agentbattler.harbor-mini-ledger-v7-task-set.v1',
    challengeId: 'terminal-mini-ledger-v7',
    pool: 'dev',
    variant,
    feedbackPolicy: 'self-service-public-only',
    phaseLimitMs: 1_500_000,
    tasks: challenge.instances.filter((instance) => instance.variant === variant).map((instance) => ({
      instanceId: instance.instanceId,
      variant,
      taskPathBase: 'result-root',
      taskPath: `control/harbor-tasks/${instance.instanceId}-${variant}`,
      packSha256: instance.packCommitments.packSha256,
      sealSha256: instance.packCommitments.sealSha256,
      sha256: instance.instanceSha256,
      fileCount: 1,
      images: Object.fromEntries(['environment', 'verifier'].map((kind, index) => [kind, {
        kind,
        imageId: `sha256:${String(index + 1).repeat(64)}`,
        sourceSha256: String(index + 3).repeat(64),
      }])),
    })),
  }));
  const binding = createTerminalV7CalibrationTaskBinding({ sealManifest: seals, pool: 'dev', seedKey: KEY, taskSets });
  assert.equal(validateTerminalV7CalibrationTaskBinding(binding, challenge), binding);
  assert.equal(Object.keys(binding.tasks).length, 6);
  assert.ok(Object.values(binding.tasks).every((task) => task.taskPathBase === 'result-root'));
  const escaped = structuredClone(taskSets);
  escaped[0].tasks[0].taskPath = '../private-pack';
  assert.throws(() => createTerminalV7CalibrationTaskBinding({ sealManifest: seals, pool: 'dev', seedKey: KEY, taskSets: escaped }), /unsafe/);
});

test('V7 pilot analysis applies every acceptance threshold and fails closed on infrastructure invalidity', () => {
  const { challenge, schedule } = pilotFixture();
  const runs = passingPilotRuns(schedule);
  assert.equal(scoreTerminalV7CalibrationRun(runs[0]).corePoints, 67);
  const report = analyzeTerminalV7DevelopmentPilot({
    challenge,
    schedule,
    runs,
    scriptedReferences: references(),
    humanTwinValidations: humanTwins(),
  });
  assert.equal(report.accepted, true);
  assert.equal(report.decision, 'accept-development-pilot');
  assert.equal(report.observations.maxDecoyMedianCore, 66.5);
  assert.equal(report.observations.maximumPilotCore, 72);
  assert.equal(report.observations.exactMaxDecoyRuns, 0);
  assert.equal(report.observations.pairedMeanMaxMinusHigh, 15);
  assert.equal(report.observations.scriptedTwinMaximumAbsoluteDifference, 0);
  assert.equal(report.observations.humanTwinMaximumAbsoluteDifference, 3);
  assert.deepEqual(report.policy, TERMINAL_V7_PILOT_POLICY);

  const invalid = structuredClone(runs);
  invalid[0] = { ...invalid[0], status: 'infrastructure-invalid', validity: 'infrastructure-invalid', evaluation: undefined };
  const rejected = analyzeTerminalV7DevelopmentPilot({
    challenge,
    schedule,
    runs: invalid,
    scriptedReferences: references(),
    humanTwinValidations: humanTwins(),
  });
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.decision, 'reject-and-reseal-template');
  assert.equal(rejected.infrastructureInvalid.length, 1);
  assert.equal(rejected.checks.find(({ id }) => id === 'PILOT-COMPLETE').passed, false);

  const saturated = structuredClone(runs);
  const clean = saturated.find((run) => run.instanceVariant === 'clean');
  clean.evaluation = evaluation(96);
  const { resultSha256: _oldSaturatedHash, ...saturatedUnsigned } = clean;
  clean.resultSha256 = canonicalJsonSha256(saturatedUnsigned);
  const saturationRejected = analyzeTerminalV7DevelopmentPilot({
    challenge,
    schedule,
    runs: saturated,
    scriptedReferences: references(),
    humanTwinValidations: humanTwins(),
  });
  assert.equal(saturationRejected.checks.find(({ id }) => id === 'NO-RUN-ABOVE-95').passed, false);
  assert.equal(saturationRejected.accepted, false);
});

test('V7 pilot analysis rejects incomplete or invalid calibration controls', () => {
  const { challenge, schedule } = pilotFixture();
  const completeReferences = references();
  const { reportSha256: _completeReportSha256, ...incompleteUnsigned } = completeReferences;
  incompleteUnsigned.rows = incompleteUnsigned.rows.slice(1);
  const incompleteReferences = sealTerminalV7ScriptedReferenceReport(incompleteUnsigned);
  assert.throws(() => analyzeTerminalV7DevelopmentPilot({
    challenge,
    schedule,
    runs: passingPilotRuns(schedule),
    scriptedReferences: incompleteReferences,
    humanTwinValidations: humanTwins(),
  }), /matrix is incomplete/);
  const invalidHuman = humanTwins();
  const changedHuman = structuredClone(invalidHuman[0]);
  delete changedHuman.attestationSha256;
  changedHuman.decoy = { ...changedHuman.decoy, corePoints: changedHuman.clean.corePoints + 5 };
  changedHuman.decoyCorePoints = changedHuman.decoy.corePoints;
  invalidHuman[0] = sealTerminalV7HumanTwinValidation(changedHuman);
  const report = analyzeTerminalV7DevelopmentPilot({
    challenge,
    schedule,
    runs: passingPilotRuns(schedule),
    scriptedReferences: references(),
    humanTwinValidations: invalidHuman,
  });
  assert.equal(report.checks.find(({ id }) => id === 'HUMAN-TWIN-PARITY').passed, false);
});

test('V7 reserve extension admits only an unresolved leading pair and all five presealed reserve packs', () => {
  const seals = manifest();
  const releasePacks = listV7Packs({ pool: 'release', variant: 'decoy' }).map((pack) => sealV7Pack(pack, { seedKey: KEY }));
  const releaseChallenge = createTerminalV7Challenge({
    protocolRevision: 'r1',
    instances: releasePacks,
    promptSha256: 'a'.repeat(64),
    publicVerifierSha256: 'b'.repeat(64),
    hiddenVerifierSha256: 'c'.repeat(64),
    adaptabilityVerifierSha256: 'd'.repeat(64),
  });
  const releaseHarnesses = [
    ...HARNESSES,
    { id: 'claude-code', version: 'test-claude' },
    { id: 'dotagents-mono', version: 'test-dotagents' },
    { id: 'factory-droid', version: 'test-droid' },
  ];
  const releaseSchedule = createTerminalV7Schedule({
    challenge: releaseChallenge,
    harnesses: releaseHarnesses,
    model: { id: 'gpt-5.6-luna', familyId: 'luna', reasoningEffort: 'max' },
    seed: 77,
  });
  const harnessScores = new Map([
    ['codex-cli', 70],
    ['pi-coding-agent', 70],
    ['claude-code', 55],
    ['dotagents-mono', 50],
    ['factory-droid', 45],
  ]);
  const releaseResults = releaseSchedule.jobs.map((job) => completed(job, harnessScores.get(job.harness.id)));
  const extension = createTerminalV7ReserveExtension({
    sealManifest: seals,
    seedKey: KEY,
    releaseChallenge,
    releaseSchedule,
    releaseResults,
    harnesses: releaseHarnesses,
    seed: 202,
  });
  assert.equal(validateTerminalV7CalibrationChallengeAgainstManifest(extension.challenge, seals, { seedKey: KEY }), extension.challenge);
  assert.equal(validateTerminalV7CalibrationSchedule(extension.schedule, extension.challenge), extension.schedule);
  assert.deepEqual(extension.challenge.selection.leadingPairHarnessIds, ['codex-cli', 'pi-coding-agent']);
  assert.equal(extension.challenge.selection.releaseDecision, 'tie');
  assert.deepEqual(extension.schedule.matrix.instanceIds, ['reserve-01', 'reserve-02', 'reserve-03', 'reserve-04', 'reserve-05']);
  assert.equal(extension.schedule.jobs.length, 10);
  for (const instanceId of extension.schedule.matrix.instanceIds) {
    const jobs = extension.schedule.jobs.filter((job) => job.instanceId === instanceId);
    assert.equal(jobs.length, 2);
    assert.deepEqual(new Set(jobs.map(({ harness }) => harness.id)), new Set(['codex-cli', 'pi-coding-agent']));
    assert.ok(jobs.every((job) => job.instanceVariant === 'decoy'));
  }

  const resolved = releaseSchedule.jobs.map((job) => completed(job, job.harness.id === 'codex-cli' ? 85 : harnessScores.get(job.harness.id)));
  assert.throws(() => createTerminalV7ReserveExtension({
    sealManifest: seals,
    seedKey: KEY,
    releaseChallenge,
    releaseSchedule,
    releaseResults: resolved,
    harnesses: releaseHarnesses,
  }), /statistically resolved/);

  const invalid = structuredClone(releaseResults);
  invalid[0].status = 'infrastructure-invalid';
  invalid[0].validity = 'infrastructure-invalid';
  assert.throws(() => createTerminalV7ReserveExtension({
    sealManifest: seals,
    seedKey: KEY,
    releaseChallenge,
    releaseSchedule,
    releaseResults: invalid,
    harnesses: releaseHarnesses,
  }), /refuses non-valid release run/);
});
