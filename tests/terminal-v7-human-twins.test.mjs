import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  bindV7PhaseEntryContract,
  hashV7ExecutableTree,
  installV7Phase,
  loadV7Pack,
  materializeV7Starter,
} from '../benchmark/challenges/mini-ledger-v7/pack.mjs';
import {
  materializeFreshGoldImplementationA,
  respondToGoldAPhase4,
} from '../benchmark/challenges/mini-ledger-v7/gold/implementation-a/materialize.mjs';
import {
  createV7CandidateFailureResult,
} from '../benchmark/challenges/mini-ledger-v7/verifier.mjs';
import { canonicalJson, canonicalJsonSha256, sha256 } from '../src/provenance.mjs';
import { captureTerminalCandidateTree } from '../src/terminal-candidate-tree.mjs';
import {
  assertTerminalV7HumanTwinArtifacts,
  sealTerminalV7HumanTwinValidation,
} from '../src/terminal-v7-human-twins.mjs';
import { MINI_LEDGER_V7_CANDIDATE_TREE_POLICY } from '../src/terminal-v7-runtime.mjs';

const VERIFIER_IMAGE = { imageId: `sha256:${'a'.repeat(64)}`, sourceSha256: 'b'.repeat(64) };

function sealedVerifierFixtures(pack) {
  const phaseResults = Array.from({ length: 5 }, (_, index) => ({
    ...createV7CandidateFailureResult({
      instance: pack,
      pack,
      phase: index + 1,
      verifierSeedIndex: 0,
      diagnostic: 'bounded human-twin phase-result threading fixture',
    }),
    durationMs: 0,
  }));
  const requirements = phaseResults.flatMap((result) => result.requirements);
  const evaluation = {
    schemaVersion: phaseResults[0].schemaVersion,
    challengeId: pack.challengeId,
    instanceId: pack.instanceId,
    variant: pack.variant,
    phase: null,
    passed: false,
    score: 0,
    maxScore: requirements.reduce((sum, { weight }) => sum + weight, 0),
    publicScore: 0,
    privateScore: 0,
    infrastructureErrors: [],
    requirements,
    checks: requirements,
    families: [],
    adaptability: { passed: 0, total: 5 },
    verifierSeedIndex: 0,
    seedCommitments: [],
    durationMs: 0,
    phases: phaseResults,
  };
  return { phaseResults, evaluation };
}

async function sealedFixtureTrajectory(root, pack) {
  const workspace = path.join(root, 'trusted-phase-04');
  await materializeFreshGoldImplementationA({ pack, destination: workspace });
  const current = path.join(workspace, '.agentbattler', 'current');
  await mkdir(current, { recursive: true, mode: 0o700 });
  const installed = await installV7Phase({ pack, phase: 4, destination: current });
  const contract = bindV7PhaseEntryContract(installed.contract, await hashV7ExecutableTree(workspace));
  await writeFile(path.join(current, 'task-contract.json'), `${canonicalJson(contract)}\n`);
  await respondToGoldAPhase4({ workspace });
  return {
    ...sealedVerifierFixtures(pack),
    phaseFourArtifact: {
      path: contract.responsePath,
      bytes: await readFile(path.join(workspace, contract.responsePath)),
    },
  };
}

