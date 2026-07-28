#!/usr/bin/env node
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createExhaustiveTerminalSchedule,
  createMiniLedgerChallenge,
  MINI_LEDGER_V4_STAGES,
  MINI_LEDGER_V3_STAGES,
  validateTerminalSchedule,
} from '../src/terminal-challenge.mjs';
import { MINI_LEDGER_V5_TURN_LIMIT_MS } from '../src/terminal-prompts-v5.mjs';
import { bindTerminalHarnessRuntime } from '../src/terminal-harness-versions.mjs';
import { canonicalJson, canonicalJsonSha256, sha256File } from '../src/provenance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const challengeVersion = process.env.AGENTBATTLER_TERMINAL_CHALLENGE_VERSION ?? 'v2';
if (!/^v\d+$/.test(challengeVersion)) throw new Error('AGENTBATTLER_TERMINAL_CHALLENGE_VERSION must look like v2');
const isHarborChallenge = challengeVersion === 'v4' || challengeVersion === 'v5';
const challengeSourceVersion = challengeVersion === 'v5' ? 'v4' : challengeVersion;
const protocolRevision = challengeVersion === 'v5' ? process.env.AGENTBATTLER_TERMINAL_PROTOCOL_REVISION ?? 'r2' : null;
const resultTag = process.env.AGENTBATTLER_TERMINAL_RESULT_TAG ?? (challengeVersion === 'v5' ? `v5-${protocolRevision}` : challengeVersion);
if (!/^v\d+(?:-[a-z0-9-]+)?$/.test(resultTag)) throw new Error('AGENTBATTLER_TERMINAL_RESULT_TAG must look like v4-harbor');
const challengeRoot = path.join(ROOT, `benchmark/challenges/mini-ledger-${challengeSourceVersion}`);
const challengeId = `terminal-mini-ledger-${challengeVersion}`;
const outputRoot = path.join(ROOT, `results/terminal-mini-ledger-${resultTag}`);
const harborTaskVersion = challengeVersion === 'v5' ? `v5-${protocolRevision}` : 'v4';
const harborTaskRoot = path.join(ROOT, `benchmark/harbor/mini-ledger-${harborTaskVersion}`);
const manifestPath = path.resolve(ROOT, process.env.AGENTBATTLER_TERMINAL_MANIFEST ?? 'agents/harness-suite/manifest.json');
function selection(name) {
  return (process.env[name] ?? '').split(',').map((value) => value.trim()).filter(Boolean);
}
const selectedHarnesses = selection('AGENTBATTLER_TERMINAL_HARNESSES');
const selectedModels = selection('AGENTBATTLER_TERMINAL_MODELS');
const requestedMaxWallTime = process.env.AGENTBATTLER_TERMINAL_MAX_WALL_TIME_MS;
const maxWallTimeMs = requestedMaxWallTime === undefined
  ? challengeVersion === 'v5' ? MINI_LEDGER_V5_TURN_LIMIT_MS : challengeVersion === 'v4' ? null : undefined
  : requestedMaxWallTime === '0'
    ? null
    : Number.parseInt(requestedMaxWallTime, 10);
if (requestedMaxWallTime !== undefined && !(maxWallTimeMs === null || Number.isSafeInteger(maxWallTimeMs) && maxWallTimeMs > 0)) {
  throw new Error('AGENTBATTLER_TERMINAL_MAX_WALL_TIME_MS must be 0 or a positive integer');
}
if (challengeVersion === 'v5' && maxWallTimeMs !== MINI_LEDGER_V5_TURN_LIMIT_MS) {
  throw new Error(`V5 has a fixed ${MINI_LEDGER_V5_TURN_LIMIT_MS} ms per-turn limit; create a new benchmark version to use a different policy`);
}

async function directoryFingerprint(directory, relative = '') {
  const records = [];
  const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) records.push(...await directoryFingerprint(directory, child));
    else if (entry.isFile()) records.push({ path: child, sha256: await sha256File(path.join(directory, child)) });
  }
  return records;
}

const harborTaskSha256 = isHarborChallenge
  ? canonicalJsonSha256(await directoryFingerprint(harborTaskRoot))
  : null;
