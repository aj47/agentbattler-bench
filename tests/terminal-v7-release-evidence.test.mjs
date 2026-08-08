import assert from 'node:assert/strict';
import test from 'node:test';

import {
  sealTerminalV7TestReport,
  validateTerminalV7BaseGateEvidence,
  validateTerminalV7TestReport,
} from '../src/terminal-v7-release-evidence.mjs';
import { canonicalJsonSha256 } from '../src/provenance.mjs';
import { TERMINAL_V7_REVIEW_TOPICS } from '../src/terminal-v7-gates.mjs';

const verifierImage = { imageId: `sha256:${'1'.repeat(64)}`, sourceSha256: '2'.repeat(64) };
const identity = { revision: 'r1', reviewedCommit: 'a'.repeat(40) };

function executionHost() {
  const unsigned = { schemaVersion: 'agentbattler.terminal-v7-execution-host.v1', role: 'm4-pro-execution-host', platform: 'darwin', architecture: 'arm64', chip: 'Apple M4 Pro', modelIdentifier: 'Mac16,8' };
  return { ...unsigned, identitySha256: canonicalJsonSha256(unsigned) };
}

function preflight(harnessId) {
  const controlEnforcement = harnessId === 'dotagents-mono'
    ? 'sandbox-remounted-read-only'
    : harnessId === 'factory-droid'
      ? 'os-sandbox-enforced-read-only'
      : 'root-owned-read-only';
  return {
    harnessId,
    passed: true,
    exactReleasePolicy: true,
    resourcePolicySha256: '3'.repeat(64),
    sandboxPolicySha256: '4'.repeat(64),
    executionHostSha256: executionHost().identitySha256,
    evidenceSha256: canonicalJsonSha256({ harnessId }),
    evidencePath: `preflights/${harnessId}.json`,
    modelCommandCapabilities: 'exactly-zero',
    network: 'denied',
    outOfWorkspace: 'denied',
    controlDirectory: 'trusted-read-only',
    controlEnforcement,
  };
}

function report() {
  return sealTerminalV7TestReport({
    schemaVersion: 'agentbattler.terminal-v7-test-preflight-report.v2',
    ...identity,
    createdAt: '2026-08-08T09:00:00.000Z',
    host: executionHost(),
    verifierImage,
    suites: {
      existing: { passed: true, tests: 211, failures: 0, logSha256: '5'.repeat(64), logPath: 'logs/existing.tap' },
      v7: { passed: true, tests: 69, failures: 0, logSha256: '6'.repeat(64), logPath: 'logs/v7.tap' },
    },
    preflights: ['claude-code', 'codex-cli', 'dotagents-mono', 'factory-droid', 'pi-coding-agent'].map(preflight),
    failures: 0,
    passed: true,
  });
}

test('V7 test report requires two green suites and five exact-policy M4 harness preflights', () => {
  const value = report();
  assert.equal(validateTerminalV7TestReport(value, { ...identity, verifierImage }), value);
  const changed = structuredClone(value);
  changed.preflights[0].modelCommandCapabilities = 'unknown';
  changed.reportSha256 = canonicalJsonSha256(Object.fromEntries(Object.entries(changed).filter(([key]) => key !== 'reportSha256')));
  assert.throws(() => validateTerminalV7TestReport(changed, { ...identity, verifierImage }), /isolation changed/);
});

test('V7 base evidence seal binds source artifacts and all three complete reviews', () => {
  const unsigned = {
    schemaVersion: 'agentbattler.terminal-v7-base-gate-evidence.v2',
    ...identity,
    evaluatedAt: '2026-08-08T09:00:00.000Z',
    executionHost: executionHost(),
    sourceArtifacts: { sealManifestSha256: '1'.repeat(64) },
    packSeals: Array.from({ length: 13 }, (_, index) => ({ instanceId: `pack-${index}`, pool: 'dev', sealSha256: '2'.repeat(64), sealedBeforePilot: true })),
    reviews: ['a', 'b', 'c'].map((reviewerId) => ({ reviewerId, approved: true, topics: [...TERMINAL_V7_REVIEW_TOPICS], reviewSha256: '3'.repeat(64) })),
  };
  const evidence = { ...unsigned, baseEvidenceSha256: canonicalJsonSha256(unsigned) };
  assert.equal(validateTerminalV7BaseGateEvidence(evidence), evidence);
  const tampered = structuredClone(evidence);
  tampered.packSeals.pop();
  assert.throws(() => validateTerminalV7BaseGateEvidence(tampered), /hash mismatch/);
});
