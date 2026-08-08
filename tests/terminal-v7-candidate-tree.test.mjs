import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  TERMINAL_CANDIDATE_TREE_MAX_BYTES,
  TERMINAL_CANDIDATE_TREE_MAX_FILES,
  applyTerminalCandidateTreeOverlay,
  captureTerminalCandidateTree,
  normalizeTerminalCandidatePath,
  normalizeTerminalCandidateTreePolicy,
  snapshotTerminalCandidateTree,
  validateCapturedTerminalCandidateTree,
  validateTerminalCandidateTree,
} from '../src/terminal-candidate-tree.mjs';
import { canonicalJson } from '../src/provenance.mjs';

const execFileAsync = promisify(execFile);
const POLICY = { allowlist: ['README.md', 'package.json', 'src', 'tests', '.git', '.agentbattler', 'node_modules'] };

const V7_RUNTIME_POLICY = {
  schemaVersion: 'agentbattler.terminal-candidate-tree-policy.v1',
  include: ['package.json', 'bin/**', 'src/**', 'config/**'],
  exclude: ['.git/**', '.agentbattler/**', 'node_modules/**', 'test/**', 'tests/**', 'var/**', 'tmp/**', '.cache/**'],
  maxFiles: 256,
  maxBytes: 4 * 1024 * 1024,
  regularFilesOnly: true,
  rejectHardlinks: true,
};

async function temporaryRoot(label) {
  return mkdtemp(path.join(os.tmpdir(), `agentbattler-${label}-`));
}

