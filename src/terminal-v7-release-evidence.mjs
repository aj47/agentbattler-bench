import { V7_POOL_INSTANCES } from '../benchmark/challenges/mini-ledger-v7/pack.mjs';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { validateTerminalV7GoldReport } from '../scripts/validate-terminal-v7-golds.mjs';
import { canonicalJson, canonicalJsonSha256, sha256File } from './provenance.mjs';
import { TERMINAL_V7_REVIEW_TOPICS } from './terminal-v7-gates.mjs';
import {
  assertTerminalV7QualityEvidence,
  terminalV7QualityGateContribution,
} from './terminal-v7-quality-gates.mjs';
import {
  assertTerminalV7RequirementMap,
  requirementMapGateEvidence,
} from './terminal-v7-requirement-map.mjs';
import {
  createTerminalV7ReviewSet,
  reviewGateEvidence,
  validateTerminalV7Review,
} from './terminal-v7-review.mjs';
import { validateTerminalV7SealManifest } from './terminal-v7-seals.mjs';
import { validateTerminalV7ScriptedReferenceReport } from './terminal-v7-scripted-references.mjs';
import { validateTerminalV7ExecutionHost } from './terminal-v7-execution-identity.mjs';

export const TERMINAL_V7_TEST_REPORT_SCHEMA = 'agentbattler.terminal-v7-test-preflight-report.v2';
export const TERMINAL_V7_BASE_GATE_SCHEMA = 'agentbattler.terminal-v7-base-gate-evidence.v2';
export const TERMINAL_V7_RELEASE_GATE_EVIDENCE_SCHEMA = 'agentbattler.terminal-v7-release-gate-evidence.v2';

const SHA256_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const EXPECTED_HARNESSES = Object.freeze([
  'claude-code',
  'codex-cli',
  'dotagents-mono',
  'factory-droid',
  'pi-coding-agent',
]);
const EXPECTED_CONTROL_ENFORCEMENT = Object.freeze({
  'claude-code': 'root-owned-read-only',
  'codex-cli': 'root-owned-read-only',
  'dotagents-mono': 'sandbox-remounted-read-only',
  'factory-droid': 'os-sandbox-enforced-read-only',
  'pi-coding-agent': 'root-owned-read-only',
});

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function hash(value, label) {
  invariant(SHA256_RE.test(value ?? ''), `${label} must be a SHA-256 digest`);
  return value;
}

