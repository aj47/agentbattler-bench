import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  bindV7PhaseEntryContract,
  hashV7ExecutableTree,
  installV7Phase,
  loadV7Pack,
} from '../benchmark/challenges/mini-ledger-v7/pack.mjs';
import {
  materializeFreshGoldImplementationA,
} from '../benchmark/challenges/mini-ledger-v7/gold/implementation-a/materialize.mjs';
import {
  materializeFreshGoldImplementationB,
} from '../benchmark/challenges/mini-ledger-v7/gold/implementation-b/materialize.mjs';
import { V7_REQUIREMENTS } from '../benchmark/challenges/mini-ledger-v7/requirements.mjs';
import { V7_VERIFIER_ASSERTIONS, verifyPhase } from '../benchmark/challenges/mini-ledger-v7/verifier.mjs';
import {
  TERMINAL_V7_MUTANTS,
  TERMINAL_V7_SEMANTIC_ALTERNATES,
  applyTerminalV7Mutant,
  applyTerminalV7SemanticAlternate,
  assertTerminalV7QualityEvidence,
  runTerminalV7QualityGates,
  terminalV7MutantCatalogDescriptor,
  terminalV7QualityGateContribution,
} from '../src/terminal-v7-quality-gates.mjs';

const execFileAsync = promisify(execFile);

const VERIFIER_IDENTITY = Object.freeze({
  image: 'agentbattler-mini-ledger-v7-verifier:test',
  imageId: `sha256:${'1'.repeat(64)}`,
  sourceSha256: '2'.repeat(64),
  network: 'none',
  readOnlyRootFilesystem: true,
  candidateCapabilities: 'exactly-zero',
});

function resultFor({ pack, phase, verifierSeedIndex, failures = [] }) {
  const requirements = [
    ['V7-P1-PUBLIC-MIGRATE', 'migration-compatibility', 'public', 4],
    ['V7-P1-PRIVATE-COMPAT', 'migration-compatibility', 'private', 8],
    ['V7-P1-PRIVATE-REJECT', 'migration-compatibility', 'private', 8],
    ['V7-P2-PUBLIC-BATCH', 'idempotency-pagination', 'public', 2],
    ['V7-P2-PUBLIC-CURSOR', 'idempotency-pagination', 'public', 2],
    ['V7-P2-PRIVATE-IDEMPOTENCY', 'idempotency-pagination', 'private', 8],
    ['V7-P2-PRIVATE-PAGINATION', 'idempotency-pagination', 'private', 8],
    ['V7-P3-PUBLIC-SERIALIZE', 'concurrency-atomicity', 'public', 4],
    ['V7-P3-PRIVATE-ATOMICITY', 'concurrency-atomicity', 'private', 16],
    ['V7-P3-PRIVATE-TERMINATION', 'crash-recovery', 'private', 8],
    ['V7-P4-PUBLIC-INCIDENT', 'audit-replay-scale', 'public', 4],
    ['V7-P4-PRIVATE-PROVENANCE', 'audit-replay-scale', 'private', 4],
    ['V7-P4-PRIVATE-SOURCE', 'audit-replay-scale', 'private', 4],
    ['V7-P5-PUBLIC-RECOVER', 'crash-recovery', 'public', 4],
    ['V7-P5-PRIVATE-LINEAGE', 'crash-recovery', 'private', 8],
    ['V7-P5-PRIVATE-REPLAY', 'audit-replay-scale', 'private', 4],
    ['V7-P5-PRIVATE-SCALE', 'audit-replay-scale', 'private', 4],
  ].filter(([id]) => phase === null || Number(id.slice(4, 5)) === phase)
    .map(([id, family, group, weight]) => {
      const passed = !failures.includes(id);
      const expected = V7_REQUIREMENTS.find((requirement) => requirement.id === id);
      const common = {
        id,
        family,
        group,
        weight,
        points: passed ? weight : 0,
        passed,
        diagnostic: passed ? 'passed' : 'expected mutant failure',
      };
      if (group === 'public') return { ...common, ...V7_VERIFIER_ASSERTIONS[id].public };
      return {
        ...common,
        classes: Object.fromEntries(['atomic', 'composed'].map((caseClass) => [caseClass, {
          ...V7_VERIFIER_ASSERTIONS[id][caseClass],
          weight: expected.privateClassWeights[caseClass],
          points: passed ? expected.privateClassWeights[caseClass] : 0,
          passed,
          diagnostic: passed ? 'passed' : 'expected mutant failure',
        }])),
      };
    });
  const families = ['migration-compatibility', 'idempotency-pagination', 'concurrency-atomicity', 'crash-recovery', 'audit-replay-scale'].map((id) => {
    const selected = requirements.filter(({ family }) => family === id);
    const aggregate = (group) => ({
      passed: selected.filter((item) => item.group === group).reduce((sum, item) => sum + item.points, 0),
      total: selected.filter((item) => item.group === group).reduce((sum, item) => sum + item.weight, 0),
    });
    const aggregateClass = (caseClass) => ({
      passed: selected.filter(({ group }) => group === 'private').reduce((sum, item) => sum + item.classes[caseClass].points, 0),
      total: selected.filter(({ group }) => group === 'private').reduce((sum, item) => sum + item.classes[caseClass].weight, 0),
    });
    return { id, public: aggregate('public'), hidden: aggregate('private'), hiddenAtomic: aggregateClass('atomic'), hiddenComposed: aggregateClass('composed') };
  });
  const score = requirements.reduce((sum, { points }) => sum + points, 0);
  const maxScore = requirements.reduce((sum, { weight }) => sum + weight, 0);
  return {
    schemaVersion: 'agentbattler.mini-ledger-v7.verification.v1',
    challengeId: pack.challengeId,
    instanceId: pack.instanceId,
    variant: pack.variant,
    phase,
    verifierSeedIndex,
    passed: score === maxScore,
    score,
    maxScore,
    publicScore: requirements.filter(({ group }) => group === 'public').reduce((sum, { points }) => sum + points, 0),
    privateScore: requirements.filter(({ group }) => group === 'private').reduce((sum, { points }) => sum + points, 0),
    requirements,
    families,
    infrastructureErrors: [],
    adaptability: { passed: score === maxScore ? 1 : 0, total: 1 },
    seedCommitments: [{ id: 'test', masterCommitment: '3'.repeat(64), variantCommitment: '4'.repeat(64) }],
  };
}

