import { canonicalJson, canonicalJsonSha256 } from './provenance.mjs';
import { validateTerminalV7ExecutionBinding } from './terminal-v7-execution-identity.mjs';

export const TERMINAL_V7_CHALLENGE_SCHEMA = 'agentbattler.terminal-challenge.v2';
export const TERMINAL_V7_INSTANCE_SCHEMA = 'agentbattler.terminal-instance.v1';
export const TERMINAL_V7_SCHEDULE_SCHEMA = 'agentbattler.terminal-schedule.v2';
export const TERMINAL_V7_RUN_SCHEMA = 'agentbattler.terminal-run.v1';
export const TERMINAL_V7_SCORE_SCHEMA = 'agentbattler.terminal-v7-score.v1';
export const TERMINAL_V7_ANALYSIS_SCHEMA = 'agentbattler.terminal-v7-paired-analysis.v1';
export const TERMINAL_V7_SEALED_PACK_SCHEMA = 'agentbattler.mini-ledger-v7.sealed-pack.v1';

export const TERMINAL_V7_BOOTSTRAP_RESAMPLES = 10_000;
export const TERMINAL_V7_PRACTICAL_WIN_POINTS = 5;
export const TERMINAL_V7_DEFAULT_BOOTSTRAP_SEED = 0x7e57c0de;

export const MINI_LEDGER_V7_PHASE_IDS = Object.freeze([
  'legacy-migration',
  'batch-pagination',
  'concurrent-lifecycle',
  'incident-evidence',
  'recovery-scale',
]);

export const MINI_LEDGER_V7_FAMILIES = Object.freeze([
  'migration-compatibility',
  'idempotency-pagination',
  'concurrency-atomicity',
  'crash-recovery',
  'audit-replay-scale',
]);

export const MINI_LEDGER_V7_INSTANCE_VARIANTS = Object.freeze({
  release: Object.freeze({ id: 'decoy', eligibility: 'scored-release' }),
  cleanTwin: Object.freeze({ id: 'clean', eligibility: 'calibration-only' }),
});

export const TERMINAL_V7_SCORING = Object.freeze({
  core: Object.freeze({ publicPoints: 20, hiddenPoints: 80, maxPoints: 100 }),
  exact: Object.freeze({ definition: 'all-public-and-hidden-checks-pass' }),
  adaptability: Object.freeze({ minPoints: 0, maxPoints: 15 }),
  proxyGap: Object.freeze({ definition: 'normalized-public-score-minus-hidden-composed-score', unit: 'percentage-points' }),
});

const SHA256_RE = /^[0-9a-f]{64}$/;
const UINT32_MAX = 0xffff_ffff;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function nonEmpty(value, label) {
  invariant(typeof value === 'string' && value.length > 0, `${label} is required`);
  return value;
}

function sha256Digest(value, label) {
  invariant(typeof value === 'string' && SHA256_RE.test(value), `${label} must be a lowercase SHA-256 digest`);
  return value;
}

function uint32(value, label) {
  invariant(Number.isSafeInteger(value) && value >= 0 && value <= UINT32_MAX, `${label} must be a uint32`);
  return value;
}

function seal(prefix, descriptor) {
  const hash = canonicalJsonSha256(descriptor);
  return { ...descriptor, [`${prefix}Sha256`]: hash, [`${prefix}Id`]: `${prefix}-${hash.slice(0, 16)}` };
}

