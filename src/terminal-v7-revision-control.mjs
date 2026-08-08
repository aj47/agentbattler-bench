import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson, canonicalJsonSha256, sha256File } from './provenance.mjs';
import { readTerminalV7RetirementRecord } from './terminal-v7-retirement.mjs';

export const TERMINAL_V7_REVISION_SATURATION_SCHEMA = 'agentbattler.terminal-v7-revision-saturation.v1';

const SHA256_RE = /^[0-9a-f]{64}$/;
const CAMPAIGNS = new Set(['development-pilot', 'official-release', 'reserve-extension']);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function revisionValue(revision) {
  invariant(/^r[1-9]\d*$/.test(revision ?? ''), 'V7 revision-control revision must look like r1');
  return revision;
}

function safeAbsolute(value, label) {
  invariant(typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0'), `${label} must be absolute`);
  return path.resolve(value);
}

function safeToken(value, label) {
  invariant(typeof value === 'string' && value.length > 0 && !value.includes('/') && !value.includes('\\') && !value.includes('\0'), `${label} is invalid`);
  return value;
}

function contained(root, relative, label) {
  invariant(typeof relative === 'string' && relative.length > 0 && !path.isAbsolute(relative) && !relative.includes('\0'), `${label} path is invalid`);
  const normalized = path.posix.normalize(relative.replaceAll(path.sep, '/'));
  invariant(normalized !== '..' && !normalized.startsWith('../'), `${label} path escapes its root`);
  const resolved = path.resolve(root, ...normalized.split('/'));
  const relation = path.relative(root, resolved);
  invariant(relation && relation !== '..' && !relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation), `${label} path escapes its root`);
  return resolved;
}

async function regularDescriptor(file, label) {
  const stat = await lstat(file);
  invariant(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, `${label} must be one regular file`);
  return { sizeBytes: stat.size, sha256: await sha256File(file) };
}

function validateRunSeal(run, label) {
  const { resultSha256, ...unsigned } = run ?? {};
  invariant(SHA256_RE.test(resultSha256 ?? '') && resultSha256 === canonicalJsonSha256(unsigned), `${label} result seal is invalid`);
  invariant(run.status === 'completed' && run.validity === 'valid', `${label} is not a valid completed result`);
  return run;
}

function scorePoints(score) {
  const value = score?.core?.points ?? score?.corePoints;
  invariant(Number.isFinite(value) && value >= 0 && value <= 100, 'V7 saturation score projection is invalid');
  return value;
}

export function resolveTerminalV7RevisionControlRoot({ root, revision, env = process.env } = {}) {
  const repositoryRoot = safeAbsolute(root, 'V7 repository root');
  revisionValue(revision);
  return path.resolve(env.AGENTBATTLER_V7_REVISION_CONTROL_ROOT
    ?? path.join(repositoryRoot, 'results', `terminal-mini-ledger-v7-control-${revision}`));
}

export async function assertTerminalV7OfficialResultRootUnused({ resultRoot } = {}) {
  const destination = safeAbsolute(resultRoot, 'V7 official result root');
  let stat;
  try {
    stat = await lstat(destination);
  } catch (error) {
    if (error?.code === 'ENOENT') return destination;
    throw error;
  }
  invariant(stat.isDirectory() && !stat.isSymbolicLink(), 'V7 official result root must be a real directory when it already exists');
  const entries = await readdir(destination);
  invariant(entries.length === 0, `Refusing to rebuild the sealed V7 official schedule over preexisting result state: ${entries.sort().join(', ')}`);
  return destination;
}

