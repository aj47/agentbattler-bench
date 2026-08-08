import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  bindV7PhaseEntryContract,
  hashV7ExecutableTree,
  installV7Phase,
  loadV7Pack,
  sealV7Pack,
  V7_HIDDEN_CASES,
  V7_POOL_INSTANCES,
} from '../benchmark/challenges/mini-ledger-v7/pack.mjs';
import {
  V7_FAMILIES,
  V7_REQUIREMENTS,
} from '../benchmark/challenges/mini-ledger-v7/requirements.mjs';
import {
  materializeFreshGoldImplementationA,
  prepareGoldImplementationAPhase,
} from '../benchmark/challenges/mini-ledger-v7/gold/implementation-a/materialize.mjs';
import {
  materializeFreshGoldImplementationB,
  prepareGoldImplementationBPhase,
} from '../benchmark/challenges/mini-ledger-v7/gold/implementation-b/materialize.mjs';
import { validateTerminalV7GoldReport } from '../scripts/validate-terminal-v7-golds.mjs';
import { canonicalJson, canonicalJsonSha256, sha256File } from './provenance.mjs';
import { validateTerminalV7SealManifest } from './terminal-v7-seals.mjs';
import {
  inspectTerminalV7VerifierImage,
  terminalV7VerifierSourceDescriptor,
  verifyTerminalV7InContainer,
} from './terminal-v7-verifier-container.mjs';

export const TERMINAL_V7_SCRIPTED_REFERENCE_REPORT_SCHEMA = 'agentbattler.terminal-v7-scripted-reference-report.v1';
export const TERMINAL_V7_SCRIPTED_REFERENCE_ROW_SCHEMA = 'agentbattler.terminal-v7-scripted-reference-row-evidence.v1';
export const TERMINAL_V7_SCRIPTED_REFERENCE_CLOSURE_SCHEMA = 'agentbattler.terminal-v7-scripted-reference-artifact-closure.v1';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA256_RE = /^[0-9a-f]{64}$/;
const IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/;
const VARIANTS = Object.freeze(['clean', 'decoy']);
const VERIFIER_SEED_INDEX = 0;
const FORBIDDEN_KEYS = new Set([
  'prompt', 'prompts', 'session', 'sessionId', 'messages', 'response', 'responses',
  'trajectory', 'trajectories', 'transcript', 'command', 'commands', 'stdout', 'stderr',
  'toolCalls', 'auth', 'token', 'accessToken', 'refreshToken', 'apiKey', 'seedKey', 'hiddenSeed',
]);

