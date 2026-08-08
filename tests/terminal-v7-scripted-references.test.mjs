import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  hashV7ExecutableTree,
  V7_HIDDEN_CASES,
  V7_POOL_INSTANCES,
} from '../benchmark/challenges/mini-ledger-v7/pack.mjs';
import {
  V7_FAMILIES,
  V7_REQUIREMENTS,
} from '../benchmark/challenges/mini-ledger-v7/requirements.mjs';
import { materializeFreshGoldImplementationA } from '../benchmark/challenges/mini-ledger-v7/gold/implementation-a/materialize.mjs';
import { materializeFreshGoldImplementationB } from '../benchmark/challenges/mini-ledger-v7/gold/implementation-b/materialize.mjs';
import { canonicalJson, canonicalJsonSha256 } from '../src/provenance.mjs';
import { createTerminalV7SealManifest } from '../src/terminal-v7-seals.mjs';
import {
  assertTerminalV7ScriptedReferenceArtifacts,
  runTerminalV7ScriptedReferences,
  sealTerminalV7ScriptedReferenceReport,
  terminalV7ScriptedImplementationDescriptors,
  validateTerminalV7ScriptedReferenceReport,
} from '../src/terminal-v7-scripted-references.mjs';
import { terminalV7VerifierSourceDescriptor } from '../src/terminal-v7-verifier-container.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const KEY = 'terminal-v7-scripted-reference-test-key';
const REVISION = 'r1';

