#!/usr/bin/env node
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadV7Pack, materializeV7Starter, sealV7Pack } from '../benchmark/challenges/mini-ledger-v7/pack.mjs';
import {
  verifyFinal as verifyTerminalV7Final,
  V7_VERIFICATION_SCHEMA,
} from '../benchmark/challenges/mini-ledger-v7/verifier.mjs';
import { V7_PHASES, V7_REQUIREMENTS, V7_REQUIREMENTS_SHA256 } from '../benchmark/challenges/mini-ledger-v7/requirements.mjs';
import { inspectDotAgentsV7Image } from '../src/dotagents-harness.mjs';
import { assertTerminalV7GoldReportArtifacts } from './validate-terminal-v7-golds.mjs';
import { canonicalJson, canonicalJsonSha256, sha256File } from '../src/provenance.mjs';
import {
  snapshotTerminalCandidateTree,
  validateCapturedTerminalCandidateTree,
} from '../src/terminal-candidate-tree.mjs';
import { assertTerminalV7ReleaseGates } from '../src/terminal-v7-gates.mjs';
import { assertTerminalV7DevelopmentPilotReportSources } from '../src/terminal-v7-pilot-report.mjs';
import {
  assertTerminalV7ReleaseEvidenceSources,
  assertTerminalV7TestReportArtifacts,
  validateTerminalV7ReleaseGateEvidence,
} from '../src/terminal-v7-release-evidence.mjs';
import { validateTerminalV7SealManifest } from '../src/terminal-v7-seals.mjs';
import {
  assertTerminalV7HarborTaskImageReferences,
  inspectTerminalV7HarborTaskImages,
} from '../src/terminal-v7-harbor-images.mjs';
import { inspectTerminalV7VerifierImage } from '../src/terminal-v7-verifier-container.mjs';
import { assertTerminalV7RequirementMap } from '../src/terminal-v7-requirement-map.mjs';
import {
  analyzeTerminalV7PairedPacks,
  MINI_LEDGER_V7_FAMILIES,
  MINI_LEDGER_V7_PHASE_IDS,
  scoreTerminalV7Run,
  validateTerminalV7Challenge,
  validateTerminalV7Schedule,
} from '../src/terminal-v7.mjs';
import { validateTerminalJobIdentity } from '../src/terminal-runner.mjs';
import {
  assertTerminalV7ImmutableAttemptPair,
  assertTerminalV7ImmutableEvidenceFile,
} from '../src/terminal-v7-calibration-runner.mjs';
import { aggregateTerminalV7OperationalMetrics } from '../src/terminal-v7-operational-metrics.mjs';
import { validateTerminalV7RunBoundaryEvidence } from '../src/terminal-v7-run-boundary.mjs';
import {
  readTerminalV7RevisionStopState,
  resolveTerminalV7RevisionControlRoot,
} from '../src/terminal-v7-revision-control.mjs';
import { assertTerminalV7ScriptedReferenceArtifacts } from '../src/terminal-v7-scripted-references.mjs';
import { assertTerminalV7QualityEvidenceArtifacts } from '../src/terminal-v7-quality-gates.mjs';
import { assertTerminalV7ReviewArtifacts } from '../src/terminal-v7-review.mjs';
import { assertTerminalV7HumanTwinArtifacts } from '../src/terminal-v7-human-twins.mjs';
import { assertTerminalV7VerifierEvidence } from '../src/terminal-v7-verifier-evidence.mjs';
import { assertTerminalV7ExecutionIdentity } from '../src/terminal-v7-execution-identity.mjs';

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA256_RE = /^[0-9a-f]{64}$/;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function exists(file) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function contained(root, relative, label) {
  invariant(typeof relative === 'string' && relative.length > 0, `${label} path is required`);
  invariant(!relative.includes('\0') && !path.isAbsolute(relative), `${label} path must be a safe relative path`);
  const resolved = path.resolve(root, relative);
  const relation = path.relative(root, resolved);
  invariant(relation && relation !== '..' && !relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation), `${label} path escapes its sealed root`);
  return resolved;
}