export function validateTerminalV7RevisionSaturationMarker(marker, { revision = null } = {}) {
  invariant(marker?.schemaVersion === TERMINAL_V7_REVISION_SATURATION_SCHEMA, 'Unsupported V7 revision saturation schema');
  const { markerSha256, ...unsigned } = marker;
  invariant(SHA256_RE.test(markerSha256 ?? '') && markerSha256 === canonicalJsonSha256(unsigned), 'V7 revision saturation marker hash mismatch');
  revisionValue(marker.revision);
  if (revision !== null) invariant(marker.revision === revisionValue(revision), 'V7 saturation marker uses another revision');
  invariant(CAMPAIGNS.has(marker.campaign), 'V7 saturation campaign is invalid');
  invariant(typeof marker.detectedAt === 'string' && Number.isFinite(Date.parse(marker.detectedAt)), 'V7 saturation timestamp is invalid');
  invariant(marker.action === 'pause-all-new-revision-jobs-for-saturation-audit' && marker.detectedCore === 100, 'V7 saturation action changed');
  invariant(typeof marker.runKey === 'string' && marker.runKey.length > 0
    && typeof marker.harnessId === 'string' && marker.harnessId.length > 0
    && typeof marker.instanceId === 'string' && marker.instanceId.length > 0
    && SHA256_RE.test(marker.resultSha256 ?? ''), 'V7 saturation run identity is incomplete');
  safeAbsolute(marker.source?.resultRoot, 'V7 saturation source result root');
  safeToken(marker.source?.attemptId, 'V7 saturation source attempt ID');
  for (const name of ['current', 'attempt']) {
    const descriptor = marker.source?.[name];
    contained(marker.source.resultRoot, descriptor?.path, `V7 saturation ${name} result`);
    invariant(Number.isSafeInteger(descriptor?.sizeBytes) && descriptor.sizeBytes > 0 && SHA256_RE.test(descriptor.sha256 ?? ''), `V7 saturation ${name} result descriptor is invalid`);
  }
  return marker;
}

export async function assertTerminalV7RevisionSaturationArtifacts({ marker, revision = null, scoreRun = null } = {}) {
  validateTerminalV7RevisionSaturationMarker(marker, { revision });
  const sourceRoot = path.resolve(marker.source.resultRoot);
  const currentFile = contained(sourceRoot, marker.source.current.path, 'V7 saturation current result');
  const attemptFile = contained(sourceRoot, marker.source.attempt.path, 'V7 saturation attempt result');
  const [currentDescriptor, attemptDescriptor, current, attempt] = await Promise.all([
    regularDescriptor(currentFile, 'V7 saturation current result'),
    regularDescriptor(attemptFile, 'V7 saturation attempt result'),
    readFile(currentFile, 'utf8').then(JSON.parse),
    readFile(attemptFile, 'utf8').then(JSON.parse),
  ]);
  invariant(canonicalJson(currentDescriptor) === canonicalJson({ sizeBytes: marker.source.current.sizeBytes, sha256: marker.source.current.sha256 })
    && canonicalJson(attemptDescriptor) === canonicalJson({ sizeBytes: marker.source.attempt.sizeBytes, sha256: marker.source.attempt.sha256 }), 'V7 saturation source result bytes changed');
  validateRunSeal(current, 'V7 saturation current result');
  validateRunSeal(attempt, 'V7 saturation attempt result');
  invariant(canonicalJson(current) === canonicalJson(attempt), 'V7 saturation current result differs from its declared immutable attempt');
  invariant(current.runKey === marker.runKey && current.attemptId === marker.source.attemptId
    && current.resultSha256 === marker.resultSha256, 'V7 saturation marker names another result or attempt');
  if (scoreRun !== null) {
    invariant(typeof scoreRun === 'function', 'V7 saturation score validator must be a function');
    invariant(scorePoints(await scoreRun(current)) === 100, 'V7 saturation source result does not score Core 100');
  }
  return { marker, run: current };
}