async function temporary(name, callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), `${name}-`));
  try { return await callback(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

function evaluation(instanceId, variant) {
  return {
    schemaVersion: 'agentbattler.mini-ledger-v7.verification.v1',
    challengeId: 'terminal-mini-ledger-v7',
    instanceId,
    variant,
    phase: null,
    passed: true,
    score: 100,
    maxScore: 100,
    publicScore: 20,
    privateScore: 80,
    infrastructureErrors: [],
    requirements: V7_REQUIREMENTS.map((requirement) => ({
      ...requirement,
      passed: true,
      points: requirement.weight,
    })),
    families: V7_FAMILIES.map((id) => ({
      id,
      public: { passed: 4, total: 4 },
      hiddenAtomic: { passed: 6, total: 6 },
      hiddenComposed: { passed: 10, total: 10 },
      hidden: { passed: 16, total: 16 },
    })),
    adaptability: { passed: 5, total: 5 },
    verifierSeedIndex: 0,
    seedCommitments: V7_HIDDEN_CASES.map(({ id }) => ({
      id,
      masterCommitment: canonicalJsonSha256({ instanceId, id, kind: 'master' }),
      variantCommitment: canonicalJsonSha256({ instanceId, variant, id, kind: 'variant' }),
    })),
  };
}

async function devExecutableHashes(temp, manifest, implementations) {
  const materializers = new Map([
    ['implementation-a', materializeFreshGoldImplementationA],
    ['implementation-b', materializeFreshGoldImplementationB],
  ]);
  const hashes = new Map();
  for (const implementation of implementations) {
    for (const instanceId of V7_POOL_INSTANCES.dev) {
      const twin = manifest.packs.find((entry) => entry.instanceId === instanceId);
      for (const variant of ['clean', 'decoy']) {
        const destination = path.join(temp, 'gold-workspaces', implementation.implementationId, instanceId, variant);
        await materializers.get(implementation.implementationId)({ destination, pack: twin[variant] });
        hashes.set(`${implementation.implementationId}\0${instanceId}\0${variant}`, await hashV7ExecutableTree(destination));
      }
    }
  }
  return hashes;
}

async function goldFixture(temp) {
  const manifest = createTerminalV7SealManifest({
    revision: REVISION,
    seedKey: KEY,
    sealedAt: '2026-08-08T08:00:00.000Z',
  });
  const implementations = await terminalV7ScriptedImplementationDescriptors({ root: ROOT });
  const executableHashes = await devExecutableHashes(temp, manifest, implementations);
  const verifierSource = await terminalV7VerifierSourceDescriptor({ root: ROOT });
  const verifierImage = {
    image: 'agentbattler-mini-ledger-v7-verifier:test',
    imageId: `sha256:${'a'.repeat(64)}`,
    sourceSha256: verifierSource.sourceSha256,
  };
  const rows = [];
  for (const implementation of implementations) {
    for (const [pool, instanceIds] of Object.entries(V7_POOL_INSTANCES)) {
      for (const instanceId of instanceIds) {
        const twin = manifest.packs.find((entry) => entry.pool === pool && entry.instanceId === instanceId);
        for (const variant of ['clean', 'decoy']) {
          const key = `${implementation.implementationId}\0${instanceId}\0${variant}`;
          rows.push({
            implementationId: implementation.implementationId,
            pool,
            instanceId,
            variant,
            packSha256: twin[variant].packSha256,
            sealSha256: twin[variant].sealSha256,
            executableSourceSha256: executableHashes.get(key) ?? canonicalJsonSha256({ key, kind: 'unmaterialized-test-gold' }),
            verifierSeeds: 100,
            minimumCore: 100,
            exactCount: 100,
            infrastructureInvalid: 0,
            resultsSha256: canonicalJsonSha256({ key, seeds: 100 }),
            evidencePath: `row-evidence/${implementation.implementationId}/${instanceId}-${variant}.json`,
            evidenceFileSha256: canonicalJsonSha256({ key, kind: 'row-evidence' }),
          });
        }
      }
    }
  }
  const unsigned = {
    schemaVersion: 'agentbattler.terminal-v7-gold-report.v1',
    challengeId: 'terminal-mini-ledger-v7',
    revision: REVISION,
    createdAt: '2026-08-08T08:30:00.000Z',
    policy: {
      independentImplementations: 2,
      variants: ['clean', 'decoy'],
      verifierSeeds: 100,
      verifierBoundary: 'sealed-linux-strace-container',
    },
    verifierImage,
    implementations,
    rows,
    summary: {
      independentImplementations: 2,
      verifierSeeds: 100,
      cleanMinCore: 100,
      decoyMinCore: 100,
      infrastructureInvalid: 0,
    },
  };
  return { manifest, goldReport: { ...unsigned, reportSha256: canonicalJsonSha256(unsigned) }, verifierImage };
}

async function scriptedFixture(temp) {
  const { manifest, goldReport, verifierImage } = await goldFixture(temp);
  const resultRoot = path.join(temp, 'calibration');
  const result = await runTerminalV7ScriptedReferences({
    root: ROOT,
    resultRoot,
    revision: REVISION,
    sealManifest: manifest,
    goldReport,
    createdAt: '2026-08-08T09:00:00.000Z',
    inspectVerifier: async ({ expectedSourceSha256, expectedImageId }) => {
      assert.equal(expectedSourceSha256, verifierImage.sourceSha256);
      assert.equal(expectedImageId, verifierImage.imageId);
      return verifierImage;
    },
    runVerifier: async ({ pack, evidenceDirectory, verifierSeedIndex, expectedSourceSha256, expectedImageId }) => {
      assert.equal(verifierSeedIndex, 0);
      assert.equal(expectedSourceSha256, verifierImage.sourceSha256);
      assert.equal(expectedImageId, verifierImage.imageId);
      await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
      await writeFile(path.join(evidenceDirectory, 'native-proof.json'), `${canonicalJson({
        instanceId: pack.instanceId,
        variant: pack.variant,
        candidateCapabilityMask: '0',
        boundary: 'bubblewrap-v1',
      })}\n`, { mode: 0o600 });
      return evaluation(pack.instanceId, pack.variant);
    },
  });
  return { ...result, resultRoot, manifest, goldReport, verifierImage };
}

test('V7 scripted-reference runner executes both gold implementations across every sealed development twin', { timeout: 120_000 }, () => temporary('v7-scripted-run', async (temp) => {
  const fixture = await scriptedFixture(temp);
  assert.equal(validateTerminalV7ScriptedReferenceReport(fixture.report, {
    revision: REVISION,
    sealManifestSha256: fixture.manifest.manifestSha256,
    goldReportSha256: fixture.goldReport.reportSha256,
    verifierImage: fixture.verifierImage,
  }), fixture.report);
  assert.equal(fixture.report.rows.length, 12);
  assert.equal(fixture.report.summary.minimumCore, 100);
  assert.equal(fixture.report.summary.maximumAbsoluteTwinDifference, 0);
  assert.match(fixture.closure.rowEvidenceSha256, /^[0-9a-f]{64}$/);
  assert.match(fixture.closure.verifierArtifactsSha256, /^[0-9a-f]{64}$/);
  const persisted = JSON.parse(await readFile(path.join(fixture.resultRoot, 'control', 'scripted-reference-results.json'), 'utf8'));
  assert.deepEqual(persisted, fixture.report);
  const serialized = JSON.stringify(persisted);
  assert.doesNotMatch(serialized, new RegExp(KEY));
  assert.doesNotMatch(serialized, /seedKey|hiddenSeed|sessionId|"prompt":|"modelText":/);
}));

test('V7 scripted-reference report rejects the former arbitrary row-array input', () => {
  const rows = [{ implementationId: 'implementation-a', instanceId: 'dev-01', variant: 'clean', corePoints: 100 }];
  assert.throws(() => validateTerminalV7ScriptedReferenceReport(rows), /report schema/);
});

test('V7 scripted-reference closure rejects handcrafted gold bindings and modified verifier artifacts', { timeout: 120_000 }, () => temporary('v7-scripted-tamper', async (temp) => {
  const fixture = await scriptedFixture(temp);
  const changedReport = structuredClone(fixture.report);
  changedReport.rows[0].goldResultsSha256 = 'b'.repeat(64);
  const { reportSha256: _oldReportSha256, ...changedUnsigned } = changedReport;
  const resealed = sealTerminalV7ScriptedReferenceReport(changedUnsigned);
  assert.equal(validateTerminalV7ScriptedReferenceReport(resealed), resealed);
  await assert.rejects(() => assertTerminalV7ScriptedReferenceArtifacts({
    evidenceRoot: fixture.resultRoot,
    root: ROOT,
    report: resealed,
    sealManifest: fixture.manifest,
    goldReport: fixture.goldReport,
    expectedVerifierImage: fixture.verifierImage,
  }), /qualifying 100-seed gold row|differs from its execution evidence/);

  const first = fixture.report.rows[0];
  const evidence = JSON.parse(await readFile(path.join(fixture.resultRoot, ...first.evidencePath.split('/')), 'utf8'));
  const artifact = path.join(fixture.resultRoot, ...evidence.verifierArtifacts[0].path.split('/'));
  await writeFile(artifact, 'tampered\n');
  await assert.rejects(() => assertTerminalV7ScriptedReferenceArtifacts({
    evidenceRoot: fixture.resultRoot,
    root: ROOT,
    report: fixture.report,
    sealManifest: fixture.manifest,
    goldReport: fixture.goldReport,
    expectedVerifierImage: fixture.verifierImage,
  }), /artifact.*(?:regular file|hash mismatch)/);
}));