async function treeRecords(root, relative = '') {
  const absolute = relative ? path.join(root, ...relative.split('/')) : root;
  const entries = await readdir(absolute, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const records = [];
  for (const entry of entries) {
    const child = relative ? path.posix.join(relative, entry.name) : entry.name;
    const childAbsolute = path.join(root, ...child.split('/'));
    const stat = await lstat(childAbsolute);
    invariant(!stat.isSymbolicLink(), `Artifact tree contains a symlink: ${child}`);
    if (stat.isDirectory()) records.push(...await treeRecords(root, child));
    else {
      invariant(stat.isFile() && stat.nlink === 1, `Artifact tree contains a non-regular or hardlinked entry: ${child}`);
      records.push({ path: child, sha256: await sha256File(childAbsolute) });
    }
  }
  return records;
}

function withoutSeal(value, field) {
  const copy = { ...value };
  delete copy[field];
  return copy;
}

function validateJsonSeal(value, field, label) {
  invariant(SHA256_RE.test(value?.[field] ?? ''), `${label} ${field} is missing`);
  invariant(value[field] === canonicalJsonSha256(withoutSeal(value, field)), `${label} ${field} mismatch`);
}

function packCommitmentView(pack) {
  return {
    schemaVersion: pack.schemaVersion,
    packSha256: pack.packSha256,
    sealSha256: pack.sealSha256,
    seedFingerprint: pack.seedFingerprint,
    starterTreeSha256: pack.starterTreeSha256,
    requirementsSha256: pack.requirementsSha256,
    requirementMapSha256: pack.requirementMapSha256,
    perPhaseLimitMs: pack.perPhaseLimitMs,
    artifactPolicy: pack.artifactPolicy,
    verifierHashes: pack.verifierHashes,
    rubricVersion: pack.rubricVersion,
    feedbackPolicy: pack.feedbackPolicy,
    phases: pack.phases.map(({ phase, id, ticketSha256, publicSmokeSha256, phaseDeltaSha256 }) => ({ phase, id, ticketSha256, publicSmokeSha256, phaseDeltaSha256 })),
    phaseDeltaSha256: [...pack.phaseDeltaSha256],
    hiddenMerkleRoot: pack.hiddenMerkleRoot,
    hiddenCaseCount: pack.hiddenCaseCount,
    twinRelationSha256: pack.twinRelationSha256,
  };
}

async function verifyFileDescriptor(root, descriptor, label) {
  invariant(descriptor && typeof descriptor === 'object', `${label} descriptor is missing`);
  invariant(SHA256_RE.test(descriptor.sha256 ?? ''), `${label} hash is invalid`);
  const file = contained(root, descriptor.path, label);
  const stat = await lstat(file);
  invariant(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, `${label} is not a safe regular file`);
  invariant(await sha256File(file) === descriptor.sha256, `${label} hash mismatch`);
  return { path: descriptor.path, sha256: descriptor.sha256 };
}

export async function assertTerminalV7HarborTaskExecutionImages({
  taskRoot,
  expected,
  inspectImages = inspectTerminalV7HarborTaskImages,
} = {}) {
  const taskImageReferences = await assertTerminalV7HarborTaskImageReferences({ taskRoot, expected });
  const runtimeImages = await inspectImages({ taskRoot, expected });
  invariant(canonicalJson(runtimeImages) === canonicalJson(expected), 'V7 Harbor inspected task images differ from the sealed challenge');
  return { taskImageReferences, runtimeImages };
}

export async function verifyTerminalV7Artifacts({ root = MODULE_ROOT, resultRoot, challenge, schedule }) {
  validateTerminalV7Challenge(challenge);
  validateTerminalV7Schedule(schedule, challenge);
  invariant(challenge.id === 'terminal-mini-ledger-v7', 'Strict V7 verification received another challenge');
  invariant(schedule.jobs.length === 25 && schedule.matrix?.expectedRuns === 25, 'Strict V7 verification requires the sealed 25-job matrix');
  invariant(schedule.matrix.releaseVariant === 'decoy' && schedule.matrix.cleanTwinIncluded === false, 'Scored V7 schedule must be release-decoy-only');
  invariant(schedule.jobs.every(({ instanceVariant }) => instanceVariant === 'decoy'), 'A scored V7 job is not a decoy pack');
  invariant(challenge.protocol?.turns === 5 && challenge.protocol?.phases === 5 && challenge.protocol?.sameSession === true, 'V7 must retain five phases in one persistent session');
  invariant(challenge.protocol.maxPhaseTimeMs === 1_500_000, 'V7 phase limit changed');
  invariant(challenge.execution?.feedbackPolicy === 'self-service-public-only', 'V7 feedback policy changed');
  invariant(challenge.execution?.candidateTree?.schemaVersion === 'agentbattler.terminal-candidate-tree.v1', 'V7 candidate-tree policy is not sealed');
  invariant(challenge.execution?.candidateTree?.grading === 'normalized-overlay-on-fresh-sealed-starter', 'V7 grading overlay policy changed');
  invariant(challenge.execution?.artifactPolicy?.maxFiles === 256 && challenge.execution?.artifactPolicy?.maxBytes === 4 * 1024 * 1024, 'V7 artifact caps changed');
  invariant(challenge.execution?.sandboxPolicy?.inheritedFrom === 'mini-ledger-v6-r14', 'V7 no longer inherits the sealed R14 sandbox');
  invariant(challenge.execution?.sandboxPolicy?.modelCommandCapabilities === 'exactly-zero', 'V7 model-command capability policy changed');
  invariant(challenge.execution?.sandboxPolicy?.blockedAttempts === 'ordinary-scoreable-tool-errors', 'V7 blocked-attempt scoring policy changed');

  const expectedVerifierImage = challenge.execution?.verifierImage;
  invariant(expectedVerifierImage?.schemaVersion === 'agentbattler.terminal-v7-verifier-image-source.v1', 'V7 verifier runtime image commitment is missing');
  const verifierRuntimeImage = await inspectTerminalV7VerifierImage({
    expectedSourceSha256: expectedVerifierImage.sourceSha256,
    expectedImageId: expectedVerifierImage.imageId,
  });
  invariant(canonicalJson(verifierRuntimeImage) === canonicalJson(expectedVerifierImage), 'V7 verifier runtime image differs from the sealed descriptor');

  const expectedDotAgentsImage = challenge.execution?.runtimeImages?.['dotagents-mono'];
  invariant(expectedDotAgentsImage?.schemaVersion === 'agentbattler.dotagents-v7-image.v1', 'V7 DotAgents runtime image commitment is missing');
  const dotAgentsRuntimeImage = await inspectDotAgentsV7Image({
    image: expectedDotAgentsImage.image,
    expectedImageId: expectedDotAgentsImage.imageId,
    repositoryRoot: root,
  });
  invariant(canonicalJson(dotAgentsRuntimeImage) === canonicalJson(expectedDotAgentsImage), 'V7 DotAgents runtime image differs from the sealed descriptor');

  const files = [];
  files.push(await verifyFileDescriptor(root, challenge.prompt, 'V7 prompt'));
  for (const [name, descriptor] of Object.entries(challenge.verifiers)) {
    files.push(await verifyFileDescriptor(root, descriptor, `V7 ${name} verifier`));
  }
  const adapters = challenge.execution?.adapters;
  invariant(adapters && typeof adapters === 'object' && !Array.isArray(adapters), 'V7 adapter commitments are missing');
  const adapterPaths = new Set();
  for (const [key, descriptor] of Object.entries(adapters)) {
    invariant(!adapterPaths.has(descriptor.path), `V7 adapter path is committed more than once: ${descriptor.path}`);
    adapterPaths.add(descriptor.path);
    files.push(await verifyFileDescriptor(root, descriptor, `V7 adapter ${key}`));
  }
  invariant(challenge.execution.commitments?.verifierSha256 === challenge.verifiers.public.sha256
    && challenge.verifiers.public.sha256 === challenge.verifiers.hidden.sha256
    && challenge.verifiers.hidden.sha256 === challenge.verifiers.adaptability.sha256, 'V7 verifier commitment mismatch');
  invariant(challenge.execution.commitments?.rubricVersion === `mini-ledger-v7-${challenge.protocolRevision}`, 'V7 rubric version mismatch');

  const taskIds = Object.keys(challenge.execution?.tasks ?? {}).sort();
  const instanceIds = challenge.instances.map(({ instanceId }) => instanceId).sort();
  invariant(canonicalJson(taskIds) === canonicalJson(instanceIds), 'V7 task roots do not cover the five sealed release packs');
  const taskTrees = [];
  for (const instanceId of instanceIds) {
    const descriptor = challenge.execution.tasks[instanceId];
    invariant(descriptor.taskPathBase === 'result-root', `V7 scored task ${instanceId} is not rooted in private result control`);
    invariant(descriptor.instanceId === instanceId && descriptor.variant === 'decoy', `V7 scored task ${instanceId} identity changed`);
    const taskRoot = contained(resultRoot, descriptor.taskPath, `V7 task ${instanceId}`);
    const stat = await lstat(taskRoot);
    invariant(stat.isDirectory() && !stat.isSymbolicLink(), `V7 task ${instanceId} is not a safe directory`);
    const records = await treeRecords(taskRoot);
    invariant(records.length === descriptor.fileCount, `V7 task ${instanceId} file count mismatch`);
    invariant(canonicalJsonSha256(records) === descriptor.sha256, `V7 task ${instanceId} tree hash mismatch`);
    const taskImages = await assertTerminalV7HarborTaskExecutionImages({ taskRoot, expected: descriptor.images });
    invariant(canonicalJson(taskImages.taskImageReferences) === canonicalJson(descriptor.imageReferences), `V7 task ${instanceId} image references differ from the sealed challenge`);
    taskTrees.push({ instanceId, ...descriptor });
  }

  const revision = challenge.protocolRevision;
  const sealPath = path.resolve(process.env.AGENTBATTLER_V7_SEALS_PATH
    ?? path.join(root, 'benchmark', 'challenges', 'mini-ledger-v7', 'seals', `${revision}.json`));
  const gatePath = path.resolve(process.env.AGENTBATTLER_V7_GATES_PATH
    ?? path.join(root, 'results', `terminal-mini-ledger-v7-calibration-${revision}`, 'release-gates.json'));
  const stateRoot = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const seedKeyPath = path.resolve(process.env.AGENTBATTLER_V7_SEED_KEY_FILE
    ?? path.join(stateRoot, 'automations', 'mini-ledger-v6-scheduled-check', `mini-ledger-v7-${revision}.seed-key`));
  const calibrationRoot = path.dirname(gatePath);
  const goldReportPath = path.resolve(process.env.AGENTBATTLER_V7_GOLD_REPORT_PATH ?? path.join(calibrationRoot, 'gold', 'gold-report.json'));
  const qualityEvidencePath = path.resolve(process.env.AGENTBATTLER_V7_QUALITY_EVIDENCE_PATH ?? path.join(calibrationRoot, 'quality-gates.json'));
  const requirementMapPath = path.resolve(process.env.AGENTBATTLER_V7_REQUIREMENT_MAP_PATH ?? path.join(root, 'benchmark', 'challenges', 'mini-ledger-v7', 'requirement-map.json'));
  const reviewsPath = path.resolve(process.env.AGENTBATTLER_V7_REVIEWS_PATH ?? path.join(calibrationRoot, 'control', 'independent-reviews.json'));
  const testReportPath = path.resolve(process.env.AGENTBATTLER_V7_TEST_REPORT_PATH ?? path.join(calibrationRoot, 'test-preflight-report.json'));
  const pilotReportPath = path.resolve(process.env.AGENTBATTLER_V7_PILOT_REPORT_PATH ?? path.join(calibrationRoot, 'pilot-report.json'));
  const scriptedReferencesPath = path.resolve(process.env.AGENTBATTLER_V7_SCRIPTED_REFERENCES_PATH ?? path.join(calibrationRoot, 'control', 'scripted-reference-results.json'));
  const humanTwinsPath = path.resolve(process.env.AGENTBATTLER_V7_HUMAN_TWINS_PATH ?? path.join(calibrationRoot, 'control', 'human-twin-validations.json'));
  const [manifest, gateEvidence, seedKey, goldReport, qualityEvidence, requirementMap, reviews, testReport, pilotReport, scriptedReferences, humanTwinValidations] = await Promise.all([
    readJson(sealPath),
    readJson(gatePath),
    readFile(seedKeyPath, 'utf8').then((value) => value.trim()),
    readJson(goldReportPath),
    readJson(qualityEvidencePath),
    readJson(requirementMapPath),
    readJson(reviewsPath),
    readJson(testReportPath),
    readJson(pilotReportPath),
    readJson(scriptedReferencesPath),
    readJson(humanTwinsPath),
  ]);
  invariant(seedKey.length >= 16, 'V7 evaluator seed key is unavailable or invalid');
  validateTerminalV7SealManifest(manifest, { seedKey });
  validateTerminalV7ReleaseGateEvidence(gateEvidence);
  const goldArtifacts = await assertTerminalV7GoldReportArtifacts({
    evidenceRoot: path.dirname(goldReportPath),
    root,
    report: goldReport,
    sealManifest: manifest,
  });
  const scriptedReferenceArtifacts = await assertTerminalV7ScriptedReferenceArtifacts({
    evidenceRoot: calibrationRoot,
    root,
    report: scriptedReferences,
    sealManifest: manifest,
    goldReport,
    expectedVerifierImage: goldReport.verifierImage,
  });
  await assertTerminalV7QualityEvidenceArtifacts({
    evidenceRoot: calibrationRoot,
    evidence: qualityEvidence,
    revision,
    reviewedCommit: gateEvidence.reviewedCommit,
    sealManifestSha256: manifest.manifestSha256,
    goldReportSha256: goldReport.reportSha256,
    goldImplementationSourceSha256: goldArtifacts.implementationSourceSha256,
    verifierImage: goldReport.verifierImage,
  });
  const requirementAudit = assertTerminalV7RequirementMap(requirementMap);
  const reviewRecords = Array.isArray(reviews) ? reviews : reviews.reviews;
  await assertTerminalV7ReviewArtifacts({
    evidenceRoot: calibrationRoot,
    reviews: reviewRecords,
    options: {
      revision,
      reviewedCommit: gateEvidence.reviewedCommit,
      sealManifestSha256: manifest.manifestSha256,
      requirementMapSha256: requirementAudit.requirementMapSha256,
    },
  });
  await assertTerminalV7HumanTwinArtifacts({
    evidenceRoot: calibrationRoot,
    rows: humanTwinValidations,
    options: {
      revision,
      reviewedCommit: gateEvidence.reviewedCommit,
      sealManifestSha256: manifest.manifestSha256,
      verifierImage: goldReport.verifierImage,
    },
  });
  assertTerminalV7ReleaseEvidenceSources(gateEvidence, {
    seedKey,
    sealManifest: manifest,
    goldReport,
    goldArtifacts,
    scriptedReferences,
    scriptedReferenceArtifacts,
    qualityEvidence,
    requirementMap,
    reviews,
    testReport,
    pilotReport,
  });
  await assertTerminalV7DevelopmentPilotReportSources({
    resultRoot: calibrationRoot,
    report: pilotReport,
    scriptedReferences,
    humanTwinValidations,
    humanTwinOptions: {
      revision,
      reviewedCommit: gateEvidence.reviewedCommit,
      sealManifestSha256: manifest.manifestSha256,
      verifierImage: goldReport.verifierImage,
    },
  });
  await assertTerminalV7TestReportArtifacts({ evidenceRoot: calibrationRoot, report: testReport });
  const gate = assertTerminalV7ReleaseGates(gateEvidence);
  assertTerminalV7RequirementMap(requirementMap);
  await assertTerminalV7ExecutionIdentity({ root, challenge });
  invariant(manifest.revision === revision && gateEvidence.revision === revision, 'V7 seals or release gates use another revision');
  invariant(manifest.manifestSha256 === challenge.execution.commitments.sealManifestSha256, 'V7 seal-manifest commitment mismatch');
  invariant(gate.gateSha256 === challenge.execution.commitments.releaseGateSha256, 'V7 release-gate commitment mismatch');
  invariant(gateEvidence.releaseEvidenceSha256 === challenge.execution.commitments.releaseEvidenceSha256, 'V7 full release-evidence commitment mismatch');
  invariant(gateEvidence.baseEvidence.baseEvidenceSha256 === challenge.execution.commitments.baseEvidenceSha256, 'V7 base-evidence commitment mismatch');
  invariant(gateEvidence.pilotReport.reportSha256 === challenge.execution.commitments.pilotReportSha256, 'V7 pilot-report commitment mismatch');
  invariant(gateEvidence.reviewedCommit === challenge.execution.commitments.reviewedCommit, 'V7 reviewed-commit commitment mismatch');
  invariant(canonicalJson(gateEvidence.baseEvidence.executionHost) === canonicalJson(challenge.execution.executionHost), 'V7 release execution host differs from the M4 Pro preflight binding');
  const releaseTwins = manifest.packs.filter(({ pool }) => pool === 'release').sort((left, right) => left.instanceId.localeCompare(right.instanceId));
  invariant(releaseTwins.length === 5, 'V7 seal manifest does not contain five release twins');
  for (const instance of challenge.instances) {
    invariant(instance.source === 'sealed-release-pack', `V7 instance ${instance.instanceId} is not a sealed release pack`);
    const twin = releaseTwins.find(({ instanceId }) => instanceId === instance.instanceId);
    invariant(twin?.decoy?.variant === 'decoy' && twin?.clean?.variant === 'clean', `V7 release twin is missing for ${instance.instanceId}`);
    invariant(canonicalJson(instance.packCommitments) === canonicalJson(packCommitmentView(twin.decoy)), `V7 release-pack commitments changed for ${instance.instanceId}`);
    invariant(challenge.execution.commitments.hiddenMerkleRoots?.[instance.instanceId] === twin.hiddenMerkleRoot, `V7 hidden root commitment changed for ${instance.instanceId}`);
    invariant(twin.decoy.requirementsSha256 === V7_REQUIREMENTS_SHA256, `V7 requirement commitment changed for ${instance.instanceId}`);
    const visiblePack = loadV7Pack(instance.instanceId, { variant: 'decoy' });
    invariant(visiblePack.packSha256 === twin.decoy.packSha256 && visiblePack.starterTreeSha256 === twin.decoy.starterTreeSha256, `V7 local pack bytes changed for ${instance.instanceId}`);
  }

  return {
    promptAndVerifierFiles: files,
    adapterFileCount: Object.keys(adapters).length,
    taskTrees,
    sealManifest: { path: sealPath, sha256: manifest.manifestSha256 },
    releaseGates: { path: gatePath, sha256: gate.gateSha256, releaseEvidenceSha256: gateEvidence.releaseEvidenceSha256 },
    verifierImage: verifierRuntimeImage,
    runtimeImages: { 'dotagents-mono': dotAgentsRuntimeImage },
    goldArtifacts,
    scriptedReferenceArtifacts,
    requirementMap,
    recomputeFinal: async ({ instanceId, phaseResults }) => {
      const canonicalPack = loadV7Pack(instanceId, { variant: 'decoy' });
      const pack = sealV7Pack(canonicalPack, { seedKey });
      return verifyTerminalV7Final({ instance: pack, pack, phaseResults, seedKey, verifierSeedIndex: 0 });
    },
  };
}

function explicitInfrastructureErrors(result, label) {
  invariant(Array.isArray(result?.infrastructureErrors), `${label} must include an explicit infrastructureErrors array`);
  invariant(result.infrastructureErrors.length === 0, `${label} contains verifier infrastructure errors`);
}

function runtimeRequirementMap(requirementMap) {
  assertTerminalV7RequirementMap(requirementMap);
  const scoredById = new Map(requirementMap.scoredAssertions.map((assertion) => [assertion.id, assertion]));
  const verifierByRequirement = new Map();
  for (const assertion of requirementMap.verifierAssertions) {
    if (!verifierByRequirement.has(assertion.requirementId)) verifierByRequirement.set(assertion.requirementId, new Map());
    const classes = verifierByRequirement.get(assertion.requirementId);
    invariant(!classes.has(assertion.caseClass), `V7 requirement map repeats ${assertion.requirementId}/${assertion.caseClass}`);
    classes.set(assertion.caseClass, assertion);
  }
  return { scoredById, verifierByRequirement };
}

function validateRequirementRecords(result, expectedIds, label, requirementMap) {
  invariant(Array.isArray(result?.requirements), `${label} requirement records are missing`);
  const records = result.requirements;
  const mapped = runtimeRequirementMap(requirementMap);
  invariant(records.length === expectedIds.length, `${label} requirement count mismatch`);
  invariant(new Set(records.map(({ id }) => id)).size === records.length, `${label} has duplicate requirement IDs`);
  invariant(expectedIds.every((id) => records.some((record) => record.id === id)), `${label} requirement IDs changed`);
  for (const record of records) {
    const expected = V7_REQUIREMENTS.find(({ id }) => id === record.id);
    invariant(expected, `${label} contains an unknown requirement ID`);
    const scoredAssertion = mapped.scoredById.get(record.id);
    const mappedClasses = mapped.verifierByRequirement.get(record.id);
    invariant(scoredAssertion && mappedClasses, `${label} requirement ${record.id} is absent from the requirement map`);
    invariant(record.passed === true || record.passed === false, `${label} requirement ${record.id} has no boolean outcome`);
    if (record.phase !== undefined) invariant(record.phase === expected.phase, `${label} requirement ${record.id} phase changed`);
    invariant(record.family === expected.family, `${label} requirement ${record.id} family changed`);
    invariant(record.weight === expected.weight, `${label} requirement ${record.id} weight changed`);
    invariant(record.group === expected.group, `${label} requirement ${record.id} group changed`);
    invariant(Number.isSafeInteger(record.points) && record.points >= 0 && record.points <= record.weight, `${label} requirement ${record.id} points are invalid`);
    if (expected.group === 'public') {
      const assertion = mappedClasses.get('public');
      invariant(mappedClasses.size === 1 && assertion, `${label} public requirement ${record.id} has invalid mapped classes`);
      invariant(scoredAssertion.privateClassWeights === undefined, `${label} public requirement ${record.id} unexpectedly maps private weights`);
      invariant(record.assertionId === assertion.id, `${label} requirement ${record.id} assertion ID changed`);
      invariant(record.caseCount === assertion.expectedCaseCount, `${label} requirement ${record.id} case count changed`);
      invariant(record.classes === undefined, `${label} public requirement ${record.id} unexpectedly contains private classes`);
      invariant(record.points === (record.passed ? record.weight : 0), `${label} requirement ${record.id} points disagree with its outcome`);
      continue;
    }
    invariant(record.assertionId === undefined && record.caseCount === undefined, `${label} private requirement ${record.id} has an unclassified assertion`);
    invariant(record.classes && typeof record.classes === 'object' && !Array.isArray(record.classes), `${label} requirement ${record.id} class outcomes are missing`);
    invariant(canonicalJson(Object.keys(record.classes).sort()) === canonicalJson(['atomic', 'composed']), `${label} requirement ${record.id} class set changed`);
    invariant(scoredAssertion.privateClassWeights && canonicalJson(scoredAssertion.privateClassWeights) === canonicalJson(expected.privateClassWeights), `${label} requirement ${record.id} mapped class weights changed`);
    let classPoints = 0;
    for (const caseClass of ['atomic', 'composed']) {
      const assertion = mappedClasses.get(caseClass);
      const actual = record.classes[caseClass];
      invariant(mappedClasses.size === 2 && assertion, `${label} requirement ${record.id}/${caseClass} is absent from the requirement map`);
      invariant(actual && typeof actual === 'object' && !Array.isArray(actual), `${label} requirement ${record.id}/${caseClass} outcome is missing`);
      invariant(actual.assertionId === assertion.id, `${label} requirement ${record.id}/${caseClass} assertion ID changed`);
      invariant(actual.caseCount === assertion.expectedCaseCount, `${label} requirement ${record.id}/${caseClass} case count changed`);
      invariant(actual.weight === scoredAssertion.privateClassWeights[caseClass], `${label} requirement ${record.id}/${caseClass} weight changed`);
      invariant(actual.passed === true || actual.passed === false, `${label} requirement ${record.id}/${caseClass} has no boolean outcome`);
      invariant(actual.points === (actual.passed ? actual.weight : 0), `${label} requirement ${record.id}/${caseClass} points disagree with its outcome`);
      classPoints += actual.points;
    }
    invariant(record.points === classPoints, `${label} requirement ${record.id} points do not equal its class outcomes`);
    invariant(record.passed === (classPoints === record.weight), `${label} requirement ${record.id} pass flag disagrees with its class outcomes`);
  }
  return records;
}

function validateEvaluationIdentity(evaluation, identity, label) {
  if (identity === null) return;
  invariant(evaluation?.schemaVersion === V7_VERIFICATION_SCHEMA, `${label} verification schema changed`);
  invariant(evaluation.challengeId === identity.challengeId
    && evaluation.instanceId === identity.instanceId
    && evaluation.variant === identity.variant, `${label} pack identity changed`);
  invariant(evaluation.verifierSeedIndex === identity.verifierSeedIndex, `${label} verifier seed index changed`);
}

export function validateTerminalV7FinalEvaluation(evaluation, requirementMap, identity = null) {
  explicitInfrastructureErrors(evaluation, 'V7 final evaluation');
  validateEvaluationIdentity(evaluation, identity, 'V7 final evaluation');
  const requirements = validateRequirementRecords(evaluation, V7_REQUIREMENTS.map(({ id }) => id), 'V7 final evaluation', requirementMap);
  invariant(canonicalJson(evaluation.checks) === canonicalJson(requirements), 'V7 final evaluation checks differ from its requirement records');
  const score = requirements.reduce((sum, { points }) => sum + points, 0);
  const maxScore = requirements.reduce((sum, { weight }) => sum + weight, 0);
  const publicScore = requirements.filter(({ group }) => group === 'public').reduce((sum, { points }) => sum + points, 0);
  const privateScore = requirements.filter(({ group }) => group === 'private').reduce((sum, { points }) => sum + points, 0);
  invariant(evaluation.score === score && evaluation.maxScore === maxScore, 'V7 final evaluation score totals differ from requirement outcomes');
  invariant(evaluation.publicScore === publicScore && evaluation.privateScore === privateScore, 'V7 final evaluation group scores differ from requirement outcomes');
  invariant(evaluation.passed === (score === maxScore), 'V7 final evaluation pass flag differs from requirement outcomes');
  invariant(Array.isArray(evaluation.families) && evaluation.families.length === 5, 'V7 final evaluation family records are incomplete');
  invariant(new Set(evaluation.families.map(({ id }) => id)).size === 5, 'V7 final evaluation contains duplicate scoring families');
  for (let index = 0; index < MINI_LEDGER_V7_FAMILIES.length; index += 1) {
    const id = MINI_LEDGER_V7_FAMILIES[index];
    const family = evaluation.families.find((entry) => entry.id === id);
    invariant(family, `V7 final evaluation is missing family ${id}`);
    invariant(family.public?.total === 4, `V7 family ${id} public weight changed`);
    invariant(family.hiddenAtomic?.total === 6, `V7 family ${id} hidden atomic weight changed`);
    invariant(family.hiddenComposed?.total === 10, `V7 family ${id} hidden composed weight changed`);
    invariant(family.hidden?.total === 16, `V7 family ${id} hidden weight changed`);
    const familyRequirements = requirements.filter((record) => V7_REQUIREMENTS.find(({ id: requirementId }) => requirementId === record.id)?.family === id);
    const expectedPublic = familyRequirements.filter(({ group }) => group === 'public').reduce((sum, { points }) => sum + points, 0);
    const privateRequirements = familyRequirements.filter(({ group }) => group === 'private');
    const expectedAtomic = privateRequirements.reduce((sum, record) => sum + record.classes.atomic.points, 0);
    const expectedComposed = privateRequirements.reduce((sum, record) => sum + record.classes.composed.points, 0);
    const expectedHidden = expectedAtomic + expectedComposed;
    invariant(Number.isSafeInteger(family.public.passed) && family.public.passed === expectedPublic, `V7 family ${id} public score does not match requirement outcomes`);
    invariant(Number.isSafeInteger(family.hiddenAtomic.passed) && family.hiddenAtomic.passed === expectedAtomic, `V7 family ${id} hidden atomic score does not match requirement outcomes`);
    invariant(Number.isSafeInteger(family.hiddenComposed.passed) && family.hiddenComposed.passed === expectedComposed, `V7 family ${id} hidden composed score does not match requirement outcomes`);
    invariant(Number.isSafeInteger(family.hidden.passed) && family.hidden.passed === expectedHidden, `V7 family ${id} hidden score does not match requirement outcomes`);
  }
  invariant(evaluation.adaptability?.total === 5, 'V7 adaptability must contain five regression-gated phase outcomes');
  invariant(Number.isSafeInteger(evaluation.adaptability.passed)
    && evaluation.adaptability.passed >= 0
    && evaluation.adaptability.passed <= 5, 'V7 adaptability outcome is invalid');
}

function validatePhaseResults(run, requirementMap, identity) {
  invariant(Array.isArray(run.phaseResults) && run.phaseResults.length === 5, 'V7 run must contain exactly five phase results');
  for (let index = 0; index < 5; index += 1) {
    const result = run.phaseResults[index];
    const phase = index + 1;
    explicitInfrastructureErrors(result, `V7 phase ${phase}`);
    validateEvaluationIdentity(result, identity, `V7 phase ${phase}`);
    invariant((result.phase ?? phase) === phase, `V7 phase result ${phase} is out of order`);
    if (result.id !== undefined) invariant(result.id === MINI_LEDGER_V7_PHASE_IDS[index], `V7 phase result ${phase} ID changed`);
    validateRequirementRecords(result, V7_PHASES[index].requirementIds, `V7 phase ${phase}`, requirementMap);
  }
}

function validateRunSeal(run) {
  validateJsonSeal(run, 'resultSha256', `V7 run ${run?.runKey ?? 'unknown'}`);
}

function validateRunIdentity(run, job, challenge) {
  validateTerminalJobIdentity(job, run);
  invariant(run.harness === job.harness.id && run.harnessVersion === job.harness.version, 'V7 run harness identity changed');
  invariant(run.model === job.model.id && run.reasoningEffort === job.model.reasoningEffort, 'V7 run model identity changed');
  invariant(run.instanceVariant === job.instanceVariant, 'V7 completed run instance variant differs from its scheduled job');
  if (challenge.schemaVersion !== 'agentbattler.terminal-v7-calibration-challenge.v1') {
    invariant(run.instanceVariant === 'decoy', 'V7 completed run did not use the decoy release variant');
  }
}

async function verifyArchiveFileSet(runDirectory, evidence) {
  const archiveRoot = path.resolve(runDirectory, ...evidence.archivePath.split('/'));
  const records = await treeRecords(archiveRoot);
  invariant(canonicalJson(records.map(({ path: candidatePath }) => candidatePath)) === canonicalJson(evidence.archivedFiles), `V7 turn ${evidence.turn} archive file set differs from its manifest`);
  const metadata = await readJson(path.join(runDirectory, 'candidate-trees', `turn-${String(evidence.turn).padStart(2, '0')}`, 'metadata.json'));
  invariant(canonicalJson(metadata) === canonicalJson(evidence), `V7 turn ${evidence.turn} candidate-tree metadata changed`);
}

async function validateDeclaredArtifacts(run, runDirectory) {
  invariant(Array.isArray(run.declaredArtifacts) && run.declaredArtifacts.length === 5, 'V7 declared-artifact evidence must align with five phases');
  if (run.declaredArtifactRejections !== undefined) {
    invariant(Array.isArray(run.declaredArtifactRejections) && run.declaredArtifactRejections.length === 5, 'V7 declared-artifact rejection evidence must align with five phases');
    invariant(run.declaredArtifactRejections.every((value, index) => value === null || index === 3), 'V7 declared-artifact rejection occurred outside the forensic phase');
  }
  for (let index = 0; index < 5; index += 1) {
    const artifact = run.declaredArtifacts[index];
    invariant(canonicalJson(run.turns[index].declaredArtifact ?? null) === canonicalJson(artifact ?? null), `V7 phase ${index + 1} declared-artifact evidence is not bound to its turn`);
    if (!artifact) continue;
    invariant(index === 3, 'V7 only permits a declared candidate artifact in the forensic phase');
    invariant(typeof artifact.path === 'string' && typeof artifact.archivePath === 'string', 'V7 declared-artifact paths are missing');
    invariant(Number.isSafeInteger(artifact.sizeBytes) && artifact.sizeBytes >= 0 && artifact.sizeBytes <= 64 * 1024, 'V7 declared artifact exceeds its size policy');
    invariant(SHA256_RE.test(artifact.sha256 ?? ''), 'V7 declared-artifact hash is invalid');
    const archive = contained(runDirectory, artifact.archivePath, 'V7 declared-artifact archive');
    const stat = await lstat(archive);
    invariant(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size === artifact.sizeBytes, 'V7 declared-artifact archive is unsafe or has the wrong size');
    invariant(await sha256File(archive) === artifact.sha256, 'V7 declared-artifact archive hash mismatch');
  }
}

async function countAttemptRecords(resultRoot, job, currentRun) {
  const directory = path.join(resultRoot, 'attempts', job.runKey);
  if (!await exists(directory)) return 0;
  const entries = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith('.json'));
  invariant(entries.length > 0, `V7 attempts directory is empty for ${job.runKey}`);
  for (const entry of entries) {
    const attemptFile = path.join(directory, entry.name);
    await assertTerminalV7ImmutableEvidenceFile(attemptFile, `V7 attempt ${job.runKey}/${entry.name}`);
    const attempt = await readJson(attemptFile);
    validateRunSeal(attempt);
    validateTerminalJobIdentity(job, attempt);
    invariant(['completed', 'infrastructure-invalid', 'protocol-invalid'].includes(attempt.status), `V7 attempt has an unsupported status for ${job.runKey}`);
  }
  invariant(typeof currentRun?.attemptId === 'string' && currentRun.attemptId.length > 0
    && !currentRun.attemptId.includes('/') && !currentRun.attemptId.includes('\\'), `V7 current run ${job.runKey} has no safe declared attempt ID`);
  const declaredName = `${currentRun.attemptId}.json`;
  invariant(entries.some(({ name }) => name === declaredName), `V7 current run ${job.runKey} has no matching immutable attempt`);
  const currentFile = path.join(resultRoot, 'runs', `${job.runKey}.json`);
  const declaredFile = path.join(directory, declaredName);
  await assertTerminalV7ImmutableAttemptPair({ currentFile, attemptFile: declaredFile });
  const declaredAttempt = await readJson(declaredFile);
  invariant(canonicalJson(declaredAttempt) === canonicalJson(currentRun), `V7 current run ${job.runKey} differs from its declared immutable attempt`);
  return entries.length;
}

