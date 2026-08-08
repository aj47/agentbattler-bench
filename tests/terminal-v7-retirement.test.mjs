import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createTerminalV7FrontierAnalysis,
  createTerminalV7FrontierReleaseIdentity,
  createTerminalV7FrontierResultSet,
  createTerminalV7RetirementRecord,
  readTerminalV7RetirementRecord,
  validateTerminalV7FrontierAnalysis,
  validateTerminalV7RetirementRecord,
  writeTerminalV7RetirementRecord,
} from '../src/terminal-v7-retirement.mjs';
import { canonicalJson, canonicalJsonSha256, sha256 } from '../src/provenance.mjs';
import { main as retireTerminalV7 } from '../scripts/retire-terminal-v7.mjs';

const hash = (character) => character.repeat(64);
const artifact = (artifactPath, bytes = 'x') => ({ path: artifactPath, sizeBytes: Buffer.byteLength(bytes), sha256: sha256(bytes) });
const RELEASE_IDENTITY = createTerminalV7FrontierReleaseIdentity({
  protocolRevision: 'r1',
  challengeId: 'challenge-test',
  challengeSha256: hash('c'),
  rubricVersion: 'mini-ledger-v7-r1',
  sealManifestSha256: hash('1'),
  verifierSha256: hash('2'),
  releasePackSetSha256: hash('3'),
  hiddenMerkleRootsSha256: hash('4'),
});

function frontierEvidence(systemId, {
  developerId = systemId,
  providerId = `${systemId}-provider`,
  modelFamilyId = `${systemId}-family`,
  releaseIdentity = RELEASE_IDENTITY,
  scores = [90, 90, 90, 90, 90],
  prefix = systemId[systemId.length - 1] ?? 'a',
} = {}) {
  const resultSet = createTerminalV7FrontierResultSet({
    revision: 'r1',
    systemId,
    systemIdentity: {
      developerId,
      providerId,
      modelFamilyId,
      modelId: `${systemId}-model`,
      modelRevision: '2026-08-08',
      harnessId: 'codex-cli',
      harnessVersion: '1.0.0',
    },
    releaseIdentity,
    scheduleId: 'schedule-test',
    scheduleSha256: hash('d'),
    runs: scores.map((corePoints, index) => ({
      runKey: canonicalJsonSha256({ systemId, index, kind: 'run' }),
      instanceId: `release-0${index + 1}`,
      status: 'completed',
      validity: 'valid',
      corePoints,
      resultSha256: canonicalJsonSha256({ systemId, index, kind: 'result' }),
    })),
  });
  const analysis = createTerminalV7FrontierAnalysis({
    resultSet,
    analystId: 'independent-analysis',
    analysisCodeSha256: hash(prefix === 'a' ? 'e' : 'f'),
    createdAt: '2026-08-08T11:00:00.000Z',
  });
  const resultBytes = `${canonicalJson(resultSet)}\n`;
  const analysisBytes = `${canonicalJson(analysis)}\n`;
  return {
    systemId,
    resultSet,
    analysis,
    resultSetArtifact: artifact(`retirement-evidence/frontier/${systemId}/result-set.json`, resultBytes),
    analysisArtifact: artifact(`retirement-evidence/frontier/${systemId}/analysis.json`, analysisBytes),
    resultBytes,
    analysisBytes,
  };
}

