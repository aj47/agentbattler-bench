#!/usr/bin/env node
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MATCHES_OUTPUT = path.join(ROOT, 'web/out/matches');

async function main() {
  const snapshot = JSON.parse(await readFile(path.join(ROOT, 'snapshots/latest-results.json'), 'utf8'));
  const expectedReplayPages = snapshot.totals.matches;
  const entries = await readdir(MATCHES_OUTPUT, { withFileTypes: true });
  let replayPages = 0;
  let removedPayloads = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const route = path.join(MATCHES_OUTPUT, entry.name);
    await stat(path.join(route, 'index.html'));
    replayPages += 1;
    try {
      await rm(path.join(route, 'index.txt'));
      removedPayloads += 1;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  if (replayPages !== expectedReplayPages) {
    throw new Error(`Expected ${expectedReplayPages} replay pages, found ${replayPages}`);
  }
  console.log(`Kept ${replayPages} replay HTML pages; removed ${removedPayloads} redundant RSC payloads for Pages deployment.`);
}

main().catch((error) => {
  console.error(`AgentBattler static export pruning: ${error.message}`);
  process.exitCode = 1;
});