async function baseTreeForInstance({ challenge, instanceId, temporaryRoots }) {
  const instance = challenge.instances.find((entry) => entry.instanceId === instanceId);
  invariant(instance, `Unknown V7 instance ${instanceId}`);
  const pack = loadV7Pack(instanceId, { variant: 'decoy' });
  invariant(pack.packSha256 === instance.packCommitments.packSha256, `V7 runtime pack changed for ${instanceId}`);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-v7-terminal-verify-'));
  temporaryRoots.push(temporary);
  await materializeV7Starter({ pack, destination: temporary });
  return snapshotTerminalCandidateTree({ root: temporary, policy: challenge.execution.candidateTree.policy });
}

export async function validateTerminalV7CompletedRun({
  challenge,
  job,
  run,
  resultRoot,
  baseTree,
  requirementMap,
  scoreRun = scoreTerminalV7Run,
  recomputeFinal = null,
}) {
  validateRunSeal(run);
  validateRunIdentity(run, job, challenge);
  invariant(run.status === 'completed' && run.validity === 'valid', 'V7 scored run is not completed and valid');
  invariant(run.humanIntervention === 'none', 'V7 run records human intervention');
  invariant(run.sameSessionProof === true, 'V7 run does not prove session continuity');
  invariant(Array.isArray(run.turns) && run.turns.length === 5, 'V7 run must contain exactly five turns');
  const sessionIds = run.turns.map(({ sessionId }) => sessionId);
  invariant(sessionIds.every((sessionId) => typeof sessionId === 'string' && sessionId.length > 0), 'V7 turn session evidence is incomplete');
  invariant(new Set(sessionIds).size === 1 && run.sessionId === sessionIds[0], 'V7 session changed between phases');
  invariant(run.turns.every((turn, index) => turn.index === index + 1), 'V7 turns are not ordered 1 through 5');
  validateTerminalV7RunBoundaryEvidence({ challenge, job, run });
  const evaluationIdentity = {
    challengeId: challenge.id,
    instanceId: job.instanceId,
    variant: job.instanceVariant,
    verifierSeedIndex: 0,
  };
  validatePhaseResults(run, requirementMap, evaluationIdentity);
  validateTerminalV7FinalEvaluation(run.evaluation, requirementMap, evaluationIdentity);

  const runDirectory = path.join(resultRoot, 'work', job.runKey);
  invariant(challenge.execution?.verifierEvidencePolicy?.bindRawTreeIntoAttempt === true
    && challenge.execution?.verifierEvidencePolicy?.currentMustEqualDeclaredAttempt === true, 'V7 verifier-evidence policy is not sealed into the challenge');
  await assertTerminalV7VerifierEvidence({ runDirectory, run });
  if (recomputeFinal !== null) {
    invariant(typeof recomputeFinal === 'function', 'V7 completed-run final recomputation callback is invalid');
    const recomputed = await recomputeFinal({ instanceId: job.instanceId, phaseResults: run.phaseResults });
    validateTerminalV7FinalEvaluation(recomputed, requirementMap, evaluationIdentity);
    const scoreProvenance = (evaluation) => ({
      requirements: evaluation.requirements,
      families: evaluation.families,
      infrastructureErrors: evaluation.infrastructureErrors,
      adaptability: evaluation.adaptability,
      score: evaluation.score,
      maxScore: evaluation.maxScore,
      publicScore: evaluation.publicScore,
      privateScore: evaluation.privateScore,
      passed: evaluation.passed,
    });
    invariant(canonicalJson(scoreProvenance(recomputed)) === canonicalJson(scoreProvenance(run.evaluation)), 'V7 final score provenance does not recompute from archived phase verifier outputs');
  }
  await validateDeclaredArtifacts(run, runDirectory);
  const trees = [];
  for (let index = 0; index < 5; index += 1) {
    const evidence = run.turns[index].candidateTree;
    invariant(evidence?.turn === index + 1, `V7 turn ${index + 1} candidate-tree evidence is missing`);
    if (evidence.kind === 'rejected') {
      invariant(evidence.schemaVersion === 'agentbattler.terminal-candidate-tree-rejection.v1', `V7 turn ${index + 1} candidate-tree rejection schema changed`);
      invariant(evidence.code === 'candidate-tree-policy-rejection' && typeof evidence.diagnostic === 'string' && evidence.diagnostic.length > 0 && evidence.diagnostic.length <= 500, `V7 turn ${index + 1} candidate-tree rejection evidence is invalid`);
      const requirements = run.phaseResults[index].requirements;
      invariant(requirements.every(({ passed }) => passed === false), `V7 turn ${index + 1} rejected tree received requirement credit`);
      trees.push({ turn: index + 1, rejected: true, code: evidence.code, baseTreeSha256: null, treeSha256: null, fileCount: null, totalBytes: null, changedFiles: null, deletions: null });
      continue;
    }
    invariant(evidence.kind === 'overlay', `V7 turn ${index + 1} must retain a source overlay or an explicit policy rejection`);
    await validateCapturedTerminalCandidateTree({ runDirectory, evidence, base: baseTree });
    await verifyArchiveFileSet(runDirectory, evidence);
    trees.push({
      turn: index + 1,
      baseTreeSha256: evidence.baseTreeSha256,
      treeSha256: evidence.treeSha256,
      fileCount: evidence.fileCount,
      totalBytes: evidence.totalBytes,
      changedFiles: evidence.files.length,
      deletions: evidence.deletions.length,
    });
  }
  invariant(typeof scoreRun === 'function', 'V7 completed-run scorer is required');
  const score = scoreRun(run, challenge);
  return { run, score, trees };
}