async function fixture(root) {
  await Promise.all([
    mkdir(path.join(root, 'src'), { recursive: true }),
    mkdir(path.join(root, 'tests'), { recursive: true }),
    mkdir(path.join(root, '.git'), { recursive: true }),
    mkdir(path.join(root, '.agentbattler'), { recursive: true }),
    mkdir(path.join(root, 'node_modules', 'dependency'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(root, 'package.json'), '{"type":"module"}\n'),
    writeFile(path.join(root, 'README.md'), 'candidate\n'),
    writeFile(path.join(root, 'src', 'z.mjs'), 'export const z = 1;\n'),
    writeFile(path.join(root, 'src', 'a.mjs'), '#!/usr/bin/env node\n'),
    writeFile(path.join(root, 'tests', 'hidden.test.mjs'), 'throw new Error("must be ignored")\n'),
    writeFile(path.join(root, '.git', 'config'), 'secret-ish-control-state\n'),
    writeFile(path.join(root, '.agentbattler', 'runtime.json'), '{}\n'),
    writeFile(path.join(root, 'node_modules', 'dependency', 'index.js'), 'ignored\n'),
    writeFile(path.join(root, 'ledger.json'), '{"runtime":true}\n'),
    writeFile(path.join(root, 'ledger.lock'), 'runtime\n'),
  ]);
  await chmod(path.join(root, 'src', 'a.mjs'), 0o750);
}

test('candidate tree snapshot is deterministic, allowlisted, and excludes control/runtime state', async () => {
  const root = await temporaryRoot('candidate-tree');
  try {
    await fixture(root);
    const first = await snapshotTerminalCandidateTree({ root, policy: POLICY });
    const second = await snapshotTerminalCandidateTree({ root, policy: { allowlist: [...POLICY.allowlist].reverse() } });
    assert.equal(canonicalJson(first), canonicalJson(second));
    assert.deepEqual(first.files.map((file) => file.path), ['README.md', 'package.json', 'src/a.mjs', 'src/z.mjs']);
    assert.equal(first.files.find((file) => file.path === 'src/a.mjs').mode, '0750');
    assert.equal(first.fileCount, 4);
    assert.match(first.treeSha256, /^[a-f0-9]{64}$/);
    assert.equal(validateTerminalCandidateTree(first), first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('candidate tree accepts and seals the V7 runtime include/exclude policy shape', async () => {
  const root = await temporaryRoot('candidate-tree-v7-policy');
  try {
    await Promise.all([
      mkdir(path.join(root, 'src', 'nested'), { recursive: true }),
      mkdir(path.join(root, 'config'), { recursive: true }),
      mkdir(path.join(root, 'var'), { recursive: true }),
      mkdir(path.join(root, 'src', 'tests'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(root, 'package.json'), '{}\n'),
      writeFile(path.join(root, 'src', 'nested', 'index.mjs'), 'export {};\n'),
      writeFile(path.join(root, 'config', 'default.json'), '{}\n'),
      writeFile(path.join(root, 'var', 'ledger.json'), 'runtime\n'),
      writeFile(path.join(root, 'src', 'tests', 'hidden.mjs'), 'ignored\n'),
    ]);
    const policy = normalizeTerminalCandidateTreePolicy(V7_RUNTIME_POLICY);
    assert.deepEqual(policy.allowlist, ['bin', 'config', 'package.json', 'src']);
    assert.deepEqual(policy.excludes, ['.agentbattler', '.cache', '.git', 'node_modules', 'test', 'tests', 'tmp', 'var']);
    const tree = await snapshotTerminalCandidateTree({ root, policy: V7_RUNTIME_POLICY });
    assert.deepEqual(tree.files.map((file) => file.path), ['config/default.json', 'package.json', 'src/nested/index.mjs']);
    assert.deepEqual(tree.excludes, policy.excludes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('candidate paths reject traversal, absolute paths, NUL, and platform-dependent separators', () => {
  assert.equal(normalizeTerminalCandidatePath('./src//file.mjs'), 'src/file.mjs');
  for (const candidate of ['../escape', 'src/../escape', '/absolute', 'C:\\escape', 'src\\file.mjs', 'bad\0name']) {
    assert.throws(() => normalizeTerminalCandidatePath(candidate), /Candidate-tree path/);
  }
});

test('candidate tree rejects symlinks, hardlinks, and special files in allowlisted paths', async (t) => {
  const root = await temporaryRoot('candidate-tree-types');
  try {
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'outside.mjs'), 'outside\n');
    await symlink('../outside.mjs', path.join(root, 'src', 'linked.mjs'));
    await assert.rejects(snapshotTerminalCandidateTree({ root, policy: { allowlist: ['src'] } }), /symlink is forbidden/);
    await unlink(path.join(root, 'src', 'linked.mjs'));

    await writeFile(path.join(root, 'src', 'original.mjs'), 'source\n');
    await link(path.join(root, 'src', 'original.mjs'), path.join(root, 'outside-hardlink.mjs'));
    await assert.rejects(snapshotTerminalCandidateTree({ root, policy: { allowlist: ['src'] } }), /hardlink is forbidden/);
    await unlink(path.join(root, 'outside-hardlink.mjs'));

    const fifo = path.join(root, 'src', 'candidate.pipe');
    try {
      await execFileAsync('mkfifo', [fifo]);
      await assert.rejects(snapshotTerminalCandidateTree({ root, policy: { allowlist: ['src'] } }), /special file is forbidden/);
    } catch (error) {
      if (error?.code === 'ENOENT') t.diagnostic('mkfifo unavailable; special-file assertion skipped');
      else throw error;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('candidate tree enforces the sealed file-count and byte ceilings', async () => {
  const root = await temporaryRoot('candidate-tree-limits');
  try {
    await mkdir(path.join(root, 'src'));
    for (let index = 0; index <= TERMINAL_CANDIDATE_TREE_MAX_FILES; index += 1) {
      await writeFile(path.join(root, 'src', `${String(index).padStart(3, '0')}.mjs`), 'x');
    }
    await assert.rejects(snapshotTerminalCandidateTree({ root, policy: { allowlist: ['src'] } }), /exceeds 256 files/);
    await rm(path.join(root, 'src'), { recursive: true, force: true });
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src', 'large.bin'), Buffer.alloc(TERMINAL_CANDIDATE_TREE_MAX_BYTES + 1));
    await assert.rejects(snapshotTerminalCandidateTree({ root, policy: { allowlist: ['src'] } }), /exceeds 4194304 bytes/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('candidate tree overlays commit changes, modes, additions, and deletions', async () => {
  const root = await temporaryRoot('candidate-tree-overlay');
  try {
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src', 'a.mjs'), 'a-v1\n');
    await writeFile(path.join(root, 'src', 'b.mjs'), 'b-v1\n');
    const base = await snapshotTerminalCandidateTree({ root, policy: { allowlist: ['src'] } });

    await writeFile(path.join(root, 'src', 'a.mjs'), 'a-v2\n');
    await chmod(path.join(root, 'src', 'a.mjs'), 0o750);
    await unlink(path.join(root, 'src', 'b.mjs'));
    await writeFile(path.join(root, 'src', 'c.mjs'), 'c-v1\n');
    const overlay = await snapshotTerminalCandidateTree({ root, policy: { allowlist: ['src'] }, base });
    assert.equal(overlay.kind, 'overlay');
    assert.deepEqual(overlay.files.map((file) => file.path), ['src/a.mjs', 'src/c.mjs']);
    assert.deepEqual(overlay.deletions, ['src/b.mjs']);
    assert.equal(overlay.files[0].mode, '0750');

    const applied = applyTerminalCandidateTreeOverlay(base, overlay);
    const current = await snapshotTerminalCandidateTree({ root, policy: { allowlist: ['src'] } });
    assert.equal(canonicalJson(applied), canonicalJson(current));
    assert.equal(validateTerminalCandidateTree(overlay, { base }), overlay);

    const tampered = structuredClone(overlay);
    tampered.files[0].sha256 = '0'.repeat(64);
    assert.throws(() => validateTerminalCandidateTree(tampered, { base }), /treeSha256 mismatch|overlay treeSha256 mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('capture archives only changed allowlisted files and validates metadata-only Harbor evidence', async () => {
  const root = await temporaryRoot('candidate-tree-capture');
  try {
    const baseline = path.join(root, 'baseline');
    const workspace = path.join(root, 'workspace');
    const runDirectory = path.join(root, 'run');
    await Promise.all([mkdir(path.join(baseline, 'src'), { recursive: true }), mkdir(path.join(workspace, 'src'), { recursive: true }), mkdir(runDirectory)]);
    await writeFile(path.join(baseline, 'src', 'same.mjs'), 'same\n');
    await writeFile(path.join(baseline, 'src', 'removed.mjs'), 'removed\n');
    await writeFile(path.join(workspace, 'src', 'same.mjs'), 'same\n');
    await writeFile(path.join(workspace, 'src', 'added.mjs'), 'added\n');
    const evidence = await captureTerminalCandidateTree({
      workspace,
      baseDirectory: baseline,
      runDirectory,
      turn: 2,
      policy: { allowlist: ['src'] },
    });
    assert.equal(evidence.kind, 'overlay');
    assert.deepEqual(evidence.archivedFiles, ['src/added.mjs']);
    assert.deepEqual(evidence.deletions, ['src/removed.mjs']);
    assert.equal(await readFile(path.join(runDirectory, evidence.archivePath, 'src', 'added.mjs'), 'utf8'), 'added\n');

    const base = await snapshotTerminalCandidateTree({ root: baseline, policy: { allowlist: ['src'] } });
    assert.equal(await validateCapturedTerminalCandidateTree({ runDirectory, evidence, base }), evidence);

    const secondRun = path.join(root, 'run-expected');
    await mkdir(secondRun);
    const repeated = await captureTerminalCandidateTree({
      workspace,
      baseDirectory: baseline,
      runDirectory: secondRun,
      turn: 2,
      policy: { allowlist: ['src'] },
      expected: evidence,
    });
    assert.equal(repeated.treeSha256, evidence.treeSha256);

    const badExpected = structuredClone(evidence);
    badExpected.treeSha256 = 'f'.repeat(64);
    const rejectedRun = path.join(root, 'run-rejected');
    await mkdir(rejectedRun);
    await assert.rejects(captureTerminalCandidateTree({
      workspace,
      baseDirectory: baseline,
      runDirectory: rejectedRun,
      turn: 2,
      policy: { allowlist: ['src'] },
      expected: badExpected,
    }), /overlay treeSha256 mismatch|does not match expected evidence/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('metadata validation rejects ignored, traversing, duplicate, and out-of-allowlist entries', async () => {
  const root = await temporaryRoot('candidate-tree-metadata');
  try {
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src', 'ok.mjs'), 'ok\n');
    const tree = await snapshotTerminalCandidateTree({ root, policy: { allowlist: ['src', 'tests'] } });
    for (const candidatePath of ['../escape.mjs', 'tests/hidden.mjs', 'other/file.mjs']) {
      const invalid = structuredClone(tree);
      invalid.files[0].path = candidatePath;
      assert.throws(() => validateTerminalCandidateTree(invalid), /traverse|ignored path|outside the candidate-tree allowlist/);
    }
    const duplicate = structuredClone(tree);
    duplicate.files.push({ ...duplicate.files[0] });
    duplicate.fileCount += 1;
    assert.throws(() => validateTerminalCandidateTree(duplicate), /duplicate path|sorted by normalized path/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
