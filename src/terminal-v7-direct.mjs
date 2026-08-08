import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadV7Pack, materializeV7Starter, sealV7Pack } from '../benchmark/challenges/mini-ledger-v7/pack.mjs';
import { createV7CandidateTrajectoryFailureResult } from '../benchmark/challenges/mini-ledger-v7/verifier.mjs';
import { captureTerminalCandidateTree } from './terminal-candidate-tree.mjs';
import { sha256 } from './provenance.mjs';
import {
  MINI_LEDGER_V7_CANDIDATE_TREE_POLICY,
  MINI_LEDGER_V7_PHASE_COUNT,
  beginV7Phase,
  prepareV7Workspace,
} from './terminal-v7-runtime.mjs';
import { materializeTerminalV7Candidate } from './terminal-v7-overlay.mjs';
import { verifyTerminalV7InContainer } from './terminal-v7-verifier-container.mjs';
import { writeTerminalV7VerifierEvaluationArtifact } from './terminal-v7-verifier-evidence.mjs';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function within(root, relative) {
  invariant(typeof relative === 'string' && relative.length > 0 && !relative.includes('\0') && !path.isAbsolute(relative), `Unsafe V7 artifact path: ${relative ?? 'missing'}`);
  const resolved = path.resolve(root, relative);
  const relation = path.relative(root, resolved);
  invariant(relation && relation !== '..' && !relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation), `V7 artifact path escapes workspace: ${relative}`);
  return resolved;
}

function committedPack(challenge, job) {
  const descriptor = challenge.instances?.find(({ instanceSha256 }) => instanceSha256 === job.instanceSha256);
  invariant(descriptor && descriptor.instanceSha256 === job.instanceSha256, 'V7 job instance is not sealed into the challenge');
  invariant(['clean', 'decoy'].includes(job.instanceVariant), 'V7 direct runs require a declared clean or decoy instance variant');
  const pack = loadV7Pack(job.instanceId, { variant: job.instanceVariant });
  return { descriptor, pack };
}

function assertCommittedPack(descriptor, pack) {
  const commitments = descriptor.packCommitments;
  invariant(commitments?.packSha256 === pack.packSha256, 'V7 runtime pack hash does not match the challenge commitment');
  invariant(commitments.sealSha256 === pack.sealSha256, 'V7 runtime pack seal does not match the challenge commitment');
  invariant(commitments.seedFingerprint === pack.seedFingerprint, 'V7 runtime pack seed fingerprint does not match the challenge commitment');
  invariant(commitments.starterTreeSha256 === pack.starterTreeSha256, 'V7 runtime starter tree does not match the challenge commitment');
  invariant(commitments.requirementsSha256 === pack.requirementsSha256, 'V7 runtime requirements do not match the challenge commitment');
  invariant(commitments.requirementMapSha256 === pack.requirementMapSha256, 'V7 runtime requirement map does not match the challenge commitment');
  invariant(commitments.hiddenMerkleRoot === pack.hiddenMerkleRoot, 'V7 runtime hidden-case commitment does not match the challenge commitment');
  invariant(commitments.twinRelationSha256 === pack.twinRelationSha256, 'V7 runtime twin relation does not match the challenge commitment');
  invariant(commitments.perPhaseLimitMs === pack.perPhaseLimitMs, 'V7 runtime phase limit does not match the challenge commitment');
  invariant(commitments.rubricVersion === pack.rubricVersion && commitments.feedbackPolicy === pack.feedbackPolicy, 'V7 runtime rubric or feedback policy does not match the challenge commitment');
  invariant(JSON.stringify(commitments.phaseDeltaSha256) === JSON.stringify(pack.phaseDeltaSha256), 'V7 runtime phase deltas do not match the challenge commitment');
  invariant(JSON.stringify(commitments.artifactPolicy) === JSON.stringify(pack.artifactPolicy), 'V7 runtime artifact policy does not match the challenge commitment');
  invariant(JSON.stringify(commitments.verifierHashes) === JSON.stringify(pack.verifierHashes), 'V7 runtime verifier hashes do not match the challenge commitment');
}

async function evaluatorSeedKey(pack) {
  if (pack.pool === 'dev') return null;
  if (typeof process.env.AGENTBATTLER_V7_SEED_KEY === 'string' && process.env.AGENTBATTLER_V7_SEED_KEY.length >= 16) return process.env.AGENTBATTLER_V7_SEED_KEY;
  const stateRoot = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const revision = process.env.AGENTBATTLER_TERMINAL_PROTOCOL_REVISION ?? 'r1';
  const keyPath = process.env.AGENTBATTLER_V7_SEED_KEY_FILE ?? path.join(stateRoot, 'automations', 'mini-ledger-v6-scheduled-check', `mini-ledger-v7-${revision}.seed-key`);
  const key = (await readFile(keyPath, 'utf8')).trim();
  invariant(key.length >= 16, 'V7 evaluator seed key is invalid');
  return key;
}

