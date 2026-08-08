import {
  assertV7PackSeal,
  loadV7Pack,
  sealV7Pack,
  V7_POOL_INSTANCES,
  V7_SEALED_PACK_SCHEMA,
} from '../benchmark/challenges/mini-ledger-v7/pack.mjs';
import { canonicalJson, canonicalJsonSha256 } from './provenance.mjs';
import {
  analyzeTerminalV7PairedPacks,
  MINI_LEDGER_V7_FAMILIES,
  MINI_LEDGER_V7_PHASE_IDS,
  scoreTerminalV7Run,
  TERMINAL_V7_RUN_SCHEMA,
  validateTerminalV7Challenge,
  validateTerminalV7Schedule,
} from './terminal-v7.mjs';
import { validateTerminalJobIdentity } from './terminal-runner.mjs';
import { validateTerminalV7SealManifest } from './terminal-v7-seals.mjs';
import { validateTerminalV7ScriptedReferenceReport } from './terminal-v7-scripted-references.mjs';
import { validateTerminalV7HumanTwinValidation } from './terminal-v7-human-twins.mjs';
import { validateTerminalV7ExecutionBinding } from './terminal-v7-execution-identity.mjs';

export const TERMINAL_V7_CALIBRATION_CHALLENGE_SCHEMA = 'agentbattler.terminal-v7-calibration-challenge.v1';
export const TERMINAL_V7_CALIBRATION_INSTANCE_SCHEMA = 'agentbattler.terminal-v7-calibration-instance.v1';
export const TERMINAL_V7_CALIBRATION_SCHEDULE_SCHEMA = 'agentbattler.terminal-v7-calibration-schedule.v1';
export const TERMINAL_V7_CALIBRATION_EXECUTION_UNIT_SCHEMA = 'agentbattler.terminal-v7-calibration-execution-unit.v1';
export const TERMINAL_V7_CALIBRATION_TASK_BINDING_SCHEMA = 'agentbattler.terminal-v7-calibration-task-binding.v1';
export const TERMINAL_V7_PILOT_ANALYSIS_SCHEMA = 'agentbattler.terminal-v7-development-pilot-analysis.v1';

export const TERMINAL_V7_PILOT_POLICY = Object.freeze({
  modelId: 'gpt-5.6-luna',
  familyId: 'luna',
  maxReasoningEffort: 'max',
  highReasoningEffort: 'high',
  maxRuns: 12,
  highAnchorRuns: 3,
  expectedRuns: 15,
  maxDecoyRuns: 6,
  maxDecoyMedianMinimum: 50,
  maxDecoyMedianMaximum: 75,
  maximumAllowedRunCore: 95,
  maximumExactMaxDecoyRuns: 1,
  minimumPairedMeanMaxMinusHigh: 10,
  scriptedTwinDifference: 0,
  maximumHumanTwinDifferenceExclusive: 5,
  infrastructureInvalidRunsAllowed: 0,
});

const SHA256_RE = /^[0-9a-f]{64}$/;
const UINT32_MAX = 0xffff_ffff;
const CALIBRATION_POOLS = new Set(['dev', 'reserve']);
const VARIANTS = new Set(['clean', 'decoy']);
const DENIED_SERIALIZED_KEYS = new Set(['seedKey', 'hiddenSeed', 'apiKey', 'accessToken', 'refreshToken', 'credential']);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function nonEmpty(value, label) {
  invariant(typeof value === 'string' && value.length > 0, `${label} is required`);
  return value;
}

function sha256(value, label) {
  invariant(typeof value === 'string' && SHA256_RE.test(value), `${label} must be a lowercase SHA-256 digest`);
  return value;
}

function uint32(value, label) {
  invariant(Number.isSafeInteger(value) && value >= 0 && value <= UINT32_MAX, `${label} must be a uint32`);
  return value;
}

function clone(value) {
  return JSON.parse(canonicalJson(value));
}

function seal(prefix, descriptor) {
  const digest = canonicalJsonSha256(descriptor);
  return { ...descriptor, [`${prefix}Sha256`]: digest, [`${prefix}Id`]: `${prefix}-${digest.slice(0, 16)}` };
}

function sameMembers(left, right) {
  return left.length === right.length
    && new Set(left).size === left.length
    && new Set(right).size === right.length
    && left.every((value) => right.includes(value));
}

function increment(counter, key) {
  counter.set(key, (counter.get(key) ?? 0) + 1);
}

function everyCount(counter, expectedSize, expectedCount) {
  return counter.size === expectedSize && [...counter.values()].every((count) => count === expectedCount);
}

