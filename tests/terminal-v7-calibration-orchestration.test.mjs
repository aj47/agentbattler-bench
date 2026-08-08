import assert from 'node:assert/strict';
import { chmod, link, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { listV7Packs, loadV7Pack, materializeV7Starter, sealV7Pack } from '../benchmark/challenges/mini-ledger-v7/pack.mjs';
import {
  createV7CandidateFailureResult,
  createV7CandidateTrajectoryFailureResult,
  verifyFinal as verifyTerminalV7Final,
} from '../benchmark/challenges/mini-ledger-v7/verifier.mjs';
import {
  buildTerminalV7DevelopmentPilotControl,
  buildTerminalV7ReserveControl,
  loadTerminalV7CalibrationSealInputs,
  terminalV7CalibrationSourceCommitments,
} from '../src/terminal-v7-calibration-build.mjs';
import {
  assertTerminalV7CalibrationInvocationReady,
  terminalV7CalibrationUnitForRunKey,
  runTerminalV7CalibrationExecutionUnit,
} from '../src/terminal-v7-calibration-runner.mjs';
import { runTerminalV7ReserveSchedule } from '../src/terminal-v7-reserve-runner.mjs';
import {
  collectTerminalV7ReserveEvidence,
  createTerminalV7ReserveFinalReport,
  validateTerminalV7ReserveFinalReport,
} from '../src/terminal-v7-reserve-report.mjs';
import {
  assertTerminalV7DevelopmentPilotReportSources,
  collectTerminalV7DevelopmentPilotEvidence,
  createTerminalV7DevelopmentPilotReport,
  createTerminalV7ReleaseGateEvidenceFromPilot,
  validateTerminalV7DevelopmentPilotReport,
} from '../src/terminal-v7-pilot-report.mjs';
import {
  createTerminalV7Challenge,
  createTerminalV7Schedule,
  analyzeTerminalV7PairedPacks,
  MINI_LEDGER_V7_FAMILIES,
  scoreTerminalV7Run,
} from '../src/terminal-v7.mjs';
import { canonicalJson, canonicalJsonSha256, sha256 } from '../src/provenance.mjs';
import { captureTerminalCandidateTree } from '../src/terminal-candidate-tree.mjs';
import { createTerminalV7SealManifest } from '../src/terminal-v7-seals.mjs';
import { sealTerminalV7ScriptedReferenceReport } from '../src/terminal-v7-scripted-references.mjs';
import { sealTerminalV7HumanTwinValidation } from '../src/terminal-v7-human-twins.mjs';
import {
  createTerminalV7RetirementRecord,
  writeTerminalV7RetirementRecord,
} from '../src/terminal-v7-retirement.mjs';
import {
  ensureTerminalV7RevisionSaturationForRun,
  readTerminalV7RevisionStopState,
} from '../src/terminal-v7-revision-control.mjs';
import { writeTerminalV7VerifierEvaluationArtifact } from '../src/terminal-v7-verifier-evidence.mjs';
import { TERMINAL_V7_HARBOR_UNBOUND_IMAGE_ID } from '../src/terminal-v7-harbor-images.mjs';
import { assertTerminalV7PilotNotStarted } from '../scripts/assemble-terminal-v7-base-gates.mjs';
import {
  DOTAGENTS_COMMIT,
  DOTAGENTS_V7_IMAGE,
  DOTAGENTS_V7_SANDBOX_REVISION,
  DOTAGENTS_VERSION,
  dotAgentsV7ImageSourceDescriptor,
} from '../src/dotagents-harness.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const KEY = 'terminal-v7-orchestration-test-key';

async function temporary(name, callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), `${name}-`));
  try { return await callback(root); } finally { await rm(root, { recursive: true, force: true }); }
}

async function inputs(root) {
  const sealManifest = createTerminalV7SealManifest({ revision: 'r1', seedKey: KEY, sealedAt: '2026-08-08T09:00:00.000Z' });
  const sealsPath = path.join(root, 'seals.json');
  const seedKeyPath = path.join(root, 'seed-key');
  await Promise.all([
    writeFile(sealsPath, `${canonicalJson(sealManifest)}\n`, { mode: 0o600 }),
    writeFile(seedKeyPath, `${KEY}\n`, { mode: 0o600 }),
  ]);
  await chmod(seedKeyPath, 0o600);
  return { sealManifest, sealsPath, seedKeyPath };
}

function verifierImage() {
  return {
    schemaVersion: 'agentbattler.terminal-v7-verifier-image-source.v1',
    sourceSha256: 'a'.repeat(64),
    imageId: `sha256:${'b'.repeat(64)}`,
    image: 'agentbattler-mini-ledger-v7-verifier:test',
    network: 'none',
    readOnlyRootFilesystem: true,
    candidateCapabilities: 'exactly-zero',
  };
}

async function dotAgentsRuntimeImages() {
  const source = await dotAgentsV7ImageSourceDescriptor({ repositoryRoot: ROOT });
  return {
    'dotagents-mono': {
      schemaVersion: 'agentbattler.dotagents-v7-image.v1',
      image: DOTAGENTS_V7_IMAGE,
      imageId: `sha256:${'c'.repeat(64)}`,
      os: 'linux',
      architecture: 'arm64',
      commit: DOTAGENTS_COMMIT,
      version: DOTAGENTS_VERSION,
      sandboxRevision: DOTAGENTS_V7_SANDBOX_REVISION,
      sourceSha256: source.sourceSha256,
    },
  };
}

function fakeTaskBuilder() {
  return async ({ pool, variant, resultRoot, seedKey }) => {
    const tasks = [];
    for (const pack of listV7Packs({ pool, variant })) {
      const sealed = sealV7Pack(pack, { seedKey });
      const taskPath = path.posix.join('control', 'harbor-tasks', `${pack.instanceId}-${variant}`);
      const taskRoot = path.join(resultRoot, ...taskPath.split('/'));
      await mkdir(taskRoot, { recursive: true });
      await writeFile(path.join(taskRoot, 'task.toml'), `[verifier.environment]
docker_image = ${JSON.stringify(TERMINAL_V7_HARBOR_UNBOUND_IMAGE_ID)}

[environment]
docker_image = ${JSON.stringify(TERMINAL_V7_HARBOR_UNBOUND_IMAGE_ID)}
`);
      tasks.push({
        instanceId: pack.instanceId,
        variant,
        taskPathBase: 'result-root',
        taskPath,
        packSha256: sealed.packSha256,
        sealSha256: sealed.sealSha256,
        sha256: canonicalJsonSha256({ resultRoot, instanceId: pack.instanceId, variant }),
        fileCount: 1,
      });
    }
    return {
      schemaVersion: 'agentbattler.harbor-mini-ledger-v7-task-set.v1',
      challengeId: 'terminal-mini-ledger-v7',
      pool,
      variant,
      feedbackPolicy: 'self-service-public-only',
      phaseLimitMs: 1_500_000,
      tasks,
    };
  };
}

