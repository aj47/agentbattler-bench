import { access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sbplString(value) {
  return JSON.stringify(value);
}

export function createDroidSandboxProfile({
  runDirectory,
  binaryPath,
  userHome = os.homedir(),
  temporaryRoots = [os.tmpdir(), '/tmp', '/private/tmp', '/var/tmp'],
} = {}) {
  for (const [label, value] of Object.entries({ runDirectory, binaryPath, userHome })) {
    invariant(typeof value === 'string' && path.isAbsolute(value), `${label} must be an absolute path`);
  }
  invariant(Array.isArray(temporaryRoots) && temporaryRoots.every((value) => typeof value === 'string' && path.isAbsolute(value)), 'temporaryRoots must contain absolute paths');
  const relativeRun = path.relative(userHome, runDirectory);
  invariant(relativeRun && relativeRun !== '..' && !relativeRun.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeRun), 'Droid run directory must be inside the denied user home');
  const deniedRoots = [...new Set([userHome, ...temporaryRoots.flatMap((root) => root.startsWith('/var/') ? [root, `/private${root}`] : [root])])];
  return `(version 1)
; The model-facing process may use the OS and network, but cannot read or
; write user-home or shared temporary data except its sealed run directory.
(allow default)
${deniedRoots.map((root) => `(deny file-read* file-write* (subpath ${sbplString(root)}))`).join('\n')}
(allow file-read* (literal ${sbplString(binaryPath)}))
(allow file-read* file-write* (subpath ${sbplString(runDirectory)}))
`;
}

export async function requireDroidSandboxRuntime() {
  invariant(process.platform === 'darwin', 'V6 Droid requires the macOS sandbox-exec runtime');
  const binary = '/usr/bin/sandbox-exec';
  try { await access(binary); } catch { throw new Error('V6 Droid requires /usr/bin/sandbox-exec'); }
  return binary;
}

export function droidSandboxLauncher({ sandboxBinary = '/usr/bin/sandbox-exec', profilePath, droidBinary }) {
  for (const [label, value] of Object.entries({ sandboxBinary, profilePath, droidBinary })) {
    invariant(typeof value === 'string' && path.isAbsolute(value), `${label} must be an absolute path`);
  }
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
    },
  };
}
