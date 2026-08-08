import { spawn } from 'node:child_process';
import { lstat, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJsonSha256, sha256File } from './provenance.mjs';

export const TERMINAL_V7_HARBOR_CONTEXT_LABEL = 'org.agentbattler.v7.context-sha256';
export const TERMINAL_V7_HARBOR_UNBOUND_IMAGE_ID = `sha256:${'0'.repeat(64)}`;

const IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/;
const TASK_IMAGE_SECTIONS = Object.freeze({
  environment: 'environment',
  verifier: 'verifier.environment',
});

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function safeRoot(value, label) {
  invariant(typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0'), `${label} must be an absolute path`);
  return path.resolve(value);
}

async function records(root, relative = '') {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const output = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = relative ? path.posix.join(relative, entry.name) : entry.name;
    const absolute = path.join(root, ...child.split('/'));
    const stat = await lstat(absolute);
    invariant(!stat.isSymbolicLink(), `V7 Harbor image context contains a symlink: ${child}`);
    if (stat.isDirectory()) output.push(...await records(root, child));
    else {
      invariant(stat.isFile() && stat.nlink === 1, `V7 Harbor image context contains a non-regular or hardlinked entry: ${child}`);
      output.push({ path: child, sha256: await sha256File(absolute) });
    }
  }
  return output;
}

async function taskRecords(root, relative = '') {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const output = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = relative ? path.posix.join(relative, entry.name) : entry.name;
    const absolute = path.join(root, ...child.split('/'));
    const stat = await lstat(absolute);
    invariant(!stat.isSymbolicLink(), `V7 Harbor task contains a symlink: ${child}`);
    if (stat.isDirectory()) output.push(...await taskRecords(root, child));
    else {
      invariant(stat.isFile() && stat.nlink === 1, `V7 Harbor task contains a non-regular or hardlinked entry: ${child}`);
      output.push({ path: child, sha256: await sha256File(absolute) });
    }
  }
  return output;
}

export async function terminalV7HarborTaskTreeIdentity({ taskRoot } = {}) {
  const root = safeRoot(taskRoot, 'V7 Harbor task root');
  const files = await taskRecords(root);
  return Object.freeze({ sha256: canonicalJsonSha256(files), fileCount: files.length });
}

function parseTomlString(value, label) {
  try {
    const parsed = JSON.parse(value);
    invariant(typeof parsed === 'string' && parsed.length > 0, `${label} must be a non-empty TOML string`);
    return parsed;
  } catch (error) {
    if (error?.message?.startsWith(label)) throw error;
    throw new Error(`${label} is not a canonical TOML string`);
  }
}

function taskImageReferenceLocations(source) {
  invariant(typeof source === 'string' && source.length > 0, 'V7 Harbor task TOML is empty');
  const lines = source.split('\n');
  const locations = {};
  let section = null;
  let dockerImageCount = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const sectionMatch = lines[index].match(/^\[([^\]]+)\]$/);
    if (sectionMatch) section = sectionMatch[1];
    const imageMatch = lines[index].match(/^docker_image = (.+)$/);
    if (!imageMatch) continue;
    dockerImageCount += 1;
    const kind = Object.entries(TASK_IMAGE_SECTIONS).find(([, expectedSection]) => section === expectedSection)?.[0];
    invariant(kind && !locations[kind], `V7 Harbor task has an unexpected or duplicate docker_image in [${section ?? 'unknown'}]`);
    locations[kind] = {
      index,
      reference: parseTomlString(imageMatch[1], `V7 Harbor ${kind} docker_image`),
    };
  }
  invariant(dockerImageCount === 2 && Object.keys(locations).length === 2, 'V7 Harbor task must declare exactly one environment and verifier docker_image');
  return { lines, locations };
}

async function assertSafeTaskToml(root) {
  const taskFile = path.join(root, 'task.toml');
  const stat = await lstat(taskFile);
  invariant(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'V7 Harbor task TOML is not one safe regular file');
  return taskFile;
}

export async function terminalV7HarborTaskImageReferences({ taskRoot } = {}) {
  const root = safeRoot(taskRoot, 'V7 Harbor task root');
  const source = await readFile(await assertSafeTaskToml(root), 'utf8');
  const { locations } = taskImageReferenceLocations(source);
  return Object.freeze(Object.fromEntries(Object.entries(locations).map(([kind, { reference }]) => [kind, reference])));
}