function declaredArtifactPath(phaseControl) {
  const contract = phaseControl?.installed?.contract ?? phaseControl?.contract ?? null;
  return contract?.responsePath ?? contract?.artifacts?.response?.path ?? contract?.artifactPolicy?.responsePath ?? null;
}

async function captureDeclaredArtifact({ workspace, runDirectory, phase, phaseControl }) {
  const relative = declaredArtifactPath(phaseControl);
  if (!relative) return { artifact: null, rejection: null };
  const source = within(workspace, relative);
  let stat;
  try {
    stat = await lstat(source);
  } catch (error) {
    if (error?.code === 'ENOENT') return { artifact: null, rejection: { code: 'missing', path: relative } };
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    return { artifact: null, rejection: { code: 'unsafe-file-type', path: relative } };
  }
  if (stat.size > 64 * 1024) {
    return { artifact: null, rejection: { code: 'size-limit', path: relative, sizeBytes: stat.size } };
  }
  const bytes = await readFile(source);
  const archiveRelative = path.join('phase-artifacts', `phase-${String(phase).padStart(2, '0')}`, relative);
  const archive = within(runDirectory, archiveRelative);
  await mkdir(path.dirname(archive), { recursive: true, mode: 0o700 });
  await copyFile(source, archive);
  return {
    artifact: { path: relative.split(path.sep).join('/'), archivePath: archiveRelative.split(path.sep).join('/'), sizeBytes: bytes.length, sha256: sha256(bytes) },
    rejection: null,
  };
}

async function installDeclaredArtifact({ artifact, runDirectory, workspace }) {
  if (!artifact) return;
  const source = within(runDirectory, artifact.archivePath);
  const destination = within(workspace, artifact.path);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(source, destination);
}

function infrastructureErrors(result) {
  return [
    ...(Array.isArray(result?.infrastructureErrors) ? result.infrastructureErrors : []),
    ...(result?.infrastructureError ? [result.infrastructureError] : []),
  ].filter(Boolean);
}

function phaseStage(result, phaseControl) {
  const requirements = Array.isArray(result?.requirements) ? result.requirements : [];
  const publicRequirements = requirements.filter(({ group, visibility }) => (group ?? visibility) === 'public');
  const passed = result?.passed === true || (publicRequirements.length > 0 && publicRequirements.every((requirement) => requirement.passed === true));
  return {
    id: phaseControl.definition.id,
    phase: phaseControl.definition.phase,
    passed,
    regressions: Number(result?.regressions ?? (passed ? 0 : 1)),
    requirementIds: publicRequirements.map(({ id }) => id),
    diagnostic: passed ? null : 'one or more current public contract checks failed',
  };
}

function candidateTreeRejection(error, { phase, workspace }) {
  const message = String(error?.message ?? error).split(workspace).join('<workspace>').slice(0, 500);
  return Object.freeze({
    schemaVersion: 'agentbattler.terminal-candidate-tree-rejection.v1',
    kind: 'rejected',
    turn: phase,
    code: 'candidate-tree-policy-rejection',
    diagnostic: message,
  });
}

function rejectedTrajectoryResult(state, phase, rejection) {
  return createV7CandidateTrajectoryFailureResult({
    instance: state.pack,
    pack: state.pack,
    phase,
    seedKey: state.seedKey,
    diagnostic: rejection.diagnostic,
  });
}

export async function createTerminalV7DirectState({ challenge, job, runDirectory, workspace }) {
  invariant(challenge?.id === 'terminal-mini-ledger-v7', 'V7 direct state requires the Mini Ledger V7 challenge');
  invariant(path.isAbsolute(runDirectory) && path.isAbsolute(workspace), 'V7 direct run paths must be absolute');
  const { descriptor, pack: canonicalPack } = committedPack(challenge, job);
  const seedKey = await evaluatorSeedKey(canonicalPack);
  const pack = sealV7Pack(canonicalPack, { seedKey });
  assertCommittedPack(descriptor, pack);
  const privateRoot = await mkdtemp(path.join(await realpath(os.tmpdir()), 'agentbattler-v7-trusted-'));
  const baselineDirectory = path.join(privateRoot, 'baseline');
  await mkdir(baselineDirectory, { mode: 0o700 });
  await prepareV7Workspace({ instanceId: pack.instanceId, variant: pack.variant, workspace, baselineDirectory });
  return {
    challenge,
    job,
    runDirectory,
    workspace,
    descriptor,
    pack,
    seedKey,
    privateRoot,
    baselineDirectory,
    phaseControl: null,
    phaseResults: [],
    phaseContracts: {},
    candidateTrees: [],
    declaredArtifacts: [],
    declaredArtifactRejections: [],
    previousCandidateTreeSha256: null,
    verifierSourceSha256: challenge.execution?.verifierImage?.sourceSha256 ?? null,
    verifierImageId: challenge.execution?.verifierImage?.imageId ?? null,
  };
}

export async function beginTerminalV7DirectPhase(state, phase) {
  invariant(phase === state.phaseResults.length + 1 && phase >= 1 && phase <= MINI_LEDGER_V7_PHASE_COUNT, 'V7 phases must execute exactly once in order');
  state.phaseControl = await beginV7Phase({ pack: state.pack, phase, workspace: state.workspace });
  state.phaseContracts[phase] = state.phaseControl.installed.contract;
  return state.phaseControl.prompt;
}