const IMPLEMENTATIONS = Object.freeze([
  Object.freeze({
    id: 'implementation-a',
    sourceRoot: 'benchmark/challenges/mini-ledger-v7/gold/implementation-a',
    materialize: materializeFreshGoldImplementationA,
    preparePhaseFour: prepareGoldImplementationAPhase,
  }),
  Object.freeze({
    id: 'implementation-b',
    sourceRoot: 'benchmark/challenges/mini-ledger-v7/gold/implementation-b',
    materialize: materializeFreshGoldImplementationB,
    preparePhaseFour: prepareGoldImplementationBPhase,
  }),
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function safeAbsolute(value, label) {
  invariant(typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0'), `${label} must be an absolute path`);
  return path.resolve(value);
}

function safeRelative(value, label) {
  invariant(typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !value.includes('\0'), `${label} path is invalid`);
  const normalized = path.posix.normalize(value.replaceAll(path.sep, '/'));
  invariant(normalized !== '.' && normalized !== '..' && !normalized.startsWith('../'), `${label} path escapes its evidence root`);
  return normalized;
}

function contained(root, relative, label) {
  const normalized = safeRelative(relative, label);
  const destination = path.resolve(root, ...normalized.split('/'));
  const relation = path.relative(path.resolve(root), destination);
  invariant(relation && relation !== '..' && !relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation), `${label} escaped its evidence root`);
  return destination;
}

function assertNoLeakageKeys(value, location = '$') {
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoLeakageKeys(child, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    invariant(!FORBIDDEN_KEYS.has(key), `V7 scripted-reference evidence contains forbidden field ${location}.${key}`);
    assertNoLeakageKeys(child, `${location}.${key}`);
  }
}

async function sourceRecords(root, relative = '') {
  const records = [];
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = relative ? path.posix.join(relative, entry.name) : entry.name;
    const absolute = path.join(root, ...child.split('/'));
    const stat = await lstat(absolute);
    invariant(!stat.isSymbolicLink(), `V7 scripted implementation source contains a symlink: ${child}`);
    if (stat.isDirectory()) records.push(...await sourceRecords(root, child));
    else {
      invariant(stat.isFile(), `V7 scripted implementation source contains a non-regular entry: ${child}`);
      records.push({ path: child, sha256: await sha256File(absolute) });
    }
  }
  return records;
}

async function implementationDescriptor(implementation, root) {
  const sourceRoot = path.join(root, ...implementation.sourceRoot.split('/'));
  const files = await sourceRecords(sourceRoot);
  return {
    implementationId: implementation.id,
    sourceRoot: implementation.sourceRoot,
    fileCount: files.length,
    sourceSha256: canonicalJsonSha256(files),
  };
}

export async function terminalV7ScriptedImplementationDescriptors({ root = ROOT } = {}) {
  const repositoryRoot = safeAbsolute(root, 'V7 scripted-reference repository root');
  return Promise.all(IMPLEMENTATIONS.map((implementation) => implementationDescriptor(implementation, repositoryRoot)));
}

async function prepareWorkspace({ implementation, pack, destination }) {
  await implementation.materialize({ destination, pack });
  const control = path.join(destination, '.agentbattler', 'current');
  await mkdir(control, { recursive: true, mode: 0o700 });
  const installed = await installV7Phase({ pack, phase: 4, destination: control });
  const executableSourceSha256 = await hashV7ExecutableTree(destination);
  const contract = bindV7PhaseEntryContract(installed.contract, executableSourceSha256);
  await writeFile(path.join(control, 'task-contract.json'), `${canonicalJson(contract, { space: 2 })}\n`, { mode: 0o400 });
  await implementation.preparePhaseFour({ destination, phase: 4 });
  invariant(await hashV7ExecutableTree(destination) === executableSourceSha256, `${implementation.id} changed executable source during the forensic phase`);
  return { contract, executableSourceSha256 };
}

function normalizedEvaluation(evaluation) {
  return {
    schemaVersion: evaluation.schemaVersion,
    challengeId: evaluation.challengeId,
    instanceId: evaluation.instanceId,
    variant: evaluation.variant,
    phase: evaluation.phase,
    passed: evaluation.passed,
    score: evaluation.score,
    maxScore: evaluation.maxScore,
    publicScore: evaluation.publicScore,
    privateScore: evaluation.privateScore,
    infrastructureErrors: evaluation.infrastructureErrors,
    requirements: evaluation.requirements,
    families: evaluation.families,
    adaptability: evaluation.adaptability,
    verifierSeedIndex: evaluation.verifierSeedIndex,
    seedCommitments: evaluation.seedCommitments,
  };
}

function validateEvaluation(evaluation, { instanceId, variant, label }) {
  invariant(evaluation?.schemaVersion === 'agentbattler.mini-ledger-v7.verification.v1', `${label} verification schema changed`);
  invariant(evaluation.challengeId === 'terminal-mini-ledger-v7'
    && evaluation.instanceId === instanceId
    && evaluation.variant === variant
    && evaluation.phase === null
    && evaluation.verifierSeedIndex === VERIFIER_SEED_INDEX, `${label} verification identity changed`);
  invariant(Array.isArray(evaluation.infrastructureErrors) && evaluation.infrastructureErrors.length === 0, `${label} has verifier infrastructure errors`);
  invariant(evaluation.passed === true && evaluation.score === 100 && evaluation.maxScore === 100
    && evaluation.publicScore === 20 && evaluation.privateScore === 80, `${label} did not score 100`);
  invariant(evaluation.adaptability?.passed === 5 && evaluation.adaptability?.total === 5, `${label} did not preserve every phase checkpoint`);
  invariant(Array.isArray(evaluation.requirements) && evaluation.requirements.length === V7_REQUIREMENTS.length
    && evaluation.requirements.every(({ passed, points, weight }) => passed === true && points === weight)
    && evaluation.requirements.reduce((sum, { points }) => sum + points, 0) === 100
    && evaluation.requirements.reduce((sum, { weight }) => sum + weight, 0) === 100, `${label} requirement scores are incomplete`);
  const requirements = new Map(evaluation.requirements.map((requirement) => [requirement.id, requirement]));
  invariant(requirements.size === V7_REQUIREMENTS.length, `${label} requirement identities are duplicated`);
  for (const expected of V7_REQUIREMENTS) {
    const actual = requirements.get(expected.id);
    invariant(actual?.group === expected.group
      && actual.family === expected.family
      && actual.weight === expected.weight
      && actual.points === expected.weight
      && actual.passed === true, `${label} requirement identity changed: ${expected.id}`);
  }
  invariant(Array.isArray(evaluation.families) && evaluation.families.length === V7_FAMILIES.length, `${label} family scores are incomplete`);
  const families = new Map(evaluation.families.map((family) => [family.id, family]));
  invariant(families.size === V7_FAMILIES.length && V7_FAMILIES.every((id) => families.has(id)), `${label} family identities changed`);
  for (const id of V7_FAMILIES) {
    const family = families.get(id);
    invariant(family.public?.passed === 4 && family.public.total === 4
      && family.hiddenAtomic?.passed === 6 && family.hiddenAtomic.total === 6
      && family.hiddenComposed?.passed === 10 && family.hiddenComposed.total === 10
      && family.hidden?.passed === 16 && family.hidden.total === 16, `${label} family ${id} score changed`);
  }
  invariant(Array.isArray(evaluation.seedCommitments) && evaluation.seedCommitments.length === V7_HIDDEN_CASES.length
    && evaluation.seedCommitments.every(({ id, masterCommitment, variantCommitment }) => (
      typeof id === 'string' && id.length > 0 && SHA256_RE.test(masterCommitment ?? '') && SHA256_RE.test(variantCommitment ?? '')
    )) && new Set(evaluation.seedCommitments.map(({ id }) => id)).size === evaluation.seedCommitments.length
    && V7_HIDDEN_CASES.every(({ id }) => evaluation.seedCommitments.some((commitment) => commitment.id === id)), `${label} seed commitments are invalid`);
  assertNoLeakageKeys(evaluation);
  return evaluation;
}

async function artifactRecords(evidenceRoot, directory, relative = '') {
  const records = [];
  const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = relative ? path.posix.join(relative, entry.name) : entry.name;
    const absolute = path.join(directory, ...child.split('/'));
    const stat = await lstat(absolute);
    invariant(!stat.isSymbolicLink(), `V7 scripted-reference verifier artifact contains a symlink: ${child}`);
    if (stat.isDirectory()) records.push(...await artifactRecords(evidenceRoot, directory, child));
    else {
      invariant(stat.isFile() && stat.nlink === 1, `V7 scripted-reference verifier artifact is not one regular file: ${child}`);
      const relativeToRoot = path.relative(evidenceRoot, absolute).split(path.sep).join('/');
      safeRelative(relativeToRoot, `V7 scripted-reference verifier artifact ${child}`);
      records.push({ path: relativeToRoot, size: stat.size, sha256: await sha256File(absolute) });
    }
  }
  return records;
}