function harnessStandings(scoredRuns) {
  const harnessIds = [...new Set(scoredRuns.map(({ job }) => job.harness.id))].sort();
  return harnessIds.map((harnessId) => {
    const rows = scoredRuns.filter(({ job }) => job.harness.id === harnessId);
    const mean = (selector) => rows.reduce((sum, row) => sum + selector(row.score), 0) / rows.length;
    return {
      harnessId,
      packs: rows.length,
      matchedMeanCore: Number(mean((score) => score.core.points).toFixed(6)),
      exactRuns: rows.filter(({ score }) => score.exact).length,
      meanAdaptability: Number(mean((score) => score.adaptability.points).toFixed(6)),
      meanProxyGap: Number(mean((score) => score.proxyGap).toFixed(6)),
    };
  }).sort((left, right) => right.matchedMeanCore - left.matchedMeanCore || left.harnessId.localeCompare(right.harnessId));
}

function privacySafeInvalid(runKey, status, attemptCount, error) {
  return {
    runKey,
    status,
    attemptCount,
    exhausted: ['infrastructure-invalid', 'protocol-invalid'].includes(status),
    terminalBlocker: true,
    evidenceSha256: canonicalJsonSha256({ runKey, status, message: String(error?.message ?? error ?? status) }),
  };
}