function validateBoundImages(images) {
  invariant(images && typeof images === 'object' && !Array.isArray(images), 'V7 Harbor inspected image bindings are missing');
  for (const kind of ['environment', 'verifier']) {
    const descriptor = images[kind];
    invariant(descriptor?.kind === kind && IMAGE_ID_RE.test(descriptor.imageId ?? ''), `V7 Harbor ${kind} inspected image ID is invalid`);
    invariant(typeof descriptor.image === 'string' && descriptor.image.length > 0 && /^[0-9a-f]{64}$/.test(descriptor.sourceSha256 ?? ''), `V7 Harbor ${kind} source identity is invalid`);
  }
  invariant(images.environment.imageId !== images.verifier.imageId, 'V7 Harbor candidate and verifier images must have distinct immutable IDs');
}

export async function bindTerminalV7HarborTaskImageReferences({ taskRoot, images } = {}) {
  const root = safeRoot(taskRoot, 'V7 Harbor task root');
  validateBoundImages(images);
  const taskFile = await assertSafeTaskToml(root);
  const source = await readFile(taskFile, 'utf8');
  const { lines, locations } = taskImageReferenceLocations(source);
  for (const kind of ['environment', 'verifier']) {
    const current = locations[kind].reference;
    invariant(current === TERMINAL_V7_HARBOR_UNBOUND_IMAGE_ID || current === images[kind].imageId, `V7 Harbor ${kind} task image reference was substituted before immutable binding`);
    lines[locations[kind].index] = `docker_image = ${JSON.stringify(images[kind].imageId)}`;
  }
  const output = lines.join('\n');
  const temporary = `${taskFile}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, output, { mode: 0o600, flag: 'wx' });
    await rename(temporary, taskFile);
  } finally {
    await rm(temporary, { force: true });
  }
  return assertTerminalV7HarborTaskImageReferences({ taskRoot: root, expected: images });
}

export async function assertTerminalV7HarborTaskImageReferences({ taskRoot, expected } = {}) {
  validateBoundImages(expected);
  const references = await terminalV7HarborTaskImageReferences({ taskRoot });
  for (const kind of ['environment', 'verifier']) {
    invariant(references[kind] === expected[kind].imageId, `V7 Harbor ${kind} task must execute the exact sealed image ID`);
    invariant(references[kind] !== expected[kind].image, `V7 Harbor ${kind} task may not execute a mutable tag`);
  }
  return references;
}

async function descriptorAt(contextRoot, kind) {
  const stat = await lstat(contextRoot);
  invariant(stat.isDirectory() && !stat.isSymbolicLink(), `V7 Harbor ${kind} context is not a safe directory`);
  const files = await records(contextRoot);
  invariant(files.some(({ path: relative }) => relative === 'Dockerfile'), `V7 Harbor ${kind} context has no Dockerfile`);
  const sourceSha256 = canonicalJsonSha256(files);
  return {
    schemaVersion: 'agentbattler.terminal-v7-harbor-image-source.v1',
    kind,
    contextRoot,
    fileCount: files.length,
    files,
    sourceSha256,
    image: `agentbattler-v7-harbor-${kind}:${sourceSha256.slice(0, 24)}`,
  };
}

async function contextDescriptor(taskRoot, kind) {
  invariant(['environment', 'verifier'].includes(kind), 'V7 Harbor image kind is invalid');
  if (kind === 'environment') return descriptorAt(path.join(taskRoot, 'environment'), kind);
  const stepEntries = await readdir(path.join(taskRoot, 'steps'), { withFileTypes: true });
  const roots = stepEntries.filter((entry) => entry.isDirectory()).map(({ name }) => path.join(taskRoot, 'steps', name, 'tests')).sort();
  invariant(roots.length === 5, 'V7 Harbor task must expose five verifier image contexts');
  const descriptors = await Promise.all(roots.map((root) => descriptorAt(root, kind)));
  invariant(descriptors.every(({ sourceSha256 }) => sourceSha256 === descriptors[0].sourceSha256), 'V7 Harbor per-phase verifier image contexts differ');
  return { ...descriptors[0], contextCount: descriptors.length };
}

export async function terminalV7HarborTaskImageSources({ taskRoot } = {}) {
  const root = safeRoot(taskRoot, 'V7 Harbor task root');
  return Object.freeze(Object.fromEntries(await Promise.all(['environment', 'verifier'].map(async (kind) => {
    const descriptor = await contextDescriptor(root, kind);
    return [kind, Object.freeze({
      schemaVersion: descriptor.schemaVersion,
      kind,
      image: descriptor.image,
      sourceSha256: descriptor.sourceSha256,
      fileCount: descriptor.fileCount,
      ...(descriptor.contextCount ? { contextCount: descriptor.contextCount } : {}),
    })];
  }))));
}

function capture(command, args, { cwd, timeoutMs }) {
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

async function inspectDescriptor(descriptor, expectedImageId = null) {
  const result = await capture('docker', [
    'image', 'inspect', descriptor.image,
    '--format', `{{ index .Config.Labels "${TERMINAL_V7_HARBOR_CONTEXT_LABEL}" }} {{ .Id }}`,
  ], { cwd: descriptor.contextRoot, timeoutMs: 30_000 });
  invariant(result.code === 0 && !result.signal && !result.timedOut, `V7 Harbor ${descriptor.kind} image is unavailable`);
  const [sourceSha256, imageId] = result.stdout.trim().split(/\s+/, 2);
  invariant(sourceSha256 === descriptor.sourceSha256, `V7 Harbor ${descriptor.kind} image source label changed`);
  invariant(IMAGE_ID_RE.test(imageId ?? ''), `V7 Harbor ${descriptor.kind} image ID is invalid`);
  if (expectedImageId !== null) invariant(imageId === expectedImageId, `V7 Harbor ${descriptor.kind} image ID differs from the sealed challenge`);
  return Object.freeze({ schemaVersion: descriptor.schemaVersion, kind: descriptor.kind, image: descriptor.image, imageId, sourceSha256: descriptor.sourceSha256, fileCount: descriptor.fileCount, ...(descriptor.contextCount ? { contextCount: descriptor.contextCount } : {}) });
}

export async function buildTerminalV7HarborTaskImages({ taskRoot } = {}) {
  const root = safeRoot(taskRoot, 'V7 Harbor task root');
  const images = {};
  for (const kind of ['environment', 'verifier']) {
    const descriptor = await contextDescriptor(root, kind);
    const result = await capture('docker', [
      'build', '--file', 'Dockerfile', '--tag', descriptor.image,
      '--build-arg', `AGENTBATTLER_V7_CONTEXT_SHA256=${descriptor.sourceSha256}`, '.',
    ], { cwd: descriptor.contextRoot, timeoutMs: 30 * 60 * 1000 });
    invariant(result.code === 0 && !result.signal && !result.timedOut, `V7 Harbor ${kind} image build failed: ${result.stderr.slice(-1200)}`);
    images[kind] = await inspectDescriptor(descriptor);
  }
  await bindTerminalV7HarborTaskImageReferences({ taskRoot: root, images });
  return Object.freeze(images);
}

export async function inspectTerminalV7HarborTaskImages({ taskRoot, expected } = {}) {
  const root = safeRoot(taskRoot, 'V7 Harbor task root');
  invariant(expected && typeof expected === 'object', 'V7 Harbor expected image commitments are missing');
  const references = await assertTerminalV7HarborTaskImageReferences({ taskRoot: root, expected });
  const images = {};
  for (const kind of ['environment', 'verifier']) {
    const descriptor = await contextDescriptor(root, kind);
    const sealed = expected[kind];
    invariant(sealed?.sourceSha256 === descriptor.sourceSha256 && sealed?.image === descriptor.image, `V7 Harbor ${kind} source commitment changed`);
    images[kind] = await inspectDescriptor(descriptor, sealed.imageId);
    const exact = await capture('docker', ['image', 'inspect', references[kind], '--format', '{{ .Id }}'], { cwd: descriptor.contextRoot, timeoutMs: 30_000 });
    invariant(exact.code === 0 && !exact.signal && !exact.timedOut, `V7 Harbor ${kind} immutable task image is unavailable`);
    invariant(exact.stdout.trim() === sealed.imageId, `V7 Harbor ${kind} immutable task image ID drifted before execution`);
  }
  return Object.freeze(images);
}