function rowEvidenceUnsigned({
  revision,
  implementation,
  implementationSource,
  pack,
  executableSourceSha256,
  verifierImage,
  evaluation,
  verifierArtifacts,
  goldRow,
}) {
  const normalized = normalizedEvaluation(evaluation);
  return {
    schemaVersion: TERMINAL_V7_SCRIPTED_REFERENCE_ROW_SCHEMA,
    challengeId: 'terminal-mini-ledger-v7',
    revision,
    implementation: implementationSource,
    instance: {
      instanceId: pack.instanceId,
      pool: pack.pool,
      variant: pack.variant,
      packSha256: pack.packSha256,
      sealSha256: pack.sealSha256,
      starterTreeSha256: pack.starterTreeSha256,
      twinRelationSha256: pack.twinRelationSha256,
      hiddenMerkleRoot: pack.hiddenMerkleRoot,
    },
    executableSourceSha256,
    verifierImage: {
      imageId: verifierImage.imageId,
      sourceSha256: verifierImage.sourceSha256,
    },
    verifierSeedIndex: VERIFIER_SEED_INDEX,
    evaluation: normalized,
    evaluationSha256: canonicalJsonSha256(normalized),
    verifierArtifacts,
    verifierArtifactsSha256: canonicalJsonSha256(verifierArtifacts),
    goldBinding: {
      goldImplementationSourceSha256: goldRow.implementationSourceSha256,
      goldExecutableSourceSha256: goldRow.executableSourceSha256,
      goldPackSha256: goldRow.packSha256,
      goldSealSha256: goldRow.sealSha256,
      goldResultsSha256: goldRow.resultsSha256,
      goldVerifierSeeds: goldRow.verifierSeeds,
      goldMinimumCore: goldRow.minimumCore,
      goldExactCount: goldRow.exactCount,
    },
  };
}

function reportRow(evidence, evidencePath, evidenceFileSha256) {
  return {
    implementationId: evidence.implementation.implementationId,
    instanceId: evidence.instance.instanceId,
    variant: evidence.instance.variant,
    status: 'completed',
    validity: 'valid',
    corePoints: evidence.evaluation.score,
    exact: evidence.evaluation.passed,
    implementationSourceSha256: evidence.implementation.sourceSha256,
    executableSourceSha256: evidence.executableSourceSha256,
    packSha256: evidence.instance.packSha256,
    sealSha256: evidence.instance.sealSha256,
    verifierImageId: evidence.verifierImage.imageId,
    verifierSourceSha256: evidence.verifierImage.sourceSha256,
    verifierSeedIndex: evidence.verifierSeedIndex,
    evaluationSha256: evidence.evaluationSha256,
    verifierArtifactsSha256: evidence.verifierArtifactsSha256,
    goldResultsSha256: evidence.goldBinding.goldResultsSha256,
    evidencePath,
    evidenceFileSha256,
  };
}

function expectedMatrixKeys(implementationIds) {
  const keys = new Set();
  for (const implementationId of implementationIds) {
    for (const instanceId of V7_POOL_INSTANCES.dev) {
      for (const variant of VARIANTS) keys.add(`${implementationId}\0${instanceId}\0${variant}`);
    }
  }
  return keys;
}

function maximumTwinDifference(rows) {
  let maximum = 0;
  const implementationIds = [...new Set(rows.map(({ implementationId }) => implementationId))];
  for (const implementationId of implementationIds) {
    for (const instanceId of V7_POOL_INSTANCES.dev) {
      const clean = rows.find((row) => row.implementationId === implementationId && row.instanceId === instanceId && row.variant === 'clean');
      const decoy = rows.find((row) => row.implementationId === implementationId && row.instanceId === instanceId && row.variant === 'decoy');
      maximum = Math.max(maximum, Math.abs(decoy.corePoints - clean.corePoints));
    }
  }
  return maximum;
}

