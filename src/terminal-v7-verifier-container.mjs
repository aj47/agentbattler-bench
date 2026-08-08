import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson, canonicalJsonSha256, sha256, sha256File } from './provenance.mjs';
import { sealTerminalV7VerifierEvaluationArtifact } from './terminal-v7-verifier-evidence.mjs';

export const TERMINAL_V7_VERIFIER_IMAGE = 'agentbattler-mini-ledger-v7-verifier:r2';
export const TERMINAL_V7_VERIFIER_SOURCE_LABEL = 'org.agentbattler.v7.verifier-source-sha256';
export const TERMINAL_V7_VERIFIER_IMAGE_ENTRYPOINT = '/tests/benchmark/verifier/mini-ledger-v7/run.mjs';

export const TERMINAL_V7_VERIFIER_IMAGE_COPY_LAYOUT = Object.freeze([
  Object.freeze({ source: 'benchmark/challenges/candidate-process.mjs', destination: '/tests/benchmark/challenges/candidate-process.mjs' }),
  Object.freeze({ source: 'benchmark/challenges/mini-ledger-v7/pack.mjs', destination: '/tests/benchmark/challenges/mini-ledger-v7/pack.mjs' }),
  Object.freeze({ source: 'benchmark/challenges/mini-ledger-v7/requirements.mjs', destination: '/tests/benchmark/challenges/mini-ledger-v7/requirements.mjs' }),
  Object.freeze({ source: 'benchmark/challenges/mini-ledger-v7/verifier.mjs', destination: '/tests/benchmark/challenges/mini-ledger-v7/verifier.mjs' }),
  Object.freeze({ source: 'benchmark/challenges/mini-ledger-v7/requirement-map.json', destination: '/tests/benchmark/challenges/mini-ledger-v7/requirement-map.json' }),
  Object.freeze({ source: 'benchmark/challenges/mini-ledger-v7/starter', destination: '/tests/benchmark/challenges/mini-ledger-v7/starter' }),
  Object.freeze({ source: 'benchmark/challenges/mini-ledger-v7/tickets', destination: '/tests/benchmark/challenges/mini-ledger-v7/tickets' }),
  Object.freeze({ source: 'benchmark/verifier/mini-ledger-v7/run.mjs', destination: TERMINAL_V7_VERIFIER_IMAGE_ENTRYPOINT }),
]);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCKERFILE_PATH = 'benchmark/verifier/mini-ledger-v7/Dockerfile';
const SOURCE_PATHS = Object.freeze([
  ...TERMINAL_V7_VERIFIER_IMAGE_COPY_LAYOUT.map(({ source }) => source),
  DOCKERFILE_PATH,
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function sourceRecords(absolute, relative) {
  const stat = await lstat(absolute);
  invariant(!stat.isSymbolicLink(), `V7 verifier source contains a symlink: ${relative}`);
  if (stat.isFile()) return [{ path: relative.split(path.sep).join('/'), sha256: await sha256File(absolute) }];
  invariant(stat.isDirectory(), `V7 verifier source is not regular: ${relative}`);
  const records = [];
  const entries = await readdir(absolute, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const childRelative = path.join(relative, entry.name);
    records.push(...await sourceRecords(path.join(absolute, entry.name), childRelative));
  }
  return records;
}

function dockerfileCopyLayout(dockerfile) {
  return dockerfile.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('COPY ')) return [];
    const tokens = trimmed.split(/\s+/);
    invariant(tokens.length === 3 && tokens[0] === 'COPY', 'V7 verifier Dockerfile COPY must use one explicit source and destination');
    return [{ source: tokens[1], destination: tokens[2] }];
  });
}

async function assertVerifierDockerfileLayout(root) {
  const dockerfile = await readFile(path.join(root, DOCKERFILE_PATH), 'utf8');
  invariant(
    canonicalJson(dockerfileCopyLayout(dockerfile)) === canonicalJson(TERMINAL_V7_VERIFIER_IMAGE_COPY_LAYOUT),
    'V7 verifier Dockerfile COPY layout differs from the source commitment',
  );
  invariant(
    dockerfile.split(/\r?\n/).includes(`ENTRYPOINT ["node", "${TERMINAL_V7_VERIFIER_IMAGE_ENTRYPOINT}"]`),
    'V7 verifier Dockerfile entrypoint differs from the committed image layout',
  );
}

