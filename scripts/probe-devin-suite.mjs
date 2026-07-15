#!/usr/bin/env node
/**
 * One-agent-safe validation for the Devin exploratory suite.
 * Checks roster identity hashes and runs v2 legality probes without requiring ≥2 agents.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { isLegalUciMove, parseFen } from '../src/chess.mjs';
import { runAgentMove, validateAgent } from '../src/runner.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = process.env.AGENTBATTLER_DEVIN_MANIFEST
  ? path.resolve(process.env.AGENTBATTLER_DEVIN_MANIFEST)
  : path.join(ROOT, 'agents/devin-suite/manifest.json');
const POSITIONS_PATH = process.env.AGENTBATTLER_POSITIONS
  ? path.resolve(process.env.AGENTBATTLER_POSITIONS)
  : path.join(ROOT, 'benchmark/positions/v2.json');

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function repoPath(relative, label) {
  invariant(typeof relative === 'string' && relative.length > 0, `${label} must be a non-empty path`);
  const absolute = path.resolve(ROOT, relative);
  const inside = path.relative(ROOT, absolute);
  invariant(inside && !inside.startsWith(`..${path.sep}`) && !path.isAbsolute(inside), `${label} escapes the repository`);
  return absolute;
}

async function main() {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  const suite = JSON.parse(await readFile(POSITIONS_PATH, 'utf8'));
  invariant(manifest.schemaVersion === 'agentbattler.agent-manifest.v1', 'Unsupported agent manifest schema');
  invariant(suite.schemaVersion === 'agentbattler.position-suite.v1', 'Unsupported position suite schema');
  invariant(Array.isArray(manifest.agents) && manifest.agents.length >= 1, 'Devin suite roster must contain at least one agent');
  invariant(Array.isArray(suite.positions) && suite.positions.length > 0, 'Position suite must not be empty');

  const ids = new Set();
  let totalProbes = 0;
  let passedProbes = 0;

  for (const entry of manifest.agents) {
    invariant(typeof entry.id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(entry.id), 'Agent has an invalid stable ID');
    invariant(!ids.has(entry.id), `Duplicate agent ID: ${entry.id}`);
    ids.add(entry.id);
    invariant(entry.provenance && typeof entry.provenance.kind === 'string', `Missing provenance for ${entry.id}`);

    const sourcePath = repoPath(entry.source, `source for ${entry.id}`);
    const identity = await validateAgent(sourcePath);
    invariant(identity.sourceSha256 === entry.sourceSha256, `Source hash mismatch for ${entry.id}`);

    for (const position of suite.positions) {
      totalProbes += 1;
      const attempt = await runAgentMove({ agentPath: sourcePath, fen: position.fen });
      const legal = attempt.status === 'ok' && isLegalUciMove(parseFen(position.fen), attempt.move);
      if (!legal) {
        throw new Error(
          `${entry.id} failed probe ${position.id}: status=${attempt.status} `
          + `move=${attempt.move ?? 'null'} detail=${attempt.detail ?? 'n/a'}`,
        );
      }
      passedProbes += 1;
    }
    console.log(`${entry.id}: ${suite.positions.length}/${suite.positions.length} probes ok (${identity.sizeBytes} bytes)`);
  }

  console.log(`Devin suite probe: ${manifest.agents.length} agent(s), ${passedProbes}/${totalProbes} probes passed`);
}

main().catch((error) => {
  console.error(`AgentBattler Devin probe: ${error.message}`);
  process.exitCode = 1;
});
