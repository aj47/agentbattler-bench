import { chmod, copyFile, lstat, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { materializeV7Starter } from '../benchmark/challenges/mini-ledger-v7/pack.mjs';
import {
  applyTerminalCandidateTreeOverlay,
  normalizeTerminalCandidatePath,
  snapshotTerminalCandidateTree,
  validateCapturedTerminalCandidateTree,
} from './terminal-candidate-tree.mjs';
import { canonicalJson } from './provenance.mjs';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function contained(root, relative) {
  const normalized = normalizeTerminalCandidatePath(relative);
  const resolved = path.resolve(root, ...normalized.split('/'));
  const relation = path.relative(root, resolved);
  invariant(relation !== '..' && !relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation), `V7 overlay path escapes its root: ${relative}`);
  return resolved;
}

export async function materializeTerminalV7Candidate({
  pack,
  candidateTree,
  runDirectory,
  destination,
  baselineDirectory,
  policy,
}) {
  invariant(candidateTree?.kind === 'overlay', 'V7 grading requires a candidate-tree overlay');
  invariant(path.isAbsolute(runDirectory) && path.isAbsolute(destination) && path.isAbsolute(baselineDirectory), 'V7 overlay directories must be absolute');
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await materializeV7Starter({ pack, destination });
  const baseline = await snapshotTerminalCandidateTree({ root: baselineDirectory, policy });
  await validateCapturedTerminalCandidateTree({ runDirectory, evidence: candidateTree, base: baseline });
  const expected = applyTerminalCandidateTreeOverlay(baseline, candidateTree);

  for (const deletion of candidateTree.deletions) await rm(contained(destination, deletion), { force: true });
  const archiveRoot = contained(runDirectory, candidateTree.archivePath);
  for (const file of candidateTree.files) {
    const source = contained(archiveRoot, file.path);
    const sourceStat = await lstat(source);
    invariant(sourceStat.isFile() && !sourceStat.isSymbolicLink() && sourceStat.nlink === 1, `V7 archived overlay entry is unsafe: ${file.path}`);
    const target = contained(destination, file.path);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(source, target);
    await chmod(target, Number.parseInt(file.mode, 8));
  }

  const observed = await snapshotTerminalCandidateTree({ root: destination, policy });
  invariant(canonicalJson(observed) === canonicalJson(expected), 'V7 fresh-tree overlay application did not reproduce the captured candidate tree');
  return { workspace: destination, baseline, candidateTree, fullTree: observed };
}
