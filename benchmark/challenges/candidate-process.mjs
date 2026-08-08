import { chmod, chown, copyFile, lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const CLEANUP_RETRY_CODES = new Set(['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM']);
export const CANDIDATE_NODE_OPTIONS = '--permission --allow-fs-read=. --allow-fs-write=.';
export const CANDIDATE_NATIVE_SANDBOX = 'bubblewrap-v1';

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function candidateIdentity() {
  const rawUid = process.env.AGENTBATTLER_CANDIDATE_UID;
  if (rawUid === undefined) return null;
  const uid = Number(rawUid);
  const gid = Number(process.env.AGENTBATTLER_CANDIDATE_GID ?? rawUid);
  if (!Number.isSafeInteger(uid) || uid < 1 || !Number.isSafeInteger(gid) || gid < 1) {
    throw new Error('Candidate UID/GID must be positive integers');
  }
  return { uid, gid };
}

export function candidateSpawnOptions() {
  return {
    ...(candidateIdentity() ?? {}),
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      LANG: 'C',
      LC_ALL: 'C',
      NODE_OPTIONS: CANDIDATE_NODE_OPTIONS,
    },
  };
}

function mapIntoCandidateWorkspace(value, workspace) {
  if (typeof value !== 'string') return value;
  const absoluteWorkspace = path.resolve(workspace);
  const resolved = path.resolve(value);
  const relation = path.relative(absoluteWorkspace, resolved);
  if (relation === '') return '/workspace';
  if (!relation.startsWith(`..${path.sep}`) && relation !== '..' && !path.isAbsolute(relation)) {
    return path.posix.join('/workspace', ...relation.split(path.sep));
  }
  return value;
}

export function candidateNativeSandboxCommand({ workspace, executable, args = [] } = {}) {
  if (process.env.AGENTBATTLER_CANDIDATE_NATIVE_SANDBOX !== CANDIDATE_NATIVE_SANDBOX) {
    return {
      command: executable,
      args,
      options: { cwd: workspace, ...candidateSpawnOptions() },
      nativeBoundary: false,
    };
  }
  if (process.platform !== 'linux') throw new Error('The V7 candidate native sandbox requires Linux');
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace) || workspace.includes('\0')) {
    throw new Error('Candidate native sandbox workspace must be an absolute path');
  }
  if (typeof executable !== 'string' || !path.isAbsolute(executable) || executable.includes('\0')) {
    throw new Error('Candidate native sandbox executable must be an absolute path');
  }
  const identity = candidateIdentity();
  if (!identity) throw new Error('Candidate native sandbox requires an explicit UID/GID');
  const mappedArgs = args.map((value) => mapIntoCandidateWorkspace(value, workspace));
  return {
    command: '/usr/bin/bwrap',
    args: [
      '--unshare-all',
      '--die-with-parent',
      '--new-session',
      '--clearenv',
      '--ro-bind', '/usr', '/usr',
      '--ro-bind-try', '/bin', '/bin',
      '--ro-bind-try', '/lib', '/lib',
      '--ro-bind-try', '/lib64', '/lib64',
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--dir', '/home',
      '--dir', '/home/candidate',
      '--bind', path.resolve(workspace), '/workspace',
      '--chdir', '/workspace',
      '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin',
      '--setenv', 'LANG', 'C',
      '--setenv', 'LC_ALL', 'C',
      '--setenv', 'NODE_OPTIONS', CANDIDATE_NODE_OPTIONS,
      '--uid', String(identity.uid),
      '--gid', String(identity.gid),
      '--cap-drop', 'ALL',
      '/usr/local/bin/agentbattler-v7-candidate-guard',
      executable,
      ...mappedArgs,
    ],
    options: {
      cwd: '/',
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    },
    nativeBoundary: true,
  };
}

async function giveToCandidate(target, mode) {
  const identity = candidateIdentity();
  if (identity) await chown(target, identity.uid, identity.gid);
  await chmod(target, mode);
}

export async function candidateOwnedDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o770 });
  await giveToCandidate(directory, 0o770);
  return directory;
}

export async function candidateOwnedFile(file, mode = 0o660) {
  await giveToCandidate(file, mode);
  return file;
}

export async function copyCandidateFile(source, destination, mode = 0o660) {
  const sourceStat = await lstat(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error(`Candidate source must be a regular file: ${source}`);
  await candidateOwnedDirectory(path.dirname(destination));
  await copyFile(source, destination);
  await candidateOwnedFile(destination, mode);
  return destination;
}

export async function createCandidateSubdirectory(parent, name) {
  const directory = path.join(parent, name);
  await rm(directory, { recursive: true, force: true });
  return candidateOwnedDirectory(directory);
}

export async function removeCandidateWorkspace(directory, {
  attempts = 8,
  retryDelayMs = 50,
  remove = rm,
  warn = (message) => process.emitWarning(message),
} = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await remove(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: retryDelayMs });
      return true;
    } catch (error) {
      lastError = error;
      if (!CLEANUP_RETRY_CODES.has(error?.code) || attempt === attempts) break;
      await delay(retryDelayMs * attempt);
    }
  }
  // Cleanup is housekeeping after the verifier has already produced its
  // result. Preserve that result and report the orphan separately instead of
  // turning a model outcome into an infrastructure-invalid benchmark record.
  warn(`Candidate workspace cleanup deferred for ${directory}: ${lastError?.message ?? lastError}`);
  return false;
}

export async function withCandidateWorkspace(sourceLedger, label, callback, cleanupOptions = {}) {
  const sourceStat = await lstat(sourceLedger);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error('ledger.mjs must be a regular source file');
  // macOS exposes the same temp root as both /var/... and /private/var/....
  // Canonicalize it before Node resolves the candidate entry point so the
  // workspace-only permission grant is checked against one stable path.
  const workspace = await mkdtemp(path.join(await realpath(os.tmpdir()), `agentbattler-${label}-`));
  const ledgerPath = path.join(workspace, 'ledger.mjs');
  try {
    await candidateOwnedDirectory(workspace);
    await copyCandidateFile(sourceLedger, ledgerPath, 0o750);
    return await callback({ workspace, ledgerPath });
  } finally {
    await removeCandidateWorkspace(workspace, cleanupOptions);
  }
}
