import { copyFile, lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  bindV7PhaseEntryContract,
  hashV7ExecutableTree,
  installV7Phase,
  loadV7Pack,
  materializeV7Starter,
} from '../benchmark/challenges/mini-ledger-v7/pack.mjs';
import { canonicalJson, canonicalJsonSha256, sha256File } from './provenance.mjs';
import { snapshotTerminalCandidateTree, validateCapturedTerminalCandidateTree } from './terminal-candidate-tree.mjs';
import { materializeTerminalV7Candidate } from './terminal-v7-overlay.mjs';
import { MINI_LEDGER_V7_CANDIDATE_TREE_POLICY } from './terminal-v7-runtime.mjs';
import { verifyTerminalV7InContainer } from './terminal-v7-verifier-container.mjs';

export const TERMINAL_V7_HUMAN_TWIN_SCHEMA = 'agentbattler.terminal-v7-human-twin-validation.v1';
export const TERMINAL_V7_HUMAN_TWIN_RUN_SCHEMA = 'agentbattler.terminal-v7-human-twin-run-evidence.v1';

const SHA256_RE = /^[0-9a-f]{64}$/;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function safeRelative(value, label) {
  invariant(typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !value.includes('\0'), `${label} path is invalid`);
  const normalized = path.posix.normalize(value.replaceAll(path.sep, '/'));
  invariant(normalized !== '..' && !normalized.startsWith('../'), `${label} path escapes its evidence root`);
  return normalized;
}

function contained(root, relative, label) {
  const normalized = safeRelative(relative, label);
  const resolved = path.resolve(root, ...normalized.split('/'));
  const relation = path.relative(path.resolve(root), resolved);
  invariant(relation && relation !== '..' && !relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation), `${label} escaped its evidence root`);
  return resolved;
}

function validateTwinProjection(projection, variant, label) {
  invariant(projection?.variant === variant && projection.status === 'completed' && projection.validity === 'valid', `${label} ${variant} result is not completed and valid`);
  invariant(Number.isFinite(projection.corePoints) && projection.corePoints >= 0 && projection.corePoints <= 100, `${label} ${variant} Core score is invalid`);
  invariant(typeof projection.exact === 'boolean', `${label} ${variant} Exact flag is invalid`);
  invariant(SHA256_RE.test(projection.candidateTreeSha256 ?? '') && SHA256_RE.test(projection.evaluationSha256 ?? ''), `${label} ${variant} source or evaluation commitment is invalid`);
  safeRelative(projection.evidencePath, `${label} ${variant} evidence`);
  invariant(SHA256_RE.test(projection.evidenceFileSha256 ?? ''), `${label} ${variant} evidence-file hash is invalid`);
  return projection;
}

export function sealTerminalV7HumanTwinValidation(unsigned) {
  invariant(unsigned?.schemaVersion === TERMINAL_V7_HUMAN_TWIN_SCHEMA, 'Unsupported V7 human-twin validation schema');
  const body = { ...unsigned };
  delete body.attestationSha256;
  return { ...body, attestationSha256: canonicalJsonSha256(body) };
}

export function validateTerminalV7HumanTwinValidation(row, {
  revision = null,
  reviewedCommit = null,
  sealManifestSha256 = null,
  verifierImage = null,
} = {}) {
  invariant(row?.schemaVersion === TERMINAL_V7_HUMAN_TWIN_SCHEMA, 'Unsupported V7 human-twin validation schema');
  const { attestationSha256, ...unsigned } = row;
  invariant(SHA256_RE.test(attestationSha256 ?? '') && attestationSha256 === canonicalJsonSha256(unsigned), 'V7 human-twin attestation hash mismatch');
  invariant(typeof row.validatorId === 'string' && row.validatorId.length > 0 && SHA256_RE.test(row.validatorIdentitySha256 ?? ''), 'V7 human validator identity is incomplete');
  invariant(row.independenceDeclaration === true && row.validationMethod === 'human-executable-twin-validation', 'V7 human twin validation method or independence declaration changed');
  invariant(/^r[1-9]\d*$/.test(row.revision ?? '') && /^[0-9a-f]{40}$/.test(row.reviewedCommit ?? ''), 'V7 human twin revision or commit is invalid');
  invariant(SHA256_RE.test(row.sealManifestSha256 ?? '') && /^sha256:[0-9a-f]{64}$/.test(row.verifierImage?.imageId ?? '') && SHA256_RE.test(row.verifierImage?.sourceSha256 ?? ''), 'V7 human twin release commitments are incomplete');
  invariant(typeof row.instanceId === 'string' && /^dev-0[1-3]$/.test(row.instanceId), 'V7 human twin must use a development pack');
  invariant(typeof row.validatedAt === 'string' && Number.isFinite(Date.parse(row.validatedAt)), 'V7 human twin timestamp is invalid');
  validateTwinProjection(row.clean, 'clean', `V7 human twin ${row.instanceId}`);
  validateTwinProjection(row.decoy, 'decoy', `V7 human twin ${row.instanceId}`);
  invariant(row.cleanCorePoints === row.clean.corePoints && row.decoyCorePoints === row.decoy.corePoints, 'V7 human twin score projection differs from its executable evidence');
  if (revision !== null) invariant(row.revision === revision, 'V7 human twin uses another revision');
  if (reviewedCommit !== null) invariant(row.reviewedCommit === reviewedCommit, 'V7 human twin uses another reviewed commit');
  if (sealManifestSha256 !== null) invariant(row.sealManifestSha256 === sealManifestSha256, 'V7 human twin uses another seal manifest');
  if (verifierImage !== null) invariant(row.verifierImage.imageId === verifierImage.imageId && row.verifierImage.sourceSha256 === verifierImage.sourceSha256, 'V7 human twin uses another verifier image');
  return row;
}

