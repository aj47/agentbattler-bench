import { access, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson, canonicalJsonSha256, sha256File } from './provenance.mjs';
import { terminalV7RetirementAction } from './terminal-v7-gates.mjs';
import { validateTerminalV7Challenge } from './terminal-v7.mjs';

export const TERMINAL_V7_RETIREMENT_SCHEMA = 'agentbattler.terminal-v7-retirement.v1';
export const TERMINAL_V7_FRONTIER_RESULT_SET_SCHEMA = 'agentbattler.terminal-v7-frontier-result-set.v1';
export const TERMINAL_V7_FRONTIER_ANALYSIS_SCHEMA = 'agentbattler.terminal-v7-frontier-analysis.v1';

const SHA256_RE = /^[0-9a-f]{64}$/;
const RELEASE_INSTANCE_IDS = Object.freeze(['release-01', 'release-02', 'release-03', 'release-04', 'release-05']);
const BOOTSTRAP_RESAMPLES = 10_000;
const MAX_SOURCE_ARTIFACT_BYTES = 1024 * 1024;
const FRONTIER_EVIDENCE_POLICY = Object.freeze({
  metricSource: 'artifact-bound-five-pack-result-commitments',
  analysis: 'locally-recomputed-deterministic-bootstrap',
  rawRunsLocallyReverified: false,
});

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function safeRelative(value, label) {
  invariant(typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !value.includes('\0'), `${label} path is invalid`);
  const normalized = path.posix.normalize(value.replaceAll(path.sep, '/'));
  invariant(normalized !== '..' && !normalized.startsWith('../'), `${label} path escapes its evidence root`);
  return normalized;
}

function safeId(value, label) {
  invariant(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value), `${label} is invalid`);
  return value;
}

function identityValue(value, label) {
  invariant(typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\0-\x1f\x7f]/.test(value), `${label} is invalid`);
  return value;
}

