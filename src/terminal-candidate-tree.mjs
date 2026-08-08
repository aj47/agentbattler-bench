import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson, sha256 } from './provenance.mjs';

export const TERMINAL_CANDIDATE_TREE_SCHEMA = 'agentbattler.terminal-candidate-tree.v1';
export const TERMINAL_CANDIDATE_TREE_POLICY_SCHEMA = 'agentbattler.terminal-candidate-tree-policy.v1';
export const TERMINAL_CANDIDATE_TREE_MAX_FILES = 256;
export const TERMINAL_CANDIDATE_TREE_MAX_BYTES = 4 * 1024 * 1024;

const REQUIRED_EXCLUDED_PATHS = Object.freeze([
  '.agentbattler',
  '.git',
  'node_modules',
  'tests',
]);

const IGNORED_RUNTIME_FILE_NAMES = new Set([
  'isolation-probe.json',
  'ledger.export.json',
  'ledger.journal',
  'ledger.json',
  'ledger.json.tmp',
  'ledger.lock',
  'ledger.snapshot.json',
  'ledger.wal',
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function posixPath(value) {
  return value.split(path.sep).join('/');
}

export function normalizeTerminalCandidatePath(input) {
  invariant(typeof input === 'string' && input.length > 0, 'Candidate-tree path must be a non-empty string');
  invariant(!input.includes('\0'), 'Candidate-tree path contains NUL');
  invariant(!input.includes('\\'), `Candidate-tree path must use POSIX separators: ${input}`);
  invariant(!path.posix.isAbsolute(input) && !path.win32.isAbsolute(input), `Candidate-tree path must be relative: ${input}`);
  const segments = input.split('/');
  invariant(!segments.includes('..'), `Candidate-tree path may not traverse: ${input}`);
  const normalized = path.posix.normalize(input).replace(/^\.\//, '').replace(/\/$/, '');
  invariant(normalized !== '' && normalized !== '.', `Candidate-tree path must name a file or directory: ${input}`);
  invariant(!normalized.startsWith('../'), `Candidate-tree path may not traverse: ${input}`);
  return normalized;
}

function isIgnoredCandidatePath(candidatePath, excludes) {
  const segments = candidatePath.split('/');
  return excludes.some((excluded) => candidatePath === excluded || candidatePath.startsWith(`${excluded}/`))
    || segments.some((segment) => REQUIRED_EXCLUDED_PATHS.includes(segment))
    || IGNORED_RUNTIME_FILE_NAMES.has(segments.at(-1));
}

function normalizePolicyPattern(input, label) {
  invariant(typeof input === 'string' && input.length > 0, `${label} must contain non-empty strings`);
  const wildcard = input.endsWith('/**');
  invariant(!input.includes('*') || (wildcard && !input.slice(0, -3).includes('*')), `${label} supports only trailing /** patterns: ${input}`);
  return normalizeTerminalCandidatePath(wildcard ? input.slice(0, -3) : input);
}

function normalizedPolicyPaths(values, label) {
  invariant(Array.isArray(values), `${label} must be an array`);
  return [...new Set(values.map((value) => normalizePolicyPattern(value, label)))].sort(comparePaths);
}

function normalizedAllowlist(values) {
  invariant(Array.isArray(values) && values.length > 0, 'Candidate-tree policy requires a non-empty allowlist');
  return normalizedPolicyPaths(values, 'Candidate-tree policy allowlist');
}

function normalizedExcludes(values = []) {
  const requested = normalizedPolicyPaths(values, 'Candidate-tree policy excludes');
  return [...new Set([...REQUIRED_EXCLUDED_PATHS, ...requested])].sort(comparePaths);
}

export function normalizeTerminalCandidateTreePolicy(policy) {
  invariant(policy && typeof policy === 'object' && !Array.isArray(policy), 'Candidate-tree policy is required');
  invariant(policy.schemaVersion === undefined || policy.schemaVersion === TERMINAL_CANDIDATE_TREE_POLICY_SCHEMA, 'Unsupported candidate-tree policy schema');
  invariant(policy.regularFilesOnly !== false, 'Candidate-tree policy may not allow non-regular files');
  invariant(policy.rejectHardlinks !== false, 'Candidate-tree policy may not allow hardlinks');
  invariant(!(policy.allowlist && policy.include), 'Candidate-tree policy may use allowlist or include, not both');
  invariant(!(policy.excludes && policy.exclude), 'Candidate-tree policy may use excludes or exclude, not both');
  const maxFiles = policy.maxFiles ?? TERMINAL_CANDIDATE_TREE_MAX_FILES;
  const maxBytes = policy.maxBytes ?? TERMINAL_CANDIDATE_TREE_MAX_BYTES;
  invariant(Number.isSafeInteger(maxFiles) && maxFiles > 0 && maxFiles <= TERMINAL_CANDIDATE_TREE_MAX_FILES, `Candidate-tree maxFiles must be between 1 and ${TERMINAL_CANDIDATE_TREE_MAX_FILES}`);
  invariant(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= TERMINAL_CANDIDATE_TREE_MAX_BYTES, `Candidate-tree maxBytes must be between 1 and ${TERMINAL_CANDIDATE_TREE_MAX_BYTES}`);
  return {
    allowlist: normalizedAllowlist(policy.allowlist ?? policy.include),
    excludes: normalizedExcludes(policy.excludes ?? policy.exclude),
    maxFiles,
    maxBytes,
  };
}

function isAllowlisted(candidatePath, allowlist) {
  return allowlist.some((allowed) => candidatePath === allowed || candidatePath.startsWith(`${allowed}/`));
}

function isAllowlistAncestor(candidatePath, allowlist) {
  return allowlist.some((allowed) => allowed.startsWith(`${candidatePath}/`));
}

function assertCanonicalPathList(values, label) {
  invariant(Array.isArray(values), `${label} must be an array`);
  const normalized = values.map(normalizeTerminalCandidatePath);
  invariant(canonicalJson(values) === canonicalJson([...new Set(normalized)].sort(comparePaths)), `${label} must contain sorted unique normalized paths`);
  return normalized;
}

function assertAllowedManifestPath(candidatePath, policy, label) {
  invariant(!isIgnoredCandidatePath(candidatePath, policy.excludes), `${label} uses an ignored path: ${candidatePath}`);
  invariant(isAllowlisted(candidatePath, policy.allowlist), `${label} is outside the candidate-tree allowlist: ${candidatePath}`);
}

function modeString(mode) {
  return (mode & 0o777).toString(8).padStart(4, '0');
}

function validateFileRecord(record, policy, label) {
  invariant(record && typeof record === 'object' && !Array.isArray(record), `${label} must be an object`);
  const candidatePath = normalizeTerminalCandidatePath(record.path);
  invariant(record.path === candidatePath, `${label} path is not normalized: ${record.path}`);
  assertAllowedManifestPath(candidatePath, policy, label);
  invariant(/^0[0-7]{3}$/.test(record.mode), `${label} mode must be a four-digit permission mode`);
  invariant(Number.isSafeInteger(record.sizeBytes) && record.sizeBytes >= 0, `${label} sizeBytes is invalid`);
  invariant(/^[a-f0-9]{64}$/.test(record.sha256), `${label} SHA-256 is invalid`);
  return {
    path: candidatePath,
    mode: record.mode,
    sizeBytes: record.sizeBytes,
    sha256: record.sha256,
  };
}

function assertNoPathConflicts(files) {
  const seen = new Set();
  for (const file of files) {
    invariant(!seen.has(file.path), `Candidate tree contains duplicate path: ${file.path}`);
    const segments = file.path.split('/');
    for (let length = 1; length < segments.length; length += 1) {
      const parent = segments.slice(0, length).join('/');
      invariant(!seen.has(parent), `Candidate tree has a file/directory path conflict: ${parent} and ${file.path}`);
    }
    seen.add(file.path);
  }
}

function terminalCandidateTreeMerkleRoot(files) {
  let level = files.map((file) => sha256(`agentbattler.terminal-candidate-tree.v1\0leaf\0${canonicalJson({
    mode: file.mode,
    path: file.path,
    sha256: file.sha256,
    sizeBytes: file.sizeBytes,
  })}`));
  if (level.length === 0) return sha256('agentbattler.terminal-candidate-tree.v1\0empty');
  while (level.length > 1) {
    const next = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      const right = level[index + 1] ?? left;
      next.push(sha256(`agentbattler.terminal-candidate-tree.v1\0node\0${left}\0${right}`));
    }
    level = next;
  }
  return level[0];
}

function fullTreeManifest(files, policy) {
  const sorted = [...files].sort((left, right) => comparePaths(left.path, right.path));
  assertNoPathConflicts(sorted);
  const totalBytes = sorted.reduce((total, file) => total + file.sizeBytes, 0);
  invariant(sorted.length <= policy.maxFiles, `Candidate tree exceeds ${policy.maxFiles} files`);
  invariant(totalBytes <= policy.maxBytes, `Candidate tree exceeds ${policy.maxBytes} bytes`);
  return {
    schemaVersion: TERMINAL_CANDIDATE_TREE_SCHEMA,
    kind: 'full',
    allowlist: policy.allowlist,
    excludes: policy.excludes,
    limits: { maxFiles: policy.maxFiles, maxBytes: policy.maxBytes },
    files: sorted,
    deletions: [],
    fileCount: sorted.length,
    totalBytes,
    treeSha256: terminalCandidateTreeMerkleRoot(sorted),
  };
}

function policyFromTree(tree) {
  invariant(tree?.limits && typeof tree.limits === 'object', 'Candidate tree limits are required');
  invariant(Array.isArray(tree.excludes), 'Candidate tree excludes are required');
  const policy = normalizeTerminalCandidateTreePolicy({
    allowlist: tree.allowlist,
    excludes: tree.excludes,
    maxFiles: tree.limits.maxFiles,
    maxBytes: tree.limits.maxBytes,
  });
  invariant(canonicalJson(tree.allowlist) === canonicalJson(policy.allowlist), 'Candidate tree allowlist is not normalized');
  invariant(canonicalJson(tree.excludes) === canonicalJson(policy.excludes), 'Candidate tree excludes are not normalized');
  invariant(canonicalJson(tree.limits) === canonicalJson({ maxFiles: policy.maxFiles, maxBytes: policy.maxBytes }), 'Candidate tree limits are not canonical');
  return policy;
}

function validateTreeEnvelope(tree) {
  invariant(tree && typeof tree === 'object' && !Array.isArray(tree), 'Candidate tree must be an object');
  invariant(tree.schemaVersion === TERMINAL_CANDIDATE_TREE_SCHEMA, 'Unsupported candidate-tree schema');
  invariant(['full', 'overlay'].includes(tree.kind), `Unsupported candidate-tree kind: ${tree.kind ?? 'missing'}`);
  const policy = policyFromTree(tree);
  invariant(Array.isArray(tree.files), 'Candidate tree files are required');
  const files = tree.files.map((record, index) => validateFileRecord(record, policy, `Candidate tree file[${index}]`));
  invariant(canonicalJson(tree.files) === canonicalJson([...files].sort((left, right) => comparePaths(left.path, right.path))), 'Candidate tree files must be sorted by normalized path');
  assertNoPathConflicts(files);
  const deletions = assertCanonicalPathList(tree.deletions, 'Candidate tree deletions');
  for (const deletion of deletions) assertAllowedManifestPath(deletion, policy, 'Candidate tree deletion');
  const changed = new Set(files.map((file) => file.path));
  for (const deletion of deletions) invariant(!changed.has(deletion), `Candidate-tree overlay both changes and deletes ${deletion}`);
  invariant(Number.isSafeInteger(tree.fileCount) && tree.fileCount >= 0 && tree.fileCount <= policy.maxFiles, 'Candidate tree fileCount is invalid');
  invariant(Number.isSafeInteger(tree.totalBytes) && tree.totalBytes >= 0 && tree.totalBytes <= policy.maxBytes, 'Candidate tree totalBytes is invalid');
  invariant(/^[a-f0-9]{64}$/.test(tree.treeSha256), 'Candidate tree Merkle root is invalid');
  return { policy, files, deletions };
}

function validateFullTree(tree) {
  const { policy, files, deletions } = validateTreeEnvelope(tree);
  invariant(tree.kind === 'full', 'Candidate-tree base must be a full snapshot');
  invariant(deletions.length === 0, 'Full candidate tree may not contain deletions');
  invariant(tree.baseTreeSha256 === undefined, 'Full candidate tree may not name a base tree');
  const expected = fullTreeManifest(files, policy);
  for (const field of ['fileCount', 'totalBytes', 'treeSha256']) {
    invariant(tree[field] === expected[field], `Full candidate tree ${field} mismatch`);
  }
  return tree;
}

function samePolicy(left, right) {
  return canonicalJson({ allowlist: left.allowlist, excludes: left.excludes, limits: left.limits })
    === canonicalJson({ allowlist: right.allowlist, excludes: right.excludes, limits: right.limits });
}

function applyOverlayUnchecked(base, overlay) {
  const map = new Map(base.files.map((file) => [file.path, file]));
  for (const deletion of overlay.deletions) {
    invariant(map.has(deletion), `Candidate-tree overlay deletes an absent path: ${deletion}`);
    map.delete(deletion);
  }
  for (const file of overlay.files) map.set(file.path, file);
  return fullTreeManifest([...map.values()], policyFromTree(base));
}

export function applyTerminalCandidateTreeOverlay(base, overlay) {
  validateFullTree(base);
  const { files, deletions } = validateTreeEnvelope(overlay);
  invariant(overlay.kind === 'overlay', 'Candidate-tree overlay must have kind overlay');
  invariant(samePolicy(base, overlay), 'Candidate-tree overlay policy differs from its base');
  invariant(overlay.baseTreeSha256 === base.treeSha256, 'Candidate-tree overlay base hash mismatch');
  const applied = applyOverlayUnchecked(base, { ...overlay, files, deletions });
  for (const field of ['fileCount', 'totalBytes', 'treeSha256']) {
    invariant(overlay[field] === applied[field], `Candidate-tree overlay ${field} mismatch`);
  }
  return applied;
}

export function validateTerminalCandidateTree(tree, { base = null } = {}) {
  if (tree?.kind === 'overlay') {
    invariant(base, 'Candidate-tree overlay validation requires its full base snapshot');
    applyTerminalCandidateTreeOverlay(base, tree);
  } else {
    validateFullTree(tree);
  }
  return tree;
}

async function readRegularCandidateFile(absolute, candidatePath, expectedStat, seenInodes) {
  let handle;
  try {
    handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    throw new Error(`Candidate-tree file could not be opened safely: ${candidatePath}: ${error.message}`);
  }
  try {
    const stat = await handle.stat();
    invariant(stat.isFile(), `Candidate-tree entry is not a regular file: ${candidatePath}`);
    invariant(stat.dev === expectedStat.dev && stat.ino === expectedStat.ino, `Candidate-tree entry changed while being opened: ${candidatePath}`);
    invariant(stat.nlink === 1, `Candidate-tree hardlink is forbidden: ${candidatePath}`);
    invariant((stat.mode & 0o7000) === 0, `Candidate-tree special permission bits are forbidden: ${candidatePath}`);
    const inode = `${stat.dev}:${stat.ino}`;
    invariant(!seenInodes.has(inode), `Candidate tree contains multiple paths for one inode: ${candidatePath}`);
    seenInodes.add(inode);
    const bytes = await handle.readFile();
    invariant(bytes.length === stat.size, `Candidate-tree file changed while being read: ${candidatePath}`);
    return {
      record: {
        path: candidatePath,
        mode: modeString(stat.mode),
        sizeBytes: bytes.length,
        sha256: sha256(bytes),
      },
      bytes,
    };
  } finally {
    await handle.close();
  }
}

async function scanTerminalCandidateTree(root, policy, { retainBytes = false } = {}) {
  invariant(path.isAbsolute(root), 'Candidate-tree root must be absolute');
  const rootStat = await lstat(root);
  invariant(rootStat.isDirectory() && !rootStat.isSymbolicLink(), 'Candidate-tree root must be a real directory');
  const canonicalRoot = await realpath(root);
  const files = [];
  const contents = new Map();
  const seenInodes = new Set();
  let totalBytes = 0;

  async function walk(relative = '') {
    const absoluteDirectory = relative ? path.join(root, ...relative.split('/')) : root;
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    entries.sort((left, right) => comparePaths(left.name, right.name));
    for (const entry of entries) {
      const candidatePath = normalizeTerminalCandidatePath(relative ? `${relative}/${entry.name}` : entry.name);
      if (isIgnoredCandidatePath(candidatePath, policy.excludes)) continue;
      const included = isAllowlisted(candidatePath, policy.allowlist);
      const ancestor = isAllowlistAncestor(candidatePath, policy.allowlist);
      if (!included && !ancestor) continue;
      const absolute = path.join(root, ...candidatePath.split('/'));
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Candidate-tree symlink is forbidden: ${candidatePath}`);
      if (stat.isDirectory()) {
        await walk(candidatePath);
        continue;
      }
      if (!stat.isFile()) throw new Error(`Candidate-tree special file is forbidden: ${candidatePath}`);
      invariant(included, `Candidate-tree allowlist ancestor is not a directory: ${candidatePath}`);
      const canonicalFile = await realpath(absolute);
      const relativeCanonical = path.relative(canonicalRoot, canonicalFile);
      invariant(relativeCanonical !== '..' && !relativeCanonical.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeCanonical), `Candidate-tree entry resolves outside its root: ${candidatePath}`);
      const { record, bytes } = await readRegularCandidateFile(absolute, candidatePath, stat, seenInodes);
      files.push(record);
      totalBytes += record.sizeBytes;
      invariant(files.length <= policy.maxFiles, `Candidate tree exceeds ${policy.maxFiles} files`);
      invariant(totalBytes <= policy.maxBytes, `Candidate tree exceeds ${policy.maxBytes} bytes`);
      if (retainBytes) contents.set(candidatePath, bytes);
    }
  }

  await walk();
  return { manifest: fullTreeManifest(files, policy), contents };
}

function overlayFromFullTrees(base, current) {
  invariant(samePolicy(base, current), 'Candidate-tree snapshot policy differs from its base');
  const before = new Map(base.files.map((file) => [file.path, file]));
  const after = new Map(current.files.map((file) => [file.path, file]));
  const files = current.files.filter((file) => canonicalJson(before.get(file.path) ?? null) !== canonicalJson(file));
  const deletions = base.files.map((file) => file.path).filter((candidatePath) => !after.has(candidatePath));
  return {
    schemaVersion: TERMINAL_CANDIDATE_TREE_SCHEMA,
    kind: 'overlay',
    allowlist: current.allowlist,
    excludes: current.excludes,
    limits: current.limits,
    baseTreeSha256: base.treeSha256,
    files,
    deletions,
    fileCount: current.fileCount,
    totalBytes: current.totalBytes,
    treeSha256: current.treeSha256,
  };
}

export async function snapshotTerminalCandidateTree({ root, policy, base = null }) {
  const normalizedPolicy = normalizeTerminalCandidateTreePolicy(policy);
  if (base) {
    validateFullTree(base);
    invariant(canonicalJson(base.allowlist) === canonicalJson(normalizedPolicy.allowlist)
      && canonicalJson(base.excludes) === canonicalJson(normalizedPolicy.excludes)
      && canonicalJson(base.limits) === canonicalJson({ maxFiles: normalizedPolicy.maxFiles, maxBytes: normalizedPolicy.maxBytes }), 'Candidate-tree snapshot policy differs from its base');
  }
  const { manifest } = await scanTerminalCandidateTree(root, normalizedPolicy);
  return base ? overlayFromFullTrees(base, manifest) : manifest;
}

function expectedTree(expected) {
  return expected?.tree ?? expected;
}

function assertExpectedCandidateTree(actual, expected, base) {
  if (!expected) return;
  const expectedManifest = expectedTree(expected);
  validateTerminalCandidateTree(expectedManifest, { base });
  const fields = ['schemaVersion', 'kind', 'allowlist', 'excludes', 'limits', 'baseTreeSha256', 'files', 'deletions', 'fileCount', 'totalBytes', 'treeSha256'];
  for (const field of fields) {
    if (expectedManifest[field] !== undefined) {
      invariant(canonicalJson(actual[field]) === canonicalJson(expectedManifest[field]), `Captured candidate tree ${field} does not match expected evidence`);
    }
  }
}

export async function captureTerminalCandidateTree({
  workspace,
  baseDirectory = null,
  runDirectory,
  turn,
  policy,
  expected = null,
}) {
  invariant(path.isAbsolute(workspace), 'Candidate-tree workspace must be absolute');
  invariant(baseDirectory === null || path.isAbsolute(baseDirectory), 'Candidate-tree baseDirectory must be null or absolute');
  invariant(path.isAbsolute(runDirectory), 'Candidate-tree runDirectory must be absolute');
  invariant(Number.isSafeInteger(turn) && turn > 0, 'Candidate-tree turn must be a positive integer');
  const normalizedPolicy = normalizeTerminalCandidateTreePolicy(policy);
  const base = baseDirectory
    ? (await scanTerminalCandidateTree(baseDirectory, normalizedPolicy)).manifest
    : null;
  const scanned = await scanTerminalCandidateTree(workspace, normalizedPolicy, { retainBytes: true });
  const tree = base ? overlayFromFullTrees(base, scanned.manifest) : scanned.manifest;
  validateTerminalCandidateTree(tree, { base });
  assertExpectedCandidateTree(tree, expected, base);

  const relativeDirectory = path.join('candidate-trees', `turn-${String(turn).padStart(2, '0')}`);
  const directory = path.join(runDirectory, relativeDirectory);
  await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  await mkdir(path.join(directory, 'files'), { mode: 0o700 });
  const archivedFiles = [];
  for (const file of tree.files) {
    const bytes = scanned.contents.get(file.path);
    invariant(bytes, `Captured candidate-tree bytes are missing for ${file.path}`);
    invariant(bytes.length === file.sizeBytes && sha256(bytes) === file.sha256, `Candidate-tree file changed during capture: ${file.path}`);
    const destination = path.join(directory, 'files', ...file.path.split('/'));
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, bytes, { mode: Number.parseInt(file.mode, 8), flag: 'wx' });
    await chmod(destination, Number.parseInt(file.mode, 8));
    archivedFiles.push(file.path);
  }
  const evidence = {
    ...tree,
    turn,
    archived: true,
    archivePath: posixPath(path.join(relativeDirectory, 'files')),
    archivedFiles,
  };
  await writeFile(path.join(directory, 'metadata.json'), `${canonicalJson(evidence, { space: 2 })}\n`, { mode: 0o600, flag: 'wx' });
  return evidence;
}

export async function validateCapturedTerminalCandidateTree({ runDirectory, evidence, base = null }) {
  invariant(path.isAbsolute(runDirectory), 'Candidate-tree runDirectory must be absolute');
  validateTerminalCandidateTree(evidence, { base });
  invariant(evidence.archived === true && typeof evidence.archivePath === 'string', 'Captured candidate-tree archive metadata is missing');
  const archivePath = normalizeTerminalCandidatePath(evidence.archivePath);
  const archiveRoot = path.resolve(runDirectory, ...archivePath.split('/'));
  const relativeArchive = path.relative(runDirectory, archiveRoot);
  invariant(relativeArchive !== '..' && !relativeArchive.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeArchive), 'Captured candidate-tree archive escapes the run directory');
  const archiveStat = await lstat(archiveRoot);
  invariant(archiveStat.isDirectory() && !archiveStat.isSymbolicLink(), 'Captured candidate-tree archive root is unsafe');
  assertCanonicalPathList(evidence.archivedFiles, 'Captured candidate-tree archivedFiles');
  invariant(canonicalJson(evidence.archivedFiles) === canonicalJson(evidence.files.map((file) => file.path)), 'Captured candidate-tree archivedFiles do not match the manifest');
  for (const file of evidence.files) {
    const absolute = path.join(archiveRoot, ...file.path.split('/'));
    const stat = await lstat(absolute);
    invariant(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, `Captured candidate-tree archive entry is unsafe: ${file.path}`);
    invariant(modeString(stat.mode) === file.mode, `Captured candidate-tree archive mode mismatch: ${file.path}`);
    const bytes = await readFile(absolute);
    invariant(bytes.length === file.sizeBytes && sha256(bytes) === file.sha256, `Captured candidate-tree archive checksum mismatch: ${file.path}`);
  }
  return evidence;
}