function validateRunEvidence(value, row, projection) {
  invariant(value?.schemaVersion === TERMINAL_V7_HUMAN_TWIN_RUN_SCHEMA, 'Unsupported V7 human-twin run-evidence schema');
  const { evidenceSha256, ...unsigned } = value;
  invariant(evidenceSha256 === canonicalJsonSha256(unsigned), 'V7 human-twin run-evidence body hash mismatch');
  invariant(value.validatorId === row.validatorId && value.validatorIdentitySha256 === row.validatorIdentitySha256
    && value.instanceId === row.instanceId && value.variant === projection.variant, 'V7 human-twin run-evidence identity changed');
  invariant(value.status === 'completed' && value.validity === 'valid'
    && value.corePoints === projection.corePoints && value.exact === projection.exact
    && value.candidateTreeSha256 === projection.candidateTreeSha256
    && value.evaluationSha256 === projection.evaluationSha256, 'V7 human-twin run-evidence projection changed');
  invariant(Array.isArray(value.phaseCandidateTrees) && value.phaseCandidateTrees.length === 5
    && value.phaseCandidateTrees.every((tree) => tree?.kind === 'overlay')
    && value.finalCandidateTree?.kind === 'overlay'
    && canonicalJson(value.finalCandidateTree) === canonicalJson(value.phaseCandidateTrees[4])
    && value.candidateTreeSha256 === value.finalCandidateTree.treeSha256, 'V7 human-twin archived five-phase candidate trajectory is incomplete');
  invariant(value.phaseFourArtifact && typeof value.phaseFourArtifact.path === 'string'
    && typeof value.phaseFourArtifact.archivePath === 'string'
    && SHA256_RE.test(value.phaseFourArtifact.sha256 ?? '')
    && Number.isSafeInteger(value.phaseFourArtifact.sizeBytes)
    && value.phaseFourArtifact.sizeBytes >= 0, 'V7 human-twin phase-4 artifact is incomplete');
  invariant(Array.isArray(value.phaseResults) && value.phaseResults.length === 5
    && value.evaluation && canonicalJsonSha256(value.evaluation) === value.evaluationSha256, 'V7 human-twin full mapped evaluation evidence is incomplete');
  invariant(value.verifierImage?.imageId === row.verifierImage.imageId && value.verifierImage?.sourceSha256 === row.verifierImage.sourceSha256, 'V7 human-twin verifier identity changed');
  return value;
}

