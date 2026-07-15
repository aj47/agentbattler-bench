#!/usr/bin/env node
/**
 * Preflight for Devin suite tournament runs: require ≥2 agents, then delegate to agentbattler.
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = path.join(ROOT, 'agents/devin-suite/manifest.json');
const CLI = path.join(ROOT, 'bin/agentbattler.mjs');

async function main() {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  const count = Array.isArray(manifest.agents) ? manifest.agents.length : 0;
  if (count < 2) {
    throw new Error(
      `Devin tournament requires ≥2 agents in agents/devin-suite/manifest.json (found ${count}). `
      + 'Generate additional free-model samples first, e.g. '
      + 'AGENTBATTLER_DEVIN_MODELS=swe-1.7,glm-5.2-high AGENTBATTLER_GENERATIONS_PER_MODEL=1 npm run generate:devin-suite. '
      + 'For the committed one-agent smoke sample use: npm run validate:devin-suite',
    );
  }

  const args = [
    CLI,
    'run',
    '--manifest', 'agents/devin-suite/manifest.json',
    '--positions', 'benchmark/positions/v2.json',
    '--pairing', 'all-pairs',
    '--output', 'results/devin-suite/matches',
    '--no-smoke',
    ...process.argv.slice(2),
  ];
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit',
    shell: false,
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  process.exitCode = exitCode === null ? 1 : exitCode;
}

main().catch((error) => {
  console.error(`AgentBattler Devin benchmark: ${error.message}`);
  process.exitCode = 1;
});
