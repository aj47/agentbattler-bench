#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { validateSnapshot } from '../src/snapshot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIRECTORY = path.join(ROOT, 'snapshots');

async function main() {
  const files = (await readdir(DIRECTORY)).filter((name) => name.endsWith('.json')).sort();
  if (files.length === 0) throw new Error('No committed snapshot manifests found');
  const ids = new Set();
  for (const name of files) {
    const snapshot = validateSnapshot(JSON.parse(await readFile(path.join(DIRECTORY, name), 'utf8')));
    if (name !== 'latest.json' && ids.has(snapshot.snapshotId)) throw new Error(`Duplicate snapshotId: ${snapshot.snapshotId}`);
    if (name !== 'latest.json') ids.add(snapshot.snapshotId);
  }
  console.log(`Validated ${ids.size} immutable snapshot manifest${ids.size === 1 ? '' : 's'} and latest pointer.`);
}

main().catch((error) => {
  console.error(`Snapshot validation: ${error.message}`);
  process.exitCode = 1;
});