export async function assertTerminalV7HumanTwinArtifacts({ evidenceRoot, rows, options = {} } = {}) {
  invariant(typeof evidenceRoot === 'string' && path.isAbsolute(evidenceRoot), 'V7 human-twin evidence root must be absolute');
  invariant(Array.isArray(rows) && rows.length > 0, 'V7 human-twin evidence rows are required');
  const artifactCommitments = [];
  const verifyCandidate = options.verifyCandidate ?? verifyTerminalV7InContainer;
  invariant(typeof verifyCandidate === 'function', 'V7 human-twin sealed verifier callback is invalid');
  for (const row of rows) {
    validateTerminalV7HumanTwinValidation(row, options);
    for (const projection of [row.clean, row.decoy]) {
      const relative = safeRelative(projection.evidencePath, 'V7 human-twin run evidence');
      const file = path.resolve(evidenceRoot, ...relative.split('/'));
      const relation = path.relative(evidenceRoot, file);
      invariant(relation && relation !== '..' && !relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation), 'V7 human-twin evidence escaped its root');
      const stat = await lstat(file);
      invariant(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, `V7 human-twin evidence is not one regular file: ${relative}`);
      invariant(await sha256File(file) === projection.evidenceFileSha256, `V7 human-twin evidence file hash mismatch: ${relative}`);
      const runEvidence = validateRunEvidence(JSON.parse(await readFile(file, 'utf8')), row, projection);
      const pack = loadV7Pack(row.instanceId, { variant: projection.variant });
      const temporary = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-v7-human-twin-'));
      try {
        const baselineDirectory = path.join(temporary, 'baseline');
        await mkdir(baselineDirectory, { recursive: true, mode: 0o700 });
        await materializeV7Starter({ pack, destination: baselineDirectory });
        const baseline = await snapshotTerminalCandidateTree({ root: baselineDirectory, policy: MINI_LEDGER_V7_CANDIDATE_TREE_POLICY });
        for (const candidateTree of runEvidence.phaseCandidateTrees) {
          await validateCapturedTerminalCandidateTree({ runDirectory: evidenceRoot, evidence: candidateTree, base: baseline });
        }
        const phaseWorkspaces = [];
        const recomputedPhaseResults = [];
        const artifactSource = contained(evidenceRoot, runEvidence.phaseFourArtifact.archivePath, 'V7 human-twin phase-4 artifact');
        const artifactStat = await lstat(artifactSource);
        invariant(artifactStat.isFile() && !artifactStat.isSymbolicLink() && artifactStat.nlink === 1
          && artifactStat.size === runEvidence.phaseFourArtifact.sizeBytes
          && await sha256File(artifactSource) === runEvidence.phaseFourArtifact.sha256, 'V7 human-twin phase-4 artifact bytes changed');
        for (let phase = 1; phase <= 5; phase += 1) {
          const workspace = path.join(temporary, `phase-${String(phase).padStart(2, '0')}`);
          phaseWorkspaces.push(workspace);
          await materializeTerminalV7Candidate({
            pack,
            candidateTree: runEvidence.phaseCandidateTrees[phase - 1],
            runDirectory: evidenceRoot,
            destination: workspace,
            baselineDirectory,
            policy: MINI_LEDGER_V7_CANDIDATE_TREE_POLICY,
          });
          const current = path.join(workspace, '.agentbattler', 'current');
          await mkdir(current, { recursive: true, mode: 0o700 });
          const installed = await installV7Phase({ pack, phase, destination: current });
          const contract = phase === 4
            ? bindV7PhaseEntryContract(installed.contract, await hashV7ExecutableTree(workspace))
            : installed.contract;
          if (phase === 4) {
            invariant(runEvidence.phaseFourArtifact.path === contract.responsePath, 'V7 human-twin phase-4 artifact names another contract path');
            const artifactTarget = path.resolve(workspace, runEvidence.phaseFourArtifact.path);
            const artifactRelation = path.relative(workspace, artifactTarget);
            invariant(artifactRelation && artifactRelation !== '..' && !artifactRelation.startsWith(`..${path.sep}`) && !path.isAbsolute(artifactRelation), 'V7 human-twin phase-4 artifact path escapes the candidate workspace');
            await mkdir(path.dirname(artifactTarget), { recursive: true, mode: 0o700 });
            await copyFile(artifactSource, artifactTarget);
          }
          const phaseResult = await verifyCandidate({
            mode: 'phase', pack, phase, workspace,
            evidenceDirectory: path.join(temporary, `verifier-phase-${String(phase).padStart(2, '0')}`), contract,
            phaseResults: recomputedPhaseResults,
            verifierSeedIndex: 0,
            expectedSourceSha256: row.verifierImage.sourceSha256,
            expectedImageId: row.verifierImage.imageId,
          });
          invariant(Array.isArray(phaseResult.infrastructureErrors) && phaseResult.infrastructureErrors.length === 0, `V7 human-twin phase-${phase} verifier was infrastructure-invalid`);
          recomputedPhaseResults.push(phaseResult);
        }
        const recomputed = await verifyCandidate({
          mode: 'final', pack, workspace: phaseWorkspaces[4],
          evidenceDirectory: path.join(temporary, 'verifier-final'), phaseResults: recomputedPhaseResults,
          verifierSeedIndex: 0,
          expectedSourceSha256: row.verifierImage.sourceSha256,
          expectedImageId: row.verifierImage.imageId,
        });
        const scoreView = (evaluation) => ({
          score: evaluation.score ?? null,
          maxScore: evaluation.maxScore ?? null,
          publicScore: evaluation.publicScore ?? null,
          privateScore: evaluation.privateScore ?? null,
          passed: evaluation.passed ?? null,
          requirements: evaluation.requirements ?? [],
          families: evaluation.families ?? [],
          adaptability: evaluation.adaptability ?? null,
          infrastructureErrors: evaluation.infrastructureErrors ?? [],
        });
        invariant(runEvidence.phaseResults.every((phaseResult, index) => canonicalJson(scoreView(phaseResult)) === canonicalJson(scoreView(recomputedPhaseResults[index]))), 'V7 human-twin phase score does not reproduce from its archived candidate bytes');
        invariant(canonicalJson(scoreView(recomputed)) === canonicalJson(scoreView(runEvidence.evaluation)), 'V7 human-twin score does not reproduce from archived candidate bytes in the sealed verifier');
        invariant(projection.corePoints === recomputed.score && projection.exact === (recomputed.score === recomputed.maxScore && recomputed.infrastructureErrors.length === 0), 'V7 human-twin score projection differs from sealed verifier output');
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
      artifactCommitments.push({ path: relative, sha256: projection.evidenceFileSha256 });
    }
  }
  artifactCommitments.sort((left, right) => left.path.localeCompare(right.path));
  invariant(new Set(artifactCommitments.map(({ path: relative }) => relative)).size === artifactCommitments.length, 'V7 human-twin evidence file is reused');
  return {
    schemaVersion: 'agentbattler.terminal-v7-human-twin-artifact-closure.v1',
    rowsSha256: canonicalJsonSha256(rows),
    artifactsSha256: canonicalJsonSha256(artifactCommitments),
  };
}
