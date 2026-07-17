#!/usr/bin/env node
import { gunzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { importRunResult } from '../src/game-ledger.mjs';
import { sha256 } from '../src/provenance.mjs';
import { fetchVerified, verifyFile } from '../src/snapshot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArguments(argv) {
  const options = {
    snapshotPath: path.join(ROOT, 'snapshots/latest-results.json'),
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

function resolveUrl(snapshot, artifact) {
  const repo = snapshot.dataset.repoId.split('/').map(encodeURIComponent).join('/');
  const objectPath = artifact.path.split('/').map(encodeURIComponent).join('/');
  return `https://huggingface.co/datasets/${repo}/resolve/${snapshot.dataset.revision}/${objectPath}`;
}

async function fetchArtifact(snapshot, artifact) {
  const cache = path.join(ROOT, '.artifacts/cache', snapshot.snapshotId, artifact.sha256, path.basename(artifact.path));
  try {
    await verifyFile(cache, artifact);
  } catch {
    await fetchVerified([resolveUrl(snapshot, artifact)], cache, artifact);
  }
  return cache;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const snapshot = JSON.parse(await readFile(options.snapshotPath, 'utf8'));
  invariant(snapshot.schemaVersion === 'agentbattler.results-snapshot.v1', 'Unsupported results snapshot schema');
  invariant(/^[0-9a-f]{64}$/.test(snapshot.snapshotSha256 ?? ''), 'Results snapshot SHA-256 is invalid');
  const artifacts = [
    snapshot.artifacts.claudeResult,
    snapshot.artifacts.threeHarnessResult,
    ...(snapshot.artifacts.dotagentsPlacementResults ?? []),
  ];
  let imported = 0;
  let existing = 0;
  let skippedVoid = 0;
  for (const artifact of artifacts) {
    const file = await fetchArtifact(snapshot, artifact);
    const canonical = gunzipSync(await readFile(file));
    invariant(sha256(canonical) === artifact.canonicalSha256, `Canonical result hash mismatch for ${artifact.path}`);
    const result = JSON.parse(canonical.toString('utf8'));
    invariant(result.games.length === artifact.games, `Game count mismatch for ${artifact.path}`);
    const summary = await importRunResult(options.ledgerPath, result, { snapshotId: snapshot.snapshotId });
    imported += summary.imported;
    existing += summary.existing;
    skippedVoid += summary.skippedVoid;
  }
  console.log(`Results snapshot ${snapshot.snapshotId}: ${imported} games imported, ${existing} already present, ${skippedVoid} retryable voids skipped.`);
}

main().catch((error) => {
  console.error(`Results ledger import: ${error.message}`);
  process.exitCode = 1;
});
