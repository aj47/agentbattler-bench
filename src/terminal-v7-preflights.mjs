import { spawn } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertDroidCredentialAbsent,
  createDroidV7SandboxProfile,
  droidV7SandboxLauncher,
  isolatedDroidV7Environment,
  resolveDroidV7RuntimeReadPaths,
  retireDroidCredentialSettings,
} from './droid-sandbox.mjs';
import {
  createDroidSettings,
  DROID_V7_RESTRICTED_TOOLS,
  materializeDroidSettingsCredential,
} from './droid-harness.mjs';
import { DroidJsonRpcSession } from './droid-jsonrpc.mjs';
import {
  buildDotAgentsDockerArgs,
  inspectDotAgentsV7Image,
} from './dotagents-harness.mjs';
import {
  canonicalJson,
  canonicalJsonSha256,
  sha256,
  sha256File,
} from './provenance.mjs';
import {
  assertTerminalV7TestReportArtifacts,
  sealTerminalV7TestReport,
  validateTerminalV7TestReport,
} from './terminal-v7-release-evidence.mjs';
import { terminalV7HarborTaskImageSources } from './terminal-v7-harbor-images.mjs';
import {
  MINI_LEDGER_V7_CANDIDATE_TREE_POLICY,
  MINI_LEDGER_V7_PHASE_COUNT,
  MINI_LEDGER_V7_PHASE_LIMIT_MS,
} from './terminal-v7-runtime.mjs';
import { inspectTerminalV7VerifierImage } from './terminal-v7-verifier-container.mjs';
import { verifyDroidRuntime } from './droid-runtime.mjs';
import { terminalHarnessVersion } from './terminal-harness-versions.mjs';
import {
  inspectTerminalV7ExecutionHost,
  inspectTerminalV7ExecutionSource,
  validateTerminalV7ExecutionHost,
} from './terminal-v7-execution-identity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA256_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;

export const TERMINAL_V7_PREFLIGHT_EVIDENCE_SCHEMA = 'agentbattler.terminal-v7-harness-preflight-evidence.v2';
export const TERMINAL_V7_PREFLIGHT_HARNESSES = Object.freeze([
  'claude-code',
  'codex-cli',
  'dotagents-mono',
  'factory-droid',
  'pi-coding-agent',
]);

// This is the portion of the release resource contract that is genuinely
// common across substrates. Candidate-runtime quotas remain explicit in each
// harness record: Harbor currently grants four CPUs, DotAgents two CPUs, and
// native Droid has no Linux cgroup. The shared verifier and scoring surface do
// not vary by harness.
export const TERMINAL_V7_COMMON_RESOURCE_POLICY = Object.freeze({
  schemaVersion: 'agentbattler.terminal-v7-common-resource-policy.v1',
  runnerConcurrency: 1,
  jobsPerRunner: 1,
  phaseCount: MINI_LEDGER_V7_PHASE_COUNT,
  perPhaseLimitMs: MINI_LEDGER_V7_PHASE_LIMIT_MS,
  candidateTree: MINI_LEDGER_V7_CANDIDATE_TREE_POLICY,
  sharedVerifier: Object.freeze({
    cpus: 4,
    memoryBytes: 4 * 1024 * 1024 * 1024,
    pids: 256,
    network: 'none',
    readOnlyRootFilesystem: true,
  }),
  candidateRuntimeQuotaPolicy: 'harness-specific-recorded-separately',
});

export const TERMINAL_V7_COMMON_SANDBOX_POLICY = Object.freeze({
  schemaVersion: 'agentbattler.terminal-v7-command-sandbox-policy.v1',
  modelCommandCapabilities: 'exactly-zero-or-no-linux-capability-facility',
  workspaceWrite: 'allowed',
  hostRoot: 'masked-or-private-contents-denied',
  controlDirectory: 'trusted-read-only-with-harness-specific-enforcement',
  outOfWorkspace: 'contents-enumeration-and-write-denied',
  network: 'denied-for-model-commands',
  droidParentNetwork: 'authenticated-loopback-router-only',
  environment: 'fixed-minimal-non-secret-values-only',
  blockedAttempts: 'ordinary-scoreable-tool-errors',
});

export const TERMINAL_V7_COMMON_RESOURCE_POLICY_SHA256 = canonicalJsonSha256(TERMINAL_V7_COMMON_RESOURCE_POLICY);
export const TERMINAL_V7_COMMON_SANDBOX_POLICY_SHA256 = canonicalJsonSha256(TERMINAL_V7_COMMON_SANDBOX_POLICY);

const LINUX_FIXED_ENVIRONMENT = Object.freeze({
  HOME: '/tmp',
  LANG: 'C',
  LC_ALL: 'C',
  PATH: '/usr/local/bin:/usr/bin:/bin',
  TMPDIR: '/tmp',
  TZ: 'UTC',
});
const LINUX_SHELL_ENV_NAMES = Object.freeze([...Object.keys(LINUX_FIXED_ENVIRONMENT), 'PWD', 'SHLVL', '_'].sort());
export const TERMINAL_V7_CLAUDE_TOOL_POLICY = Object.freeze({
  permittedTools: Object.freeze(['Bash']),
  deniedTools: Object.freeze(['Read', 'Edit', 'Write', 'Glob', 'Grep', 'NotebookEdit', 'WebFetch', 'WebSearch', 'mcp__*']),
  providerProtocol: 'deterministic-local-anthropic-messages-sse',
  providerPort: 19_081,
  model: 'gpt-5.6-luna',
  toolCommand: '/usr/local/bin/agentbattler-v7-preflight-probe | tee /app/src/.agentbattler-v7-claude-tool-output',
});

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function safeRelative(value, label) {
  invariant(typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !value.includes('\0'), `${label} path is invalid`);
  const normalized = path.posix.normalize(value.replaceAll(path.sep, '/'));
  invariant(normalized !== '..' && !normalized.startsWith('../'), `${label} path escapes its evidence root`);
  return normalized;
}