function sameMembers(left, right) {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function safeRelative(value, label) {
  invariant(typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !value.includes('\0'), `${label} path is invalid`);
  const normalized = path.posix.normalize(value.replaceAll(path.sep, '/'));
  invariant(normalized !== '..' && !normalized.startsWith('../'), `${label} path escapes its evidence root`);
  return normalized;
}

export function sealTerminalV7TestReport(unsigned) {
  invariant(unsigned?.schemaVersion === TERMINAL_V7_TEST_REPORT_SCHEMA, 'V7 test report schema is invalid');
  return { ...unsigned, reportSha256: canonicalJsonSha256(unsigned) };
}

export function validateTerminalV7TestReport(report, {
  revision = null,
  reviewedCommit = null,
  verifierImage = null,
} = {}) {
  invariant(report?.schemaVersion === TERMINAL_V7_TEST_REPORT_SCHEMA, 'Unsupported V7 test-report schema');
  const { reportSha256, ...unsigned } = report;
  invariant(reportSha256 === canonicalJsonSha256(unsigned), 'V7 test-report hash mismatch');
  invariant(/^r[1-9]\d*$/.test(report.revision ?? ''), 'V7 test-report revision is invalid');
  invariant(COMMIT_RE.test(report.reviewedCommit ?? ''), 'V7 test-report commit is invalid');
  invariant(typeof report.createdAt === 'string' && Number.isFinite(Date.parse(report.createdAt)), 'V7 test-report timestamp is invalid');
  if (revision !== null) invariant(report.revision === revision, 'V7 test report uses another revision');
  if (reviewedCommit !== null) invariant(report.reviewedCommit === reviewedCommit, 'V7 test report uses another commit');
  validateTerminalV7ExecutionHost(report.host);
  for (const [name, suite] of Object.entries({ existing: report.suites?.existing, v7: report.suites?.v7 })) {
    invariant(suite?.passed === true
      && Number.isSafeInteger(suite.tests)
      && suite.tests > 0
      && suite.failures === 0
      && SHA256_RE.test(suite.logSha256 ?? ''), `V7 ${name} test suite did not pass with sealed evidence`);
    safeRelative(suite.logPath, `V7 ${name} test log`);
  }
  invariant(/^sha256:[0-9a-f]{64}$/.test(verifierImage?.imageId ?? '')
    && SHA256_RE.test(verifierImage?.sourceSha256 ?? ''), 'Expected V7 verifier image identity is invalid');
  invariant(report.verifierImage?.imageId === verifierImage?.imageId
    && report.verifierImage?.sourceSha256 === verifierImage?.sourceSha256, 'V7 test report used another verifier image');
  invariant(Array.isArray(report.preflights) && report.preflights.length === EXPECTED_HARNESSES.length, 'V7 test report must contain five harness preflights');
  invariant(sameMembers(report.preflights.map(({ harnessId }) => harnessId), EXPECTED_HARNESSES), 'V7 test report harness set changed');
  const policyHashes = new Set();
  for (const preflight of report.preflights) {
    invariant(preflight.passed === true && preflight.exactReleasePolicy === true, `V7 ${preflight.harnessId} preflight did not pass the exact release policy`);
    hash(preflight.resourcePolicySha256, `V7 ${preflight.harnessId} resource-policy commitment`);
    hash(preflight.sandboxPolicySha256, `V7 ${preflight.harnessId} sandbox-policy commitment`);
    invariant(preflight.executionHostSha256 === report.host.identitySha256, `V7 ${preflight.harnessId} preflight used another execution host`);
    hash(preflight.evidenceSha256, `V7 ${preflight.harnessId} preflight evidence`);
    safeRelative(preflight.evidencePath, `V7 ${preflight.harnessId} preflight evidence`);
    invariant(preflight.modelCommandCapabilities === 'exactly-zero'
      && preflight.network === 'denied'
      && preflight.outOfWorkspace === 'denied'
      && preflight.controlDirectory === 'trusted-read-only'
      && preflight.controlEnforcement === EXPECTED_CONTROL_ENFORCEMENT[preflight.harnessId], `V7 ${preflight.harnessId} preflight isolation changed`);
    policyHashes.add(`${preflight.resourcePolicySha256}\0${preflight.sandboxPolicySha256}`);
  }
  invariant(policyHashes.size === 1, 'V7 harness preflights did not use one exact release policy');
  invariant(report.failures === 0 && report.passed === true, 'V7 test/preflight report is not qualifying');
  return report;
}

export async function assertTerminalV7TestReportArtifacts({ evidenceRoot, report } = {}) {
  validateTerminalV7TestReport(report, { verifierImage: report?.verifierImage });
  invariant(typeof evidenceRoot === 'string' && path.isAbsolute(evidenceRoot), 'V7 test evidence root must be absolute');
  const root = path.resolve(evidenceRoot);
  for (const [name, suite] of Object.entries(report.suites)) {
    const file = path.resolve(root, safeRelative(suite.logPath, `V7 ${name} test log`));
    const relation = path.relative(root, file);
    invariant(relation && relation !== '..' && !relation.startsWith(`..${path.sep}`), `V7 ${name} test log escaped its evidence root`);
    const stat = await lstat(file);
    invariant(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, `V7 ${name} test log is not one regular file`);
    invariant(await sha256File(file) === suite.logSha256, `V7 ${name} test log hash mismatch`);
  }
  for (const projection of report.preflights) {
    const file = path.resolve(root, safeRelative(projection.evidencePath, `V7 ${projection.harnessId} preflight evidence`));
    const relation = path.relative(root, file);
    invariant(relation && relation !== '..' && !relation.startsWith(`..${path.sep}`), `V7 ${projection.harnessId} preflight evidence escaped its root`);
    const stat = await lstat(file);
    invariant(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, `V7 ${projection.harnessId} preflight evidence is not one regular file`);
    const evidence = JSON.parse(await readFile(file, 'utf8'));
    invariant(canonicalJsonSha256(evidence) === projection.evidenceSha256, `V7 ${projection.harnessId} preflight evidence hash mismatch`);
    invariant(canonicalJson(evidence.host) === canonicalJson(report.host), `V7 ${projection.harnessId} preflight host binding changed`);
    invariant(projection.executionHostSha256 === evidence.host.identitySha256, `V7 ${projection.harnessId} preflight host commitment changed`);
    for (const field of ['harnessId', 'passed', 'exactReleasePolicy', 'resourcePolicySha256', 'sandboxPolicySha256', 'modelCommandCapabilities', 'network', 'outOfWorkspace', 'controlDirectory', 'controlEnforcement']) {
      invariant(canonicalJson(evidence[field]) === canonicalJson(projection[field]), `V7 ${projection.harnessId} preflight ${field} projection changed`);
    }
  }
  return report;
}

function packGateRows(sealManifest) {
  return sealManifest.packs.map((pack) => ({
    instanceId: pack.instanceId,
    pool: pack.pool,
    sealSha256: pack.decoy.sealSha256,
    sealedBeforePilot: sealManifest.policy.createdBeforeFrontierPilotResults === true,
  }));
}

function validateReviewInputs(reviews, options) {
  invariant(Array.isArray(reviews) && reviews.length === 3, 'V7 release evidence requires three review records');
  return reviews.map((review) => validateTerminalV7Review(review, options));
}

export function assembleTerminalV7BaseGateEvidence({
  revision,
  evaluatedAt,
  reviewedCommit,
  seedKey,
  sealManifest,
  goldReport,
  goldArtifacts,
  scriptedReferences,
  scriptedReferenceArtifacts,
  qualityEvidence,
  requirementMap,
  reviews,
  testReport,
} = {}) {
  invariant(/^r[1-9]\d*$/.test(revision ?? ''), 'V7 base-gate revision is invalid');
  invariant(typeof evaluatedAt === 'string' && Number.isFinite(Date.parse(evaluatedAt)), 'V7 base-gate timestamp is invalid');
  invariant(COMMIT_RE.test(reviewedCommit ?? ''), 'V7 base-gate commit is invalid');
  validateTerminalV7SealManifest(sealManifest, { seedKey });
  invariant(sealManifest.revision === revision, 'V7 seal manifest uses another revision');
  const gold = validateTerminalV7GoldReport(goldReport, { revision });
  invariant(goldArtifacts?.reportSha256 === gold.reportSha256
    && SHA256_RE.test(goldArtifacts?.rowEvidenceSha256 ?? '')
    && Object.keys(goldArtifacts?.implementationSourceSha256 ?? {}).sort().join(',') === 'implementation-a,implementation-b'
    && Object.values(goldArtifacts.implementationSourceSha256).every((value) => SHA256_RE.test(value)), 'V7 gold artifact closure is incomplete');
  const goldImplementationSourcesSha256 = canonicalJsonSha256(goldArtifacts.implementationSourceSha256);
  const references = validateTerminalV7ScriptedReferenceReport(scriptedReferences, {
    revision,
    sealManifestSha256: sealManifest.manifestSha256,
    goldReportSha256: gold.reportSha256,
    verifierImage: gold.verifierImage,
  });
  const { closureSha256: scriptedClosureSha256, ...unsignedScriptedClosure } = scriptedReferenceArtifacts ?? {};
  invariant(scriptedReferenceArtifacts?.schemaVersion === 'agentbattler.terminal-v7-scripted-reference-artifact-closure.v1'
    && scriptedReferenceArtifacts.reportSha256 === references.reportSha256
    && scriptedReferenceArtifacts.sealManifestSha256 === sealManifest.manifestSha256
    && scriptedReferenceArtifacts.goldReportSha256 === gold.reportSha256
    && scriptedReferenceArtifacts.verifierImage?.imageId === gold.verifierImage.imageId
    && scriptedReferenceArtifacts.verifierImage?.sourceSha256 === gold.verifierImage.sourceSha256
    && scriptedReferenceArtifacts.implementationSourcesSha256 === goldImplementationSourcesSha256
    && SHA256_RE.test(scriptedReferenceArtifacts.rowEvidenceSha256 ?? '')
    && SHA256_RE.test(scriptedReferenceArtifacts.verifierArtifactsSha256 ?? '')
    && SHA256_RE.test(scriptedClosureSha256 ?? '')
    && scriptedClosureSha256 === canonicalJsonSha256(unsignedScriptedClosure), 'V7 scripted-reference artifact closure is incomplete');
  const quality = terminalV7QualityGateContribution(assertTerminalV7QualityEvidence(qualityEvidence, { requireFull: true }));
  invariant(gold.verifierImage.imageId === qualityEvidence.verifier.imageId
    && gold.verifierImage.sourceSha256 === qualityEvidence.verifier.sourceSha256, 'V7 gold and quality gates used different verifier images');
  const expectedQualityPackSeals = sealManifest.packs.flatMap((entry) => ['clean', 'decoy'].map((variant) => ({
    instanceId: entry.instanceId,
    variant,
    sealSha256: entry[variant].sealSha256,
  }))).sort((left, right) => left.instanceId.localeCompare(right.instanceId) || left.variant.localeCompare(right.variant));
  invariant(qualityEvidence.provenance?.protocolRevision === revision
    && qualityEvidence.provenance.reviewedCommit === reviewedCommit
    && qualityEvidence.provenance.sealManifestSha256 === sealManifest.manifestSha256
    && qualityEvidence.provenance.goldReportSha256 === gold.reportSha256
    && canonicalJson(qualityEvidence.provenance.goldImplementationSourceSha256) === canonicalJson(goldArtifacts.implementationSourceSha256)
    && canonicalJson(qualityEvidence.provenance.packSeals) === canonicalJson(expectedQualityPackSeals)
    && qualityEvidence.provenance.packSealsSha256 === canonicalJsonSha256(expectedQualityPackSeals), 'V7 quality gates are not bound to the reviewed revision, exact pack seals, and current gold sources');
  const requirementAudit = assertTerminalV7RequirementMap(requirementMap);
  const reviewOptions = {
    revision,
    reviewedCommit,
    sealManifestSha256: sealManifest.manifestSha256,
    requirementMapSha256: requirementAudit.requirementMapSha256,
  };
  const validatedReviews = validateReviewInputs(reviews, reviewOptions);
  const reviewSet = createTerminalV7ReviewSet({ ...reviewOptions, reviews: validatedReviews });
  const reviewArtifactSetsSha256 = canonicalJsonSha256(validatedReviews.map(({ reviewerId, reviewerIdentitySha256, artifactsSha256 }) => ({
    reviewerId,
    reviewerIdentitySha256,
    artifactsSha256,
  })).sort((left, right) => left.reviewerId.localeCompare(right.reviewerId)));
  validateTerminalV7TestReport(testReport, {
    revision,
    reviewedCommit,
    verifierImage: gold.verifierImage,
  });
  invariant(sealManifest.packs.length === Object.values(V7_POOL_INSTANCES).flat().length, 'V7 base gate pack set is incomplete');

  const unsigned = {
    schemaVersion: TERMINAL_V7_BASE_GATE_SCHEMA,
    revision,
    evaluatedAt,
    reviewedCommit,
    executionHost: structuredClone(testReport.host),
    sourceArtifacts: {
      sealManifestSha256: sealManifest.manifestSha256,
      goldReportSha256: gold.reportSha256,
      goldRowEvidenceSha256: goldArtifacts.rowEvidenceSha256,
      goldImplementationSourcesSha256,
      scriptedReferenceReportSha256: references.reportSha256,
      scriptedReferenceClosureSha256: scriptedReferenceArtifacts.closureSha256,
      scriptedReferenceRowEvidenceSha256: scriptedReferenceArtifacts.rowEvidenceSha256,
      scriptedReferenceVerifierArtifactsSha256: scriptedReferenceArtifacts.verifierArtifactsSha256,
      qualityEvidenceSha256: quality.evidenceSha256,
      qualityArtifactTreeSha256: qualityEvidence.artifactRoot.treeSha256,
      qualityPackSealsSha256: qualityEvidence.provenance.packSealsSha256,
      requirementMapSha256: requirementAudit.requirementMapSha256,
      requirementMapAuditSha256: requirementAudit.auditSha256,
      reviewSetSha256: reviewSet.reviewSetSha256,
      reviewArtifactSetsSha256,
      testReportSha256: testReport.reportSha256,
      verifierImageId: gold.verifierImage.imageId,
      verifierSourceSha256: gold.verifierImage.sourceSha256,
    },
    packSeals: packGateRows(sealManifest),
    gold: {
      independentImplementations: gold.summary.independentImplementations,
      verifierSeeds: gold.summary.verifierSeeds,
      cleanMinCore: gold.summary.cleanMinCore,
      decoyMinCore: gold.summary.decoyMinCore,
      goldReportSha256: gold.reportSha256,
      rowEvidenceSha256: goldArtifacts.rowEvidenceSha256,
      implementationSourcesSha256: goldImplementationSourcesSha256,
    },
    scriptedReferences: {
      rows: references.summary.rows,
      independentImplementations: references.summary.independentImplementations,
      minimumCore: references.summary.minimumCore,
      exactRows: references.summary.exactRows,
      infrastructureInvalid: references.summary.infrastructureInvalid,
      maximumAbsoluteTwinDifference: references.summary.maximumAbsoluteTwinDifference,
      reportSha256: references.reportSha256,
      closureSha256: scriptedReferenceArtifacts.closureSha256,
    },
    flake: { ...quality.flake, qualityEvidenceSha256: quality.evidenceSha256 },
    mutation: { ...quality.mutation, qualityEvidenceSha256: quality.evidenceSha256 },
    requirementMap: requirementMapGateEvidence(requirementAudit),
    reviews: reviewGateEvidence(validatedReviews),
    tests: {
      existing: testReport.suites.existing.passed,
      v7: testReport.suites.v7.passed,
      m4Preflights: testReport.preflights.length,
      failures: testReport.failures,
      testReportSha256: testReport.reportSha256,
    },
  };
  return { ...unsigned, baseEvidenceSha256: canonicalJsonSha256(unsigned) };
}

export function validateTerminalV7BaseGateEvidence(evidence) {
  invariant(evidence?.schemaVersion === TERMINAL_V7_BASE_GATE_SCHEMA, 'Unsupported V7 base-gate evidence schema');
  const { baseEvidenceSha256, ...unsigned } = evidence;
  invariant(baseEvidenceSha256 === canonicalJsonSha256(unsigned), 'V7 base-gate evidence hash mismatch');
  invariant(COMMIT_RE.test(evidence.reviewedCommit ?? '') && /^r[1-9]\d*$/.test(evidence.revision ?? ''), 'V7 base-gate identity is invalid');
  validateTerminalV7ExecutionHost(evidence.executionHost);
  invariant(Object.values(evidence.sourceArtifacts ?? {}).every((value) => typeof value === 'string' && value.length > 0), 'V7 base-gate source commitments are incomplete');
  invariant(Array.isArray(evidence.packSeals) && evidence.packSeals.length === 13, 'V7 base-gate pack evidence is incomplete');
  invariant(Array.isArray(evidence.reviews) && evidence.reviews.length === 3
    && evidence.reviews.every(({ approved, topics }) => approved === true && sameMembers(topics, TERMINAL_V7_REVIEW_TOPICS)), 'V7 base-gate review evidence is incomplete');
  return evidence;
}

export function assertTerminalV7BaseGateMatches(left, right) {
  validateTerminalV7BaseGateEvidence(left);
  validateTerminalV7BaseGateEvidence(right);
  invariant(canonicalJson(left) === canonicalJson(right), 'V7 base-gate evidence is not reproducible from its source artifacts');
  return left;
}

export function assertTerminalV7ReleaseEvidenceSources(evidence, {
  seedKey,
  sealManifest,
  goldReport,
  goldArtifacts,
  scriptedReferences,
  scriptedReferenceArtifacts,
  qualityEvidence,
  requirementMap,
  reviews,
  testReport,
  pilotReport,
} = {}) {
  validateTerminalV7ReleaseGateEvidence(evidence);
  const reviewRecords = Array.isArray(reviews) ? reviews : reviews?.reviews;
  const rebuiltBase = assembleTerminalV7BaseGateEvidence({
    revision: evidence.revision,
    evaluatedAt: evidence.baseEvidence.evaluatedAt,
    reviewedCommit: evidence.reviewedCommit,
    seedKey,
    sealManifest,
    goldReport,
    goldArtifacts,
    scriptedReferences,
    scriptedReferenceArtifacts,
    qualityEvidence,
    requirementMap,
    reviews: reviewRecords,
    testReport,
  });
  assertTerminalV7BaseGateMatches(evidence.baseEvidence, rebuiltBase);
  invariant(canonicalJson(evidence.pilotReport) === canonicalJson(pilotReport), 'V7 release evidence does not match the sealed pilot-report artifact');
  return evidence;
}

export function sealTerminalV7ReleaseGateEvidence({ baseEvidence, pilotReport, evaluatedAt } = {}) {
  validateTerminalV7BaseGateEvidence(baseEvidence);
  invariant(pilotReport?.schemaVersion === 'agentbattler.terminal-v7-development-pilot-report.v1', 'V7 release evidence requires a pilot report');
  const { reportSha256, ...unsignedPilot } = pilotReport;
  invariant(reportSha256 === canonicalJsonSha256(unsignedPilot) && pilotReport.accepted === true, 'V7 release evidence requires an accepted sealed pilot report');
  invariant(baseEvidence.revision === pilotReport.revision, 'V7 base evidence and pilot report revisions differ');
  invariant(typeof evaluatedAt === 'string' && Number.isFinite(Date.parse(evaluatedAt)), 'V7 release evidence timestamp is invalid');
  const unsigned = {
    schemaVersion: TERMINAL_V7_RELEASE_GATE_EVIDENCE_SCHEMA,
    revision: baseEvidence.revision,
    evaluatedAt,
    reviewedCommit: baseEvidence.reviewedCommit,
    baseEvidence,
    pilotReport,
    packSeals: baseEvidence.packSeals,
    gold: baseEvidence.gold,
    scriptedReferences: baseEvidence.scriptedReferences,
    flake: baseEvidence.flake,
    mutation: baseEvidence.mutation,
    requirementMap: baseEvidence.requirementMap,
    reviews: baseEvidence.reviews,
    tests: baseEvidence.tests,
    pilot: { ...pilotReport.pilot, pilotReportSha256: pilotReport.reportSha256 },
  };
  return { ...unsigned, releaseEvidenceSha256: canonicalJsonSha256(unsigned) };
}

export function validateTerminalV7ReleaseGateEvidence(evidence) {
  invariant(evidence?.schemaVersion === TERMINAL_V7_RELEASE_GATE_EVIDENCE_SCHEMA, 'Unsupported V7 release-gate evidence schema');
  const { releaseEvidenceSha256, ...unsigned } = evidence;
  invariant(releaseEvidenceSha256 === canonicalJsonSha256(unsigned), 'V7 release-gate evidence hash mismatch');
  validateTerminalV7BaseGateEvidence(evidence.baseEvidence);
  invariant(evidence.revision === evidence.baseEvidence.revision
    && evidence.reviewedCommit === evidence.baseEvidence.reviewedCommit, 'V7 release-gate base identity changed');
  for (const field of ['packSeals', 'gold', 'scriptedReferences', 'flake', 'mutation', 'requirementMap', 'reviews', 'tests']) {
    invariant(canonicalJson(evidence[field]) === canonicalJson(evidence.baseEvidence[field]), `V7 release-gate ${field} differs from validated base evidence`);
  }
  const pilot = evidence.pilotReport;
  invariant(pilot?.schemaVersion === 'agentbattler.terminal-v7-development-pilot-report.v1', 'V7 release-gate pilot report is missing');
  const { reportSha256, ...unsignedPilot } = pilot;
  invariant(reportSha256 === canonicalJsonSha256(unsignedPilot)
    && pilot.accepted === true
    && pilot.revision === evidence.revision, 'V7 release-gate pilot report is invalid');
  invariant(canonicalJson(evidence.pilot) === canonicalJson({ ...pilot.pilot, pilotReportSha256: reportSha256 }), 'V7 release-gate pilot projection changed');
  return evidence;
}
