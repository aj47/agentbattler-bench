#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { importRunResult } from '../src/game-ledger.mjs';
import { fetchVerified, githubReleaseAssetUrl, readSnapshot, verifyFile } from '../src/snapshot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArguments(argv) {
  const options = {
    snapshotPath: path.join(ROOT, 'snapshots/model-suite-2026-07-15-five-v1.json'),
    ledgerPath: path.join(ROOT, 'results/league/ledger'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--snapshot') options.snapshotPath = path.resolve(argv[++index]);
    else if (value === '--ledger') options.ledgerPath = path.resolve(argv[++index]);
    else throw new Error(`Unexpected argument: ${value}`);
  }
  return options;
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, shell: false, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const snapshot = await readSnapshot(options.snapshotPath);
  const cacheRoot = path.join(ROOT, '.artifacts/cache', snapshot.snapshotId, snapshot.release.archive.sha256);
  const archive = path.join(cacheRoot, path.basename(snapshot.release.archive.path));
  const extracted = path.join(cacheRoot, 'ledger-import');
  try {
    await verifyFile(archive, snapshot.release.archive);
  } catch {
    await fetchVerified([githubReleaseAssetUrl(snapshot)], archive, snapshot.release.archive);
  }
  await rm(extracted, { recursive: true, force: true });
  await mkdir(extracted, { recursive: true });
  await run('tar', ['-xzf', archive, '-C', extracted]);
  const resultPath = path.join(extracted, snapshot.dataset.root, 'raw/matches/result.json');
  const result = JSON.parse(await readFile(resultPath, 'utf8'));
  const summary = await importRunResult(options.ledgerPath, result, { snapshotId: snapshot.snapshotId });
  console.log(`Snapshot ${snapshot.snapshotId}: ${summary.imported} games imported, ${summary.existing} already present, ${summary.skippedVoid} retryable voids skipped.`);
  console.log(`Protocol: ${summary.protocol.protocolId}`);
}

main().catch((error) => {
  console.error(`Snapshot ledger import: ${error.message}`);
  process.exitCode = 1;
});