function safeAbsolute(value, label) {
  invariant(typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0'), `${label} must be absolute`);
  return path.resolve(value);
}

function sameMembers(left, right) {
  return left.length === right.length
    && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

export function parseTerminalV7Tap(log, label = 'test suite') {
  invariant(typeof log === 'string' && log.length > 0, `${label} emitted no test log`);
  const tests = [...log.matchAll(/^# tests (\d+)\s*$/gm)].at(-1);
  const pass = [...log.matchAll(/^# pass (\d+)\s*$/gm)].at(-1);
  const fail = [...log.matchAll(/^# fail (\d+)\s*$/gm)].at(-1);
  invariant(tests && pass && fail, `${label} omitted the Node test summary`);
  const summary = {
    tests: Number(tests[1]),
    passedTests: Number(pass[1]),
    failures: Number(fail[1]),
  };
  invariant(Number.isSafeInteger(summary.tests) && summary.tests > 0, `${label} test count is invalid`);
  invariant(summary.failures === 0 && summary.passedTests === summary.tests, `${label} did not pass every test`);
  return summary;
}

export function validateTerminalV7HarnessPreflightEvidence(evidence, {
  harnessId = evidence?.harnessId,
  revision = evidence?.revision,
  reviewedCommit = evidence?.reviewedCommit,
} = {}) {
  invariant(evidence?.schemaVersion === TERMINAL_V7_PREFLIGHT_EVIDENCE_SCHEMA, 'Unsupported V7 harness-preflight evidence schema');
  invariant(TERMINAL_V7_PREFLIGHT_HARNESSES.includes(harnessId) && evidence.harnessId === harnessId, 'V7 preflight harness identity changed');
  invariant(/^r[1-9]\d*$/.test(revision ?? '') && evidence.revision === revision, 'V7 preflight revision changed');
  invariant(COMMIT_RE.test(reviewedCommit ?? '') && evidence.reviewedCommit === reviewedCommit, 'V7 preflight reviewed commit changed');
  invariant(typeof evidence.createdAt === 'string' && Number.isFinite(Date.parse(evidence.createdAt)), 'V7 preflight timestamp is invalid');
  validateTerminalV7ExecutionHost(evidence.host);
  invariant(evidence.source?.head === reviewedCommit
    && evidence.source?.clean === true
    && evidence.source?.detached === true, 'V7 preflight source is not the clean detached reviewed commit');
  invariant(evidence.passed === true && evidence.exactReleasePolicy === true, `V7 ${harnessId} preflight did not pass`);
  invariant(evidence.modelCommandCapabilities === 'exactly-zero'
    && evidence.network === 'denied'
    && evidence.outOfWorkspace === 'denied'
    && evidence.controlDirectory === 'trusted-read-only', `V7 ${harnessId} report projection changed`);
  invariant(evidence.resourcePolicySha256 === TERMINAL_V7_COMMON_RESOURCE_POLICY_SHA256, `V7 ${harnessId} common resource policy changed`);
  invariant(evidence.sandboxPolicySha256 === TERMINAL_V7_COMMON_SANDBOX_POLICY_SHA256, `V7 ${harnessId} common sandbox policy changed`);
  invariant(evidence.releaseDescriptor?.matched === true
    && SHA256_RE.test(evidence.releaseDescriptor?.sha256 ?? ''), `V7 ${harnessId} release descriptor was not matched`);
  invariant(evidence.runtime && typeof evidence.runtime === 'object'
    && SHA256_RE.test(evidence.runtime.identitySha256 ?? ''), `V7 ${harnessId} runtime identity is incomplete`);
  invariant(evidence.candidateRuntime?.recorded === true
    && typeof evidence.candidateRuntime?.quotaKind === 'string', `V7 ${harnessId} candidate runtime limits were not recorded`);
  invariant(evidence.verifierImage?.resourcePolicy?.cpus === TERMINAL_V7_COMMON_RESOURCE_POLICY.sharedVerifier.cpus
    && evidence.verifierImage?.resourcePolicy?.memoryBytes === TERMINAL_V7_COMMON_RESOURCE_POLICY.sharedVerifier.memoryBytes
    && evidence.verifierImage?.resourcePolicy?.pids === TERMINAL_V7_COMMON_RESOURCE_POLICY.sharedVerifier.pids
    && evidence.verifierImage?.network === 'none'
    && evidence.verifierImage?.readOnlyRootFilesystem === true, `V7 ${harnessId} shared verifier resource proof changed`);

  const boundary = evidence.boundary;
  invariant(boundary?.modelCommandCapabilities === 'exactly-zero', `V7 ${harnessId} did not prove an unprivileged model command`);
  invariant(boundary.workspaceWrite === 'allowed-and-observed', `V7 ${harnessId} workspace write probe failed`);
  invariant(boundary.hostRoot === 'masked-or-private-contents-denied', `V7 ${harnessId} host root remained exposed`);
  const expectedControl = harnessId === 'dotagents-mono'
    ? 'sandbox-remounted-read-only'
    : harnessId === 'factory-droid'
      ? 'os-sandbox-enforced-read-only'
      : 'root-owned-read-only';
  invariant(evidence.controlEnforcement === expectedControl, `V7 ${harnessId} control enforcement projection changed`);
  invariant(boundary.controlDirectory === expectedControl, `V7 ${harnessId} control boundary changed`);
  invariant(boundary.outOfWorkspace === 'contents-enumeration-and-write-denied', `V7 ${harnessId} out-of-workspace boundary changed`);
  invariant(boundary.network === 'denied', `V7 ${harnessId} model-command network probe failed`);
  invariant(boundary.environment?.policy === 'fixed-minimal-non-secret-values-only'
    && Array.isArray(boundary.environment.names)
    && boundary.environment.names.length > 0
    && boundary.environment.unexpectedNames?.length === 0
    && boundary.environment.sensitiveNames?.length === 0
    && SHA256_RE.test(boundary.environment.valuesSha256 ?? ''), `V7 ${harnessId} environment proof is incomplete`);
  if (harnessId === 'factory-droid') {
    invariant(boundary.capabilityProof?.kind === 'darwin-no-linux-capability-facility', 'V7 Droid capability proof changed');
    invariant(boundary.parentRouter === 'loopback-allowed-to-parent-only', 'V7 Droid parent router exception was not proved');
    invariant(sameMembers(boundary.permittedTools ?? [], DROID_V7_RESTRICTED_TOOLS), 'V7 Droid must expose only its child-isolated Execute tool');
    invariant(boundary.toolExecutionProbe?.tool === 'Execute'
      && boundary.toolExecutionProbe?.actualRuntimeExecution === true
      && boundary.toolExecutionProbe?.absoluteOutOfWorkspaceRead === 'denied-by-os-sandbox'
      && boundary.toolExecutionProbe?.observedToolCalls === 1
      && sameMembers(boundary.toolExecutionProbe?.requestedToolSchemas ?? [], DROID_V7_RESTRICTED_TOOLS), 'V7 Droid actual Execute-tool filesystem probe is incomplete');
  } else {
    invariant(boundary.capabilityProof?.kind === 'linux-proc-status-cap-eff'
      && /^0+$/.test(boundary.capabilityProof?.mask ?? ''), `V7 ${harnessId} CapEff was not exactly zero`);
    invariant(sameMembers(boundary.environment.names, LINUX_SHELL_ENV_NAMES), `V7 ${harnessId} command environment names changed`);
    if (harnessId === 'claude-code') {
      invariant(sameMembers(boundary.permittedTools ?? [], TERMINAL_V7_CLAUDE_TOOL_POLICY.permittedTools), 'V7 Claude must expose only its bwrap-contained Bash tool');
      invariant(boundary.toolExecutionProbe?.tool === 'Bash'
        && boundary.toolExecutionProbe?.actualPinnedCliExecution === true
        && boundary.toolExecutionProbe?.deterministicLocalProvider === true
        && boundary.toolExecutionProbe?.absoluteOutOfWorkspaceRead === 'denied-by-native-sandbox'
        && boundary.toolExecutionProbe?.observedToolCalls === 1
        && boundary.toolExecutionProbe?.observedToolResults === 1
        && sameMembers(boundary.toolExecutionProbe?.requestedToolSchemas ?? [], TERMINAL_V7_CLAUDE_TOOL_POLICY.permittedTools), 'V7 Claude actual Bash-tool filesystem probe is incomplete');
    }
  }
  return evidence;
}

export function terminalV7PreflightProjection(evidence, evidencePath) {
  validateTerminalV7HarnessPreflightEvidence(evidence);
  return Object.freeze({
    harnessId: evidence.harnessId,
    passed: true,
    exactReleasePolicy: true,
    resourcePolicySha256: evidence.resourcePolicySha256,
    sandboxPolicySha256: evidence.sandboxPolicySha256,
    executionHostSha256: evidence.host.identitySha256,
    evidenceSha256: canonicalJsonSha256(evidence),
    evidencePath: safeRelative(evidencePath, `V7 ${evidence.harnessId} preflight`),
    modelCommandCapabilities: 'exactly-zero',
    network: 'denied',
    outOfWorkspace: 'denied',
    controlDirectory: 'trusted-read-only',
    controlEnforcement: evidence.controlEnforcement,
  });
}

function capture(command, args, {
  cwd = ROOT,
  env = process.env,
  timeoutMs = 30_000,
} = {}) {
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        timedOut,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await lstat(file).then(
    () => { throw new Error(`V7 evidence artifact already exists: ${path.basename(file)}`); },
    (error) => { if (error?.code !== 'ENOENT') throw error; },
  );
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${canonicalJson(value, { space: 2 })}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
}

async function atomicLog(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await lstat(file).then(
    () => { throw new Error(`V7 evidence artifact already exists: ${path.basename(file)}`); },
    (error) => { if (error?.code !== 'ENOENT') throw error; },
  );
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, value, { mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
}

async function defaultSourceIdentity({ root, reviewedCommit }) {
  return inspectTerminalV7ExecutionSource({ root, reviewedCommit });
}

function sanitizedSuiteEnvironment(home) {
  return Object.freeze({
    PATH: process.env.PATH ?? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    TMPDIR: path.join(home, 'tmp'),
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
    CI: '1',
    NO_COLOR: '1',
    npm_config_cache: path.join(home, 'npm-cache'),
  });
}

async function defaultRunSuite({ root, name, files, home }) {
  await mkdir(path.join(home, 'tmp'), { recursive: true, mode: 0o700 });
  const command = name === 'existing' ? 'npm' : process.execPath;
  const args = name === 'existing'
    ? ['test', '--', '--test-reporter=tap']
    : ['--test', '--test-reporter=tap', ...files];
  const result = await capture(command, args, {
    cwd: root,
    env: sanitizedSuiteEnvironment(home),
    timeoutMs: name === 'existing' ? 45 * 60 * 1000 : 30 * 60 * 1000,
  });
  invariant(result.code === 0 && !result.signal && !result.timedOut, `V7 ${name} test suite failed`);
  return { log: `${result.stdout}${result.stderr}` };
}

async function v7TestFiles(root) {
  const entries = await readdir(path.join(root, 'tests'), { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile()
      && (entry.name === 'mini-ledger-v7.test.mjs' || entry.name.startsWith('terminal-v7'))
      && entry.name.endsWith('.test.mjs'))
    .map(({ name }) => path.join('tests', name))
    .sort();
  invariant(files.length >= 10, 'V7 focused test suite is unexpectedly incomplete');
  return files;
}

function taskSection(document, section) {
  const match = document.match(new RegExp(`(?:^|\\n)\\[${section.replaceAll('.', '\\\\.')}\\]\\n([\\s\\S]*?)(?=\\n\\[|$)`));
  invariant(match, `V7 task descriptor omitted [${section}]`);
  return match[1];
}

function tomlInteger(section, name) {
  const match = section.match(new RegExp(`^${name}\\s*=\\s*(\\d+)\\s*$`, 'm'));
  invariant(match, `V7 task descriptor omitted ${name}`);
  return Number(match[1]);
}

async function defaultReleaseDescriptor({ taskRoot }) {
  const taskPath = path.join(taskRoot, 'task.toml');
  const document = await readFile(taskPath, 'utf8');
  invariant(tomlInteger(taskSection(document, 'metadata'), 'phase_count') === MINI_LEDGER_V7_PHASE_COUNT, 'V7 release task phase count changed');
  invariant(tomlInteger(taskSection(document, 'metadata'), 'agent_time_limit_sec_per_phase') * 1000 === MINI_LEDGER_V7_PHASE_LIMIT_MS, 'V7 release task phase limit changed');
  const environment = taskSection(document, 'environment');
  const verifier = taskSection(document, 'verifier.environment');
  invariant(tomlInteger(environment, 'cpus') === 4
    && tomlInteger(environment, 'memory_mb') === 4096
    && tomlInteger(environment, 'storage_mb') === 8192, 'V7 Harbor candidate resource descriptor changed');
  invariant(tomlInteger(verifier, 'cpus') === 4
    && tomlInteger(verifier, 'memory_mb') === 4096
    && tomlInteger(verifier, 'storage_mb') === 8192, 'V7 Harbor verifier resource descriptor changed');
  return {
    matched: true,
    sha256: await sha256File(taskPath),
    phaseCount: MINI_LEDGER_V7_PHASE_COUNT,
    perPhaseLimitMs: MINI_LEDGER_V7_PHASE_LIMIT_MS,
    harborCandidate: { cpus: 4, memoryBytes: 4 * 1024 * 1024 * 1024, storageBytes: 8 * 1024 * 1024 * 1024 },
    harborVerifier: { cpus: 4, memoryBytes: 4 * 1024 * 1024 * 1024, storageBytes: 8 * 1024 * 1024 * 1024 },
  };
}

async function inspectHarborEnvironment({ taskRoot }) {
  const sources = await terminalV7HarborTaskImageSources({ taskRoot });
  const result = await capture('docker', ['image', 'inspect', sources.environment.image], { timeoutMs: 30_000 });
  invariant(result.code === 0 && !result.signal && !result.timedOut, 'V7 Harbor environment image is unavailable');
  const inspected = JSON.parse(result.stdout)[0];
  invariant(/^sha256:[0-9a-f]{64}$/.test(inspected?.Id ?? ''), 'V7 Harbor environment image ID is invalid');
  invariant(inspected.Config?.Labels?.['org.agentbattler.v7.context-sha256'] === sources.environment.sourceSha256, 'V7 Harbor environment image source label changed');
  invariant(inspected.Os === 'linux' && inspected.Architecture === 'arm64', 'V7 Harbor environment image must be Linux arm64');
  return Object.freeze({ ...sources.environment, imageId: inspected.Id, os: inspected.Os, architecture: inspected.Architecture });
}

function runtimeIdentity(runtime) {
  return { ...runtime, identitySha256: canonicalJsonSha256(runtime) };
}

function cgroupQuota(cpus) {
  return Object.freeze({ cpus, memoryBytes: 4 * 1024 * 1024 * 1024, pids: 256 });
}

function parseProbeLines(stdout) {
  const lines = Object.fromEntries(stdout.split(/\r?\n/).flatMap((line) => {
    const index = line.indexOf('=');
    return line.startsWith('AGENTBATTLER_V7_') && index > 0 ? [[line.slice(0, index), line.slice(index + 1)]] : [];
  }));
  invariant(lines.AGENTBATTLER_V7_PROBE === 'passed', 'V7 command sandbox probe did not finish');
  invariant(/^0+$/.test(lines.AGENTBATTLER_V7_CAPEFF ?? ''), 'V7 command sandbox retained effective capabilities');
  const names = (lines.AGENTBATTLER_V7_ENV_NAMES ?? '').split(',').filter(Boolean).sort();
  invariant(sameMembers(names, LINUX_SHELL_ENV_NAMES), `V7 command sandbox environment changed: ${names.join(',')}`);
  const cpu = (lines.AGENTBATTLER_V7_CPU_MAX ?? '').split(/\s+/).map(Number);
  return {
    capEff: lines.AGENTBATTLER_V7_CAPEFF,
    environmentNames: names,
    environmentValuesSha256: lines.AGENTBATTLER_V7_ENV_SHA256,
    cgroup: {
      cpuQuota: cpu[0],
      cpuPeriod: cpu[1],
      memoryMaxBytes: Number(lines.AGENTBATTLER_V7_MEMORY_MAX),
      pidsMax: Number(lines.AGENTBATTLER_V7_PIDS_MAX),
    },
  };
}

function assertCgroup(probe, quota) {
  invariant(probe.cgroup.cpuQuota === quota.cpus * probe.cgroup.cpuPeriod, 'V7 candidate CPU cgroup differs from its harness runtime');
  invariant(probe.cgroup.memoryMaxBytes === quota.memoryBytes, 'V7 candidate memory cgroup differs from its harness runtime');
  invariant(probe.cgroup.pidsMax === quota.pids, 'V7 candidate PID cgroup differs from its harness runtime');
}

function linuxProbeScript({ rootOwnedControl = true } = {}) {
  const fixedHash = canonicalJsonSha256(LINUX_FIXED_ENVIRONMENT);
  return `#!/usr/bin/env bash
set -euo pipefail
workspace=/app
if [[ ! -d "$workspace/.agentbattler/current" ]]; then workspace=/workspace; fi
cap="$(sed -n 's/^CapEff:[[:space:]]*//p' /proc/self/status)"
case "$cap" in ''|*[!0]*) exit 70;; esac
printf 'workspace-write-ok\n' >"$workspace/src/.agentbattler-v7-preflight-write"
test "$(cat "$workspace/src/.agentbattler-v7-preflight-write")" = workspace-write-ok
control="$workspace/.agentbattler/current/task-contract.json"
test -r "$control"
${rootOwnedControl ? `test "$(stat -c '%u:%g' "$workspace/.agentbattler")" = 0:0
test "$(stat -c '%u:%g' "$workspace/.agentbattler/current")" = 0:0
test "$(stat -c '%u:%g' "$control")" = 0:0` : ''}
if (printf 'tamper\n' >"$control") 2>/dev/null; then exit 71; fi
if chmod 0644 "$control" >/dev/null 2>&1; then exit 72; fi
if [[ -e /agentbattler-host-private/secret ]]; then exit 73; fi
if ls /agentbattler-host-private >/dev/null 2>&1; then exit 74; fi
if (printf tamper >/agentbattler-host-private/tamper) 2>/dev/null; then exit 75; fi
if timeout 2 bash -c '</dev/tcp/127.0.0.1/19080' >/dev/null 2>&1; then exit 76; fi
names="$(env | sed 's/=.*//' | LC_ALL=C sort | paste -sd, -)"
values_hash="$(node - <<'NODE'
const crypto = require('node:crypto');
const fixed = Object.fromEntries(['HOME','LANG','LC_ALL','PATH','TMPDIR','TZ'].sort().map((name) => [name, process.env[name]]));
const stable = JSON.stringify(Object.fromEntries(Object.entries(fixed).sort()));
process.stdout.write(crypto.createHash('sha256').update(stable).digest('hex'));
NODE
)"
test "$values_hash" = ${fixedHash}
printf 'AGENTBATTLER_V7_CAPEFF=%s\n' "$cap"
printf 'AGENTBATTLER_V7_ENV_NAMES=%s\n' "$names"
printf 'AGENTBATTLER_V7_ENV_SHA256=%s\n' "$values_hash"
printf 'AGENTBATTLER_V7_CPU_MAX=%s\n' "$(cat /sys/fs/cgroup/cpu.max)"
printf 'AGENTBATTLER_V7_MEMORY_MAX=%s\n' "$(cat /sys/fs/cgroup/memory.max)"
printf 'AGENTBATTLER_V7_PIDS_MAX=%s\n' "$(cat /sys/fs/cgroup/pids.max)"
printf 'AGENTBATTLER_V7_PROBE=passed\n'
`;
}

function outerServerShell(inner, { rootOwnedControl = true, workspaceTarget = '/app' } = {}) {
  const encoded = Buffer.from(inner).toString('base64');
  return `set -euo pipefail
${rootOwnedControl ? `chown -R 0:0 ${workspaceTarget}/.agentbattler` : ''}
chmod 0755 ${workspaceTarget}/.agentbattler
chmod 0555 ${workspaceTarget}/.agentbattler/current
chmod 0444 ${workspaceTarget}/.agentbattler/current/task-contract.json
node -e 'require("node:http").createServer((q,r)=>r.end("outer-ok")).listen(19080,"127.0.0.1")' &
server=$!
trap 'kill "$server" 2>/dev/null || true' EXIT
for attempt in $(seq 1 50); do
  if bash -c '</dev/tcp/127.0.0.1/19080' >/dev/null 2>&1; then break; fi
  sleep 0.05
done
bash -c '</dev/tcp/127.0.0.1/19080'
printf '%s' '${encoded}' | base64 -d >/tmp/agentbattler-v7-inner.sh
chmod 0700 /tmp/agentbattler-v7-inner.sh
exec /tmp/agentbattler-v7-inner.sh
`;
}

async function prepareLinuxWorkspace(root, prefix, { rootOwnedControl = true } = {}) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), prefix));
  const workspace = path.join(scratch, 'workspace');
  const tools = path.join(scratch, 'tools');
  const hostPrivate = path.join(scratch, 'host-private');
  await Promise.all([
    mkdir(path.join(workspace, 'src'), { recursive: true, mode: 0o755 }),
    mkdir(path.join(workspace, '.agentbattler', 'current'), { recursive: true, mode: 0o755 }),
    mkdir(tools, { recursive: true, mode: 0o700 }),
    mkdir(hostPrivate, { recursive: true, mode: 0o700 }),
  ]);
  await writeFile(path.join(workspace, '.agentbattler', 'current', 'task-contract.json'), '{}\n', { mode: 0o444 });
  await writeFile(path.join(hostPrivate, 'secret'), 'outer-private\n', { mode: 0o600 });
  await chmod(path.join(workspace, '.agentbattler', 'current'), 0o555);
  const probePath = path.join(tools, 'probe.sh');
  await writeFile(probePath, linuxProbeScript({ rootOwnedControl }), { mode: 0o755 });
  return { scratch, workspace, tools, hostPrivate, probePath, root };
}

function dockerProbeArgs({ imageId, workspace, probePath, quota, mounts = [], entrypoint = '/bin/bash', command, rootOwnedControl = true, workspaceTarget = '/app' }) {
  const hostPrivate = path.join(path.dirname(workspace), 'host-private');
  return [
    'run', '--rm', '--read-only', '--network', 'none',
    '--cap-drop', 'ALL', '--cap-add', 'SYS_ADMIN', '--cap-add', 'NET_ADMIN',
    '--security-opt', 'no-new-privileges', '--security-opt', 'seccomp=unconfined',
    '--pids-limit', String(quota.pids), '--memory', String(quota.memoryBytes), '--cpus', String(quota.cpus),
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=512m',
    '--mount', `type=bind,src=${workspace},dst=${workspaceTarget}`,
    '--mount', `type=bind,src=${hostPrivate},dst=/agentbattler-host-private,readonly`,
    '--mount', `type=bind,src=${probePath},dst=/usr/local/bin/agentbattler-v7-preflight-probe,readonly`,
    ...mounts.flatMap(({ source, target, readonly = true }) => ['--mount', `type=bind,src=${source},dst=${target}${readonly ? ',readonly' : ''}`]),
    '--entrypoint', entrypoint,
    imageId,
    '-lc', outerServerShell(command, { rootOwnedControl, workspaceTarget }),
  ];
}

function linuxBoundary(probe, controlDirectory = 'root-owned-read-only') {
  return {
    modelCommandCapabilities: 'exactly-zero',
    capabilityProof: { kind: 'linux-proc-status-cap-eff', mask: probe.capEff },
    workspaceWrite: 'allowed-and-observed',
    hostRoot: 'masked-or-private-contents-denied',
    controlDirectory,
    outOfWorkspace: 'contents-enumeration-and-write-denied',
    network: 'denied',
    parentRouter: 'not-applicable',
    environment: {
      policy: 'fixed-minimal-non-secret-values-only',
      names: probe.environmentNames,
      unexpectedNames: [],
      sensitiveNames: [],
      valuesSha256: probe.environmentValuesSha256,
    },
  };
}

export function terminalV7ClaudeCliProbeDescriptor() {
  const policy = TERMINAL_V7_CLAUDE_TOOL_POLICY;
  return {
    cliVersion: terminalHarnessVersion('claude-code'),
    model: policy.model,
    providerProtocol: policy.providerProtocol,
    providerPort: policy.providerPort,
    permittedTools: [...policy.permittedTools],
    deniedTools: [...policy.deniedTools],
    toolCommand: policy.toolCommand,
    prompt: 'Use the Bash tool exactly once. Run the requested local boundary probe, then report completion.',
    settings: {
      permissions: {
        allow: [...policy.permittedTools],
        deny: [...policy.deniedTools],
      },
      sandbox: {
        enabled: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        failIfUnavailable: true,
        bwrapPath: '/usr/local/bin/agentbattler-bwrap',
        network: { allowedDomains: [], deniedDomains: [] },
        filesystem: {
          denyRead: ['/root', '/logs', '/tests', '/proc'],
          allowRead: ['/app'],
          allowWrite: ['/app', '/tmp'],
          denyWrite: ['/root', '/logs', '/tests'],
        },
      },
    },
  };
}

function claudeMockProviderSource(descriptor) {
  return `import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const expectedCommand = ${JSON.stringify(descriptor.toolCommand)};
const expectedTools = ${JSON.stringify(descriptor.permittedTools)};
const summaryPath = '/app/src/.agentbattler-v7-claude-provider-summary.json';
let messageRequests = 0;
let toolCallsIssued = 0;
let toolResultsObserved = 0;

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function message(body, content, stopReason) {
  return {
    id: 'msg_agentbattler_v7_claude_preflight',
    type: 'message',
    role: 'assistant',
    model: body.model || ${JSON.stringify(descriptor.model)},
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

function stream(response, body, content, stopReason) {
  const completed = message(body, content, stopReason);
  const events = [{ type: 'message_start', message: { ...completed, content: [], stop_reason: null } }];
  for (const [index, block] of content.entries()) {
    if (block.type === 'tool_use') {
      events.push({ type: 'content_block_start', index, content_block: { ...block, input: {} } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    } else {
      events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
    }
    events.push({ type: 'content_block_stop', index });
  }
  events.push({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 10 } });
  events.push({ type: 'message_stop' });
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const event of events) response.write('event: ' + event.type + '\\ndata: ' + JSON.stringify(event) + '\\n\\n');
  response.end();
}

function send(response, body, content, stopReason) {
  if (body.stream === true) stream(response, body, content, stopReason);
  else json(response, 200, message(body, content, stopReason));
}

const server = createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    if (request.url && request.url.includes('count_tokens')) {
      json(response, 200, { input_tokens: 10 });
      return;
    }
    if (request.method !== 'POST' || !request.url || !request.url.startsWith('/v1/messages')) {
      json(response, 404, { type: 'error', error: { type: 'not_found_error', message: 'local preflight endpoint' } });
      return;
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { json(response, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'invalid JSON' } }); return; }
    messageRequests += 1;
    const requestedTools = (body.tools || []).map((tool) => tool.name).filter(Boolean).sort();
    if (JSON.stringify(requestedTools) !== JSON.stringify(expectedTools)) {
      json(response, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'tool schema mismatch' } });
      return;
    }
    const toolResult = (body.messages || []).flatMap((entry) => Array.isArray(entry.content) ? entry.content : []).find((block) => block && block.type === 'tool_result');
    if (!toolResult) {
      if (toolCallsIssued !== 0) {
        json(response, 409, { type: 'error', error: { type: 'invalid_request_error', message: 'duplicate tool request' } });
        return;
      }
      toolCallsIssued += 1;
      send(response, body, [{ type: 'tool_use', id: 'toolu_agentbattler_v7_preflight', name: 'Bash', input: { command: expectedCommand } }], 'tool_use');
      return;
    }
    const renderedResult = JSON.stringify(toolResult.content);
    if (toolResult.is_error === true || !renderedResult.includes('AGENTBATTLER_V7_PROBE=passed')) {
      json(response, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'boundary probe tool failed' } });
      return;
    }
    toolResultsObserved += 1;
    writeFileSync(summaryPath, JSON.stringify({
      providerProtocol: ${JSON.stringify(descriptor.providerProtocol)},
      messageRequests,
      toolCallsIssued,
      toolResultsObserved,
      requestedToolSchemas: requestedTools,
      probeOutputObserved: true,
    }) + '\\n', { mode: 0o600 });
    send(response, body, [{ type: 'text', text: 'TOOL_PROBE_COMPLETE' }], 'end_turn');
  });
});

server.listen(${descriptor.providerPort}, '127.0.0.1');
`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function claudeCliProbeCommand(descriptor) {
  const args = [
    '--print',
    '--verbose',
    '--output-format', 'stream-json',
    '--model', descriptor.model,
    '--tools', descriptor.permittedTools.join(','),
    '--allowedTools', descriptor.permittedTools.join(','),
    '--disallowedTools', descriptor.deniedTools.join(','),
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-chrome',
    descriptor.prompt,
  ];
  return `set -euo pipefail
home=/tmp/agentbattler-v7-claude-home
rm -rf "$home"
mkdir -p "$home/.claude"
cp /usr/local/share/agentbattler-v7-claude-settings.json "$home/.claude/settings.json"
chown -R 0:0 "$home"
chmod 0555 "$home/.claude"
chmod 0444 "$home/.claude/settings.json"
version="$(claude --version)"
case "$version" in *${shellQuote(descriptor.cliVersion)}*) ;; *) echo 'V7 Claude CLI version mismatch' >&2; exit 65;; esac
node /usr/local/share/agentbattler-v7-claude-mock.mjs &
provider=$!
trap 'kill "$provider" 2>/dev/null || true' EXIT
for attempt in $(seq 1 100); do
  if bash -c '</dev/tcp/127.0.0.1/${descriptor.providerPort}' >/dev/null 2>&1; then break; fi
  sleep 0.05
done
bash -c '</dev/tcp/127.0.0.1/${descriptor.providerPort}'
HOME="$home" \
ANTHROPIC_BASE_URL=http://127.0.0.1:${descriptor.providerPort} \
ANTHROPIC_API_KEY=agentbattler-v7-local-mock-only \
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
DISABLE_AUTOUPDATER=1 \
DISABLE_TELEMETRY=1 \
NO_COLOR=1 \
CI=1 \
claude ${args.map(shellQuote).join(' ')} >/tmp/agentbattler-v7-claude-output.jsonl 2>/tmp/agentbattler-v7-claude-stderr.txt || {
  tail -n 20 /tmp/agentbattler-v7-claude-stderr.txt >&2
  exit 66
}
for attempt in $(seq 1 100); do
  test ! -s /app/src/.agentbattler-v7-claude-provider-summary.json || break
  sleep 0.05
done
test -s /app/src/.agentbattler-v7-claude-provider-summary.json
test -s /app/src/.agentbattler-v7-claude-tool-output
cat /app/src/.agentbattler-v7-claude-tool-output
`;
}

export function buildTerminalV7ClaudeCliProbeAssets() {
  const descriptor = terminalV7ClaudeCliProbeDescriptor();
  return Object.freeze({
    descriptor,
    mockProviderSource: claudeMockProviderSource(descriptor),
    settingsJson: `${canonicalJson(descriptor.settings, { space: 2 })}\n`,
    command: claudeCliProbeCommand(descriptor),
  });
}

async function harborWrapperProbe({ harnessId, root, environmentImage, releaseDescriptor }) {
  const prepared = await prepareLinuxWorkspace(root, `agentbattler-v7-${harnessId}-`);
  const quota = cgroupQuota(releaseDescriptor.harborCandidate.cpus);
  try {
    const wrapperName = harnessId === 'codex-cli' ? 'v7_codex_bwrap_wrapper.sh' : 'v7_claude_bwrap_wrapper.sh';
    const wrapperPath = path.join(root, 'benchmark', 'harbor', wrapperName);
    const mounts = [{
      source: wrapperPath,
      target: harnessId === 'codex-cli' ? '/usr/local/bin/bwrap' : '/usr/local/bin/agentbattler-bwrap',
    }];
    let setup = '';
    let claudeDescriptor = null;
    let claudeAssets = null;
    let claudeMockPath = null;
    let claudeSettingsPath = null;
    if (harnessId === 'codex-cli') {
      const real = path.join(prepared.tools, 'codex-bwrap-real');
      await writeFile(real, '', { mode: 0o755 });
      mounts.push({ source: real, target: '/usr/local/bin/agentbattler-codex-bwrap-real', readonly: false });
      setup = 'pinned="$(find /usr/local/lib/node_modules/@openai/codex -type f -path "*/codex-resources/bwrap" -print -quit)"; test -n "$pinned" -a -x "$pinned"; cp "$pinned" /usr/local/bin/agentbattler-codex-bwrap-real; chmod 0755 /usr/local/bin/agentbattler-codex-bwrap-real; ';
    } else {
      claudeAssets = buildTerminalV7ClaudeCliProbeAssets();
      claudeDescriptor = claudeAssets.descriptor;
      claudeMockPath = path.join(prepared.tools, 'claude-mock.mjs');
      claudeSettingsPath = path.join(prepared.tools, 'claude-settings.json');
      await Promise.all([
        writeFile(claudeMockPath, claudeAssets.mockProviderSource, { mode: 0o644 }),
        writeFile(claudeSettingsPath, claudeAssets.settingsJson, { mode: 0o644 }),
      ]);
      mounts.push(
        { source: claudeMockPath, target: '/usr/local/share/agentbattler-v7-claude-mock.mjs' },
        { source: claudeSettingsPath, target: '/usr/local/share/agentbattler-v7-claude-settings.json' },
      );
    }
    const executable = harnessId === 'codex-cli' ? '/usr/local/bin/bwrap' : '/usr/local/bin/agentbattler-bwrap';
    const inner = harnessId === 'claude-code'
      ? claudeAssets.command
      : `${setup}exec ${executable} --unshare-user --unshare-pid --unshare-net --cap-drop ALL --ro-bind / / --chdir /app -- /usr/local/bin/agentbattler-v7-preflight-probe`;
    const result = await capture('docker', dockerProbeArgs({
      imageId: environmentImage.imageId,
      workspace: prepared.workspace,
      probePath: prepared.probePath,
      quota,
      mounts,
      command: inner,
    }), { timeoutMs: 120_000 });
    invariant(result.code === 0 && !result.signal && !result.timedOut, `V7 ${harnessId} wrapper probe failed: ${result.stderr.slice(-600)}`);
    const probe = parseProbeLines(result.stdout);
    assertCgroup(probe, quota);
    invariant((await readFile(path.join(prepared.workspace, 'src', '.agentbattler-v7-preflight-write'), 'utf8')).trim() === 'workspace-write-ok', `V7 ${harnessId} workspace write did not persist`);
    invariant((await readFile(path.join(prepared.workspace, '.agentbattler', 'current', 'task-contract.json'), 'utf8')) === '{}\n', `V7 ${harnessId} changed trusted control`);
    let boundary = linuxBoundary(probe);
    let cliProbeIdentity = {};
    if (harnessId === 'claude-code') {
      const summary = JSON.parse(await readFile(path.join(prepared.workspace, 'src', '.agentbattler-v7-claude-provider-summary.json'), 'utf8'));
      invariant(summary.providerProtocol === claudeDescriptor.providerProtocol
        && summary.messageRequests === 2
        && summary.toolCallsIssued === 1
        && summary.toolResultsObserved === 1
        && summary.probeOutputObserved === true
        && sameMembers(summary.requestedToolSchemas ?? [], claudeDescriptor.permittedTools), 'V7 Claude local provider did not observe exactly one successful Bash tool execution');
      boundary = {
        ...boundary,
        permittedTools: [...claudeDescriptor.permittedTools],
        toolExecutionProbe: {
          tool: 'Bash',
          actualPinnedCliExecution: true,
          deterministicLocalProvider: true,
          absoluteOutOfWorkspaceRead: 'denied-by-native-sandbox',
          observedToolCalls: summary.toolCallsIssued,
          observedToolResults: summary.toolResultsObserved,
          requestedToolSchemas: [...summary.requestedToolSchemas],
        },
      };
      cliProbeIdentity = {
        cliVersion: claudeDescriptor.cliVersion,
        cliPolicySha256: canonicalJsonSha256(claudeDescriptor),
        localProviderSha256: await sha256File(claudeMockPath),
        settingsSha256: await sha256File(claudeSettingsPath),
      };
    }
    return {
      runtime: runtimeIdentity({ kind: 'sealed-harbor-environment-image-plus-wrapper', ...environmentImage, wrapperSha256: await sha256File(wrapperPath), ...cliProbeIdentity }),
      candidateRuntime: { recorded: true, quotaKind: 'sealed-task-plus-preflight-docker-cgroup-v2', ...releaseDescriptor.harborCandidate, pids: quota.pids, asymmetries: [] },
      boundary,
    };
  } finally {
    await rm(prepared.scratch, { recursive: true, force: true });
  }
}

async function piExtensionProbe({ root, environmentImage, releaseDescriptor }) {
  const prepared = await prepareLinuxWorkspace(root, 'agentbattler-v7-pi-');
  const quota = cgroupQuota(releaseDescriptor.harborCandidate.cpus);
  try {
    const extension = path.join(root, 'benchmark', 'harbor', 'v7_pi_sandbox_extension.mjs');
    const loader = path.join(prepared.tools, 'pi-loader.mjs');
    await writeFile(loader, `let tool;
const extension = await import('/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/agentbattler-sandbox.mjs');
extension.default({ registerTool(value) { if (value.name === 'bash') tool = value; }, on() {} });
if (!tool) throw new Error('V7 Pi sandbox extension did not register bash');
const result = await tool.execute('agentbattler-v7-preflight', { command: '/usr/local/bin/agentbattler-v7-preflight-probe', timeout: 20 });
for (const item of result.content ?? []) if (item.type === 'text') process.stdout.write(item.text + '\\n');
`, { mode: 0o644 });
    const result = await capture('docker', dockerProbeArgs({
      imageId: environmentImage.imageId,
      workspace: prepared.workspace,
      probePath: prepared.probePath,
      quota,
      mounts: [
        { source: extension, target: '/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/agentbattler-sandbox.mjs' },
        { source: loader, target: '/usr/local/bin/agentbattler-v7-pi-preflight.mjs' },
      ],
      command: 'exec node /usr/local/bin/agentbattler-v7-pi-preflight.mjs',
    }), { timeoutMs: 120_000 });
    invariant(result.code === 0 && !result.signal && !result.timedOut, `V7 Pi extension probe failed: ${result.stderr.slice(-600)}`);
    const probe = parseProbeLines(result.stdout);
    assertCgroup(probe, quota);
    return {
      runtime: runtimeIdentity({ kind: 'sealed-harbor-environment-image-plus-pi-extension', ...environmentImage, extensionSha256: await sha256File(extension) }),
      candidateRuntime: { recorded: true, quotaKind: 'sealed-task-plus-preflight-docker-cgroup-v2', ...releaseDescriptor.harborCandidate, pids: quota.pids, asymmetries: [] },
      boundary: linuxBoundary(probe),
    };
  } finally {
    await rm(prepared.scratch, { recursive: true, force: true });
  }
}

function dotBwrapCommand() {
  return `compiled="$(grep -rl 'AgentBattler V7 command sandbox retained capabilities' /opt/dotagents/apps/desktop/out/main | head -n 1)"; test -n "$compiled"; grep -q 'AGENTBATTLER_V7_CONTROL_ROOT' "$compiled"; grep -q -- '--unshare-net' "$compiled"; grep -q -- '--clearenv' "$compiled"; exec /usr/bin/bwrap --die-with-parent --new-session --unshare-pid --unshare-net --unshare-ipc --unshare-uts --cap-drop ALL --tmpfs / --proc /proc --dev /dev --ro-bind /usr /usr --dir /etc --ro-bind /etc/passwd /etc/passwd --ro-bind /etc/group /etc/group --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib64 /lib64 --dir /workspace --bind /workspace /workspace --ro-bind /workspace/.agentbattler /workspace/.agentbattler --tmpfs /tmp --clearenv --setenv PATH /usr/local/bin:/usr/bin:/bin --setenv HOME /tmp --setenv LANG C --setenv LC_ALL C --setenv TZ UTC --setenv TMPDIR /tmp --chdir /workspace -- /bin/bash -c 'cap="$(sed -n "s/^CapEff:[[:space:]]*//p" /proc/self/status)"; case "$cap" in ""|*[!0]*) exit 77;; esac; exec "$@"' agentbattler-v7-capability-guard /usr/local/bin/agentbattler-v7-preflight-probe`;
}

async function dotAgentsProbe({ root, dotImage }) {
  const prepared = await prepareLinuxWorkspace(root, 'agentbattler-v7-dotagents-', { rootOwnedControl: false });
  try {
    const policyArgs = buildDotAgentsDockerArgs({
      image: dotImage.imageId,
      name: 'agentbattler-v7-preflight-policy',
      hostPort: 32101,
      home: path.join(prepared.scratch, 'home'),
      configRoot: path.join(prepared.scratch, 'config'),
      workspace: prepared.workspace,
      readOnlyControl: true,
    });
    const cpuIndex = policyArgs.indexOf('--cpus');
    const memoryIndex = policyArgs.indexOf('--memory');
    const pidsIndex = policyArgs.indexOf('--pids-limit');
    const adapterCpus = Number(policyArgs[cpuIndex + 1]);
    const adapterPids = Number(policyArgs[pidsIndex + 1]);
    invariant(Number.isFinite(adapterCpus) && adapterCpus > 0
      && policyArgs[memoryIndex + 1] === '4g'
      && Number.isSafeInteger(adapterPids) && adapterPids > 0, 'V7 DotAgents preflight quota differs from its actual adapter');
    const quota = Object.freeze({ cpus: adapterCpus, memoryBytes: 4 * 1024 * 1024 * 1024, pids: adapterPids });
    const result = await capture('docker', dockerProbeArgs({
      imageId: dotImage.imageId,
      workspace: prepared.workspace,
      probePath: prepared.probePath,
      quota,
      command: dotBwrapCommand(),
      rootOwnedControl: false,
      workspaceTarget: '/workspace',
    }), { timeoutMs: 120_000 });
    invariant(result.code === 0 && !result.signal && !result.timedOut, `V7 DotAgents bwrap-image probe failed: ${result.stderr.slice(-600)}`);
    const probe = parseProbeLines(result.stdout);
    assertCgroup(probe, quota);
    return {
      runtime: runtimeIdentity({
        kind: 'sealed-dotagents-v7-bwrap-image',
        ...dotImage,
        sandboxPatchSha256: await sha256File(path.join(root, 'harnesses', 'dotagents', 'runtime-tools-sandbox-v7.patch')),
      }),
      candidateRuntime: {
        recorded: true,
        quotaKind: 'docker-cgroup-v2',
        ...quota,
        asymmetries: quota.cpus === 4 ? [] : [`candidate-cpus:${quota.cpus}-vs-harbor:4`],
      },
      boundary: linuxBoundary(probe, 'sandbox-remounted-read-only'),
    };
  } finally {
    await rm(prepared.scratch, { recursive: true, force: true });
  }
}

function responsesEvent(response, event) {
  response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function completedResponse({ id, output, tools }) {
  return {
    id,
    object: 'response',
    created_at: 1,
    status: 'completed',
    completed_at: 2,
    error: null,
    incomplete_details: null,
    model: 'gpt-5.6-luna',
    output,
    parallel_tool_calls: false,
    tool_choice: 'auto',
    tools,
    usage: {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 1,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 101,
    },
  };
}

function streamDroidToolCall(response, body, command) {
  const id = 'resp_agentbattler_v7_execute_probe';
  const item = {
    id: 'fc_agentbattler_v7_execute_probe',
    type: 'function_call',
    status: 'completed',
    call_id: 'call_agentbattler_v7_execute_probe',
    name: 'Execute',
    arguments: JSON.stringify({ command }),
  };
  const completed = completedResponse({ id, output: [item], tools: body.tools ?? [] });
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  responsesEvent(response, { type: 'response.created', response: { ...completed, status: 'in_progress', completed_at: null, output: [], usage: null }, sequence_number: 0 });
  responsesEvent(response, { type: 'response.output_item.added', item: { ...item, status: 'in_progress', arguments: '' }, output_index: 0, sequence_number: 1 });
  responsesEvent(response, { type: 'response.function_call_arguments.delta', delta: item.arguments, item_id: item.id, output_index: 0, sequence_number: 2 });
  responsesEvent(response, { type: 'response.function_call_arguments.done', arguments: item.arguments, item_id: item.id, name: item.name, output_index: 0, sequence_number: 3 });
  responsesEvent(response, { type: 'response.output_item.done', item, output_index: 0, sequence_number: 4 });
  responsesEvent(response, { type: 'response.completed', response: completed, sequence_number: 5 });
  response.end('data: [DONE]\n\n');
}

function streamDroidText(response, body) {
  const id = 'resp_agentbattler_v7_execute_complete';
  const item = { id: 'msg_agentbattler_v7_execute_complete', type: 'message', status: 'completed', content: [{ type: 'output_text', annotations: [], logprobs: [], text: 'TOOL_PROBE_COMPLETE' }], role: 'assistant' };
  const completed = completedResponse({ id, output: [item], tools: body.tools ?? [] });
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  responsesEvent(response, { type: 'response.created', response: { ...completed, status: 'in_progress', completed_at: null, output: [], usage: null }, sequence_number: 0 });
  responsesEvent(response, { type: 'response.output_item.added', item: { ...item, status: 'in_progress', content: [] }, output_index: 0, sequence_number: 1 });
  responsesEvent(response, { type: 'response.content_part.added', content_index: 0, item_id: item.id, output_index: 0, part: { type: 'output_text', annotations: [], logprobs: [], text: '' }, sequence_number: 2 });
  responsesEvent(response, { type: 'response.output_text.delta', content_index: 0, delta: 'TOOL_PROBE_COMPLETE', item_id: item.id, logprobs: [], output_index: 0, sequence_number: 3 });
  responsesEvent(response, { type: 'response.output_text.done', content_index: 0, item_id: item.id, logprobs: [], output_index: 0, sequence_number: 4, text: 'TOOL_PROBE_COMPLETE' });
  responsesEvent(response, { type: 'response.content_part.done', content_index: 0, item_id: item.id, output_index: 0, part: item.content[0], sequence_number: 5 });
  responsesEvent(response, { type: 'response.output_item.done', item, output_index: 0, sequence_number: 6 });
  responsesEvent(response, { type: 'response.completed', response: completed, sequence_number: 7 });
  response.end('data: [DONE]\n\n');
}

async function droidToolProbeServer(command) {
  const requests = [];
  let sentToolCall = false;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      if (request.method === 'GET' && request.url === '/') {
        response.end('router-ok');
        return;
      }
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-5.6-luna', object: 'model' }] }));
        return;
      }
      invariant(request.method === 'POST' && request.url === '/v1/responses', `V7 Droid tool probe received ${request.method} ${request.url}`);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(body);
      const hasExecute = (body.tools ?? []).some((tool) => (tool.function?.name ?? tool.name) === 'Execute');
      if (hasExecute && !sentToolCall) {
        sentToolCall = true;
        streamDroidToolCall(response, body, command);
      } else streamDroidText(response, body);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, requests };
}

function spawnResult(command, args, options = {}) {
  return capture(command, args, { ...options, timeoutMs: options.timeoutMs ?? 10_000 });
}

export async function runTerminalV7DroidPreflightProbe({ root = ROOT } = {}) {
  invariant(process.platform === 'darwin' && process.arch === 'arm64', 'V7 Droid preflight requires macOS arm64');
  const droidRuntimeEnvironment = {
    PATH: process.env.PATH ?? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
    HOME: os.tmpdir(),
    TMPDIR: os.tmpdir(),
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
    NO_COLOR: '1',
  };
  const droidRuntime = await verifyDroidRuntime(droidRuntimeEnvironment);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-v7-droid-preflight-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-v7-droid-outside-'));
  const workspace = path.join(scratch, 'workspace');
  const control = path.join(workspace, '.agentbattler', 'current');
  const home = path.join(scratch, 'home');
  const temporary = path.join(scratch, 'tmp');
  const marker = path.join(workspace, 'src', '.agentbattler-v7-droid-execute-probe');
  const probeProgram = `const fs=require('node:fs');let value='readable';try{fs.readFileSync(${JSON.stringify(path.join(outside, 'secret'))})}catch(error){value=['EPERM','EACCES'].includes(error.code)?'denied':'error-'+error.code}fs.writeFileSync(${JSON.stringify(marker)},value);if(value!=='denied')process.exit(41)`;
  const executeCommand = `node -e ${JSON.stringify(probeProgram)}`;
  const toolProbe = await droidToolProbeServer(executeCommand);
  const { server } = toolProbe;
  try {
    await Promise.all([
      mkdir(path.join(workspace, 'src'), { recursive: true, mode: 0o755 }),
      mkdir(control, { recursive: true, mode: 0o755 }),
      mkdir(home, { recursive: true, mode: 0o700 }),
      mkdir(temporary, { recursive: true, mode: 0o700 }),
    ]);
    await Promise.all([
      writeFile(path.join(control, 'task-contract.json'), '{}\n', { mode: 0o444 }),
      writeFile(path.join(outside, 'secret'), 'private\n', { mode: 0o600 }),
    ]);
    await chmod(control, 0o555);
    const port = server.address().port;
    const runtimeReadPaths = await resolveDroidV7RuntimeReadPaths([process.execPath]);
    const actualProfile = createDroidV7SandboxProfile({
      runDirectory: scratch,
      workspace,
      binaryPath: droidRuntime.binaryPath,
      runtimeReadPaths,
      networkPort: port,
      controlRoot: path.join(workspace, '.agentbattler'),
    });
    const probeProfile = createDroidV7SandboxProfile({
      runDirectory: scratch,
      workspace,
      binaryPath: '/usr/bin/curl',
      runtimeReadPaths,
      networkPort: port,
      controlRoot: path.join(workspace, '.agentbattler'),
    });
    invariant(actualProfile.includes(`(process-path ${JSON.stringify(droidRuntime.binaryPath)})`)
      && !actualProfile.includes('(process-path "/usr/bin/curl")'), 'V7 Droid sealed profile did not bind only the Droid parent router exception');
    invariant(probeProfile.includes('(process-path "/usr/bin/curl")'), 'V7 Droid dynamic probe profile did not bind its parent surrogate');
    const actualProfilePath = path.join(scratch, 'actual.sb');
    const profilePath = path.join(scratch, 'probe.sb');
    await Promise.all([
      writeFile(actualProfilePath, actualProfile, { mode: 0o600 }),
      writeFile(profilePath, probeProfile, { mode: 0o600 }),
    ]);
    const parent = await spawnResult('/usr/bin/sandbox-exec', [
      '-f', profilePath, '/usr/bin/curl', '--fail', '--silent', `http://localhost:${port}/`,
    ]);
    invariant(parent.code === 0 && parent.stdout === 'router-ok', 'V7 Droid parent router exception failed');
    const isolatedEnvironment = isolatedDroidV7Environment(home, temporary, { executablePaths: [process.execPath] });
    const expectedEnvironmentNames = [...Object.keys(isolatedEnvironment), '__CF_USER_TEXT_ENCODING'].sort();
    const probe = [
      "const fs=require('node:fs')",
      "const http=require('node:http')",
      `fs.writeFileSync(${JSON.stringify(path.join(workspace, 'src', '.agentbattler-v7-preflight-write'))},'workspace-write-ok\\n')`,
      `try{fs.readFileSync(${JSON.stringify(path.join(outside, 'secret'))});process.exit(41)}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e}`,
      `try{fs.readdirSync(${JSON.stringify(outside)});process.exit(42)}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e}`,
      `try{fs.writeFileSync(${JSON.stringify(path.join(outside, 'tamper'))},'x');process.exit(43)}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e}`,
      `try{fs.writeFileSync(${JSON.stringify(path.join(control, 'task-contract.json'))},'x');process.exit(44)}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e}`,
      `if(JSON.stringify(Object.keys(process.env).sort())!==${JSON.stringify(JSON.stringify(expectedEnvironmentNames))})process.exit(45)`,
      "if(!/^0x[0-9A-F]+:[0-9]+:[0-9]+$/i.test(process.env.__CF_USER_TEXT_ENCODING||''))process.exit(49)",
      `const request=http.get('http://localhost:${port}/',()=>process.exit(46));request.on('error',()=>{console.log('AGENTBATTLER_V7_DROID_PROBE=passed');process.exit(0)});setTimeout(()=>process.exit(47),2000)`,
    ].join(';');
    const child = await spawnResult('/usr/bin/sandbox-exec', ['-f', profilePath, process.execPath, '-e', probe], {
      cwd: workspace,
      env: isolatedEnvironment,
      timeoutMs: 5_000,
    });
    invariant(child.code === 0 && child.stdout.includes('AGENTBATTLER_V7_DROID_PROBE=passed'), `V7 Droid model-child probe failed (code=${child.code}, signal=${child.signal ?? 'none'}, stdout=${child.stdout.slice(-200)}, stderr=${child.stderr.slice(-400)})`);
    invariant((await readFile(path.join(workspace, 'src', '.agentbattler-v7-preflight-write'), 'utf8')).trim() === 'workspace-write-ok', 'V7 Droid workspace write did not persist');
    invariant((await readFile(path.join(control, 'task-contract.json'), 'utf8')) === '{}\n', 'V7 Droid changed trusted control');

    const factoryHome = path.join(home, '.factory');
    await mkdir(factoryHome, { recursive: true, mode: 0o700 });
    const apiKey = 'agentbattler-v7-local-probe-key';
    const settings = createDroidSettings({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      upstreamModelPrefix: '',
      reasoningEffort: 'high',
    });
    await writeFile(path.join(factoryHome, 'settings.json'), `${canonicalJson(materializeDroidSettingsCredential(settings, apiKey), { space: 2 })}\n`, { mode: 0o600 });
    const launcher = droidV7SandboxLauncher({
      profilePath: actualProfilePath,
      droidBinary: droidRuntime.binaryPath,
      runtimeReadPaths,
    });
    const session = new DroidJsonRpcSession({
      workspace,
      model: 'gpt-5.6-luna',
      env: isolatedEnvironment,
      timeoutMs: 120_000,
      reasoningEffort: 'high',
      launcher,
      allowedTools: DROID_V7_RESTRICTED_TOOLS,
    });
    let initialized;
    let toolTurn;
    try {
      initialized = await session.start();
      const retirement = await retireDroidCredentialSettings({ factoryHome, apiKey, timeoutMs: 5_000, quietMs: 75, pollMs: 10 });
      invariant(retirement.settingsFilesRemoved >= 1, 'V7 Droid tool probe did not retire its local routing credential');
      await assertDroidCredentialAbsent({ runDirectory: scratch, apiKey });
      toolTurn = await session.turn('Use the only available Execute tool exactly once, then report completion.', 120_000);
    } finally {
      await session.close();
      await retireDroidCredentialSettings({ factoryHome, apiKey, timeoutMs: 5_000, quietMs: 75, pollMs: 10 });
      await assertDroidCredentialAbsent({ runDirectory: scratch, apiKey });
    }
    const requestedToolNames = [...new Set(toolProbe.requests.flatMap((request) => (request.tools ?? []).map((tool) => tool.function?.name ?? tool.name).filter(Boolean)))].sort();
    invariant(canonicalJson(requestedToolNames) === canonicalJson(DROID_V7_RESTRICTED_TOOLS), `V7 Droid exposed non-child-isolated tools: ${requestedToolNames.join(',')}`);
    invariant(initialized.settings.allowedTools?.length === 1 && initialized.settings.allowedTools[0] === 'Execute', 'V7 Droid session did not retain the Execute-only tool policy');
    invariant(toolTurn.summary.toolCallCount === 1 && toolTurn.summary.toolCallBreakdown.Execute === 1, `V7 Droid did not execute exactly one permitted Execute tool (count=${toolTurn.summary.toolCallCount}, schemas=${requestedToolNames.join(',') || 'none'}, marker=${await readFile(marker, 'utf8').catch(() => 'missing')})`);
    invariant((await readFile(marker, 'utf8')) === 'denied', 'V7 Droid Execute tool reached an absolute path outside the workspace');
    const normalizedEnvironment = Object.fromEntries(Object.entries(isolatedEnvironment).map(([name, value]) => [name,
      name === 'HOME' ? '<ephemeral-home>' : name === 'TMPDIR' ? '<ephemeral-tmp>' : name === 'PATH' ? '<sealed-runtime-path>' : value]));
    normalizedEnvironment.__CF_USER_TEXT_ENCODING = '<macos-injected-non-secret-uid-encoding>';
    return {
      runtime: runtimeIdentity({
        kind: 'sealed-native-droid-plus-sbpl',
        version: droidRuntime.version,
        binarySha256: droidRuntime.binarySha256,
        sandboxProfileSha256: sha256(actualProfile),
        probeProfileSha256: sha256(probeProfile),
        runtimeReadSetSha256: canonicalJsonSha256(runtimeReadPaths),
      }),
      candidateRuntime: {
        recorded: true,
        quotaKind: 'native-macos-no-cgroup-claim',
        phaseLimitMs: MINI_LEDGER_V7_PHASE_LIMIT_MS,
        asymmetries: ['candidate-cpu-memory-cgroup:not-applicable-native-droid'],
      },
      boundary: {
        modelCommandCapabilities: 'exactly-zero',
        capabilityProof: { kind: 'darwin-no-linux-capability-facility', mask: null },
        workspaceWrite: 'allowed-and-observed',
        hostRoot: 'masked-or-private-contents-denied',
        controlDirectory: 'os-sandbox-enforced-read-only',
        outOfWorkspace: 'contents-enumeration-and-write-denied',
        network: 'denied',
        parentRouter: 'loopback-allowed-to-parent-only',
        permittedTools: [...DROID_V7_RESTRICTED_TOOLS],
        toolExecutionProbe: {
          tool: 'Execute',
          actualRuntimeExecution: true,
          absoluteOutOfWorkspaceRead: 'denied-by-os-sandbox',
          observedToolCalls: toolTurn.summary.toolCallCount,
          requestedToolSchemas: requestedToolNames,
        },
        filesystemMetadataLimitation: 'exact-outside-path-metadata-and-root-directory-runtime-surface-observable',
        environment: {
          policy: 'fixed-minimal-non-secret-values-only',
          names: expectedEnvironmentNames,
          unexpectedNames: [],
          sensitiveNames: [],
          valuesSha256: canonicalJsonSha256(normalizedEnvironment),
        },
      },
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await chmod(control, 0o755).catch(() => {});
    await Promise.all([
      rm(scratch, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
}

export function createTerminalV7RealPreflightDrivers() {
  return Object.freeze({
    now: () => new Date().toISOString(),
    host: inspectTerminalV7ExecutionHost,
    sourceIdentity: defaultSourceIdentity,
    runSuite: defaultRunSuite,
    releaseDescriptor: defaultReleaseDescriptor,
    inspectVerifier: () => inspectTerminalV7VerifierImage(),
    inspectHarborEnvironment,
    inspectDotAgents: () => inspectDotAgentsV7Image(),
    runHarness: async (harnessId, context) => {
      if (harnessId === 'codex-cli' || harnessId === 'claude-code') return harborWrapperProbe({ harnessId, ...context });
      if (harnessId === 'pi-coding-agent') return piExtensionProbe(context);
      if (harnessId === 'dotagents-mono') return dotAgentsProbe(context);
      if (harnessId === 'factory-droid') return runTerminalV7DroidPreflightProbe(context);
      throw new Error(`Unsupported V7 preflight harness: ${harnessId}`);
    },
  });
}

export async function runTerminalV7TestPreflights({
  root = ROOT,
  evidenceRoot,
  taskRoot,
  revision,
  reviewedCommit,
  outputPath = path.join(evidenceRoot ?? '', 'test-preflight-report.json'),
  drivers = createTerminalV7RealPreflightDrivers(),
} = {}) {
  const sourceRoot = safeAbsolute(root, 'V7 source root');
  const artifactsRoot = safeAbsolute(evidenceRoot, 'V7 preflight evidence root');
  const sealedTaskRoot = safeAbsolute(taskRoot, 'V7 preflight task root');
  invariant(/^r[1-9]\d*$/.test(revision ?? ''), 'V7 preflight revision must look like r1');
  invariant(COMMIT_RE.test(reviewedCommit ?? ''), 'V7 preflight reviewed commit is required');
  const reportPath = safeAbsolute(outputPath, 'V7 preflight report path');
  const reportRelation = path.relative(artifactsRoot, reportPath);
  invariant(reportRelation && reportRelation !== '..' && !reportRelation.startsWith(`..${path.sep}`) && !path.isAbsolute(reportRelation), 'V7 preflight report must stay under its evidence root');

  const [host, source, releaseDescriptor, verifierImage, environmentImage, dotImage] = await Promise.all([
    drivers.host(),
    drivers.sourceIdentity({ root: sourceRoot, reviewedCommit }),
    drivers.releaseDescriptor({ taskRoot: sealedTaskRoot }),
    drivers.inspectVerifier(),
    drivers.inspectHarborEnvironment({ taskRoot: sealedTaskRoot }),
    drivers.inspectDotAgents(),
  ]);
  validateTerminalV7ExecutionHost(host);
  invariant(source.head === reviewedCommit && source.clean === true && source.detached === true, 'V7 preflights require the clean detached reviewed commit');
  invariant(releaseDescriptor.matched === true && SHA256_RE.test(releaseDescriptor.sha256 ?? ''), 'V7 release task descriptor did not match');
  invariant(/^sha256:[0-9a-f]{64}$/.test(verifierImage.imageId ?? '') && SHA256_RE.test(verifierImage.sourceSha256 ?? ''), 'V7 sealed verifier image inspection failed');
  invariant(verifierImage.resourcePolicy?.cpus === TERMINAL_V7_COMMON_RESOURCE_POLICY.sharedVerifier.cpus
    && verifierImage.resourcePolicy?.memoryBytes === TERMINAL_V7_COMMON_RESOURCE_POLICY.sharedVerifier.memoryBytes
    && verifierImage.resourcePolicy?.pids === TERMINAL_V7_COMMON_RESOURCE_POLICY.sharedVerifier.pids
    && verifierImage.network === 'none'
    && verifierImage.readOnlyRootFilesystem === true, 'V7 sealed verifier image does not implement the common resource policy');

  await mkdir(artifactsRoot, { recursive: true, mode: 0o700 });
  const suiteHome = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-v7-suite-home-'));
  const suiteRecords = {};
  try {
    const focusedFiles = await v7TestFiles(sourceRoot);
    for (const name of ['existing', 'v7']) {
      const result = await drivers.runSuite({ root: sourceRoot, name, files: name === 'v7' ? focusedFiles : [], home: suiteHome });
      invariant(typeof result?.log === 'string', `V7 ${name} suite driver returned no log`);
      const summary = parseTerminalV7Tap(result.log, `V7 ${name} suite`);
      const relative = `logs/${name}.tap`;
      const file = path.join(artifactsRoot, ...relative.split('/'));
      await atomicLog(file, result.log);
      suiteRecords[name] = {
        passed: true,
        tests: summary.tests,
        failures: summary.failures,
        logSha256: await sha256File(file),
        logPath: relative,
      };
    }
  } finally {
    await rm(suiteHome, { recursive: true, force: true });
  }

  const projections = [];
  for (const harnessId of TERMINAL_V7_PREFLIGHT_HARNESSES) {
    const proof = await drivers.runHarness(harnessId, {
      root: sourceRoot,
      taskRoot: sealedTaskRoot,
      revision,
      reviewedCommit,
      releaseDescriptor,
      verifierImage,
      environmentImage,
      dotImage,
    });
    const evidence = {
      schemaVersion: TERMINAL_V7_PREFLIGHT_EVIDENCE_SCHEMA,
      revision,
      reviewedCommit,
      createdAt: drivers.now(),
      host,
      source,
      harnessId,
      passed: true,
      exactReleasePolicy: true,
      modelCommandCapabilities: 'exactly-zero',
      network: 'denied',
      outOfWorkspace: 'denied',
      controlDirectory: 'trusted-read-only',
      controlEnforcement: proof.boundary.controlDirectory,
      resourcePolicySha256: TERMINAL_V7_COMMON_RESOURCE_POLICY_SHA256,
      sandboxPolicySha256: TERMINAL_V7_COMMON_SANDBOX_POLICY_SHA256,
      releaseDescriptor,
      verifierImage: {
        imageId: verifierImage.imageId,
        sourceSha256: verifierImage.sourceSha256,
        resourcePolicy: verifierImage.resourcePolicy,
        network: verifierImage.network,
        readOnlyRootFilesystem: verifierImage.readOnlyRootFilesystem,
      },
      ...proof,
    };
    validateTerminalV7HarnessPreflightEvidence(evidence, { harnessId, revision, reviewedCommit });
    const relative = `preflights/${harnessId}.json`;
    await atomicJson(path.join(artifactsRoot, ...relative.split('/')), evidence);
    projections.push(terminalV7PreflightProjection(evidence, relative));
  }

  const [finalHost, finalSource] = await Promise.all([
    drivers.host(),
    drivers.sourceIdentity({ root: sourceRoot, reviewedCommit }),
  ]);
  invariant(canonicalJson(finalHost) === canonicalJson(host), 'V7 execution host changed while preflights ran');
  invariant(canonicalJson(finalSource) === canonicalJson(source), 'V7 source changed while preflights ran');
  const report = sealTerminalV7TestReport({
    schemaVersion: 'agentbattler.terminal-v7-test-preflight-report.v2',
    revision,
    reviewedCommit,
    createdAt: drivers.now(),
    host,
    verifierImage: { imageId: verifierImage.imageId, sourceSha256: verifierImage.sourceSha256 },
    suites: suiteRecords,
    preflights: projections,
    failures: 0,
    passed: true,
  });
  validateTerminalV7TestReport(report, { revision, reviewedCommit, verifierImage });
  await atomicJson(reportPath, report);
  await assertTerminalV7TestReportArtifacts({ evidenceRoot: artifactsRoot, report });
  return report;
}
