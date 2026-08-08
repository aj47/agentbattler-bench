import { execFile } from 'node:child_process';
import { createReadStream, realpathSync } from 'node:fs';
import { access, opendir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sbplString(value) {
  return JSON.stringify(value);
}

function sbplPathRegex(values) {
  const patterns = [...new Set(values)].map((value) => `(string-append "^" (regex-quote ${sbplString(value)}) #"(/|$)")`);
  return `(regex ${patterns.join(' ')})`;
}

function sbplProcessPath(values) {
  const filters = [...new Set(values)].map((value) => `(process-path ${sbplString(value)})`);
  return filters.length === 1 ? filters[0] : `(require-any ${filters.join(' ')})`;
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
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

export function isolatedDroidV7Environment(home, temporaryDirectory, { executablePaths = [process.execPath] } = {}) {
  for (const [label, value] of Object.entries({ home, temporaryDirectory })) {
    invariant(typeof value === 'string' && path.isAbsolute(value), `${label} must be an absolute path`);
  }
  invariant(Array.isArray(executablePaths) && executablePaths.every((value) => typeof value === 'string' && path.isAbsolute(value)), 'executablePaths must contain absolute paths');
  const runtimePath = [...new Set([...executablePaths.map((value) => path.dirname(value)), '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(path.delimiter);
  // macOS children can enumerate their environment. This contains no host or
  // provider values; HOME/TMPDIR are ephemeral inaccessible parent paths.
  // launchd/sandbox-exec adds __CF_USER_TEXT_ENCODING at exec time; preflight
  // treats that OS-supplied UID/encoding tuple as non-secret platform metadata
  // and records only a normalized placeholder for its value.
  return Object.freeze({
    PATH: runtimePath,
    HOME: home,
    TMPDIR: temporaryDirectory,
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
    NO_COLOR: '1',
  });
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

function parseOtoolDependencies(output) {
  return output.split(/\r?\n/).slice(1).map((line) => line.trim().split(/\s+\(/, 1)[0]).filter(Boolean);
}

function dependencyCandidate(value, { executablePath, loaderPath }) {
  if (value.startsWith('@loader_path/')) return path.join(path.dirname(loaderPath), value.slice('@loader_path/'.length));
  if (value.startsWith('@executable_path/')) return path.join(path.dirname(executablePath), value.slice('@executable_path/'.length));
  if (value.startsWith('@rpath/')) {
    const relative = value.slice('@rpath/'.length);
    return path.join(path.dirname(executablePath), '..', 'lib', relative);
  }
  return path.isAbsolute(value) ? value : null;
}

export async function resolveDroidV7RuntimeReadPaths(executablePaths = [process.execPath]) {
  invariant(Array.isArray(executablePaths) && executablePaths.length > 0 && executablePaths.every((value) => typeof value === 'string' && path.isAbsolute(value)), 'V7 Droid executable paths must be absolute');
  const executablePath = await realpath(executablePaths[0]);
  const queue = [...new Set(await Promise.all(executablePaths.map((value) => realpath(value))))];
  const observed = new Set();
  const allowedFiles = new Set(queue);
  while (queue.length > 0) {
    const current = queue.shift();
    if (observed.has(current)) continue;
    observed.add(current);
    const inspection = await execFileAsync('/usr/bin/otool', ['-L', current], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    for (const dependency of parseOtoolDependencies(inspection.stdout)) {
      const candidate = dependencyCandidate(dependency, { executablePath, loaderPath: current });
      if (!candidate || candidate.startsWith('/System/') || candidate.startsWith('/usr/lib/')) continue;
      allowedFiles.add(candidate);
      let resolved;
      try { resolved = await realpath(candidate); } catch { continue; }
      allowedFiles.add(resolved);
      if (!observed.has(resolved)) queue.push(resolved);
    }
  }
  for (const staticRuntimeFile of [
    '/opt/homebrew/etc/openssl@3/openssl.cnf',
    '/var/db/timezone/zoneinfo/UTC',
    '/var/db/timezone/zoneinfo/posixrules',
    '/var/db/timezone/icutz/icutz44l.dat',
  ]) {
    try { allowedFiles.add(await realpath(staticRuntimeFile)); } catch { /* Another sealed Node runtime may not use Homebrew OpenSSL. */ }
  }
  const externalFiles = [...allowedFiles].filter((value) => !value.startsWith('/System/') && !value.startsWith('/usr/lib/')).sort();
  const runtimeRoots = [...new Set(externalFiles.filter((value) => (
    !value.startsWith('/opt/homebrew/etc/')
    && !value.startsWith('/private/var/db/timezone/')
  )).map((value) => {
    const homebrewOpt = value.match(/^(\/opt\/homebrew\/opt\/[^/]+)(?:\/|$)/);
    return homebrewOpt?.[1] ?? path.dirname(value);
  }))].sort();
  return Object.freeze({ executablePath, files: Object.freeze(externalFiles), roots: Object.freeze(runtimeRoots) });
}

export function createDroidV7SandboxProfile({
  runDirectory,
  workspace,
  binaryPath,
  runtimeReadPaths,
  networkPort,
  controlRoot = path.join(workspace ?? '', '.agentbattler'),
} = {}) {
  for (const [label, value] of Object.entries({ runDirectory, workspace, binaryPath, controlRoot })) {
    invariant(typeof value === 'string' && path.isAbsolute(value), `${label} must be an absolute path`);
  }
  invariant(inside(runDirectory, workspace), 'V7 Droid workspace must be inside its run directory');
  invariant(inside(workspace, controlRoot), 'V7 Droid control root must be inside its workspace');
  invariant(Array.isArray(runtimeReadPaths?.files) && runtimeReadPaths.files.length > 0
    && runtimeReadPaths.files.every((value) => typeof value === 'string' && path.isAbsolute(value)), 'V7 Droid runtime files must be absolute');
  invariant(Array.isArray(runtimeReadPaths?.roots) && runtimeReadPaths.roots.length > 0
    && runtimeReadPaths.roots.every((value) => typeof value === 'string' && path.isAbsolute(value)), 'V7 Droid runtime roots must be absolute');
  invariant(Number.isSafeInteger(networkPort) && networkPort > 0 && networkPort <= 65_535, 'V7 Droid networkPort must be a valid TCP port');
  // sandbox-exec compares the kernel-canonical name. In particular, macOS
  // reports temporary paths as `/var/...` while the VFS resolves them through
  // `/private/var/...`; seal the existing roots under their canonical names so
  // the workspace exception cannot silently miss on either spelling.
  const sealedRunDirectory = realpathSync(runDirectory);
  const sealedWorkspace = realpathSync(workspace);
  const sealedBinaryPath = realpathSync(binaryPath);
  const sealedControlRoot = path.join(sealedWorkspace, path.relative(workspace, controlRoot));
  invariant(inside(sealedRunDirectory, sealedWorkspace) && inside(sealedWorkspace, sealedControlRoot), 'V7 Droid canonical paths escaped their declared boundaries');
  // `subpath` resolves only existing path components. Regex filters are also
  // required here so file-write-create is recognized before its target exists.
  const runFilter = sbplPathRegex([runDirectory, sealedRunDirectory]);
  const workspaceFilter = sbplPathRegex([workspace, sealedWorkspace]);
  const controlFilter = sbplPathRegex([controlRoot, sealedControlRoot]);
  const droidProcessFilter = sbplProcessPath([binaryPath, sealedBinaryPath]);
  const droidBinaryLiterals = [...new Set([binaryPath, sealedBinaryPath])].map((value) => `(literal ${sbplString(value)})`);
  const droidBinaryFilter = droidBinaryLiterals.length === 1 ? droidBinaryLiterals[0] : `(require-any ${droidBinaryLiterals.join(' ')})`;
  // `/usr/local` is a mutable, administrator-controlled tree on macOS. Do not
  // inherit it through a broad `/usr` exception; expose only the sealed system
  // runtime subtrees and separately resolved executable roots above.
  const runtimeSystemRoots = [
    '/System',
    '/usr/bin',
    '/usr/lib',
    '/usr/libexec',
    '/usr/sbin',
    '/usr/share',
    '/bin',
    '/sbin',
    '/Library/Apple',
  ];
  const staticSystemFiles = ['/private/etc/passwd', '/private/etc/group', '/private/etc/ssl/openssl.cnf'];
  return `(version 1)
; V7 keeps the provider-bearing Droid process separate from model commands.
; The parent alone may read private run state and reach the authenticated
; loopback router; child tools receive only runtime files and the workspace.
(allow default)
(deny process-exec (literal "/usr/bin/sandbox-exec"))
(deny process-exec (require-all ${droidBinaryFilter} (require-not (process-path "/usr/bin/sandbox-exec"))))
(deny file-read*)
(allow file-read-metadata)
(deny file-write* (literal "/"))
(deny file-write* (require-not ${runFilter}))
(deny file-write* (require-all ${runFilter} (require-not ${workspaceFilter}) (require-not ${droidProcessFilter})))
(allow file-read* (literal "/"))
${runtimeSystemRoots.map((root) => `(allow file-read* (subpath ${sbplString(root)}))`).join('\n')}
${staticSystemFiles.map((file) => `(allow file-read* (literal ${sbplString(file)}))`).join('\n')}
${[...new Set(runtimeReadPaths.roots)].map((root) => `(allow file-read* (subpath ${sbplString(root)}))`).join('\n')}
${[...new Set([binaryPath, sealedBinaryPath, ...runtimeReadPaths.files])].map((file) => `(allow file-read* (literal ${sbplString(file)}))`).join('\n')}
(allow file-read* file-write* (subpath "/dev"))
(allow file-read* file-write* (require-all ${runFilter} ${droidProcessFilter}))
(allow file-read* file-write* ${workspaceFilter})
(deny file-write* ${controlFilter})
(deny network*)
(allow network-outbound (require-all (remote ip ${sbplString(`localhost:${networkPort}`)}) ${droidProcessFilter}))
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

export function droidV7SandboxLauncher({ sandboxBinary = '/usr/bin/sandbox-exec', profilePath, droidBinary, runtimeReadPaths }) {
  for (const [label, value] of Object.entries({ sandboxBinary, profilePath, droidBinary })) {
    invariant(typeof value === 'string' && path.isAbsolute(value), `${label} must be an absolute path`);
  }
  invariant(Array.isArray(runtimeReadPaths?.files) && runtimeReadPaths.files.length > 0, 'V7 Droid launcher requires its runtime read set');
  return {
    command: sandboxBinary,
    argsPrefix: ['-f', profilePath, droidBinary],
    policy: {
      name: 'macos-sandbox-exec-v7-process-separated',
      version: 1,
      defaultFilesystemAccess: 'denied',
      modelCommandFilesystem: 'runtime-and-workspace-only',
      outOfWorkspaceFileContents: 'denied',
      outOfWorkspaceDirectoryEnumeration: 'denied-except-root-and-declared-runtime-roots',
      rootDirectoryEnumeration: 'observable-macos-runtime-requirement',
      outOfWorkspaceExactPathMetadata: 'observable-macos-sandbox-exec-limitation',
      parentPrivateRunState: 'droid-binary-only',
      controlRoot: 'read-only',
      runtimeReadFileCount: new Set(runtimeReadPaths.files).size,
      runtimeReadRootCount: new Set(runtimeReadPaths.roots).size,
      network: 'loopback-router-droid-binary-only-model-children-denied',
      environment: 'fixed-minimal-non-secret-values-only',
    },
  };
}