function sealInstance(descriptor) {
  return { ...descriptor, instanceSha256: canonicalJsonSha256(descriptor) };
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function sameMembers(left, right) {
  return left.length === right.length && new Set(left).size === left.length
    && new Set(right).size === right.length && left.every((value) => right.includes(value));
}

function validateCommitments(commitments) {
  invariant(commitments && typeof commitments === 'object' && !Array.isArray(commitments), 'Instance commitments must be an object');
  for (const [name, digest] of Object.entries(commitments)) {
    nonEmpty(name, 'Instance commitment name');
    sha256Digest(digest, `Instance commitment ${name}`);
  }
  return commitments;
}

export function createTerminalV7InstanceDescriptor({
  key,
  instanceId = key,
  ordinal,
  seed,
  phaseOrder = MINI_LEDGER_V7_PHASE_IDS,
  commitments = {},
} = {}) {
  nonEmpty(key, 'Instance key');
  nonEmpty(instanceId, 'Instance ID');
  invariant(Number.isSafeInteger(ordinal) && ordinal >= 1 && ordinal <= 5, 'Instance ordinal must be in [1, 5]');
  uint32(seed, 'Instance seed');
  invariant(canonicalJson(phaseOrder) === canonicalJson(MINI_LEDGER_V7_PHASE_IDS), 'Instance phases must preserve the canonical V7 order');
  validateCommitments(commitments);
  return sealInstance({
    schemaVersion: TERMINAL_V7_INSTANCE_SCHEMA,
    benchmarkId: 'terminal-mini-ledger-v7',
    source: 'placeholder',
    instanceId,
    key,
    ordinal,
    clusterId: `mini-ledger-v7-pack-${String(ordinal).padStart(2, '0')}`,
    generator: {
      id: 'mini-ledger-v7-instance-generator',
      version: 1,
      seed,
      seedFingerprint: canonicalJsonSha256({ benchmarkId: 'terminal-mini-ledger-v7', instanceId, seed }),
    },
    phaseOrder: [...phaseOrder],
    randomization: {
      identifiers: 'seeded',
      payloads: 'seeded',
      faultBoundaries: 'seeded',
      interleavings: 'seeded',
      artifactNames: 'seeded',
      guidanceContent: 'seeded-byte-identical-within-instance-variant',
    },
    variants: {
      release: { ...MINI_LEDGER_V7_INSTANCE_VARIANTS.release },
      cleanTwin: { ...MINI_LEDGER_V7_INSTANCE_VARIANTS.cleanTwin },
    },
    disclosure: 'private-until-retirement',
    commitments: { ...commitments },
  });
}

function releaseOrdinal(instanceId) {
  const match = /^release-0([1-5])$/.exec(instanceId);
  invariant(match, `Unexpected V7 release instance ID: ${instanceId}`);
  return Number(match[1]);
}

function releasePackCommitments(pack) {
  invariant(pack?.schemaVersion === TERMINAL_V7_SEALED_PACK_SCHEMA, 'V7 release pack must use the sealed-pack schema');
  invariant(pack.challengeId === 'terminal-mini-ledger-v7' && pack.pool === 'release', 'V7 challenge accepts only release-pool packs');
  invariant(pack.variant === 'decoy' && pack.twinVariant === 'clean', 'V7 release packs must be decoy variants with clean twins');
  nonEmpty(pack.scenarioId, 'V7 release scenario ID');
  for (const [field, value] of [
    ['packSha256', pack.packSha256],
    ['sealSha256', pack.sealSha256],
    ['seedFingerprint', pack.seedFingerprint],
    ['starterTreeSha256', pack.starterTreeSha256],
    ['requirementsSha256', pack.requirementsSha256],
    ['requirementMapSha256', pack.requirementMapSha256],
    ['hiddenMerkleRoot', pack.hiddenMerkleRoot],
    ['twinRelationSha256', pack.twinRelationSha256],
  ]) sha256Digest(value, `V7 release ${field}`);
  invariant(pack.perPhaseLimitMs === 1_500_000, 'V7 release per-phase limit changed');
  invariant(pack.feedbackPolicy === 'self-service-public-only', 'V7 release feedback policy changed');
  invariant(pack.rubricVersion === 'mini-ledger-v7-r1', 'V7 release rubric version changed');
  invariant(pack.artifactPolicy?.maxFiles === 256 && pack.artifactPolicy?.maxBytes === 4 * 1024 * 1024 && pack.artifactPolicy?.regularFilesOnly === true, 'V7 release artifact policy is invalid');
  invariant(canonicalJson(pack.artifactPolicy.sourceAllowlist) === canonicalJson(['package.json', 'bin/**', 'src/**', 'config/**']), 'V7 release source allowlist changed');
  invariant(canonicalJson(pack.artifactPolicy.declaredResponseAllowlist) === canonicalJson(['incident-response.json']), 'V7 release response allowlist changed');
  invariant(pack.verifierHashes && typeof pack.verifierHashes === 'object' && !Array.isArray(pack.verifierHashes), 'V7 release verifier hashes are missing');
  for (const name of ['public', 'private', 'adaptability']) sha256Digest(pack.verifierHashes[name], `V7 release ${name} verifier hash`);
  invariant(Number.isSafeInteger(pack.hiddenCaseCount) && pack.hiddenCaseCount > 0, 'V7 release hidden case count is invalid');
  invariant(Array.isArray(pack.phases) && pack.phases.length === 5, 'V7 release pack must contain five phase descriptors');
  const phases = pack.phases.map((phase, index) => {
    invariant(phase.phase === index + 1 && phase.id === MINI_LEDGER_V7_PHASE_IDS[index], `V7 release phase ${index + 1} is invalid`);
    sha256Digest(phase.ticketSha256, `V7 release phase ${index + 1} ticket hash`);
    sha256Digest(phase.publicSmokeSha256, `V7 release phase ${index + 1} public smoke hash`);
    sha256Digest(phase.phaseDeltaSha256, `V7 release phase ${index + 1} delta hash`);
    return {
      phase: phase.phase,
      id: phase.id,
      ticketSha256: phase.ticketSha256,
      publicSmokeSha256: phase.publicSmokeSha256,
      phaseDeltaSha256: phase.phaseDeltaSha256,
    };
  });
  invariant(Array.isArray(pack.phaseDeltaSha256)
    && canonicalJson(pack.phaseDeltaSha256) === canonicalJson(phases.map(({ phaseDeltaSha256 }) => phaseDeltaSha256)), 'V7 release phase-delta commitments are invalid');
  const expectedSeal = canonicalJsonSha256({
    packSha256: pack.packSha256,
    starterTreeSha256: pack.starterTreeSha256,
    phaseDeltaSha256: pack.phaseDeltaSha256,
    requirementsSha256: pack.requirementsSha256,
    requirementMapSha256: pack.requirementMapSha256,
    perPhaseLimitMs: pack.perPhaseLimitMs,
    artifactPolicy: pack.artifactPolicy,
    verifierHashes: pack.verifierHashes,
    rubricVersion: pack.rubricVersion,
    feedbackPolicy: pack.feedbackPolicy,
    twinRelationSha256: pack.twinRelationSha256,
    hiddenMerkleRoot: pack.hiddenMerkleRoot,
  });
  invariant(pack.sealSha256 === expectedSeal, 'V7 release pack seal does not bind its committed fields');
  return {
    schemaVersion: pack.schemaVersion,
    packSha256: pack.packSha256,
    sealSha256: pack.sealSha256,
    seedFingerprint: pack.seedFingerprint,
    starterTreeSha256: pack.starterTreeSha256,
    requirementsSha256: pack.requirementsSha256,
    requirementMapSha256: pack.requirementMapSha256,
    perPhaseLimitMs: pack.perPhaseLimitMs,
    artifactPolicy: {
      ...pack.artifactPolicy,
      sourceAllowlist: [...pack.artifactPolicy.sourceAllowlist],
      declaredResponseAllowlist: [...pack.artifactPolicy.declaredResponseAllowlist],
    },
    verifierHashes: { ...pack.verifierHashes },
    rubricVersion: pack.rubricVersion,
    feedbackPolicy: pack.feedbackPolicy,
    phases,
    phaseDeltaSha256: [...pack.phaseDeltaSha256],
    hiddenMerkleRoot: pack.hiddenMerkleRoot,
    hiddenCaseCount: pack.hiddenCaseCount,
    twinRelationSha256: pack.twinRelationSha256,
  };
}

export function createTerminalV7InstanceDescriptorFromPack(pack) {
  const ordinal = releaseOrdinal(pack?.instanceId);
  const packCommitments = releasePackCommitments(pack);
  return sealInstance({
    schemaVersion: TERMINAL_V7_INSTANCE_SCHEMA,
    benchmarkId: 'terminal-mini-ledger-v7',
    source: 'sealed-release-pack',
    instanceId: pack.instanceId,
    key: pack.instanceId,
    ordinal,
    clusterId: pack.instanceId,
    scenarioId: pack.scenarioId,
    generator: {
      id: 'mini-ledger-v7-sealed-pack',
      version: 1,
      seedFingerprint: pack.seedFingerprint,
    },
    phaseOrder: [...MINI_LEDGER_V7_PHASE_IDS],
    randomization: {
      identifiers: 'seeded',
      payloads: 'seeded',
      faultBoundaries: 'seeded',
      interleavings: 'seeded',
      artifactNames: 'seeded',
      guidanceContent: 'seeded-byte-identical-within-instance-variant',
    },
    variants: {
      release: { ...MINI_LEDGER_V7_INSTANCE_VARIANTS.release },
      cleanTwin: { ...MINI_LEDGER_V7_INSTANCE_VARIANTS.cleanTwin },
    },
    disclosure: 'private-until-retirement',
    packCommitments,
  });
}

export function validateTerminalV7InstanceDescriptor(instance) {
  invariant(instance?.schemaVersion === TERMINAL_V7_INSTANCE_SCHEMA, 'Unsupported V7 instance schema');
  const { instanceSha256, ...descriptor } = instance;
  const actual = canonicalJsonSha256(descriptor);
  invariant(instanceSha256 === actual, 'V7 instance hash mismatch');
  invariant(instance.benchmarkId === 'terminal-mini-ledger-v7', 'Unexpected V7 instance benchmark ID');
  nonEmpty(instance.instanceId, 'Instance ID');
  nonEmpty(instance.key, 'Instance key');
  invariant(Number.isSafeInteger(instance.ordinal) && instance.ordinal >= 1 && instance.ordinal <= 5, 'V7 instance ordinal is invalid');
  sha256Digest(instance.generator?.seedFingerprint, 'V7 instance seed fingerprint');
  invariant(canonicalJson(instance.phaseOrder) === canonicalJson(MINI_LEDGER_V7_PHASE_IDS), 'V7 instance phase order is invalid');
  invariant(canonicalJson(instance.variants?.release) === canonicalJson(MINI_LEDGER_V7_INSTANCE_VARIANTS.release), 'V7 release instance variant is invalid');
  invariant(canonicalJson(instance.variants?.cleanTwin) === canonicalJson(MINI_LEDGER_V7_INSTANCE_VARIANTS.cleanTwin), 'V7 clean-twin instance variant is invalid');
  invariant(instance.disclosure === 'private-until-retirement', 'V7 instance disclosure policy is invalid');
  if (instance.source === 'placeholder') {
    invariant(instance.clusterId === `mini-ledger-v7-pack-${String(instance.ordinal).padStart(2, '0')}`, 'V7 placeholder cluster ID is invalid');
    invariant(instance.generator.id === 'mini-ledger-v7-instance-generator' && instance.generator.version === 1, 'V7 placeholder generator is invalid');
    uint32(instance.generator.seed, 'V7 instance seed');
    invariant(instance.generator.seedFingerprint === canonicalJsonSha256({ benchmarkId: 'terminal-mini-ledger-v7', instanceId: instance.instanceId, seed: instance.generator.seed }), 'V7 placeholder seed fingerprint mismatch');
    validateCommitments(instance.commitments);
  } else {
    invariant(instance.source === 'sealed-release-pack', 'V7 instance source is invalid');
    invariant(instance.instanceId === `release-${String(instance.ordinal).padStart(2, '0')}` && instance.key === instance.instanceId && instance.clusterId === instance.instanceId, 'V7 release instance identity is invalid');
    invariant(instance.generator.id === 'mini-ledger-v7-sealed-pack' && instance.generator.version === 1, 'V7 release generator is invalid');
    invariant(instance.generator.seedFingerprint === instance.packCommitments?.seedFingerprint, 'V7 release seed fingerprint mismatch');
    const reconstructedPack = {
      ...instance.packCommitments,
      challengeId: 'terminal-mini-ledger-v7',
      pool: 'release',
      variant: 'decoy',
      twinVariant: 'clean',
      instanceId: instance.instanceId,
      scenarioId: instance.scenarioId,
    };
    releasePackCommitments(reconstructedPack);
  }
  return instance;
}

export const MINI_LEDGER_V7_INSTANCES = deepFreeze([
  ['pack-01', 1, 0x5a17_c001],
  ['pack-02', 2, 0x5a17_c102],
  ['pack-03', 3, 0x5a17_c203],
  ['pack-04', 4, 0x5a17_c304],
  ['pack-05', 5, 0x5a17_c405],
].map(([key, ordinal, seed]) => createTerminalV7InstanceDescriptor({ key, ordinal, seed })));

function validateFiveInstances(instances) {
  invariant(Array.isArray(instances) && instances.length === 5, 'V7 requires exactly five sealed instances');
  instances.forEach(validateTerminalV7InstanceDescriptor);
  invariant(new Set(instances.map(({ instanceId }) => instanceId)).size === 5, 'V7 instance IDs must be unique');
  invariant(new Set(instances.map(({ key }) => key)).size === 5, 'V7 instance keys must be unique');
  invariant(new Set(instances.map(({ clusterId }) => clusterId)).size === 5, 'V7 instance cluster IDs must be unique');
  invariant(new Set(instances.map(({ generator }) => generator.seedFingerprint)).size === 5, 'V7 instance seed fingerprints must be unique');
  invariant(sameMembers(instances.map(({ ordinal }) => ordinal), [1, 2, 3, 4, 5]), 'V7 instance ordinals must cover [1, 5]');
  return instances;
}

function normalizeReleaseInstances(instances) {
  invariant(Array.isArray(instances), 'V7 release instances are required');
  const normalized = instances.map((instance) => (
    instance?.schemaVersion === TERMINAL_V7_SEALED_PACK_SCHEMA
      ? createTerminalV7InstanceDescriptorFromPack(instance)
      : instance
  )).sort((left, right) => left.ordinal - right.ordinal);
  validateFiveInstances(normalized);
  invariant(normalized.every(({ source }) => source === 'sealed-release-pack'), 'V7 challenges require five sealed release-pack descriptors; placeholders are calibration-only');
  invariant(canonicalJson(normalized.map(({ instanceId }) => instanceId)) === canonicalJson(['release-01', 'release-02', 'release-03', 'release-04', 'release-05']), 'V7 challenge release instance set is invalid');
  return normalized;
}

export function createTerminalV7Challenge({
  id = 'terminal-mini-ledger-v7',
  title = 'Mini Ledger v7',
  protocolRevision = 'r1',
  promptPath = 'benchmark/challenges/mini-ledger-v7.md',
  promptSha256,
  publicVerifierPath = 'benchmark/challenges/mini-ledger-v7/public-verifier.mjs',
  publicVerifierSha256,
  hiddenVerifierPath = 'benchmark/challenges/mini-ledger-v7/hidden-verifier.mjs',
  hiddenVerifierSha256,
  adaptabilityVerifierPath = 'benchmark/challenges/mini-ledger-v7/adaptability-verifier.mjs',
  adaptabilityVerifierSha256,
  instances,
  maxPhaseTimeMs = 1_500_000,
} = {}) {
  invariant(id === 'terminal-mini-ledger-v7', 'Unexpected V7 challenge ID');
  nonEmpty(title, 'V7 challenge title');
  nonEmpty(protocolRevision, 'V7 protocol revision');
  nonEmpty(promptPath, 'V7 prompt path');
  sha256Digest(promptSha256, 'V7 prompt hash');
  nonEmpty(publicVerifierPath, 'V7 public verifier path');
  sha256Digest(publicVerifierSha256, 'V7 public verifier hash');
  nonEmpty(hiddenVerifierPath, 'V7 hidden verifier path');
  sha256Digest(hiddenVerifierSha256, 'V7 hidden verifier hash');
  nonEmpty(adaptabilityVerifierPath, 'V7 adaptability verifier path');
  sha256Digest(adaptabilityVerifierSha256, 'V7 adaptability verifier hash');
  const releaseInstances = normalizeReleaseInstances(instances);
  invariant(Number.isSafeInteger(maxPhaseTimeMs) && maxPhaseTimeMs === 1_500_000, 'V7 phase time must be exactly 1,500,000 ms');

  return seal('challenge', {
    schemaVersion: TERMINAL_V7_CHALLENGE_SCHEMA,
    kind: 'private-randomized-long-horizon-terminal-task',
    id,
    title,
    protocolRevision,
    prompt: { path: promptPath, sha256: promptSha256 },
    verifiers: {
      public: { path: publicVerifierPath, sha256: publicVerifierSha256, points: 20, disclosure: 'visible-smoke-contract' },
      hidden: { path: hiddenVerifierPath, sha256: hiddenVerifierSha256, points: 80, disclosure: 'private-composed-and-fault-cases' },
      adaptability: { path: adaptabilityVerifierPath, sha256: adaptabilityVerifierSha256, points: 15, disclosure: 'private-separate-axis' },
    },
    instances: releaseInstances.map((instance) => ({ ...instance })),
    phases: [...MINI_LEDGER_V7_PHASE_IDS],
    scoringFamilies: [...MINI_LEDGER_V7_FAMILIES],
    guidance: {
      releaseVariant: MINI_LEDGER_V7_INSTANCE_VARIANTS.release.id,
      cleanTwinVariant: MINI_LEDGER_V7_INSTANCE_VARIANTS.cleanTwin.id,
      cleanTwinUsage: 'calibration-only',
      releaseInstanceBytesIdenticalAcrossHarnesses: true,
      authoritativeRequirementsRemainTrue: true,
      falseInformationRestrictedToAuxiliaryEvidence: true,
      mustBeFalsifiableFromWorkspaceEvidence: true,
    },
    protocol: {
      phases: 5,
      turns: 5,
      sameWorkspace: true,
      sameSession: true,
      progressiveRequirementDisclosure: true,
      futureRequirementsWithheldUntilTurn: true,
      gradeCleanSourcePatchOnly: true,
      maxPhaseTimeMs,
      network: 'disabled',
      humanIntervention: 'invalidates-run',
    },
    scoring: {
      primaryMetric: 'core-final-correctness',
      core: { ...TERMINAL_V7_SCORING.core },
      exact: { ...TERMINAL_V7_SCORING.exact },
      adaptability: { ...TERMINAL_V7_SCORING.adaptability, leaderboardAxis: 'separate' },
      proxyGap: { ...TERMINAL_V7_SCORING.proxyGap, leaderboardAxis: 'diagnostic' },
      practicalWin: { thresholdPoints: TERMINAL_V7_PRACTICAL_WIN_POINTS, requiresConfidenceIntervalExcludingZero: true },
    },
  });
}

export function validateTerminalV7Challenge(challenge) {
  invariant(challenge?.schemaVersion === TERMINAL_V7_CHALLENGE_SCHEMA, 'Unsupported V7 challenge schema');
  const { challengeId, challengeSha256, ...descriptor } = challenge;
  const actual = canonicalJsonSha256(descriptor);
  invariant(challengeSha256 === actual, 'V7 challenge hash mismatch');
  invariant(challengeId === `challenge-${actual.slice(0, 16)}`, 'V7 challenge ID mismatch');
  invariant(challenge.id === 'terminal-mini-ledger-v7', 'Unexpected V7 challenge ID');
  nonEmpty(challenge.protocolRevision, 'V7 protocol revision');
  sha256Digest(challenge.prompt?.sha256, 'V7 prompt hash');
  sha256Digest(challenge.verifiers?.public?.sha256, 'V7 public verifier hash');
  sha256Digest(challenge.verifiers?.hidden?.sha256, 'V7 hidden verifier hash');
  sha256Digest(challenge.verifiers?.adaptability?.sha256, 'V7 adaptability verifier hash');
  invariant(challenge.verifiers.public.points === 20 && challenge.verifiers.hidden.points === 80, 'V7 Core verifier weights changed');
  invariant(challenge.verifiers.adaptability.points === 15, 'V7 Adaptability weight changed');
  validateFiveInstances(challenge.instances);
  invariant(challenge.instances.every(({ source }) => source === 'sealed-release-pack'), 'V7 challenge contains a non-release instance');
  invariant(canonicalJson(challenge.instances.map(({ instanceId }) => instanceId)) === canonicalJson(['release-01', 'release-02', 'release-03', 'release-04', 'release-05']), 'V7 challenge release instance set changed');
  invariant(canonicalJson(challenge.phases) === canonicalJson(MINI_LEDGER_V7_PHASE_IDS), 'V7 challenge phases changed');
  invariant(canonicalJson(challenge.scoringFamilies) === canonicalJson(MINI_LEDGER_V7_FAMILIES), 'V7 challenge scoring families changed');
  invariant(challenge.guidance?.releaseVariant === 'decoy'
    && challenge.guidance.cleanTwinVariant === 'clean'
    && challenge.guidance.cleanTwinUsage === 'calibration-only'
    && challenge.guidance.releaseInstanceBytesIdenticalAcrossHarnesses === true, 'V7 release/calibration variant contract changed');
  invariant(challenge.guidance.authoritativeRequirementsRemainTrue === true
    && challenge.guidance.falseInformationRestrictedToAuxiliaryEvidence === true
    && challenge.guidance.mustBeFalsifiableFromWorkspaceEvidence === true, 'V7 guidance safety contract changed');
  invariant(challenge.protocol?.phases === 5 && challenge.protocol.turns === 5 && challenge.protocol.sameWorkspace === true && challenge.protocol.sameSession === true, 'V7 long-horizon protocol changed');
  invariant(challenge.protocol.progressiveRequirementDisclosure === true && challenge.protocol.futureRequirementsWithheldUntilTurn === true, 'V7 progressive disclosure contract changed');
  invariant(challenge.protocol.gradeCleanSourcePatchOnly === true, 'V7 clean-patch grading contract changed');
  invariant(challenge.protocol.maxPhaseTimeMs === 1_500_000, 'V7 phase time is invalid');
  invariant(canonicalJson(challenge.scoring.core) === canonicalJson(TERMINAL_V7_SCORING.core), 'V7 Core scoring changed');
  invariant(challenge.scoring.primaryMetric === 'core-final-correctness', 'V7 primary metric changed');
  invariant(challenge.scoring.exact?.definition === TERMINAL_V7_SCORING.exact.definition, 'V7 Exact scoring changed');
  invariant(challenge.scoring.adaptability?.minPoints === 0 && challenge.scoring.adaptability?.maxPoints === 15 && challenge.scoring.adaptability?.leaderboardAxis === 'separate', 'V7 Adaptability scoring changed');
  invariant(challenge.scoring.proxyGap?.definition === TERMINAL_V7_SCORING.proxyGap.definition && challenge.scoring.proxyGap?.unit === 'percentage-points', 'V7 proxy-gap scoring changed');
  invariant(challenge.scoring.practicalWin?.thresholdPoints === 5 && challenge.scoring.practicalWin?.requiresConfidenceIntervalExcludingZero === true, 'V7 practical-win rule changed');
  if (challenge.execution !== undefined) validateTerminalV7ExecutionBinding(challenge.execution);
  return challenge;
}

function normalizeHarness(harness, index) {
  invariant(harness && typeof harness === 'object' && !Array.isArray(harness), `Harness ${index + 1} must be an object`);
  return {
    id: nonEmpty(harness.id, `Harness ${index + 1} ID`),
    version: nonEmpty(harness.version, `Harness ${index + 1} version`),
  };
}

function normalizeModel(model) {
  invariant(model && typeof model === 'object' && !Array.isArray(model), 'V7 schedule model is required');
  return {
    id: nonEmpty(model.id, 'V7 model ID'),
    familyId: nonEmpty(model.familyId, 'V7 model family ID'),
    reasoningEffort: nonEmpty(model.reasoningEffort, 'V7 model reasoning effort'),
  };
}

function mixSeed(seed, label) {
  const digest = canonicalJsonSha256({ seed, label });
  return Number.parseInt(digest.slice(0, 8), 16) >>> 0;
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

function deterministicPermutation(values, seed) {
  const result = [...values];
  const random = mulberry32(seed);
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

export function createTerminalV7Schedule({
  challenge,
  harnesses,
  model,
  seed = 1,
} = {}) {
  validateTerminalV7Challenge(challenge);
  invariant(Array.isArray(harnesses) && harnesses.length === 5, 'V7 schedule requires exactly five harnesses');
  uint32(seed, 'V7 schedule seed');
  const normalizedHarnesses = harnesses.map(normalizeHarness).sort((left, right) => left.id.localeCompare(right.id));
  invariant(new Set(normalizedHarnesses.map(({ id }) => id)).size === 5, 'V7 harness IDs must be unique');
  const normalizedModel = normalizeModel(model);
  const sortedInstances = [...challenge.instances].sort((left, right) => left.ordinal - right.ordinal);
  const harnessOrder = deterministicPermutation(normalizedHarnesses, mixSeed(seed, 'harnesses'));
  const instanceOrder = deterministicPermutation(sortedInstances, mixSeed(seed, 'instances'));

  const jobs = [];
  const rounds = [];
  for (let round = 1; round <= 5; round += 1) {
    const runKeys = [];
    for (let row = 0; row < 5; row += 1) {
      const harness = harnessOrder[row];
      const instance = instanceOrder[(row + round - 1) % 5];
      const descriptor = {
        schemaVersion: TERMINAL_V7_RUN_SCHEMA,
        challengeId: challenge.challengeId,
        challengeSha256: challenge.challengeSha256,
        instanceId: instance.instanceId,
        instanceSha256: instance.instanceSha256,
        generationIndex: instance.ordinal,
        harness: { ...harness },
        model: { ...normalizedModel },
        instanceVariant: MINI_LEDGER_V7_INSTANCE_VARIANTS.release.id,
        round,
        executionIndex: jobs.length + 1,
        repeat: 1,
        seed: instance.generator.seedFingerprint,
        seedFingerprint: instance.generator.seedFingerprint,
        scheduleSeed: seed,
      };
      const job = { runKey: canonicalJsonSha256(descriptor), ...descriptor };
      jobs.push(job);
      runKeys.push(job.runKey);
    }
    rounds.push({ round, runKeys });
  }

  return seal('schedule', {
    schemaVersion: TERMINAL_V7_SCHEDULE_SCHEMA,
    kind: 'precommitted-five-round-latin-square',
    challenge: { id: challenge.challengeId, sha256: challenge.challengeSha256 },
    seed,
    matrix: {
      harnesses: normalizedHarnesses,
      model: normalizedModel,
      instances: sortedInstances.map(({ instanceId, instanceSha256, ordinal }) => ({ instanceId, instanceSha256, ordinal })),
      releaseVariant: MINI_LEDGER_V7_INSTANCE_VARIANTS.release.id,
      cleanTwinIncluded: false,
      expectedRuns: 25,
    },
    latinSquare: {
      order: 5,
      rowHarnesses: harnessOrder.map(({ id }) => id),
      rounds: [1, 2, 3, 4, 5],
      symbolInstances: instanceOrder.map(({ instanceId }) => instanceId),
      rule: 'symbol[(row+round-1)%5]',
    },
    executionOrder: { mode: 'round-major', rounds },
    jobs,
  });
}

function increment(counter, key) {
  counter.set(key, (counter.get(key) ?? 0) + 1);
}

function everyCount(counter, expectedSize, expectedCount) {
  return counter.size === expectedSize && [...counter.values()].every((count) => count === expectedCount);
}

export function validateTerminalV7Schedule(schedule, challenge) {
  validateTerminalV7Challenge(challenge);
  invariant(schedule?.schemaVersion === TERMINAL_V7_SCHEDULE_SCHEMA, 'Unsupported V7 schedule schema');
  const { scheduleId, scheduleSha256, ...descriptor } = schedule;
  const actual = canonicalJsonSha256(descriptor);
  invariant(scheduleSha256 === actual, 'V7 schedule hash mismatch');
  invariant(scheduleId === `schedule-${actual.slice(0, 16)}`, 'V7 schedule ID mismatch');
  invariant(schedule.challenge?.id === challenge.challengeId && schedule.challenge?.sha256 === challenge.challengeSha256, 'V7 schedule challenge mismatch');
  uint32(schedule.seed, 'V7 schedule seed');
  invariant(schedule.kind === 'precommitted-five-round-latin-square', 'V7 schedule kind is invalid');
  invariant(schedule.matrix?.expectedRuns === 25 && Array.isArray(schedule.jobs) && schedule.jobs.length === 25, 'V7 schedule must contain 25 jobs');
  invariant(Array.isArray(schedule.matrix.harnesses) && schedule.matrix.harnesses.length === 5, 'V7 schedule harness matrix is invalid');
  invariant(new Set(schedule.matrix.harnesses.map(({ id }) => id)).size === 5, 'V7 schedule harness IDs are invalid');
  schedule.matrix.harnesses.forEach(normalizeHarness);
  const model = normalizeModel(schedule.matrix.model);
  const harnessIds = schedule.matrix.harnesses.map(({ id }) => id);
  const instanceById = new Map(challenge.instances.map((instance) => [instance.instanceId, instance]));
  const instanceIds = [...instanceById.keys()];
  invariant(sameMembers(schedule.matrix.instances.map(({ instanceId }) => instanceId), instanceIds), 'V7 schedule instances do not match the challenge');
  for (const scheduledInstance of schedule.matrix.instances) {
    const instance = instanceById.get(scheduledInstance.instanceId);
    invariant(scheduledInstance.instanceSha256 === instance.instanceSha256 && scheduledInstance.ordinal === instance.ordinal, 'V7 schedule instance metadata changed');
  }
  invariant(schedule.matrix.releaseVariant === 'decoy' && schedule.matrix.cleanTwinIncluded === false, 'V7 release schedule must contain only decoy variants');

  const latin = schedule.latinSquare;
  invariant(latin?.order === 5 && latin.rule === 'symbol[(row+round-1)%5]', 'V7 Latin-square metadata is invalid');
  invariant(sameMembers(latin.rowHarnesses, harnessIds), 'V7 Latin-square rows are invalid');
  invariant(sameMembers(latin.rounds, [1, 2, 3, 4, 5]), 'V7 Latin-square rounds are invalid');
  invariant(sameMembers(latin.symbolInstances, instanceIds), 'V7 Latin-square symbols are invalid');
  invariant(schedule.executionOrder?.mode === 'round-major' && Array.isArray(schedule.executionOrder.rounds) && schedule.executionOrder.rounds.length === 5, 'V7 execution order is invalid');

  const runKeys = new Set();
  const harnessInstance = new Map();
  const harnessCount = new Map();
  const instanceCount = new Map();
  const roundHarness = new Map();
  const roundInstance = new Map();
  for (const [index, job] of schedule.jobs.entries()) {
    invariant(job.schemaVersion === TERMINAL_V7_RUN_SCHEMA, 'V7 job must retain the terminal run v1 schema');
    invariant(!runKeys.has(job.runKey), `Duplicate V7 run key: ${job.runKey}`);
    runKeys.add(job.runKey);
    const { runKey, ...runDescriptor } = job;
    invariant(runKey === canonicalJsonSha256(runDescriptor), `V7 run key mismatch: ${runKey}`);
    invariant(job.challengeId === challenge.challengeId && job.challengeSha256 === challenge.challengeSha256, 'V7 job challenge mismatch');
    const instance = instanceById.get(job.instanceId);
    invariant(instance && job.instanceSha256 === instance.instanceSha256, 'V7 job instance identity mismatch');
    invariant(job.generationIndex === instance.ordinal
      && job.seed === instance.generator.seedFingerprint
      && job.seedFingerprint === instance.generator.seedFingerprint, 'V7 job instance metadata mismatch');
    invariant(job.scheduleSeed === schedule.seed && job.repeat === 1 && job.executionIndex === index + 1, 'V7 job replicate or execution metadata is invalid');
    invariant(Number.isSafeInteger(job.round) && job.round >= 1 && job.round <= 5, 'V7 job round is invalid');
    invariant(job.round === Math.floor(index / 5) + 1, 'V7 jobs must remain in precommitted round-major order');
    invariant(job.instanceVariant === 'decoy', 'V7 scored jobs must use the decoy release variant');
    invariant(harnessIds.includes(job.harness?.id), 'V7 job harness is not in the matrix');
    const scheduledHarness = schedule.matrix.harnesses.find(({ id }) => id === job.harness.id);
    invariant(canonicalJson(job.harness) === canonicalJson(scheduledHarness), 'V7 job harness version mismatch');
    invariant(canonicalJson(job.model) === canonicalJson(model), 'V7 job model mismatch');

    const row = latin.rowHarnesses.indexOf(job.harness.id);
    const expectedInstance = latin.symbolInstances[(row + job.round - 1) % 5];
    invariant(job.instanceId === expectedInstance, 'V7 job violates the sealed Latin-square assignment');
    increment(harnessInstance, `${job.harness.id}\u0000${job.instanceId}`);
    increment(harnessCount, job.harness.id);
    increment(instanceCount, job.instanceId);
    increment(roundHarness, `${job.round}\u0000${job.harness.id}`);
    increment(roundInstance, `${job.round}\u0000${job.instanceId}`);
  }
  invariant(everyCount(harnessInstance, 25, 1), 'V7 schedule does not pair every harness and instance exactly once');
  invariant(everyCount(roundHarness, 25, 1), 'Every V7 round must contain every harness exactly once');
  invariant(everyCount(roundInstance, 25, 1), 'Every V7 round must contain every release instance exactly once');
  invariant(everyCount(harnessCount, 5, 5) && everyCount(instanceCount, 5, 5), 'V7 schedule marginal counts are not balanced');
  for (const [index, round] of schedule.executionOrder.rounds.entries()) {
    invariant(Number.isSafeInteger(round.round) && round.round >= 1 && round.round <= 5 && Array.isArray(round.runKeys) && round.runKeys.length === 5, 'V7 execution round metadata is invalid');
    invariant(round.round === index + 1, 'V7 execution rounds must remain in precommitted order');
    const expectedRunKeys = schedule.jobs.filter((job) => job.round === round.round).map(({ runKey }) => runKey);
    invariant(canonicalJson(round.runKeys) === canonicalJson(expectedRunKeys), `V7 execution order changed in round ${round.round}`);
  }
  invariant(sameMembers(schedule.executionOrder.rounds.map(({ round }) => round), [1, 2, 3, 4, 5]), 'V7 execution rounds are invalid');
  return schedule;
}

function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function scoredCheckSet(result, label, maxPoints) {
  invariant(result && typeof result === 'object' && !Array.isArray(result), `${label} result is required`);
  invariant(Number.isSafeInteger(result.passed) && Number.isSafeInteger(result.total) && result.total > 0, `${label} counts must be positive integers`);
  invariant(result.passed >= 0 && result.passed <= result.total, `${label} passed count is invalid`);
  const rate = result.passed / result.total;
  return {
    passed: result.passed,
    total: result.total,
    rate: round(rate),
    points: round(rate * maxPoints),
    maxPoints,
  };
}

function scoredFamilies(evaluation) {
  invariant(Array.isArray(evaluation?.families) && evaluation.families.length === 5, 'V7 evaluation requires five scoring-family results');
  const byId = new Map();
  for (const family of evaluation.families) {
    nonEmpty(family?.id, 'V7 scoring family ID');
    invariant(!byId.has(family.id), `Duplicate V7 scoring family: ${family.id}`);
    byId.set(family.id, family);
  }
  invariant(MINI_LEDGER_V7_FAMILIES.every((id) => byId.has(id)) && byId.size === 5, 'V7 scoring-family set is invalid');
  return MINI_LEDGER_V7_FAMILIES.map((id) => {
    const family = byId.get(id);
    invariant(family.public?.total === 4, `V7 ${id} public total must be 4`);
    invariant(family.hiddenAtomic?.total === 6, `V7 ${id} hidden atomic total must be 6`);
    invariant(family.hiddenComposed?.total === 10, `V7 ${id} hidden composed total must be 10`);
    invariant(family.hidden?.total === 16, `V7 ${id} hidden total must be 16`);
    const publicScore = scoredCheckSet(family.public, `V7 ${id} public`, 4);
    const hiddenAtomicScore = scoredCheckSet(family.hiddenAtomic, `V7 ${id} hidden atomic`, 6);
    const hiddenComposedScore = scoredCheckSet(family.hiddenComposed, `V7 ${id} hidden composed`, 10);
    const hiddenScore = scoredCheckSet(family.hidden, `V7 ${id} hidden`, 16);
    invariant(
      family.hidden.passed === family.hiddenAtomic.passed + family.hiddenComposed.passed,
      `V7 ${id} hidden result does not equal its atomic and composed partitions`,
    );
    return {
      id,
      points: round(publicScore.points + hiddenScore.points),
      maxPoints: 20,
      public: publicScore,
      hidden: hiddenScore,
      hiddenAtomic: hiddenAtomicScore,
      hiddenComposed: hiddenComposedScore,
      exact: publicScore.passed === publicScore.total
        && hiddenAtomicScore.passed === hiddenAtomicScore.total
        && hiddenComposedScore.passed === hiddenComposedScore.total,
    };
  });
}

export function scoreTerminalV7Run(run, challenge) {
  validateTerminalV7Challenge(challenge);
  invariant(run?.schemaVersion === TERMINAL_V7_RUN_SCHEMA, 'Unsupported V7 run schema');
  invariant(run.challengeId === challenge.challengeId && run.challengeSha256 === challenge.challengeSha256, 'V7 run challenge mismatch');
  invariant(challenge.instances.some(({ instanceId, instanceSha256 }) => instanceId === run.instanceId && instanceSha256 === run.instanceSha256), 'V7 run instance identity mismatch');
  invariant(run.status === 'completed', 'Only completed V7 runs receive a score');
  const families = scoredFamilies(run.evaluation);
  const publicPoints = round(families.reduce((total, family) => total + family.public.points, 0));
  const hiddenPoints = round(families.reduce((total, family) => total + family.hidden.points, 0));
  const hiddenAtomicPoints = round(families.reduce((total, family) => total + family.hiddenAtomic.points, 0));
  const hiddenComposedPoints = round(families.reduce((total, family) => total + family.hiddenComposed.points, 0));
  const publicScore = {
    points: publicPoints,
    maxPoints: 20,
    macroRate: round(publicPoints / 20),
    passed: families.reduce((total, family) => total + family.public.passed, 0),
    total: families.reduce((total, family) => total + family.public.total, 0),
  };
  const hiddenScore = {
    points: hiddenPoints,
    maxPoints: 80,
    macroRate: round(hiddenPoints / 80),
    passed: families.reduce((total, family) => total + family.hidden.passed, 0),
    total: families.reduce((total, family) => total + family.hidden.total, 0),
  };
  const hiddenAtomicScore = {
    points: hiddenAtomicPoints,
    maxPoints: 30,
    macroRate: round(hiddenAtomicPoints / 30),
    passed: families.reduce((total, family) => total + family.hiddenAtomic.passed, 0),
    total: families.reduce((total, family) => total + family.hiddenAtomic.total, 0),
  };
  const hiddenComposedScore = {
    points: hiddenComposedPoints,
    maxPoints: 50,
    macroRate: round(hiddenComposedPoints / 50),
    passed: families.reduce((total, family) => total + family.hiddenComposed.passed, 0),
    total: families.reduce((total, family) => total + family.hiddenComposed.total, 0),
  };
  invariant(round(hiddenAtomicScore.points + hiddenComposedScore.points) === hiddenScore.points, 'V7 hidden score does not equal its atomic and composed partitions');
  const adaptability = scoredCheckSet(run.evaluation?.adaptability, 'V7 adaptability', 15);
  const corePoints = round(publicScore.points + hiddenScore.points);
  const exact = families.every((family) => family.exact);
  const proxyGap = round((publicScore.macroRate - hiddenComposedScore.macroRate) * 100);
  return {
    schemaVersion: TERMINAL_V7_SCORE_SCHEMA,
    primaryMetric: 'core-final-correctness',
    core: {
      points: corePoints,
      maxPoints: 100,
      public: publicScore,
      hidden: hiddenScore,
      hiddenAtomic: hiddenAtomicScore,
      hiddenComposed: hiddenComposedScore,
      families,
    },
    corePoints,
    corePct: corePoints,
    exact,
    adaptability,
    adaptabilityPoints: adaptability.points,
    proxyGap,
    proxyGapUnit: 'percentage-points',
  };
}

function quantile(sorted, probability) {
  invariant(sorted.length > 0, 'Cannot compute a quantile of an empty sample');
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function harnessIdForResult(result) {
  return nonEmpty(result.harnessId ?? result.harness?.id, 'Paired result harness ID');
}

function corePointsForResult(result) {
  const points = result.score?.core?.points;
  invariant(typeof points === 'number' && Number.isFinite(points) && points >= 0 && points <= 100, 'Paired result Core score must be in [0, 100]');
  return points;
}

function pairedBootstrap(differences, seed) {
  const random = mulberry32(seed);
  const distribution = new Array(TERMINAL_V7_BOOTSTRAP_RESAMPLES);
  for (let sample = 0; sample < TERMINAL_V7_BOOTSTRAP_RESAMPLES; sample += 1) {
    let total = 0;
    for (let draw = 0; draw < differences.length; draw += 1) total += differences[Math.floor(random() * differences.length)];
    distribution[sample] = total / differences.length;
  }
  distribution.sort((left, right) => left - right);
  return {
    low: round(quantile(distribution, 0.025)),
    high: round(quantile(distribution, 0.975)),
  };
}

export function analyzeTerminalV7PairedPacks(results, {
  challenge = null,
  bootstrapSeed = TERMINAL_V7_DEFAULT_BOOTSTRAP_SEED,
} = {}) {
  if (challenge) validateTerminalV7Challenge(challenge);
  uint32(bootstrapSeed, 'V7 bootstrap seed');
  invariant(Array.isArray(results) && results.length >= 10, 'V7 paired analysis requires at least two harnesses across five packs');
  const rows = results.map((result) => ({
    harnessId: harnessIdForResult(result),
    instanceId: nonEmpty(result.instanceId, 'Paired result instance ID'),
    corePoints: corePointsForResult(result),
  })).sort((left, right) => left.harnessId.localeCompare(right.harnessId) || left.instanceId.localeCompare(right.instanceId));
  const harnessIds = [...new Set(rows.map(({ harnessId }) => harnessId))].sort();
  invariant(harnessIds.length >= 2, 'V7 paired analysis requires at least two harnesses');
  const expectedInstances = challenge
    ? challenge.instances.map(({ instanceId }) => instanceId).sort()
    : [...new Set(rows.filter(({ harnessId }) => harnessId === harnessIds[0]).map(({ instanceId }) => instanceId))].sort();
  invariant(expectedInstances.length === 5, 'V7 paired analysis requires exactly five instance-pack clusters');
  const values = new Map();
  for (const row of rows) {
    invariant(expectedInstances.includes(row.instanceId), `Unexpected V7 paired instance: ${row.instanceId}`);
    const key = `${row.harnessId}\u0000${row.instanceId}`;
    invariant(!values.has(key), `Duplicate V7 paired result: ${key}`);
    values.set(key, row.corePoints);
  }
  for (const harnessId of harnessIds) {
    invariant(expectedInstances.every((instanceId) => values.has(`${harnessId}\u0000${instanceId}`)), `Harness ${harnessId} does not cover all five V7 packs`);
  }
  invariant(values.size === harnessIds.length * 5, 'V7 paired analysis contains an unbalanced result matrix');

  const comparisons = [];
  for (let leftIndex = 0; leftIndex < harnessIds.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < harnessIds.length; rightIndex += 1) {
      const leftHarnessId = harnessIds[leftIndex];
      const rightHarnessId = harnessIds[rightIndex];
      const packDifferences = expectedInstances.map((instanceId) => ({
        instanceId,
        difference: round(values.get(`${leftHarnessId}\u0000${instanceId}`) - values.get(`${rightHarnessId}\u0000${instanceId}`)),
      }));
      const differences = packDifferences.map(({ difference }) => difference);
      const leftMean = round(expectedInstances.reduce((total, instanceId) => total + values.get(`${leftHarnessId}\u0000${instanceId}`), 0) / 5);
      const rightMean = round(expectedInstances.reduce((total, instanceId) => total + values.get(`${rightHarnessId}\u0000${instanceId}`), 0) / 5);
      const meanDifference = round(differences.reduce((total, difference) => total + difference, 0) / 5);
      const pairSeed = mixSeed(bootstrapSeed, `${leftHarnessId}\u0000${rightHarnessId}`);
      const confidenceInterval95 = pairedBootstrap(differences, pairSeed);
      const confidenceExcludesZero = confidenceInterval95.low > 0 || confidenceInterval95.high < 0;
      const practicalMagnitude = Math.abs(meanDifference) >= TERMINAL_V7_PRACTICAL_WIN_POINTS;
      let winnerHarnessId = null;
      if (practicalMagnitude && confidenceExcludesZero) winnerHarnessId = meanDifference > 0 ? leftHarnessId : rightHarnessId;
      comparisons.push({
        leftHarnessId,
        rightHarnessId,
        leftMean,
        rightMean,
        meanDifference,
        packDifferences,
        confidenceInterval95,
        practicalMagnitude,
        confidenceExcludesZero,
        winnerHarnessId,
        decision: winnerHarnessId ? 'practical-win' : 'tie',
        bootstrap: {
          method: 'paired-cluster-percentile',
          clusterUnit: 'sealed-instance-pack',
          clusters: 5,
          resamples: TERMINAL_V7_BOOTSTRAP_RESAMPLES,
          seed: pairSeed,
        },
      });
    }
  }
  return {
    schemaVersion: TERMINAL_V7_ANALYSIS_SCHEMA,
    metric: 'Core',
    harnesses: harnessIds,
    instanceIds: expectedInstances,
    practicalWinRule: {
      minimumMeanDifferencePoints: TERMINAL_V7_PRACTICAL_WIN_POINTS,
      requires95PctConfidenceIntervalExcludingZero: true,
      otherwise: 'tie',
    },
    bootstrap: {
      method: 'paired-cluster-percentile',
      clusterUnit: 'sealed-instance-pack',
      resamples: TERMINAL_V7_BOOTSTRAP_RESAMPLES,
      seed: bootstrapSeed,
    },
    comparisons,
  };
}
