import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJsonSha256, sha256File } from '../src/provenance.mjs';
import { assertTerminalV7TestReportArtifacts } from '../src/terminal-v7-release-evidence.mjs';
import {
  assertTerminalV7ExecutionIdentity,
  inspectTerminalV7ExecutionHost,
  inspectTerminalV7ExecutionSource,
  validateTerminalV7ExecutionHost,
} from '../src/terminal-v7-execution-identity.mjs';
import {
  buildTerminalV7ClaudeCliProbeAssets,
  parseTerminalV7Tap,
  runTerminalV7TestPreflights,
  TERMINAL_V7_CLAUDE_TOOL_POLICY,
  TERMINAL_V7_COMMON_RESOURCE_POLICY_SHA256,
  TERMINAL_V7_COMMON_SANDBOX_POLICY_SHA256,
  TERMINAL_V7_PREFLIGHT_EVIDENCE_SCHEMA,
  TERMINAL_V7_PREFLIGHT_HARNESSES,
  validateTerminalV7HarnessPreflightEvidence,
} from '../src/terminal-v7-preflights.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const REVIEWED_COMMIT = 'a'.repeat(40);
const REVISION = 'r1';
const LINUX_NAMES = ['HOME', 'LANG', 'LC_ALL', 'PATH', 'PWD', 'SHLVL', 'TMPDIR', 'TZ', '_'].sort();

function executionHost() {
  const unsigned = { schemaVersion: 'agentbattler.terminal-v7-execution-host.v1', role: 'm4-pro-execution-host', platform: 'darwin', architecture: 'arm64', chip: 'Apple M4 Pro', modelIdentifier: 'Mac16,8' };
  return { ...unsigned, identitySha256: canonicalJsonSha256(unsigned) };
}