export async function completeTerminalV7DirectPhase(state, phase) {
  invariant(state.phaseControl?.definition?.phase === phase, `V7 phase ${phase} was not installed before verification`);
  let candidateTree;
  try {
    candidateTree = await captureTerminalCandidateTree({
      workspace: state.workspace,
      baseDirectory: state.baselineDirectory,
      runDirectory: state.runDirectory,
      turn: phase,
      policy: MINI_LEDGER_V7_CANDIDATE_TREE_POLICY,
    });
  } catch (error) {
    const rejection = candidateTreeRejection(error, { phase, workspace: state.workspace });
    const result = rejectedTrajectoryResult(state, phase, rejection);
    await writeTerminalV7VerifierEvaluationArtifact({
      runDirectory: state.runDirectory,
      phase,
      source: 'trusted-candidate-tree-rejection',
      evaluation: result,
      boundary: {
        modelCommandCapabilities: 'exactly-zero',
        network: 'denied',
        candidateFilesystem: 'native-sandbox',
        policyDisposition: 'candidate-tree-policy-rejection',
      },
    });
    const stage = phaseStage(result, state.phaseControl);
    state.phaseResults.push(result);
    state.candidateTrees.push(rejection);
    state.declaredArtifacts.push(null);
    state.declaredArtifactRejections.push(null);
    return { result, stage, candidateTree: rejection, artifact: null };
  }
  const { artifact, rejection } = await captureDeclaredArtifact({ workspace: state.workspace, runDirectory: state.runDirectory, phase, phaseControl: state.phaseControl });
  const fresh = path.join(state.privateRoot, `phase-${String(phase).padStart(2, '0')}`);
  await materializeTerminalV7Candidate({
    pack: state.pack,
    candidateTree,
    runDirectory: state.runDirectory,
    destination: fresh,
    baselineDirectory: state.baselineDirectory,
    policy: MINI_LEDGER_V7_CANDIDATE_TREE_POLICY,
  });
  await installDeclaredArtifact({ artifact, runDirectory: state.runDirectory, workspace: fresh });
  const result = await verifyTerminalV7InContainer({
    mode: 'phase',
    pack: state.pack,
    phase,
    workspace: fresh,
    evidenceDirectory: path.join(state.runDirectory, 'verifier-evidence', `phase-${String(phase).padStart(2, '0')}`),
    seedKey: state.seedKey,
    contract: state.phaseContracts[phase],
    phaseContracts: state.phaseContracts,
    phaseResults: state.phaseResults,
    expectedSourceSha256: state.verifierSourceSha256,
    expectedImageId: state.verifierImageId,
  });
  const errors = infrastructureErrors(result);
  invariant(errors.length === 0, `V7 phase ${phase} verifier infrastructure failed: ${errors.join('; ').slice(0, 1000)}`);
  const stage = phaseStage(result, state.phaseControl);
  state.phaseResults.push(result);
  state.candidateTrees.push(candidateTree);
  state.declaredArtifacts.push(artifact);
  state.declaredArtifactRejections.push(rejection);
  state.previousCandidateTreeSha256 = candidateTree.treeSha256;
  return { result, stage, candidateTree, artifact };
}

export async function finishTerminalV7DirectRun(state) {
  invariant(state.phaseResults.length === MINI_LEDGER_V7_PHASE_COUNT && state.candidateTrees.length === MINI_LEDGER_V7_PHASE_COUNT, 'V7 final verification requires all five phases');
  const candidateTree = state.candidateTrees.at(-1);
  const fresh = path.join(state.privateRoot, 'final');
  if (candidateTree.kind === 'overlay') {
    await materializeTerminalV7Candidate({
      pack: state.pack,
      candidateTree,
      runDirectory: state.runDirectory,
      destination: fresh,
      baselineDirectory: state.baselineDirectory,
      policy: MINI_LEDGER_V7_CANDIDATE_TREE_POLICY,
    });
  } else {
    await mkdir(fresh, { recursive: true, mode: 0o700 });
    await materializeV7Starter({ pack: state.pack, destination: fresh });
  }
  const result = await verifyTerminalV7InContainer({
    mode: 'final',
    pack: state.pack,
    workspace: fresh,
    evidenceDirectory: path.join(state.runDirectory, 'verifier-evidence', 'final'),
    seedKey: state.seedKey,
    phaseContracts: state.phaseContracts,
    phaseResults: state.phaseResults,
    expectedSourceSha256: state.verifierSourceSha256,
    expectedImageId: state.verifierImageId,
  });
  const errors = infrastructureErrors(result);
  invariant(errors.length === 0, `V7 final verifier infrastructure failed: ${errors.join('; ').slice(0, 1000)}`);
  return result;
}

export async function disposeTerminalV7DirectState(state) {
  if (state?.privateRoot) await rm(state.privateRoot, { recursive: true, force: true });
}