export function sealTerminalV7ScriptedReferenceReport(unsigned) {
  invariant(unsigned?.schemaVersion === TERMINAL_V7_SCRIPTED_REFERENCE_REPORT_SCHEMA, 'V7 scripted-reference report schema is invalid');
  return { ...unsigned, reportSha256: canonicalJsonSha256(unsigned) };
}

export function validateTerminalV7ScriptedReferenceReport(report, {
  revision = null,
  sealManifestSha256 = null,
  goldReportSha256 = null,
  verifierImage = null,
} = {}) {
  invariant(report?.schemaVersion === TERMINAL_V7_SCRIPTED_REFERENCE_REPORT_SCHEMA, 'Unsupported V7 scripted-reference report schema');
  const { reportSha256, ...unsigned } = report;
  invariant(SHA256_RE.test(reportSha256 ?? '') && reportSha256 === canonicalJsonSha256(unsigned), 'V7 scripted-reference report hash mismatch');
  invariant(report.challengeId === 'terminal-mini-ledger-v7' && /^r[1-9]\d*$/.test(report.revision ?? ''), 'V7 scripted-reference report identity is invalid');
  invariant(typeof report.createdAt === 'string' && Number.isFinite(Date.parse(report.createdAt)), 'V7 scripted-reference report timestamp is invalid');
  if (revision !== null) invariant(report.revision === revision, 'V7 scripted-reference report revision changed');
  if (sealManifestSha256 !== null) invariant(report.sealManifestSha256 === sealManifestSha256, 'V7 scripted-reference seal-manifest commitment changed');
  if (goldReportSha256 !== null) invariant(report.goldReportSha256 === goldReportSha256, 'V7 scripted-reference gold-report commitment changed');
  invariant(SHA256_RE.test(report.sealManifestSha256 ?? '') && SHA256_RE.test(report.goldReportSha256 ?? ''), 'V7 scripted-reference source commitments are invalid');
  invariant(report.policy?.implementations === 2
    && report.policy?.developmentPacks === V7_POOL_INSTANCES.dev.length
    && canonicalJson(report.policy?.variants) === canonicalJson(VARIANTS)
    && report.policy?.verifierSeedIndex === VERIFIER_SEED_INDEX
    && report.policy?.verifierBoundary === 'sealed-linux-strace-container'
    && report.policy?.reporting === 'aggregate-scores-and-commitments-only', 'V7 scripted-reference policy changed');
  invariant(IMAGE_ID_RE.test(report.verifierImage?.imageId ?? '') && SHA256_RE.test(report.verifierImage?.sourceSha256 ?? ''), 'V7 scripted-reference verifier identity is invalid');
  if (verifierImage !== null) invariant(report.verifierImage.imageId === verifierImage.imageId
    && report.verifierImage.sourceSha256 === verifierImage.sourceSha256, 'V7 scripted references used another verifier image');
  invariant(Array.isArray(report.implementations) && report.implementations.length === 2
    && new Set(report.implementations.map(({ implementationId }) => implementationId)).size === 2
    && new Set(report.implementations.map(({ sourceSha256 }) => sourceSha256)).size === 2
    && report.implementations.every(({ sourceRoot, fileCount, sourceSha256 }) => (
      typeof sourceRoot === 'string' && sourceRoot.length > 0 && Number.isSafeInteger(fileCount) && fileCount > 0 && SHA256_RE.test(sourceSha256 ?? '')
    )), 'V7 scripted-reference implementation descriptors are invalid');
  const expected = expectedMatrixKeys(report.implementations.map(({ implementationId }) => implementationId));
  invariant(Array.isArray(report.rows) && report.rows.length === expected.size, 'V7 scripted-reference matrix is incomplete');
  const observed = new Set();
  const evidencePaths = new Set();
  for (const row of report.rows) {
    const key = `${row.implementationId}\0${row.instanceId}\0${row.variant}`;
    invariant(expected.has(key) && !observed.has(key), `V7 scripted-reference row is unexpected or duplicated: ${key}`);
    observed.add(key);
    invariant(row.status === 'completed' && row.validity === 'valid' && row.corePoints === 100 && row.exact === true, `V7 scripted-reference row did not qualify: ${key}`);
    invariant(row.verifierSeedIndex === VERIFIER_SEED_INDEX && IMAGE_ID_RE.test(row.verifierImageId ?? ''), `V7 scripted-reference row verifier identity changed: ${key}`);
    for (const field of [
      'implementationSourceSha256', 'executableSourceSha256', 'packSha256', 'sealSha256',
      'verifierSourceSha256', 'evaluationSha256', 'verifierArtifactsSha256', 'goldResultsSha256', 'evidenceFileSha256',
    ]) invariant(SHA256_RE.test(row[field] ?? ''), `V7 scripted-reference row ${field} is invalid: ${key}`);
    invariant(row.verifierImageId === report.verifierImage.imageId && row.verifierSourceSha256 === report.verifierImage.sourceSha256, `V7 scripted-reference row verifier changed: ${key}`);
    const implementation = report.implementations.find(({ implementationId }) => implementationId === row.implementationId);
    invariant(row.implementationSourceSha256 === implementation.sourceSha256, `V7 scripted-reference implementation source changed: ${key}`);
    const evidencePath = safeRelative(row.evidencePath, `V7 scripted-reference row ${key}`);
    invariant(evidencePath.startsWith('control/scripted-reference-evidence/rows/') && !evidencePaths.has(evidencePath), `V7 scripted-reference evidence path is invalid or reused: ${key}`);
    evidencePaths.add(evidencePath);
  }
  invariant(observed.size === expected.size, 'V7 scripted-reference identities are incomplete');
  const difference = maximumTwinDifference(report.rows);
  invariant(report.summary?.rows === expected.size
    && report.summary?.independentImplementations === 2
    && report.summary?.minimumCore === 100
    && report.summary?.exactRows === expected.size
    && report.summary?.infrastructureInvalid === 0
    && report.summary?.maximumAbsoluteTwinDifference === difference
    && difference === 0, 'V7 scripted-reference summary is not release qualifying');
  invariant(report.privacy?.aggregateOnly === true
    && report.privacy?.privateSeedsIncluded === false
    && report.privacy?.verifierCasesIncluded === false
    && report.privacy?.promptsIncluded === false
    && report.privacy?.sessionsIncluded === false
    && report.privacy?.modelTextIncluded === false, 'V7 scripted-reference privacy policy changed');
  assertNoLeakageKeys(report);
  return report;
}