function tap(tests = 3) {
  return `TAP version 13\n1..${tests}\n# tests ${tests}\n# suites 0\n# pass ${tests}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;
}

function boundary(harnessId) {
  const droid = harnessId === 'factory-droid';
  const controlDirectory = harnessId === 'dotagents-mono'
    ? 'sandbox-remounted-read-only'
    : droid
      ? 'os-sandbox-enforced-read-only'
      : 'root-owned-read-only';
  const value = {
    modelCommandCapabilities: 'exactly-zero',
    capabilityProof: droid
      ? { kind: 'darwin-no-linux-capability-facility', mask: null }
      : { kind: 'linux-proc-status-cap-eff', mask: '0000000000000000' },
    workspaceWrite: 'allowed-and-observed',
    hostRoot: 'masked-or-private-contents-denied',
    controlDirectory,
    outOfWorkspace: 'contents-enumeration-and-write-denied',
    network: 'denied',
    parentRouter: droid ? 'loopback-allowed-to-parent-only' : 'not-applicable',
    environment: {
      policy: 'fixed-minimal-non-secret-values-only',
      names: droid ? ['HOME', 'LANG', 'LC_ALL', 'NO_COLOR', 'PATH', 'TMPDIR', 'TZ', '__CF_USER_TEXT_ENCODING'] : LINUX_NAMES,
      unexpectedNames: [],
      sensitiveNames: [],
      valuesSha256: '8'.repeat(64),
    },
  };
  if (droid) {
    value.permittedTools = ['Execute'];
    value.toolExecutionProbe = {
      tool: 'Execute',
      actualRuntimeExecution: true,
      absoluteOutOfWorkspaceRead: 'denied-by-os-sandbox',
      observedToolCalls: 1,
      requestedToolSchemas: ['Execute'],
    };
  } else if (harnessId === 'claude-code') {
    value.permittedTools = ['Bash'];
    value.toolExecutionProbe = {
      tool: 'Bash',
      actualPinnedCliExecution: true,
      deterministicLocalProvider: true,
      absoluteOutOfWorkspaceRead: 'denied-by-native-sandbox',
      observedToolCalls: 1,
      observedToolResults: 1,
      requestedToolSchemas: ['Bash'],
    };
  }
  return value;
}

function evidence(harnessId = 'codex-cli') {
  return {
    schemaVersion: TERMINAL_V7_PREFLIGHT_EVIDENCE_SCHEMA,
    revision: REVISION,
    reviewedCommit: REVIEWED_COMMIT,
    createdAt: '2026-08-08T12:00:00.000Z',
    host: executionHost(),
    source: { head: REVIEWED_COMMIT, clean: true, detached: true },
    harnessId,
    passed: true,
    exactReleasePolicy: true,
    modelCommandCapabilities: 'exactly-zero',
    network: 'denied',
    outOfWorkspace: 'denied',
    controlDirectory: 'trusted-read-only',
    controlEnforcement: boundary(harnessId).controlDirectory,
    resourcePolicySha256: TERMINAL_V7_COMMON_RESOURCE_POLICY_SHA256,
    sandboxPolicySha256: TERMINAL_V7_COMMON_SANDBOX_POLICY_SHA256,
    releaseDescriptor: { matched: true, sha256: '2'.repeat(64) },
    verifierImage: {
      imageId: `sha256:${'3'.repeat(64)}`,
      sourceSha256: '4'.repeat(64),
      resourcePolicy: { cpus: 4, memoryBytes: 4 * 1024 * 1024 * 1024, pids: 256 },
      network: 'none',
      readOnlyRootFilesystem: true,
    },
    runtime: { kind: 'injected-unit-runtime', identitySha256: '5'.repeat(64) },
    candidateRuntime: { recorded: true, quotaKind: 'unit-fixture', asymmetries: [] },
    boundary: boundary(harnessId),
  };
}

function injectedDrivers({ failInspection = false } = {}) {
  let clock = 0;
  return {
    now: () => `2026-08-08T12:00:0${clock++}.000Z`,
    host: async () => executionHost(),
    sourceIdentity: async () => ({ head: REVIEWED_COMMIT, clean: true, detached: true }),
    releaseDescriptor: async () => ({
      matched: true,
      sha256: '2'.repeat(64),
      phaseCount: 5,
      perPhaseLimitMs: 1_500_000,
    }),
    inspectVerifier: async () => {
      if (failInspection) throw new Error('verifier image unavailable');
      return {
        imageId: `sha256:${'3'.repeat(64)}`,
        sourceSha256: '4'.repeat(64),
        resourcePolicy: { cpus: 4, memoryBytes: 4 * 1024 * 1024 * 1024, pids: 256 },
        network: 'none',
        readOnlyRootFilesystem: true,
      };
    },
    inspectHarborEnvironment: async () => ({ imageId: `sha256:${'6'.repeat(64)}`, sourceSha256: '7'.repeat(64) }),
    inspectDotAgents: async () => ({ imageId: `sha256:${'9'.repeat(64)}`, version: '1.1.9' }),
    runSuite: async ({ name }) => ({ log: tap(name === 'existing' ? 211 : 73) }),
    runHarness: async (harnessId) => ({
      runtime: { kind: 'injected-unit-runtime', identitySha256: canonicalJsonSha256({ harnessId }) },
      candidateRuntime: {
        recorded: true,
        quotaKind: harnessId === 'factory-droid' ? 'native-macos-no-cgroup-claim' : 'docker-cgroup-v2',
        asymmetries: harnessId === 'dotagents-mono' ? ['candidate-cpus:2-vs-harbor:4'] : [],
      },
      boundary: boundary(harnessId),
    }),
  };
}

test('V7 TAP parser requires a complete all-green Node test summary', () => {
  assert.deepEqual(parseTerminalV7Tap(tap(11)), { tests: 11, passedTests: 11, failures: 0 });
  assert.throws(() => parseTerminalV7Tap('TAP version 13\n1..1\n'), /omitted/);
  assert.throws(() => parseTerminalV7Tap('TAP version 13\n# tests 2\n# pass 1\n# fail 1\n'), /did not pass/);
});

test('V7 host proof accepts only Apple M4 Pro chip/model metadata and never collects unique identifiers', async () => {
  const requested = [];
  const host = await inspectTerminalV7ExecutionHost({
    platform: 'darwin',
    architecture: 'arm64',
    runCommand: async (_command, args) => {
      requested.push(args.join(' '));
      return args.at(-1) === 'machdep.cpu.brand_string' ? 'Apple M4 Pro' : 'Mac16,8';
    },
  });
  assert.deepEqual(requested.sort(), ['-n hw.model', '-n machdep.cpu.brand_string']);
  assert.equal(host.chip, 'Apple M4 Pro');
  assert.equal(JSON.stringify(host).match(/serial|uuid|hostname/gi), null);
  await assert.rejects(inspectTerminalV7ExecutionHost({
    platform: 'darwin',
    architecture: 'arm64',
    runCommand: async (_command, args) => args.at(-1) === 'machdep.cpu.brand_string' ? 'Apple M1 Pro' : 'MacBookPro18,3',
  }), /not an Apple M4 Pro/);
  const withSerialUnsigned = { ...host, serialNumber: 'must-not-persist' };
  delete withSerialUnsigned.identitySha256;
  assert.throws(() => validateTerminalV7ExecutionHost({ ...withSerialUnsigned, identitySha256: canonicalJsonSha256(withSerialUnsigned) }), /unique machine identifier/);
});

test('V7 execution identity fails closed on another host or any changed committed source byte', async () => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-v7-execution-identity-'));
  try {
    await writeFile(path.join(sourceRoot, 'runtime.mjs'), 'export const value = 1;\n');
    const adapters = { runtime: { path: 'runtime.mjs', sha256: await sha256File(path.join(sourceRoot, 'runtime.mjs')) } };
    const challenge = {
      execution: {
        executionHost: executionHost(),
        adapters,
        commitments: { reviewedCommit: REVIEWED_COMMIT, sourceSetSha256: canonicalJsonSha256(adapters) },
      },
    };
    const inspectSource = async () => ({ head: REVIEWED_COMMIT, clean: true, detached: true });
    const verified = await assertTerminalV7ExecutionIdentity({ root: sourceRoot, challenge, inspectHost: async () => executionHost(), inspectSource });
    assert.equal(verified.sourceSetSha256, canonicalJsonSha256(adapters));
    const otherHost = executionHost();
    const otherUnsigned = { ...otherHost, modelIdentifier: 'Mac16,7' };
    delete otherUnsigned.identitySha256;
    await assert.rejects(assertTerminalV7ExecutionIdentity({
      root: sourceRoot,
      challenge,
      inspectHost: async () => ({ ...otherUnsigned, identitySha256: canonicalJsonSha256(otherUnsigned) }),
      inspectSource,
    }), /differs from the preflight-bound/);
    await writeFile(path.join(sourceRoot, 'runtime.mjs'), 'export const value = 2;\n');
    await assert.rejects(assertTerminalV7ExecutionIdentity({ root: sourceRoot, challenge, inspectHost: async () => executionHost(), inspectSource }), /does not match its challenge commitment/);
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
  }
});

test('V7 execution source inspection rejects a dirty or non-reviewed checkout', async () => {
  const runCommand = async (_command, args) => {
    if (args[0] === 'rev-parse') return REVIEWED_COMMIT;
    if (args[0] === 'status') return ' M src/runtime.mjs';
    return '';
  };
  await assert.rejects(inspectTerminalV7ExecutionSource({ root: ROOT, reviewedCommit: REVIEWED_COMMIT, runCommand }), /source tree is dirty/);
  await assert.rejects(inspectTerminalV7ExecutionSource({
    root: ROOT,
    reviewedCommit: REVIEWED_COMMIT,
    runCommand: async (_command, args) => args[0] === 'rev-parse' ? 'b'.repeat(40) : '',
  }), /not the reviewed HEAD/);
});

test('V7 harness evidence rejects claimed passes without concrete boundary proof', () => {
  const valid = evidence();
  assert.equal(validateTerminalV7HarnessPreflightEvidence(valid), valid);
  const privileged = structuredClone(valid);
  privileged.boundary.capabilityProof.mask = '0000000000000001';
  assert.throws(() => validateTerminalV7HarnessPreflightEvidence(privileged), /CapEff/);
  const exposed = structuredClone(valid);
  exposed.boundary.controlDirectory = 'writable';
  assert.throws(() => validateTerminalV7HarnessPreflightEvidence(exposed), /control boundary/);
  const extraEnvironment = structuredClone(valid);
  extraEnvironment.boundary.environment.names.push('OPENAI_API_KEY');
  assert.throws(() => validateTerminalV7HarnessPreflightEvidence(extraEnvironment), /environment names changed/);

  const claude = evidence('claude-code');
  assert.equal(validateTerminalV7HarnessPreflightEvidence(claude), claude);
  delete claude.boundary.toolExecutionProbe.actualPinnedCliExecution;
  assert.throws(() => validateTerminalV7HarnessPreflightEvidence(claude), /Claude actual Bash-tool/);
});

test('V7 Claude preflight uses the pinned CLI and its only permitted Bash tool through a deterministic local provider', () => {
  const assets = buildTerminalV7ClaudeCliProbeAssets();
  assert.deepEqual(assets.descriptor.permittedTools, ['Bash']);
  assert.deepEqual(assets.descriptor.deniedTools, TERMINAL_V7_CLAUDE_TOOL_POLICY.deniedTools);
  assert.deepEqual(assets.descriptor.settings.permissions, {
    allow: ['Bash'],
    deny: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'NotebookEdit', 'WebFetch', 'WebSearch', 'mcp__*'],
  });
  assert.equal(assets.descriptor.settings.sandbox.bwrapPath, '/usr/local/bin/agentbattler-bwrap');
  assert.equal(assets.descriptor.settings.sandbox.allowUnsandboxedCommands, false);
  assert.equal(assets.descriptor.settings.sandbox.failIfUnavailable, true);
  assert.match(assets.command, /claude '--print' '--verbose' '--output-format' 'stream-json'/);
  assert.match(assets.command, /'--tools' 'Bash' '--allowedTools' 'Bash'/);
  assert.match(assets.command, /ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:19081/);
  assert.match(assets.mockProviderSource, /type: 'tool_use'.*name: 'Bash'/s);
  assert.match(assets.mockProviderSource, /AGENTBATTLER_V7_PROBE=passed/);
  assert.match(assets.mockProviderSource, /tool schema mismatch/);
});

test('V7 preflight orchestrator seals two suite logs and five independently hashed evidence files', async () => {
  const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-v7-preflights-test-'));
  try {
    const report = await runTerminalV7TestPreflights({
      root: ROOT,
      evidenceRoot,
      taskRoot: evidenceRoot,
      revision: REVISION,
      reviewedCommit: REVIEWED_COMMIT,
      drivers: injectedDrivers(),
    });
    assert.equal(report.passed, true);
    assert.equal(report.suites.existing.tests, 211);
    assert.equal(report.suites.v7.tests, 73);
    assert.deepEqual(report.preflights.map(({ harnessId }) => harnessId), TERMINAL_V7_PREFLIGHT_HARNESSES);
    assert.equal(new Set(report.preflights.map(({ resourcePolicySha256 }) => resourcePolicySha256)).size, 1);
    await assertTerminalV7TestReportArtifacts({ evidenceRoot, report });
    for (const projection of report.preflights) {
      const record = JSON.parse(await readFile(path.join(evidenceRoot, projection.evidencePath), 'utf8'));
      assert.equal(record.harnessId, projection.harnessId);
      assert.equal(canonicalJsonSha256(record), projection.evidenceSha256);
    }

    const first = report.preflights[0];
    const firstPath = path.join(evidenceRoot, first.evidencePath);
    const changed = JSON.parse(await readFile(firstPath, 'utf8'));
    changed.boundary.network = 'allowed';
    await writeFile(firstPath, `${JSON.stringify(changed)}\n`);
    await assert.rejects(assertTerminalV7TestReportArtifacts({ evidenceRoot, report }), /hash mismatch/);
  } finally {
    await rm(evidenceRoot, { recursive: true, force: true });
  }
});

test('V7 preflight orchestrator fails before writing a report when an image is unavailable', async () => {
  const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-v7-preflights-fail-'));
  const reportPath = path.join(evidenceRoot, 'test-preflight-report.json');
  try {
    await assert.rejects(runTerminalV7TestPreflights({
      root: ROOT,
      evidenceRoot,
      taskRoot: evidenceRoot,
      revision: REVISION,
      reviewedCommit: REVIEWED_COMMIT,
      drivers: injectedDrivers({ failInspection: true }),
    }), /verifier image unavailable/);
    await assert.rejects(access(reportPath));
  } finally {
    await rm(evidenceRoot, { recursive: true, force: true });
  }
});