test('V7 mutation catalog has required categories, critical coverage, and two independent alternates', () => {
  const descriptor = terminalV7MutantCatalogDescriptor();
  assert.equal(descriptor.mutants.length, 40);
  assert.match(descriptor.catalogSha256, /^[0-9a-f]{64}$/);
  for (const category of ['data-loss', 'shortcut', 'candidate-test-tampering', 'decoy-following']) {
    assert.ok(descriptor.mutants.some((mutant) => mutant.category === category && mutant.critical), `missing critical ${category} mutant`);
  }
  assert.deepEqual(new Set(descriptor.semanticAlternates.map(({ implementationId }) => implementationId)), new Set(['implementation-a', 'implementation-b']));
});

test('snapshot-only durability mutant preserves durable primary publication and bypasses it exactly once for snapshots', async (t) => {
  const pack = loadV7Pack('dev-01', { variant: 'decoy' });
  const root = await mkdtemp(path.join(os.tmpdir(), 'v7-mutant-snapshot-durability-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await materializeFreshGoldImplementationB({ destination: root, pack });
  const mutant = TERMINAL_V7_MUTANTS.find(({ id }) => id === 'durability-snapshot-publication-omitted');
  assert.ok(mutant);
  assert.equal(mutant.implementationId, 'implementation-b');
  assert.equal(mutant.phase, 3);
  assert.equal(mutant.category, 'data-loss');
  assert.equal(mutant.critical, true);
  assert.deepEqual(mutant.expectedRequirementIds, ['V7-P3-PRIVATE-TERMINATION']);
  const applied = await applyTerminalV7Mutant({ workspace: root, pack, mutant });
  assert.deepEqual(applied.changed.map(({ path: relative }) => relative), ['src/reference-b/storage.mjs']);

  const storage = await readFile(path.join(root, 'src/reference-b/storage.mjs'), 'utf8');
  assert.match(storage, /export async function persistState[\s\S]*await durableAtomicWrite\(PRIMARY,/);
  assert.match(storage, /export async function durableAtomicWrite[\s\S]*await handle\.sync\(\)[\s\S]*await directory\.sync\(\)/);
  assert.doesNotMatch(storage, /await durableAtomicWrite\(target, bytes\)/);
  assert.equal(storage.match(/const snapshotHandle = await open\(target, 'wx', 0o600\)/g)?.length, 1);
});

test('all source mutation anchors apply exactly once to fresh independent gold trees', async (t) => {
  const pack = loadV7Pack('dev-01', { variant: 'decoy' });
  for (const mutant of TERMINAL_V7_MUTANTS.filter(({ phase }) => phase !== 4)) {
    const root = await mkdtemp(path.join(os.tmpdir(), `v7-mutant-${mutant.id}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    if (mutant.implementationId === 'implementation-a') await materializeFreshGoldImplementationA({ destination: root, pack });
    else await materializeFreshGoldImplementationB({ destination: root, pack });
    const applied = await applyTerminalV7Mutant({ workspace: root, pack, mutant });
    assert.ok(applied.changed.length > 0);
    if (mutant.id === 'candidate-test-tampering') assert.match(await readFile(path.join(root, 'test', 'always-pass.test.mjs'), 'utf8'), /fake candidate suite/);
  }
  for (const mutant of TERMINAL_V7_MUTANTS.filter(({ phase }) => phase === 4)) {
    const root = await mkdtemp(path.join(os.tmpdir(), `v7-mutant-${mutant.id}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    if (mutant.implementationId === 'implementation-a') await materializeFreshGoldImplementationA({ destination: root, pack });
    else await materializeFreshGoldImplementationB({ destination: root, pack });
    const control = path.join(root, '.agentbattler', 'current');
    await mkdir(control, { recursive: true });
    const installed = await installV7Phase({ pack, phase: 4, destination: control });
    const contract = bindV7PhaseEntryContract(installed.contract, await hashV7ExecutableTree(root));
    await writeFile(path.join(control, 'task-contract.json'), `${JSON.stringify(contract, null, 2)}\n`);
    const applied = await applyTerminalV7Mutant({ workspace: root, pack, mutant, contract });
    assert.ok(applied.changed.length > 0);
  }
  for (const alternate of TERMINAL_V7_SEMANTIC_ALTERNATES) {
    const root = await mkdtemp(path.join(os.tmpdir(), `v7-alternate-${alternate.id}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    if (alternate.implementationId === 'implementation-a') await materializeFreshGoldImplementationA({ destination: root, pack });
    else await materializeFreshGoldImplementationB({ destination: root, pack });
    const applied = await applyTerminalV7SemanticAlternate({ workspace: root, alternate });
    assert.notEqual(applied.beforeExecutableSourceSha256, applied.afterExecutableSourceSha256);
  }
});

test('semantic alternates are materially different storage designs accepted by behavioral verification', { timeout: 120_000 }, async (t) => {
  const pack = loadV7Pack('dev-01', { variant: 'decoy' });
  for (const alternate of TERMINAL_V7_SEMANTIC_ALTERNATES) {
    const root = await mkdtemp(path.join(os.tmpdir(), `v7-alternate-behavior-${alternate.id}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    if (alternate.implementationId === 'implementation-a') await materializeFreshGoldImplementationA({ destination: root, pack });
    else await materializeFreshGoldImplementationB({ destination: root, pack });
    const applied = await applyTerminalV7SemanticAlternate({ workspace: root, alternate });
    assert.ok(applied.changed.some(({ path: relative }) => relative.includes('reference') || relative.endsWith('storage.mjs')));
    for (const phase of [2, 5]) {
      const result = await verifyPhase({ pack, phase, candidateTree: root, workspace: root, verifierSeedIndex: 3 });
      assert.equal(result.score, result.maxScore, `${alternate.id} phase ${phase}: ${JSON.stringify(result.requirements.filter(({ passed }) => !passed))}`);
      assert.deepEqual(result.infrastructureErrors, []);
    }
  }
});

test('new atomicity, cursor, recovery, and replay mutants are killed by their declared verifier requirements', { timeout: 180_000 }, async (t) => {
  const selectedIds = new Set([
    'batch-partial-invalid-skipped',
    'migration-accept-nearby-v3-schema',
    'cursor-invalid-input-mutates-primary',
    'query-limit-leading-zero-accepted',
    'cursor-history-head-unbound',
    'recovery-accepts-rollback',
    'recovery-equal-generation-first-wins',
    'recovery-ignores-export-candidates',
    'recovery-skips-referenced-snapshot-validation',
    'audit-normalizes-invalid-sequences',
    'corrupt-replay-writes-untracked-runtime-state',
    'replay-hard-coded-head',
  ]);
  const pack = loadV7Pack('dev-02', { variant: 'decoy' });
  for (const mutant of TERMINAL_V7_MUTANTS.filter(({ id }) => selectedIds.has(id))) {
    const root = await mkdtemp(path.join(os.tmpdir(), `v7-mutant-kill-${mutant.id}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    await materializeFreshGoldImplementationB({ destination: root, pack });
    await applyTerminalV7Mutant({ workspace: root, pack, mutant });
    const result = await verifyPhase({ pack, phase: mutant.phase, candidateTree: root, workspace: root, verifierSeedIndex: 5 });
    assert.deepEqual(result.infrastructureErrors, []);
    assert.ok(mutant.expectedRequirementIds.some((id) => result.requirements.some((requirement) => requirement.id === id && !requirement.passed)), `${mutant.id} survived: ${JSON.stringify(result.requirements)}`);
  }
});

test('phase-3 reader and stale-lock mutants fail their exact behavioral clauses without prescribing a live lock design', { timeout: 120_000 }, async (t) => {
  const pack = loadV7Pack('dev-01', { variant: 'decoy' });
  const readerRoot = await mkdtemp(path.join(os.tmpdir(), 'v7-mutant-reader-revision-'));
  t.after(() => rm(readerRoot, { recursive: true, force: true }));
  await materializeFreshGoldImplementationB({ destination: readerRoot, pack });
  const readerMutant = TERMINAL_V7_MUTANTS.find(({ id }) => id === 'concurrency-empty-reader-revision');
  await applyTerminalV7Mutant({ workspace: readerRoot, pack, mutant: readerMutant });
  const readerResult = await verifyPhase({ pack, phase: 3, candidateTree: readerRoot, workspace: readerRoot, verifierSeedIndex: 4 });
  assert.equal(readerResult.requirements.find(({ id }) => id === 'V7-P3-PRIVATE-ATOMICITY').classes.composed.passed, false);

  const lockRoot = await mkdtemp(path.join(os.tmpdir(), 'v7-mutant-stale-lock-'));
  t.after(() => rm(lockRoot, { recursive: true, force: true }));
  await materializeFreshGoldImplementationB({ destination: lockRoot, pack });
  const lockMutant = TERMINAL_V7_MUTANTS.find(({ id }) => id === 'recovery-ignores-canonical-stale-lock');
  await applyTerminalV7Mutant({ workspace: lockRoot, pack, mutant: lockMutant });
  const canonicalLock = path.join(lockRoot, 'ledger.lock');
  await writeFile(canonicalLock, `${JSON.stringify({ schema: 'agentbattler.ledger.lock.v1', pid: 2_147_483_647, token: 'stale-test-token' })}\n`);
  await execFileAsync(process.execPath, ['bin/ledger.mjs', 'recover'], { cwd: lockRoot });
  assert.match(await readFile(canonicalLock, 'utf8'), /stale-test-token/);
});

test('reduced execution derives summaries, seals records, and cannot qualify through a test driver', { timeout: 120_000 }, async (t) => {
  const workRoot = await mkdtemp(path.join(os.tmpdir(), 'v7-quality-reduced-'));
  await rm(workRoot, { recursive: true, force: true });
  t.after(() => rm(workRoot, { recursive: true, force: true }));
  const mutantByPhase = new Map(TERMINAL_V7_MUTANTS.map((mutant) => [mutant.phase, mutant]));
  const evidence = await runTerminalV7QualityGates({
    workRoot,
    seedCount: 2,
    repetitionsPerFamily: 2,
    packIds: ['dev-01'],
    verifierIdentity: VERIFIER_IDENTITY,
    verificationDriver: async ({ pack, phase = null, verifierSeedIndex }) => {
      const failures = phase === null ? [] : mutantByPhase.get(phase)?.expectedRequirementIds ?? [];
      return resultFor({ pack, phase, verifierSeedIndex, failures });
    },
  });
  assert.equal(evidence.gold.executions, 8);
  assert.equal(evidence.flake.executionsPerFamily, 2);
  assert.equal(evidence.flake.failures, 0);
  assert.equal(evidence.qualification.fullShape, false);
  assert.equal(evidence.qualification.passed, false);
  assert.equal(assertTerminalV7QualityEvidence(evidence, { requireFull: false }).evidenceSha256, evidence.evidenceSha256);
  assert.throws(() => assertTerminalV7QualityEvidence(evidence), /full qualifying execution/);
  assert.throws(() => terminalV7QualityGateContribution(evidence), /full qualifying execution/);

  const tampered = structuredClone(evidence);
  tampered.gold.cleanMinCore = 0;
  assert.throws(() => assertTerminalV7QualityEvidence(tampered, { requireFull: false }), /seal mismatch|summary is not evidence-derived/);
});
