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
import { MINI_LEDGER_V6_TURN_LIMIT_MS } from '../src/terminal-prompts-v6.mjs';
import { bindTerminalHarnessRuntime, SEALED_TERMINAL_HARNESS_VERSIONS } from '../src/terminal-harness-versions.mjs';
import { createTerminalRuntimeRoster } from '../src/terminal-roster.mjs';
import { canonicalJson, canonicalJsonSha256, sha256File } from '../src/provenance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const challengeVersion = process.env.AGENTBATTLER_TERMINAL_CHALLENGE_VERSION ?? 'v2';
if (!/^v\d+$/.test(challengeVersion)) throw new Error('AGENTBATTLER_TERMINAL_CHALLENGE_VERSION must look like v2');
const isV6 = challengeVersion === 'v6';
const isHarborChallenge = challengeVersion === 'v4' || challengeVersion === 'v5' || isV6;
const challengeSourceVersion = challengeVersion === 'v5' ? 'v4' : challengeVersion;
const protocolRevision = challengeVersion === 'v5'
  ? process.env.AGENTBATTLER_TERMINAL_PROTOCOL_REVISION ?? 'r2'
  : isV6 ? process.env.AGENTBATTLER_TERMINAL_PROTOCOL_REVISION ?? 'r13' : null;
const resultTag = process.env.AGENTBATTLER_TERMINAL_RESULT_TAG ?? (challengeVersion === 'v5' ? `v5-${protocolRevision}` : isV6 ? `v6-luna-max-${protocolRevision}` : challengeVersion);
if (!/^v\d+(?:-[a-z0-9-]+)?$/.test(resultTag)) throw new Error('AGENTBATTLER_TERMINAL_RESULT_TAG must look like v4-harbor');
const challengeRoot = path.join(ROOT, `benchmark/challenges/mini-ledger-${challengeSourceVersion}`);
const challengeId = `terminal-mini-ledger-${challengeVersion}`;
const outputRoot = path.join(ROOT, `results/terminal-mini-ledger-${resultTag}`);
const harborTaskVersion = challengeVersion === 'v5' ? `v5-${protocolRevision}` : isV6 ? 'v6' : 'v4';
const harborTaskRoot = path.join(ROOT, `benchmark/harbor/mini-ledger-${harborTaskVersion}`);
const manifestPath = path.resolve(ROOT, process.env.AGENTBATTLER_TERMINAL_MANIFEST ?? 'agents/harness-suite/manifest.json');
const useRuntimeRoster = isV6 || process.env.AGENTBATTLER_TERMINAL_RUNTIME_ROSTER === '1';
if (useRuntimeRoster && !['v5', 'v6'].includes(challengeVersion)) throw new Error('The terminal runtime roster is available only for V5 and V6 schedules');
function selection(name) {
  return (process.env[name] ?? '').split(',').map((value) => value.trim()).filter(Boolean);
}
function invariantV6Schedule(schedule) {
  const sealedHarnesses = Object.keys(SEALED_TERMINAL_HARNESS_VERSIONS).sort();
  if (canonicalJson(schedule.matrix.harnesses) !== canonicalJson(sealedHarnesses)) throw new Error('V6 schedule must contain every sealed terminal harness exactly once');
  if (schedule.matrix.models.length !== 1 || schedule.matrix.models[0] !== 'gpt-5.6-luna') throw new Error('V6 schedule contains a model other than gpt-5.6-luna');
  if (schedule.matrix.generationsPerCombo !== 5 || schedule.matrix.repeats !== 1 || schedule.matrix.expectedRuns !== 25 || schedule.coverage.length !== sealedHarnesses.length) throw new Error('V6 schedule must contain five independent runs for each of the five harnesses');
  if (!schedule.coverage.every((entry) => entry.combo.model.id === 'gpt-5.6-luna' && entry.combo.model.reasoningEffort === 'max')) throw new Error('V6 schedule is not uniformly Luna at max reasoning effort');
}
const selectedHarnesses = selection('AGENTBATTLER_TERMINAL_HARNESSES');
const selectedModels = selection('AGENTBATTLER_TERMINAL_MODELS');
const reasoningEffort = process.env.AGENTBATTLER_TERMINAL_REASONING_EFFORT ?? (isV6 ? 'max' : 'high');
if (isV6 && reasoningEffort !== 'max') throw new Error('V6 is sealed to max reasoning effort');
if (isV6 && selectedModels.length > 0 && (selectedModels.length !== 1 || selectedModels[0] !== 'gpt-5.6-luna')) throw new Error('V6 is sealed to gpt-5.6-luna only');
const requestedMaxWallTime = process.env.AGENTBATTLER_TERMINAL_MAX_WALL_TIME_MS;
const maxWallTimeMs = requestedMaxWallTime === undefined
  ? challengeVersion === 'v5' ? MINI_LEDGER_V5_TURN_LIMIT_MS : isV6 ? MINI_LEDGER_V6_TURN_LIMIT_MS : challengeVersion === 'v4' ? null : undefined
  : requestedMaxWallTime === '0'
    ? null
    : Number.parseInt(requestedMaxWallTime, 10);
