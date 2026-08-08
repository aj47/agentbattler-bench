#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { buildHarborTerminalV7Tasks } from './build-harbor-terminal-v7.mjs';
import { canonicalJson, canonicalJsonSha256, sha256File } from '../src/provenance.mjs';
import { assertTerminalV7ReleaseGates } from '../src/terminal-v7-gates.mjs';
import { assertTerminalV7DevelopmentPilotReportSources } from '../src/terminal-v7-pilot-report.mjs';
import {
  assertTerminalV7ReleaseEvidenceSources,
  assertTerminalV7TestReportArtifacts,
  validateTerminalV7ReleaseGateEvidence,
} from '../src/terminal-v7-release-evidence.mjs';
import { validateTerminalV7SealManifest } from '../src/terminal-v7-seals.mjs';
import {
  createTerminalV7Challenge,
  createTerminalV7Schedule,
  validateTerminalV7Challenge,
  validateTerminalV7Schedule,
} from '../src/terminal-v7.mjs';
import { SEALED_TERMINAL_HARNESS_VERSIONS } from '../src/terminal-harness-versions.mjs';
import { MINI_LEDGER_V7_CANDIDATE_TREE_POLICY } from '../src/terminal-v7-runtime.mjs';
import {
  bindTerminalV7HarborTaskImageReferences,
  buildTerminalV7HarborTaskImages,
  terminalV7HarborTaskTreeIdentity,
} from '../src/terminal-v7-harbor-images.mjs';
import { inspectTerminalV7VerifierImage } from '../src/terminal-v7-verifier-container.mjs';
import { inspectDotAgentsV7Image } from '../src/dotagents-harness.mjs';
import { assertTerminalV7GoldReportArtifacts } from './validate-terminal-v7-golds.mjs';
import { assertTerminalV7ScriptedReferenceArtifacts } from '../src/terminal-v7-scripted-references.mjs';
import { assertTerminalV7QualityEvidenceArtifacts } from '../src/terminal-v7-quality-gates.mjs';
import { assertTerminalV7ReviewArtifacts } from '../src/terminal-v7-review.mjs';
import { assertTerminalV7HumanTwinArtifacts } from '../src/terminal-v7-human-twins.mjs';
import { assertTerminalV7RequirementMap } from '../src/terminal-v7-requirement-map.mjs';
import { terminalV7CalibrationSourceCommitments } from '../src/terminal-v7-calibration-build.mjs';
import {
  assertTerminalV7OfficialResultRootUnused,
  assertTerminalV7RevisionAcceptsNewWork,
  resolveTerminalV7RevisionControlRoot,
} from '../src/terminal-v7-revision-control.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REVISION = process.env.AGENTBATTLER_TERMINAL_PROTOCOL_REVISION ?? 'r2';
const RESULT_TAG = process.env.AGENTBATTLER_TERMINAL_RESULT_TAG ?? `v7-${REVISION}`;
const RESULT_ROOT = path.join(ROOT, `results/terminal-mini-ledger-${RESULT_TAG}`);
const SEALS_PATH = path.resolve(ROOT, process.env.AGENTBATTLER_V7_SEALS_PATH ?? `benchmark/challenges/mini-ledger-v7/seals/${REVISION}.json`);
const GATES_PATH = path.resolve(ROOT, process.env.AGENTBATTLER_V7_GATES_PATH ?? `results/terminal-mini-ledger-v7-calibration-${REVISION}/release-gates.json`);
const CODEX_STATE_ROOT = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
const SEED_KEY_PATH = path.resolve(process.env.AGENTBATTLER_V7_SEED_KEY_FILE ?? path.join(CODEX_STATE_ROOT, 'automations', 'mini-ledger-v6-scheduled-check', `mini-ledger-v7-${REVISION}.seed-key`));
const GOLD_REPORT_PATH = path.resolve(process.env.AGENTBATTLER_V7_GOLD_REPORT_PATH ?? path.join(ROOT, 'results', `terminal-mini-ledger-v7-calibration-${REVISION}`, 'gold', 'gold-report.json'));
const QUALITY_EVIDENCE_PATH = path.resolve(process.env.AGENTBATTLER_V7_QUALITY_EVIDENCE_PATH ?? path.join(ROOT, 'results', `terminal-mini-ledger-v7-calibration-${REVISION}`, 'quality-gates.json'));
const REQUIREMENT_MAP_PATH = path.resolve(process.env.AGENTBATTLER_V7_REQUIREMENT_MAP_PATH ?? path.join(ROOT, 'benchmark', 'challenges', 'mini-ledger-v7', 'requirement-map.json'));
const REVIEWS_PATH = path.resolve(process.env.AGENTBATTLER_V7_REVIEWS_PATH ?? path.join(ROOT, 'results', `terminal-mini-ledger-v7-calibration-${REVISION}`, 'control', 'independent-reviews.json'));
const TEST_REPORT_PATH = path.resolve(process.env.AGENTBATTLER_V7_TEST_REPORT_PATH ?? path.join(ROOT, 'results', `terminal-mini-ledger-v7-calibration-${REVISION}`, 'test-preflight-report.json'));
const PILOT_REPORT_PATH = path.resolve(process.env.AGENTBATTLER_V7_PILOT_REPORT_PATH ?? path.join(ROOT, 'results', `terminal-mini-ledger-v7-calibration-${REVISION}`, 'pilot-report.json'));
const SCRIPTED_REFERENCES_PATH = path.resolve(process.env.AGENTBATTLER_V7_SCRIPTED_REFERENCES_PATH ?? path.join(ROOT, 'results', `terminal-mini-ledger-v7-calibration-${REVISION}`, 'control', 'scripted-reference-results.json'));
const HUMAN_TWINS_PATH = path.resolve(process.env.AGENTBATTLER_V7_HUMAN_TWINS_PATH ?? path.join(ROOT, 'results', `terminal-mini-ledger-v7-calibration-${REVISION}`, 'control', 'human-twin-validations.json'));
const REVISION_CONTROL_ROOT = resolveTerminalV7RevisionControlRoot({ root: ROOT, revision: REVISION });
const execFileAsync = promisify(execFile);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function assertReviewedSourceTree(reviewedCommit) {
  const [{ stdout: head }, { stdout: status }] = await Promise.all([
    execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: ROOT }),
    execFileAsync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: ROOT }),
  ]);
  invariant(head.trim() === reviewedCommit, 'V7 schedule source is not the independently reviewed commit');
  invariant(status.trim() === '', 'V7 release schedule requires a clean reviewed source tree');
}