const executionAdapters = isHarborChallenge ? {
  dispatcher: { path: 'scripts/terminal-adapter-all.mjs', sha256: await sha256File(path.join(ROOT, 'scripts/terminal-adapter-all.mjs')) },
  harbor: { path: 'scripts/terminal-adapter-harbor.mjs', sha256: await sha256File(path.join(ROOT, 'scripts/terminal-adapter-harbor.mjs')) },
  piHarbor: { path: 'benchmark/harbor/pi_agent.py', sha256: await sha256File(path.join(ROOT, 'benchmark/harbor/pi_agent.py')) },
  claudeHarbor: { path: 'benchmark/harbor/claude_agent.py', sha256: await sha256File(path.join(ROOT, 'benchmark/harbor/claude_agent.py')) },
  claudeCompaction: { path: 'src/claude-compaction.mjs', sha256: await sha256File(path.join(ROOT, 'src/claude-compaction.mjs')) },
  anthropicOverflowCompat: { path: 'src/anthropic-overflow-compat.mjs', sha256: await sha256File(path.join(ROOT, 'src/anthropic-overflow-compat.mjs')) },
  dotagents: { path: 'scripts/terminal-adapter-dotagents.mjs', sha256: await sha256File(path.join(ROOT, 'scripts/terminal-adapter-dotagents.mjs')) },
  candidateProcess: { path: 'benchmark/challenges/candidate-process.mjs', sha256: await sha256File(path.join(ROOT, 'benchmark/challenges/candidate-process.mjs')) },
  publicVerifier: { path: `benchmark/challenges/mini-ledger-${challengeSourceVersion}/public-verifier.mjs`, sha256: await sha256File(path.join(challengeRoot, 'public-verifier.mjs')) },
  holdoutVerifier: { path: `benchmark/challenges/mini-ledger-${challengeSourceVersion}/holdout-verifier.mjs`, sha256: await sha256File(path.join(challengeRoot, 'holdout-verifier.mjs')) },
  challengeRuntime: { path: 'src/terminal-challenge-runtime.mjs', sha256: await sha256File(path.join(ROOT, 'src/terminal-challenge-runtime.mjs')) },
  terminalPrompts: { path: challengeVersion === 'v5' ? 'src/terminal-prompts-v5.mjs' : 'src/terminal-prompts-v4.mjs', sha256: await sha256File(path.join(ROOT, challengeVersion === 'v5' ? 'src/terminal-prompts-v5.mjs' : 'src/terminal-prompts-v4.mjs')) },
  harnessVersions: { path: 'src/terminal-harness-versions.mjs', sha256: await sha256File(path.join(ROOT, 'src/terminal-harness-versions.mjs')) },
} : null;

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
  publicVerifierPath: `benchmark/challenges/mini-ledger-${challengeSourceVersion}/public-verifier.mjs`,
  holdoutVerifierPath: `benchmark/challenges/mini-ledger-${challengeSourceVersion}/holdout-verifier.mjs`,
  promptSha256,
  publicVerifierSha256,
  holdoutVerifierSha256,
  ...(isHarborChallenge ? { stages: MINI_LEDGER_V4_STAGES, turns: 15, holdoutCases: 11, network: 'agent-public; verifier-and-candidate-offline', execution: { substrate: 'harbor', version: '0.20.0', taskPath: `benchmark/harbor/mini-ledger-${harborTaskVersion}`, taskSha256: harborTaskSha256, adapters: executionAdapters, ...(challengeVersion === 'v5' ? { predecessor: 'terminal-mini-ledger-v4', protocolRevision, amendment: protocolRevision === 'r3' ? 'dotagents-v1.1.9-prompt-cache-continuity-and-cumulative-usage-fix' : 'fixed-turns-explicit-wire-contract-source-only-verification' } : {}) }, scoring: { visibleStagePoints: 70, holdoutPoints: 30, maxPoints: 100, tieTolerancePoints: 1, regressionPenalty: 0, infrastructureInvalid: true } } : {}),
  ...(challengeVersion === 'v3' ? { stages: MINI_LEDGER_V3_STAGES, turns: 12 } : {}),
  ...(maxWallTimeMs === undefined ? {} : { maxWallTimeMs }),
});
const availableHarnesses = manifest.comparison?.harnesses ?? [...new Set(manifest.agents.map((agent) => agent.provenance.harness))];
const availableModels = manifest.comparison?.models ?? [...new Set(manifest.agents.map((agent) => agent.provenance.modelRequested))];
const expectedHarnesses = selectedHarnesses.length ? selectedHarnesses : availableHarnesses;
const expectedModels = selectedModels.length ? selectedModels : availableModels;
for (const harness of expectedHarnesses) if (!availableHarnesses.includes(harness)) throw new Error(`Requested terminal harness is absent from the manifest: ${harness}`);
for (const model of expectedModels) if (!availableModels.includes(model)) throw new Error(`Requested terminal model is absent from the manifest: ${model}`);
const generationsPerCombo = manifest.comparison?.generationsPerHarnessModel ?? Math.max(...manifest.agents.map((agent) => agent.generationIndex ?? agent.provenance.generationIndex ?? 0));
const terminalAgents = manifest.agents.filter((agent) => expectedHarnesses.includes(agent.provenance.harness) && expectedModels.includes(agent.provenance.modelRequested)).map((sourceAgent) => {
  const agent = bindTerminalHarnessRuntime(sourceAgent);
  return {
    ...agent,
    id: `terminal-${agent.provenance.harness}-${agent.provenance.modelFamilyId}-${String(agent.generationIndex ?? agent.provenance.generationIndex).padStart(2, '0')}`,
  };
});
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
if (challengeVersion === 'v5') {
  try {
    const existing = JSON.parse(await readFile(path.join(outputRoot, 'challenge.json'), 'utf8'));
    if (existing.challengeSha256 !== challenge.challengeSha256) {
      const persistedRuns = await readdir(path.join(outputRoot, 'runs')).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error));
      const persistedAttempts = await readdir(path.join(outputRoot, 'attempts')).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error));
      if (persistedRuns.length > 0 || persistedAttempts.length > 0) {
        throw new Error(`Refusing to replace sealed V5 challenge ${existing.challengeId}; choose a new AGENTBATTLER_TERMINAL_RESULT_TAG for a different protocol`);
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}
await mkdir(outputRoot, { recursive: true });
await writeFile(path.join(outputRoot, 'challenge.json'), `${canonicalJson(challenge, { space: 2 })}\n`);
await writeFile(path.join(outputRoot, 'schedule.json'), `${canonicalJson(schedule, { space: 2 })}\n`);
console.log(`Challenge: ${challenge.id} (${challenge.challengeId})`);
console.log(`Turn wall-time policy: ${challenge.protocol.maxWallTimeMs === null ? 'unbounded' : `${challenge.protocol.maxWallTimeMs} ms maximum`}`);
console.log(`Matrix: ${expectedHarnesses.length} harnesses × ${expectedModels.length} models × ${generationsPerCombo} generations = ${schedule.jobs.length} runs`);
console.log(`Schedule: ${path.join(outputRoot, 'schedule.json')}`);
