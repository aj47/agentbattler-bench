import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { canonicalJson, canonicalJsonSha256, sha256File } from './provenance.mjs';

const execFileAsync = promisify(execFile);
const COMMIT_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MODEL_RE = /^[A-Za-z0-9,._-]{2,64}$/;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function commandText(command, args, { cwd = undefined } = {}) {
  const { stdout } = await execFileAsync(command, args, {
    ...(cwd ? { cwd } : {}),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

export function validateTerminalV7ExecutionHost(host) {
  invariant(host?.schemaVersion === 'agentbattler.terminal-v7-execution-host.v1', 'Unsupported V7 execution-host schema');
  const { identitySha256, ...unsigned } = host;
  invariant(identitySha256 === canonicalJsonSha256(unsigned), 'V7 execution-host identity hash mismatch');
  invariant(host.role === 'm4-pro-execution-host'
    && host.platform === 'darwin'
    && host.architecture === 'arm64'
    && host.chip === 'Apple M4 Pro'
    && MODEL_RE.test(host.modelIdentifier ?? ''), 'V7 execution host is not an Apple M4 Pro');
  invariant(!Object.keys(host).some((key) => /serial|uuid|hostname/i.test(key)), 'V7 execution-host evidence contains a unique machine identifier');
  return host;
}

export async function inspectTerminalV7ExecutionHost({
  platform = process.platform,
  architecture = process.arch,
  runCommand = commandText,
} = {}) {
  invariant(platform === 'darwin' && architecture === 'arm64', 'V7 execution requires Darwin arm64 hardware');
  const [chip, modelIdentifier] = await Promise.all([
    runCommand('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string']),
    runCommand('/usr/sbin/sysctl', ['-n', 'hw.model']),
  ]);
  const unsigned = {
    schemaVersion: 'agentbattler.terminal-v7-execution-host.v1',
    role: 'm4-pro-execution-host',
    platform,
    architecture,
    chip: String(chip).trim(),
    modelIdentifier: String(modelIdentifier).trim(),
  };
  return validateTerminalV7ExecutionHost({ ...unsigned, identitySha256: canonicalJsonSha256(unsigned) });
}

export async function inspectTerminalV7ExecutionSource({
  root,
  reviewedCommit,
  runCommand = commandText,
} = {}) {
  invariant(typeof root === 'string' && path.isAbsolute(root), 'V7 execution source root must be absolute');
  invariant(COMMIT_RE.test(reviewedCommit ?? ''), 'V7 execution reviewed commit is invalid');
  const [head, status, branch] = await Promise.all([
    runCommand('git', ['rev-parse', 'HEAD'], { cwd: root }),
    runCommand('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root }),
    runCommand('git', ['symbolic-ref', '-q', '--short', 'HEAD'], { cwd: root }).catch((error) => {
      if (error?.code === 1 || error?.exitCode === 1) return '';
      throw error;
    }),
  ]);
  invariant(head === reviewedCommit, 'V7 execution source is not the reviewed HEAD');
  invariant(status === '', 'V7 execution source tree is dirty');
  invariant(branch === '', 'V7 execution source must be a detached worktree');
  return { head, clean: true, detached: true };
}

export function validateTerminalV7ExecutionBinding(execution) {
  invariant(execution && typeof execution === 'object' && !Array.isArray(execution), 'V7 execution binding is missing');
  validateTerminalV7ExecutionHost(execution.executionHost);
  invariant(COMMIT_RE.test(execution.commitments?.reviewedCommit ?? ''), 'V7 execution binding omits the reviewed commit');
  const adapters = execution.adapters;
  invariant(adapters && typeof adapters === 'object' && !Array.isArray(adapters) && Object.keys(adapters).length > 0, 'V7 execution source closure is missing');
  const paths = new Set();
  for (const [name, descriptor] of Object.entries(adapters)) {
    invariant(descriptor && typeof descriptor === 'object' && SHA256_RE.test(descriptor.sha256 ?? ''), `V7 source commitment is invalid: ${name}`);
    invariant(typeof descriptor.path === 'string' && descriptor.path.length > 0 && !path.isAbsolute(descriptor.path) && !descriptor.path.includes('\0'), `V7 source commitment path is invalid: ${name}`);
    const normalized = path.posix.normalize(descriptor.path.replaceAll(path.sep, '/'));
    invariant(normalized !== '..' && !normalized.startsWith('../') && normalized === descriptor.path, `V7 source commitment path escapes or is not normalized: ${name}`);
    invariant(!paths.has(descriptor.path), `V7 source closure repeats ${descriptor.path}`);
    paths.add(descriptor.path);
  }
  invariant(execution.commitments.sourceSetSha256 === canonicalJsonSha256(adapters), 'V7 execution source-set commitment changed');
  return execution;
}

function safeSourcePath(root, relative) {
  invariant(typeof relative === 'string' && relative.length > 0 && !path.isAbsolute(relative) && !relative.includes('\0'), 'V7 source commitment path is invalid');
  const absolute = path.resolve(root, relative);
  const relation = path.relative(root, absolute);
  invariant(relation && relation !== '..' && !relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation), 'V7 source commitment escapes the execution checkout');
  return absolute;
}

export async function assertTerminalV7ExecutionIdentity({
  root,
  challenge,
  inspectHost = inspectTerminalV7ExecutionHost,
  inspectSource = inspectTerminalV7ExecutionSource,
} = {}) {
  invariant(typeof root === 'string' && path.isAbsolute(root), 'V7 execution repository root must be absolute');
  validateTerminalV7ExecutionBinding(challenge?.execution);
  const expectedHost = challenge.execution.executionHost;
  const reviewedCommit = challenge.execution.commitments.reviewedCommit;
  const adapters = challenge.execution.adapters;
  const observedPaths = new Set();
  for (const [name, descriptor] of Object.entries(adapters)) {
    invariant(descriptor && typeof descriptor === 'object' && SHA256_RE.test(descriptor.sha256 ?? ''), `V7 source commitment is invalid: ${name}`);
    invariant(!observedPaths.has(descriptor.path), `V7 source closure repeats ${descriptor.path}`);
    observedPaths.add(descriptor.path);
    invariant(await sha256File(safeSourcePath(root, descriptor.path)) === descriptor.sha256, `V7 execution source does not match its challenge commitment: ${name}`);
  }
  invariant(challenge.execution.commitments.sourceSetSha256 === canonicalJsonSha256(adapters), 'V7 execution source-set commitment changed');
  const [host, source] = await Promise.all([
    inspectHost(),
    inspectSource({ root, reviewedCommit }),
  ]);
  invariant(canonicalJson(host) === canonicalJson(expectedHost), 'V7 execution host differs from the preflight-bound Apple M4 Pro identity');
  return { host, source, sourceSetSha256: challenge.execution.commitments.sourceSetSha256 };
}