function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function quantile(sorted, probability) {
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
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

function normalizeArtifact(artifact, label) {
  const normalized = {
    path: safeRelative(artifact?.path, label),
    sizeBytes: artifact?.sizeBytes,
    sha256: artifact?.sha256,
  };
  invariant(Number.isSafeInteger(normalized.sizeBytes)
    && normalized.sizeBytes > 0
    && normalized.sizeBytes <= MAX_SOURCE_ARTIFACT_BYTES
    && SHA256_RE.test(normalized.sha256 ?? ''), `${label} descriptor is incomplete`);
  return normalized;
}

function normalizeLeakage(value) {
  if (value === null || value === undefined || value.detected === false) {
    return { detected: false, evidenceSha256: null, evidenceArtifact: null };
  }
  const evidenceArtifact = normalizeArtifact(value?.evidenceArtifact, 'V7 private-pack leakage evidence');
  invariant(value?.detected === true && value.evidenceSha256 === evidenceArtifact.sha256, 'V7 private-pack leakage requires artifact-bound sealed evidence');
  return { detected: true, evidenceSha256: value.evidenceSha256, evidenceArtifact };
}

function normalizeSystemIdentity(identity) {
  const normalized = {
    developerId: identityValue(identity?.developerId, 'V7 frontier developer ID'),
    providerId: identityValue(identity?.providerId, 'V7 frontier provider ID'),
    modelFamilyId: identityValue(identity?.modelFamilyId, 'V7 frontier model-family ID'),
    modelId: identityValue(identity?.modelId, 'V7 frontier model ID'),
    modelRevision: identityValue(identity?.modelRevision, 'V7 frontier model revision'),
    harnessId: identityValue(identity?.harnessId, 'V7 frontier harness ID'),
    harnessVersion: identityValue(identity?.harnessVersion, 'V7 frontier harness version'),
  };
  return {
    identity: normalized,
    systemIdentitySha256: canonicalJsonSha256(normalized),
    independenceKeySha256: canonicalJsonSha256({
      developerId: normalized.developerId,
      providerId: normalized.providerId,
      modelFamilyId: normalized.modelFamilyId,
    }),
  };
}

function normalizeReleaseIdentity(value) {
  const normalized = {
    benchmarkId: value?.benchmarkId,
    protocolRevision: value?.protocolRevision,
    challengeId: value?.challengeId,
    challengeSha256: value?.challengeSha256,
    rubricVersion: value?.rubricVersion,
    sealManifestSha256: value?.sealManifestSha256,
    verifierSha256: value?.verifierSha256,
    releasePackSetSha256: value?.releasePackSetSha256,
    hiddenMerkleRootsSha256: value?.hiddenMerkleRootsSha256,
  };
  invariant(normalized.benchmarkId === 'terminal-mini-ledger-v7', 'V7 frontier release identity names another benchmark');
  invariant(/^r[1-9]\d*$/.test(normalized.protocolRevision ?? ''), 'V7 frontier release identity revision is invalid');
  invariant(typeof normalized.challengeId === 'string' && normalized.challengeId.length > 0, 'V7 frontier release challenge ID is invalid');
  invariant(normalized.rubricVersion === `mini-ledger-v7-${normalized.protocolRevision}`, 'V7 frontier release rubric version is invalid');
  for (const [label, digest] of Object.entries({
    challenge: normalized.challengeSha256,
    sealManifest: normalized.sealManifestSha256,
    verifier: normalized.verifierSha256,
    releasePackSet: normalized.releasePackSetSha256,
    hiddenMerkleRoots: normalized.hiddenMerkleRootsSha256,
  })) invariant(SHA256_RE.test(digest ?? ''), `V7 frontier release ${label} commitment is invalid`);
  const releaseIdentitySha256 = canonicalJsonSha256(normalized);
  if (value?.releaseIdentitySha256 !== undefined) {
    invariant(value.releaseIdentitySha256 === releaseIdentitySha256, 'V7 frontier release identity seal is invalid');
  }
  return { ...normalized, releaseIdentitySha256 };
}

export function createTerminalV7FrontierReleaseIdentity({
  benchmarkId = 'terminal-mini-ledger-v7',
  protocolRevision,
  challengeId,
  challengeSha256,
  rubricVersion,
  sealManifestSha256,
  verifierSha256,
  releasePackSetSha256,
  hiddenMerkleRootsSha256,
} = {}) {
  return normalizeReleaseIdentity({
    benchmarkId,
    protocolRevision,
    challengeId,
    challengeSha256,
    rubricVersion,
    sealManifestSha256,
    verifierSha256,
    releasePackSetSha256,
    hiddenMerkleRootsSha256,
  });
}

export function terminalV7FrontierReleaseIdentityFromChallenge(challenge) {
  validateTerminalV7Challenge(challenge);
  invariant(challenge.execution?.commitments?.rubricVersion === `mini-ledger-v7-${challenge.protocolRevision}`, 'V7 official challenge has no current rubric commitment');
  invariant(SHA256_RE.test(challenge.execution.commitments.sealManifestSha256 ?? '')
    && SHA256_RE.test(challenge.execution.commitments.verifierSha256 ?? ''), 'V7 official challenge has incomplete release commitments');
  const hiddenMerkleRoots = challenge.execution.commitments.hiddenMerkleRoots;
  invariant(hiddenMerkleRoots && typeof hiddenMerkleRoots === 'object' && !Array.isArray(hiddenMerkleRoots), 'V7 official challenge has no hidden-root commitment set');
  const expectedHiddenMerkleRoots = Object.fromEntries(challenge.instances.map(({ instanceId, packCommitments }) => [
    instanceId,
    packCommitments.hiddenMerkleRoot,
  ]));
  invariant(canonicalJson(hiddenMerkleRoots) === canonicalJson(expectedHiddenMerkleRoots), 'V7 official challenge hidden-root commitments differ from its release packs');
  return createTerminalV7FrontierReleaseIdentity({
    protocolRevision: challenge.protocolRevision,
    challengeId: challenge.challengeId,
    challengeSha256: challenge.challengeSha256,
    rubricVersion: challenge.execution.commitments.rubricVersion,
    sealManifestSha256: challenge.execution.commitments.sealManifestSha256,
    verifierSha256: challenge.execution.commitments.verifierSha256,
    releasePackSetSha256: canonicalJsonSha256(challenge.instances.map(({ instanceId, instanceSha256, packCommitments }) => ({
      instanceId,
      instanceSha256,
      packCommitments,
    }))),
    hiddenMerkleRootsSha256: canonicalJsonSha256(hiddenMerkleRoots),
  });
}

function normalizeFrontierRuns(runs) {
  invariant(Array.isArray(runs) && runs.length === RELEASE_INSTANCE_IDS.length, 'V7 frontier result set requires exactly five release-pack runs');
  const normalized = runs.map((run) => {
    invariant(run?.status === 'completed' && run.validity === 'valid', 'V7 frontier result set contains a non-valid run');
    invariant(SHA256_RE.test(run.runKey ?? '') && SHA256_RE.test(run.resultSha256 ?? ''), 'V7 frontier run commitment is invalid');
    invariant(RELEASE_INSTANCE_IDS.includes(run.instanceId), 'V7 frontier result set contains a non-release pack');
    invariant(Number.isSafeInteger(run.corePoints) && run.corePoints >= 0 && run.corePoints <= 100, 'V7 frontier Core score is invalid');
    return {
      runKey: run.runKey,
      instanceId: run.instanceId,
      status: 'completed',
      validity: 'valid',
      corePoints: run.corePoints,
      resultSha256: run.resultSha256,
    };
  }).sort((left, right) => left.instanceId.localeCompare(right.instanceId));
  invariant(canonicalJson(normalized.map(({ instanceId }) => instanceId)) === canonicalJson(RELEASE_INSTANCE_IDS), 'V7 frontier result set must cover every release pack exactly once');
  invariant(new Set(normalized.map(({ runKey }) => runKey)).size === normalized.length, 'V7 frontier result set reuses a run key');
  invariant(new Set(normalized.map(({ resultSha256 }) => resultSha256)).size === normalized.length, 'V7 frontier result set reuses a result commitment');
  return normalized;
}

export function createTerminalV7FrontierResultSet({
  revision,
  systemId,
  systemIdentity,
  releaseIdentity,
  scheduleId,
  scheduleSha256,
  runs,
} = {}) {
  invariant(/^r[1-9]\d*$/.test(revision ?? ''), 'V7 frontier result-set revision must look like r1');
  const normalizedSystemId = safeId(systemId, 'V7 frontier system ID');
  const identity = normalizeSystemIdentity(systemIdentity);
  const release = normalizeReleaseIdentity(releaseIdentity);
  invariant(release.protocolRevision === revision, 'V7 frontier result set uses another release revision');
  identityValue(scheduleId, 'V7 frontier schedule ID');
  invariant(SHA256_RE.test(scheduleSha256 ?? ''), 'V7 frontier schedule commitment is invalid');
  const unsigned = {
    schemaVersion: TERMINAL_V7_FRONTIER_RESULT_SET_SCHEMA,
    revision,
    systemId: normalizedSystemId,
    systemIdentity: identity.identity,
    systemIdentitySha256: identity.systemIdentitySha256,
    independenceKeySha256: identity.independenceKeySha256,
    releaseIdentity: release,
    challenge: { id: release.challengeId, sha256: release.challengeSha256 },
    schedule: { id: scheduleId, sha256: scheduleSha256 },
    pool: 'release',
    evidencePolicy: FRONTIER_EVIDENCE_POLICY,
    runs: normalizeFrontierRuns(runs),
  };
  return { ...unsigned, resultSetSha256: canonicalJsonSha256(unsigned) };
}

export function validateTerminalV7FrontierResultSet(resultSet, { revision = null } = {}) {
  invariant(resultSet?.schemaVersion === TERMINAL_V7_FRONTIER_RESULT_SET_SCHEMA, 'Unsupported V7 frontier result-set schema');
  const rebuilt = createTerminalV7FrontierResultSet({
    revision: resultSet.revision,
    systemId: resultSet.systemId,
    systemIdentity: resultSet.systemIdentity,
    releaseIdentity: resultSet.releaseIdentity,
    scheduleId: resultSet.schedule?.id,
    scheduleSha256: resultSet.schedule?.sha256,
    runs: resultSet.runs,
  });
  invariant(canonicalJson(rebuilt) === canonicalJson(resultSet), 'V7 frontier result-set seal or normalized content is invalid');
  if (revision !== null) invariant(resultSet.revision === revision, 'V7 frontier result set uses another revision');
  return resultSet;
}

export function recomputeTerminalV7FrontierMetrics(resultSet) {
  validateTerminalV7FrontierResultSet(resultSet);
  const scores = resultSet.runs.map(({ corePoints }) => corePoints);
  const meanCore = round(scores.reduce((sum, score) => sum + score, 0) / scores.length);
  const seed = Number.parseInt(canonicalJsonSha256({
    revision: resultSet.revision,
    resultSetSha256: resultSet.resultSetSha256,
    systemIdentitySha256: resultSet.systemIdentitySha256,
    method: 'pack-cluster-bootstrap-percentile',
  }).slice(0, 8), 16) >>> 0;
  const random = mulberry32(seed);
  const distribution = new Array(BOOTSTRAP_RESAMPLES);
  for (let sample = 0; sample < distribution.length; sample += 1) {
    let total = 0;
    for (let draw = 0; draw < scores.length; draw += 1) total += scores[Math.floor(random() * scores.length)];
    distribution[sample] = total / scores.length;
  }
  distribution.sort((left, right) => left - right);
  const confidenceInterval95 = {
    low: round(quantile(distribution, 0.025)),
    high: round(quantile(distribution, 0.975)),
  };
  return {
    meanCore,
    lowerConfidenceBound: confidenceInterval95.low,
    confidenceInterval95,
    bootstrap: {
      method: 'pack-cluster-bootstrap-percentile',
      clusterUnit: 'sealed-release-instance-pack',
      clusters: RELEASE_INSTANCE_IDS.length,
      resamples: BOOTSTRAP_RESAMPLES,
      confidenceLevel: 0.95,
      seed,
    },
  };
}

export function createTerminalV7FrontierAnalysis({
  resultSet,
  analystId,
  analysisCodeSha256,
  createdAt,
} = {}) {
  validateTerminalV7FrontierResultSet(resultSet);
  invariant(typeof createdAt === 'string' && Number.isFinite(Date.parse(createdAt)), 'V7 frontier analysis timestamp is invalid');
  const analyst = {
    id: safeId(analystId, 'V7 frontier analyst ID'),
    codeSha256: analysisCodeSha256,
  };
  invariant(SHA256_RE.test(analyst.codeSha256 ?? ''), 'V7 frontier analysis-code commitment is invalid');
  const metrics = recomputeTerminalV7FrontierMetrics(resultSet);
  const unsigned = {
    schemaVersion: TERMINAL_V7_FRONTIER_ANALYSIS_SCHEMA,
    revision: resultSet.revision,
    systemId: resultSet.systemId,
    systemIdentitySha256: resultSet.systemIdentitySha256,
    independenceKeySha256: resultSet.independenceKeySha256,
    resultSetSha256: resultSet.resultSetSha256,
    metric: 'Core',
    createdAt,
    analyst,
    ...metrics,
  };
  return { ...unsigned, analysisSha256: canonicalJsonSha256(unsigned) };
}

export function validateTerminalV7FrontierAnalysis(analysis, { resultSet } = {}) {
  invariant(analysis?.schemaVersion === TERMINAL_V7_FRONTIER_ANALYSIS_SCHEMA, 'Unsupported V7 frontier analysis schema');
  validateTerminalV7FrontierResultSet(resultSet);
  const rebuilt = createTerminalV7FrontierAnalysis({
    resultSet,
    analystId: analysis.analyst?.id,
    analysisCodeSha256: analysis.analyst?.codeSha256,
    createdAt: analysis.createdAt,
  });
  invariant(canonicalJson(rebuilt) === canonicalJson(analysis), 'V7 frontier analysis differs from deterministic recomputation');
  return analysis;
}

function projectionFromEvidence(system) {
  const resultSet = validateTerminalV7FrontierResultSet(system?.resultSet);
  const analysis = validateTerminalV7FrontierAnalysis(system?.analysis, { resultSet });
  if (system.systemId !== undefined) invariant(system.systemId === resultSet.systemId, 'V7 frontier evidence system ID differs from its result set');
  return {
    systemId: resultSet.systemId,
    releaseIdentity: resultSet.releaseIdentity,
    releaseIdentitySha256: resultSet.releaseIdentity.releaseIdentitySha256,
    systemIdentity: resultSet.systemIdentity,
    systemIdentitySha256: resultSet.systemIdentitySha256,
    independenceKeySha256: resultSet.independenceKeySha256,
    meanCore: analysis.meanCore,
    lowerConfidenceBound: analysis.lowerConfidenceBound,
    confidenceInterval95: analysis.confidenceInterval95,
    resultCount: resultSet.runs.length,
    resultSetSha256: resultSet.resultSetSha256,
    analysisSha256: analysis.analysisSha256,
    resultSetArtifact: normalizeArtifact(system.resultSetArtifact, `V7 ${resultSet.systemId} result-set evidence`),
    analysisArtifact: normalizeArtifact(system.analysisArtifact, `V7 ${resultSet.systemId} analysis evidence`),
  };
}

function normalizeRecordedSystem(system) {
  const systemId = safeId(system?.systemId, 'V7 frontier system ID');
  const releaseIdentity = normalizeReleaseIdentity(system.releaseIdentity);
  invariant(system.releaseIdentitySha256 === releaseIdentity.releaseIdentitySha256, `V7 ${systemId} release identity binding is invalid`);
  const identity = normalizeSystemIdentity(system.systemIdentity);
  invariant(system.systemIdentitySha256 === identity.systemIdentitySha256
    && system.independenceKeySha256 === identity.independenceKeySha256, `V7 ${systemId} system identity binding is invalid`);
  invariant(Number.isFinite(system.meanCore) && system.meanCore >= 0 && system.meanCore <= 100, `V7 ${systemId} mean Core is invalid`);
  invariant(Number.isFinite(system.lowerConfidenceBound) && system.lowerConfidenceBound >= 0 && system.lowerConfidenceBound <= 100, `V7 ${systemId} lower confidence bound is invalid`);
  invariant(Number.isFinite(system.confidenceInterval95?.low)
    && Number.isFinite(system.confidenceInterval95?.high)
    && system.confidenceInterval95.low === system.lowerConfidenceBound
    && system.confidenceInterval95.low <= system.confidenceInterval95.high, `V7 ${systemId} confidence interval is invalid`);
  invariant(system.resultCount === RELEASE_INSTANCE_IDS.length, `V7 ${systemId} result count changed`);
  invariant(SHA256_RE.test(system.resultSetSha256 ?? '') && SHA256_RE.test(system.analysisSha256 ?? ''), `V7 ${systemId} evidence seal is invalid`);
  return {
    systemId,
    releaseIdentity,
    releaseIdentitySha256: releaseIdentity.releaseIdentitySha256,
    systemIdentity: identity.identity,
    systemIdentitySha256: identity.systemIdentitySha256,
    independenceKeySha256: identity.independenceKeySha256,
    meanCore: system.meanCore,
    lowerConfidenceBound: system.lowerConfidenceBound,
    confidenceInterval95: { low: system.confidenceInterval95.low, high: system.confidenceInterval95.high },
    resultCount: system.resultCount,
    resultSetSha256: system.resultSetSha256,
    analysisSha256: system.analysisSha256,
    resultSetArtifact: normalizeArtifact(system.resultSetArtifact, `V7 ${systemId} result-set evidence`),
    analysisArtifact: normalizeArtifact(system.analysisArtifact, `V7 ${systemId} analysis evidence`),
  };
}

function assertIndependentSystems(systems) {
  invariant(new Set(systems.map(({ systemId }) => systemId)).size === systems.length, 'V7 frontier retirement system IDs must be unique');
  invariant(new Set(systems.map(({ independenceKeySha256 }) => independenceKeySha256)).size === systems.length, 'V7 frontier retirement systems are not independent model families');
  invariant(new Set(systems.map(({ releaseIdentitySha256 }) => releaseIdentitySha256)).size <= 1, 'V7 frontier retirement systems use different authoritative release identities');
  return systems;
}

function normalizeEvidenceSystems(frontierSystems) {
  invariant(Array.isArray(frontierSystems), 'V7 frontier retirement systems must be an array');
  return assertIndependentSystems(frontierSystems.map(projectionFromEvidence)
    .sort((left, right) => left.systemId.localeCompare(right.systemId)));
}

function normalizeRecordedSystems(frontierSystems) {
  invariant(Array.isArray(frontierSystems), 'V7 frontier retirement systems must be an array');
  return assertIndependentSystems(frontierSystems.map(normalizeRecordedSystem)
    .sort((left, right) => left.systemId.localeCompare(right.systemId)));
}

function sourceArtifacts(leakage, systems) {
  const artifacts = [];
  if (leakage.detected) artifacts.push({ kind: 'private-pack-leakage', ...leakage.evidenceArtifact });
  for (const system of systems) {
    artifacts.push({ kind: 'frontier-result-set', systemId: system.systemId, ...system.resultSetArtifact });
    artifacts.push({ kind: 'frontier-analysis', systemId: system.systemId, ...system.analysisArtifact });
  }
  artifacts.sort((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind));
  invariant(new Set(artifacts.map(({ path: artifactPath }) => artifactPath)).size === artifacts.length, 'V7 retirement source artifact path is reused');
  return artifacts;
}

export function createTerminalV7RetirementRecord({
  revision,
  detectedAt,
  privatePackLeakage = null,
  frontierSystems = [],
} = {}) {
  invariant(/^r[1-9]\d*$/.test(revision ?? ''), 'V7 retirement revision must look like r1');
  invariant(typeof detectedAt === 'string' && Number.isFinite(Date.parse(detectedAt)), 'V7 retirement timestamp is invalid');
  const leakage = normalizeLeakage(privatePackLeakage);
  const systems = normalizeEvidenceSystems(frontierSystems);
  const artifacts = sourceArtifacts(leakage, systems);
  const action = terminalV7RetirementAction({ privatePackLeakage: leakage.detected, frontierSystems: systems });
  invariant(action.retire === true, 'V7 retirement evidence does not meet a retirement threshold');
  const unsigned = {
    schemaVersion: TERMINAL_V7_RETIREMENT_SCHEMA,
    revision,
    detectedAt,
    privatePackLeakage: leakage,
    frontierEvidencePolicy: FRONTIER_EVIDENCE_POLICY,
    frontierSystems: systems,
    sourceArtifactsSha256: canonicalJsonSha256(artifacts),
    action,
  };
  return { ...unsigned, recordSha256: canonicalJsonSha256(unsigned) };
}

export function validateTerminalV7RetirementRecord(record, { revision = null } = {}) {
  invariant(record?.schemaVersion === TERMINAL_V7_RETIREMENT_SCHEMA, 'Unsupported V7 retirement schema');
  const { recordSha256, ...unsigned } = record;
  invariant(SHA256_RE.test(recordSha256 ?? '') && recordSha256 === canonicalJsonSha256(unsigned), 'V7 retirement record hash mismatch');
  invariant(/^r[1-9]\d*$/.test(record.revision ?? ''), 'V7 retirement revision must look like r1');
  invariant(typeof record.detectedAt === 'string' && Number.isFinite(Date.parse(record.detectedAt)), 'V7 retirement timestamp is invalid');
  const leakage = normalizeLeakage(record.privatePackLeakage);
  const systems = normalizeRecordedSystems(record.frontierSystems);
  const artifacts = sourceArtifacts(leakage, systems);
  const action = terminalV7RetirementAction({ privatePackLeakage: leakage.detected, frontierSystems: systems });
  invariant(action.retire === true, 'V7 retirement evidence does not meet a retirement threshold');
  const expectedUnsigned = {
    schemaVersion: TERMINAL_V7_RETIREMENT_SCHEMA,
    revision: record.revision,
    detectedAt: record.detectedAt,
    privatePackLeakage: leakage,
    frontierEvidencePolicy: FRONTIER_EVIDENCE_POLICY,
    frontierSystems: systems,
    sourceArtifactsSha256: canonicalJsonSha256(artifacts),
    action,
  };
  invariant(canonicalJson(expectedUnsigned) === canonicalJson(unsigned), 'V7 retirement decision differs from its normalized evidence');
  if (revision !== null) invariant(record.revision === revision, 'V7 retirement record uses another revision');
  return record;
}

function artifactFile(evidenceRoot, artifact) {
  const file = path.resolve(evidenceRoot, ...artifact.path.split('/'));
  const relation = path.relative(evidenceRoot, file);
  invariant(relation && relation !== '..' && !relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation), `V7 retirement source artifact escaped its root: ${artifact.path}`);
  return file;
}