async function executableTwinEvidence(evidenceRoot, instanceId, variant) {
  const pack = loadV7Pack(instanceId, { variant });
  const baseline = path.join(evidenceRoot, 'fixtures', `${instanceId}-${variant}`, 'baseline');
  const workspace = path.join(evidenceRoot, 'fixtures', `${instanceId}-${variant}`, 'workspace');
  await Promise.all([mkdir(baseline, { recursive: true }), mkdir(workspace, { recursive: true })]);
  await Promise.all([materializeV7Starter({ pack, destination: baseline }), materializeFreshGoldImplementationA({ pack, destination: workspace })]);
  const phaseCandidateTrees = [];
  for (let phase = 1; phase <= 5; phase += 1) {
    phaseCandidateTrees.push(await captureTerminalCandidateTree({
      workspace,
      baseDirectory: baseline,
      runDirectory: evidenceRoot,
      turn: phase + (variant === 'clean' ? 0 : 10),
      policy: MINI_LEDGER_V7_CANDIDATE_TREE_POLICY,
    }));
  }
  const finalCandidateTree = phaseCandidateTrees[4];
  const verified = await sealedFixtureTrajectory(path.join(evidenceRoot, 'fixtures', `${instanceId}-${variant}`, 'trusted-verifier'), pack);
  const artifactBytes = verified.phaseFourArtifact.bytes;
  const artifactArchivePath = `control/human-twin-evidence/artifacts/${instanceId}-${variant}.json`;
  const artifactFile = path.join(evidenceRoot, ...artifactArchivePath.split('/'));
  await mkdir(path.dirname(artifactFile), { recursive: true });
  await writeFile(artifactFile, artifactBytes);
  const evidencePath = `control/human-twin-evidence/${instanceId}-${variant}.json`;
  const unsigned = {
    schemaVersion: 'agentbattler.terminal-v7-human-twin-run-evidence.v1',
    validatorId: 'human-01',
    validatorIdentitySha256: 'c'.repeat(64),
    instanceId,
    variant,
    status: 'completed',
    validity: 'valid',
    corePoints: verified.evaluation.score,
    exact: verified.evaluation.score === verified.evaluation.maxScore,
    candidateTreeSha256: finalCandidateTree.treeSha256,
    evaluationSha256: canonicalJsonSha256(verified.evaluation),
    phaseCandidateTrees,
    finalCandidateTree,
    phaseFourArtifact: {
      path: verified.phaseFourArtifact.path,
      archivePath: artifactArchivePath,
      sizeBytes: Buffer.byteLength(artifactBytes),
      sha256: sha256(artifactBytes),
    },
    phaseResults: verified.phaseResults,
    evaluation: verified.evaluation,
    verifierImage: VERIFIER_IMAGE,
  };
  const runEvidence = { ...unsigned, evidenceSha256: canonicalJsonSha256(unsigned) };
  const serialized = `${canonicalJson(runEvidence, { space: 2 })}\n`;
  const evidenceFile = path.join(evidenceRoot, ...evidencePath.split('/'));
  await mkdir(path.dirname(evidenceFile), { recursive: true });
  await writeFile(evidenceFile, serialized);
  return {
    evidenceFile,
    originalSerialized: serialized,
    runEvidence,
    projection: {
      variant,
      status: 'completed',
      validity: 'valid',
      corePoints: verified.evaluation.score,
      exact: verified.evaluation.score === verified.evaluation.maxScore,
      candidateTreeSha256: finalCandidateTree.treeSha256,
      evaluationSha256: canonicalJsonSha256(verified.evaluation),
      evidencePath,
      evidenceFileSha256: sha256(serialized),
    },
    archivedFinalSource: path.join(evidenceRoot, ...finalCandidateTree.archivePath.split('/'), 'src', 'reference-ledger.mjs'),
  };
}

function twinRow(clean, decoy) {
  return sealTerminalV7HumanTwinValidation({
    schemaVersion: 'agentbattler.terminal-v7-human-twin-validation.v1',
    revision: 'r1',
    reviewedCommit: 'd'.repeat(40),
    sealManifestSha256: 'e'.repeat(64),
    verifierImage: VERIFIER_IMAGE,
    validatorId: 'human-01',
    validatorIdentitySha256: 'c'.repeat(64),
    independenceDeclaration: true,
    validationMethod: 'human-executable-twin-validation',
    validatedAt: '2026-08-08T10:00:00.000Z',
    instanceId: 'dev-01',
    clean: clean.projection,
    decoy: decoy.projection,
    cleanCorePoints: clean.projection.corePoints,
    decoyCorePoints: decoy.projection.corePoints,
  });
}

function sealedVerifierSpy(calls = []) {
  return async ({ mode, pack, phase = null, phaseResults = [] }) => {
    const fixtures = sealedVerifierFixtures(pack);
    const priorPhases = phaseResults.map((result) => result.phase);
    if (mode === 'final') {
      assert.deepEqual(priorPhases, [1, 2, 3, 4, 5], 'final must receive prior phases 1-5');
      assert.equal(canonicalJson(phaseResults), canonicalJson(fixtures.phaseResults), 'final received phase results other than the sealed fixture evidence');
    } else {
      const expected = Array.from({ length: phase - 1 }, (_, index) => index + 1);
      assert.deepEqual(priorPhases, expected, phase === 5
        ? 'phase 5 must receive prior phases 1-4'
        : `phase ${phase} received the wrong prior phase history`);
      assert.equal(canonicalJson(phaseResults), canonicalJson(fixtures.phaseResults.slice(0, phase - 1)), `phase ${phase} received results other than the sealed fixture evidence`);
      if (phase === 5) {
        assert.equal(phaseResults[3].schemaVersion, fixtures.phaseResults[3].schemaVersion, 'phase 5 did not receive a real-schema phase-4 result');
        assert.ok(phaseResults[3].requirements.some(({ id }) => id === 'V7-P4-PRIVATE-SOURCE'), 'phase 5 did not receive the trusted phase-4 requirement result');
      }
    }
    calls.push({ variant: pack.variant, mode, phase, priorPhases });
    return structuredClone(mode === 'final' ? fixtures.evaluation : fixtures.phaseResults[phase - 1]);
  };
}

