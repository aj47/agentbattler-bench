#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  installV7Phase,
  listV7Packs,
  loadV7Pack,
  materializeV7Starter,
  sealV7Pack,
} from '../benchmark/challenges/mini-ledger-v7/pack.mjs';
import { terminalHarnessVersion } from '../src/terminal-harness-versions.mjs';
import {
  TERMINAL_V7_HARBOR_UNBOUND_IMAGE_ID,
  terminalV7HarborTaskTreeIdentity,
} from '../src/terminal-v7-harbor-images.mjs';

export const TERMINAL_V7_HARBOR_AGENT_TIMEOUT_SECONDS = 25 * 60;
export const TERMINAL_V7_HARBOR_PHASE_COUNT = 5;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUTPUT_ROOT = path.join(REPO_ROOT, 'benchmark', 'harbor', 'mini-ledger-v7');
const CHALLENGE_ROOT = path.join(REPO_ROOT, 'benchmark', 'challenges', 'mini-ledger-v7');
const CANDIDATE_PROCESS = path.join(REPO_ROOT, 'benchmark', 'challenges', 'candidate-process.mjs');
const SOURCE_SUPPORT = Object.freeze([
  'provenance.mjs',
  'terminal-candidate-tree.mjs',
  'terminal-v7-overlay.mjs',
]);
const CONTROL_PREFIX = 'AGENTBATTLER_V7_CONTROL_V1 ';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(normalize(value));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function tomlArray(values) {
  return `[${values.map(tomlString).join(', ')}]`;
}

function safeTaskSegment(value, label) {
  invariant(typeof value === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(value), `${label} must be a lowercase task identifier`);
  return value;
}

function assertSafeOutputRoot(outputRoot) {
  invariant(path.isAbsolute(outputRoot), 'V7 Harbor output root must be absolute');
  const relative = path.relative(REPO_ROOT, outputRoot);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    invariant(relative.startsWith(path.join('benchmark', 'harbor', 'mini-ledger-v7')), 'V7 Harbor output inside the repository must stay under benchmark/harbor/mini-ledger-v7');
  }
}

function currentControlRelativePath(value) {
  invariant(typeof value === 'string' && value.startsWith('.agentbattler/current/'), 'V7 current artifact must live under .agentbattler/current');
  const relative = value.slice('.agentbattler/current/'.length);
  invariant(relative.length > 0 && !relative.includes('\\') && !relative.includes('\0'), 'V7 current artifact path is invalid');
  invariant(!path.posix.isAbsolute(relative) && path.posix.normalize(relative) === relative && !relative.split('/').includes('..'), 'V7 current artifact path may not traverse');
  return relative;
}

