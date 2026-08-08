#!/usr/bin/env node
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  bindV7PhaseEntryContract,
  hashV7ExecutableTree,
  installV7Phase,
  loadV7Pack,
  sealV7Pack,
  V7_POOL_INSTANCES,
} from '../benchmark/challenges/mini-ledger-v7/pack.mjs';
import { V7_FAMILIES } from '../benchmark/challenges/mini-ledger-v7/requirements.mjs';
import {
  materializeFreshGoldImplementationA,
  prepareGoldImplementationAPhase,
} from '../benchmark/challenges/mini-ledger-v7/gold/implementation-a/materialize.mjs';
import {
  materializeFreshGoldImplementationB,
  prepareGoldImplementationBPhase,
} from '../benchmark/challenges/mini-ledger-v7/gold/implementation-b/materialize.mjs';
import { canonicalJson, canonicalJsonSha256, sha256File } from '../src/provenance.mjs';
import {
  inspectTerminalV7VerifierImage,
  terminalV7VerifierSourceDescriptor,
  verifyTerminalV7InContainer,
} from '../src/terminal-v7-verifier-container.mjs';
import { validateTerminalV7SealManifest } from '../src/terminal-v7-seals.mjs';

export const TERMINAL_V7_GOLD_REPORT_SCHEMA = 'agentbattler.terminal-v7-gold-report.v1';
export const TERMINAL_V7_GOLD_ROW_EVIDENCE_SCHEMA = 'agentbattler.terminal-v7-gold-row-evidence.v1';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMPLEMENTATIONS = Object.freeze([
  Object.freeze({
    id: 'implementation-a',
    root: 'benchmark/challenges/mini-ledger-v7/gold/implementation-a',
    materialize: materializeFreshGoldImplementationA,
    phaseFour: prepareGoldImplementationAPhase,
  }),
  Object.freeze({
    id: 'implementation-b',
    root: 'benchmark/challenges/mini-ledger-v7/gold/implementation-b',
    materialize: materializeFreshGoldImplementationB,
    phaseFour: prepareGoldImplementationBPhase,
  }),
]);

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

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? null : process.argv[index + 1];
}

