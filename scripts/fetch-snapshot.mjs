#!/usr/bin/env node
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  fetchVerified,
  githubReleaseAssetUrl,
  huggingFaceResolveUrl,
  readSnapshot,
  verifyFile,
} from '../src/snapshot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArguments(argv) {
  const options = {
    snapshot: path.join(ROOT, 'snapshots/latest.json'),
    artifact: 'site-data',
    output: path.join(ROOT, 'web/generated/site-data.json'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--snapshot') options.snapshot = path.resolve(argv[++index]);
    else if (value === '--artifact') options.artifact = argv[++index];
    else if (value === '--output') options.output = path.resolve(argv[++index]);
    else throw new Error(`Unexpected argument: ${value}`);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const snapshot = await readSnapshot(options.snapshot);
  if (options.artifact === 'site-data') {
    const artifact = snapshot.dataset.siteData;
    const cache = path.join(ROOT, '.artifacts/cache', snapshot.snapshotId, artifact.sha256, path.basename(artifact.path));
    try {
      await verifyFile(cache, artifact);
    } catch {
      await fetchVerified([huggingFaceResolveUrl(snapshot, artifact)], cache, artifact);
    }
    await mkdir(path.dirname(options.output), { recursive: true });
    await copyFile(cache, options.output);
    console.log(`Fetched verified ${artifact.path} to ${path.relative(ROOT, options.output)}.`);
    return;
  }
  if (options.artifact === 'archive') {
    const artifact = snapshot.release.archive;
    await fetchVerified([githubReleaseAssetUrl(snapshot, artifact)], options.output, artifact);
    console.log(`Fetched verified ${artifact.path} to ${path.relative(ROOT, options.output)}.`);
    return;
  }
  throw new Error(`Unsupported artifact: ${options.artifact}`);
}

main().catch((error) => {
  console.error(`Snapshot fetch: ${error.message}`);
  process.exitCode = 1;
});
