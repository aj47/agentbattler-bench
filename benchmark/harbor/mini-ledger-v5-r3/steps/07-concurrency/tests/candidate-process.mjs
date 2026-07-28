import { chmod, chown, copyFile, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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
  return candidateIdentity() ?? {};
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

export async function withCandidateWorkspace(sourceLedger, label, callback) {
  const sourceStat = await lstat(sourceLedger);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error('ledger.mjs must be a regular source file');
  const workspace = await mkdtemp(path.join(os.tmpdir(), `agentbattler-${label}-`));
  const ledgerPath = path.join(workspace, 'ledger.mjs');
  try {
    await candidateOwnedDirectory(workspace);
    await copyCandidateFile(sourceLedger, ledgerPath, 0o750);
    return await callback({ workspace, ledgerPath });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
