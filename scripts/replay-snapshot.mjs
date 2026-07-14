#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { fetchVerified, githubReleaseAssetUrl, readSnapshot, verifyFile } from '../src/snapshot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT_PATH = path.join(ROOT, 'snapshots/latest.json');

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, shell: false, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}

async function main() {
  const snapshot = await readSnapshot(SNAPSHOT_PATH);
  const cacheRoot = path.join(ROOT, '.artifacts/cache', snapshot.snapshotId, snapshot.release.archive.sha256);
  const archive = path.join(cacheRoot, path.basename(snapshot.release.archive.path));
  const extracted = path.join(cacheRoot, 'extracted');
  try {
    await verifyFile(archive, snapshot.release.archive);
  } catch {
    await fetchVerified([githubReleaseAssetUrl(snapshot)], archive, snapshot.release.archive);
  }
  await rm(extracted, { recursive: true, force: true });
  await mkdir(extracted, { recursive: true });
  await run('tar', ['-xzf', archive, '-C', extracted]);
  const result = path.join(extracted, snapshot.dataset.root, 'raw/matches/result.json');
  await run(process.execPath, [path.join(ROOT, 'bin/agentbattler.mjs'), 'replay', result]);
}

main().catch((error) => {
  console.error(`Snapshot replay: ${error.message}`);
  process.exitCode = 1;
});