if (requestedMaxWallTime !== undefined && !(maxWallTimeMs === null || Number.isSafeInteger(maxWallTimeMs) && maxWallTimeMs > 0)) {
  throw new Error('AGENTBATTLER_TERMINAL_MAX_WALL_TIME_MS must be 0 or a positive integer');
}
if (challengeVersion === 'v5' && maxWallTimeMs !== MINI_LEDGER_V5_TURN_LIMIT_MS) {
  throw new Error(`V5 has a fixed ${MINI_LEDGER_V5_TURN_LIMIT_MS} ms per-turn limit; create a new benchmark version to use a different policy`);
}
if (isV6 && maxWallTimeMs !== MINI_LEDGER_V6_TURN_LIMIT_MS) {
  throw new Error(`V6 has a fixed ${MINI_LEDGER_V6_TURN_LIMIT_MS} ms per-turn limit; create a new benchmark version to use a different policy`);
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
  codexHarbor: { path: 'benchmark/harbor/codex_agent.py', sha256: await sha256File(path.join(ROOT, 'benchmark/harbor/codex_agent.py')) },
  codexBwrapWrapper: { path: 'benchmark/harbor/codex_bwrap_wrapper.sh', sha256: await sha256File(path.join(ROOT, 'benchmark/harbor/codex_bwrap_wrapper.sh')) },
  piHarbor: { path: 'benchmark/harbor/pi_agent.py', sha256: await sha256File(path.join(ROOT, 'benchmark/harbor/pi_agent.py')) },
  piSandboxExtension: { path: 'benchmark/harbor/pi_sandbox_extension.mjs', sha256: await sha256File(path.join(ROOT, 'benchmark/harbor/pi_sandbox_extension.mjs')) },
  claudeHarbor: { path: 'benchmark/harbor/claude_agent.py', sha256: await sha256File(path.join(ROOT, 'benchmark/harbor/claude_agent.py')) },
  claudeBwrapWrapper: { path: 'benchmark/harbor/claude_bwrap_wrapper.sh', sha256: await sha256File(path.join(ROOT, 'benchmark/harbor/claude_bwrap_wrapper.sh')) },
  claudeCompaction: { path: 'src/claude-compaction.mjs', sha256: await sha256File(path.join(ROOT, 'src/claude-compaction.mjs')) },
  anthropicOverflowCompat: { path: 'src/anthropic-overflow-compat.mjs', sha256: await sha256File(path.join(ROOT, 'src/anthropic-overflow-compat.mjs')) },
  dotagents: { path: 'scripts/terminal-adapter-dotagents.mjs', sha256: await sha256File(path.join(ROOT, 'scripts/terminal-adapter-dotagents.mjs')) },
  dotagentsHarness: { path: 'src/dotagents-harness.mjs', sha256: await sha256File(path.join(ROOT, 'src/dotagents-harness.mjs')) },
  dotagentsDockerfile: { path: 'harnesses/dotagents/Dockerfile', sha256: await sha256File(path.join(ROOT, 'harnesses/dotagents/Dockerfile')) },
  dotagentsDockerignore: { path: 'harnesses/dotagents/.dockerignore', sha256: await sha256File(path.join(ROOT, 'harnesses/dotagents/.dockerignore')) },
  dotagentsCommandSandbox: { path: 'harnesses/dotagents/runtime-tools-sandbox.patch', sha256: await sha256File(path.join(ROOT, 'harnesses/dotagents/runtime-tools-sandbox.patch')) },
  dotagentsMaxReasoning: { path: 'harnesses/dotagents/enable-max-reasoning.mjs', sha256: await sha256File(path.join(ROOT, 'harnesses/dotagents/enable-max-reasoning.mjs')) },
  droid: { path: 'scripts/terminal-adapter-droid.mjs', sha256: await sha256File(path.join(ROOT, 'scripts/terminal-adapter-droid.mjs')) },
  droidHarness: { path: 'src/droid-harness.mjs', sha256: await sha256File(path.join(ROOT, 'src/droid-harness.mjs')) },
  droidJsonRpc: { path: 'src/droid-jsonrpc.mjs', sha256: await sha256File(path.join(ROOT, 'src/droid-jsonrpc.mjs')) },
  droidRouting: { path: 'src/droid-routing.mjs', sha256: await sha256File(path.join(ROOT, 'src/droid-routing.mjs')) },
  droidRuntime: { path: 'src/droid-runtime.mjs', sha256: await sha256File(path.join(ROOT, 'src/droid-runtime.mjs')) },
  droidSandbox: { path: 'src/droid-sandbox.mjs', sha256: await sha256File(path.join(ROOT, 'src/droid-sandbox.mjs')) },
  runEvidence: { path: 'src/terminal-run-evidence.mjs', sha256: await sha256File(path.join(ROOT, 'src/terminal-run-evidence.mjs')) },
  candidateProcess: { path: 'benchmark/challenges/candidate-process.mjs', sha256: await sha256File(path.join(ROOT, 'benchmark/challenges/candidate-process.mjs')) },
  publicVerifier: { path: `benchmark/challenges/mini-ledger-${challengeSourceVersion}/public-verifier.mjs`, sha256: await sha256File(path.join(challengeRoot, 'public-verifier.mjs')) },
  holdoutVerifier: { path: `benchmark/challenges/mini-ledger-${challengeSourceVersion}/holdout-verifier.mjs`, sha256: await sha256File(path.join(challengeRoot, 'holdout-verifier.mjs')) },
  ...(isV6 ? {
    publicVerifierV4Dependency: { path: 'benchmark/challenges/mini-ledger-v4/public-verifier.mjs', sha256: await sha256File(path.join(ROOT, 'benchmark/challenges/mini-ledger-v4/public-verifier.mjs')) },
    holdoutVerifierV4Dependency: { path: 'benchmark/challenges/mini-ledger-v4/holdout-verifier.mjs', sha256: await sha256File(path.join(ROOT, 'benchmark/challenges/mini-ledger-v4/holdout-verifier.mjs')) },
    publicVerifierV3Dependency: { path: 'benchmark/challenges/mini-ledger-v3/public-verifier.mjs', sha256: await sha256File(path.join(ROOT, 'benchmark/challenges/mini-ledger-v3/public-verifier.mjs')) },
    holdoutVerifierV3Dependency: { path: 'benchmark/challenges/mini-ledger-v3/holdout-verifier.mjs', sha256: await sha256File(path.join(ROOT, 'benchmark/challenges/mini-ledger-v3/holdout-verifier.mjs')) },
  } : {}),
  challengeRuntime: { path: 'src/terminal-challenge-runtime.mjs', sha256: await sha256File(path.join(ROOT, 'src/terminal-challenge-runtime.mjs')) },
  terminalChallenge: { path: 'src/terminal-challenge.mjs', sha256: await sha256File(path.join(ROOT, 'src/terminal-challenge.mjs')) },
  terminalRunner: { path: 'src/terminal-runner.mjs', sha256: await sha256File(path.join(ROOT, 'src/terminal-runner.mjs')) },
  terminalPrompts: { path: challengeVersion === 'v5' ? 'src/terminal-prompts-v5.mjs' : isV6 ? 'src/terminal-prompts-v6.mjs' : 'src/terminal-prompts-v4.mjs', sha256: await sha256File(path.join(ROOT, challengeVersion === 'v5' ? 'src/terminal-prompts-v5.mjs' : isV6 ? 'src/terminal-prompts-v6.mjs' : 'src/terminal-prompts-v4.mjs')) },
  harnessVersions: { path: 'src/terminal-harness-versions.mjs', sha256: await sha256File(path.join(ROOT, 'src/terminal-harness-versions.mjs')) },
  terminalRoster: { path: 'src/terminal-roster.mjs', sha256: await sha256File(path.join(ROOT, 'src/terminal-roster.mjs')) },
} : null;