async function fakeTaskImages() {
  return Object.fromEntries(['environment', 'verifier'].map((kind, index) => [kind, {
    schemaVersion: 'agentbattler.terminal-v7-harbor-image-source.v1',
    kind,
    image: `agentbattler-v7-${kind}:test`,
    imageId: `sha256:${String(index + 3).repeat(64)}`,
    sourceSha256: String(index + 5).repeat(64),
    fileCount: 1,
  }]));
}

function evaluation(corePoints) {
  return {
    infrastructureErrors: [],
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
    adaptability: { passed: 5, total: 5 },
  };
}

function scoreForJob(job) {
  if (job.reasoningEffort === 'high') return { 'dev-01': 55, 'dev-02': 57, 'dev-03': 53 }[job.instanceId];
  if (job.instanceVariant === 'decoy' && job.harness === 'codex-cli') return { 'dev-01': 70, 'dev-02': 72, 'dev-03': 68 }[job.instanceId];
  if (job.instanceVariant === 'decoy') return { 'dev-01': 60, 'dev-02': 65, 'dev-03': 64 }[job.instanceId];
  return 67;
}

function completedAdapterResult(job) {
  const score = scoreForJob(job);
  return completedAdapterResultAt(job, score);
}

function completedAdapterResultAt(job, score) {
  return {
    ...job,
    schemaVersion: 'agentbattler.terminal-run.v1',
    status: 'completed',
    validity: 'valid',
    sessionId: 'redacted-session-proof',
    sameSessionProof: true,
    turns: Array.from({ length: 5 }, (_, index) => ({ index: index + 1, sessionId: 'redacted-session-proof', candidateTree: { schemaVersion: 'agentbattler.terminal-candidate-tree.v1', kind: 'overlay' } })),
    stages: Array.from({ length: 5 }, (_, index) => ({ id: `phase-${index + 1}`, passed: true })),
    phaseResults: Array.from({ length: 5 }, () => ({ infrastructureErrors: [], requirements: [] })),
    evaluation: evaluation(score),
    humanIntervention: 'none',
  };
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

function humans() {
  return ['dev-01', 'dev-02', 'dev-03'].map((instanceId) => {
    const projection = (variant, corePoints) => ({
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
    const clean = projection('clean', 82);
    const decoy = projection('decoy', 85);
    return sealTerminalV7HumanTwinValidation({
      schemaVersion: 'agentbattler.terminal-v7-human-twin-validation.v1',
      revision: 'r1',
      reviewedCommit: '1'.repeat(40),
      sealManifestSha256: '2'.repeat(64),
      verifierImage: { imageId: `sha256:${'3'.repeat(64)}`, sourceSha256: '4'.repeat(64) },
      validatorId: 'human-01',
      validatorIdentitySha256: '5'.repeat(64),
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

function fakeHumanTwinArtifactClosure(rows = humans()) {
  return {
    schemaVersion: 'agentbattler.terminal-v7-human-twin-artifact-closure.v1',
    rowsSha256: canonicalJsonSha256(rows),
    artifactsSha256: canonicalJsonSha256(rows.map(({ instanceId }) => instanceId)),
  };
}

async function fakeVerifierEvidence({ run }) {
  return {
    schemaVersion: 'agentbattler.terminal-v7-verifier-evidence.v1',
    syntheticUnitFixture: true,
    evaluationSha256: canonicalJsonSha256(run.evaluation),
  };
}

function strictIsolation(turn, harnessId) {
  return {
    schemaVersion: 'agentbattler.terminal-trace-isolation-audit.v1',
    turn,
    checkedToolPayloads: 0,
    forbiddenMarkers: 9,
    passed: true,
    sandboxEnforced: true,
    sandboxPolicy: `${harnessId}-sealed-command-sandbox`,
    disqualifying: false,
    observedAttemptCount: 0,
    observedAttempts: [],
    violations: [],
  };
}

function forgedPassingFinal(evaluation) {
  const forged = structuredClone(evaluation);
  for (const requirement of forged.requirements) {
    requirement.passed = true;
    requirement.points = requirement.weight;
    if (requirement.classes) {
      for (const outcome of Object.values(requirement.classes)) {
        outcome.passed = true;
        outcome.points = outcome.weight;
      }
    }
  }
  forged.checks = structuredClone(forged.requirements);
  forged.families = MINI_LEDGER_V7_FAMILIES.map((id) => ({
    id,
    public: { passed: 4, total: 4 },
    hiddenAtomic: { passed: 6, total: 6 },
    hiddenComposed: { passed: 10, total: 10 },
    hidden: { passed: 16, total: 16 },
  }));
  Object.assign(forged, { score: 100, maxScore: 100, publicScore: 20, privateScore: 80, passed: true });
  return forged;
}

async function strictFailedAdapterResult(job, { challenge, runDirectory, seedKey = null, forgeFinal = false }) {
  const sourcePack = loadV7Pack(job.instanceId, { variant: job.instanceVariant });
  const pack = sealV7Pack(sourcePack, seedKey === null ? {} : { seedKey });
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-v7-strict-run-fixture-'));
  const baseline = path.join(fixtureRoot, 'baseline');
  const workspace = path.join(fixtureRoot, 'workspace');
  const phaseResults = [];
  const candidateTrees = [];
  const boundary = {
    modelCommandCapabilities: 'exactly-zero',
    network: 'denied',
    candidateFilesystem: 'native-sandbox',
  };
  try {
    await Promise.all([
      materializeV7Starter({ pack, destination: baseline }),
      materializeV7Starter({ pack, destination: workspace }),
    ]);
    for (let phase = 1; phase <= 5; phase += 1) {
      const candidateTree = await captureTerminalCandidateTree({
        workspace,
        baseDirectory: baseline,
        runDirectory,
        turn: phase,
        policy: challenge.execution.candidateTree.policy,
      });
      candidateTrees.push(candidateTree);
      const evaluation = phase === 5
        ? createV7CandidateTrajectoryFailureResult({ instance: pack, pack, phase, seedKey: seedKey ?? undefined })
        : createV7CandidateFailureResult({ instance: pack, pack, phase, seedKey: seedKey ?? undefined });
      phaseResults.push(evaluation);
      await writeTerminalV7VerifierEvaluationArtifact({
        runDirectory,
        phase,
        source: 'harbor-separate-verifier',
        sourceArtifactBytes: Buffer.from(canonicalJson({ phaseEvaluation: evaluation })),
        evaluation,
        boundary,
      });
    }
    const verifiedEvaluation = await verifyTerminalV7Final({
      instance: pack,
      pack,
      phaseResults,
      seedKey: seedKey ?? undefined,
      verifierSeedIndex: 0,
    });
    const evaluation = forgeFinal ? forgedPassingFinal(verifiedEvaluation) : verifiedEvaluation;
    await writeTerminalV7VerifierEvaluationArtifact({
      runDirectory,
      phase: null,
      source: 'trusted-final-aggregator',
      sourceArtifactBytes: Buffer.from(canonicalJson(phaseResults)),
      evaluation,
      boundary,
    });
    const task = challenge.execution.tasks[job.instanceSha256];
    assert.ok(task, `missing strict fixture task binding for ${job.instanceSha256}`);
    return {
      ...job,
      status: 'completed',
      validity: 'valid',
      sessionId: 'redacted-strict-session-proof',
      sameSessionProof: true,
      turns: candidateTrees.map((candidateTree, index) => ({
        index: index + 1,
        sessionId: 'redacted-strict-session-proof',
        candidateTree,
        declaredArtifact: null,
        isolation: strictIsolation(index + 1, job.harness),
      })),
      stages: Array.from({ length: 5 }, (_, index) => ({ id: `phase-${index + 1}`, passed: false })),
      phaseResults,
      evaluation,
      declaredArtifacts: [null, null, null, null, null],
      declaredArtifactRejections: [null, null, null, null, null],
      humanIntervention: 'none',
      adapter: {
        name: 'harbor',
        environment: 'docker',
        verifierEnvironment: 'separate',
        modelCommandCapabilities: 'exactly-zero',
        imageExecutionPolicy: 'sealed-prebuilt-task-images',
        runtimeImages: task.images,
        taskImageReferences: Object.fromEntries(['environment', 'verifier'].map((kind) => [kind, task.images[kind].imageId])),
        verifierBoundaries: Array.from({ length: 5 }, (_, index) => ({
          phase: index + 1,
          candidateCapabilityMask: '0000000000000000',
          candidateNativeBoundary: 'bubblewrap-v1',
        })),
      },
    };
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

function baseGateEvidence(manifest) {
  const hostUnsigned = { schemaVersion: 'agentbattler.terminal-v7-execution-host.v1', role: 'm4-pro-execution-host', platform: 'darwin', architecture: 'arm64', chip: 'Apple M4 Pro', modelIdentifier: 'Mac16,8' };
  const unsigned = {
    schemaVersion: 'agentbattler.terminal-v7-base-gate-evidence.v2',
    revision: 'r1',
    evaluatedAt: '2026-08-08T09:30:00.000Z',
    reviewedCommit: '1'.repeat(40),
    executionHost: { ...hostUnsigned, identitySha256: canonicalJsonSha256(hostUnsigned) },
    sourceArtifacts: { sealManifestSha256: manifest.manifestSha256 },
    packSeals: manifest.packs.map((pack) => ({ pool: pack.pool, instanceId: pack.instanceId, sealSha256: pack.decoy.sealSha256, sealedBeforePilot: true })),
    gold: { independentImplementations: 2, verifierSeeds: 100, cleanMinCore: 100, decoyMinCore: 100 },
    scriptedReferences: { rows: 12, independentImplementations: 2, minimumCore: 100, exactRows: 12, infrastructureInvalid: 0, maximumAbsoluteTwinDifference: 0, reportSha256: '3'.repeat(64), closureSha256: '4'.repeat(64) },
    flake: { executionsPerFamily: 100, failures: 0 },
    mutation: { killRate: 0.96, criticalSurvivors: [], semanticAlternatesPassed: true },
    requirementMap: { scoredAssertionsMapped: true, normativeClausesVerified: true, unmappedAssertions: 0, unverifiedClauses: 0 },
    reviews: ['a', 'b', 'c'].map((reviewerId) => ({ reviewerId, approved: true, topics: ['solvability', 'prompt-verifier-correspondence', 'alternate-solutions', 'decoy-falsifiability', 'infrastructure-cleanliness'], reviewSha256: '2'.repeat(64) })),
    tests: { existing: true, v7: true, m4Preflights: 5, failures: 0 },
  };
  return { ...unsigned, baseEvidenceSha256: canonicalJsonSha256(unsigned) };
}

async function pilotControl(temp) {
  const fixture = await inputs(temp);
  const resultRoot = path.join(temp, 'pilot-results');
  await mkdir(resultRoot, { recursive: true });
  const baseEvidence = baseGateEvidence(fixture.sealManifest);
  const baseEvidencePath = path.join(resultRoot, 'release-gates-base.json');
  await writeFile(baseEvidencePath, `${canonicalJson(baseEvidence)}\n`, { mode: 0o600 });
  const built = await buildTerminalV7DevelopmentPilotControl({
    root: ROOT,
    resultRoot,
    revision: 'r1',
    sealsPath: fixture.sealsPath,
    seedKeyPath: fixture.seedKeyPath,
    seed: 91,
    buildTasks: fakeTaskBuilder(),
    buildTaskImages: fakeTaskImages,
    inspectVerifierImage: async () => verifierImage(),
    baseEvidencePath,
    validateBaseGates: async ({ expectedEvidence }) => expectedEvidence,
  });
  return { ...fixture, ...built, resultRoot };
}

async function retiredRevisionControl(temp) {
  const controlRoot = path.join(temp, 'revision-control');
  const relative = 'retirement-evidence/private-pack-leakage.json';
  const evidencePath = path.join(controlRoot, ...relative.split('/'));
  const bytes = 'sealed private-pack leakage evidence\n';
  await mkdir(path.dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, bytes);
  const digest = sha256(bytes);
  const record = createTerminalV7RetirementRecord({
    revision: 'r1',
    detectedAt: '2026-08-08T09:15:00.000Z',
    privatePackLeakage: {
      detected: true,
      evidenceSha256: digest,
      evidenceArtifact: { path: relative, sizeBytes: Buffer.byteLength(bytes), sha256: digest },
    },
  });
  await writeTerminalV7RetirementRecord({ resultRoot: controlRoot, record });
  return controlRoot;
}

test('V7 pilot builder silently loads private inputs and seals run-ready task/source/image commitments', () => temporary('v7-pilot-build', async (temp) => {
  const loadedFixture = await inputs(temp);
  const loaded = await loadTerminalV7CalibrationSealInputs({ root: ROOT, revision: 'r1', sealsPath: loadedFixture.sealsPath, seedKeyPath: loadedFixture.seedKeyPath });
  assert.equal(loaded.sealManifest.manifestSha256, loadedFixture.sealManifest.manifestSha256);
  assert.equal(loaded.seedKey, KEY);
  const resultRoot = path.join(temp, 'pilot-results');
  await mkdir(resultRoot, { recursive: true });
  const baseEvidencePath = path.join(resultRoot, 'release-gates-base.json');
  await writeFile(baseEvidencePath, `${canonicalJson(baseGateEvidence(loadedFixture.sealManifest))}\n`, { mode: 0o600 });
  const built = await buildTerminalV7DevelopmentPilotControl({
    root: ROOT,
    resultRoot,
    revision: 'r1',
    sealsPath: loadedFixture.sealsPath,
    seedKeyPath: loadedFixture.seedKeyPath,
    buildTasks: fakeTaskBuilder(),
    buildTaskImages: fakeTaskImages,
    inspectVerifierImage: async () => verifierImage(),
    baseEvidencePath,
    validateBaseGates: async ({ expectedEvidence }) => expectedEvidence,
  });
  assert.equal(built.schedule.jobs.length, 15);
  assert.equal(Object.keys(built.challenge.execution.tasks).length, 6);
  assert.equal(built.challenge.execution.feedbackPolicy, 'self-service-public-only');
  assert.equal(built.challenge.execution.verifierImage.imageId, verifierImage().imageId);
  assert.match(built.challenge.execution.adapters.harbor.sha256, /^[0-9a-f]{64}$/);
  assert.equal(built.challenge.execution.adapters.v7CalibrationRunner.path, 'src/terminal-v7-calibration-runner.mjs');
  assert.equal(built.control.runPolicy, 'one-precommitted-execution-unit-per-invocation');
  const persisted = JSON.parse(await readFile(path.join(resultRoot, 'challenge.json'), 'utf8'));
  assert.equal(persisted.challengeSha256, built.challenge.challengeSha256);
  assert.doesNotMatch(JSON.stringify(persisted), new RegExp(KEY));
}));

test('V7 base assembly rejects frontier evidence outside runs before pilot launch', () => temporary('v7-base-prepilot-scan', async (temp) => {
  const resultRoot = path.join(temp, 'calibration');
  await mkdir(resultRoot, { recursive: true });
  await assert.doesNotReject(assertTerminalV7PilotNotStarted(resultRoot));
  await mkdir(path.join(resultRoot, 'attempts', 'scheduled-run'), { recursive: true });
  await writeFile(path.join(resultRoot, 'attempts', 'scheduled-run', 'attempt.json'), '{}\n');
  await assert.rejects(assertTerminalV7PilotNotStarted(resultRoot), /frontier execution evidence under attempts/);
  await rm(path.join(resultRoot, 'attempts'), { recursive: true, force: true });
  await mkdir(path.join(resultRoot, 'work', 'scheduled-run'), { recursive: true });
  await writeFile(path.join(resultRoot, 'work', 'scheduled-run', 'native-event.json'), '{}\n');
  await assert.rejects(assertTerminalV7PilotNotStarted(resultRoot), /frontier execution evidence under work/);
}));

test('V7 pilot builder refuses a retired revision before task construction', () => temporary('v7-pilot-retired', async (temp) => {
  const fixture = await inputs(temp);
  const revisionControlRoot = await retiredRevisionControl(temp);
  let taskBuilds = 0;
  await assert.rejects(buildTerminalV7DevelopmentPilotControl({
    root: ROOT,
    resultRoot: path.join(temp, 'pilot-results'),
    revision: 'r1',
    sealsPath: fixture.sealsPath,
    seedKeyPath: fixture.seedKeyPath,
    revisionControlRoot,
    buildTasks: async () => { taskBuilds += 1; throw new Error('must not build tasks'); },
    validateBaseGates: async () => { throw new Error('must not validate gates after retirement'); },
  }), /revision is retired/);
  assert.equal(taskBuilds, 0);
}));

test('V7 one-unit runner persists one immutable attempt and skips completed work', () => temporary('v7-pilot-runner', async (temp) => {
  const built = await pilotControl(temp);
  const job = built.schedule.jobs[0];
  const unit = terminalV7CalibrationUnitForRunKey({ challenge: built.challenge, schedule: built.schedule, runKey: job.runKey });
  let calls = 0;
  const first = await runTerminalV7CalibrationExecutionUnit({
    challenge: built.challenge,
    schedule: built.schedule,
    unit,
    resultRoot: built.resultRoot,
    challengeRoot: path.join(ROOT, 'benchmark', 'challenges', 'mini-ledger-v7'),
    runTerminalJob: async ({ job: adapterJob }) => { calls += 1; return completedAdapterResult(adapterJob); },
    captureVerifierEvidence: fakeVerifierEvidence,
  });
  assert.equal(first.status, 'completed');
  assert.equal(calls, 1);
  const persisted = JSON.parse(await readFile(path.join(built.resultRoot, 'runs', `${job.runKey}.json`), 'utf8'));
  assert.equal(persisted.resultSha256, canonicalJsonSha256(Object.fromEntries(Object.entries(persisted).filter(([key]) => key !== 'resultSha256'))));
  const attempt = JSON.parse(await readFile(path.join(built.resultRoot, 'attempts', job.runKey, `${persisted.attemptId}.json`), 'utf8'));
  assert.deepEqual(attempt, persisted);
  const second = await runTerminalV7CalibrationExecutionUnit({
    challenge: built.challenge,
    schedule: built.schedule,
    unit,
    resultRoot: built.resultRoot,
    challengeRoot: path.join(ROOT, 'benchmark', 'challenges', 'mini-ledger-v7'),
    runTerminalJob: async () => { calls += 1; throw new Error('must not run'); },
    captureVerifierEvidence: fakeVerifierEvidence,
  });
  assert.equal(second.status, 'skipped');
  assert.equal(calls, 1);

  const currentFile = path.join(built.resultRoot, 'runs', `${job.runKey}.json`);
  await rm(currentFile);
  await link(path.join(built.resultRoot, 'attempts', job.runKey, `${persisted.attemptId}.json`), currentFile);
  const aliased = await collectTerminalV7DevelopmentPilotEvidence({ resultRoot: built.resultRoot });
  assert.ok(aliased.evidenceIssues.some(({ code }) => code === 'invalid-attempt-record'));
}));

test('V7 pilot invocation enforces schedule order and recovers a missing Core-100 marker before later work', () => temporary('v7-pilot-order-saturation', async (temp) => {
  const built = await pilotControl(temp);
  const [firstJob, secondJob, thirdJob] = [...built.schedule.jobs].sort((left, right) => left.executionIndex - right.executionIndex);
  const scoreRun = (run) => ({ corePoints: run.runKey === secondJob.runKey ? 100 : 50 });
  await assert.rejects(assertTerminalV7CalibrationInvocationReady({
    challenge: built.challenge,
    schedule: built.schedule,
    resultRoot: built.resultRoot,
    runKey: secondJob.runKey,
    scoreRun,
    onSaturation: async () => { throw new Error('must not observe saturation before a run exists'); },
  }), new RegExp(`earliest outstanding scheduled run ${firstJob.runKey}`));

  for (const [job, score] of [[firstJob, 50], [secondJob, 100]]) {
    const unit = terminalV7CalibrationUnitForRunKey({ challenge: built.challenge, schedule: built.schedule, runKey: job.runKey });
    const outcome = await runTerminalV7CalibrationExecutionUnit({
      challenge: built.challenge,
      schedule: built.schedule,
      unit,
      resultRoot: built.resultRoot,
      challengeRoot: path.join(ROOT, 'benchmark', 'challenges', 'mini-ledger-v7'),
      runTerminalJob: async ({ job: adapterJob }) => completedAdapterResultAt(adapterJob, score),
      captureVerifierEvidence: fakeVerifierEvidence,
    });
    assert.equal(outcome.status, 'completed');
  }

  const controlRoot = path.join(temp, 'revision-control');
  let recovered = 0;
  await assert.rejects(assertTerminalV7CalibrationInvocationReady({
    challenge: built.challenge,
    schedule: built.schedule,
    resultRoot: built.resultRoot,
    runKey: thirdJob.runKey,
    scoreRun,
    onSaturation: async ({ job, run }) => {
      recovered += 1;
      await ensureTerminalV7RevisionSaturationForRun({
        controlRoot,
        revision: 'r1',
        campaign: 'development-pilot',
        resultRoot: built.resultRoot,
        job,
        run,
        scoreRun,
        detectedAt: '2026-08-08T12:00:00.000Z',
      });
    },
  }), /pending Core-100 saturation audit/);
  assert.equal(recovered, 1);
  assert.equal((await readTerminalV7RevisionStopState({ controlRoot, revision: 'r1', scoreRun })).status, 'saturation-pending');
  await assert.rejects(readFile(path.join(built.resultRoot, 'runs', `${thirdJob.runKey}.json`)), /ENOENT/);
}));

test('V7 calibration rechecks a shared stop immediately before creating an adapter attempt', () => temporary('v7-pilot-boundary-stop', async (temp) => {
  const built = await pilotControl(temp);
  const job = [...built.schedule.jobs].sort((left, right) => left.executionIndex - right.executionIndex)[0];
  const unit = terminalV7CalibrationUnitForRunKey({ challenge: built.challenge, schedule: built.schedule, runKey: job.runKey });
  let calls = 0;
  await assert.rejects(runTerminalV7CalibrationExecutionUnit({
    challenge: built.challenge,
    schedule: built.schedule,
    unit,
    resultRoot: built.resultRoot,
    challengeRoot: path.join(ROOT, 'benchmark', 'challenges', 'mini-ledger-v7'),
    runTerminalJob: async () => { calls += 1; throw new Error('adapter must not start'); },
    captureVerifierEvidence: fakeVerifierEvidence,
    shouldStopBeforeRun: async () => { throw new Error('revision-wide stop appeared'); },
  }), /revision-wide stop appeared/);
  assert.equal(calls, 0);
  await assert.rejects(readFile(path.join(built.resultRoot, 'runs', `${job.runKey}.json`)), /ENOENT/);
  await assert.rejects(readFile(path.join(built.resultRoot, 'work', job.runKey)), /ENOENT|EISDIR/);
}));

test('V7 pilot report is derived from sealed attempts and projects only aggregates into release gates', () => temporary('v7-pilot-report', async (temp) => {
  const built = await pilotControl(temp);
  for (const job of built.schedule.jobs) {
    const unit = terminalV7CalibrationUnitForRunKey({ challenge: built.challenge, schedule: built.schedule, runKey: job.runKey });
    const result = await runTerminalV7CalibrationExecutionUnit({
      challenge: built.challenge,
      schedule: built.schedule,
      unit,
      resultRoot: built.resultRoot,
      challengeRoot: path.join(ROOT, 'benchmark', 'challenges', 'mini-ledger-v7'),
      runTerminalJob: async ({ job: adapterJob }) => completedAdapterResult(adapterJob),
      captureVerifierEvidence: fakeVerifierEvidence,
    });
    assert.equal(result.status, 'completed');
  }
  const completedRunValidator = async () => true;
  const collected = await collectTerminalV7DevelopmentPilotEvidence({ resultRoot: built.resultRoot, completedRunValidator });
  assert.equal(collected.runs.length, 15);
  assert.deepEqual(collected.evidenceIssues, []);
  const report = createTerminalV7DevelopmentPilotReport({
    ...collected,
    scriptedReferences: references(),
    humanTwinValidations: humans(),
    humanTwinArtifactClosure: fakeHumanTwinArtifactClosure(),
    createdAt: '2026-08-08T10:00:00.000Z',
  });
  assert.equal(validateTerminalV7DevelopmentPilotReport(report), report);
  assert.equal(report.accepted, true);
  assert.equal(report.pilot.lunaMaxJobs, 12);
  assert.equal(report.pilot.lunaHighJobs, 3);
  assert.equal(report.pilot.infrastructureInvalid, 0);
  assert.equal(report.privacy.modelTextIncluded, false);
  assert.doesNotMatch(JSON.stringify(report), /sessionId|trajectory|response|toolCalls|stdout|stderr/);
  const privacyTamperUnsigned = structuredClone(Object.fromEntries(Object.entries(report).filter(([key]) => key !== 'reportSha256')));
  privacyTamperUnsigned.privacy.unrecognizedPayload = 'synthetic private payload';
  const privacyTamper = { ...privacyTamperUnsigned, reportSha256: canonicalJsonSha256(privacyTamperUnsigned) };
  assert.throws(() => validateTerminalV7DevelopmentPilotReport(privacyTamper), /privacy keys changed/);
  const emptyCommitmentUnsigned = structuredClone(Object.fromEntries(Object.entries(report).filter(([key]) => key !== 'reportSha256')));
  emptyCommitmentUnsigned.sourceCommitments = {};
  const emptyCommitments = { ...emptyCommitmentUnsigned, reportSha256: canonicalJsonSha256(emptyCommitmentUnsigned) };
  assert.throws(() => validateTerminalV7DevelopmentPilotReport(emptyCommitments), /source commitments keys changed/);
  assert.equal(await assertTerminalV7DevelopmentPilotReportSources({
    resultRoot: built.resultRoot,
    report,
    scriptedReferences: references(),
    humanTwinValidations: humans(),
    completedRunValidator,
    humanTwinArtifactValidator: async ({ rows }) => fakeHumanTwinArtifactClosure(rows),
  }), report);
  const originalReferences = references();
  const { reportSha256: _originalReferenceSha256, ...changedReferenceUnsigned } = originalReferences;
  changedReferenceUnsigned.createdAt = '2026-08-08T09:00:01.000Z';
  const changedReferences = sealTerminalV7ScriptedReferenceReport(changedReferenceUnsigned);
  await assert.rejects(() => assertTerminalV7DevelopmentPilotReportSources({
    resultRoot: built.resultRoot,
    report,
    scriptedReferences: changedReferences,
    humanTwinValidations: humans(),
    completedRunValidator,
    humanTwinArtifactValidator: async ({ rows }) => fakeHumanTwinArtifactClosure(rows),
  }), /not reproducible/);
  const gate = createTerminalV7ReleaseGateEvidenceFromPilot({
    baseEvidence: baseGateEvidence(built.sealManifest),
    pilotReport: report,
    evaluatedAt: '2026-08-08T10:00:00.000Z',
  });
  assert.equal(gate.evaluation.passed, true);
  assert.equal(gate.evidence.pilot.pilotReportSha256, report.reportSha256);
}));

test('V7 pilot production collector strictly validates both clean and decoy task/image bindings', () => temporary('v7-pilot-strict-twins', async (temp) => {
  const built = await pilotControl(temp);
  const instanceId = 'dev-01';
  const jobs = ['clean', 'decoy'].map((variant) => built.schedule.jobs.find((job) => (
    job.instanceId === instanceId && job.instanceVariant === variant && job.model.reasoningEffort === 'max'
  )));
  assert.ok(jobs.every(Boolean));
  for (const job of jobs) {
    const unit = terminalV7CalibrationUnitForRunKey({ challenge: built.challenge, schedule: built.schedule, runKey: job.runKey });
    const result = await runTerminalV7CalibrationExecutionUnit({
      challenge: built.challenge,
      schedule: built.schedule,
      unit,
      resultRoot: built.resultRoot,
      challengeRoot: path.join(ROOT, 'benchmark', 'challenges', 'mini-ledger-v7'),
      runTerminalJob: async ({ job: adapterJob, challenge, runDirectory }) => strictFailedAdapterResult(adapterJob, { challenge, runDirectory }),
    });
    assert.equal(result.status, 'completed');
  }
  const collected = await collectTerminalV7DevelopmentPilotEvidence({ resultRoot: built.resultRoot });
  assert.equal(collected.runs.length, 2);
  assert.deepEqual(collected.evidenceIssues, []);
  assert.deepEqual(new Set(collected.runs.map(({ instanceVariant }) => instanceVariant)), new Set(['clean', 'decoy']));

  await writeFile(path.join(built.resultRoot, 'work', jobs[0].runKey, 'verifier-evidence', 'phase-01', 'source.json'), 'tampered raw verifier source\n');
  const tampered = await collectTerminalV7DevelopmentPilotEvidence({ resultRoot: built.resultRoot });
  assert.ok(tampered.evidenceIssues.some(({ runKey, code }) => runKey === jobs[0].runKey && code === 'strict-completed-run-validation-failed'));
}));

async function releaseFixture() {
  const releasePacks = listV7Packs({ pool: 'release', variant: 'decoy' }).map((pack) => sealV7Pack(pack, { seedKey: KEY }));
  const baseChallenge = createTerminalV7Challenge({
    protocolRevision: 'r1',
    instances: releasePacks,
    promptSha256: 'a'.repeat(64),
    publicVerifierSha256: 'b'.repeat(64),
    hiddenVerifierSha256: 'c'.repeat(64),
    adaptabilityVerifierSha256: 'd'.repeat(64),
  });
  const { challengeId: _challengeId, challengeSha256: _challengeSha256, ...descriptor } = baseChallenge;
  const hostUnsigned = { schemaVersion: 'agentbattler.terminal-v7-execution-host.v1', role: 'm4-pro-execution-host', platform: 'darwin', architecture: 'arm64', chip: 'Apple M4 Pro', modelIdentifier: 'Mac16,8' };
  const adapters = { dispatcher: { path: 'scripts/terminal-adapter-all.mjs', sha256: '9'.repeat(64) } };
  const extended = {
    ...descriptor,
    execution: {
      runtimeImages: await dotAgentsRuntimeImages(),
      executionHost: { ...hostUnsigned, identitySha256: canonicalJsonSha256(hostUnsigned) },
      adapters,
      commitments: { reviewedCommit: '1'.repeat(40), sourceSetSha256: canonicalJsonSha256(adapters) },
    },
  };
  const challengeSha256 = canonicalJsonSha256(extended);
  const challenge = { ...extended, challengeId: `challenge-${challengeSha256.slice(0, 16)}`, challengeSha256 };
  const harnesses = [
    { id: 'codex-cli', version: 'test-codex' },
    { id: 'pi-coding-agent', version: 'test-pi' },
    { id: 'claude-code', version: 'test-claude' },
    { id: 'dotagents-mono', version: 'test-dotagents' },
    { id: 'factory-droid', version: 'test-droid' },
  ];
  const schedule = createTerminalV7Schedule({ challenge, harnesses, model: { id: 'gpt-5.6-luna', familyId: 'luna', reasoningEffort: 'max' }, seed: 2 });
  const values = { 'codex-cli': 70, 'pi-coding-agent': 70, 'claude-code': 55, 'dotagents-mono': 50, 'factory-droid': 45 };
  const results = schedule.jobs.map((job) => {
    const unsigned = { ...job, status: 'completed', validity: 'valid', evaluation: evaluation(values[job.harness.id]) };
    return { ...unsigned, resultSha256: canonicalJsonSha256(unsigned) };
  });
  return { challenge, schedule, results };
}

test('V7 source closure binds every V7 CLI/module plus all harness adapters and Harbor control bytes', async () => {
  const commitments = await terminalV7CalibrationSourceCommitments({ root: ROOT });
  const paths = new Set(Object.values(commitments).map(({ path: sourcePath }) => sourcePath));
  const v7Scripts = (await readdir(path.join(ROOT, 'scripts')))
    .filter((name) => name.includes('v7') && name.endsWith('.mjs'))
    .map((name) => `scripts/${name}`);
  const v7Modules = (await readdir(path.join(ROOT, 'src')))
    .filter((name) => name.startsWith('terminal-v7') && name.endsWith('.mjs'))
    .map((name) => `src/${name}`);
  for (const required of [
    ...v7Scripts,
    ...v7Modules,
    'package.json',
    'scripts/terminal-adapter-all.mjs',
    'scripts/terminal-adapter-harbor.mjs',
    'scripts/terminal-adapter-codex.mjs',
    'scripts/terminal-adapter-pi.mjs',
    'scripts/terminal-adapter-claude.mjs',
    'scripts/terminal-adapter-dotagents.mjs',
    'scripts/terminal-adapter-droid.mjs',
    'benchmark/harbor/v7_control.py',
    'src/terminal-challenge.mjs',
    'src/terminal-prompts.mjs',
  ]) assert.equal(paths.has(required), true, `source closure omitted ${required}`);
  assert.equal(paths.size, Object.keys(commitments).length);
  assert.ok(Object.values(commitments).every(({ sha256: digest }) => /^[0-9a-f]{64}$/.test(digest)));
});

test('V7 reserve builder uses the strict release pair but never model-selects reserve packs', () => temporary('v7-reserve-build', async (temp) => {
  const fixture = await inputs(temp);
  const release = await releaseFixture();
  const resultRoot = path.join(temp, 'reserve-results');
  const built = await buildTerminalV7ReserveControl({
    root: ROOT,
    resultRoot,
    revision: 'r1',
    sealManifest: fixture.sealManifest,
    seedKey: KEY,
    releaseChallenge: release.challenge,
    releaseSchedule: release.schedule,
    releaseResults: release.results,
    seed: 3,
    buildTasks: fakeTaskBuilder(),
    buildTaskImages: fakeTaskImages,
    inspectVerifierImage: async () => verifierImage(),
  });
  assert.equal(built.schedule.jobs.length, 10);
  assert.deepEqual(built.challenge.selection.leadingPairHarnessIds, ['codex-cli', 'pi-coding-agent']);
  assert.deepEqual(built.schedule.matrix.instanceIds, ['reserve-01', 'reserve-02', 'reserve-03', 'reserve-04', 'reserve-05']);
  assert.equal(built.challenge.packSelection.rule, 'all-presealed-reserve-packs');
  assert.equal(built.challenge.packSelection.selectionFromModelFailures, 'forbidden');
  assert.ok(built.schedule.jobs.every((job) => job.instanceVariant === 'decoy'));
  assert.deepEqual(built.challenge.execution.runtimeImages, await dotAgentsRuntimeImages());
  assert.doesNotMatch(JSON.stringify(built.challenge), new RegExp(KEY));

  const saturatedResults = structuredClone(release.results);
  const { resultSha256: _oldResultSha256, ...saturatedUnsigned } = saturatedResults[0];
  saturatedUnsigned.evaluation = evaluation(100);
  saturatedResults[0] = { ...saturatedUnsigned, resultSha256: canonicalJsonSha256(saturatedUnsigned) };
  let reserveTaskBuilds = 0;
  await assert.rejects(buildTerminalV7ReserveControl({
    root: ROOT,
    resultRoot: path.join(temp, 'reserve-blocked-by-release-saturation'),
    revision: 'r1',
    sealManifest: fixture.sealManifest,
    seedKey: KEY,
    releaseChallenge: release.challenge,
    releaseSchedule: release.schedule,
    releaseResults: saturatedResults,
    revisionControlRoot: path.join(temp, 'active-revision-control'),
    buildTasks: async () => { reserveTaskBuilds += 1; throw new Error('must not build reserve tasks'); },
  }), /refuses a release Core-100 result/);
  assert.equal(reserveTaskBuilds, 0);
}));

function strictReleaseVerification(release) {
  const byRunKey = new Map(release.results.map((run) => [run.runKey, run]));
  const scoredRuns = release.schedule.jobs.map((job) => {
    const run = byRunKey.get(job.runKey);
    return { job, run, score: scoreTerminalV7Run(run, release.challenge) };
  });
  const pairedAnalysis = analyzeTerminalV7PairedPacks(scoredRuns.map(({ job, score }) => ({ harnessId: job.harness.id, instanceId: job.instanceId, score })), { challenge: release.challenge });
  const summaryUnsigned = { pairedAnalysis };
  return {
    challenge: release.challenge,
    schedule: release.schedule,
    scoredRuns,
    summary: { ...summaryUnsigned, summarySha256: canonicalJsonSha256(summaryUnsigned) },
    officialMatrixVerified: true,
    officialEvidenceSha256: canonicalJsonSha256({ challenge: release.challenge.challengeSha256, schedule: release.schedule.scheduleSha256, pairedAnalysis }),
    terminalVerified: false,
  };
}

test('V7 reserve final report combines five release and five reserve clusters without exporting run content', () => temporary('v7-reserve-final-report', async (temp) => {
  const fixture = await inputs(temp);
  const release = await releaseFixture();
  const resultRoot = path.join(temp, 'reserve-results');
  const built = await buildTerminalV7ReserveControl({
    root: ROOT,
    resultRoot,
    revision: 'r1',
    sealManifest: fixture.sealManifest,
    seedKey: KEY,
    releaseChallenge: release.challenge,
    releaseSchedule: release.schedule,
    releaseResults: release.results,
    seed: 4,
    buildTasks: fakeTaskBuilder(),
    buildTaskImages: fakeTaskImages,
    inspectVerifierImage: async () => verifierImage(),
  });
  for (const job of built.schedule.jobs) {
    const unit = terminalV7CalibrationUnitForRunKey({ challenge: built.challenge, schedule: built.schedule, runKey: job.runKey });
    await runTerminalV7CalibrationExecutionUnit({
      challenge: built.challenge,
      schedule: built.schedule,
      unit,
      resultRoot,
      challengeRoot: path.join(ROOT, 'benchmark', 'challenges', 'mini-ledger-v7'),
      runTerminalJob: async ({ job: adapterJob }) => completedAdapterResultAt(adapterJob, adapterJob.harness === 'codex-cli' ? 82 : 70),
      captureVerifierEvidence: fakeVerifierEvidence,
    });
  }
  let strictValidations = 0;
  const reserveEvidence = await collectTerminalV7ReserveEvidence({
    resultRoot,
    validateCompletedRun: async () => { strictValidations += 1; },
  });
  assert.equal(strictValidations, 10);
  await assert.rejects(
    collectTerminalV7ReserveEvidence({ resultRoot, seedKey: KEY }),
    /harness identity|zero-capability|candidate-tree|requirement/i,
    'the production collector must reject these deliberately reduced synthetic run records',
  );
  assert.equal(reserveEvidence.scoredRuns.length, 10);
  const report = createTerminalV7ReserveFinalReport({
    releaseVerification: strictReleaseVerification(release),
    reserveEvidence,
    createdAt: '2026-08-08T12:00:00.000Z',
  });
  assert.equal(validateTerminalV7ReserveFinalReport(report), report);
  assert.equal(report.matrix.combinedClusters, 10);
  assert.equal(report.operational.release.runs, 25);
  assert.equal(report.operational.reserve.runs, 10);
  assert.equal(report.operational.combined.runs, 35);
  assert.equal(report.comparison.bootstrap.resamples, 10_000);
  assert.equal(report.comparison.meanDifference, 6);
  assert.equal(report.comparison.decision, 'practical-win');
  assert.equal(report.winnerHarnessId, 'codex-cli');
  assert.doesNotMatch(JSON.stringify(report), /sessionId|trajectory|response|toolCalls|stdout|stderr/);
  const privacyTamperUnsigned = structuredClone(Object.fromEntries(Object.entries(report).filter(([key]) => key !== 'reportSha256')));
  privacyTamperUnsigned.privacy.unrecognizedPayload = 'synthetic private payload';
  const privacyTamper = { ...privacyTamperUnsigned, reportSha256: canonicalJsonSha256(privacyTamperUnsigned) };
  assert.throws(() => validateTerminalV7ReserveFinalReport(privacyTamper), /privacy keys changed/);
  const emptyCommitmentUnsigned = structuredClone(Object.fromEntries(Object.entries(report).filter(([key]) => key !== 'reportSha256')));
  emptyCommitmentUnsigned.sourceCommitments = {};
  const emptyCommitments = { ...emptyCommitmentUnsigned, reportSha256: canonicalJsonSha256(emptyCommitmentUnsigned) };
  assert.throws(() => validateTerminalV7ReserveFinalReport(emptyCommitments), /source commitments keys changed/);
}));

test('V7 reserve production collector resolves instance-hash task bindings without an injected validator', () => temporary('v7-reserve-strict-bindings', async (temp) => {
  const fixture = await inputs(temp);
  const release = await releaseFixture();
  const resultRoot = path.join(temp, 'reserve-results');
  const built = await buildTerminalV7ReserveControl({
    root: ROOT,
    resultRoot,
    revision: 'r1',
    sealManifest: fixture.sealManifest,
    seedKey: KEY,
    releaseChallenge: release.challenge,
    releaseSchedule: release.schedule,
    releaseResults: release.results,
    seed: 6,
    buildTasks: fakeTaskBuilder(),
    buildTaskImages: fakeTaskImages,
    inspectVerifierImage: async () => verifierImage(),
  });
  for (const job of built.schedule.jobs) {
    const unit = terminalV7CalibrationUnitForRunKey({ challenge: built.challenge, schedule: built.schedule, runKey: job.runKey });
    const result = await runTerminalV7CalibrationExecutionUnit({
      challenge: built.challenge,
      schedule: built.schedule,
      unit,
      resultRoot,
      challengeRoot: path.join(ROOT, 'benchmark', 'challenges', 'mini-ledger-v7'),
      runTerminalJob: async ({ job: adapterJob, challenge, runDirectory }) => strictFailedAdapterResult(adapterJob, { challenge, runDirectory, seedKey: KEY }),
    });
    assert.equal(result.status, 'completed');
  }
  const reserveEvidence = await collectTerminalV7ReserveEvidence({ resultRoot, seedKey: KEY });
  assert.equal(reserveEvidence.scoredRuns.length, 10);
  assert.ok(reserveEvidence.scoredRuns.every(({ score }) => score.corePoints === 0 && score.exact === false));

  const first = reserveEvidence.scoredRuns[0];
  const currentFile = path.join(resultRoot, 'runs', `${first.job.runKey}.json`);
  const attemptFile = path.join(resultRoot, 'attempts', first.job.runKey, `${first.run.attemptId}.json`);
  await rm(currentFile);
  await link(attemptFile, currentFile);
  await assert.rejects(
    collectTerminalV7ReserveEvidence({ resultRoot, seedKey: KEY }),
    /single-link|distinct files/,
  );
}));

test('V7 reserve production collector recomputes and rejects a consistently archived forged final score', () => temporary('v7-reserve-recompute', async (temp) => {
  const fixture = await inputs(temp);
  const release = await releaseFixture();
  const resultRoot = path.join(temp, 'reserve-results');
  const built = await buildTerminalV7ReserveControl({
    root: ROOT,
    resultRoot,
    revision: 'r1',
    sealManifest: fixture.sealManifest,
    seedKey: KEY,
    releaseChallenge: release.challenge,
    releaseSchedule: release.schedule,
    releaseResults: release.results,
    seed: 7,
    buildTasks: fakeTaskBuilder(),
    buildTaskImages: fakeTaskImages,
    inspectVerifierImage: async () => verifierImage(),
  });
  for (const [index, job] of built.schedule.jobs.entries()) {
    const unit = terminalV7CalibrationUnitForRunKey({ challenge: built.challenge, schedule: built.schedule, runKey: job.runKey });
    await runTerminalV7CalibrationExecutionUnit({
      challenge: built.challenge,
      schedule: built.schedule,
      unit,
      resultRoot,
      challengeRoot: path.join(ROOT, 'benchmark', 'challenges', 'mini-ledger-v7'),
      runTerminalJob: async ({ job: adapterJob, challenge, runDirectory }) => strictFailedAdapterResult(adapterJob, {
        challenge,
        runDirectory,
        seedKey: KEY,
        forgeFinal: index === 0,
      }),
    });
  }
  await assert.rejects(
    collectTerminalV7ReserveEvidence({ resultRoot, seedKey: KEY }),
    /final score provenance does not recompute/,
  );
}));

test('V7 reserve runner persists a Core-100 audit and never starts the next job', () => temporary('v7-reserve-saturation', async (temp) => {
  const fixture = await inputs(temp);
  const release = await releaseFixture();
  const resultRoot = path.join(temp, 'reserve-results');
  const built = await buildTerminalV7ReserveControl({
    root: ROOT,
    resultRoot,
    revision: 'r1',
    sealManifest: fixture.sealManifest,
    seedKey: KEY,
    releaseChallenge: release.challenge,
    releaseSchedule: release.schedule,
    releaseResults: release.results,
    seed: 5,
    buildTasks: fakeTaskBuilder(),
    buildTaskImages: fakeTaskImages,
    inspectVerifierImage: async () => verifierImage(),
  });
  let calls = 0;
  const revisionControlRoot = path.join(temp, 'revision-control');
  const first = await runTerminalV7ReserveSchedule({
    challenge: built.challenge,
    schedule: built.schedule,
    resultRoot,
    challengeRoot: path.join(ROOT, 'benchmark', 'challenges', 'mini-ledger-v7'),
    runTerminalJob: async ({ job }) => { calls += 1; return completedAdapterResultAt(job, 100); },
    captureVerifierEvidence: fakeVerifierEvidence,
    revisionControlRoot,
  });
  assert.equal(first.status, 'saturation-paused');
  assert.equal(first.attemptedJobs, 1);
  assert.equal(calls, 1);
  const marker = JSON.parse(await readFile(path.join(revisionControlRoot, 'saturation-audit.json'), 'utf8'));
  assert.equal(marker.detectedCore, 100);
  const second = await runTerminalV7ReserveSchedule({
    challenge: built.challenge,
    schedule: built.schedule,
    resultRoot,
    challengeRoot: path.join(ROOT, 'benchmark', 'challenges', 'mini-ledger-v7'),
    runTerminalJob: async () => { calls += 1; throw new Error('must not run after saturation'); },
    captureVerifierEvidence: fakeVerifierEvidence,
    revisionControlRoot,
  });
  assert.equal(second.status, 'saturation-paused');
  assert.equal(second.attemptedJobs, 0);
  assert.equal(calls, 1);
}));

test('V7 reserve runner observes a revision-global retirement before the next job boundary', () => temporary('v7-reserve-boundary-retirement', async (temp) => {
  const fixture = await inputs(temp);
  const release = await releaseFixture();
  const resultRoot = path.join(temp, 'reserve-results');
  const built = await buildTerminalV7ReserveControl({
    root: ROOT,
    resultRoot,
    revision: 'r1',
    sealManifest: fixture.sealManifest,
    seedKey: KEY,
    releaseChallenge: release.challenge,
    releaseSchedule: release.schedule,
    releaseResults: release.results,
    seed: 5,
    buildTasks: fakeTaskBuilder(),
    buildTaskImages: fakeTaskImages,
    inspectVerifierImage: async () => verifierImage(),
  });
  const revisionControlRoot = path.join(temp, 'revision-control');
  let calls = 0;
  const outcome = await runTerminalV7ReserveSchedule({
    challenge: built.challenge,
    schedule: built.schedule,
    resultRoot,
    challengeRoot: path.join(ROOT, 'benchmark', 'challenges', 'mini-ledger-v7'),
    runTerminalJob: async ({ job }) => {
      calls += 1;
      if (calls === 1) await retiredRevisionControl(temp);
      return completedAdapterResultAt(job, 70);
    },
    captureVerifierEvidence: fakeVerifierEvidence,
    revisionControlRoot,
  });
  assert.equal(outcome.status, 'retirement-paused');
  assert.equal(outcome.attemptedJobs, 1);
  assert.equal(outcome.processedJobs, 1);
  assert.equal(calls, 1);
}));