async function treeRecords(root, relative = '') {
  const records = [];
  for (const entry of (await readdir(path.join(root, relative), { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    const child = relative ? path.posix.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) records.push(...await treeRecords(root, child));
    else if (entry.isFile()) records.push({ path: child, sha256: await sha256File(path.join(root, ...child.split('/'))) });
    else throw new Error(`V7 Harbor task contains a non-regular entry: ${child}`);
  }
  return records;
}

function resealChallenge(challenge, execution) {
  const { challengeId: _oldId, challengeSha256: _oldHash, ...descriptor } = challenge;
  const extended = { ...descriptor, execution };
  const challengeSha256 = canonicalJsonSha256(extended);
  return { ...extended, challengeSha256, challengeId: `challenge-${challengeSha256.slice(0, 16)}` };
}

invariant(/^r[1-9]\d*$/.test(REVISION), 'AGENTBATTLER_TERMINAL_PROTOCOL_REVISION must look like r1');
invariant(/^v7-r[1-9]\d*$/.test(RESULT_TAG), 'V7 result tag must look like v7-r1');
await assertTerminalV7OfficialResultRootUnused({ resultRoot: RESULT_ROOT });
await assertTerminalV7RevisionAcceptsNewWork({ controlRoot: REVISION_CONTROL_ROOT, revision: REVISION });
const [sealManifest, gateEvidence, goldReport, qualityEvidence, requirementMap, reviews, testReport, pilotReport, scriptedReferences, humanTwinValidations] = await Promise.all([
  readFile(SEALS_PATH, 'utf8').then(JSON.parse),
  readFile(GATES_PATH, 'utf8').then(JSON.parse),
  readFile(GOLD_REPORT_PATH, 'utf8').then(JSON.parse),
  readFile(QUALITY_EVIDENCE_PATH, 'utf8').then(JSON.parse),
  readFile(REQUIREMENT_MAP_PATH, 'utf8').then(JSON.parse),
  readFile(REVIEWS_PATH, 'utf8').then(JSON.parse),
  readFile(TEST_REPORT_PATH, 'utf8').then(JSON.parse),
  readFile(PILOT_REPORT_PATH, 'utf8').then(JSON.parse),
  readFile(SCRIPTED_REFERENCES_PATH, 'utf8').then(JSON.parse),
  readFile(HUMAN_TWINS_PATH, 'utf8').then(JSON.parse),
]);
const seedKey = (await readFile(SEED_KEY_PATH, 'utf8')).trim();
invariant(seedKey.length >= 16, 'V7 evaluator seed key is invalid');
validateTerminalV7SealManifest(sealManifest, { seedKey });
validateTerminalV7ReleaseGateEvidence(gateEvidence);
const goldArtifacts = await assertTerminalV7GoldReportArtifacts({
  evidenceRoot: path.dirname(GOLD_REPORT_PATH),
  root: ROOT,
  report: goldReport,
  sealManifest,
});
const scriptedReferenceArtifacts = await assertTerminalV7ScriptedReferenceArtifacts({
  evidenceRoot: path.dirname(GATES_PATH),
  root: ROOT,
  report: scriptedReferences,
  sealManifest,
  goldReport,
  expectedVerifierImage: goldReport.verifierImage,
});
await assertTerminalV7QualityEvidenceArtifacts({
  evidenceRoot: path.dirname(GATES_PATH),
  evidence: qualityEvidence,
  revision: REVISION,
  reviewedCommit: gateEvidence.reviewedCommit,
  sealManifestSha256: sealManifest.manifestSha256,
  goldReportSha256: goldReport.reportSha256,
  goldImplementationSourceSha256: goldArtifacts.implementationSourceSha256,
  verifierImage: goldReport.verifierImage,
});
const requirementAudit = assertTerminalV7RequirementMap(requirementMap);
const reviewRecords = Array.isArray(reviews) ? reviews : reviews.reviews;
await assertTerminalV7ReviewArtifacts({
  evidenceRoot: path.dirname(GATES_PATH),
  reviews: reviewRecords,
  options: {
    revision: REVISION,
    reviewedCommit: gateEvidence.reviewedCommit,
    sealManifestSha256: sealManifest.manifestSha256,
    requirementMapSha256: requirementAudit.requirementMapSha256,
  },
});
await assertTerminalV7HumanTwinArtifacts({
  evidenceRoot: path.dirname(GATES_PATH),
  rows: humanTwinValidations,
  options: {
    revision: REVISION,
    reviewedCommit: gateEvidence.reviewedCommit,
    sealManifestSha256: sealManifest.manifestSha256,
    verifierImage: goldReport.verifierImage,
  },
});
assertTerminalV7ReleaseEvidenceSources(gateEvidence, {
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
});
await assertTerminalV7DevelopmentPilotReportSources({
  resultRoot: path.dirname(GATES_PATH),
  report: pilotReport,
  scriptedReferences,
  humanTwinValidations,
  humanTwinOptions: {
    revision: REVISION,
    reviewedCommit: gateEvidence.reviewedCommit,
    sealManifestSha256: sealManifest.manifestSha256,
    verifierImage: goldReport.verifierImage,
  },
});
await assertTerminalV7TestReportArtifacts({ evidenceRoot: path.dirname(GATES_PATH), report: testReport });
const gate = assertTerminalV7ReleaseGates(gateEvidence);
await assertReviewedSourceTree(gateEvidence.reviewedCommit);
invariant(gateEvidence.revision === REVISION, 'V7 release-gate revision does not match the requested schedule');
invariant(gateEvidence.baseEvidence.sourceArtifacts.sealManifestSha256 === sealManifest.manifestSha256, 'V7 release gates use another seal manifest');
const releasePacks = sealManifest.packs.filter(({ pool }) => pool === 'release').map(({ decoy }) => decoy);
invariant(releasePacks.length === 5, 'V7 release seal manifest must contain five decoy packs');

const verifierPath = 'benchmark/challenges/mini-ledger-v7/verifier.mjs';
const promptPath = 'benchmark/challenges/mini-ledger-v7.md';
const [promptSha256, verifierSha256] = await Promise.all([
  sha256File(path.join(ROOT, promptPath)),
  sha256File(path.join(ROOT, verifierPath)),
]);
const baseChallenge = createTerminalV7Challenge({
  protocolRevision: REVISION,
  instances: releasePacks,
  promptPath,
  promptSha256,
  publicVerifierPath: verifierPath,
  publicVerifierSha256: verifierSha256,
  hiddenVerifierPath: verifierPath,
  hiddenVerifierSha256: verifierSha256,
  adaptabilityVerifierPath: verifierPath,
  adaptabilityVerifierSha256: verifierSha256,
});

const harborTaskSet = await buildHarborTerminalV7Tasks({
  pool: 'release',
  variant: 'decoy',
  resultRoot: RESULT_ROOT,
  seedKey,
});
const [verifierImage, dotAgentsRuntimeImage] = await Promise.all([
  inspectTerminalV7VerifierImage(),
  inspectDotAgentsV7Image(),
]);
const taskEntries = [];
const boundHarborTasks = [];
for (const task of harborTaskSet.tasks) {
  invariant(task.taskPathBase === 'result-root', `V7 release task ${task.instanceId} is not under private result control`);
  const taskRoot = path.resolve(RESULT_ROOT, task.taskPath);
  const relation = path.relative(RESULT_ROOT, taskRoot);
  invariant(relation && !relation.startsWith(`..${path.sep}`) && relation !== '..' && !path.isAbsolute(relation), `V7 release task ${task.instanceId} escaped its result root`);
  const images = await buildTerminalV7HarborTaskImages({ taskRoot });
  await bindTerminalV7HarborTaskImageReferences({ taskRoot, images });
  const taskIdentity = await terminalV7HarborTaskTreeIdentity({ taskRoot });
  const imageReferences = Object.fromEntries(['environment', 'verifier'].map((kind) => [kind, images[kind].imageId]));
  const boundTask = {
    ...task,
    sha256: taskIdentity.sha256,
    fileCount: taskIdentity.fileCount,
    images,
    imageReferences,
  };
  boundHarborTasks.push(boundTask);
  taskEntries.push([task.instanceId, {
    instanceId: task.instanceId,
    variant: task.variant,
    taskPathBase: task.taskPathBase,
    taskPath: task.taskPath,
    sha256: taskIdentity.sha256,
    fileCount: taskIdentity.fileCount,
    images,
    imageReferences,
  }]);
}
await writeFile(
  path.join(RESULT_ROOT, 'control', 'harbor-tasks', 'manifest-release-decoy.json'),
  `${canonicalJson({ ...harborTaskSet, tasks: boundHarborTasks }, { space: 2 })}\n`,
  { mode: 0o600 },
);
const taskPaths = Object.fromEntries(taskEntries);
invariant(Object.keys(taskPaths).length === 5, 'V7 release Harbor task set is incomplete');
const adapters = await terminalV7CalibrationSourceCommitments({ root: ROOT });
const challenge = resealChallenge(baseChallenge, {
  substrate: 'harbor-with-sealed-direct-fallbacks',
  harborVersion: '0.20.0',
  protocolRevision: REVISION,
  predecessorCommit: 'dd0482e2d467a324994b258587b82ceb95aafd08',
  feedbackPolicy: 'self-service-public-only',
  phaseCount: 5,
  perPhaseLimitMs: 1_500_000,
  executionHost: structuredClone(gateEvidence.baseEvidence.executionHost),
  verifierImage,
  runtimeImages: { 'dotagents-mono': dotAgentsRuntimeImage },
  tasks: taskPaths,
  adapters,
  candidateTree: {
    schemaVersion: 'agentbattler.terminal-candidate-tree.v1',
    policy: MINI_LEDGER_V7_CANDIDATE_TREE_POLICY,
    grading: 'normalized-overlay-on-fresh-sealed-starter',
  },
  artifactPolicy: {
    accepted: 'regular-files-under-declared-source-allowlist',
    ignored: ['candidate-tests', '.git', 'control-files', 'caches', 'dependencies', 'runtime-state'],
    maxFiles: 256,
    maxBytes: 4 * 1024 * 1024,
  },
  sandboxPolicy: {
    inheritedFrom: 'mini-ledger-v6-r14',
    network: 'denied-for-model-commands-and-candidate-processes',
    environmentEnumeration: 'observable-fixed-minimal-non-secret-values-only',
    dynamicSensitiveEnvironmentAccess: 'denied-no-sensitive-values-present',
    outOfWorkspace: 'denied',
    modelCommandCapabilities: 'exactly-zero',
    blockedAttempts: 'ordinary-scoreable-tool-errors',
  },
  agentToolRuntimePolicy: {
    environment: 'forced-minimal-non-secret-allowlist',
    filesystem: 'workspace-and-disposable-temp-only',
    network: 'denied-for-model-generated-commands',
    enforcement: 'native-or-os-sandbox-per-harness',
    traceAudit: 'sandbox-enforced-attempt-observation',
    blockedAttemptDisposition: 'ordinary-tool-error-run-remains-scoreable',
    modelCommandCapabilities: 'fail-closed-zero-mask-guard',
  },
  traceIsolationRequired: true,
  verifierEvidencePolicy: {
    schemaVersion: 'agentbattler.terminal-v7-verifier-evidence.v1',
    phaseArtifacts: 5,
    finalArtifact: true,
    bindRawTreeIntoAttempt: true,
    currentMustEqualDeclaredAttempt: true,
  },
  commitments: {
    sealManifestSha256: sealManifest.manifestSha256,
    releaseGateSha256: gate.gateSha256,
    releaseEvidenceSha256: gateEvidence.releaseEvidenceSha256,
    baseEvidenceSha256: gateEvidence.baseEvidence.baseEvidenceSha256,
    pilotReportSha256: gateEvidence.pilotReport.reportSha256,
    reviewedCommit: gateEvidence.reviewedCommit,
    sourceSetSha256: canonicalJsonSha256(adapters),
    verifierSha256,
    hiddenMerkleRoots: Object.fromEntries(releasePacks.map((pack) => [pack.instanceId, pack.hiddenMerkleRoot])),
    rubricVersion: 'mini-ledger-v7-r1',
  },
});
validateTerminalV7Challenge(challenge);
invariant(challenge.execution.agentToolRuntimePolicy?.traceAudit === 'sandbox-enforced-attempt-observation'
  && challenge.execution.agentToolRuntimePolicy?.blockedAttemptDisposition === 'ordinary-tool-error-run-remains-scoreable'
  && challenge.execution.agentToolRuntimePolicy?.modelCommandCapabilities === 'fail-closed-zero-mask-guard', 'V7 runtime boundary policy changed');

const harnesses = Object.entries(SEALED_TERMINAL_HARNESS_VERSIONS).map(([id, version]) => ({ id, version }));
invariant(harnesses.length === 5, 'V7 release schedule requires exactly five sealed harnesses');
const schedule = createTerminalV7Schedule({
  challenge,
  harnesses,
  model: { id: 'gpt-5.6-luna', familyId: 'luna', reasoningEffort: 'max' },
  seed: Number.parseInt(process.env.AGENTBATTLER_TERMINAL_SEED ?? '20260808', 10),
});
validateTerminalV7Schedule(schedule, challenge);

await mkdir(RESULT_ROOT, { recursive: true });
await Promise.all([
  writeFile(path.join(RESULT_ROOT, 'challenge.json'), `${canonicalJson(challenge, { space: 2 })}\n`),
  writeFile(path.join(RESULT_ROOT, 'schedule.json'), `${canonicalJson(schedule, { space: 2 })}\n`),
]);
console.log(`V7 challenge ${challenge.challengeId}`);
console.log(`V7 schedule ${schedule.scheduleId}: 5 harnesses x 5 sealed release packs = 25 jobs`);
console.log(`V7 execution order: five precommitted balanced rounds; scored variant decoy only`);