function goldRowsByKey(goldReport) {
  const implementationSources = new Map(goldReport.implementations.map(({ implementationId, sourceSha256 }) => [implementationId, sourceSha256]));
  return new Map(goldReport.rows.map((row) => [`${row.implementationId}\0${row.instanceId}\0${row.variant}`, {
    ...row,
    implementationSourceSha256: implementationSources.get(row.implementationId),
  }]));
}

async function validateArtifactInventory(evidenceRoot, row, evidence) {
  invariant(Array.isArray(evidence.verifierArtifacts) && evidence.verifierArtifacts.length > 0
    && evidence.verifierArtifactsSha256 === canonicalJsonSha256(evidence.verifierArtifacts), `V7 scripted-reference verifier artifacts changed: ${row.evidencePath}`);
  const expectedPrefix = `control/scripted-reference-evidence/verifier/${row.implementationId}/${row.instanceId}/${row.variant}/`;
  const seen = new Set();
  for (const artifact of evidence.verifierArtifacts) {
    const relative = safeRelative(artifact.path, `V7 scripted-reference artifact ${row.evidencePath}`);
    invariant(relative.startsWith(expectedPrefix) && !seen.has(relative), `V7 scripted-reference artifact path is invalid or reused: ${relative}`);
    seen.add(relative);
    invariant(Number.isSafeInteger(artifact.size) && artifact.size >= 0 && SHA256_RE.test(artifact.sha256 ?? ''), `V7 scripted-reference artifact descriptor is invalid: ${relative}`);
    const file = contained(evidenceRoot, relative, `V7 scripted-reference artifact ${relative}`);
    const stat = await lstat(file);
    invariant(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size === artifact.size, `V7 scripted-reference artifact is not the sealed regular file: ${relative}`);
    invariant(await sha256File(file) === artifact.sha256, `V7 scripted-reference artifact hash mismatch: ${relative}`);
  }
}

function reportProjectionFromEvidence(evidence, row) {
  return reportRow(evidence, row.evidencePath, row.evidenceFileSha256);
}