test('V7 retirement derives frontier metrics and independent identities from sealed artifacts', () => {
  assert.throws(() => createTerminalV7RetirementRecord({ revision: 'r1', detectedAt: '2026-08-08T12:00:00.000Z' }), /threshold/);
  const leakage = createTerminalV7RetirementRecord({
    revision: 'r1',
    detectedAt: '2026-08-08T12:00:00.000Z',
    privatePackLeakage: { detected: true, evidenceSha256: sha256('x'), evidenceArtifact: artifact('retirement-evidence/leakage.json') },
  });
  assert.equal(validateTerminalV7RetirementRecord(leakage).action.reason, 'private-pack-leakage');

  const frontierA = frontierEvidence('frontier-a', { scores: [86, 86, 86, 86, 86], prefix: 'a' });
  const frontierB = frontierEvidence('frontier-b', { scores: [90, 90, 90, 90, 90], prefix: 'b' });
  const frontier = createTerminalV7RetirementRecord({
    revision: 'r1',
    detectedAt: '2026-08-08T12:00:00.000Z',
    frontierSystems: [frontierB, frontierA],
  });
  assert.deepEqual(frontier.action.qualifyingSystems, ['frontier-a', 'frontier-b']);
  assert.equal(frontier.frontierSystems[0].meanCore, 86);
  assert.equal(frontier.frontierSystems[0].lowerConfidenceBound, 86);

  const changed = structuredClone(frontier);
  changed.frontierSystems[0].meanCore = 80;
  assert.throws(() => validateTerminalV7RetirementRecord(changed), /hash mismatch/);

  const lowClaims = frontierEvidence('frontier-low', { scores: [70, 70, 70, 70, 70], prefix: 'b' });
  lowClaims.meanCore = 99;
  lowClaims.lowerConfidenceBound = 99;
  assert.throws(() => createTerminalV7RetirementRecord({
    revision: 'r1',
    detectedAt: '2026-08-08T12:00:00.000Z',
    frontierSystems: [frontierA, lowClaims],
  }), /threshold/);

  const alias = frontierEvidence('frontier-alias', {
    developerId: frontierA.resultSet.systemIdentity.developerId,
    providerId: frontierA.resultSet.systemIdentity.providerId,
    modelFamilyId: frontierA.resultSet.systemIdentity.modelFamilyId,
  });
  assert.throws(() => createTerminalV7RetirementRecord({
    revision: 'r1',
    detectedAt: '2026-08-08T12:00:00.000Z',
    frontierSystems: [frontierA, alias],
  }), /not independent model families/);

  const otherRelease = createTerminalV7FrontierReleaseIdentity({
    ...RELEASE_IDENTITY,
    sealManifestSha256: hash('9'),
  });
  const crossBenchmark = frontierEvidence('frontier-other-release', { releaseIdentity: otherRelease });
  assert.throws(() => createTerminalV7RetirementRecord({
    revision: 'r1',
    detectedAt: '2026-08-08T12:00:00.000Z',
    frontierSystems: [frontierA, crossBenchmark],
  }), /different authoritative release identities/);

  const forgedAnalysis = structuredClone(frontierA.analysis);
  forgedAnalysis.meanCore = 99;
  const { analysisSha256: _oldSeal, ...forgedUnsigned } = forgedAnalysis;
  forgedAnalysis.analysisSha256 = canonicalJsonSha256(forgedUnsigned);
  assert.throws(() => validateTerminalV7FrontierAnalysis(forgedAnalysis, { resultSet: frontierA.resultSet }), /deterministic recomputation/);
});

test('V7 retirement marker is immutable and readable by runner controls', async () => {
  const resultRoot = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-v7-retirement-'));
  const evidencePath = path.join(resultRoot, 'retirement-evidence', 'leakage.json');
  const bytes = 'sealed leakage evidence\n';
  await mkdir(path.dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, bytes);
  const record = createTerminalV7RetirementRecord({
    revision: 'r1',
    detectedAt: '2026-08-08T12:00:00.000Z',
    privatePackLeakage: {
      detected: true,
      evidenceSha256: sha256(bytes),
      evidenceArtifact: { path: 'retirement-evidence/leakage.json', sizeBytes: Buffer.byteLength(bytes), sha256: sha256(bytes) },
    },
  });
  await writeTerminalV7RetirementRecord({ resultRoot, record });
  assert.deepEqual(await readTerminalV7RetirementRecord({ resultRoot, revision: 'r1' }), record);
  await assert.rejects(writeTerminalV7RetirementRecord({ resultRoot, record }), { code: 'EEXIST' });
  await writeFile(evidencePath, 'tampered leakage evidence\n');
  await assert.rejects(readTerminalV7RetirementRecord({ resultRoot, revision: 'r1' }), /bytes changed/);
  await writeFile(path.join(resultRoot, 'retirement.json'), '{}');
  await assert.rejects(readTerminalV7RetirementRecord({ resultRoot, revision: 'r1' }), /schema/);
});

