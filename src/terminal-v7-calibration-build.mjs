import { lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildHarborTerminalV7Tasks } from '../scripts/build-harbor-terminal-v7.mjs';
import {
  createTerminalV7CalibrationChallenge,
  createTerminalV7CalibrationTaskBinding,
  createTerminalV7DevelopmentPilotSchedule,
  createTerminalV7ReserveExtension,
  validateTerminalV7CalibrationChallenge,
  validateTerminalV7CalibrationChallengeAgainstManifest,
  validateTerminalV7CalibrationSchedule,
  validateTerminalV7CalibrationTaskBinding,
} from './terminal-v7-calibration.mjs';
import { scoreTerminalV7Run } from './terminal-v7.mjs';
import { SEALED_TERMINAL_HARNESS_VERSIONS } from './terminal-harness-versions.mjs';
import { canonicalJson, canonicalJsonSha256, sha256File } from './provenance.mjs';
import { MINI_LEDGER_V7_CANDIDATE_TREE_POLICY } from './terminal-v7-runtime.mjs';
import { validateTerminalV7SealManifest } from './terminal-v7-seals.mjs';
import { inspectTerminalV7VerifierImage } from './terminal-v7-verifier-container.mjs';
import {
  bindTerminalV7HarborTaskImageReferences,
  buildTerminalV7HarborTaskImages,
  terminalV7HarborTaskTreeIdentity,
} from './terminal-v7-harbor-images.mjs';
import { validateTerminalV7BaseGateEvidence } from './terminal-v7-release-evidence.mjs';
import { validateTerminalV7ExecutionHost } from './terminal-v7-execution-identity.mjs';
import { assertTerminalV7BaseGatesFromFiles } from '../scripts/assemble-terminal-v7-base-gates.mjs';
import {
  assertTerminalV7RevisionAcceptsNewWork,
  resolveTerminalV7RevisionControlRoot,
} from './terminal-v7-revision-control.mjs';
import {
  DOTAGENTS_COMMIT,
  DOTAGENTS_V7_IMAGE,
  DOTAGENTS_V7_SANDBOX_REVISION,
  DOTAGENTS_VERSION,
  dotAgentsV7ImageSourceDescriptor,
} from './dotagents-harness.mjs';

export const TERMINAL_V7_CALIBRATION_CONTROL_SCHEMA = 'agentbattler.terminal-v7-calibration-control.v1';

const SHA256_RE = /^[0-9a-f]{64}$/;
const IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/;

