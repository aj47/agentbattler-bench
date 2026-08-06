import { createReadStream } from 'node:fs';
import { access, opendir } from 'node:fs/promises';
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

async function* regularFiles(directory) {
  const entries = await opendir(directory);
  for await (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* regularFiles(entryPath);
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