export async function writeTerminalV7RevisionSaturationMarker({
  controlRoot,
  revision,
  campaign,
  resultRoot,
  job,
  run,
  scoreRun,
  detectedAt = new Date().toISOString(),
} = {}) {
  const destination = safeAbsolute(controlRoot, 'V7 revision control root');
  const sourceRoot = safeAbsolute(resultRoot, 'V7 saturation source result root');
  revisionValue(revision);
  invariant(CAMPAIGNS.has(campaign), 'V7 saturation campaign is invalid');
  validateRunSeal(run, 'V7 saturation result');
  invariant(typeof scoreRun === 'function' && scorePoints(await scoreRun(run)) === 100, 'V7 saturation marker requires a Core-100 result');
  invariant(job?.runKey === run.runKey && job?.instanceId === run.instanceId, 'V7 saturation scheduled identity differs from its result');
  const harnessId = job?.harness?.id ?? job?.harness;
  invariant(typeof harnessId === 'string' && harnessId.length > 0, 'V7 saturation harness identity is missing');
  const attemptId = safeToken(run.attemptId, 'V7 saturation attempt ID');
  const currentPath = path.posix.join('runs', `${run.runKey}.json`);
  const attemptPath = path.posix.join('attempts', run.runKey, `${attemptId}.json`);
  const currentFile = contained(sourceRoot, currentPath, 'V7 saturation current result');
  const attemptFile = contained(sourceRoot, attemptPath, 'V7 saturation attempt result');
  const [current, attempt, currentDescriptor, attemptDescriptor] = await Promise.all([
    readFile(currentFile, 'utf8').then(JSON.parse),
    readFile(attemptFile, 'utf8').then(JSON.parse),
    regularDescriptor(currentFile, 'V7 saturation current result'),
    regularDescriptor(attemptFile, 'V7 saturation attempt result'),
  ]);
  invariant(canonicalJson(current) === canonicalJson(run) && canonicalJson(attempt) === canonicalJson(run), 'V7 saturation source must equal the current immutable attempt');
  const unsigned = {
    schemaVersion: TERMINAL_V7_REVISION_SATURATION_SCHEMA,
    revision,
    detectedAt,
    campaign,
    action: 'pause-all-new-revision-jobs-for-saturation-audit',
    detectedCore: 100,
    runKey: run.runKey,
    harnessId,
    instanceId: run.instanceId,
    resultSha256: run.resultSha256,
    source: {
      resultRoot: sourceRoot,
      attemptId,
      current: { path: currentPath, ...currentDescriptor },
      attempt: { path: attemptPath, ...attemptDescriptor },
    },
  };
  const marker = { ...unsigned, markerSha256: canonicalJsonSha256(unsigned) };
  await assertTerminalV7RevisionSaturationArtifacts({ marker, revision, scoreRun });
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await writeFile(path.join(destination, 'saturation-audit.json'), `${canonicalJson(marker, { space: 2 })}\n`, { mode: 0o600, flag: 'wx' });
  return marker;
}

export async function readTerminalV7RevisionSaturationMarker({ controlRoot, revision, scoreRun = null } = {}) {
  const destination = safeAbsolute(controlRoot, 'V7 revision control root');
  const file = path.join(destination, 'saturation-audit.json');
  let marker;
  try { marker = JSON.parse(await readFile(file, 'utf8')); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  await assertTerminalV7RevisionSaturationArtifacts({ marker, revision, scoreRun });
  return marker;
}

export async function ensureTerminalV7RevisionSaturationMarker(options = {}) {
  try {
    return await writeTerminalV7RevisionSaturationMarker(options);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const marker = await readTerminalV7RevisionSaturationMarker({
      controlRoot: options.controlRoot,
      revision: options.revision,
    });
    invariant(marker !== null, 'V7 revision saturation marker disappeared during creation');
    return marker;
  }
}

export async function ensureTerminalV7RevisionSaturationForRun(options = {}) {
  const run = options.run;
  if (run?.status !== 'completed' || run.validity !== 'valid') return null;
  invariant(typeof options.scoreRun === 'function', 'V7 saturation recovery requires a scorer');
  if (scorePoints(await options.scoreRun(run)) !== 100) return null;
  return ensureTerminalV7RevisionSaturationMarker(options);
}

export async function readTerminalV7RevisionStopState({ controlRoot, revision, scoreRun = null } = {}) {
  const destination = safeAbsolute(controlRoot, 'V7 revision control root');
  const retirement = await readTerminalV7RetirementRecord({ resultRoot: destination, revision });
  if (retirement) return { status: 'retired', retirement, saturation: null };
  const saturation = await readTerminalV7RevisionSaturationMarker({ controlRoot: destination, revision, scoreRun });
  return saturation ? { status: 'saturation-pending', retirement: null, saturation } : { status: 'active', retirement: null, saturation: null };
}

export async function assertTerminalV7RevisionAcceptsNewWork(options = {}) {
  const state = await readTerminalV7RevisionStopState(options);
  invariant(state.status === 'active', state.status === 'retired'
    ? 'V7 revision is retired and refuses new work'
    : 'V7 revision has a pending Core-100 saturation audit and refuses new work');
  return state;
}