export const TERMINAL_V7_CALIBRATION_SOURCE_PATHS = Object.freeze({
  packageScripts: 'package.json',
  dispatcher: 'scripts/terminal-adapter-all.mjs',
  harbor: 'scripts/terminal-adapter-harbor.mjs',
  codex: 'scripts/terminal-adapter-codex.mjs',
  pi: 'scripts/terminal-adapter-pi.mjs',
  claude: 'scripts/terminal-adapter-claude.mjs',
  dotagents: 'scripts/terminal-adapter-dotagents.mjs',
  droid: 'scripts/terminal-adapter-droid.mjs',
  v7HarborTaskBuilder: 'scripts/build-harbor-terminal-v7.mjs',
  v7SealCli: 'scripts/seal-terminal-v7-packs.mjs',
  v7GoldCli: 'scripts/validate-terminal-v7-golds.mjs',
  v7QualityCli: 'scripts/run-terminal-v7-quality-gates.mjs',
  v7PreflightCli: 'scripts/run-terminal-v7-test-preflights.mjs',
  v7VerifierImageBuilderCli: 'scripts/build-terminal-v7-verifier-image.mjs',
  v7ReleaseBuilderCli: 'scripts/build-terminal-v7-schedule.mjs',
  v7ReleaseRunnerCli: 'scripts/run-terminal-v7-matrix.mjs',
  v7TraceExporterCli: 'scripts/export-terminal-v7-traces.mjs',
  terminalRunner: 'src/terminal-runner.mjs',
  challengeRuntime: 'src/terminal-challenge-runtime.mjs',
  v7Calibration: 'src/terminal-v7-calibration.mjs',
  v7CalibrationBuild: 'src/terminal-v7-calibration-build.mjs',
  v7CalibrationRunner: 'src/terminal-v7-calibration-runner.mjs',
  v7CalibrationRunnerCli: 'scripts/run-terminal-v7-pilot-job.mjs',
  v7PilotReport: 'src/terminal-v7-pilot-report.mjs',
  v7ScriptedReferences: 'src/terminal-v7-scripted-references.mjs',
  v7PilotBuilderCli: 'scripts/build-terminal-v7-pilot.mjs',
  v7PilotReportCli: 'scripts/report-terminal-v7-pilot.mjs',
  v7ScriptedReferencesRunnerCli: 'scripts/run-terminal-v7-scripted-references.mjs',
  v7ReserveBuilderCli: 'scripts/build-terminal-v7-reserve.mjs',
  v7ReserveRunner: 'src/terminal-v7-reserve-runner.mjs',
  v7ReserveReport: 'src/terminal-v7-reserve-report.mjs',
  v7ReserveRunnerCli: 'scripts/run-terminal-v7-reserve.mjs',
  v7ReserveReportCli: 'scripts/report-terminal-v7-reserve.mjs',
  v7StrictVerifierCli: 'scripts/verify-terminal-v7-results.mjs',
  v7Retirement: 'src/terminal-v7-retirement.mjs',
  v7RetirementCli: 'scripts/retire-terminal-v7.mjs',
  v7RevisionControl: 'src/terminal-v7-revision-control.mjs',
  v7VerifierEvidence: 'src/terminal-v7-verifier-evidence.mjs',
  v7ExecutionIdentity: 'src/terminal-v7-execution-identity.mjs',
  v7Gates: 'src/terminal-v7-gates.mjs',
  v7Preflights: 'src/terminal-v7-preflights.mjs',
  v7ReleaseEvidence: 'src/terminal-v7-release-evidence.mjs',
  v7OperationalMetrics: 'src/terminal-v7-operational-metrics.mjs',
  v7QualityGates: 'src/terminal-v7-quality-gates.mjs',
  v7RequirementMap: 'src/terminal-v7-requirement-map.mjs',
  v7Review: 'src/terminal-v7-review.mjs',
  v7RunBoundary: 'src/terminal-v7-run-boundary.mjs',
  v7Seals: 'src/terminal-v7-seals.mjs',
  v7HumanTwins: 'src/terminal-v7-human-twins.mjs',
  v7BaseGateAssembler: 'scripts/assemble-terminal-v7-base-gates.mjs',
  v7Runtime: 'src/terminal-v7-runtime.mjs',
  v7Direct: 'src/terminal-v7-direct.mjs',
  v7Overlay: 'src/terminal-v7-overlay.mjs',
  candidateTree: 'src/terminal-candidate-tree.mjs',
  runEvidence: 'src/terminal-run-evidence.mjs',
  provenance: 'src/provenance.mjs',
  v7Scoring: 'src/terminal-v7.mjs',
  verifierContainer: 'src/terminal-v7-verifier-container.mjs',
  harborImages: 'src/terminal-v7-harbor-images.mjs',
  verifierContainerDockerfile: 'benchmark/verifier/mini-ledger-v7/Dockerfile',
  verifierContainerRunner: 'benchmark/verifier/mini-ledger-v7/run.mjs',
  v7Control: 'benchmark/harbor/v7_control.py',
  v7CodexHarbor: 'benchmark/harbor/v7_codex_agent.py',
  v7PiHarbor: 'benchmark/harbor/v7_pi_agent.py',
  v7ClaudeHarbor: 'benchmark/harbor/v7_claude_agent.py',
  v7CodexBwrapWrapper: 'benchmark/harbor/v7_codex_bwrap_wrapper.sh',
  v7PiSandboxExtension: 'benchmark/harbor/v7_pi_sandbox_extension.mjs',
  v7ClaudeBwrapWrapper: 'benchmark/harbor/v7_claude_bwrap_wrapper.sh',
  codexHarbor: 'benchmark/harbor/codex_agent.py',
  piHarbor: 'benchmark/harbor/pi_agent.py',
  claudeHarbor: 'benchmark/harbor/claude_agent.py',
  codexBwrapWrapper: 'benchmark/harbor/codex_bwrap_wrapper.sh',
  piSandboxExtension: 'benchmark/harbor/pi_sandbox_extension.mjs',
  claudeBwrapWrapper: 'benchmark/harbor/claude_bwrap_wrapper.sh',
  claudeCompaction: 'src/claude-compaction.mjs',
  anthropicOverflowCompat: 'src/anthropic-overflow-compat.mjs',
  droidSandbox: 'src/droid-sandbox.mjs',
  droidHarness: 'src/droid-harness.mjs',
  droidJsonRpc: 'src/droid-jsonrpc.mjs',
  droidRouting: 'src/droid-routing.mjs',
  droidRuntime: 'src/droid-runtime.mjs',
  verifier: 'benchmark/challenges/mini-ledger-v7/verifier.mjs',
  pack: 'benchmark/challenges/mini-ledger-v7/pack.mjs',
  requirements: 'benchmark/challenges/mini-ledger-v7/requirements.mjs',
  requirementMap: 'benchmark/challenges/mini-ledger-v7/requirement-map.json',
  candidateProcess: 'benchmark/challenges/candidate-process.mjs',
  harnessVersions: 'src/terminal-harness-versions.mjs',
  dotagentsHarness: 'src/dotagents-harness.mjs',
  dotagentsDockerfile: 'harnesses/dotagents/Dockerfile',
  dotagentsV7Dockerfile: 'harnesses/dotagents/Dockerfile.v7',
  dotagentsDockerignore: 'harnesses/dotagents/.dockerignore',
  dotagentsSandboxPatchV7: 'harnesses/dotagents/runtime-tools-sandbox-v7.patch',
  dotagentsMaxReasoning: 'harnesses/dotagents/enable-max-reasoning.mjs',
  dotagentsV7ImageBuilder: 'scripts/build-dotagents-v7-image.mjs',
});

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function safeAbsolute(value, label) {
  invariant(typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0'), `${label} must be an absolute path`);
  return path.resolve(value);
}

function validateRevision(revision) {
  invariant(/^r[1-9]\d*$/.test(revision ?? ''), 'V7 calibration revision must look like r1');
  return revision;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function atomicWriteJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporary, `${canonicalJson(value, { space: 2 })}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
}

async function assertPrivateKeyFile(file) {
  const stat = await lstat(file);
  invariant(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'V7 evaluator key must be one regular file');
  invariant(stat.size > 0 && stat.size <= 4096, 'V7 evaluator key file size is invalid');
  invariant((stat.mode & 0o077) === 0, 'V7 evaluator key file must not be group/world accessible');
}

export async function loadTerminalV7CalibrationSealInputs({
  root,
  revision,
  sealsPath = null,
  seedKeyPath = null,
} = {}) {
  const repositoryRoot = safeAbsolute(root, 'V7 calibration repository root');
  validateRevision(revision);
  const stateRoot = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const resolvedSeals = path.resolve(sealsPath ?? path.join(repositoryRoot, 'benchmark', 'challenges', 'mini-ledger-v7', 'seals', `${revision}.json`));
  const resolvedKey = path.resolve(seedKeyPath ?? path.join(stateRoot, 'automations', 'mini-ledger-v6-scheduled-check', `mini-ledger-v7-${revision}.seed-key`));
  await assertPrivateKeyFile(resolvedKey);
  const [sealManifest, seedKey] = await Promise.all([
    readJson(resolvedSeals),
    readFile(resolvedKey, 'utf8').then((value) => value.trim()),
  ]);
  invariant(seedKey.length >= 16 && seedKey.length <= 4096, 'V7 evaluator key contents are invalid');
  validateTerminalV7SealManifest(sealManifest, { seedKey });
  invariant(sealManifest.revision === revision, 'V7 calibration seal-manifest revision changed');
  return {
    sealManifest,
    seedKey,
    paths: { sealsPath: resolvedSeals, seedKeyPath: resolvedKey },
  };
}

export async function terminalV7CalibrationSourceCommitments({ root } = {}) {
  const repositoryRoot = safeAbsolute(root, 'V7 calibration source root');
  const explicit = Object.entries(TERMINAL_V7_CALIBRATION_SOURCE_PATHS);
  const sourcePaths = new Set(explicit.map(([, relative]) => relative));
  const queue = [...sourcePaths].filter((relative) => /\.(?:mjs|js)$/.test(relative));
  const localSpecifier = /(?:\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?|\bimport\s*\()\s*['"](\.{1,2}\/[^'"]+)['"]/g;
  while (queue.length > 0) {
    const relative = queue.shift();
    const source = await readFile(path.join(repositoryRoot, ...relative.split('/')), 'utf8');
    for (const match of source.matchAll(localSpecifier)) {
      const unresolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1]));
      invariant(unresolved !== '..' && !unresolved.startsWith('../'), `V7 source dependency escapes the repository: ${match[1]}`);
      const candidates = path.posix.extname(unresolved)
        ? [unresolved]
        : [unresolved, `${unresolved}.mjs`, `${unresolved}.js`, `${unresolved}.json`, path.posix.join(unresolved, 'index.mjs'), path.posix.join(unresolved, 'index.js')];
      let resolved = null;
      for (const candidate of candidates) {
        const absolute = path.join(repositoryRoot, ...candidate.split('/'));
        const stat = await lstat(absolute).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
        if (stat?.isFile()) { resolved = candidate; break; }
      }
      // Generated task/template sources can contain import-looking strings whose
      // paths are relative to a future sandbox, not this module. Only existing
      // repository-local targets participate in the execution source closure.
      if (resolved === null) continue;
      if (sourcePaths.has(resolved)) continue;
      sourcePaths.add(resolved);
      if (/\.(?:mjs|js)$/.test(resolved)) queue.push(resolved);
    }
  }
  const explicitPaths = new Set(explicit.map(([, relative]) => relative));
  const dependencyEntries = [...sourcePaths]
    .filter((relative) => !explicitPaths.has(relative))
    .sort()
    .map((relative) => [`dependency_${canonicalJsonSha256(relative).slice(0, 20)}`, relative]);
  const allEntries = [...explicit, ...dependencyEntries];
  invariant(new Set(allEntries.map(([name]) => name)).size === allEntries.length, 'V7 source-closure key collision');
  const entries = await Promise.all(allEntries.map(async ([name, relative]) => {
    const absolute = path.join(repositoryRoot, ...relative.split('/'));
    const stat = await lstat(absolute);
    invariant(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, `V7 calibration source is not one regular file: ${relative}`);
    return [name, { path: relative, sha256: await sha256File(absolute) }];
  }));
  return Object.fromEntries(entries);
}

function validateVerifierImage(image) {
  invariant(image?.schemaVersion === 'agentbattler.terminal-v7-verifier-image-source.v1', 'V7 calibration verifier image descriptor changed');
  invariant(SHA256_RE.test(image.sourceSha256 ?? '') && IMAGE_ID_RE.test(image.imageId ?? ''), 'V7 calibration verifier image identity is invalid');
  invariant(image.network === 'none' && image.readOnlyRootFilesystem === true && image.candidateCapabilities === 'exactly-zero', 'V7 calibration verifier image isolation changed');
  return image;
}

async function validateRuntimeImages(runtimeImages, { root }) {
  invariant(runtimeImages && typeof runtimeImages === 'object' && !Array.isArray(runtimeImages), 'V7 calibration runtime images are invalid');
  invariant(canonicalJson(Object.keys(runtimeImages).sort()) === canonicalJson(['dotagents-mono']), 'V7 calibration runtime image set changed');
  const image = runtimeImages['dotagents-mono'];
  invariant(image?.schemaVersion === 'agentbattler.dotagents-v7-image.v1', 'V7 calibration DotAgents runtime image descriptor changed');
  invariant(image.image === DOTAGENTS_V7_IMAGE && IMAGE_ID_RE.test(image.imageId ?? ''), 'V7 calibration DotAgents runtime image identity is invalid');
  invariant(image.os === 'linux' && image.architecture === 'arm64', 'V7 calibration DotAgents runtime platform changed');
  const source = await dotAgentsV7ImageSourceDescriptor({ repositoryRoot: root });
  invariant(image.sourceSha256 === source.sourceSha256, 'V7 calibration DotAgents reviewed source hash changed');
  invariant(image.commit === DOTAGENTS_COMMIT && image.version === DOTAGENTS_VERSION, 'V7 calibration DotAgents upstream identity changed');
  invariant(image.sandboxRevision === DOTAGENTS_V7_SANDBOX_REVISION, 'V7 calibration DotAgents sandbox revision changed');
  return runtimeImages;
}

export async function createTerminalV7CalibrationExecutionBinding({
  root,
  revision,
  sealManifest,
  taskBinding,
  verifierImage,
  runtimeImages = null,
  baseEvidence = null,
  executionHost = null,
  reviewedCommit = null,
} = {}) {
  validateRevision(revision);
  validateVerifierImage(verifierImage);
  if (runtimeImages !== null) await validateRuntimeImages(runtimeImages, { root });
  invariant(taskBinding?.sealManifestSha256 === sealManifest?.manifestSha256, 'V7 calibration task binding uses another seal manifest');
  if (baseEvidence !== null) {
    validateTerminalV7BaseGateEvidence(baseEvidence);
    invariant(baseEvidence.revision === revision && baseEvidence.sourceArtifacts?.sealManifestSha256 === sealManifest.manifestSha256, 'V7 calibration base gates use another revision or seal manifest');
  }
  const boundHost = validateTerminalV7ExecutionHost(baseEvidence?.executionHost ?? executionHost);
  const boundCommit = baseEvidence?.reviewedCommit ?? reviewedCommit;
  invariant(/^[0-9a-f]{40}$/.test(boundCommit ?? ''), 'V7 calibration execution requires the reviewed source commit');
  const adapters = await terminalV7CalibrationSourceCommitments({ root });
  const verifierSha256 = adapters.verifier.sha256;
  return {
    substrate: 'harbor-with-sealed-direct-fallbacks',
    harborVersion: '0.20.0',
    protocolRevision: revision,
    predecessorCommit: 'dd0482e2d467a324994b258587b82ceb95aafd08',
    calibrationOnly: true,
    feedbackPolicy: 'self-service-public-only',
    phaseCount: 5,
    perPhaseLimitMs: 1_500_000,
    verifierImage: { ...verifierImage },
    executionHost: structuredClone(boundHost),
    ...(runtimeImages === null ? {} : { runtimeImages: structuredClone(runtimeImages) }),
    tasks: { ...taskBinding.tasks },
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
      taskBindingSha256: taskBinding.taskBindingSha256,
      sourceSetSha256: canonicalJsonSha256(adapters),
      reviewedCommit: boundCommit,
      verifierSha256,
      rubricVersion: `mini-ledger-v7-${revision}`,
      ...(baseEvidence === null ? {} : {
        baseEvidenceSha256: baseEvidence.baseEvidenceSha256,
        baseGateSourceArtifactsSha256: canonicalJsonSha256(baseEvidence.sourceArtifacts),
      }),
    },
  };
}

async function assertNoRuns(resultRoot) {
  const entries = await readdir(path.join(resultRoot, 'runs'), { withFileTypes: true }).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error));
  invariant(entries.length === 0, 'Refusing to rebuild V7 calibration control after any run evidence exists');
}

function rebaseDevelopmentTaskSet(taskSet, { repositoryRoot, resultRoot }) {
  return {
    ...taskSet,
    tasks: taskSet.tasks.map((task) => {
      if (task.taskPathBase === 'result-root') return task;
      invariant(task.taskPathBase === 'repository', 'V7 development task has an unsupported path base');
      const absolute = path.resolve(repositoryRoot, task.taskPath);
      const relation = path.relative(resultRoot, absolute);
      invariant(relation && relation !== '..' && !relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation), 'V7 development task is not under its private result-root control directory');
      return { ...task, taskPathBase: 'result-root', taskPath: relation.split(path.sep).join('/') };
    }),
  };
}

async function bindTaskImages(taskSet, { resultRoot, buildImages }) {
  const tasks = [];
  let taskSetRoot = null;
  for (const task of taskSet.tasks) {
    invariant(task.taskPathBase === 'result-root', 'V7 calibration image binding requires result-root tasks');
    const taskRoot = path.resolve(resultRoot, task.taskPath);
    const relation = path.relative(resultRoot, taskRoot);
    invariant(relation && relation !== '..' && !relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation), 'V7 calibration task escaped its result root before image binding');
    if (taskSetRoot === null) taskSetRoot = path.dirname(taskRoot);
    else invariant(path.dirname(taskRoot) === taskSetRoot, 'V7 calibration task set spans multiple storage roots');
    const images = await buildImages({ taskRoot });
    await bindTerminalV7HarborTaskImageReferences({ taskRoot, images });
    const identity = await terminalV7HarborTaskTreeIdentity({ taskRoot });
    const imageReferences = Object.fromEntries(['environment', 'verifier'].map((kind) => [kind, images[kind].imageId]));
    tasks.push({ ...task, sha256: identity.sha256, fileCount: identity.fileCount, images, imageReferences });
  }
  const bound = { ...taskSet, tasks };
  invariant(taskSetRoot !== null, 'V7 calibration task set is empty during image binding');
  await atomicWriteJson(path.join(taskSetRoot, `manifest-${taskSet.pool}-${taskSet.variant}.json`), bound);
  return bound;
}

function controlRecord({ campaign, challenge, schedule, taskBinding, sealManifest }) {
  const unsigned = {
    schemaVersion: TERMINAL_V7_CALIBRATION_CONTROL_SCHEMA,
    campaign,
    challenge: { id: challenge.challengeId, sha256: challenge.challengeSha256 },
    schedule: { id: schedule.scheduleId, sha256: schedule.scheduleSha256 },
    taskBindingSha256: taskBinding.taskBindingSha256,
    sealManifestSha256: sealManifest.manifestSha256,
    runPolicy: 'one-precommitted-execution-unit-per-invocation',
    modelTextInControlArtifacts: false,
  };
  return { ...unsigned, controlSha256: canonicalJsonSha256(unsigned) };
}

export async function writeTerminalV7CalibrationControl({ resultRoot, campaign, challenge, schedule, taskBinding, sealManifest } = {}) {
  const destination = safeAbsolute(resultRoot, 'V7 calibration result root');
  validateTerminalV7CalibrationChallenge(challenge, { requireExecution: true });
  validateTerminalV7CalibrationSchedule(schedule, challenge);
  validateTerminalV7CalibrationTaskBinding(taskBinding, challenge);
  await assertNoRuns(destination);
  const control = controlRecord({ campaign, challenge, schedule, taskBinding, sealManifest });
  await Promise.all([
    atomicWriteJson(path.join(destination, 'challenge.json'), challenge),
    atomicWriteJson(path.join(destination, 'schedule.json'), schedule),
    atomicWriteJson(path.join(destination, 'control', 'task-binding.json'), taskBinding),
    atomicWriteJson(path.join(destination, 'control', 'calibration-control.json'), control),
  ]);
  return control;
}

export async function buildTerminalV7DevelopmentPilotControl({
  root,
  resultRoot,
  revision,
  sealsPath = null,
  seedKeyPath = null,
  seed = 20_260_808,
  buildTasks = buildHarborTerminalV7Tasks,
  buildTaskImages = buildTerminalV7HarborTaskImages,
  inspectVerifierImage = inspectTerminalV7VerifierImage,
  baseEvidencePath = null,
  validateBaseGates = assertTerminalV7BaseGatesFromFiles,
  revisionControlRoot = null,
  revisionControlEnv = process.env,
} = {}) {
  const repositoryRoot = safeAbsolute(root, 'V7 pilot repository root');
  const destination = safeAbsolute(resultRoot, 'V7 pilot result root');
  validateRevision(revision);
  invariant(Number.isSafeInteger(seed) && seed >= 0 && seed <= 0xffff_ffff, 'V7 pilot schedule seed must be a uint32');
  await assertTerminalV7RevisionAcceptsNewWork({
    controlRoot: path.resolve(revisionControlRoot ?? resolveTerminalV7RevisionControlRoot({ root: repositoryRoot, revision, env: revisionControlEnv })),
    revision,
  });
  await assertNoRuns(destination);
  const { sealManifest, seedKey, paths } = await loadTerminalV7CalibrationSealInputs({ root: repositoryRoot, revision, sealsPath, seedKeyPath });
  const resolvedBaseEvidencePath = path.resolve(baseEvidencePath ?? path.join(destination, 'release-gates-base.json'));
  const baseEvidence = validateTerminalV7BaseGateEvidence(await readJson(resolvedBaseEvidencePath));
  await validateBaseGates({
    root: repositoryRoot,
    resultRoot: destination,
    revision,
    sealsPath: paths.sealsPath,
    seedKeyPath: paths.seedKeyPath,
    goldReportPath: path.join(destination, 'gold', 'gold-report.json'),
    scriptedReferencesPath: path.join(destination, 'control', 'scripted-reference-results.json'),
    qualityEvidencePath: path.join(destination, 'quality-gates.json'),
    requirementMapPath: path.join(repositoryRoot, 'benchmark', 'challenges', 'mini-ledger-v7', 'requirement-map.json'),
    reviewsPath: path.join(destination, 'control', 'independent-reviews.json'),
    testReportPath: path.join(destination, 'test-preflight-report.json'),
    expectedEvidence: baseEvidence,
  });
  const taskRoot = path.join(destination, 'control', 'harbor-tasks');
  const [rawCleanTasks, rawDecoyTasks] = await Promise.all([
    buildTasks({ pool: 'dev', variant: 'clean', resultRoot: destination, outputRoot: taskRoot }),
    buildTasks({ pool: 'dev', variant: 'decoy', resultRoot: destination, outputRoot: taskRoot }),
  ]);
  const cleanTasks = await bindTaskImages(rebaseDevelopmentTaskSet(rawCleanTasks, { repositoryRoot, resultRoot: destination }), { resultRoot: destination, buildImages: buildTaskImages });
  const decoyTasks = await bindTaskImages(rebaseDevelopmentTaskSet(rawDecoyTasks, { repositoryRoot, resultRoot: destination }), { resultRoot: destination, buildImages: buildTaskImages });
  const taskBinding = createTerminalV7CalibrationTaskBinding({ sealManifest, pool: 'dev', seedKey, taskSets: [cleanTasks, decoyTasks] });
  const verifierImage = await inspectVerifierImage();
  const execution = await createTerminalV7CalibrationExecutionBinding({ root: repositoryRoot, revision, sealManifest, taskBinding, verifierImage, baseEvidence });
  const challenge = createTerminalV7CalibrationChallenge({ sealManifest, pool: 'dev', seedKey, execution });
  validateTerminalV7CalibrationChallengeAgainstManifest(challenge, sealManifest, { seedKey });
  validateTerminalV7CalibrationTaskBinding(taskBinding, challenge);
  const harnesses = ['codex-cli', 'pi-coding-agent'].map((id) => ({ id, version: SEALED_TERMINAL_HARNESS_VERSIONS[id] }));
  const schedule = createTerminalV7DevelopmentPilotSchedule({ challenge, harnesses, seed });
  const control = await writeTerminalV7CalibrationControl({ resultRoot: destination, campaign: 'development-pilot', challenge, schedule, taskBinding, sealManifest });
  return {
    challenge,
    schedule,
    taskBinding,
    control,
    baseEvidence,
    inputPaths: { sealsPath: paths.sealsPath, seedKeyPath: '<evaluator-held-private-file>' },
  };
}

export async function buildTerminalV7ReserveControl({
  root,
  resultRoot,
  revision,
  sealManifest,
  seedKey,
  releaseChallenge,
  releaseSchedule,
  releaseResults,
  seed = 20_260_808,
  buildTasks = buildHarborTerminalV7Tasks,
  buildTaskImages = buildTerminalV7HarborTaskImages,
  inspectVerifierImage = inspectTerminalV7VerifierImage,
  revisionControlRoot = null,
  revisionControlEnv = process.env,
} = {}) {
  const repositoryRoot = safeAbsolute(root, 'V7 reserve repository root');
  const destination = safeAbsolute(resultRoot, 'V7 reserve result root');
  validateRevision(revision);
  validateTerminalV7SealManifest(sealManifest, { seedKey });
  invariant(sealManifest.revision === revision, 'V7 reserve seal-manifest revision changed');
  await assertTerminalV7RevisionAcceptsNewWork({
    controlRoot: path.resolve(revisionControlRoot ?? resolveTerminalV7RevisionControlRoot({ root: repositoryRoot, revision, env: revisionControlEnv })),
    revision,
  });
  invariant(Array.isArray(releaseResults) && releaseResults.every((run) => run.status !== 'completed'
    || run.validity !== 'valid'
    || scoreTerminalV7Run(run, releaseChallenge).core.points !== 100), 'V7 reserve build refuses a release Core-100 result pending saturation audit or retirement');
  await assertNoRuns(destination);
  const taskSet = await buildTasks({
    pool: 'reserve',
    variant: 'decoy',
    resultRoot: destination,
    outputRoot: path.join(destination, 'control', 'harbor-tasks'),
    seedKey,
  });
  const imageBoundTaskSet = await bindTaskImages(taskSet, { resultRoot: destination, buildImages: buildTaskImages });
  const taskBinding = createTerminalV7CalibrationTaskBinding({ sealManifest, pool: 'reserve', seedKey, taskSets: [imageBoundTaskSet] });
  const verifierImage = await inspectVerifierImage();
  const execution = await createTerminalV7CalibrationExecutionBinding({
    root: repositoryRoot,
    revision,
    sealManifest,
    taskBinding,
    verifierImage,
    runtimeImages: releaseChallenge?.execution?.runtimeImages ?? null,
    executionHost: releaseChallenge?.execution?.executionHost ?? null,
    reviewedCommit: releaseChallenge?.execution?.commitments?.reviewedCommit ?? null,
  });
  const extension = createTerminalV7ReserveExtension({
    sealManifest,
    seedKey,
    releaseChallenge,
    releaseSchedule,
    releaseResults,
    harnesses: releaseSchedule.matrix.harnesses,
    seed,
    execution,
  });
  validateTerminalV7CalibrationChallengeAgainstManifest(extension.challenge, sealManifest, { seedKey });
  validateTerminalV7CalibrationTaskBinding(taskBinding, extension.challenge);
  const control = await writeTerminalV7CalibrationControl({ resultRoot: destination, campaign: 'reserve-extension', challenge: extension.challenge, schedule: extension.schedule, taskBinding, sealManifest });
  return { ...extension, taskBinding, control };
}