export async function assertTerminalV7ScriptedReferenceArtifacts({
  evidenceRoot,
  root = ROOT,
  report,
  sealManifest,
  goldReport,
  expectedVerifierImage = null,
} = {}) {
  const destination = safeAbsolute(evidenceRoot, 'V7 scripted-reference evidence root');
  const repositoryRoot = safeAbsolute(root, 'V7 scripted-reference source root');
  validateTerminalV7SealManifest(sealManifest);
  validateTerminalV7GoldReport(goldReport, { revision: sealManifest.revision, expectedVerifierImage: expectedVerifierImage ?? null });
  validateTerminalV7ScriptedReferenceReport(report, {
    revision: sealManifest.revision,
    sealManifestSha256: sealManifest.manifestSha256,
    goldReportSha256: goldReport.reportSha256,
    verifierImage: expectedVerifierImage ?? goldReport.verifierImage,
  });
  invariant(report.verifierImage.imageId === goldReport.verifierImage.imageId
    && report.verifierImage.sourceSha256 === goldReport.verifierImage.sourceSha256, 'V7 scripted references and gold gate used different verifier images');
  const verifierSource = await terminalV7VerifierSourceDescriptor({ root: repositoryRoot });
  invariant(verifierSource.sourceSha256 === report.verifierImage.sourceSha256, 'V7 scripted-reference verifier source bytes changed');
  const implementations = await terminalV7ScriptedImplementationDescriptors({ root: repositoryRoot });
  invariant(canonicalJson(implementations) === canonicalJson(report.implementations), 'V7 scripted-reference implementation source bytes changed');
  const implementationById = new Map(IMPLEMENTATIONS.map((implementation) => [implementation.id, implementation]));
  const descriptorById = new Map(implementations.map((implementation) => [implementation.implementationId, implementation]));
  const goldRows = goldRowsByKey(goldReport);
  const devTwins = new Map(sealManifest.packs.filter(({ pool }) => pool === 'dev').map((twin) => [twin.instanceId, twin]));
  invariant(devTwins.size === V7_POOL_INSTANCES.dev.length, 'V7 scripted-reference development pack seals are incomplete');
  const auditRoot = await mkdtemp(path.join(await realpath(os.tmpdir()), 'agentbattler-v7-scripted-audit-'));
  const evidenceCommitments = [];
  const artifactCommitments = [];
  try {
    for (const [index, row] of report.rows.entries()) {
      const implementation = implementationById.get(row.implementationId);
      const descriptor = descriptorById.get(row.implementationId);
      invariant(implementation && descriptor, `Unknown V7 scripted implementation: ${row.implementationId}`);
      const twin = devTwins.get(row.instanceId);
      const manifestPack = twin?.[row.variant];
      invariant(manifestPack?.packSha256 === row.packSha256 && manifestPack?.sealSha256 === row.sealSha256, `V7 scripted-reference pack commitment changed: ${row.instanceId}/${row.variant}`);
      const canonicalPack = sealV7Pack(loadV7Pack(row.instanceId, { variant: row.variant }));
      invariant(canonicalPack.packSha256 === manifestPack.packSha256
        && canonicalPack.sealSha256 === manifestPack.sealSha256, `V7 scripted-reference local pack bytes changed: ${row.instanceId}/${row.variant}`);
      const goldRow = goldRows.get(`${row.implementationId}\0${row.instanceId}\0${row.variant}`);
      invariant(goldRow?.pool === 'dev'
        && goldRow.packSha256 === row.packSha256
        && goldRow.sealSha256 === row.sealSha256
        && goldRow.implementationSourceSha256 === row.implementationSourceSha256
        && goldRow.executableSourceSha256 === row.executableSourceSha256
        && goldRow.resultsSha256 === row.goldResultsSha256
        && goldRow.verifierSeeds === 100
        && goldRow.minimumCore === 100
        && goldRow.exactCount === 100
        && goldRow.infrastructureInvalid === 0, `V7 scripted-reference row is not backed by its qualifying 100-seed gold row: ${row.instanceId}/${row.variant}`);

      const evidenceFile = contained(destination, row.evidencePath, `V7 scripted-reference row ${row.instanceId}/${row.variant}`);
      const stat = await lstat(evidenceFile);
      invariant(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, `V7 scripted-reference row evidence is not one regular file: ${row.evidencePath}`);
      invariant(await sha256File(evidenceFile) === row.evidenceFileSha256, `V7 scripted-reference row evidence hash mismatch: ${row.evidencePath}`);
      const evidence = JSON.parse(await readFile(evidenceFile, 'utf8'));
      invariant(evidence?.schemaVersion === TERMINAL_V7_SCRIPTED_REFERENCE_ROW_SCHEMA, 'Unsupported V7 scripted-reference row-evidence schema');
      const { evidenceSha256, ...unsignedEvidence } = evidence;
      invariant(SHA256_RE.test(evidenceSha256 ?? '') && evidenceSha256 === canonicalJsonSha256(unsignedEvidence), `V7 scripted-reference row evidence seal mismatch: ${row.evidencePath}`);
      invariant(evidence.challengeId === 'terminal-mini-ledger-v7' && evidence.revision === report.revision
        && evidence.implementation?.implementationId === row.implementationId
        && evidence.instance?.instanceId === row.instanceId
        && evidence.instance?.variant === row.variant, `V7 scripted-reference row evidence identity changed: ${row.evidencePath}`);
      invariant(canonicalJson(evidence.implementation) === canonicalJson(descriptor), `V7 scripted-reference implementation descriptor changed: ${row.evidencePath}`);
      invariant(evidence.instance.packSha256 === row.packSha256
        && evidence.instance.sealSha256 === row.sealSha256
        && evidence.instance.starterTreeSha256 === manifestPack.starterTreeSha256
        && evidence.instance.twinRelationSha256 === twin.twinRelationSha256
        && evidence.instance.hiddenMerkleRoot === twin.hiddenMerkleRoot, `V7 scripted-reference pack evidence changed: ${row.evidencePath}`);
      invariant(evidence.executableSourceSha256 === row.executableSourceSha256
        && evidence.verifierImage.imageId === report.verifierImage.imageId
        && evidence.verifierImage.sourceSha256 === report.verifierImage.sourceSha256
        && evidence.verifierSeedIndex === VERIFIER_SEED_INDEX, `V7 scripted-reference execution commitment changed: ${row.evidencePath}`);
      validateEvaluation(evidence.evaluation, { instanceId: row.instanceId, variant: row.variant, label: `${row.implementationId}/${row.instanceId}/${row.variant}` });
      invariant(evidence.evaluationSha256 === canonicalJsonSha256(normalizedEvaluation(evidence.evaluation)), `V7 scripted-reference evaluation hash mismatch: ${row.evidencePath}`);
      invariant(canonicalJson(reportProjectionFromEvidence(evidence, row)) === canonicalJson(row), `V7 scripted-reference report row differs from its execution evidence: ${row.evidencePath}`);
      invariant(canonicalJson(evidence.goldBinding) === canonicalJson({
        goldImplementationSourceSha256: goldRow.implementationSourceSha256,
        goldExecutableSourceSha256: goldRow.executableSourceSha256,
        goldPackSha256: goldRow.packSha256,
        goldSealSha256: goldRow.sealSha256,
        goldResultsSha256: goldRow.resultsSha256,
        goldVerifierSeeds: goldRow.verifierSeeds,
        goldMinimumCore: goldRow.minimumCore,
        goldExactCount: goldRow.exactCount,
      }), `V7 scripted-reference gold binding changed: ${row.evidencePath}`);
      await validateArtifactInventory(destination, row, evidence);
      const workspace = path.join(auditRoot, `${String(index).padStart(2, '0')}-${row.implementationId}-${row.instanceId}-${row.variant}`);
      await implementation.materialize({ destination: workspace, pack: canonicalPack });
      invariant(await hashV7ExecutableTree(workspace) === row.executableSourceSha256, `V7 scripted-reference executable source no longer reproduces: ${row.evidencePath}`);
      evidenceCommitments.push({ evidencePath: row.evidencePath, evidenceFileSha256: row.evidenceFileSha256, evidenceSha256 });
      artifactCommitments.push({ evidencePath: row.evidencePath, verifierArtifactsSha256: row.verifierArtifactsSha256 });
    }
  } finally {
    await rm(auditRoot, { recursive: true, force: true });
  }
  const implementationSourcesSha256 = canonicalJsonSha256(Object.fromEntries(implementations.map(({ implementationId, sourceSha256 }) => [implementationId, sourceSha256])));
  const unsignedClosure = {
    schemaVersion: TERMINAL_V7_SCRIPTED_REFERENCE_CLOSURE_SCHEMA,
    reportSha256: report.reportSha256,
    sealManifestSha256: sealManifest.manifestSha256,
    goldReportSha256: goldReport.reportSha256,
    verifierImage: report.verifierImage,
    implementationSourcesSha256,
    rowEvidenceSha256: canonicalJsonSha256(evidenceCommitments),
    verifierArtifactsSha256: canonicalJsonSha256(artifactCommitments),
  };
  return { ...unsignedClosure, closureSha256: canonicalJsonSha256(unsignedClosure) };
}