test('V7 human twin evidence threads sealed phase results and rejects invented scores or archive tampering', async () => {
  const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-v7-human-twin-'));
  try {
    const clean = await executableTwinEvidence(evidenceRoot, 'dev-01', 'clean');
    const decoy = await executableTwinEvidence(evidenceRoot, 'dev-01', 'decoy');
    const calls = [];
    const verifyCandidate = sealedVerifierSpy(calls);
    const cleanPack = loadV7Pack('dev-01', { variant: 'clean' });
    await assert.rejects(
      verifyCandidate({ mode: 'phase', pack: cleanPack, phase: 5, phaseResults: [] }),
      /phase 5 must receive prior phases 1-4/,
    );
    await assert.rejects(
      verifyCandidate({ mode: 'final', pack: cleanPack, phaseResults: sealedVerifierFixtures(cleanPack).phaseResults.slice(0, 4) }),
      /final must receive prior phases 1-5/,
    );
    const row = twinRow(clean, decoy);
    const options = {
      revision: 'r1',
      reviewedCommit: 'd'.repeat(40),
      sealManifestSha256: 'e'.repeat(64),
      verifierImage: VERIFIER_IMAGE,
      verifyCandidate,
    };
    const closure = await assertTerminalV7HumanTwinArtifacts({ evidenceRoot, rows: [row], options });
    assert.equal(closure.rowsSha256, canonicalJsonSha256([row]));
    assert.deepEqual(calls, ['clean', 'decoy'].flatMap((variant) => [
      { variant, mode: 'phase', phase: 1, priorPhases: [] },
      { variant, mode: 'phase', phase: 2, priorPhases: [1] },
      { variant, mode: 'phase', phase: 3, priorPhases: [1, 2] },
      { variant, mode: 'phase', phase: 4, priorPhases: [1, 2, 3] },
      { variant, mode: 'phase', phase: 5, priorPhases: [1, 2, 3, 4] },
      { variant, mode: 'final', phase: null, priorPhases: [1, 2, 3, 4, 5] },
    ]));

    const inventedUnsigned = structuredClone(clean.runEvidence);
    delete inventedUnsigned.evidenceSha256;
    inventedUnsigned.corePoints = 99;
    inventedUnsigned.evaluation = { ...inventedUnsigned.evaluation, score: 99 };
    inventedUnsigned.evaluationSha256 = canonicalJsonSha256(inventedUnsigned.evaluation);
    const invented = { ...inventedUnsigned, evidenceSha256: canonicalJsonSha256(inventedUnsigned) };
    const inventedSerialized = `${canonicalJson(invented, { space: 2 })}\n`;
    await writeFile(clean.evidenceFile, inventedSerialized);
    const inventedClean = structuredClone(clean);
    inventedClean.projection = {
      ...inventedClean.projection,
      corePoints: 99,
      evaluationSha256: invented.evaluationSha256,
      evidenceFileSha256: sha256(inventedSerialized),
    };
    await assert.rejects(
      assertTerminalV7HumanTwinArtifacts({ evidenceRoot, rows: [twinRow(inventedClean, decoy)], options }),
      /does not reproduce|projection differs/,
    );

    await writeFile(clean.evidenceFile, clean.originalSerialized);
    await writeFile(clean.archivedFinalSource, 'export const independentlyValidated = false;\n');
    await assert.rejects(
      assertTerminalV7HumanTwinArtifacts({ evidenceRoot, rows: [row], options }),
      /checksum mismatch/,
    );
  } finally {
    await rm(evidenceRoot, { recursive: true, force: true });
  }
});
