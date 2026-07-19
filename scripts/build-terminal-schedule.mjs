#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createExhaustiveTerminalSchedule,
  createMiniLedgerChallenge,
  MINI_LEDGER_V4_STAGES,
  MINI_LEDGER_V3_STAGES,
  validateTerminalSchedule,
} from '../src/terminal-challenge.mjs';
import { canonicalJson, sha256File } from '../src/provenance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const challengeVersion = process.env.AGENTBATTLER_TERMINAL_CHALLENGE_VERSION ?? 'v2';
if (!/^v\d+$/.test(challengeVersion)) throw new Error('AGENTBATTLER_TERMINAL_CHALLENGE_VERSION must look like v2');
const challengeRoot = path.join(ROOT, `benchmark/challenges/mini-ledger-${challengeVersion}`);
const challengeId = `terminal-mini-ledger-${challengeVersion}`;
const outputRoot = path.join(ROOT, `results/terminal-mini-ledger-${challengeVersion}`);
const manifestPath = path.resolve(ROOT, process.env.AGENTBATTLER_TERMINAL_MANIFEST ?? 'agents/harness-suite/manifest.json');
const requestedMaxWallTime = process.env.AGENTBATTLER_TERMINAL_MAX_WALL_TIME_MS;
const maxWallTimeMs = requestedMaxWallTime === undefined
  ? undefined
  : requestedMaxWallTime === '0'
    ? null
    : Number.parseInt(requestedMaxWallTime, 10);
if (requestedMaxWallTime !== undefined && !(maxWallTimeMs === null || Number.isSafeInteger(maxWallTimeMs) && maxWallTimeMs > 0)) {
  throw new Error('AGENTBATTLER_TERMINAL_MAX_WALL_TIME_MS must be 0 or a positive integer');
}

const [promptSha256, publicVerifierSha256, holdoutVerifierSha256, manifest] = await Promise.all([
  sha256File(path.join(ROOT, `benchmark/challenges/mini-ledger-${challengeVersion}.md`)),
  sha256File(path.join(challengeRoot, 'public-verifier.mjs')),
  sha256File(path.join(challengeRoot, 'holdout-verifier.mjs')),
  readFile(manifestPath, 'utf8').then(JSON.parse),
]);
const challenge = createMiniLedgerChallenge({
  challengeId,
  title: `Mini Ledger ${challengeVersion}`,
  promptPath: `benchmark/challenges/mini-ledger-${challengeVersion}.md`,
  publicVerifierPath: `benchmark/challenges/mini-ledger-${challengeVersion}/public-verifier.mjs`,
  holdoutVerifierPath: `benchmark/challenges/mini-ledger-${challengeVersion}/holdout-verifier.mjs`,
  promptSha256,
  publicVerifierSha256,
  holdoutVerifierSha256,
  ...(challengeVersion === 'v4' ? { stages: MINI_LEDGER_V4_STAGES, turns: 15, holdoutCases: 11, scoring: { visibleStagePoints: 70, holdoutPoints: 30, maxPoints: 100, tieTolerancePoints: 1, regressionPenalty: 0, infrastructureInvalid: true } } : {}),
  ...(challengeVersion === 'v3' ? { stages: MINI_LEDGER_V3_STAGES, turns: 12 } : {}),
  ...(maxWallTimeMs === undefined ? {} : { maxWallTimeMs }),
});
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
console.log(`Turn wall-time policy: ${challenge.protocol.maxWallTimeMs === null ? 'unbounded' : `${challenge.protocol.maxWallTimeMs} ms maximum`}`);
console.log(`Matrix: ${expectedHarnesses.length} harnesses × ${expectedModels.length} models × ${generationsPerCombo} generations = ${schedule.jobs.length} runs`);
console.log(`Schedule: ${path.join(outputRoot, 'schedule.json')}`);