test('V7 frontier retirement rereads and recomputes copied result-set and analysis artifacts', async () => {
  const resultRoot = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-v7-frontier-retirement-'));
  const systems = [frontierEvidence('frontier-a'), frontierEvidence('frontier-b', { prefix: 'b' })];
  for (const system of systems) {
    const resultFile = path.join(resultRoot, ...system.resultSetArtifact.path.split('/'));
    const analysisFile = path.join(resultRoot, ...system.analysisArtifact.path.split('/'));
    await mkdir(path.dirname(resultFile), { recursive: true });
    await Promise.all([
      writeFile(resultFile, system.resultBytes),
      writeFile(analysisFile, system.analysisBytes),
    ]);
  }
  const record = createTerminalV7RetirementRecord({
    revision: 'r1',
    detectedAt: '2026-08-08T12:00:00.000Z',
    frontierSystems: systems,
  });
  await writeTerminalV7RetirementRecord({ resultRoot, record });
  const reread = await readTerminalV7RetirementRecord({ resultRoot, revision: 'r1' });
  assert.equal(reread.action.reason, 'frontier-saturation');
  assert.ok(reread.frontierSystems.every(({ meanCore, lowerConfidenceBound }) => meanCore === 90 && lowerConfidenceBound === 90));
});

test('V7 retirement CLI ignores declared score projections and derives its decision from source JSON', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-v7-retirement-cli-'));
  const sources = path.join(root, 'source-evidence');
  const controlRoot = path.join(root, 'revision-control');
  await mkdir(sources, { recursive: true });
  const systems = [frontierEvidence('frontier-a'), frontierEvidence('frontier-b', { prefix: 'b' })];
  const declarations = [];
  for (const system of systems) {
    const resultSetPath = path.join(sources, `${system.systemId}-results.json`);
    const analysisPath = path.join(sources, `${system.systemId}-analysis.json`);
    await Promise.all([
      writeFile(resultSetPath, system.resultBytes),
      writeFile(analysisPath, system.analysisBytes),
    ]);
    declarations.push({
      systemId: system.systemId,
      resultSetPath,
      analysisPath,
      meanCore: 0,
      lowerConfidenceBound: 0,
    });
  }
  const evidencePath = path.join(sources, 'retire.json');
  await writeFile(evidencePath, `${canonicalJson({ frontierSystems: declarations })}\n`);
  await assert.rejects(retireTerminalV7({
    root,
    argv: [evidencePath],
    env: {
      AGENTBATTLER_TERMINAL_PROTOCOL_REVISION: 'r1',
      AGENTBATTLER_V7_REVISION_CONTROL_ROOT: path.join(root, 'mismatched-control'),
    },
    expectedReleaseIdentity: createTerminalV7FrontierReleaseIdentity({
      ...RELEASE_IDENTITY,
      verifierSha256: hash('9'),
    }),
  }), /another authoritative release identity/);
  const record = await retireTerminalV7({
    root,
    argv: [evidencePath],
    env: {
      AGENTBATTLER_TERMINAL_PROTOCOL_REVISION: 'r1',
      AGENTBATTLER_V7_REVISION_CONTROL_ROOT: controlRoot,
    },
    now: () => '2026-08-08T12:00:00.000Z',
    expectedReleaseIdentity: RELEASE_IDENTITY,
  });
  assert.equal(record.action.reason, 'frontier-saturation');
  assert.ok(record.frontierSystems.every(({ meanCore }) => meanCore === 90));
  assert.equal(record.frontierEvidencePolicy.rawRunsLocallyReverified, false);
});