async function ensureUnusedOutput(resultRoot) {
  const reportPath = path.join(resultRoot, 'control', 'scripted-reference-results.json');
  try {
    await lstat(reportPath);
    throw new Error('Refusing to overwrite existing V7 scripted-reference report');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const evidenceDirectory = path.join(resultRoot, 'control', 'scripted-reference-evidence');
  try {
    const entries = await readdir(evidenceDirectory);
    invariant(entries.length === 0, 'Refusing to merge V7 scripted-reference execution evidence');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  }
  return { reportPath, evidenceDirectory };
}

export async function runTerminalV7ScriptedReferences({
  root = ROOT,
  resultRoot,
  revision,
  sealManifest,
  goldReport,
  createdAt = new Date().toISOString(),
  inspectVerifier = inspectTerminalV7VerifierImage,
  runVerifier = verifyTerminalV7InContainer,
} = {}) {
  const repositoryRoot = safeAbsolute(root, 'V7 scripted-reference repository root');
  const destination = safeAbsolute(resultRoot, 'V7 scripted-reference result root');
  invariant(/^r[1-9]\d*$/.test(revision ?? ''), 'V7 scripted-reference revision must look like r1');
  invariant(typeof createdAt === 'string' && Number.isFinite(Date.parse(createdAt)), 'V7 scripted-reference timestamp is invalid');
  validateTerminalV7SealManifest(sealManifest);
  invariant(sealManifest.revision === revision, 'V7 scripted-reference seal manifest uses another revision');
  validateTerminalV7GoldReport(goldReport, { revision });
  const verifierSource = await terminalV7VerifierSourceDescriptor({ root: repositoryRoot });
  const verifierImage = await inspectVerifier({ expectedSourceSha256: verifierSource.sourceSha256, expectedImageId: goldReport.verifierImage.imageId });
  invariant(verifierImage.imageId === goldReport.verifierImage.imageId
    && verifierImage.sourceSha256 === goldReport.verifierImage.sourceSha256, 'V7 scripted-reference runner and gold gate verifier images differ');
  const implementations = await terminalV7ScriptedImplementationDescriptors({ root: repositoryRoot });
  invariant(canonicalJson(implementations) === canonicalJson(goldReport.implementations), 'V7 scripted-reference and gold implementation source descriptors differ');
  const descriptorById = new Map(implementations.map((implementation) => [implementation.implementationId, implementation]));
  const goldRows = goldRowsByKey(goldReport);
  const { reportPath } = await ensureUnusedOutput(destination);
  const temporaryRoot = await mkdtemp(path.join(await realpath(os.tmpdir()), 'agentbattler-v7-scripted-run-'));
  const rows = [];
  try {
    for (const implementation of IMPLEMENTATIONS) {
      for (const instanceId of V7_POOL_INSTANCES.dev) {
        for (const variant of VARIANTS) {
          const pack = sealV7Pack(loadV7Pack(instanceId, { variant }));
          const manifestTwin = sealManifest.packs.find((twin) => twin.pool === 'dev' && twin.instanceId === instanceId);
          invariant(manifestTwin?.[variant]?.packSha256 === pack.packSha256
            && manifestTwin[variant].sealSha256 === pack.sealSha256, `V7 scripted-reference pack differs from its preseal: ${instanceId}/${variant}`);
          const goldRow = goldRows.get(`${implementation.id}\0${instanceId}\0${variant}`);
          invariant(goldRow?.pool === 'dev' && goldRow.verifierSeeds === 100 && goldRow.minimumCore === 100
            && goldRow.exactCount === 100 && goldRow.infrastructureInvalid === 0, `V7 scripted-reference has no qualifying gold row: ${implementation.id}/${instanceId}/${variant}`);
          const workspace = path.join(temporaryRoot, `${implementation.id}-${instanceId}-${variant}`);
          const { contract, executableSourceSha256 } = await prepareWorkspace({ implementation, pack, destination: workspace });
          invariant(executableSourceSha256 === goldRow.executableSourceSha256, `V7 scripted-reference executable source differs from the gold gate: ${implementation.id}/${instanceId}/${variant}`);
          const verifierDirectory = path.join(destination, 'control', 'scripted-reference-evidence', 'verifier', implementation.id, instanceId, variant, 'seed-000');
          const evaluation = await runVerifier({
            mode: 'final',
            pack,
            workspace,
            evidenceDirectory: verifierDirectory,
            verifierSeedIndex: VERIFIER_SEED_INDEX,
            phaseContracts: { 4: contract },
            expectedSourceSha256: verifierImage.sourceSha256,
            expectedImageId: verifierImage.imageId,
          });
          validateEvaluation(evaluation, { instanceId, variant, label: `${implementation.id}/${instanceId}/${variant}` });
          const verifierArtifacts = await artifactRecords(destination, verifierDirectory);
          invariant(verifierArtifacts.length > 0, `V7 scripted-reference verifier emitted no artifacts: ${implementation.id}/${instanceId}/${variant}`);
          const unsignedEvidence = rowEvidenceUnsigned({
            revision,
            implementation,
            implementationSource: descriptorById.get(implementation.id),
            pack,
            executableSourceSha256,
            verifierImage,
            evaluation,
            verifierArtifacts,
            goldRow,
          });
          const evidence = { ...unsignedEvidence, evidenceSha256: canonicalJsonSha256(unsignedEvidence) };
          const evidencePath = path.posix.join('control', 'scripted-reference-evidence', 'rows', implementation.id, `${instanceId}-${variant}.json`);
          const evidenceFile = contained(destination, evidencePath, `V7 scripted-reference output ${instanceId}/${variant}`);
          await mkdir(path.dirname(evidenceFile), { recursive: true, mode: 0o700 });
          await writeFile(evidenceFile, `${canonicalJson(evidence, { space: 2 })}\n`, { mode: 0o600, flag: 'wx' });
          rows.push(reportRow(evidence, evidencePath, await sha256File(evidenceFile)));
        }
      }
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  const unsignedReport = {
    schemaVersion: TERMINAL_V7_SCRIPTED_REFERENCE_REPORT_SCHEMA,
    challengeId: 'terminal-mini-ledger-v7',
    revision,
    createdAt,
    sealManifestSha256: sealManifest.manifestSha256,
    goldReportSha256: goldReport.reportSha256,
    policy: {
      implementations: 2,
      developmentPacks: V7_POOL_INSTANCES.dev.length,
      variants: [...VARIANTS],
      verifierSeedIndex: VERIFIER_SEED_INDEX,
      verifierBoundary: 'sealed-linux-strace-container',
      reporting: 'aggregate-scores-and-commitments-only',
    },
    verifierImage: { imageId: verifierImage.imageId, sourceSha256: verifierImage.sourceSha256 },
    implementations,
    rows,
    summary: {
      rows: rows.length,
      independentImplementations: implementations.length,
      minimumCore: Math.min(...rows.map(({ corePoints }) => corePoints)),
      exactRows: rows.filter(({ exact }) => exact).length,
      infrastructureInvalid: rows.filter(({ status, validity }) => status !== 'completed' || validity !== 'valid').length,
      maximumAbsoluteTwinDifference: maximumTwinDifference(rows),
    },
    privacy: {
      aggregateOnly: true,
      privateSeedsIncluded: false,
      verifierCasesIncluded: false,
      promptsIncluded: false,
      sessionsIncluded: false,
      modelTextIncluded: false,
    },
  };
  const report = sealTerminalV7ScriptedReferenceReport(unsignedReport);
  validateTerminalV7ScriptedReferenceReport(report, {
    revision,
    sealManifestSha256: sealManifest.manifestSha256,
    goldReportSha256: goldReport.reportSha256,
    verifierImage,
  });
  await mkdir(path.dirname(reportPath), { recursive: true, mode: 0o700 });
  await writeFile(reportPath, `${canonicalJson(report, { space: 2 })}\n`, { mode: 0o600, flag: 'wx' });
  const closure = await assertTerminalV7ScriptedReferenceArtifacts({
    evidenceRoot: destination,
    root: repositoryRoot,
    report,
    sealManifest,
    goldReport,
    expectedVerifierImage: verifierImage,
  });
  return { report, closure, reportPath };
}