export async function terminalV7VerifierSourceDescriptor({ root = ROOT } = {}) {
  invariant(path.isAbsolute(root), 'V7 verifier source root must be absolute');
  await assertVerifierDockerfileLayout(root);
  const records = [];
  for (const relative of SOURCE_PATHS) records.push(...await sourceRecords(path.join(root, relative), relative));
  records.sort((left, right) => left.path.localeCompare(right.path));
  return Object.freeze({
    schemaVersion: 'agentbattler.terminal-v7-verifier-image-source.v1',
    image: TERMINAL_V7_VERIFIER_IMAGE,
    fileCount: records.length,
    files: Object.freeze(records),
    sourceSha256: canonicalJsonSha256(records),
    network: 'none',
    readOnlyRootFilesystem: true,
    candidateUid: 1000,
    candidateCapabilities: 'exactly-zero',
    resourcePolicy: Object.freeze({ cpus: 4, memoryBytes: 4 * 1024 * 1024 * 1024, pids: 256 }),
  });
}

function capture(command, args, { cwd = ROOT, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const child = spawn(command, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
  });
}

export async function inspectTerminalV7VerifierImage({ expectedSourceSha256 = null, expectedImageId = null } = {}) {
  const descriptor = await terminalV7VerifierSourceDescriptor();
  if (expectedSourceSha256 !== null) invariant(descriptor.sourceSha256 === expectedSourceSha256, 'V7 verifier image source does not match the sealed challenge');
  const result = await capture('docker', ['image', 'inspect', TERMINAL_V7_VERIFIER_IMAGE, '--format', `{{ index .Config.Labels "${TERMINAL_V7_VERIFIER_SOURCE_LABEL}" }} {{ .Id }}`]);
  invariant(result.code === 0 && !result.signal && !result.timedOut, `V7 verifier image is unavailable: ${result.stderr.trim()}`);
  const [sourceSha256, imageId] = result.stdout.trim().split(/\s+/, 2);
  invariant(sourceSha256 === descriptor.sourceSha256, 'V7 verifier image was built from different source bytes');
  invariant(/^sha256:[0-9a-f]{64}$/.test(imageId ?? ''), 'V7 verifier image ID is invalid');
  if (expectedImageId !== null) invariant(imageId === expectedImageId, 'V7 verifier image ID does not match the sealed challenge');
  return { ...descriptor, imageId };
}

export async function buildTerminalV7VerifierImage() {
  const descriptor = await terminalV7VerifierSourceDescriptor();
  const result = await capture('docker', [
    'build',
    '--file', 'benchmark/verifier/mini-ledger-v7/Dockerfile',
    '--tag', TERMINAL_V7_VERIFIER_IMAGE,
    '--build-arg', `AGENTBATTLER_V7_VERIFIER_SOURCE_SHA256=${descriptor.sourceSha256}`,
    '.',
  ], { timeoutMs: 20 * 60 * 1000 });
  invariant(result.code === 0 && !result.signal && !result.timedOut, `V7 verifier image build failed: ${result.stderr.slice(-2000)}`);
  return inspectTerminalV7VerifierImage({ expectedSourceSha256: descriptor.sourceSha256 });
}