export async function assertTerminalV7RetirementSourceArtifacts({ evidenceRoot, record } = {}) {
  invariant(typeof evidenceRoot === 'string' && path.isAbsolute(evidenceRoot), 'V7 retirement evidence root must be absolute');
  validateTerminalV7RetirementRecord(record);
  const leakage = normalizeLeakage(record.privatePackLeakage);
  const systems = normalizeRecordedSystems(record.frontierSystems);
  const artifacts = sourceArtifacts(leakage, systems);
  invariant(record.sourceArtifactsSha256 === canonicalJsonSha256(artifacts), 'V7 retirement source artifact set hash mismatch');
  for (const artifact of artifacts) {
    const file = artifactFile(evidenceRoot, artifact);
    const stat = await lstat(file);
    invariant(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, `V7 retirement source artifact is not one regular file: ${artifact.path}`);
    invariant(stat.size === artifact.sizeBytes && await sha256File(file) === artifact.sha256, `V7 retirement source artifact bytes changed: ${artifact.path}`);
  }
  const recomputedSystems = [];
  for (const system of systems) {
    let resultSet;
    let analysis;
    try {
      resultSet = JSON.parse(await readFile(artifactFile(evidenceRoot, system.resultSetArtifact), 'utf8'));
      analysis = JSON.parse(await readFile(artifactFile(evidenceRoot, system.analysisArtifact), 'utf8'));
    } catch (error) {
      throw new Error(`V7 ${system.systemId} frontier evidence is not valid JSON: ${error.message}`);
    }
    recomputedSystems.push(projectionFromEvidence({
      systemId: system.systemId,
      resultSet,
      analysis,
      resultSetArtifact: system.resultSetArtifact,
      analysisArtifact: system.analysisArtifact,
    }));
  }
  const normalizedRecomputed = assertIndependentSystems(recomputedSystems.sort((left, right) => left.systemId.localeCompare(right.systemId)));
  invariant(canonicalJson(normalizedRecomputed) === canonicalJson(systems), 'V7 retirement metrics differ from artifact-bound deterministic evidence');
  return { artifacts, sourceArtifactsSha256: record.sourceArtifactsSha256, frontierSystems: normalizedRecomputed };
}

export async function readTerminalV7RetirementRecord({ resultRoot, revision } = {}) {
  invariant(typeof resultRoot === 'string' && path.isAbsolute(resultRoot), 'V7 retirement result root must be absolute');
  const file = path.join(resultRoot, 'retirement.json');
  try { await access(file); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const stat = await lstat(file);
  invariant(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'V7 retirement record must be one regular file');
  const record = validateTerminalV7RetirementRecord(JSON.parse(await readFile(file, 'utf8')), { revision });
  await assertTerminalV7RetirementSourceArtifacts({ evidenceRoot: resultRoot, record });
  return record;
}

export async function writeTerminalV7RetirementRecord({ resultRoot, record } = {}) {
  invariant(typeof resultRoot === 'string' && path.isAbsolute(resultRoot), 'V7 retirement result root must be absolute');
  validateTerminalV7RetirementRecord(record);
  await assertTerminalV7RetirementSourceArtifacts({ evidenceRoot: resultRoot, record });
  await mkdir(resultRoot, { recursive: true, mode: 0o700 });
  await writeFile(path.join(resultRoot, 'retirement.json'), `${canonicalJson(record, { space: 2 })}\n`, { mode: 0o600, flag: 'wx' });
  return record;
}