export async function readTerminalV7StrictRevisionStopState({ root = MODULE_ROOT, revision, env = process.env } = {}) {
  const controlRoot = resolveTerminalV7RevisionControlRoot({ root, revision, env });
  return readTerminalV7RevisionStopState({ controlRoot, revision });
}

function sameHarnessPair(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === 2 && right.length === 2
    && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

export function classifyTerminalV7OfficialFinalization({
  complete,
  revisionStatus,
  saturationTriggered,
  standings,
  pairedAnalysis,
} = {}) {
  const officialMatrixVerified = complete === true && revisionStatus === 'active' && saturationTriggered !== true;
  const leadingPairHarnessIds = officialMatrixVerified ? standings.slice(0, 2).map(({ harnessId }) => harnessId) : [];
  const leadingComparison = officialMatrixVerified
    ? pairedAnalysis?.comparisons?.find(({ leftHarnessId, rightHarnessId }) => sameHarnessPair([leftHarnessId, rightHarnessId], leadingPairHarnessIds)) ?? null
    : null;
  if (officialMatrixVerified) invariant(leadingPairHarnessIds.length === 2 && leadingComparison, 'V7 official finalization cannot identify the leading matched pair');
  const reserveRequired = Boolean(leadingComparison
    && leadingComparison.decision === 'tie'
    && leadingComparison.confidenceExcludesZero === false);
  const status = revisionStatus === 'retired'
    ? 'retired'
    : revisionStatus === 'saturation-pending'
      ? 'saturation-pending'
      : saturationTriggered === true
        ? 'saturation-audit-required'
        : !complete || revisionStatus !== 'active'
          ? 'incomplete'
          : reserveRequired ? 'reserve-required' : 'official-complete';
  return {
    schemaVersion: 'agentbattler.terminal-v7-finalization-state.v1',
    status,
    officialMatrixVerified,
    reserveRequired,
    leadingPairHarnessIds,
    releaseDecision: leadingComparison?.decision ?? null,
    releaseConfidenceExcludesZero: leadingComparison?.confidenceExcludesZero ?? null,
    terminalVerified: status === 'official-complete',
  };
}

export function completeTerminalV7ReserveFinalization(official, report) {
  invariant(official?.status === 'reserve-required' && official.officialMatrixVerified === true && official.reserveRequired === true, 'V7 reserve completion requires an unresolved, strictly verified official matrix');
  invariant(report?.saturationAudit?.triggered === false, 'V7 reserve completion is blocked by a Core-100 saturation audit');
  invariant(sameHarnessPair(report.matrix?.selectedHarnesses === 2 ? report.standings?.map(({ harnessId }) => harnessId) : null, official.leadingPairHarnessIds), 'V7 reserve completion does not cover the exact unresolved leading pair');
  return {
    ...official,
    status: 'reserve-complete',
    terminalVerified: true,
    reserve: {
      reportSha256: report.reportSha256,
      decision: report.decision,
      winnerHarnessId: report.winnerHarnessId,
      selectedHarnessIds: report.standings.map(({ harnessId }) => harnessId).sort(),
    },
  };
}

async function verifyTerminalV7ReserveCompletion({ root, releaseVerification, reserveResultRoot, env }) {
  const official = releaseVerification.finalization;
  if (!official.reserveRequired) return { finalization: official, reserveEvidence: null, reserveReport: null };
  if (!await exists(reserveResultRoot)) return { finalization: official, reserveEvidence: null, reserveReport: null };
  const required = [
    'challenge.json',
    'schedule.json',
    path.join('control', 'task-binding.json'),
    path.join('control', 'calibration-control.json'),
    'final-report.json',
  ];
  if (!(await Promise.all(required.map((relative) => exists(path.join(reserveResultRoot, relative))))).every(Boolean)) {
    return { finalization: { ...official, status: 'reserve-incomplete', terminalVerified: false }, reserveEvidence: null, reserveReport: null };
  }
  const revision = releaseVerification.challenge.protocolRevision;
  const stateRoot = env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const seedKeyPath = path.resolve(env.AGENTBATTLER_V7_SEED_KEY_FILE
    ?? path.join(stateRoot, 'automations', 'mini-ledger-v6-scheduled-check', `mini-ledger-v7-${revision}.seed-key`));
  const seedKey = (await readFile(seedKeyPath, 'utf8')).trim();
  invariant(seedKey.length >= 16, 'V7 reserve finalization evaluator seed key is unavailable or invalid');
  const {
    collectTerminalV7ReserveEvidence,
    createTerminalV7ReserveFinalReport,
    validateTerminalV7ReserveFinalReport,
  } = await import('../src/terminal-v7-reserve-report.mjs');
  const [reserveEvidence, storedReport] = await Promise.all([
    collectTerminalV7ReserveEvidence({ resultRoot: reserveResultRoot, seedKey }),
    readJson(path.join(reserveResultRoot, 'final-report.json')),
  ]);
  invariant(reserveEvidence.challenge.protocolRevision === revision, 'V7 reserve evidence uses another protocol revision');
  invariant(reserveEvidence.challenge.packSelection?.sourceManifestSha256 === releaseVerification.artifactEvidence.sealManifest.sha256,
    'V7 reserve evidence is not bound to the official presealed pack manifest');
  validateTerminalV7ReserveFinalReport(storedReport);
  const expectedReport = createTerminalV7ReserveFinalReport({
    releaseVerification,
    reserveEvidence,
    createdAt: storedReport.createdAt,
  });
  invariant(canonicalJson(storedReport) === canonicalJson(expectedReport), 'V7 reserve final report does not exactly recompute from strict release and reserve evidence');
  if (storedReport.saturationAudit.triggered) {
    return {
      finalization: { ...official, status: 'saturation-pending', terminalVerified: false, reserve: { reportSha256: storedReport.reportSha256 } },
      reserveEvidence,
      reserveReport: storedReport,
    };
  }
  return {
    finalization: completeTerminalV7ReserveFinalization(official, storedReport),
    reserveEvidence,
    reserveReport: storedReport,
  };
}

export async function verifyTerminalV7Results({
  root = MODULE_ROOT,
  resultRoot,
  writeArtifacts = true,
  env = process.env,
  includeReserve = true,
  reserveResultRoot = null,
} = {}) {
  invariant(path.isAbsolute(root), 'V7 verifier repository root must be absolute');
  invariant(path.isAbsolute(resultRoot), 'V7 verifier result root must be absolute');
  const [challenge, schedule] = await Promise.all([
    readJson(path.join(resultRoot, 'challenge.json')),
    readJson(path.join(resultRoot, 'schedule.json')),
  ]);
  const revisionStopState = await readTerminalV7StrictRevisionStopState({ root, revision: challenge.protocolRevision, env });
  const retirement = revisionStopState.retirement;
  const artifactEvidence = await verifyTerminalV7Artifacts({ root, resultRoot, challenge, schedule });
  const runDirectory = path.join(resultRoot, 'runs');
  const observedEntries = await readdir(runDirectory, { withFileTypes: true }).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error));
  const observedRunFiles = observedEntries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map(({ name }) => name).sort();
  const expectedRunFiles = schedule.jobs.map(({ runKey }) => `${runKey}.json`).sort();
  const unexpectedRuns = observedRunFiles.filter((name) => !expectedRunFiles.includes(name));
  const missing = [];
  const invalid = [];
  const scoredRuns = [];
  const baseTrees = new Map();
  const temporaryRoots = [];
  try {
    for (const job of schedule.jobs) {
      const file = path.join(runDirectory, `${job.runKey}.json`);
      if (!await exists(file)) {
        missing.push({ runKey: job.runKey, harnessId: job.harness.id, instanceId: job.instanceId });
        continue;
      }
      let run = null;
      let attemptCount = 0;
      try {
        run = await readJson(file);
        validateRunSeal(run);
        validateTerminalJobIdentity(job, run);
        attemptCount = await countAttemptRecords(resultRoot, job, run);
        invariant(attemptCount >= 1, `V7 run ${job.runKey} has no immutable attempt record`);
        if (run.status !== 'completed') {
          invariant(['infrastructure-invalid', 'protocol-invalid'].includes(run.status), `Unsupported V7 terminal status ${run.status}`);
          invalid.push(privacySafeInvalid(job.runKey, run.status, attemptCount, run.error));
          continue;
        }
        if (!baseTrees.has(job.instanceId)) {
          baseTrees.set(job.instanceId, await baseTreeForInstance({ challenge, instanceId: job.instanceId, temporaryRoots }));
        }
        const validated = await validateTerminalV7CompletedRun({
          challenge,
          job,
          run,
          resultRoot,
          baseTree: baseTrees.get(job.instanceId),
          requirementMap: artifactEvidence.requirementMap,
          recomputeFinal: artifactEvidence.recomputeFinal,
        });
        scoredRuns.push({ job, attemptCount, ...validated });
      } catch (error) {
        invalid.push(privacySafeInvalid(job.runKey, run?.status ?? 'malformed-evidence', attemptCount, error));
      }
    }
  } finally {
    await Promise.allSettled(temporaryRoots.map((temporary) => rm(temporary, { recursive: true, force: true })));
  }

  for (const file of unexpectedRuns) invalid.push(privacySafeInvalid(file.slice(0, -5), 'unexpected-run-record', 0, 'not present in the sealed schedule'));
  const complete = missing.length === 0 && invalid.length === 0 && scoredRuns.length === 25;
  const pairedAnalysis = complete
    ? analyzeTerminalV7PairedPacks(scoredRuns.map(({ job, score }) => ({ harnessId: job.harness.id, instanceId: job.instanceId, score })), { challenge })
    : null;
  const saturated = scoredRuns.find(({ score }) => score.core.points === 100) ?? null;
  const saturationAudit = {
    schemaVersion: 'agentbattler.terminal-v7-saturation-audit.v1',
    pauseAtNextSafeBoundary: Boolean(saturated),
    reason: saturated ? 'core-100-saturation-audit' : null,
    runKey: saturated?.job.runKey ?? null,
    harnessId: saturated?.job.harness.id ?? null,
    instanceId: saturated?.job.instanceId ?? null,
    detectedCore: saturated?.score.core.points ?? null,
  };
  const saturationMarker = { ...saturationAudit, markerSha256: canonicalJsonSha256(saturationAudit) };
  const operational = aggregateTerminalV7OperationalMetrics(scoredRuns.map(({ run }) => run), {
    expectedRuns: 25,
    infrastructureInvalid: invalid.length,
    missing: missing.length,
  });
  const challengeSummary = { id: challenge.challengeId, sha256: challenge.challengeSha256, protocolRevision: challenge.protocolRevision };
  const scheduleSummary = { id: schedule.scheduleId, sha256: schedule.scheduleSha256 };
  const artifactSummary = {
    files: artifactEvidence.promptAndVerifierFiles,
    adapterFileCount: artifactEvidence.adapterFileCount,
    tasks: artifactEvidence.taskTrees,
    verifierImage: artifactEvidence.verifierImage,
    runtimeImages: artifactEvidence.runtimeImages,
    sealManifestSha256: artifactEvidence.sealManifest.sha256,
    releaseGateSha256: artifactEvidence.releaseGates.sha256,
    goldArtifacts: artifactEvidence.goldArtifacts,
  };
  const scoreSummary = scoredRuns.map(({ job, score, attemptCount, trees }) => ({
    runKey: job.runKey,
    harnessId: job.harness.id,
    instanceId: job.instanceId,
    attemptCount,
    core: score.core.points,
    public: score.core.public.points,
    hiddenAtomic: score.core.hiddenAtomic.points,
    hiddenComposed: score.core.hiddenComposed.points,
    hidden: score.core.hidden.points,
    exact: score.exact,
    adaptability: score.adaptability.points,
    proxyGap: score.proxyGap,
    candidateTreeSha256: trees.map(({ treeSha256 }) => treeSha256),
  }));
  const standings = harnessStandings(scoredRuns);
  const finalizationBase = classifyTerminalV7OfficialFinalization({
    complete,
    revisionStatus: revisionStopState.status,
    saturationTriggered: Boolean(saturated),
    standings,
    pairedAnalysis,
  });
  const officialEvidenceUnsigned = {
    schemaVersion: 'agentbattler.terminal-v7-official-evidence.v1',
    challenge: challengeSummary,
    schedule: scheduleSummary,
    artifactEvidence: artifactSummary,
    expectedRuns: 25,
    completedValidRuns: scoredRuns.length,
    exactRuns: scoredRuns.filter(({ score }) => score.exact).length,
    missingRuns: missing,
    invalidRuns: invalid,
    operational,
    revisionControl: {
      status: revisionStopState.status,
      retirementRecordSha256: retirement?.recordSha256 ?? null,
      saturationMarkerSha256: revisionStopState.saturation?.markerSha256 ?? null,
    },
    retirement,
    saturationAudit: saturationMarker,
    scores: scoreSummary,
    standings,
    pairedAnalysis,
  };
  const officialEvidenceSha256 = canonicalJsonSha256(officialEvidenceUnsigned);
  const releaseVerification = {
    challenge,
    schedule,
    artifactEvidence,
    scoredRuns,
    officialMatrixVerified: finalizationBase.officialMatrixVerified,
    officialEvidenceSha256,
    finalization: finalizationBase,
    summary: { pairedAnalysis, operational, standings, officialEvidenceSha256 },
  };
  const resolvedReserveRoot = path.resolve(reserveResultRoot
    ?? env.AGENTBATTLER_V7_RESERVE_RESULT_ROOT
    ?? path.join(root, 'results', `terminal-mini-ledger-v7-reserve-${challenge.protocolRevision}`));
  const reserveCompletion = includeReserve
    ? await verifyTerminalV7ReserveCompletion({ root, releaseVerification, reserveResultRoot: resolvedReserveRoot, env })
    : { finalization: finalizationBase, reserveEvidence: null, reserveReport: null };
  const finalization = reserveCompletion.finalization;
  const terminalVerified = finalization.terminalVerified === true;
  invariant(!terminalVerified || (!saturated && revisionStopState.status !== 'saturation-pending'), 'V7 strict verification cannot complete while a Core-100 saturation audit is unresolved');
  const operationalPools = reserveCompletion.reserveReport?.operational ?? {
    release: operational,
    reserve: null,
    combined: operational,
  };
  const summaryUnsigned = {
    ...officialEvidenceUnsigned,
    schemaVersion: 'agentbattler.terminal-v7-results-summary.v2',
    officialEvidenceSha256,
    officialMatrixVerified: finalizationBase.officialMatrixVerified,
    terminalVerified,
    benchmarkStatus: finalization.status,
    finalization,
    operationalPools,
    reserveFinalReport: reserveCompletion.reserveReport,
  };
  const summary = { ...summaryUnsigned, summarySha256: canonicalJsonSha256(summaryUnsigned) };
  if (writeArtifacts) {
    await mkdir(resultRoot, { recursive: true });
    await Promise.all([
      writeFile(path.join(resultRoot, 'summary.json'), `${canonicalJson(summary, { space: 2 })}\n`, { mode: 0o600 }),
      writeFile(path.join(resultRoot, 'saturation-audit.json'), `${canonicalJson(saturationMarker, { space: 2 })}\n`, { mode: 0o600 }),
    ]);
  }
  return {
    challenge,
    schedule,
    artifactEvidence,
    scoredRuns,
    summary,
    retirement,
    revisionStopState,
    officialMatrixVerified: finalizationBase.officialMatrixVerified,
    officialEvidenceSha256,
    finalization,
    reserveEvidence: reserveCompletion.reserveEvidence,
    reserveReport: reserveCompletion.reserveReport,
    terminalVerified,
  };
}