const [promptSha256, publicVerifierSha256, holdoutVerifierSha256, manifest] = await Promise.all([
  sha256File(path.join(ROOT, `benchmark/challenges/mini-ledger-${challengeVersion}.md`)),
  sha256File(path.join(challengeRoot, 'public-verifier.mjs')),
  sha256File(path.join(challengeRoot, 'holdout-verifier.mjs')),
  useRuntimeRoster ? Promise.resolve(createTerminalRuntimeRoster({
    ...(isV6 ? { models: ['gpt-5.6-luna'] } : {}),
    reasoningEffort,
  })) : readFile(manifestPath, 'utf8').then(JSON.parse),
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
  ...(isHarborChallenge ? {
    stages: MINI_LEDGER_V4_STAGES,
    turns: 15,
    holdoutCases: 11,
    network: isV6 ? 'agent-provider-public; model-command-network-denied; candidate-node-network-denied; trusted-verifier-network-unused' : 'agent-public; verifier-and-candidate-offline',
    execution: {
      substrate: 'harbor',
      version: '0.20.0',
      taskPath: `benchmark/harbor/mini-ledger-${harborTaskVersion}`,
      taskSha256: harborTaskSha256,
      adapters: executionAdapters,
      ...(challengeVersion === 'v5' ? {
        predecessor: 'terminal-mini-ledger-v4',
        protocolRevision,
        amendment: protocolRevision === 'r5' ? 'factory-droid-cli-harness-and-cliproxy-route' : protocolRevision === 'r4' ? 'harness-reliability-redaction-cleanup-and-streaming-fixes' : protocolRevision === 'r3' ? 'dotagents-v1.1.9-prompt-cache-continuity-and-cumulative-usage-fix' : 'fixed-turns-explicit-wire-contract-source-only-verification',
      } : {}),
      ...(isV6 ? {
        predecessor: 'terminal-mini-ledger-v5',
        protocolRevision,
        amendment: protocolRevision === 'r13' ? 'in-sandbox-zero-capability-command-guard' : protocolRevision === 'r12' ? 'sandbox-enforced-nondisqualifying-boundary-attempts' : protocolRevision === 'r11' ? 'droid-transient-session-lock-scan-race-tolerance' : protocolRevision === 'r10' ? 'pinned-pi-image-runtime-and-droid-credential-write-settlement' : protocolRevision === 'r9' ? 'per-turn-harbor-default-user-for-codex-auth-upload-ownership' : protocolRevision === 'r8' ? 'explicit-harbor-default-user-for-per-turn-secret-upload-ownership' : protocolRevision === 'r7' ? 'trusted-upload-ownership-normalization-and-pi-nvm-runtime-continuity' : protocolRevision === 'r6' ? 'owner-staged-executable-wrappers-under-minimal-parent-capabilities' : protocolRevision === 'r5' ? 'preinstalled-pinned-agent-runtimes-and-luna-max-provider-compatibility' : protocolRevision === 'r4' ? 'agent-command-sandbox-and-precise-environment-isolation' : 'luna-max-final-correctness-source-snapshots-stop-reasons-leak-rejection-permission-model-durability-stage-isolation-and-exact-command-grammar',
        modelPolicy: { models: ['gpt-5.6-luna'], reasoningEffort: 'max', harnesses: Object.keys(SEALED_TERMINAL_HARNESS_VERSIONS).sort(), independentRunsPerHarness: 5, repeats: 1 },
        agentToolRuntimePolicy: ['r12', 'r13'].includes(protocolRevision)
          ? { environment: 'forced-minimal-non-secret-allowlist', filesystem: 'workspace-and-disposable-temp-only', network: 'denied-for-model-generated-commands', enforcement: 'native-or-os-sandbox-per-harness', traceAudit: 'sandbox-enforced-attempt-observation', blockedAttemptDisposition: 'ordinary-tool-error-run-remains-scoreable', ...(protocolRevision === 'r13' ? { modelCommandCapabilities: 'fail-closed-zero-mask-guard' } : {}) }
          : { environment: 'minimal-non-secret-allowlist', filesystem: 'workspace-and-disposable-temp-only', network: 'denied-for-model-generated-commands', enforcement: 'native-or-os-sandbox-per-harness', traceAudit: 'denied-boundary-attempts-and-sensitive-access-only' },
        candidateRuntimePolicy: { nodePermissionModel: true, filesystem: 'working-directory-only', network: 'denied', childProcess: 'denied', workerThreads: 'denied', nativeAddons: 'denied', wasi: 'denied', durabilityApis: { supported: ['FileHandle.sync', 'FileHandle.datasync'], unavailable: ['fs.fsync', 'fs.fdatasync', 'fs.fsyncSync', 'fs.fdatasyncSync'] } },
        traceIsolationRequired: true,
        candidateSnapshotsRequired: true,
        finalPublicEvaluationRequired: true,
      } : {}),
    },
    scoring: { visibleStagePoints: 70, holdoutPoints: 30, maxPoints: 100, tieTolerancePoints: 1, regressionPenalty: 0, infrastructureInvalid: true, ...(isV6 ? { primaryMetric: 'final-correctness', reportTrajectory: true } : {}) },
  } : {}),
  ...(challengeVersion === 'v3' ? { stages: MINI_LEDGER_V3_STAGES, turns: 12 } : {}),
  ...(maxWallTimeMs === undefined ? {} : { maxWallTimeMs }),
  generationIndexIsArtifact: !useRuntimeRoster,
});
const availableHarnesses = manifest.comparison?.harnesses ?? [...new Set(manifest.agents.map((agent) => agent.provenance.harness))];
const availableModels = manifest.comparison?.models ?? [...new Set(manifest.agents.map((agent) => agent.provenance.modelRequested))];
const expectedHarnesses = selectedHarnesses.length ? selectedHarnesses : availableHarnesses;
const expectedModels = selectedModels.length ? selectedModels : availableModels;
for (const harness of expectedHarnesses) if (!availableHarnesses.includes(harness)) throw new Error(`Requested terminal harness is absent from the manifest: ${harness}`);
for (const model of expectedModels) if (!availableModels.includes(model)) throw new Error(`Requested terminal model is absent from the manifest: ${model}`);
const generationsPerCombo = manifest.comparison?.generationsPerHarnessModel ?? Math.max(...manifest.agents.map((agent) => agent.generationIndex ?? agent.provenance.generationIndex ?? 0));
const terminalAgents = manifest.agents.filter((agent) => expectedHarnesses.includes(agent.provenance.harness) && expectedModels.includes(agent.provenance.modelRequested)).map((sourceAgent) => {
  const agent = useRuntimeRoster ? sourceAgent : bindTerminalHarnessRuntime(sourceAgent);
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
if (challengeVersion === 'v5' || isV6) {
  try {
    const existing = JSON.parse(await readFile(path.join(outputRoot, 'challenge.json'), 'utf8'));
    if (existing.challengeSha256 !== challenge.challengeSha256) {
      const persistedRuns = await readdir(path.join(outputRoot, 'runs')).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error));
      const persistedAttempts = await readdir(path.join(outputRoot, 'attempts')).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error));
      if (persistedRuns.length > 0 || persistedAttempts.length > 0) {
        throw new Error(`Refusing to replace sealed ${challengeVersion.toUpperCase()} challenge ${existing.challengeId}; choose a new AGENTBATTLER_TERMINAL_RESULT_TAG for a different protocol`);
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}
if (isV6) {
  invariantV6Schedule(schedule);
}
await mkdir(outputRoot, { recursive: true });
await writeFile(path.join(outputRoot, 'challenge.json'), `${canonicalJson(challenge, { space: 2 })}\n`);
await writeFile(path.join(outputRoot, 'schedule.json'), `${canonicalJson(schedule, { space: 2 })}\n`);
console.log(`Challenge: ${challenge.id} (${challenge.challengeId})`);
console.log(`Turn wall-time policy: ${challenge.protocol.maxWallTimeMs === null ? 'unbounded' : `${challenge.protocol.maxWallTimeMs} ms maximum`}`);
console.log(`Matrix: ${expectedHarnesses.length} harnesses × ${expectedModels.length} models × ${generationsPerCombo} generations = ${schedule.jobs.length} runs`);
console.log(`Roster: ${useRuntimeRoster ? 'fresh terminal runtime replicates' : manifestPath}`);
console.log(`Schedule: ${path.join(outputRoot, 'schedule.json')}`);