async function currentTicket(pack, descriptor) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-v7-phase-'));
  try {
    const current = path.join(scratch, 'current');
    await mkdir(current);
    const installed = await installV7Phase({ pack, phase: descriptor.phase, destination: current });
    const ticket = await readFile(path.join(current, path.posix.basename(installed.path)), 'utf8');
    invariant(sha256(ticket) === installed.ticketSha256, `V7 phase ${descriptor.phase} ticket does not match its descriptor`);
    const contract = { ...installed.contract };
    invariant(contract.schemaVersion === 'agentbattler.mini-ledger-v7.phase-contract.v1', `V7 phase ${descriptor.phase} contract schema mismatch`);
    invariant(contract.packSha256 === pack.packSha256, `V7 phase ${descriptor.phase} contract pack commitment mismatch`);
    invariant(contract.phase === descriptor.phase && contract.phaseId === descriptor.id, `V7 phase ${descriptor.phase} contract identity mismatch`);
    const artifacts = [];
    for (const artifact of installed.artifacts) {
      if (artifact.path === installed.path || artifact.path === installed.contractPath) continue;
      const relative = currentControlRelativePath(artifact.path);
      const bytes = await readFile(path.join(current, ...relative.split('/')));
      const digest = sha256(bytes);
      invariant(artifact.sha256 === digest, `V7 current artifact commitment mismatch: ${relative}`);
      artifacts.push({ path: relative, bytesBase64: bytes.toString('base64'), sha256: digest });
    }
    if (contract.incidentEvidencePath) invariant(installed.incidentEvidenceSha256 === contract.incidentEvidenceSha256, 'V7 phase incident evidence commitment mismatch');
    return { installed, ticket, contract, artifacts };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function phaseInstruction(pack, descriptor) {
  const { installed, ticket, contract, artifacts } = await currentTicket(pack, descriptor);
  invariant(installed.phaseDeltaSha256 === descriptor.phaseDeltaSha256, `V7 phase ${descriptor.phase} delta commitment mismatch`);
  const contractBytes = `${canonicalJson(contract)}\n`;
  const control = {
    schemaVersion: 'agentbattler.mini-ledger-v7.phase-control.v1',
    instanceId: pack.instanceId,
    phase: descriptor.phase,
    ticket,
    ticketSha256: installed.ticketSha256,
    contract,
    contractSha256: sha256(contractBytes),
    ...(artifacts.length > 0 ? { artifacts } : {}),
  };
  const envelope = Buffer.from(canonicalJson(control)).toString('base64');
  const prompt = [
    `Work only on Mini Ledger V7 phase ${descriptor.phase}: ${descriptor.title}.`,
    'Read .agentbattler/current/TASK.md and .agentbattler/current/task-contract.json before editing. The current root-owned smoke command named by that contract is also normative and self-service.',
    'Logs, comments, examples, old ADRs, and incident hypotheses are auxiliary evidence; resolve them through observable provenance.',
    'Run repository-provided smoke checks yourself. Preserve earlier contracts and leave the repository runnable within the hard 25-minute phase limit.',
    'Future tickets, private checks, scoring weights, and verifier sources are intentionally unavailable.',
  ].join('\n');
  return `${CONTROL_PREFIX}${envelope}\n${prompt}\n`;
}

function taskToml(pack, images) {
  invariant(typeof images?.environment === 'string' && typeof images?.verifier === 'string', 'V7 Harbor task image names are required');
  const phaseDeltaHashes = pack.phases.map(({ phaseDeltaSha256 }) => phaseDeltaSha256);
  const verifierCommitment = sha256(canonicalJson(pack.verifierHashes ?? pack.verifierSha256 ?? null));
  const artifactPolicyCommitment = sha256(canonicalJson(pack.artifactPolicy ?? {
    sourceAllowlist: ['package.json', 'bin/**', 'src/**', 'config/**'],
    maxFiles: 256,
    maxBytes: 4 * 1024 * 1024,
  }));
  return `schema_version = "1.4"
multi_step_reward_strategy = "final"
artifacts = [{ source = "/app", destination = "candidate" }]

[task]
name = ${tomlString(`agentbattler/mini-ledger-v7-${pack.instanceId}-${pack.variant}`)}
version = "7.0.0"
description = "Five-phase sealed repository-evolution benchmark"

[metadata]
benchmark = "AgentBattler"
challenge = "mini-ledger-v7"
protocol_revision = "sealed-evolution-packs-v1"
harbor_version = "0.20.0"
instance_id = ${tomlString(pack.instanceId)}
instance_pool = ${tomlString(pack.pool)}
instance_variant = ${tomlString(pack.variant)}
pack_sha256 = ${tomlString(pack.packSha256)}
seal_sha256 = ${tomlString(pack.sealSha256)}
starter_tree_sha256 = ${tomlString(pack.starterTreeSha256)}
phase_delta_sha256 = ${tomlArray(phaseDeltaHashes)}
requirements_sha256 = ${tomlString(pack.requirementsSha256)}
hidden_pack_merkle_root = ${tomlString(pack.hiddenMerkleRoot)}
verifier_commitment_sha256 = ${tomlString(verifierCommitment)}
artifact_policy_sha256 = ${tomlString(artifactPolicyCommitment)}
rubric_version = ${tomlString(pack.rubricVersion ?? 'mini-ledger-v7-rubric.v1')}
feedback_policy = "self-service-public-only"
phase_count = 5
agent_time_limit_sec_per_phase = 1500
agent_time_policy = "hard-25-minutes-per-phase-via-sealed-runner"
candidate_snapshot_policy = "terminal-candidate-tree.v1-overlay-every-phase"
verifier_workspace_policy = "normalized-source-overlay-on-fresh-sealed-starter"
candidate_network_policy = "r14-native-sandbox-deny"
agent_command_sandbox_policy = "r14-workspace-filesystem-minimal-environment-no-network-zero-capability"
durability_evidence_policy = "strace-plus-deterministic-termination-recovery-required"
primary_score_policy = "core-public-private-with-exact-adaptability-and-proxy-gap-separate"

[agent]
network_mode = "public"
timeout_sec = 1500.0

[verifier]
timeout_sec = 1800.0
environment_mode = "separate"

[verifier.environment]
# Harbor 0.20 rejects no-network for separate verifier environments. The
# credential-free root verifier drops outbound traffic before loading source.
network_mode = "public"
docker_image = ${tomlString(images.verifier)}
workdir = "/"
cpus = 4
memory_mb = 4096
storage_mb = 8192

[environment]
network_mode = "public"
docker_image = ${tomlString(images.environment)}
workdir = "/app"
cpus = 4
memory_mb = 4096
storage_mb = 8192

${pack.phases.map((descriptor, index) => `[[steps]]
name = ${tomlString(`${String(descriptor.phase).padStart(2, '0')}-${safeTaskSegment(descriptor.id, 'V7 phase id')}`)}

[steps.agent]
timeout_sec = 1500.0

[steps.verifier]
timeout_sec = ${index === pack.phases.length - 1 ? '1800.0' : '1200.0'}

[steps.verifier.env]
AGENTBATTLER_V7_PHASE = ${tomlString(descriptor.phase)}
AGENTBATTLER_V7_PHASE_ID = ${tomlString(descriptor.id)}
AGENTBATTLER_V7_FINAL_PHASE = ${tomlString(index === pack.phases.length - 1 ? '1' : '0')}
`).join('\n')}`;
}

function environmentDockerfile() {
  return `FROM node:24-bookworm-slim
ARG AGENTBATTLER_V7_CONTEXT_SHA256
LABEL org.agentbattler.v7.context-sha256="\${AGENTBATTLER_V7_CONTEXT_SHA256}"
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap ca-certificates curl git procps ripgrep socat strace util-linux \\
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g @openai/codex@${terminalHarnessVersion('codex-cli')} @anthropic-ai/claude-code@${terminalHarnessVersion('claude-code')} @earendil-works/pi-coding-agent@${terminalHarnessVersion('pi-coding-agent')}
COPY starter/ /seed/
COPY control-boundary-probe.sh /usr/local/bin/agentbattler-v7-control-boundary-probe
COPY executable-hash.mjs /usr/local/bin/agentbattler-v7-executable-hash
RUN set -eux; \\
    chown 0:0 /usr/local/bin/agentbattler-v7-control-boundary-probe; \\
    chown 0:0 /usr/local/bin/agentbattler-v7-executable-hash; \\
    chmod 0755 /usr/local/bin/agentbattler-v7-control-boundary-probe; \\
    chmod 0755 /usr/local/bin/agentbattler-v7-executable-hash; \\
    git -C /seed init --initial-branch=main; \\
    git -C /seed config user.name AgentBattler; \\
    git -C /seed config user.email sealed@invalid.example; \\
    git -C /seed add --all; \\
    GIT_AUTHOR_DATE=2000-01-01T00:00:00Z GIT_COMMITTER_DATE=2000-01-01T00:00:00Z git -C /seed commit -m 'sealed starter'; \\
    git clone --depth=1 file:///seed /app; \\
    git -C /app remote remove origin; \\
    rm -rf /seed; \\
    mkdir -p /app/config /app/.agentbattler/current; \\
    chown -R 0:0 /app; \\
    chmod 0755 /app /app/.agentbattler; \\
    chmod 0555 /app/.agentbattler/current; \\
    test -z "$(git -C /app remote)"; \\
    test "$(git -C /app rev-list --count HEAD)" = 1; \\
    command -v strace >/dev/null
WORKDIR /app
`;
}

function executableHashHelper() {
  return `#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

function invariant(condition, message) { if (!condition) throw new Error(message); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
async function listFiles(root, relative = '') {
  const found = [];
  for (const item of (await readdir(path.join(root, relative), { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    const child = relative ? path.posix.join(relative, item.name) : item.name;
    if (item.isDirectory()) found.push(...await listFiles(root, child));
    else if (item.isFile()) found.push(child);
  }
  return found;
}
async function executableHash(workspace) {
  const files = (await listFiles(workspace)).filter((relative) => relative === 'package.json' || ['bin/', 'src/', 'config/'].some((prefix) => relative.startsWith(prefix)));
  invariant(files.length > 0, 'Mini Ledger V7 executable source tree is empty');
  const digest = createHash('sha256');
  for (const relative of files) {
    digest.update(relative);
    digest.update('\\0');
    digest.update(sha256(await readFile(path.join(workspace, ...relative.split('/')))));
    digest.update('\\n');
  }
  return digest.digest('hex');
}
function option(name) {
  const index = process.argv.indexOf('--' + name);
  return index < 0 ? null : process.argv[index + 1];
}
try {
  const workspace = path.resolve(option('workspace') ?? '/app');
  const contractPath = option('update-contract');
  const digest = await executableHash(workspace);
  if (contractPath) {
    const target = path.resolve(contractPath);
    const contract = JSON.parse(await readFile(target, 'utf8'));
    contract.executableSourceSha256 = digest;
    contract.executableSourceHashAlgorithm = 'sha256-path-null-content-sha256-newline-v1';
    const temporary = target + '.agentbattler-' + process.pid + '.tmp';
    await writeFile(temporary, JSON.stringify(stable(contract)) + '\\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
  }
  process.stdout.write(digest + '\\n');
} catch (error) {
  process.stderr.write(String(error?.message ?? error) + '\\n');
  process.exitCode = 1;
}
`;
}

function environmentCompose() {
  return `services:
  main:
    cap_drop:
      - ALL
    cap_add:
      - CHOWN
      - SYS_ADMIN
      - NET_ADMIN
    security_opt:
      - no-new-privileges:true
      - seccomp=unconfined
`;
}

function controlBoundaryProbe() {
  return `#!/bin/sh
set -eu
capability_mask="$(sed -n 's/^CapEff:[[:space:]]*//p' /proc/self/status)"
case "$capability_mask" in
  ''|*[!0]*) echo "V7 control probe requires a zero-capability model child" >&2; exit 77 ;;
esac
source_probe="/app/src/.agentbattler-v7-write-probe-$$"
printf 'source-write-ok\\n' > "$source_probe"
test "$(cat "$source_probe")" = source-write-ok
rm "$source_probe"
ticket=/app/.agentbattler/current/TASK.md
contract=/app/.agentbattler/current/task-contract.json
test -r "$ticket" -a -r "$contract"
if chmod 0644 "$ticket" >/dev/null 2>&1; then
  echo "V7 control probe changed ticket mode" >&2
  exit 78
fi
if (printf 'tamper\\n' > "$contract") 2>/dev/null; then
  echo "V7 control probe wrote the machine contract" >&2
  exit 79
fi
if umount /app/.agentbattler/current >/dev/null 2>&1; then
  echo "V7 control probe unmounted the trusted control directory" >&2
  exit 80
fi
test "$(findmnt -n -o OPTIONS --target /app/.agentbattler/current | tr ',' '\\n' | grep -cx ro)" = 1
`;
}

function verifierDockerfile() {
  return `FROM node:24-bookworm-slim
ARG AGENTBATTLER_V7_CONTEXT_SHA256
LABEL org.agentbattler.v7.context-sha256="\${AGENTBATTLER_V7_CONTEXT_SHA256}"
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap iptables strace \\
    && rm -rf /var/lib/apt/lists/*
COPY . /tests
RUN printf '%s\\n' \\
      '#!/bin/sh' \\
      'set -eu' \\
      'cap="$(sed -n "s/^CapEff:[[:space:]]*//p" /proc/self/status)"' \\
      'case "$cap" in ""|*[!0]*) echo "V7 candidate retained capabilities" >&2; exit 77;; esac' \\
      'test "$(id -u)" = 1000 && test "$(id -g)" = 1000' \\
      'for hidden in /tests /input /output /evidence /logs; do test ! -e "$hidden" || { echo "V7 candidate can see verifier control" >&2; exit 78; }; done' \\
      'exec "$@"' \\
      > /usr/local/bin/agentbattler-v7-candidate-guard \\
    && chown 0:0 /usr/local/bin/agentbattler-v7-candidate-guard \\
    && chmod 0555 /usr/local/bin/agentbattler-v7-candidate-guard
RUN find /tests -type d -exec chmod 0700 {} + \\
    && find /tests -type f -exec chmod 0600 {} + \\
    && chmod 0700 /tests/test.sh /tests/run-phase.mjs \\
    && command -v bwrap >/dev/null \\
    && command -v strace >/dev/null
WORKDIR /
`;
}

function verifierCompose() {
  return `services:
  main:
    cap_drop:
      - ALL
    cap_add:
      - NET_ADMIN
      - CHOWN
      - DAC_OVERRIDE
      - FOWNER
      - SETUID
      - SETGID
      - SYS_ADMIN
      - SYS_PTRACE
    security_opt:
      - no-new-privileges:true
      - seccomp=unconfined
`;
}

function verifierShell() {
  return `#!/bin/sh
set -eu
iptables -P OUTPUT DROP
test "$(stat -c %a /tests)" = 700
test "$(stat -c %a /tests/benchmark/challenges/mini-ledger-v7/verifier.mjs)" = 600
command -v strace >/dev/null
exec node /tests/run-phase.mjs
`;
}

function verifierRunner() {
  return `#!/usr/bin/env node
import { constants as fsConstants } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chown, lstat, mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { candidateNativeSandboxCommand } from './benchmark/challenges/candidate-process.mjs';
import { loadV7Pack } from './benchmark/challenges/mini-ledger-v7/pack.mjs';
import { createV7CandidateTrajectoryFailureResult, verifyPhaseTrajectory } from './benchmark/challenges/mini-ledger-v7/verifier.mjs';
import { captureTerminalCandidateTree } from './src/terminal-candidate-tree.mjs';
import { materializeTerminalV7Candidate } from './src/terminal-v7-overlay.mjs';

const workspace = '/app';
const logs = '/logs/verifier';
const baselineDirectory = '/tests/starter-baseline';
const gradedDirectory = '/tmp/agentbattler-v7-graded';
const phase = Number(process.env.AGENTBATTLER_V7_PHASE);
const phaseId = process.env.AGENTBATTLER_V7_PHASE_ID;
const finalPhase = process.env.AGENTBATTLER_V7_FINAL_PHASE === '1';
const sealedPack = JSON.parse(await readFile('/tests/sealed-pack.json', 'utf8'));
const seedKey = await readFile('/tests/hidden-seed-key', 'utf8').then((value) => value.trim()).catch((error) => {
  if (error?.code === 'ENOENT') return undefined;
  throw error;
});
const canonicalPack = loadV7Pack(sealedPack.instanceId, { variant: sealedPack.variant });
const policy = {
  schemaVersion: 'agentbattler.terminal-candidate-tree-policy.v1',
  include: ['package.json', 'bin/**', 'src/**', 'config/**'],
  exclude: ['.git/**', '.agentbattler/**', 'contract/**', 'node_modules/**', 'test/**', 'tests/**', 'var/**', 'tmp/**', '.cache/**'],
  maxFiles: 256,
  maxBytes: 4 * 1024 * 1024,
  regularFilesOnly: true,
  rejectHardlinks: true,
};

function invariant(condition, message) { if (!condition) throw new Error(message); }
function diagnostic(error) { return String(error?.message ?? error).slice(0, 1000); }
function number(value) { return Number.isFinite(Number(value)) ? Number(value) : null; }
function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(maximum, value)); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

async function childResult(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({
      code,
      signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

async function zeroCapabilityProbe() {
  const result = await childResult('/bin/sh', ['-c', "sed -n 's/^CapEff:[[:space:]]*//p' /proc/self/status"], {
    uid: 1000,
    gid: 1000,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  });
  const mask = result.stdout.trim();
  invariant(result.code === 0 && !result.signal, 'V7 Harbor verifier candidate capability probe failed: ' + result.stderr);
  invariant(/^0+$/.test(mask), 'V7 Harbor verifier candidate capability mask is not zero');
  return mask;
}

async function nativeBoundaryProbe() {
  const probeWorkspace = '/tmp/agentbattler-v7-native-boundary-probe';
  await mkdir(probeWorkspace, { recursive: true, mode: 0o770 });
  await chown(probeWorkspace, 1000, 1000);
  const invocation = candidateNativeSandboxCommand({
    workspace: probeWorkspace,
    executable: '/bin/sh',
    args: ['-c', 'test ! -e /tests && test ! -e /input && test ! -e /output && test ! -e /evidence && test ! -e /logs && test -r /workspace && printf native-boundary-ok'],
  });
  invariant(invocation.nativeBoundary === true, 'V7 Harbor verifier did not select its native candidate boundary');
  const result = await childResult(invocation.command, invocation.args, invocation.options);
  invariant(result.code === 0 && !result.signal && result.stdout === 'native-boundary-ok', 'V7 Harbor verifier native candidate boundary probe failed: ' + result.stderr);
  return 'bubblewrap-v1';
}

function normalizedArtifactPath(value) {
  invariant(typeof value === 'string' && value.length > 0 && !value.includes('\\\\') && !value.includes('\\0'), 'declared artifact path is invalid');
  invariant(!path.posix.isAbsolute(value) && path.posix.normalize(value) === value && !value.split('/').includes('..'), 'declared artifact path may not traverse');
  const forbidden = ['.agentbattler', '.git', 'bin', 'config', 'node_modules', 'src', 'test', 'tests'];
  invariant(value !== 'package.json' && !forbidden.some((prefix) => value === prefix || value.startsWith(prefix + '/')), 'declared artifact path overlaps executable or control source');
  return value;
}

async function readRegularArtifact(root, relative, maxBytes) {
  const absolute = path.join(root, ...relative.split('/'));
  const before = await lstat(absolute);
  invariant(before.isFile() && !before.isSymbolicLink() && before.nlink === 1, 'declared artifact is not one regular unlinked file: ' + relative);
  invariant(before.size <= maxBytes, 'declared artifact exceeds byte limit: ' + relative);
  const handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const after = await handle.stat();
    invariant(after.isFile() && after.dev === before.dev && after.ino === before.ino && after.nlink === 1, 'declared artifact changed while opening: ' + relative);
    const bytes = await handle.readFile();
    invariant(bytes.length === after.size, 'declared artifact changed while reading: ' + relative);
    return { bytes, mode: after.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

async function installTrustedCurrentContract(gradedWorkspace) {
  const source = path.join(workspace, '.agentbattler', 'current', 'task-contract.json');
  const bytes = await readFile(source);
  invariant(bytes.length <= 128 * 1024, 'current V7 contract exceeds 128 KiB');
  const contract = JSON.parse(bytes);
  invariant(contract.schemaVersion === 'agentbattler.mini-ledger-v7.phase-contract.v1', 'current V7 contract schema mismatch');
  invariant(contract.instanceId === sealedPack.instanceId && contract.phase === phase && contract.phaseId === phaseId, 'current V7 contract identity mismatch');
  const target = path.join(gradedWorkspace, '.agentbattler', 'current', 'task-contract.json');
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, bytes, { mode: 0o400, flag: 'wx' });
  return contract;
}

async function captureDeclaredArtifacts(contract, gradedWorkspace) {
  if (!contract.responsePath) return [];
  invariant(phase === 4, 'only V7 phase 4 may declare a response artifact');
  const relative = normalizedArtifactPath(contract.responsePath);
  const { bytes, mode } = await readRegularArtifact(workspace, relative, 64 * 1024);
  const archiveRelative = path.posix.join('declared-artifacts', 'phase-04', relative);
  const archive = path.join(logs, ...archiveRelative.split('/'));
  await mkdir(path.dirname(archive), { recursive: true, mode: 0o700 });
  await writeFile(archive, bytes, { mode: 0o600, flag: 'wx' });
  const target = path.join(gradedWorkspace, ...relative.split('/'));
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, bytes, { mode, flag: 'wx' });
  const record = { path: relative, sizeBytes: bytes.length, sha256: sha256(bytes), mode: (mode & 0o777).toString(8).padStart(4, '0'), archivePath: archiveRelative };
  await writeFile(path.join(logs, 'declared-artifacts', 'phase-04', 'metadata.json'), JSON.stringify({ schemaVersion: 'agentbattler.terminal-declared-artifacts.v1', artifacts: [record] }, null, 2), { mode: 0o600, flag: 'wx' });
  return [record];
}

function coreScore(result) {
  for (const value of [result?.core, result?.coreScore, result?.score, result?.scores?.core, result?.score?.core]) {
    const parsed = number(value);
    if (parsed !== null) return clamp(parsed, 0, 100);
  }
  return null;
}

function phaseFraction(result) {
  if (typeof result?.passed === 'boolean') return result.passed ? 1 : 0;
  const earned = number(result?.earnedWeight ?? result?.score ?? result?.public?.earned);
  const possible = number(result?.maxWeight ?? result?.maxScore ?? result?.public?.possible);
  return earned !== null && possible && possible > 0 ? clamp(earned / possible, 0, 1) : 0;
}

async function giveTreeToCandidate(root) {
  const stat = await lstat(root);
  await chown(root, 1000, 1000);
  if (!stat.isDirectory()) return;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    await giveTreeToCandidate(path.join(root, entry.name));
  }
}

await mkdir(logs, { recursive: true });
process.env.AGENTBATTLER_CANDIDATE_UID = '1000';
process.env.AGENTBATTLER_CANDIDATE_GID = '1000';
process.env.AGENTBATTLER_CANDIDATE_NATIVE_SANDBOX = 'bubblewrap-v1';
invariant(Number.isSafeInteger(phase) && phase >= 1 && phase <= 5, 'invalid V7 verifier phase');
invariant(canonicalPack.packSha256 === sealedPack.packSha256, 'sealed V7 pack descriptor differs from canonical visible descriptor');
invariant(canonicalPack.starterTreeSha256 === sealedPack.starterTreeSha256, 'sealed V7 starter commitment mismatch');
invariant(canonicalPack.phases[phase - 1]?.id === phaseId, 'V7 phase id does not match the sealed descriptor');
invariant(typeof sealedPack.hiddenMerkleRoot === 'string' && /^[a-f0-9]{64}$/.test(sealedPack.hiddenMerkleRoot), 'sealed V7 hidden Merkle root is missing');
const candidateCapabilityMask = await zeroCapabilityProbe();
const candidateNativeBoundary = await nativeBoundaryProbe();

let candidateTree = null;
let candidateTreeRejection = null;
let declaredArtifactRejection = null;
let currentContract = null;
let declaredArtifacts = [];
let phaseEvaluation = null;
let finalEvaluation = null;
let infrastructureError = null;
try {
  candidateTree = await captureTerminalCandidateTree({
    workspace,
    baseDirectory: baselineDirectory,
    runDirectory: logs,
    turn: phase,
    policy,
  });
} catch (error) {
  candidateTreeRejection = diagnostic(error);
}

if (candidateTree) {
  try {
    const graded = await materializeTerminalV7Candidate({
      pack: canonicalPack,
      candidateTree,
      runDirectory: logs,
      destination: gradedDirectory,
      baselineDirectory,
      policy,
    });
    currentContract = await installTrustedCurrentContract(graded.workspace);
    try {
      declaredArtifacts = await captureDeclaredArtifacts(currentContract, graded.workspace);
    } catch (error) {
      declaredArtifactRejection = diagnostic(error);
    }
    await giveTreeToCandidate(graded.workspace);
    phaseEvaluation = await verifyPhaseTrajectory({
      instance: sealedPack,
      pack: sealedPack,
      phase,
      candidateTree,
      workspace: graded.workspace,
      contract: currentContract,
      declaredArtifacts,
      previousCandidateTreeSha256: null,
      durabilityTraceDirectory: path.join(logs, 'durability'),
      seedKey,
    });
  } catch (error) {
    infrastructureError = diagnostic(error);
  }
}
if (!candidateTree && !infrastructureError) {
  phaseEvaluation = createV7CandidateTrajectoryFailureResult({
    instance: sealedPack,
    pack: sealedPack,
    phase,
    seedKey,
    diagnostic: candidateTreeRejection ?? 'candidate source overlay was rejected',
  });
}

const finalCore = coreScore(finalEvaluation);
const rewardValue = phaseFraction(phaseEvaluation);
const publicRequirements = Array.isArray(phaseEvaluation?.requirements)
  ? phaseEvaluation.requirements.filter(({ group }) => group === 'public')
  : [];
const phasePassed = candidateTreeRejection === null && infrastructureError === null
  && publicRequirements.length > 0 && publicRequirements.every(({ passed }) => passed === true);
const stage = {
  id: phaseId,
  phase,
  passed: phasePassed,
  regressions: Number(phaseEvaluation?.regressions ?? (phasePassed ? 0 : 1)),
  exitCode: phasePassed ? 0 : 1,
  durationMs: number(phaseEvaluation?.durationMs) ?? 0,
  diagnostic: candidateTreeRejection ?? declaredArtifactRejection ?? infrastructureError ?? phaseEvaluation?.diagnostic ?? null,
};
const result = {
  schemaVersion: 'agentbattler.harbor-mini-ledger-v7-phase-result.v1',
  instanceId: sealedPack.instanceId,
  variant: sealedPack.variant,
  phase,
  phaseId,
  candidateCapabilityMask,
  candidateNativeBoundary,
  stage,
  candidateTree,
  candidateTreeRejection,
  currentContract,
  declaredArtifacts,
  declaredArtifact: declaredArtifacts[0] ?? null,
  declaredArtifactRejection,
  phaseEvaluation,
  finalEvaluation,
  finalBreakdown: finalEvaluation ? {
    core: finalCore,
    exact: finalEvaluation.exact ?? finalEvaluation.Exact ?? finalEvaluation.passed ?? null,
    public: finalEvaluation.public ?? finalEvaluation.publicScore ?? finalEvaluation.scores?.public ?? null,
    private: finalEvaluation.private ?? finalEvaluation.privateScore ?? finalEvaluation.hidden ?? finalEvaluation.scores?.private ?? null,
    adaptability: finalEvaluation.adaptability ?? finalEvaluation.scores?.adaptability ?? null,
    proxyGap: finalEvaluation.proxyGap ?? finalEvaluation.scores?.proxyGap ?? null,
    phaseFourTrajectoryComparison: 'computed-from-phase-03-and-phase-04-candidate-tree-hashes-by-result-importer',
  } : null,
  infrastructureError,
  infrastructureErrors: infrastructureError ? [infrastructureError] : [],
};
await writeFile(path.join(logs, 'reward.json'), JSON.stringify({
  reward: rewardValue,
  core_score: finalCore ?? 0,
  phase_passed: phasePassed ? 1 : 0,
  infrastructure_valid: infrastructureError === null ? 1 : 0,
}));
await writeFile(path.join(logs, 'stage-result.json'), JSON.stringify(result, null, 2));
if (infrastructureError) process.exitCode = 2;
`;
}

async function copyVerifierSources(testsRoot) {
  const destination = path.join(testsRoot, 'benchmark', 'challenges', 'mini-ledger-v7');
  await mkdir(destination, { recursive: true });
  await mkdir(path.join(testsRoot, 'src'), { recursive: true });
  for (const name of ['pack.mjs', 'requirements.mjs', 'verifier.mjs', 'requirement-map.json']) {
    await cp(path.join(CHALLENGE_ROOT, name), path.join(destination, name));
  }
  for (const name of ['starter', 'tickets']) {
    await cp(path.join(CHALLENGE_ROOT, name), path.join(destination, name), { recursive: true });
  }
  await cp(CANDIDATE_PROCESS, path.join(testsRoot, 'benchmark', 'challenges', 'candidate-process.mjs'));
  for (const file of SOURCE_SUPPORT) {
    await cp(path.join(REPO_ROOT, 'src', file), path.join(testsRoot, 'src', file));
  }
}

async function buildOneTask({ pack, outputRoot, seedKey }) {
  invariant(pack.phases?.length === TERMINAL_V7_HARBOR_PHASE_COUNT, 'A V7 Harbor pack must declare exactly five phases');
  invariant(pack.phases.every(({ phase }, index) => phase === index + 1), 'V7 Harbor phases must be ordered 1 through 5');
  await access(path.join(CHALLENGE_ROOT, 'verifier.mjs'));
  const sealedPack = sealV7Pack(pack, { seedKey: pack.pool === 'dev' ? undefined : seedKey });
  invariant(sealedPack.hiddenMerkleRoot && sealedPack.sealSha256, 'V7 Harbor pack sealing did not produce commitments');
  const taskName = `${safeTaskSegment(pack.instanceId, 'V7 instance id')}-${safeTaskSegment(pack.variant, 'V7 variant')}`;
  const taskRoot = path.join(outputRoot, taskName);
  await rm(taskRoot, { recursive: true, force: true });
  await mkdir(path.join(taskRoot, 'environment'), { recursive: true });
  await materializeV7Starter({ pack, destination: path.join(taskRoot, 'environment', 'starter') });
  await writeFile(path.join(taskRoot, 'environment', 'Dockerfile'), environmentDockerfile());
  await writeFile(path.join(taskRoot, 'environment', 'docker-compose.yaml'), environmentCompose());
  await writeFile(path.join(taskRoot, 'environment', 'control-boundary-probe.sh'), controlBoundaryProbe(), { mode: 0o755 });
  await writeFile(path.join(taskRoot, 'environment', 'executable-hash.mjs'), executableHashHelper(), { mode: 0o755 });
  for (const descriptor of sealedPack.phases) {
    const stepName = `${String(descriptor.phase).padStart(2, '0')}-${descriptor.id}`;
    const stepRoot = path.join(taskRoot, 'steps', stepName);
    const testsRoot = path.join(stepRoot, 'tests');
    await mkdir(testsRoot, { recursive: true });
    await writeFile(path.join(stepRoot, 'instruction.md'), await phaseInstruction(pack, descriptor));
    await writeFile(path.join(testsRoot, 'Dockerfile'), verifierDockerfile());
    await writeFile(path.join(testsRoot, 'docker-compose.yaml'), verifierCompose());
    await writeFile(path.join(testsRoot, 'test.sh'), verifierShell(), { mode: 0o700 });
    await writeFile(path.join(testsRoot, 'run-phase.mjs'), verifierRunner(), { mode: 0o700 });
    await writeFile(path.join(testsRoot, 'sealed-pack.json'), `${canonicalJson(sealedPack)}\n`, { mode: 0o600 });
    if (pack.pool !== 'dev') await writeFile(path.join(testsRoot, 'hidden-seed-key'), `${seedKey}\n`, { mode: 0o600 });
    await materializeV7Starter({ pack, destination: path.join(testsRoot, 'starter-baseline') });
    await copyVerifierSources(testsRoot);
  }

  const images = {
    environment: TERMINAL_V7_HARBOR_UNBOUND_IMAGE_ID,
    verifier: TERMINAL_V7_HARBOR_UNBOUND_IMAGE_ID,
  };
  await writeFile(path.join(taskRoot, 'task.toml'), taskToml(sealedPack, images));

  await writeFile(path.join(taskRoot, 'README.md'), `# Mini Ledger V7: ${pack.instanceId} (${pack.variant})

This sealed Harbor task is generated from pack commitment \`${pack.packSha256}\` and contains exactly five persistent-session phases. The candidate image starts from one sanitized, one-commit repository with no remotes. Only the current ticket and current machine-readable contract are installed by the trusted V7 Harbor adapter before each phase.

Every candidate phase has a hard 25-minute limit supplied by the sealed schedule/runner. Verifiers execute separately without credentials, drop outbound traffic before loading source, keep \`/tests\` root-only, capture a normalized \`terminal-candidate-tree.v1\` overlay, and grade that overlay on a fresh starter tree. The R14 model-command sandbox capability, filesystem, environment, and network boundaries are unchanged. \`strace\` is installed for verifier-owned durability observations.
`);
  const taskIdentity = await terminalV7HarborTaskTreeIdentity({ taskRoot });
  return {
    instanceId: pack.instanceId,
    variant: pack.variant,
    taskRoot,
    packSha256: pack.packSha256,
    sealSha256: sealedPack.sealSha256,
    taskSha256: taskIdentity.sha256,
    fileCount: taskIdentity.fileCount,
  };
}

export async function buildHarborTerminalV7Tasks({
  pool = 'dev',
  variant = 'decoy',
  instanceIds = null,
  outputRoot = null,
  resultRoot = process.env.AGENTBATTLER_TERMINAL_RESULT_ROOT ?? null,
  seedKey = process.env.AGENTBATTLER_V7_SEED_KEY,
} = {}) {
  invariant(['dev', 'release', 'reserve'].includes(pool), `Unknown V7 Harbor pool: ${pool}`);
  invariant(['clean', 'decoy'].includes(variant), `Unknown V7 Harbor variant: ${variant}`);
  invariant(resultRoot === null || path.isAbsolute(resultRoot), 'V7 Harbor resultRoot must be absolute');
  const resolvedResultRoot = resultRoot ? path.resolve(resultRoot) : null;
  invariant(pool === 'dev' || resolvedResultRoot, 'Release and reserve Harbor builds require an absolute resultRoot');
  const resolvedOutput = path.resolve(outputRoot ?? (pool === 'dev'
    ? DEFAULT_OUTPUT_ROOT
    : path.join(resolvedResultRoot ?? '', 'control', 'harbor-tasks')));
  assertSafeOutputRoot(resolvedOutput);
  const repositoryRelativeOutput = path.relative(REPO_ROOT, resolvedOutput);
  const outputIsInRepository = repositoryRelativeOutput === '' || (!repositoryRelativeOutput.startsWith('..') && !path.isAbsolute(repositoryRelativeOutput));
  invariant(pool === 'dev' || !outputIsInRepository, 'Release and reserve Harbor tasks contain evaluator-only material and must be generated outside the repository');
  if (pool !== 'dev') {
    const privateRoot = path.join(resolvedResultRoot, 'control', 'harbor-tasks');
    const privateRelative = path.relative(privateRoot, resolvedOutput);
    invariant(privateRelative === '' || (!privateRelative.startsWith('..') && !path.isAbsolute(privateRelative)), 'Release and reserve Harbor tasks must stay under RESULT_ROOT/control/harbor-tasks');
  }
  await mkdir(resolvedOutput, { recursive: true });
  const packs = instanceIds === null
    ? listV7Packs({ pool, variant })
    : instanceIds.map((instanceId) => loadV7Pack(instanceId, { variant }));
  invariant(packs.length > 0, 'V7 Harbor build requires at least one pack');
  invariant(new Set(packs.map(({ instanceId }) => instanceId)).size === packs.length, 'V7 Harbor instance ids must be unique');
  invariant(packs.every((pack) => pack.pool === pool), 'A selected V7 Harbor instance belongs to a different pool');
  const tasks = [];
  for (const pack of packs) {
    const built = await buildOneTask({ pack, outputRoot: resolvedOutput, seedKey });
    let taskPathBase;
    let taskPath;
    if (outputIsInRepository) {
      taskPathBase = 'repository';
      taskPath = path.relative(REPO_ROOT, built.taskRoot);
    } else if (resolvedResultRoot) {
      taskPathBase = 'result-root';
      taskPath = path.relative(resolvedResultRoot, built.taskRoot);
    } else {
      taskPathBase = 'output-root';
      taskPath = path.relative(resolvedOutput, built.taskRoot);
    }
    invariant(taskPath && !taskPath.startsWith('..') && !path.isAbsolute(taskPath), 'Generated V7 Harbor task path escaped its declared base');
    tasks.push({
      instanceId: built.instanceId,
      variant: built.variant,
      taskPathBase,
      taskPath: taskPath.split(path.sep).join('/'),
      packSha256: built.packSha256,
      sealSha256: built.sealSha256,
      sha256: built.taskSha256,
      fileCount: built.fileCount,
    });
  }
  const manifest = {
    schemaVersion: 'agentbattler.harbor-mini-ledger-v7-task-set.v1',
    challengeId: 'terminal-mini-ledger-v7',
    pool,
    variant,
    feedbackPolicy: 'self-service-public-only',
    phaseLimitMs: TERMINAL_V7_HARBOR_AGENT_TIMEOUT_SECONDS * 1000,
    tasks,
  };
  await writeFile(path.join(resolvedOutput, `manifest-${pool}-${variant}.json`), `${canonicalJson(manifest)}\n`);
  return manifest;
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? null : process.argv[index + 1];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const pool = argument('pool') ?? process.env.AGENTBATTLER_V7_POOL ?? 'dev';
    const variant = argument('variant') ?? process.env.AGENTBATTLER_V7_VARIANT ?? 'decoy';
    const instance = argument('instance');
    const output = argument('output');
    const resultRoot = argument('result-root') ?? process.env.AGENTBATTLER_TERMINAL_RESULT_ROOT ?? null;
    const manifest = await buildHarborTerminalV7Tasks({
      pool,
      variant,
      instanceIds: instance ? instance.split(',').map((value) => value.trim()).filter(Boolean) : null,
      outputRoot: output ? path.resolve(output) : null,
      resultRoot,
    });
    process.stdout.write(`${JSON.stringify({ ok: true, pool, variant, taskCount: manifest.tasks.length, taskPathBase: manifest.tasks[0]?.taskPathBase ?? null })}\n`);
  } catch (error) {
    process.stderr.write(`${String(error?.message ?? error)}\n`);
    process.exitCode = 1;
  }
}