async function main() {
  const revision = process.env.AGENTBATTLER_TERMINAL_PROTOCOL_REVISION ?? 'r2';
  const resultTag = process.env.AGENTBATTLER_TERMINAL_RESULT_TAG ?? `v7-${revision}`;
  invariant(/^r[1-9]\d*$/.test(revision), 'V7 protocol revision must look like r1');
  invariant(/^v7-r[1-9]\d*$/.test(resultTag), 'V7 result tag must look like v7-r1');
  invariant(!process.argv.includes('--allow-incomplete'), 'Strict V7 terminal verification does not allow incomplete results');
  const resultRoot = path.resolve(process.env.AGENTBATTLER_TERMINAL_RESULT_ROOT
    ?? path.join(MODULE_ROOT, `results/terminal-mini-ledger-${resultTag}`));
  const result = await verifyTerminalV7Results({ root: MODULE_ROOT, resultRoot });
  console.log(`Mini Ledger V7 terminal verification: ${result.summary.completedValidRuns}/25 valid, ${result.summary.invalidRuns.length} invalid, ${result.summary.missingRuns.length} missing`);
  console.log(`Exact: ${result.summary.exactRuns}/25; saturation pause: ${result.summary.saturationAudit.pauseAtNextSafeBoundary ? 'required' : 'not triggered'}`);
  console.log(`Matched harness means: ${result.summary.standings.map(({ harnessId, matchedMeanCore }) => `${harnessId}=${matchedMeanCore}`).join(', ') || 'unavailable'}`);
  if (!result.terminalVerified) process.exitCode = 1;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main().catch((error) => {
  console.error(`Mini Ledger V7 verification failed: ${error.message}`);
  process.exitCode = 1;
});