async function prepareImmutableOutputDirectory(directory) {
  try {
    const entries = await readdir(directory);
    invariant(entries.length === 0, 'Refusing to overwrite existing V7 gold evidence');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
}

async function evaluatorSeedKey(revision) {
  if (typeof process.env.AGENTBATTLER_V7_SEED_KEY === 'string' && process.env.AGENTBATTLER_V7_SEED_KEY.length >= 16) return process.env.AGENTBATTLER_V7_SEED_KEY;
  const stateRoot = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const file = path.resolve(process.env.AGENTBATTLER_V7_SEED_KEY_FILE
    ?? path.join(stateRoot, 'automations', 'mini-ledger-v6-scheduled-check', `mini-ledger-v7-${revision}.seed-key`));
  const key = (await readFile(file, 'utf8')).trim();
  invariant(key.length >= 16, 'V7 evaluator seed key is invalid');
  return key;
}

async function sourceRecords(root, relative = '') {
  const entries = [];
  for (const entry of (await readdir(path.join(root, relative), { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    const child = relative ? path.posix.join(relative, entry.name) : entry.name;
    const absolute = path.join(root, ...child.split('/'));
    const stat = await lstat(absolute);
    invariant(!stat.isSymbolicLink(), `Gold source contains a symlink: ${child}`);
    if (stat.isDirectory()) entries.push(...await sourceRecords(root, child));
    else {
      invariant(stat.isFile(), `Gold source contains a non-regular entry: ${child}`);
      entries.push({ path: child, sha256: await sha256File(absolute) });
    }
  }
  return entries;
}

async function verifierArtifactRecords(evidenceRoot, directory, relative = '') {
  const records = [];
  for (const entry of (await readdir(path.join(directory, relative), { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    const child = relative ? path.posix.join(relative, entry.name) : entry.name;
    const absolute = path.join(directory, ...child.split('/'));
    const stat = await lstat(absolute);
    invariant(!stat.isSymbolicLink(), `Verifier evidence contains a symlink: ${child}`);
    if (stat.isDirectory()) records.push(...await verifierArtifactRecords(evidenceRoot, directory, child));
    else {
      invariant(stat.isFile() && stat.nlink === 1, `Verifier evidence contains a non-regular or hardlinked entry: ${child}`);
      const rootRelative = path.relative(evidenceRoot, absolute).split(path.sep).join('/');
      safeRelative(rootRelative, `Verifier evidence ${child}`);
      records.push({ path: rootRelative, size: stat.size, sha256: await sha256File(absolute) });
    }
  }
  return records;
}

async function implementationDescriptor(implementation, repositoryRoot = ROOT) {
  const root = path.join(repositoryRoot, implementation.root);
  const files = await sourceRecords(root);
  return {
    implementationId: implementation.id,
    sourceRoot: implementation.root,
    fileCount: files.length,
    sourceSha256: canonicalJsonSha256(files),
  };
}

export async function terminalV7GoldImplementationDescriptors({ root = ROOT } = {}) {
  invariant(typeof root === 'string' && path.isAbsolute(root), 'V7 gold repository root must be absolute');
  return Promise.all(IMPLEMENTATIONS.map((implementation) => implementationDescriptor(implementation, root)));
}

async function prepareGoldWorkspace({ implementation, pack, destination }) {
  await implementation.materialize({ destination, pack });
  const control = path.join(destination, '.agentbattler', 'current');
  await mkdir(control, { recursive: true, mode: 0o700 });
  const installed = await installV7Phase({ pack, phase: 4, destination: control });
  const executableSourceSha256 = await hashV7ExecutableTree(destination);
  const contract = bindV7PhaseEntryContract(installed.contract, executableSourceSha256);
  await writeFile(path.join(control, 'task-contract.json'), `${canonicalJson(contract, { space: 2 })}\n`, { mode: 0o400 });
  await implementation.phaseFour({ destination, phase: 4 });
  invariant(await hashV7ExecutableTree(destination) === executableSourceSha256, `${implementation.id} changed executable source during phase 4`);
  return { contract, executableSourceSha256 };
}

function validateEvaluation(evaluation, label) {
  invariant(evaluation?.schemaVersion === 'agentbattler.mini-ledger-v7.verification.v1', `${label} verification schema changed`);
  invariant(Array.isArray(evaluation?.infrastructureErrors) && evaluation.infrastructureErrors.length === 0, `${label} produced verifier infrastructure errors`);
  invariant(evaluation.score === 100 && evaluation.maxScore === 100
    && evaluation.publicScore === 20 && evaluation.privateScore === 80
    && evaluation.passed === true, `${label} did not score 100`);
  invariant(evaluation.adaptability?.passed === 5 && evaluation.adaptability?.total === 5, `${label} did not preserve all five phase checkpoints`);
  invariant(Array.isArray(evaluation.requirements) && evaluation.requirements.length > 0
    && evaluation.requirements.every(({ passed, points, weight }) => passed === true && points === weight)
    && evaluation.requirements.reduce((sum, { points }) => sum + points, 0) === 100
    && evaluation.requirements.reduce((sum, { weight }) => sum + weight, 0) === 100, `${label} failed or omitted a requirement`);
  invariant(Array.isArray(evaluation.families) && evaluation.families.length === 5
    && evaluation.families.every(({ public: publicScore, hidden, hiddenAtomic, hiddenComposed }) => (
      publicScore.passed === 4 && publicScore.total === 4
      && hiddenAtomic.passed === 6 && hiddenAtomic.total === 6
      && hiddenComposed.passed === 10 && hiddenComposed.total === 10
      && hidden.passed === 16 && hidden.total === 16
    ))
    && JSON.stringify(evaluation.families.map(({ id }) => id).sort()) === JSON.stringify([...V7_FAMILIES].sort()), `${label} family scores changed`);
}

function evaluationEvidence(evaluation, verifierArtifacts) {
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
    verifierArtifacts,
    verifierArtifactsSha256: canonicalJsonSha256(verifierArtifacts),
  };
}

function sealGoldEvaluation(evaluation, verifierArtifacts) {
  invariant(Array.isArray(verifierArtifacts) && verifierArtifacts.length > 0, 'V7 gold evaluation omitted raw verifier artifacts');
  const unsigned = evaluationEvidence(evaluation, verifierArtifacts);
  return { ...unsigned, evaluationSha256: canonicalJsonSha256(unsigned) };
}

async function validateSealedGoldEvaluation(evaluation, {
  evidenceRoot,
  implementationId,
  instanceId,
  variant,
  verifierSeedIndex,
  label,
} = {}) {
  const { evaluationSha256, ...unsigned } = evaluation ?? {};
  invariant(/^[0-9a-f]{64}$/.test(evaluationSha256 ?? '')
    && evaluationSha256 === canonicalJsonSha256(unsigned), `${label} evaluation seal mismatch`);
  validateEvaluation(evaluation, label);
  invariant(evaluation.challengeId === 'terminal-mini-ledger-v7'
    && evaluation.instanceId === instanceId
    && evaluation.variant === variant
    && evaluation.phase === null
    && evaluation.verifierSeedIndex === verifierSeedIndex, `${label} evaluation identity changed`);
  invariant(Array.isArray(evaluation.seedCommitments) && evaluation.seedCommitments.length > 0, `${label} seed commitments are missing`);
  const seedIds = new Set();
  for (const commitment of evaluation.seedCommitments) {
    invariant(typeof commitment.id === 'string' && commitment.id.length > 0 && !seedIds.has(commitment.id), `${label} seed commitment IDs are invalid`);
    seedIds.add(commitment.id);
    invariant(/^[0-9a-f]{64}$/.test(commitment.masterCommitment ?? '')
      && /^[0-9a-f]{64}$/.test(commitment.variantCommitment ?? ''), `${label} seed commitment is invalid`);
  }
  invariant(Array.isArray(evaluation.verifierArtifacts) && evaluation.verifierArtifacts.length > 0
    && evaluation.verifierArtifactsSha256 === canonicalJsonSha256(evaluation.verifierArtifacts), `${label} verifier artifact inventory changed`);
  const artifactPaths = new Set();
  const expectedArtifactPrefix = `evidence/${implementationId}/${instanceId}/${variant}/seed-${String(verifierSeedIndex).padStart(3, '0')}/`;
  for (const artifact of evaluation.verifierArtifacts) {
    const normalized = safeRelative(artifact.path, `${label} verifier artifact`);
    invariant(normalized.startsWith(expectedArtifactPrefix), `${label} verifier artifact belongs to another execution`);
    invariant(!artifactPaths.has(normalized), `${label} verifier artifact is duplicated`);
    artifactPaths.add(normalized);
    invariant(Number.isSafeInteger(artifact.size) && artifact.size >= 0 && /^[0-9a-f]{64}$/.test(artifact.sha256 ?? ''), `${label} verifier artifact descriptor is invalid`);
    const file = contained(evidenceRoot, normalized, `${label} verifier artifact`);
    const stat = await lstat(file);
    invariant(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size === artifact.size, `${label} verifier artifact is not the sealed regular file`);
    invariant(await sha256File(file) === artifact.sha256, `${label} verifier artifact hash mismatch`);
  }
  return evaluation;
}

function goldRowEvidenceUnsigned({
  revision,
  implementation,
  pool,
  instanceId,
  variant,
  pack,
  executableSourceSha256,
  verifierImage,
  evaluations,
}) {
  return {
    schemaVersion: TERMINAL_V7_GOLD_ROW_EVIDENCE_SCHEMA,
    challengeId: 'terminal-mini-ledger-v7',
    revision,
    implementationId: implementation.id,
    pool,
    instanceId,
    variant,
    packSha256: pack.packSha256,
    sealSha256: pack.sealSha256,
    executableSourceSha256,
    verifierImage: {
      imageId: verifierImage.imageId,
      sourceSha256: verifierImage.sourceSha256,
    },
    verifierSeeds: evaluations.length,
    evaluations,
    resultsSha256: canonicalJsonSha256(evaluations.map(({ evaluationSha256 }) => evaluationSha256)),
  };
}

async function validateGoldRowEvidence(evidence, { evidenceRoot, report, row, implementation } = {}) {
  invariant(evidence?.schemaVersion === TERMINAL_V7_GOLD_ROW_EVIDENCE_SCHEMA, 'Unsupported V7 gold-row evidence schema');
  const { evidenceSha256, ...unsigned } = evidence;
  invariant(/^[0-9a-f]{64}$/.test(evidenceSha256 ?? '')
    && evidenceSha256 === canonicalJsonSha256(unsigned), 'V7 gold-row evidence hash mismatch');
  invariant(evidence.challengeId === 'terminal-mini-ledger-v7'
    && evidence.revision === report.revision
    && evidence.implementationId === row.implementationId
    && evidence.pool === row.pool
    && evidence.instanceId === row.instanceId
    && evidence.variant === row.variant, 'V7 gold-row evidence identity changed');
  invariant(evidence.packSha256 === row.packSha256
    && evidence.sealSha256 === row.sealSha256
    && evidence.executableSourceSha256 === row.executableSourceSha256, 'V7 gold-row source or pack commitment changed');
  invariant(evidence.verifierImage?.imageId === report.verifierImage.imageId
    && evidence.verifierImage?.sourceSha256 === report.verifierImage.sourceSha256, 'V7 gold-row verifier image changed');
  invariant(implementation?.sourceSha256 && implementation.sourceSha256 === report.implementations.find(({ implementationId }) => implementationId === row.implementationId)?.sourceSha256, 'V7 gold-row implementation source changed');
  invariant(evidence.verifierSeeds === 100 && Array.isArray(evidence.evaluations) && evidence.evaluations.length === 100, 'V7 gold-row must preserve all 100 verifier seeds');
  for (let index = 0; index < evidence.evaluations.length; index += 1) {
    await validateSealedGoldEvaluation(evidence.evaluations[index], {
      evidenceRoot,
      implementationId: row.implementationId,
      instanceId: row.instanceId,
      variant: row.variant,
      verifierSeedIndex: index,
      label: `${row.implementationId}/${row.instanceId}/${row.variant}/seed-${index}`,
    });
  }
  const resultsSha256 = canonicalJsonSha256(evidence.evaluations.map(({ evaluationSha256 }) => evaluationSha256));
  invariant(evidence.resultsSha256 === resultsSha256 && row.resultsSha256 === resultsSha256, 'V7 gold-row result commitments changed');
  return evidence;
}

export function validateTerminalV7GoldReport(report, {
  revision = null,
  expectedVerifierImage = null,
} = {}) {
  invariant(report?.schemaVersion === TERMINAL_V7_GOLD_REPORT_SCHEMA, 'Unsupported V7 gold-report schema');
  const { reportSha256, ...unsigned } = report;
  invariant(reportSha256 === canonicalJsonSha256(unsigned), 'V7 gold-report hash mismatch');
  invariant(/^r[1-9]\d*$/.test(report.revision ?? ''), 'V7 gold-report revision is invalid');
  invariant(report.challengeId === 'terminal-mini-ledger-v7', 'V7 gold-report challenge changed');
  if (revision !== null) invariant(report.revision === revision, 'V7 gold-report revision changed');
  invariant(typeof report.createdAt === 'string' && Number.isFinite(Date.parse(report.createdAt)), 'V7 gold-report timestamp is invalid');
  invariant(report.policy?.independentImplementations === 2
    && JSON.stringify(report.policy?.variants) === JSON.stringify(['clean', 'decoy'])
    && report.policy?.verifierSeeds === 100
    && report.policy?.verifierBoundary === 'sealed-linux-strace-container', 'V7 gold-report policy is not release qualifying');
  invariant(/^sha256:[0-9a-f]{64}$/.test(report.verifierImage?.imageId ?? '')
    && /^[0-9a-f]{64}$/.test(report.verifierImage?.sourceSha256 ?? ''), 'V7 gold-report verifier identity is invalid');
  if (expectedVerifierImage !== null) {
    invariant(report.verifierImage.imageId === expectedVerifierImage.imageId
      && report.verifierImage.sourceSha256 === expectedVerifierImage.sourceSha256, 'V7 gold-report used another verifier image');
  }
  invariant(Array.isArray(report.implementations) && report.implementations.length === 2, 'V7 gold-report requires two implementations');
  invariant(new Set(report.implementations.map(({ implementationId }) => implementationId)).size === 2
    && new Set(report.implementations.map(({ sourceSha256 }) => sourceSha256)).size === 2, 'V7 gold implementations are not independent');
  invariant(report.implementations.every(({ fileCount, sourceSha256 }) => Number.isSafeInteger(fileCount) && fileCount > 0 && /^[0-9a-f]{64}$/.test(sourceSha256 ?? '')), 'V7 gold implementation descriptor is invalid');

  const expectedRows = new Set();
  for (const implementationId of report.implementations.map(({ implementationId }) => implementationId)) {
    for (const [pool, instanceIds] of Object.entries(V7_POOL_INSTANCES)) {
      for (const instanceId of instanceIds) {
        for (const variant of ['clean', 'decoy']) expectedRows.add(`${implementationId}\0${pool}\0${instanceId}\0${variant}`);
      }
    }
  }
  invariant(Array.isArray(report.rows) && report.rows.length === expectedRows.size, 'V7 gold-report matrix is incomplete');
  const observed = new Set();
  const evidencePaths = new Set();
  for (const row of report.rows) {
    const key = `${row.implementationId}\0${row.pool}\0${row.instanceId}\0${row.variant}`;
    invariant(expectedRows.has(key) && !observed.has(key), `V7 gold-report has an unexpected or duplicate row: ${key}`);
    observed.add(key);
    invariant(row.verifierSeeds === 100 && row.minimumCore === 100 && row.exactCount === 100 && row.infrastructureInvalid === 0, `V7 gold row did not qualify: ${key}`);
    invariant(/^[0-9a-f]{64}$/.test(row.packSha256 ?? '')
      && /^[0-9a-f]{64}$/.test(row.sealSha256 ?? '')
      && /^[0-9a-f]{64}$/.test(row.executableSourceSha256 ?? '')
      && /^[0-9a-f]{64}$/.test(row.resultsSha256 ?? '')
      && /^[0-9a-f]{64}$/.test(row.evidenceFileSha256 ?? ''), `V7 gold row commitments are invalid: ${key}`);
    const evidencePath = safeRelative(row.evidencePath, `V7 gold row ${key}`);
    invariant(!evidencePaths.has(evidencePath), `V7 gold-report reuses row evidence: ${evidencePath}`);
    evidencePaths.add(evidencePath);
  }
  invariant(observed.size === expectedRows.size, 'V7 gold-report matrix identities are incomplete');
  invariant(report.summary?.independentImplementations === 2
    && report.summary?.verifierSeeds === 100
    && report.summary?.cleanMinCore === 100
    && report.summary?.decoyMinCore === 100
    && report.summary?.infrastructureInvalid === 0, 'V7 gold-report summary is not release qualifying');
  return report;
}

export async function assertTerminalV7GoldReportArtifacts({
  evidenceRoot,
  root = ROOT,
  report,
  sealManifest,
} = {}) {
  invariant(typeof evidenceRoot === 'string' && path.isAbsolute(evidenceRoot), 'V7 gold evidence root must be absolute');
  validateTerminalV7GoldReport(report, { revision: sealManifest?.revision ?? null });
  validateTerminalV7SealManifest(sealManifest);
  invariant(report.revision === sealManifest.revision, 'V7 gold report and seal manifest revisions differ');
  const implementations = await terminalV7GoldImplementationDescriptors({ root });
  invariant(canonicalJson(implementations) === canonicalJson(report.implementations), 'V7 gold implementation source descriptors changed');
  const byImplementation = new Map(implementations.map((implementation) => [implementation.implementationId, implementation]));
  const implementationById = new Map(IMPLEMENTATIONS.map((implementation) => [implementation.id, implementation]));
  const materializedRoot = await mkdtemp(path.join(await realpath(os.tmpdir()), 'agentbattler-v7-gold-audit-'));
  try {
    for (const [index, row] of report.rows.entries()) {
      const twin = sealManifest.packs.find(({ pool, instanceId }) => pool === row.pool && instanceId === row.instanceId);
      const sealedPack = twin?.[row.variant];
      invariant(sealedPack?.packSha256 === row.packSha256 && sealedPack?.sealSha256 === row.sealSha256, `V7 gold row uses another sealed pack: ${row.instanceId}/${row.variant}`);
      const implementation = implementationById.get(row.implementationId);
      invariant(implementation, `Unknown V7 gold implementation: ${row.implementationId}`);
      const workspace = path.join(materializedRoot, `${String(index).padStart(2, '0')}-${row.implementationId}-${row.instanceId}-${row.variant}`);
      await implementation.materialize({ destination: workspace, pack: sealedPack });
      invariant(await hashV7ExecutableTree(workspace) === row.executableSourceSha256, `V7 gold executable source no longer reproduces: ${row.implementationId}/${row.instanceId}/${row.variant}`);
      const evidenceFile = contained(evidenceRoot, row.evidencePath, `V7 gold row ${row.instanceId}/${row.variant}`);
      const stat = await lstat(evidenceFile);
      invariant(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, `V7 gold-row evidence is not a safe regular file: ${row.evidencePath}`);
      invariant(await sha256File(evidenceFile) === row.evidenceFileSha256, `V7 gold-row evidence file hash mismatch: ${row.evidencePath}`);
      const evidence = JSON.parse(await readFile(evidenceFile, 'utf8'));
      await validateGoldRowEvidence(evidence, { evidenceRoot, report, row, implementation: byImplementation.get(row.implementationId) });
    }
  } finally {
    await rm(materializedRoot, { recursive: true, force: true });
  }
  return {
    reportSha256: report.reportSha256,
    implementationSourceSha256: Object.fromEntries(implementations.map(({ implementationId, sourceSha256 }) => [implementationId, sourceSha256])),
    rowEvidenceSha256: canonicalJsonSha256(report.rows.map(({ evidencePath, evidenceFileSha256, resultsSha256 }) => ({ evidencePath, evidenceFileSha256, resultsSha256 }))),
  };
}

export async function validateTerminalV7Golds({
  revision = 'r2',
  pools = ['dev', 'release', 'reserve'],
  variants = ['clean', 'decoy'],
  verifierSeeds = 100,
  outputDirectory,
  seedKey,
} = {}) {
  invariant(/^r[1-9]\d*$/.test(revision), 'V7 gold revision must look like r1');
  invariant(Array.isArray(pools) && pools.length > 0 && pools.every((pool) => Object.hasOwn(V7_POOL_INSTANCES, pool)), 'V7 gold pools are invalid');
  invariant(Array.isArray(variants) && variants.length > 0 && variants.every((variant) => ['clean', 'decoy'].includes(variant)), 'V7 gold variants are invalid');
  invariant(Number.isSafeInteger(verifierSeeds) && verifierSeeds >= 1 && verifierSeeds <= 100, 'V7 gold verifierSeeds must be in [1, 100]');
  invariant(typeof outputDirectory === 'string' && path.isAbsolute(outputDirectory), 'V7 gold output directory must be absolute');
  const effectiveKey = seedKey ?? (pools.some((pool) => pool !== 'dev') ? await evaluatorSeedKey(revision) : null);
  const verifierSource = await terminalV7VerifierSourceDescriptor();
  const verifierImage = await inspectTerminalV7VerifierImage({ expectedSourceSha256: verifierSource.sourceSha256 });
  const implementationDescriptors = await terminalV7GoldImplementationDescriptors();
  invariant(new Set(implementationDescriptors.map(({ sourceSha256 }) => sourceSha256)).size === 2, 'V7 gold implementations are not source-independent');
  await prepareImmutableOutputDirectory(outputDirectory);
  const temporaryRoot = await mkdtemp(path.join(await realpath(os.tmpdir()), 'agentbattler-v7-gold-gate-'));
  const rows = [];
  try {
    for (const implementation of IMPLEMENTATIONS) {
      for (const pool of pools) {
        for (const instanceId of V7_POOL_INSTANCES[pool]) {
          for (const variant of variants) {
            const canonicalPack = loadV7Pack(instanceId, { variant });
            const packKey = pool === 'dev' ? null : effectiveKey;
            const pack = sealV7Pack(canonicalPack, { seedKey: packKey });
            const workspace = path.join(temporaryRoot, `${implementation.id}-${instanceId}-${variant}`);
            const { contract, executableSourceSha256 } = await prepareGoldWorkspace({ implementation, pack, destination: workspace });
            const evaluations = [];
            let minimumCore = 100;
            for (let verifierSeedIndex = 0; verifierSeedIndex < verifierSeeds; verifierSeedIndex += 1) {
              const evidenceDirectory = path.join(outputDirectory, 'evidence', implementation.id, instanceId, variant, `seed-${String(verifierSeedIndex).padStart(3, '0')}`);
              const evaluation = await verifyTerminalV7InContainer({
                mode: 'final',
                pack,
                workspace,
                evidenceDirectory,
                seedKey: packKey,
                verifierSeedIndex,
                phaseContracts: { 4: contract },
                expectedSourceSha256: verifierImage.sourceSha256,
                expectedImageId: verifierImage.imageId,
              });
              validateEvaluation(evaluation, `${implementation.id}/${instanceId}/${variant}/seed-${verifierSeedIndex}`);
              minimumCore = Math.min(minimumCore, evaluation.score);
              const artifacts = await verifierArtifactRecords(outputDirectory, evidenceDirectory);
              evaluations.push(sealGoldEvaluation(evaluation, artifacts));
            }
            const unsignedEvidence = goldRowEvidenceUnsigned({
              revision,
              implementation,
              pool,
              instanceId,
              variant,
              pack,
              executableSourceSha256,
              verifierImage,
              evaluations,
            });
            const rowEvidence = { ...unsignedEvidence, evidenceSha256: canonicalJsonSha256(unsignedEvidence) };
            const evidencePath = path.posix.join('row-evidence', implementation.id, `${instanceId}-${variant}.json`);
            const evidenceFile = path.join(outputDirectory, ...evidencePath.split('/'));
            await mkdir(path.dirname(evidenceFile), { recursive: true, mode: 0o700 });
            await writeFile(evidenceFile, `${canonicalJson(rowEvidence, { space: 2 })}\n`, { mode: 0o600, flag: 'wx' });
            rows.push({
              implementationId: implementation.id,
              pool,
              instanceId,
              variant,
              packSha256: pack.packSha256,
              sealSha256: pack.sealSha256,
              executableSourceSha256,
              verifierSeeds,
              minimumCore,
              exactCount: verifierSeeds,
              infrastructureInvalid: 0,
              resultsSha256: rowEvidence.resultsSha256,
              evidencePath,
              evidenceFileSha256: await sha256File(evidenceFile),
            });
          }
        }
      }
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  const unsigned = {
    schemaVersion: TERMINAL_V7_GOLD_REPORT_SCHEMA,
    challengeId: 'terminal-mini-ledger-v7',
    revision,
    createdAt: new Date().toISOString(),
    policy: {
      independentImplementations: 2,
      variants: [...variants],
      verifierSeeds,
      verifierBoundary: 'sealed-linux-strace-container',
    },
    verifierImage: { image: verifierImage.image, imageId: verifierImage.imageId, sourceSha256: verifierImage.sourceSha256 },
    implementations: implementationDescriptors,
    rows,
    summary: {
      independentImplementations: 2,
      verifierSeeds,
      cleanMinCore: Math.min(...rows.filter(({ variant }) => variant === 'clean').map(({ minimumCore }) => minimumCore)),
      decoyMinCore: Math.min(...rows.filter(({ variant }) => variant === 'decoy').map(({ minimumCore }) => minimumCore)),
      infrastructureInvalid: rows.reduce((sum, { infrastructureInvalid }) => sum + infrastructureInvalid, 0),
    },
  };
  const report = { ...unsigned, reportSha256: canonicalJsonSha256(unsigned) };
  const fullReleaseMatrix = verifierSeeds === 100
    && JSON.stringify(pools) === JSON.stringify(['dev', 'release', 'reserve'])
    && JSON.stringify(variants) === JSON.stringify(['clean', 'decoy']);
  if (fullReleaseMatrix) validateTerminalV7GoldReport(report, { revision, expectedVerifierImage: verifierImage });
  await writeFile(path.join(outputDirectory, 'gold-report.json'), `${canonicalJson(report, { space: 2 })}\n`, { mode: 0o600, flag: 'wx' });
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const revision = argument('revision') ?? process.env.AGENTBATTLER_TERMINAL_PROTOCOL_REVISION ?? 'r2';
  const outputDirectory = path.resolve(argument('output') ?? path.join(ROOT, 'results', `terminal-mini-ledger-v7-calibration-${revision}`, 'gold'));
  const pools = (argument('pools') ?? 'dev,release,reserve').split(',').map((value) => value.trim()).filter(Boolean);
  const variants = (argument('variants') ?? 'clean,decoy').split(',').map((value) => value.trim()).filter(Boolean);
  const verifierSeeds = Number.parseInt(argument('verifier-seeds') ?? '100', 10);
  const report = await validateTerminalV7Golds({ revision, pools, variants, verifierSeeds, outputDirectory });
  process.stdout.write(`${JSON.stringify({ ok: true, reportSha256: report.reportSha256, rows: report.rows.length, verifierSeeds })}\n`);
}
