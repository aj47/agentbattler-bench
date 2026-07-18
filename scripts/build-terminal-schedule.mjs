#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createExhaustiveTerminalSchedule,
  createMiniLedgerChallenge,
  validateTerminalSchedule,
} from '../src/terminal-challenge.mjs';
import { canonicalJson, sha256File } from '../src/provenance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const challengeRoot = path.join(ROOT, 'benchmark/challenges/mini-ledger-v1');
const outputRoot = path.join(ROOT, 'results/terminal-mini-ledger');
const manifestPath = path.resolve(ROOT, process.env.AGENTBATTLER_TERMINAL_MANIFEST ?? 'agents/harness-suite/manifest.json');

const [promptSha256, publicVerifierSha256, holdoutVerifierSha256, manifest] = await Promise.all([
  sha256File(path.join(ROOT, 'benchmark/challenges/mini-ledger-v1.md')),
  sha256File(path.join(challengeRoot, 'public-verifier.mjs')),
  sha256File(path.join(challengeRoot, 'holdout-verifier.mjs')),
  readFile(manifestPath, 'utf8').then(JSON.parse),
]);
const challenge = createMiniLedgerChallenge({ promptSha256, publicVerifierSha256, holdoutVerifierSha256 });
const expectedHarnesses = manifest.comparison?.harnesses ?? [...new Set(manifest.agents.map((agent) => agent.provenance.harness))];
const expectedModels = manifest.comparison?.models ?? [...new Set(manifest.agents.map((agent) => agent.provenance.modelRequested))];
const generationsPerCombo = manifest.comparison?.generationsPerHarnessModel ?? Math.max(...manifest.agents.map((agent) => agent.generationIndex ?? agent.provenance.generationIndex ?? 0));
const terminalAgents = manifest.agents.map((agent) => ({
  ...agent,
  id: `terminal-${agent.provenance.harness}-${agent.provenance.modelFamilyId}-${String(agent.generationIndex ?? agent.provenance.generationIndex).padStart(2, '0')}`,
}));
const schedule = createExhaustiveTerminalSchedule({
  challenge,
  agents: terminalAgents,
  expectedHarnesses,
  expectedModels,
  generationsPerCombo,
  repeats: Number.parseInt(process.env.AGENTBATTLER_TERMINAL_REPEATS ?? '1', 10),
  seed: Number.parseInt(process.env.AGENTBATTLER_TERMINAL_SEED ?? '1', 10),
});
validateTerminalSchedule(schedule, challenge);
await mkdir(outputRoot, { recursive: true });
await writeFile(path.join(outputRoot, 'challenge.json'), `${canonicalJson(challenge, { space: 2 })}\n`);
await writeFile(path.join(outputRoot, 'schedule.json'), `${canonicalJson(schedule, { space: 2 })}\n`);
console.log(`Challenge: ${challenge.id} (${challenge.challengeId})`);
console.log(`Matrix: ${expectedHarnesses.length} harnesses × ${expectedModels.length} models × ${generationsPerCombo} generations = ${schedule.jobs.length} runs`);
console.log(`Schedule: ${path.join(outputRoot, 'schedule.json')}`);