function safeBindPath(value, label) {
  invariant(typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0'), `${label} must be an absolute path`);
  return path.resolve(value);
}

export function terminalV7VerifierRunArguments({
  verifierImage,
  workspace,
  input,
  output,
  evidenceDirectory,
} = {}) {
  invariant(verifierImage?.image === TERMINAL_V7_VERIFIER_IMAGE, 'V7 verifier inspected image tag is invalid');
  invariant(/^sha256:[0-9a-f]{64}$/.test(verifierImage?.imageId ?? ''), 'V7 verifier inspected image ID is invalid');
  const candidate = safeBindPath(workspace, 'V7 verifier workspace');
  const verifierInput = safeBindPath(input, 'V7 verifier input directory');
  const verifierOutput = safeBindPath(output, 'V7 verifier output directory');
  const evidence = safeBindPath(evidenceDirectory, 'V7 verifier evidence directory');
  return [
    'run', '--rm',
    '--network', 'none',
    '--read-only',
    '--cap-drop', 'ALL',
    '--cap-add', 'CHOWN',
    '--cap-add', 'DAC_OVERRIDE',
    '--cap-add', 'FOWNER',
    '--cap-add', 'SETUID',
    '--cap-add', 'SETGID',
    '--cap-add', 'SYS_ADMIN',
    '--cap-add', 'SYS_PTRACE',
    '--security-opt', 'no-new-privileges',
    '--security-opt', 'seccomp=unconfined',
    '--pids-limit', '256',
    '--memory', '4g',
    '--cpus', '4',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=2g',
    '--mount', `type=bind,src=${candidate},dst=/candidate,readonly`,
    '--mount', `type=bind,src=${verifierInput},dst=/input,readonly`,
    '--mount', `type=bind,src=${verifierOutput},dst=/output`,
    '--mount', `type=bind,src=${evidence},dst=/evidence`,
    // Image tags are mutable. Execute the immutable ID returned by the
    // immediately preceding inspection so a concurrent retag cannot swap the
    // verifier between validation and execution.
    verifierImage.imageId,
  ];
}

export async function verifyTerminalV7InContainer({
  mode,
  pack,
  phase = null,
  workspace,
  evidenceDirectory,
  seedKey = null,
  verifierSeedIndex = 0,
  contract = null,
  phaseContracts = null,
  phaseResults = null,
  expectedSourceSha256 = null,
  expectedImageId = null,
} = {}) {
  invariant(['phase', 'final'].includes(mode), 'V7 verifier container mode must be phase or final');
  if (mode === 'phase') invariant(Number.isSafeInteger(phase) && phase >= 1 && phase <= 5, 'V7 verifier container phase is invalid');
  invariant(pack?.challengeId === 'terminal-mini-ledger-v7', 'V7 verifier container pack is invalid');
  safeBindPath(workspace, 'V7 verifier workspace');
  safeBindPath(evidenceDirectory, 'V7 verifier evidence directory');
  const verifierImage = await inspectTerminalV7VerifierImage({ expectedSourceSha256, expectedImageId });
  const privateRoot = await mkdtemp(path.join(await realpath(os.tmpdir()), 'agentbattler-v7-verifier-input-'));
  const input = path.join(privateRoot, 'input');
  const output = path.join(privateRoot, 'output');
  try {
    await Promise.all([
      mkdir(input, { recursive: true, mode: 0o700 }),
      mkdir(output, { recursive: true, mode: 0o700 }),
      mkdir(evidenceDirectory, { recursive: true, mode: 0o700 }),
    ]);
    const request = {
      schemaVersion: 'agentbattler.terminal-v7-verifier-request.v1',
      mode,
      instanceId: pack.instanceId,
      variant: pack.variant,
      verifierSeedIndex,
      ...(mode === 'phase' ? { phase } : {}),
      ...(contract ? { contract } : {}),
      ...(phaseContracts ? { phaseContracts } : {}),
      ...(phaseResults ? { phaseResults } : {}),
    };
    await writeFile(path.join(input, 'request.json'), `${canonicalJson(request)}\n`, { mode: 0o600 });
    if (seedKey) await writeFile(path.join(input, 'seed-key'), `${seedKey}\n`, { mode: 0o600 });
    const args = terminalV7VerifierRunArguments({ verifierImage, workspace, input, output, evidenceDirectory });
    const result = await capture('docker', args, { timeoutMs: 30 * 60 * 1000 });
    invariant(result.code === 0 && !result.signal && !result.timedOut, `V7 verifier container failed: ${result.stderr.slice(-2000)}`);
    const wrapped = JSON.parse(await readFile(path.join(output, 'result.json'), 'utf8'));
    invariant(wrapped.schemaVersion === 'agentbattler.terminal-v7-verifier-container-result.v1', 'V7 verifier container result schema changed');
    invariant(/^0+$/.test(wrapped.candidateCapabilityMask ?? ''), 'V7 verifier candidate child did not prove zero capabilities');
    invariant(wrapped.candidateNativeBoundary === 'bubblewrap-v1', 'V7 verifier candidate child did not prove the native filesystem boundary');
    invariant(Array.isArray(wrapped.evaluation?.infrastructureErrors), 'V7 verifier result omitted infrastructure classification');
    const sourceBytes = Buffer.from(canonicalJson(wrapped));
    const sourceArtifact = { path: 'source.json', sizeBytes: sourceBytes.length, sha256: sha256(sourceBytes) };
    const artifact = sealTerminalV7VerifierEvaluationArtifact({
      phase: mode === 'phase' ? phase : null,
      source: 'sealed-linux-container',
      sourceArtifact,
      sourceArtifactSha256: sourceArtifact.sha256,
      evaluation: wrapped.evaluation,
      boundary: {
        modelCommandCapabilities: 'exactly-zero',
        capabilityMask: wrapped.candidateCapabilityMask,
        network: 'denied',
        candidateFilesystem: 'native-sandbox',
        nativeBoundary: wrapped.candidateNativeBoundary,
      },
    });
    await writeFile(path.join(evidenceDirectory, sourceArtifact.path), sourceBytes, { mode: 0o600, flag: 'wx' });
    await writeFile(path.join(evidenceDirectory, 'result.json'), `${canonicalJson(artifact, { space: 2 })}\n`, { mode: 0o600, flag: 'wx' });
    return wrapped.evaluation;
  } finally {
    await rm(privateRoot, { recursive: true, force: true });
  }
}