function rejectSensitiveKeys(value, location = '$') {
  if (Array.isArray(value)) {
    value.forEach((child, index) => rejectSensitiveKeys(child, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    invariant(!DENIED_SERIALIZED_KEYS.has(key), `V7 calibration descriptor contains forbidden key ${location}.${key}`);
    rejectSensitiveKeys(child, `${location}.${key}`);
  }
}

function packCommitments(pack) {
  invariant(pack?.schemaVersion === V7_SEALED_PACK_SCHEMA, 'V7 calibration pack must use the sealed-pack schema');
  for (const [field, value] of [
    ['packSha256', pack.packSha256],
    ['sealSha256', pack.sealSha256],
    ['seedFingerprint', pack.seedFingerprint],
    ['starterTreeSha256', pack.starterTreeSha256],
    ['requirementsSha256', pack.requirementsSha256],
    ['requirementMapSha256', pack.requirementMapSha256],
    ['hiddenMerkleRoot', pack.hiddenMerkleRoot],
    ['twinRelationSha256', pack.twinRelationSha256],
  ]) sha256(value, `V7 calibration ${field}`);
  invariant(pack.perPhaseLimitMs === 1_500_000, 'V7 calibration phase limit changed');
  invariant(pack.rubricVersion === 'mini-ledger-v7-r1', 'V7 calibration rubric changed');
  invariant(pack.feedbackPolicy === 'self-service-public-only', 'V7 calibration feedback policy changed');
  invariant(Array.isArray(pack.phases) && pack.phases.length === 5, 'V7 calibration pack must have five phases');
  const phases = pack.phases.map((phase, index) => {
    invariant(phase.phase === index + 1 && phase.id === MINI_LEDGER_V7_PHASE_IDS[index], `V7 calibration phase ${index + 1} changed`);
    sha256(phase.ticketSha256, `V7 calibration phase ${index + 1} ticket hash`);
    sha256(phase.publicSmokeSha256, `V7 calibration phase ${index + 1} public smoke hash`);
    sha256(phase.phaseDeltaSha256, `V7 calibration phase ${index + 1} delta hash`);
    return {
      phase: phase.phase,
      id: phase.id,
      ticketSha256: phase.ticketSha256,
      publicSmokeSha256: phase.publicSmokeSha256,
      phaseDeltaSha256: phase.phaseDeltaSha256,
    };
  });
  invariant(canonicalJson(pack.phaseDeltaSha256) === canonicalJson(phases.map(({ phaseDeltaSha256 }) => phaseDeltaSha256)), 'V7 calibration phase-delta commitments changed');
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
  invariant(pack.sealSha256 === expectedSeal, 'V7 calibration pack seal does not bind every committed field');
  return {
    schemaVersion: pack.schemaVersion,
    packSha256: pack.packSha256,
    sealSha256: pack.sealSha256,
    seedFingerprint: pack.seedFingerprint,
    starterTreeSha256: pack.starterTreeSha256,
    requirementsSha256: pack.requirementsSha256,
    requirementMapSha256: pack.requirementMapSha256,
    phases,
    phaseDeltaSha256: [...pack.phaseDeltaSha256],
    perPhaseLimitMs: pack.perPhaseLimitMs,
    artifactPolicy: clone(pack.artifactPolicy),
    verifierHashes: clone(pack.verifierHashes),
    rubricVersion: pack.rubricVersion,
    feedbackPolicy: pack.feedbackPolicy,
    hiddenMerkleRoot: pack.hiddenMerkleRoot,
    hiddenCaseCount: pack.hiddenCaseCount,
    twinRelationSha256: pack.twinRelationSha256,
  };
}

function publicManifestSeal(twin, variant) {
  invariant(twin && typeof twin === 'object', 'V7 calibration manifest twin is missing');
  const visible = twin[variant];
  invariant(visible?.instanceId === twin.instanceId && visible?.pool === twin.pool && visible?.variant === variant, `V7 ${variant} manifest identity changed for ${twin.instanceId}`);
  return visible;
}

function sealedPacksFromManifest(manifest, pool, variants, { seedKey = null } = {}) {
  validateTerminalV7SealManifest(manifest, { seedKey });
  invariant(CALIBRATION_POOLS.has(pool), `Unsupported V7 calibration pool: ${pool}`);
  if (pool === 'reserve') invariant(typeof seedKey === 'string' && seedKey.length >= 16, 'Reserve calibration requires the evaluator-held seed key');
  const expectedIds = V7_POOL_INSTANCES[pool];
  const twins = manifest.packs.filter((entry) => entry.pool === pool);
  invariant(twins.length === expectedIds.length && sameMembers(twins.map(({ instanceId }) => instanceId), expectedIds), `V7 ${pool} manifest pack set changed`);
  const packs = [];
  for (const instanceId of expectedIds) {
    const twin = twins.find((entry) => entry.instanceId === instanceId);
    for (const variant of variants) {
      invariant(VARIANTS.has(variant), `Unsupported V7 calibration variant: ${variant}`);
      const packSeedKey = pool === 'dev' ? undefined : seedKey ?? undefined;
      const canonical = sealV7Pack(loadV7Pack(instanceId, { variant }), { seedKey: packSeedKey });
      assertV7PackSeal(canonical, { seedKey: packSeedKey });
      const visible = publicManifestSeal(twin, variant);
      for (const field of ['packSha256', 'sealSha256', 'starterTreeSha256', 'hiddenMerkleRoot', 'twinRelationSha256', 'seedFingerprint']) {
        invariant(visible[field] === canonical[field], `V7 ${pool}/${instanceId}/${variant} ${field} differs from the precommitted manifest`);
      }
      packs.push(canonical);
    }
  }
  return packs;
}

function ordinalForPack(pack) {
  const expected = V7_POOL_INSTANCES[pack.pool];
  const index = expected.indexOf(pack.instanceId);
  invariant(index >= 0, `V7 ${pack.pool} instance is not in its precommitted pool`);
  return index + 1;
}

function instanceFromPack(pack) {
  const ordinal = ordinalForPack(pack);
  const descriptor = {
    schemaVersion: TERMINAL_V7_CALIBRATION_INSTANCE_SCHEMA,
    benchmarkId: 'terminal-mini-ledger-v7',
    source: pack.pool === 'dev' ? 'sealed-development-pack' : 'sealed-reserve-pack',
    pool: pack.pool,
    variant: pack.variant,
    instanceId: pack.instanceId,
    key: `${pack.instanceId}:${pack.variant}`,
    ordinal,
    clusterId: pack.instanceId,
    scenarioId: pack.scenarioId,
    generator: {
      id: 'mini-ledger-v7-sealed-pack',
      version: 1,
      seedFingerprint: pack.seedFingerprint,
    },
    phaseOrder: [...MINI_LEDGER_V7_PHASE_IDS],
    disclosure: 'private-until-retirement',
    packCommitments: packCommitments(pack),
  };
  return { ...descriptor, instanceSha256: canonicalJsonSha256(descriptor) };
}

function validateCalibrationInstance(instance, { pool }) {
  invariant(instance?.schemaVersion === TERMINAL_V7_CALIBRATION_INSTANCE_SCHEMA, 'Unsupported V7 calibration instance schema');
  const { instanceSha256, ...descriptor } = instance;
  invariant(instanceSha256 === canonicalJsonSha256(descriptor), 'V7 calibration instance hash mismatch');
  invariant(instance.benchmarkId === 'terminal-mini-ledger-v7' && instance.pool === pool, 'V7 calibration instance benchmark or pool changed');
  invariant(instance.source === (pool === 'dev' ? 'sealed-development-pack' : 'sealed-reserve-pack'), 'V7 calibration instance source changed');
  invariant(V7_POOL_INSTANCES[pool].includes(instance.instanceId), 'V7 calibration instance is outside the precommitted pool');
  invariant(instance.ordinal === V7_POOL_INSTANCES[pool].indexOf(instance.instanceId) + 1, 'V7 calibration instance ordinal changed');
  invariant(VARIANTS.has(instance.variant) && instance.key === `${instance.instanceId}:${instance.variant}`, 'V7 calibration instance variant identity changed');
  invariant(instance.clusterId === instance.instanceId, 'V7 calibration cluster identity changed');
  invariant(instance.generator?.id === 'mini-ledger-v7-sealed-pack' && instance.generator?.version === 1, 'V7 calibration generator changed');
  invariant(instance.generator.seedFingerprint === instance.packCommitments?.seedFingerprint, 'V7 calibration seed fingerprint changed');
  invariant(canonicalJson(instance.phaseOrder) === canonicalJson(MINI_LEDGER_V7_PHASE_IDS), 'V7 calibration phase order changed');
  invariant(instance.disclosure === 'private-until-retirement', 'V7 calibration disclosure policy changed');
  const reconstructed = {
    ...instance.packCommitments,
    challengeId: 'terminal-mini-ledger-v7',
    pool,
    variant: instance.variant,
    twinVariant: instance.variant === 'clean' ? 'decoy' : 'clean',
    instanceId: instance.instanceId,
    scenarioId: instance.scenarioId,
  };
  packCommitments(reconstructed);
  return instance;
}

function calibrationChallengeDescriptor({ manifest, pool, instances, execution, selection }) {
  return {
    schemaVersion: TERMINAL_V7_CALIBRATION_CHALLENGE_SCHEMA,
    kind: pool === 'dev' ? 'sealed-development-twin-calibration' : 'sealed-reserve-leading-pair-extension',
    id: 'terminal-mini-ledger-v7',
    title: pool === 'dev' ? 'Mini Ledger V7 development pilot' : 'Mini Ledger V7 reserve extension',
    protocolRevision: manifest.revision,
    pool,
    phases: [...MINI_LEDGER_V7_PHASE_IDS],
    scoringFamilies: [...MINI_LEDGER_V7_FAMILIES],
    instances,
    protocol: {
      phases: 5,
      turns: 5,
      sameWorkspace: true,
      sameSession: true,
      progressiveRequirementDisclosure: true,
      futureRequirementsWithheldUntilTurn: true,
      gradeCleanSourcePatchOnly: true,
      maxPhaseTimeMs: 1_500_000,
      network: 'disabled',
      humanIntervention: 'invalidates-run',
    },
    guidance: {
      authoritativeRequirementsRemainTrue: true,
      falseInformationRestrictedToAuxiliaryEvidence: true,
      mustBeFalsifiableFromWorkspaceEvidence: true,
      releaseEligibility: 'calibration-only',
    },
    packSelection: {
      sourceManifestSha256: manifest.manifestSha256,
      sourceManifestRevision: manifest.revision,
      sourceManifestSealedAt: manifest.sealedAt,
      createdBeforeFrontierPilotResults: manifest.policy.createdBeforeFrontierPilotResults,
      pool,
      instanceIds: [...V7_POOL_INSTANCES[pool]],
      variants: pool === 'dev' ? ['clean', 'decoy'] : ['decoy'],
      rule: `all-presealed-${pool}-packs`,
      selectionFromModelFailures: 'forbidden',
    },
    feedbackPolicy: 'self-service-public-only',
    selection,
    execution,
  };
}

export function createTerminalV7CalibrationChallenge({
  sealManifest,
  pool = 'dev',
  seedKey = null,
  execution = null,
  selection = null,
} = {}) {
  invariant(CALIBRATION_POOLS.has(pool), `Unsupported V7 calibration pool: ${pool}`);
  const variants = pool === 'dev' ? ['clean', 'decoy'] : ['decoy'];
  const packs = sealedPacksFromManifest(sealManifest, pool, variants, { seedKey });
  const instances = packs.map(instanceFromPack);
  const challenge = seal('challenge', calibrationChallengeDescriptor({
    manifest: sealManifest,
    pool,
    instances,
    execution: execution === null ? null : clone(execution),
    selection: selection === null ? null : clone(selection),
  }));
  return validateTerminalV7CalibrationChallenge(challenge);
}

export function validateTerminalV7CalibrationChallenge(challenge, { requireExecution = false } = {}) {
  invariant(challenge?.schemaVersion === TERMINAL_V7_CALIBRATION_CHALLENGE_SCHEMA, 'Unsupported V7 calibration challenge schema');
  const { challengeId, challengeSha256, ...descriptor } = challenge;
  const actual = canonicalJsonSha256(descriptor);
  invariant(challengeSha256 === actual && challengeId === `challenge-${actual.slice(0, 16)}`, 'V7 calibration challenge hash mismatch');
  invariant(challenge.id === 'terminal-mini-ledger-v7' && CALIBRATION_POOLS.has(challenge.pool), 'V7 calibration challenge identity changed');
  invariant(challenge.kind === (challenge.pool === 'dev' ? 'sealed-development-twin-calibration' : 'sealed-reserve-leading-pair-extension'), 'V7 calibration challenge kind changed');
  invariant(/^r[1-9]\d*$/.test(challenge.protocolRevision ?? ''), 'V7 calibration protocol revision is invalid');
  invariant(canonicalJson(challenge.phases) === canonicalJson(MINI_LEDGER_V7_PHASE_IDS), 'V7 calibration phases changed');
  invariant(canonicalJson(challenge.scoringFamilies) === canonicalJson(MINI_LEDGER_V7_FAMILIES), 'V7 calibration scoring families changed');
  invariant(challenge.protocol?.phases === 5 && challenge.protocol?.turns === 5 && challenge.protocol?.maxPhaseTimeMs === 1_500_000, 'V7 calibration phase protocol changed');
  invariant(challenge.protocol.sameWorkspace === true && challenge.protocol.sameSession === true && challenge.protocol.progressiveRequirementDisclosure === true && challenge.protocol.futureRequirementsWithheldUntilTurn === true, 'V7 calibration long-horizon protocol changed');
  invariant(challenge.protocol.gradeCleanSourcePatchOnly === true && challenge.protocol.network === 'disabled' && challenge.protocol.humanIntervention === 'invalidates-run', 'V7 calibration isolation protocol changed');
  invariant(challenge.feedbackPolicy === 'self-service-public-only', 'V7 calibration feedback policy changed');
  invariant(challenge.guidance?.authoritativeRequirementsRemainTrue === true && challenge.guidance?.falseInformationRestrictedToAuxiliaryEvidence === true && challenge.guidance?.mustBeFalsifiableFromWorkspaceEvidence === true && challenge.guidance?.releaseEligibility === 'calibration-only', 'V7 calibration guidance contract changed');
  sha256(challenge.packSelection?.sourceManifestSha256, 'V7 calibration source manifest hash');
  invariant(challenge.packSelection.sourceManifestRevision === challenge.protocolRevision, 'V7 calibration manifest revision changed');
  invariant(typeof challenge.packSelection.sourceManifestSealedAt === 'string' && Number.isFinite(Date.parse(challenge.packSelection.sourceManifestSealedAt)), 'V7 calibration manifest timestamp is invalid');
  invariant(challenge.packSelection.createdBeforeFrontierPilotResults === true && challenge.packSelection.selectionFromModelFailures === 'forbidden', 'V7 calibration precommitment policy changed');
  invariant(challenge.packSelection.pool === challenge.pool && challenge.packSelection.rule === `all-presealed-${challenge.pool}-packs`, 'V7 calibration pool selection rule changed');
  invariant(canonicalJson(challenge.packSelection.instanceIds) === canonicalJson(V7_POOL_INSTANCES[challenge.pool]), 'V7 calibration pack set changed');
  const expectedVariants = challenge.pool === 'dev' ? ['clean', 'decoy'] : ['decoy'];
  invariant(canonicalJson(challenge.packSelection.variants) === canonicalJson(expectedVariants), 'V7 calibration variants changed');
  const expectedCount = V7_POOL_INSTANCES[challenge.pool].length * expectedVariants.length;
  invariant(Array.isArray(challenge.instances) && challenge.instances.length === expectedCount, 'V7 calibration instance count changed');
  challenge.instances.forEach((instance) => validateCalibrationInstance(instance, { pool: challenge.pool }));
  invariant(new Set(challenge.instances.map(({ instanceSha256 }) => instanceSha256)).size === expectedCount, 'V7 calibration instance seals are not unique');
  for (const instanceId of V7_POOL_INSTANCES[challenge.pool]) {
    const variants = challenge.instances.filter((instance) => instance.instanceId === instanceId).map(({ variant }) => variant).sort();
    invariant(canonicalJson(variants) === canonicalJson([...expectedVariants].sort()), `V7 calibration variants are incomplete for ${instanceId}`);
    if (challenge.pool === 'dev') {
      const twins = challenge.instances.filter((instance) => instance.instanceId === instanceId);
      invariant(twins[0].packCommitments.hiddenMerkleRoot === twins[1].packCommitments.hiddenMerkleRoot && twins[0].packCommitments.twinRelationSha256 === twins[1].packCommitments.twinRelationSha256, `V7 calibration twins are not matched for ${instanceId}`);
    }
  }
  if (challenge.pool === 'dev') invariant(challenge.selection === null, 'Development pilot may not be selected from scored results');
  else validateReserveSelection(challenge.selection);
  if (requireExecution) {
    invariant(challenge.execution && typeof challenge.execution === 'object' && !Array.isArray(challenge.execution), 'V7 calibration execution binding is required');
    invariant(challenge.execution.feedbackPolicy === 'self-service-public-only', 'V7 calibration execution feedback policy changed');
    invariant(challenge.execution.perPhaseLimitMs === 1_500_000, 'V7 calibration execution phase limit changed');
    invariant(challenge.execution.agentToolRuntimePolicy?.traceAudit === 'sandbox-enforced-attempt-observation'
      && challenge.execution.agentToolRuntimePolicy?.blockedAttemptDisposition === 'ordinary-tool-error-run-remains-scoreable'
      && challenge.execution.agentToolRuntimePolicy?.modelCommandCapabilities === 'fail-closed-zero-mask-guard', 'V7 calibration runtime boundary policy changed');
    validateTerminalV7ExecutionBinding(challenge.execution);
  }
  rejectSensitiveKeys(challenge);
  return challenge;
}

export function validateTerminalV7CalibrationChallengeAgainstManifest(challenge, sealManifest, { seedKey = null } = {}) {
  validateTerminalV7CalibrationChallenge(challenge);
  invariant(challenge.packSelection.sourceManifestSha256 === sealManifest?.manifestSha256, 'V7 calibration challenge does not match its seal manifest');
  invariant(challenge.protocolRevision === sealManifest.revision, 'V7 calibration challenge and seal-manifest revisions differ');
  const variants = challenge.pool === 'dev' ? ['clean', 'decoy'] : ['decoy'];
  const expected = sealedPacksFromManifest(sealManifest, challenge.pool, variants, { seedKey }).map(instanceFromPack);
  invariant(canonicalJson(challenge.instances) === canonicalJson(expected), 'V7 calibration challenge pack commitments differ from the seal manifest');
  return challenge;
}

function safeRelativePath(value, label) {
  nonEmpty(value, label);
  invariant(!value.startsWith('/') && !value.includes('\0'), `${label} is unsafe`);
  const segments = value.split('/');
  invariant(segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..'), `${label} is unsafe`);
  return value;
}

export function createTerminalV7CalibrationTaskBinding({
  sealManifest,
  pool = 'dev',
  seedKey = null,
  taskSets,
} = {}) {
  invariant(CALIBRATION_POOLS.has(pool), `Unsupported V7 calibration task pool: ${pool}`);
  const variants = pool === 'dev' ? ['clean', 'decoy'] : ['decoy'];
  const packs = sealedPacksFromManifest(sealManifest, pool, variants, { seedKey });
  const instances = packs.map(instanceFromPack);
  invariant(Array.isArray(taskSets) && taskSets.length === variants.length, `V7 ${pool} task binding requires ${variants.length} task-set manifest(s)`);
  const byVariant = new Map();
  for (const taskSet of taskSets) {
    invariant(taskSet?.schemaVersion === 'agentbattler.harbor-mini-ledger-v7-task-set.v1', 'Unsupported V7 Harbor task-set schema');
    invariant(taskSet.challengeId === 'terminal-mini-ledger-v7' && taskSet.pool === pool && variants.includes(taskSet.variant), 'V7 Harbor task-set campaign identity changed');
    invariant(taskSet.feedbackPolicy === 'self-service-public-only' && taskSet.phaseLimitMs === 1_500_000, 'V7 Harbor task-set phase policy changed');
    invariant(!byVariant.has(taskSet.variant), `Duplicate V7 Harbor ${taskSet.variant} task set`);
    invariant(Array.isArray(taskSet.tasks) && taskSet.tasks.length === V7_POOL_INSTANCES[pool].length, `V7 Harbor ${taskSet.variant} task set is incomplete`);
    byVariant.set(taskSet.variant, taskSet);
  }
  invariant(sameMembers([...byVariant.keys()], variants), `V7 ${pool} Harbor task variants are incomplete`);
  const tasks = {};
  for (const instance of instances) {
    const taskSet = byVariant.get(instance.variant);
    const matches = taskSet.tasks.filter((task) => task.instanceId === instance.instanceId && task.variant === instance.variant);
    invariant(matches.length === 1, `V7 Harbor task is not unique for ${instance.instanceId}/${instance.variant}`);
    const task = matches[0];
    invariant(task.packSha256 === instance.packCommitments.packSha256 && task.sealSha256 === instance.packCommitments.sealSha256, `V7 Harbor task pack commitment changed for ${instance.instanceId}/${instance.variant}`);
    invariant(task.taskPathBase === 'result-root', 'V7 calibration Harbor tasks must stay under the private result-root control directory');
    safeRelativePath(task.taskPath, `V7 Harbor task path for ${instance.instanceId}/${instance.variant}`);
    sha256(task.sha256, `V7 Harbor task tree hash for ${instance.instanceId}/${instance.variant}`);
    invariant(Number.isSafeInteger(task.fileCount) && task.fileCount > 0, `V7 Harbor task file count is invalid for ${instance.instanceId}/${instance.variant}`);
    const imageReferences = {};
    for (const kind of ['environment', 'verifier']) {
      const image = task.images?.[kind];
      invariant(image?.kind === kind && /^sha256:[0-9a-f]{64}$/.test(image.imageId ?? '') && /^[0-9a-f]{64}$/.test(image.sourceSha256 ?? ''), `V7 Harbor ${kind} image commitment is invalid for ${instance.instanceId}/${instance.variant}`);
      imageReferences[kind] = image.imageId;
    }
    tasks[instance.instanceSha256] = {
      instanceId: instance.instanceId,
      variant: instance.variant,
      taskPathBase: 'result-root',
      taskPath: task.taskPath,
      sha256: task.sha256,
      fileCount: task.fileCount,
      images: task.images,
      imageReferences,
      packSha256: task.packSha256,
      sealSha256: task.sealSha256,
    };
  }
  const unsigned = {
    schemaVersion: TERMINAL_V7_CALIBRATION_TASK_BINDING_SCHEMA,
    challengeId: 'terminal-mini-ledger-v7',
    pool,
    sealManifestSha256: sealManifest.manifestSha256,
    variants,
    instanceIds: [...V7_POOL_INSTANCES[pool]],
    storagePolicy: 'private-result-root-control-directory',
    selectionFromModelFailures: 'forbidden',
    tasks,
  };
  return { ...unsigned, taskBindingSha256: canonicalJsonSha256(unsigned) };
}

export function validateTerminalV7CalibrationTaskBinding(binding, challenge) {
  validateTerminalV7CalibrationChallenge(challenge);
  invariant(binding?.schemaVersion === TERMINAL_V7_CALIBRATION_TASK_BINDING_SCHEMA, 'Unsupported V7 calibration task-binding schema');
  const { taskBindingSha256, ...unsigned } = binding;
  invariant(taskBindingSha256 === canonicalJsonSha256(unsigned), 'V7 calibration task-binding hash mismatch');
  invariant(binding.challengeId === challenge.id && binding.pool === challenge.pool, 'V7 calibration task binding campaign changed');
  invariant(binding.sealManifestSha256 === challenge.packSelection.sourceManifestSha256, 'V7 calibration task binding seal manifest changed');
  invariant(canonicalJson(binding.variants) === canonicalJson(challenge.packSelection.variants) && canonicalJson(binding.instanceIds) === canonicalJson(challenge.packSelection.instanceIds), 'V7 calibration task binding pack set changed');
  invariant(binding.storagePolicy === 'private-result-root-control-directory' && binding.selectionFromModelFailures === 'forbidden', 'V7 calibration task binding policy changed');
  invariant(binding.tasks && Object.keys(binding.tasks).length === challenge.instances.length, 'V7 calibration task binding is incomplete');
  for (const instance of challenge.instances) {
    const task = binding.tasks[instance.instanceSha256];
    invariant(task?.instanceId === instance.instanceId && task?.variant === instance.variant, `V7 calibration task identity changed for ${instance.instanceId}/${instance.variant}`);
    invariant(task.taskPathBase === 'result-root', 'V7 calibration task escaped its private result root');
    safeRelativePath(task.taskPath, `V7 calibration task path for ${instance.instanceId}/${instance.variant}`);
    sha256(task.sha256, `V7 calibration task tree hash for ${instance.instanceId}/${instance.variant}`);
    invariant(Number.isSafeInteger(task.fileCount) && task.fileCount > 0, `V7 calibration task file count changed for ${instance.instanceId}/${instance.variant}`);
    for (const kind of ['environment', 'verifier']) {
      const image = task.images?.[kind];
      invariant(image?.kind === kind && /^sha256:[0-9a-f]{64}$/.test(image.imageId ?? '') && /^[0-9a-f]{64}$/.test(image.sourceSha256 ?? ''), `V7 calibration ${kind} image commitment changed for ${instance.instanceId}/${instance.variant}`);
      invariant(task.imageReferences?.[kind] === image.imageId, `V7 calibration ${kind} task image reference is not the sealed image ID for ${instance.instanceId}/${instance.variant}`);
    }
    invariant(task.packSha256 === instance.packCommitments.packSha256 && task.sealSha256 === instance.packCommitments.sealSha256, `V7 calibration task commitment changed for ${instance.instanceId}/${instance.variant}`);
  }
  rejectSensitiveKeys(binding);
  return binding;
}

function normalizeHarness(harness, label) {
  invariant(harness && typeof harness === 'object' && !Array.isArray(harness), `${label} is required`);
  return { id: nonEmpty(harness.id, `${label} ID`), version: nonEmpty(harness.version, `${label} version`) };
}

function normalizeLunaModel(model, effort, label) {
  invariant(model && typeof model === 'object' && !Array.isArray(model), `${label} is required`);
  const normalized = {
    id: nonEmpty(model.id, `${label} ID`),
    familyId: nonEmpty(model.familyId, `${label} family ID`),
    reasoningEffort: nonEmpty(model.reasoningEffort, `${label} reasoning effort`),
  };
  invariant(normalized.id === TERMINAL_V7_PILOT_POLICY.modelId && normalized.familyId === TERMINAL_V7_PILOT_POLICY.familyId && normalized.reasoningEffort === effort, `${label} must be Luna/${effort}`);
  return normalized;
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

function permutation(values, seed) {
  const result = [...values];
  const random = mulberry32(seed);
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

function instanceForJob(challenge, instanceId, variant) {
  const matches = challenge.instances.filter((instance) => instance.instanceId === instanceId && instance.variant === variant);
  invariant(matches.length === 1, `V7 calibration challenge has no unique ${instanceId}/${variant} instance`);
  return matches[0];
}

function createJob({ challenge, scheduleSeed, harness, model, instance, round, executionIndex, pilotArm = null }) {
  const descriptor = {
    schemaVersion: TERMINAL_V7_RUN_SCHEMA,
    challengeId: challenge.challengeId,
    challengeSha256: challenge.challengeSha256,
    instanceId: instance.instanceId,
    instanceSha256: instance.instanceSha256,
    generationIndex: instance.ordinal,
    harness: { ...harness },
    model: { ...model },
    instanceVariant: instance.variant,
    round,
    executionIndex,
    repeat: 1,
    seed: instance.generator.seedFingerprint,
    seedFingerprint: instance.generator.seedFingerprint,
    scheduleSeed,
    ...(pilotArm ? { pilotArm } : {}),
  };
  return { runKey: canonicalJsonSha256(descriptor), ...descriptor };
}

function sealSchedule(descriptor) {
  return seal('schedule', descriptor);
}

export function createTerminalV7DevelopmentPilotSchedule({
  challenge,
  harnesses,
  maxModel = { id: 'gpt-5.6-luna', familyId: 'luna', reasoningEffort: 'max' },
  highModel = { id: 'gpt-5.6-luna', familyId: 'luna', reasoningEffort: 'high' },
  seed = 20_260_808,
} = {}) {
  validateTerminalV7CalibrationChallenge(challenge);
  invariant(challenge.pool === 'dev', 'Development pilot requires the sealed development pool');
  uint32(seed, 'V7 development-pilot schedule seed');
  invariant(Array.isArray(harnesses) && harnesses.length === 2, 'Development pilot requires exactly Codex and Pi');
  const normalizedHarnesses = harnesses.map((harness, index) => normalizeHarness(harness, `Pilot harness ${index + 1}`)).sort((left, right) => left.id.localeCompare(right.id));
  invariant(canonicalJson(normalizedHarnesses.map(({ id }) => id)) === canonicalJson(['codex-cli', 'pi-coding-agent']), 'Development pilot harnesses must be Codex and Pi');
  const codex = normalizedHarnesses.find(({ id }) => id === 'codex-cli');
  const pi = normalizedHarnesses.find(({ id }) => id === 'pi-coding-agent');
  const normalizedMax = normalizeLunaModel(maxModel, 'max', 'Pilot max model');
  const normalizedHigh = normalizeLunaModel(highModel, 'high', 'Pilot high model');
  const packOrder = permutation([...V7_POOL_INSTANCES.dev], mixSeed(seed, 'development-pack-order'));
  const lanes = [
    { harness: codex, model: normalizedMax, variant: 'clean', pilotArm: 'luna-max-twin' },
    { harness: pi, model: normalizedMax, variant: 'clean', pilotArm: 'luna-max-twin' },
    { harness: codex, model: normalizedMax, variant: 'decoy', pilotArm: 'luna-max-twin' },
    { harness: pi, model: normalizedMax, variant: 'decoy', pilotArm: 'luna-max-twin' },
  ];
  const jobs = [];
  const rounds = [];
  for (let round = 1; round <= 4; round += 1) {
    const runKeys = [];
    for (let row = 0; row < packOrder.length; row += 1) {
      const lane = lanes[(row + round - 1) % lanes.length];
      const instance = instanceForJob(challenge, packOrder[row], lane.variant);
      const job = createJob({ challenge, scheduleSeed: seed, instance, round, executionIndex: jobs.length + 1, ...lane });
      jobs.push(job);
      runKeys.push(job.runKey);
    }
    rounds.push({ round, purpose: 'luna-max-clean-decoy-rotation', runKeys });
  }
  const anchorRunKeys = [];
  for (const instanceId of packOrder) {
    const instance = instanceForJob(challenge, instanceId, 'decoy');
    const job = createJob({
      challenge,
      scheduleSeed: seed,
      harness: codex,
      model: normalizedHigh,
      instance,
      round: 5,
      executionIndex: jobs.length + 1,
      pilotArm: 'luna-high-anchor',
    });
    jobs.push(job);
    anchorRunKeys.push(job.runKey);
  }
  rounds.push({ round: 5, purpose: 'luna-high-codex-decoy-anchor', runKeys: anchorRunKeys });
  const schedule = sealSchedule({
    schemaVersion: TERMINAL_V7_CALIBRATION_SCHEDULE_SCHEMA,
    kind: 'precommitted-development-pilot-five-round-rotation',
    campaign: 'development-pilot',
    challenge: { id: challenge.challengeId, sha256: challenge.challengeSha256 },
    seed,
    matrix: {
      harnesses: normalizedHarnesses,
      models: { max: normalizedMax, high: normalizedHigh },
      instanceIds: [...V7_POOL_INSTANCES.dev],
      variants: ['clean', 'decoy'],
      maxRuns: 12,
      highAnchorRuns: 3,
      expectedRuns: 15,
    },
    executionOrder: { mode: 'round-major', rounds },
    jobs,
  });
  return validateTerminalV7CalibrationSchedule(schedule, challenge);
}

function validateJobSeal(job, challenge, schedule, index) {
  invariant(job?.schemaVersion === TERMINAL_V7_RUN_SCHEMA, 'V7 calibration job must use terminal run v1');
  const { runKey, ...descriptor } = job;
  invariant(runKey === canonicalJsonSha256(descriptor), `V7 calibration run-key mismatch at execution ${index + 1}`);
  invariant(job.challengeId === challenge.challengeId && job.challengeSha256 === challenge.challengeSha256, 'V7 calibration job challenge changed');
  const instance = challenge.instances.find(({ instanceSha256 }) => instanceSha256 === job.instanceSha256);
  invariant(instance && instance.instanceId === job.instanceId && instance.variant === job.instanceVariant, 'V7 calibration job instance commitment changed');
  invariant(job.generationIndex === instance.ordinal && job.seed === instance.generator.seedFingerprint && job.seedFingerprint === instance.generator.seedFingerprint, 'V7 calibration job seed or ordinal changed');
  invariant(job.scheduleSeed === schedule.seed && job.executionIndex === index + 1 && job.repeat === 1, 'V7 calibration execution identity changed');
  return instance;
}

export function validateTerminalV7CalibrationSchedule(schedule, challenge) {
  validateTerminalV7CalibrationChallenge(challenge);
  invariant(schedule?.schemaVersion === TERMINAL_V7_CALIBRATION_SCHEDULE_SCHEMA, 'Unsupported V7 calibration schedule schema');
  const { scheduleId, scheduleSha256, ...descriptor } = schedule;
  const actual = canonicalJsonSha256(descriptor);
  invariant(scheduleSha256 === actual && scheduleId === `schedule-${actual.slice(0, 16)}`, 'V7 calibration schedule hash mismatch');
  invariant(schedule.challenge?.id === challenge.challengeId && schedule.challenge?.sha256 === challenge.challengeSha256, 'V7 calibration schedule challenge changed');
  uint32(schedule.seed, 'V7 calibration schedule seed');
  invariant(Array.isArray(schedule.jobs), 'V7 calibration schedule jobs are missing');
  invariant(new Set(schedule.jobs.map(({ runKey }) => runKey)).size === schedule.jobs.length, 'V7 calibration schedule has duplicate run keys');
  invariant(schedule.executionOrder?.mode === 'round-major' && Array.isArray(schedule.executionOrder.rounds), 'V7 calibration execution order changed');
  schedule.jobs.forEach((job, index) => validateJobSeal(job, challenge, schedule, index));
  for (const [index, round] of schedule.executionOrder.rounds.entries()) {
    invariant(round.round === index + 1, 'V7 calibration rounds are not sequential');
    invariant(canonicalJson(round.runKeys) === canonicalJson(schedule.jobs.filter((job) => job.round === round.round).map(({ runKey }) => runKey)), `V7 calibration round ${round.round} order changed`);
  }
  if (schedule.campaign === 'development-pilot') validateDevelopmentScheduleShape(schedule, challenge);
  else if (schedule.campaign === 'reserve-extension') validateReserveScheduleShape(schedule, challenge);
  else throw new Error(`Unsupported V7 calibration campaign: ${schedule.campaign ?? 'missing'}`);
  rejectSensitiveKeys(schedule);
  return schedule;
}

function validateDevelopmentScheduleShape(schedule, challenge) {
  invariant(challenge.pool === 'dev' && schedule.kind === 'precommitted-development-pilot-five-round-rotation', 'V7 development schedule kind or pool changed');
  invariant(schedule.matrix?.expectedRuns === 15 && schedule.matrix.maxRuns === 12 && schedule.matrix.highAnchorRuns === 3 && schedule.jobs.length === 15, 'V7 development pilot must contain exactly 15 jobs');
  invariant(canonicalJson(schedule.matrix.instanceIds) === canonicalJson(V7_POOL_INSTANCES.dev) && canonicalJson(schedule.matrix.variants) === canonicalJson(['clean', 'decoy']), 'V7 development pilot pack matrix changed');
  invariant(schedule.executionOrder.rounds.length === 5, 'V7 development pilot must contain five rounds');
  invariant(Array.isArray(schedule.matrix.harnesses) && canonicalJson(schedule.matrix.harnesses.map(({ id }) => id)) === canonicalJson(['codex-cli', 'pi-coding-agent']), 'V7 development pilot harness matrix changed');
  schedule.matrix.harnesses.forEach((harness, index) => normalizeHarness(harness, `Pilot matrix harness ${index + 1}`));
  const matrixMax = normalizeLunaModel(schedule.matrix.models?.max, 'max', 'Pilot matrix max model');
  const matrixHigh = normalizeLunaModel(schedule.matrix.models?.high, 'high', 'Pilot matrix high model');
  const maxJobs = schedule.jobs.filter((job) => job.model.reasoningEffort === 'max');
  const highJobs = schedule.jobs.filter((job) => job.model.reasoningEffort === 'high');
  invariant(maxJobs.length === 12 && highJobs.length === 3, 'V7 development pilot reasoning-effort counts changed');
  invariant(schedule.jobs.every((job) => job.model.id === 'gpt-5.6-luna' && job.model.familyId === 'luna'), 'V7 development pilot model changed');
  invariant(schedule.jobs.every((job) => {
    const harness = schedule.matrix.harnesses.find(({ id }) => id === job.harness.id);
    const model = job.model.reasoningEffort === 'max' ? matrixMax : matrixHigh;
    return harness && canonicalJson(job.harness) === canonicalJson(harness) && canonicalJson(job.model) === canonicalJson(model);
  }), 'V7 development pilot job runtime descriptors differ from the matrix');
  invariant(maxJobs.every((job) => ['codex-cli', 'pi-coding-agent'].includes(job.harness.id) && job.pilotArm === 'luna-max-twin'), 'V7 development-pilot max arm changed');
  invariant(highJobs.every((job) => job.harness.id === 'codex-cli' && job.instanceVariant === 'decoy' && job.pilotArm === 'luna-high-anchor'), 'V7 development-pilot high anchor changed');
  const maxCoverage = new Map();
  for (const job of maxJobs) increment(maxCoverage, `${job.harness.id}\0${job.instanceId}\0${job.instanceVariant}`);
  invariant(everyCount(maxCoverage, 12, 1), 'V7 development pilot does not cover every max harness/pack/twin combination exactly once');
  const highCoverage = new Map();
  for (const job of highJobs) increment(highCoverage, job.instanceId);
  invariant(everyCount(highCoverage, 3, 1), 'V7 development pilot high anchor does not cover all development packs');
  for (let round = 1; round <= 5; round += 1) {
    const jobs = schedule.jobs.filter((job) => job.round === round);
    invariant(jobs.length === 3 && sameMembers(jobs.map(({ instanceId }) => instanceId), V7_POOL_INSTANCES.dev), `V7 development pilot round ${round} must contain every development pack once`);
    if (round <= 4) invariant(jobs.every((job) => job.model.reasoningEffort === 'max'), `V7 development pilot round ${round} must contain only Luna/max jobs`);
  }
  for (const instanceId of V7_POOL_INSTANCES.dev) {
    const jobs = maxJobs.filter((job) => job.instanceId === instanceId);
    invariant(everyCount(new Map(jobs.map((job) => [`${job.harness.id}\0${job.instanceVariant}`, 1])), 4, 1), `V7 development pack ${instanceId} did not rotate through all max twin lanes`);
  }
}

function validateReserveSelection(selection) {
  invariant(selection && typeof selection === 'object' && !Array.isArray(selection), 'V7 reserve challenge requires a release-result selection commitment');
  invariant(selection.rule === 'statistically-unresolved-leading-pair-only', 'V7 reserve leading-pair rule changed');
  invariant(selection.releaseDecision === 'tie' && selection.confidenceIntervalExcludesZero === false, 'V7 reserve extension requires an unresolved release comparison');
  invariant(Array.isArray(selection.leadingPairHarnessIds) && selection.leadingPairHarnessIds.length === 2 && new Set(selection.leadingPairHarnessIds).size === 2, 'V7 reserve leading pair is invalid');
  selection.leadingPairHarnessIds.forEach((id) => nonEmpty(id, 'V7 reserve leading harness ID'));
  for (const field of ['releaseChallengeSha256', 'releaseScheduleSha256', 'releaseResultSetSha256', 'releaseAnalysisSha256']) sha256(selection[field], `V7 reserve ${field}`);
  invariant(selection.packRule === 'all-five-already-sealed-reserve-packs' && selection.packSelectionFromModelFailures === 'forbidden', 'V7 reserve pack-selection rule changed');
}

function validateReserveScheduleShape(schedule, challenge) {
  invariant(challenge.pool === 'reserve' && schedule.kind === 'precommitted-five-pack-leading-pair-extension', 'V7 reserve schedule kind or pool changed');
  validateReserveSelection(challenge.selection);
  invariant(schedule.matrix?.expectedRuns === 10 && schedule.jobs.length === 10, 'V7 reserve extension must contain exactly 10 jobs');
  invariant(canonicalJson(schedule.selection) === canonicalJson(challenge.selection), 'V7 reserve schedule selection commitment changed');
  invariant(canonicalJson(schedule.matrix.instanceIds) === canonicalJson(V7_POOL_INSTANCES.reserve) && canonicalJson(schedule.matrix.variants) === canonicalJson(['decoy']), 'V7 reserve pack matrix changed');
  invariant(sameMembers(schedule.matrix.harnesses.map(({ id }) => id), challenge.selection.leadingPairHarnessIds), 'V7 reserve harness pair differs from its release decision');
  schedule.matrix.harnesses.forEach((harness, index) => normalizeHarness(harness, `Reserve matrix harness ${index + 1}`));
  const matrixModel = normalizeLunaModel(schedule.matrix.model, 'max', 'Reserve matrix model');
  invariant(schedule.executionOrder.rounds.length === 5, 'V7 reserve extension must contain five rounds');
  const coverage = new Map();
  for (const job of schedule.jobs) {
    invariant(job.model.id === 'gpt-5.6-luna' && job.model.familyId === 'luna' && job.model.reasoningEffort === 'max', 'V7 reserve model must remain Luna/max');
    const harness = schedule.matrix.harnesses.find(({ id }) => id === job.harness.id);
    invariant(harness && canonicalJson(job.harness) === canonicalJson(harness) && canonicalJson(job.model) === canonicalJson(matrixModel), 'V7 reserve job runtime descriptor differs from the matrix');
    invariant(job.instanceVariant === 'decoy' && job.pilotArm === undefined, 'V7 reserve jobs must use only sealed decoy packs');
    increment(coverage, `${job.harness.id}\0${job.instanceId}`);
  }
  invariant(everyCount(coverage, 10, 1), 'V7 reserve extension does not pair both harnesses with all five packs');
  for (let round = 1; round <= 5; round += 1) {
    const jobs = schedule.jobs.filter((job) => job.round === round);
    invariant(jobs.length === 2 && jobs[0].instanceId === jobs[1].instanceId, `V7 reserve round ${round} must be a matched pack pair`);
    invariant(sameMembers(jobs.map(({ harness }) => harness.id), challenge.selection.leadingPairHarnessIds), `V7 reserve round ${round} does not contain both leading harnesses`);
  }
  invariant(sameMembers(schedule.executionOrder.rounds.map(({ instanceId }) => instanceId), V7_POOL_INSTANCES.reserve), 'V7 reserve execution order does not include every sealed reserve pack');
}

function resultSetSha256(results) {
  return canonicalJsonSha256([...results].map((result) => ({
    runKey: result.runKey,
    resultSha256: result.resultSha256 ?? canonicalJsonSha256(result),
  })).sort((left, right) => left.runKey.localeCompare(right.runKey)));
}

function scoreReleaseResults({ releaseChallenge, releaseSchedule, releaseResults }) {
  validateTerminalV7Challenge(releaseChallenge);
  validateTerminalV7Schedule(releaseSchedule, releaseChallenge);
  invariant(Array.isArray(releaseResults) && releaseResults.length === releaseSchedule.jobs.length, 'Reserve selection requires every release result');
  const byRunKey = new Map(releaseResults.map((result) => [result.runKey, result]));
  invariant(byRunKey.size === releaseResults.length, 'Reserve selection received duplicate release results');
  const scored = [];
  for (const job of releaseSchedule.jobs) {
    const result = byRunKey.get(job.runKey);
    invariant(result, `Reserve selection is missing release run ${job.runKey}`);
    validateTerminalJobIdentity(job, result);
    invariant(result.status === 'completed' && result.validity === 'valid', `Reserve selection refuses non-valid release run ${job.runKey}`);
    invariant(typeof result.resultSha256 === 'string' && SHA256_RE.test(result.resultSha256), `Reserve selection requires a sealed release result for ${job.runKey}`);
    const { resultSha256, ...unsigned } = result;
    invariant(resultSha256 === canonicalJsonSha256(unsigned), `Reserve selection release result hash mismatch for ${job.runKey}`);
    const score = scoreTerminalV7Run(result, releaseChallenge);
    scored.push({ harnessId: job.harness.id, instanceId: job.instanceId, score });
  }
  return scored;
}

function leadingPair(scored) {
  const groups = new Map();
  for (const row of scored) {
    if (!groups.has(row.harnessId)) groups.set(row.harnessId, []);
    groups.get(row.harnessId).push(row.score.core.points);
  }
  const standings = [...groups].map(([harnessId, values]) => ({
    harnessId,
    meanCore: values.reduce((sum, value) => sum + value, 0) / values.length,
  })).sort((left, right) => right.meanCore - left.meanCore || left.harnessId.localeCompare(right.harnessId));
  invariant(standings.length >= 2, 'Reserve selection requires at least two release harnesses');
  return { standings, ids: standings.slice(0, 2).map(({ harnessId }) => harnessId) };
}

export function createTerminalV7ReserveExtension({
  sealManifest,
  seedKey,
  releaseChallenge,
  releaseSchedule,
  releaseResults,
  harnesses,
  model = { id: 'gpt-5.6-luna', familyId: 'luna', reasoningEffort: 'max' },
  seed = 20_260_808,
  execution = null,
} = {}) {
  uint32(seed, 'V7 reserve schedule seed');
  const scored = scoreReleaseResults({ releaseChallenge, releaseSchedule, releaseResults });
  const analysis = analyzeTerminalV7PairedPacks(scored, { challenge: releaseChallenge });
  const leaders = leadingPair(scored);
  const comparison = analysis.comparisons.find(({ leftHarnessId, rightHarnessId }) => sameMembers([leftHarnessId, rightHarnessId], leaders.ids));
  invariant(comparison && comparison.decision === 'tie' && comparison.confidenceExcludesZero === false, 'Reserve extension is forbidden because the leading release pair is statistically resolved');
  invariant(Array.isArray(harnesses), 'Reserve extension harness descriptors are required');
  const normalizedHarnesses = harnesses.map((harness, index) => normalizeHarness(harness, `Reserve harness ${index + 1}`));
  const selectedHarnesses = leaders.ids.map((id) => {
    const matches = normalizedHarnesses.filter((harness) => harness.id === id);
    invariant(matches.length === 1, `Reserve extension has no unique runtime descriptor for ${id}`);
    return matches[0];
  });
  const selection = {
    rule: 'statistically-unresolved-leading-pair-only',
    releaseDecision: 'tie',
    confidenceIntervalExcludesZero: false,
    leadingPairHarnessIds: [...leaders.ids],
    releaseChallengeSha256: releaseChallenge.challengeSha256,
    releaseScheduleSha256: releaseSchedule.scheduleSha256,
    releaseResultSetSha256: resultSetSha256(releaseResults),
    releaseAnalysisSha256: canonicalJsonSha256(analysis),
    packRule: 'all-five-already-sealed-reserve-packs',
    packSelectionFromModelFailures: 'forbidden',
  };
  const challenge = createTerminalV7CalibrationChallenge({ sealManifest, pool: 'reserve', seedKey, execution, selection });
  const normalizedModel = normalizeLunaModel(model, 'max', 'Reserve model');
  const packOrder = permutation([...V7_POOL_INSTANCES.reserve], mixSeed(seed, 'reserve-pack-order'));
  const harnessOrder = permutation(selectedHarnesses, mixSeed(seed, 'reserve-harness-order'));
  const jobs = [];
  const rounds = [];
  for (let index = 0; index < packOrder.length; index += 1) {
    const round = index + 1;
    const instanceId = packOrder[index];
    const runKeys = [];
    for (const harness of (round % 2 === 0 ? [...harnessOrder].reverse() : harnessOrder)) {
      const instance = instanceForJob(challenge, instanceId, 'decoy');
      const job = createJob({ challenge, scheduleSeed: seed, harness, model: normalizedModel, instance, round, executionIndex: jobs.length + 1 });
      jobs.push(job);
      runKeys.push(job.runKey);
    }
    rounds.push({ round, purpose: 'matched-reserve-pack-pair', instanceId, runKeys });
  }
  const schedule = sealSchedule({
    schemaVersion: TERMINAL_V7_CALIBRATION_SCHEDULE_SCHEMA,
    kind: 'precommitted-five-pack-leading-pair-extension',
    campaign: 'reserve-extension',
    challenge: { id: challenge.challengeId, sha256: challenge.challengeSha256 },
    seed,
    matrix: {
      harnesses: selectedHarnesses.sort((left, right) => left.id.localeCompare(right.id)),
      model: normalizedModel,
      instanceIds: [...V7_POOL_INSTANCES.reserve],
      variants: ['decoy'],
      expectedRuns: 10,
    },
    selection,
    executionOrder: { mode: 'round-major', rounds },
    jobs,
  });
  validateTerminalV7CalibrationSchedule(schedule, challenge);
  invariant(canonicalJson(schedule.selection) === canonicalJson(challenge.selection), 'V7 reserve schedule selection commitment changed');
  return { challenge, schedule, releaseAnalysis: analysis, releaseStandings: leaders.standings };
}

export function createTerminalV7CalibrationExecutionUnit({ challenge, schedule, runKey } = {}) {
  validateTerminalV7CalibrationSchedule(schedule, challenge);
  const matches = schedule.jobs.filter((job) => job.runKey === runKey);
  invariant(matches.length === 1, `V7 calibration run key is not uniquely scheduled: ${runKey ?? 'missing'}`);
  const descriptor = {
    schemaVersion: TERMINAL_V7_CALIBRATION_EXECUTION_UNIT_SCHEMA,
    challenge: { id: challenge.challengeId, sha256: challenge.challengeSha256 },
    schedule: { id: schedule.scheduleId, sha256: schedule.scheduleSha256 },
    executionIndex: matches[0].executionIndex,
    job: clone(matches[0]),
  };
  return { ...descriptor, unitSha256: canonicalJsonSha256(descriptor) };
}

export function validateTerminalV7CalibrationExecutionUnit(unit, { challenge, schedule } = {}) {
  validateTerminalV7CalibrationSchedule(schedule, challenge);
  invariant(unit?.schemaVersion === TERMINAL_V7_CALIBRATION_EXECUTION_UNIT_SCHEMA, 'Unsupported V7 calibration execution-unit schema');
  const { unitSha256, ...descriptor } = unit;
  invariant(unitSha256 === canonicalJsonSha256(descriptor), 'V7 calibration execution-unit hash mismatch');
  invariant(unit.challenge?.id === challenge.challengeId && unit.challenge?.sha256 === challenge.challengeSha256, 'V7 calibration execution-unit challenge changed');
  invariant(unit.schedule?.id === schedule.scheduleId && unit.schedule?.sha256 === schedule.scheduleSha256, 'V7 calibration execution-unit schedule changed');
  const scheduled = schedule.jobs.find(({ runKey }) => runKey === unit.job?.runKey);
  invariant(scheduled && canonicalJson(scheduled) === canonicalJson(unit.job) && unit.executionIndex === scheduled.executionIndex, 'V7 calibration execution-unit job changed');
  return unit;
}

export function terminalV7CalibrationAdapterJob(unit, challenge) {
  invariant(unit?.schemaVersion === TERMINAL_V7_CALIBRATION_EXECUTION_UNIT_SCHEMA, 'V7 calibration execution unit is required');
  invariant(unit.challenge?.id === challenge?.challengeId && unit.challenge?.sha256 === challenge?.challengeSha256, 'V7 calibration execution unit does not match its challenge');
  const job = unit.job;
  return {
    ...job,
    harness: job.harness.id,
    harnessVersion: job.harness.version,
    model: job.model.id,
    modelFamilyId: job.model.familyId,
    reasoningEffort: job.model.reasoningEffort,
    generationSettings: {},
    maxWallTimeMs: challenge.protocol.maxPhaseTimeMs,
    executionConcurrency: 1,
  };
}

function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function checkSet(value, label, maxPoints) {
  invariant(value && Number.isSafeInteger(value.passed) && Number.isSafeInteger(value.total) && value.total > 0, `${label} counts are invalid`);
  invariant(value.passed >= 0 && value.passed <= value.total, `${label} passed count is invalid`);
  return round((value.passed / value.total) * maxPoints);
}

export function scoreTerminalV7CalibrationRun(run) {
  invariant(run?.schemaVersion === TERMINAL_V7_RUN_SCHEMA && run.status === 'completed' && run.validity === 'valid', 'Only valid completed V7 calibration runs can be scored');
  invariant(Array.isArray(run.evaluation?.families) && run.evaluation.families.length === MINI_LEDGER_V7_FAMILIES.length, 'V7 calibration evaluation family set is invalid');
  const families = new Map(run.evaluation.families.map((family) => [family.id, family]));
  invariant(families.size === MINI_LEDGER_V7_FAMILIES.length && MINI_LEDGER_V7_FAMILIES.every((id) => families.has(id)), 'V7 calibration evaluation family IDs changed');
  let points = 0;
  let exact = true;
  for (const id of MINI_LEDGER_V7_FAMILIES) {
    const family = families.get(id);
    invariant(family.public?.total === 4, `V7 ${id} public total changed`);
    invariant(family.hidden?.total === 16, `V7 ${id} hidden total changed`);
    invariant(family.hiddenAtomic?.total === 6, `V7 ${id} hidden atomic total changed`);
    invariant(family.hiddenComposed?.total === 10, `V7 ${id} hidden composed total changed`);
    invariant(family.hidden.passed === family.hiddenAtomic.passed + family.hiddenComposed.passed, `V7 ${id} hidden score does not equal its atomic and composed partitions`);
    points += checkSet(family.public, `V7 ${id} public`, 4);
    points += checkSet(family.hidden, `V7 ${id} hidden`, 16);
    checkSet(family.hiddenAtomic, `V7 ${id} hidden atomic`, 6);
    checkSet(family.hiddenComposed, `V7 ${id} hidden composed`, 10);
    exact &&= family.public.passed === 4 && family.hiddenAtomic.passed === 6 && family.hiddenComposed.passed === 10;
  }
  return { corePoints: round(points), exact };
}

function median(values) {
  invariant(values.length > 0, 'Cannot take the median of an empty sample');
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : round((sorted[middle - 1] + sorted[middle]) / 2);
}

function gateCheck(checks, id, passed, observed, requirement) {
  checks.push({ id, passed: passed === true, observed, requirement });
}

function validateScriptedReferences(report) {
  validateTerminalV7ScriptedReferenceReport(report);
  const rows = report.rows;
  const implementationIds = [...new Set(rows.map((row) => nonEmpty(row.implementationId, 'Scripted reference implementation ID')))];
  invariant(implementationIds.length === 2, 'V7 pilot requires exactly two independent scripted reference implementations');
  invariant(rows.length === implementationIds.length * V7_POOL_INSTANCES.dev.length * 2, 'V7 pilot scripted-reference matrix is incomplete');
  const values = new Map();
  for (const row of rows) {
    invariant(row.status === 'completed' && row.validity === 'valid', 'V7 pilot scripted reference contains an infrastructure-invalid result');
    invariant(V7_POOL_INSTANCES.dev.includes(row.instanceId) && VARIANTS.has(row.variant), 'V7 pilot scripted reference identity changed');
    invariant(typeof row.corePoints === 'number' && Number.isFinite(row.corePoints) && row.corePoints >= 0 && row.corePoints <= 100, 'V7 pilot scripted reference Core score is invalid');
    const key = `${row.implementationId}\0${row.instanceId}\0${row.variant}`;
    invariant(!values.has(key), `Duplicate V7 pilot scripted reference: ${key}`);
    values.set(key, row.corePoints);
  }
  const differences = [];
  for (const implementationId of implementationIds) {
    for (const instanceId of V7_POOL_INSTANCES.dev) {
      const clean = values.get(`${implementationId}\0${instanceId}\0clean`);
      const decoy = values.get(`${implementationId}\0${instanceId}\0decoy`);
      invariant(clean !== undefined && decoy !== undefined, `Missing V7 scripted twin result for ${implementationId}/${instanceId}`);
      differences.push({ implementationId, instanceId, difference: round(decoy - clean) });
    }
  }
  return { implementationIds: implementationIds.sort(), differences, reportSha256: report.reportSha256 };
}

function validateHumanTwins(rows) {
  invariant(Array.isArray(rows) && rows.length > 0, 'V7 pilot human twin-validation results are required');
  const seen = new Set();
  const covered = new Set();
  const differences = [];
  for (const row of rows) {
    validateTerminalV7HumanTwinValidation(row);
    invariant(V7_POOL_INSTANCES.dev.includes(row.instanceId), 'V7 human validation uses a non-development pack');
    const key = `${row.validatorId}\0${row.instanceId}`;
    invariant(!seen.has(key), `Duplicate V7 human twin validation: ${key}`);
    seen.add(key);
    covered.add(row.instanceId);
    differences.push({ validatorId: row.validatorId, instanceId: row.instanceId, absoluteDifference: round(Math.abs(row.decoyCorePoints - row.cleanCorePoints)) });
  }
  invariant(sameMembers([...covered], V7_POOL_INSTANCES.dev), 'V7 human validation must cover all three development packs');
  return differences;
}

export function analyzeTerminalV7DevelopmentPilot({
  challenge,
  schedule,
  runs,
  scriptedReferences,
  humanTwinValidations,
} = {}) {
  validateTerminalV7CalibrationSchedule(schedule, challenge);
  invariant(schedule.campaign === 'development-pilot', 'V7 pilot analysis requires the development-pilot schedule');
  invariant(Array.isArray(runs), 'V7 development pilot runs are required');
  const expected = new Map(schedule.jobs.map((job) => [job.runKey, job]));
  const supplied = new Map();
  const infrastructureInvalid = [];
  const scored = [];
  for (const run of runs) {
    if (!expected.has(run?.runKey)) throw new Error(`Unexpected V7 pilot run: ${run?.runKey ?? 'missing'}`);
    invariant(!supplied.has(run.runKey), `Duplicate V7 pilot run: ${run.runKey}`);
    supplied.set(run.runKey, run);
  }
  for (const job of schedule.jobs) {
    const run = supplied.get(job.runKey);
    if (!run) {
      infrastructureInvalid.push({ runKey: job.runKey, reason: 'missing-run' });
      continue;
    }
    try { validateTerminalJobIdentity(job, run); } catch (error) {
      infrastructureInvalid.push({ runKey: job.runKey, reason: 'identity-invalid', detail: String(error.message).slice(0, 300) });
      continue;
    }
    if (run.status !== 'completed' || run.validity !== 'valid') {
      infrastructureInvalid.push({ runKey: job.runKey, reason: run.status ?? run.validity ?? 'invalid-run' });
      continue;
    }
    if (typeof run.resultSha256 !== 'string' || !SHA256_RE.test(run.resultSha256)) {
      infrastructureInvalid.push({ runKey: job.runKey, reason: 'unsealed-run' });
      continue;
    }
    const { resultSha256, ...unsignedRun } = run;
    if (resultSha256 !== canonicalJsonSha256(unsignedRun)) {
      infrastructureInvalid.push({ runKey: job.runKey, reason: 'result-hash-mismatch' });
      continue;
    }
    try {
      scored.push({ job, run, ...scoreTerminalV7CalibrationRun(run) });
    } catch (error) {
      infrastructureInvalid.push({ runKey: job.runKey, reason: 'unscorable-run', detail: String(error.message).slice(0, 300) });
    }
  }
  const references = validateScriptedReferences(scriptedReferences);
  const humanDifferences = validateHumanTwins(humanTwinValidations);
  const maxDecoy = scored.filter(({ job }) => job.model.reasoningEffort === 'max' && job.instanceVariant === 'decoy');
  const maxScores = scored.filter(({ job }) => job.model.reasoningEffort === 'max');
  const highScores = scored.filter(({ job }) => job.model.reasoningEffort === 'high');
  const decoyMedian = maxDecoy.length === TERMINAL_V7_PILOT_POLICY.maxDecoyRuns ? median(maxDecoy.map(({ corePoints }) => corePoints)) : null;
  const exactMaxDecoy = maxDecoy.filter(({ exact }) => exact).length;
  const allPilotMaximum = scored.length > 0 ? Math.max(...scored.map(({ corePoints }) => corePoints)) : null;
  const pairedEffortDifferences = V7_POOL_INSTANCES.dev.map((instanceId) => {
    const max = maxDecoy.find(({ job }) => job.harness.id === 'codex-cli' && job.instanceId === instanceId);
    const high = highScores.find(({ job }) => job.harness.id === 'codex-cli' && job.instanceId === instanceId);
    return { instanceId, difference: max && high ? round(max.corePoints - high.corePoints) : null };
  });
  const pairedEffortMean = pairedEffortDifferences.every(({ difference }) => difference !== null)
    ? round(pairedEffortDifferences.reduce((sum, { difference }) => sum + difference, 0) / pairedEffortDifferences.length)
    : null;
  const referenceMaximumDifference = Math.max(...references.differences.map(({ difference }) => Math.abs(difference)));
  const humanMaximumDifference = Math.max(...humanDifferences.map(({ absoluteDifference }) => absoluteDifference));
  const checks = [];
  gateCheck(checks, 'PILOT-COMPLETE', scored.length === TERMINAL_V7_PILOT_POLICY.expectedRuns && infrastructureInvalid.length === 0, { scoredRuns: scored.length, infrastructureInvalid: infrastructureInvalid.length }, 'Exactly 15 valid, scoreable model runs and zero infrastructure-invalid records.');
  gateCheck(checks, 'MAX-DECOY-MEDIAN', decoyMedian !== null && decoyMedian >= 50 && decoyMedian <= 75, decoyMedian, 'Luna/max decoy Core median is within [50, 75].');
  gateCheck(checks, 'NO-RUN-ABOVE-95', scored.length === 15 && allPilotMaximum <= 95, allPilotMaximum, 'No frontier pilot model run exceeds 95 Core.');
  gateCheck(checks, 'MAX-DECOY-EXACT', maxDecoy.length === 6 && exactMaxDecoy <= 1, { exact: exactMaxDecoy, runs: maxDecoy.length }, 'At most one of the six Luna/max decoy runs is Exact.');
  gateCheck(checks, 'HIGH-ANCHOR-GAP', pairedEffortMean !== null && pairedEffortMean >= 10, { pairedMeanMaxMinusHigh: pairedEffortMean, pairs: pairedEffortDifferences }, 'Codex Luna/high trails matched Codex Luna/max decoy runs by at least 10 Core points on paired mean.');
  gateCheck(checks, 'SCRIPTED-TWIN-PARITY', referenceMaximumDifference === 0, { maximumAbsoluteDifference: referenceMaximumDifference, pairs: references.differences.length }, 'Both scripted references have exactly zero clean/decoy Core difference on every development pack.');
  gateCheck(checks, 'HUMAN-TWIN-PARITY', humanMaximumDifference < 5, { maximumAbsoluteDifference: humanMaximumDifference, pairs: humanDifferences.length }, 'Every supplied human clean/decoy validation differs by fewer than five Core points.');
  const unsigned = {
    schemaVersion: TERMINAL_V7_PILOT_ANALYSIS_SCHEMA,
    challenge: { id: challenge.challengeId, sha256: challenge.challengeSha256 },
    schedule: { id: schedule.scheduleId, sha256: schedule.scheduleSha256 },
    policy: clone(TERMINAL_V7_PILOT_POLICY),
    population: {
      frontierRuns: schedule.jobs.length,
      maxRuns: maxScores.length,
      maxDecoyRuns: maxDecoy.length,
      highAnchorRuns: highScores.length,
      scriptedImplementations: references.implementationIds,
      scriptedReferenceReportSha256: references.reportSha256,
      humanTwinPairs: humanDifferences.length,
    },
    observations: {
      maxDecoyMedianCore: decoyMedian,
      maximumPilotCore: allPilotMaximum,
      exactMaxDecoyRuns: exactMaxDecoy,
      pairedMeanMaxMinusHigh: pairedEffortMean,
      pairedEffortDifferences,
      scriptedTwinMaximumAbsoluteDifference: referenceMaximumDifference,
      humanTwinMaximumAbsoluteDifference: humanMaximumDifference,
    },
    infrastructureInvalid,
    checks,
    accepted: checks.every(({ passed }) => passed),
    decision: checks.every(({ passed }) => passed) ? 'accept-development-pilot' : 'reject-and-reseal-template',
  };
  return { ...unsigned, analysisSha256: canonicalJsonSha256(unsigned) };
}
