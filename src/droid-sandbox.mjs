import { createReadStream } from 'node:fs';
import { access, opendir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sbplString(value) {
  return JSON.stringify(value);
}

export function isolatedDroidEnvironment(home, temporaryDirectory, { executablePaths = [process.execPath], environment = process.env } = {}) {
  for (const [label, value] of Object.entries({ home, temporaryDirectory })) {
    invariant(typeof value === 'string' && path.isAbsolute(value), `${label} must be an absolute path`);
  }
  invariant(Array.isArray(executablePaths) && executablePaths.every((value) => typeof value === 'string' && path.isAbsolute(value)), 'executablePaths must contain absolute paths');
  const runtimePath = [...new Set([...executablePaths.map((value) => path.dirname(value)), '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(path.delimiter);
  const keep = ['LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'SHELL'];
  return {
    ...Object.fromEntries(keep.flatMap((key) => typeof environment[key] === 'string' ? [[key, environment[key]]] : [])),
    PATH: runtimePath,
    HOME: home,
    TMPDIR: temporaryDirectory,
    NO_COLOR: '1',
  };
}

async function fileContainsLiteral(filePath, literal) {
  const needle = Buffer.from(literal);
  let tail = Buffer.alloc(0);
  for await (const chunk of createReadStream(filePath)) {
    const candidate = tail.length === 0 ? chunk : Buffer.concat([tail, chunk]);
    if (candidate.includes(needle)) return true;
    tail = candidate.subarray(Math.max(0, candidate.length - needle.length + 1));
  }
  return false;
}

export async function openDroidCredentialDirectory(directory, { allowMissing = false } = {}) {
  try {
    return await opendir(directory);
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function* regularFiles(directory, { allowMissing = false } = {}) {
  const entries = await openDroidCredentialDirectory(directory, { allowMissing });
  if (!entries) return;
  for await (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    // Droid creates and removes session lock directories while its process is
    // live. A child that disappears after readdir but before opendir contains
    // no credential residue to inspect; the stable scan root must still exist.
    if (entry.isDirectory()) yield* regularFiles(entryPath, { allowMissing: true });
    else if (entry.isFile()) yield entryPath;
  }
}

export async function assertDroidCredentialAbsent({ runDirectory, apiKey }) {
  invariant(typeof runDirectory === 'string' && path.isAbsolute(runDirectory), 'Droid run directory must be absolute');
  invariant(typeof apiKey === 'string' && apiKey.length > 0, 'Droid API key is required');
  let filesScanned = 0;
  for await (const filePath of regularFiles(runDirectory)) {
    filesScanned += 1;
    invariant(!await fileContainsLiteral(filePath, apiKey), `Droid credential residue found in ${path.relative(runDirectory, filePath)}`);
  }
  return { filesScanned };
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isTransientDroidSettings(relativePath) {
  return /^settings\.json\.tmp-[^/]+$/.test(relativePath);
}

export async function retireDroidCredentialSettings({
  factoryHome,
  apiKey,
  timeoutMs = 5_000,
  quietMs = 500,
  pollMs = 25,
} = {}) {
  invariant(typeof factoryHome === 'string' && path.isAbsolute(factoryHome), 'Droid Factory home must be absolute');
  invariant(typeof apiKey === 'string' && apiKey.length > 0, 'Droid API key is required');
  invariant(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, 'Droid credential retirement timeout must be positive');
  invariant(Number.isSafeInteger(quietMs) && quietMs >= 0 && quietMs < timeoutMs, 'Droid credential retirement quiet period must be non-negative and shorter than its timeout');
  invariant(Number.isSafeInteger(pollMs) && pollMs > 0 && pollMs <= timeoutMs, 'Droid credential retirement poll interval must be positive');

  const startedAt = Date.now();
  let quietSince = null;
  let filesScanned = 0;
  let settingsFilesRemoved = 0;
  let transientObservations = 0;
  while (Date.now() - startedAt < timeoutMs) {
    const residue = [];
    filesScanned = 0;
    for await (const filePath of regularFiles(factoryHome)) {
      filesScanned += 1;
      try {
        if (await fileContainsLiteral(filePath, apiKey)) residue.push(filePath);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    const relativeResidue = residue.map((filePath) => path.relative(factoryHome, filePath));
    const unexpected = relativeResidue.filter((relativePath) => relativePath !== 'settings.json' && !isTransientDroidSettings(relativePath));
    invariant(unexpected.length === 0, `Droid credential escaped its transient settings boundary: ${unexpected.join(', ')}`);

    const transient = relativeResidue.filter(isTransientDroidSettings);
    if (transient.length > 0) {
      // Droid writes settings atomically. Let an in-flight writer finish instead
      // of unlinking its open temporary file and racing a later rename.
      transientObservations += transient.length;
      quietSince = null;
    } else if (relativeResidue.includes('settings.json')) {
      await rm(path.join(factoryHome, 'settings.json'), { force: true });
      settingsFilesRemoved += 1;
      quietSince = null;
    } else {
      quietSince ??= Date.now();
      if (Date.now() - quietSince >= quietMs) {
        return { filesScanned, settingsFilesRemoved, transientObservations, quietMs };
      }
    }
    await wait(pollMs);
  }
  throw new Error(`Droid credential settings did not settle within ${timeoutMs} ms`);
}

export function createDroidSandboxProfile({
  runDirectory,
  binaryPath,
  allowedReadPaths = [process.execPath],
  networkPort = null,
  userHome = os.homedir(),
  temporaryRoots = [os.tmpdir(), '/tmp', '/private/tmp', '/var/tmp'],
} = {}) {
  for (const [label, value] of Object.entries({ runDirectory, binaryPath, userHome })) {
    invariant(typeof value === 'string' && path.isAbsolute(value), `${label} must be an absolute path`);
  }
  invariant(Array.isArray(temporaryRoots) && temporaryRoots.every((value) => typeof value === 'string' && path.isAbsolute(value)), 'temporaryRoots must contain absolute paths');
  invariant(Array.isArray(allowedReadPaths) && allowedReadPaths.every((value) => typeof value === 'string' && path.isAbsolute(value)), 'allowedReadPaths must contain absolute paths');
  invariant(networkPort === null || Number.isSafeInteger(networkPort) && networkPort > 0 && networkPort <= 65_535, 'networkPort must be null or a valid TCP port');
  const relativeRun = path.relative(userHome, runDirectory);
  invariant(relativeRun && relativeRun !== '..' && !relativeRun.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeRun), 'Droid run directory must be inside the denied user home');
  const deniedRoots = [...new Set([userHome, ...temporaryRoots.flatMap((root) => root.startsWith('/var/') ? [root, `/private${root}`] : [root])])];
  return `(version 1)
; The model-facing process may use the OS and network, but cannot read or
; write user-home or shared temporary data except its sealed run directory.
(allow default)
${deniedRoots.map((root) => `(deny file-read* file-write* (subpath ${sbplString(root)}))`).join('\n')}
(allow file-read* (literal ${sbplString(binaryPath)}))
${[...new Set(allowedReadPaths)].map((runtimePath) => `(allow file-read* (literal ${sbplString(runtimePath)}))`).join('\n')}
(allow file-read* file-write* (subpath ${sbplString(runDirectory)}))
${networkPort === null ? '' : `(deny network*)
(allow network-outbound (remote ip "localhost:${networkPort}"))`}
`;
}

export async function requireDroidSandboxRuntime() {
  invariant(process.platform === 'darwin', 'V6 Droid requires the macOS sandbox-exec runtime');
  const binary = '/usr/bin/sandbox-exec';
  try { await access(binary); } catch { throw new Error('V6 Droid requires /usr/bin/sandbox-exec'); }
  return binary;
}

export function droidSandboxLauncher({ sandboxBinary = '/usr/bin/sandbox-exec', profilePath, droidBinary, allowedReadPaths = [process.execPath] }) {
  for (const [label, value] of Object.entries({ sandboxBinary, profilePath, droidBinary })) {
    invariant(typeof value === 'string' && path.isAbsolute(value), `${label} must be an absolute path`);
  }
  invariant(Array.isArray(allowedReadPaths) && allowedReadPaths.every((value) => typeof value === 'string' && path.isAbsolute(value)), 'allowedReadPaths must contain absolute paths');
  return {
    command: sandboxBinary,
    argsPrefix: ['-f', profilePath, droidBinary],
    policy: {
      name: 'macos-sandbox-exec',
      version: 1,
      defaultAccess: 'allowed-outside-denied-roots',
      userHome: 'denied',
      sharedTemporaryStorage: 'denied',
      runDirectory: 'read-write',
      droidBinary: 'read-execute',
      runtimeReadExecutableCount: new Set(allowedReadPaths).size,
      network: 'loopback-router-only',
    },
  };
}
