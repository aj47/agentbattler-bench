import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertTerminalV7GoldReportArtifacts,
  terminalV7GoldImplementationDescriptors,
  TERMINAL_V7_GOLD_REPORT_SCHEMA,
  validateTerminalV7GoldReport,
} from '../scripts/validate-terminal-v7-golds.mjs';
import { canonicalJsonSha256 } from '../src/provenance.mjs';
import { createTerminalV7SealManifest } from '../src/terminal-v7-seals.mjs';

test('V7 gold gate is evidence-derived and routes every grade through the sealed verifier image', async () => {
  const source = await readFile(new URL('../scripts/validate-terminal-v7-golds.mjs', import.meta.url), 'utf8');
  assert.equal(TERMINAL_V7_GOLD_REPORT_SCHEMA, 'agentbattler.terminal-v7-gold-report.v1');
  assert.match(source, /verifyTerminalV7InContainer/);
  assert.match(source, /verifierSeedIndex < verifierSeeds/);
  assert.match(source, /V7_POOL_INSTANCES\[pool\]/);
  assert.match(source, /variants/);
  assert.match(source, /cleanMinCore/);
  assert.match(source, /decoyMinCore/);
  assert.match(source, /sourceSha256/);
  assert.doesNotMatch(source, /gold:\s*\{[^}]*cleanMinCore:\s*100/s);
});

test('V7 gold release gate rejects a shape-valid aggregate without row artifacts or reproducible gold bytes', async () => {
  const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-v7-fake-gold-'));
  try {
    const manifest = createTerminalV7SealManifest({
      revision: 'r1',
      seedKey: 'gold-gate-test-seed-key-0001',
      sealedAt: '2026-08-08T00:00:00.000Z',
    });
    const implementations = await terminalV7GoldImplementationDescriptors({ root: path.resolve('.') });
    const rows = [];
    for (const implementation of implementations) {
      for (const twin of manifest.packs) {
        for (const variant of ['clean', 'decoy']) {
          rows.push({
            implementationId: implementation.implementationId,
            pool: twin.pool,
            instanceId: twin.instanceId,
            variant,
            packSha256: twin[variant].packSha256,
            sealSha256: twin[variant].sealSha256,
            executableSourceSha256: '3'.repeat(64),
            verifierSeeds: 100,
            minimumCore: 100,
            exactCount: 100,
            infrastructureInvalid: 0,
            resultsSha256: '4'.repeat(64),
            evidencePath: `row-evidence/${implementation.implementationId}/${twin.instanceId}-${variant}.json`,
            evidenceFileSha256: '5'.repeat(64),
          });
        }
      }
    }
    const unsigned = {
      schemaVersion: TERMINAL_V7_GOLD_REPORT_SCHEMA,
      challengeId: 'terminal-mini-ledger-v7',
      revision: 'r1',
      createdAt: '2026-08-08T00:01:00.000Z',
      policy: {
        independentImplementations: 2,
        variants: ['clean', 'decoy'],
        verifierSeeds: 100,
        verifierBoundary: 'sealed-linux-strace-container',
      },
      verifierImage: { image: 'agentbattler-mini-ledger-v7-verifier:r1', imageId: `sha256:${'1'.repeat(64)}`, sourceSha256: '2'.repeat(64) },
      implementations,
      rows,
      summary: { independentImplementations: 2, verifierSeeds: 100, cleanMinCore: 100, decoyMinCore: 100, infrastructureInvalid: 0 },
    };
    const report = { ...unsigned, reportSha256: canonicalJsonSha256(unsigned) };
    assert.doesNotThrow(() => validateTerminalV7GoldReport(report, { revision: 'r1' }));
    await assert.rejects(
      assertTerminalV7GoldReportArtifacts({ evidenceRoot, root: path.resolve('.'), report, sealManifest: manifest }),
      /executable source no longer reproduces|evidence/,
    );
  } finally {
    await rm(evidenceRoot, { recursive: true, force: true });
  }
});
