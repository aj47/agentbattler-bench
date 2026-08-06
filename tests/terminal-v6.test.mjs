import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDroidSandboxProfile, droidSandboxLauncher } from '../src/droid-sandbox.mjs';
import { createExhaustiveTerminalSchedule, createMiniLedgerChallenge, MINI_LEDGER_V4_STAGES, scoreTerminalRun, validateTerminalSchedule } from '../src/terminal-challenge.mjs';
import {
  MINI_LEDGER_V6_EVALUATION_NOTICE,
  MINI_LEDGER_V6_LOCK_NOTICE,
  MINI_LEDGER_V6_SOURCE_NOTICE,
  MINI_LEDGER_V6_TURN_LIMIT_MS,
  MINI_LEDGER_V6_TURN_PROMPTS,
  MINI_LEDGER_V6_WIRE_NOTICE,
} from '../src/terminal-prompts-v6.mjs';
import {
  TerminalTraceIsolationError,
  assertTerminalTraceIsolation,
  captureTerminalCandidateSnapshot,
  terminalTurnCompletion,
} from '../src/terminal-run-evidence.mjs';
import { createTerminalRuntimeRoster } from '../src/terminal-roster.mjs';

const HASH = 'a'.repeat(64);

test('V6 gives every turn the corrected source-only and validation contract', () => {
  assert.equal(MINI_LEDGER_V6_TURN_LIMIT_MS, 3_600_000);
  assert.equal(MINI_LEDGER_V6_TURN_PROMPTS.length, 15);
  for (const prompt of MINI_LEDGER_V6_TURN_PROMPTS) {
    assert.ok(prompt.includes(MINI_LEDGER_V6_SOURCE_NOTICE));
    assert.ok(prompt.includes(MINI_LEDGER_V6_WIRE_NOTICE));
    assert.ok(prompt.includes(MINI_LEDGER_V6_LOCK_NOTICE));
    assert.ok(prompt.includes(MINI_LEDGER_V6_EVALUATION_NOTICE));
    assert.match(prompt, /strictly positive integers/);
    assert.match(prompt, /final-correctness matrix/);
    assert.match(prompt, /hard 60-minute wall-clock limit/);
  }
  assert.match(MINI_LEDGER_V6_TURN_PROMPTS[0], /must never be embedded as source defaults/);
  assert.match(MINI_LEDGER_V6_TURN_PROMPTS[7], /--keep 0.*fail without mutation/);
  assert.match(MINI_LEDGER_V6_TURN_PROMPTS[13], /canonical stale regular ledger\.lock/);
});

test('V6 runtime roster is Luna-only at max reasoning with five independent runs', () => {
  const roster = createTerminalRuntimeRoster({ models: ['gpt-5.6-luna'], reasoningEffort: 'max' });
  assert.equal(roster.comparison.models.length, 1);
  assert.equal(roster.comparison.models[0], 'gpt-5.6-luna');
  assert.equal(roster.comparison.reasoningEffort, 'max');
  assert.equal(roster.agents.length, 25);
  assert.ok(roster.agents.every((agent) => agent.provenance.modelRequested === 'gpt-5.6-luna'));
  assert.ok(roster.agents.every((agent) => agent.provenance.reasoningEffort === 'max'));
});

test('V6 model policy rejects a validly sealed schedule for any other model', () => {
  const challenge = createMiniLedgerChallenge({
    challengeId: 'terminal-mini-ledger-v6',
    promptSha256: HASH,
    publicVerifierSha256: 'b'.repeat(64),
    holdoutVerifierSha256: 'c'.repeat(64),
    execution: { modelPolicy: { models: ['gpt-5.6-luna'], harnesses: ['codex-cli'], reasoningEffort: 'max', independentRunsPerHarness: 1, repeats: 1 } },
  });
  const schedule = createExhaustiveTerminalSchedule({
    challenge,
    agents: [{ id: 'terra-run', generationIndex: 1, provenance: { harness: 'codex-cli', harnessVersion: 'test', modelRequested: 'gpt-5.6-terra', modelFamilyId: 'terra', reasoningEffort: 'max' } }],
    expectedHarnesses: ['codex-cli'],
    expectedModels: ['gpt-5.6-terra'],
    generationsPerCombo: 1,
  });
  assert.throws(() => validateTerminalSchedule(schedule, challenge), /sealed model policy/);
});

test('V6 primary score uses final correctness and preserves trajectory reporting', () => {
  const challenge = createMiniLedgerChallenge({
    challengeId: 'terminal-mini-ledger-v6',
    title: 'Mini Ledger v6',
    stages: MINI_LEDGER_V4_STAGES,
    turns: 15,
    holdoutCases: 11,
    scoring: { visibleStagePoints: 70, holdoutPoints: 30, maxPoints: 100, tieTolerancePoints: 1, regressionPenalty: 0, infrastructureInvalid: true, primaryMetric: 'final-correctness', reportTrajectory: true },
    promptSha256: HASH,
    publicVerifierSha256: 'b'.repeat(64),
    holdoutVerifierSha256: 'c'.repeat(64),
  });
  const trajectory = challenge.stages.map((stage) => ({ id: stage.id, passed: true, regressions: 0 }));
  const finalStages = challenge.stages.map((stage, index) => ({ id: stage.id, passed: index === 0, regressions: index === 0 ? 0 : 1 }));
  const score = scoreTerminalRun({
    schemaVersion: 'agentbattler.terminal-run.v1',
    challengeId: challenge.challengeId,
    challengeSha256: challenge.challengeSha256,
    status: 'completed',
    stages: trajectory,
    finalPublic: { schemaVersion: 'agentbattler.terminal-final-public.v1', stages: finalStages, visiblePoints: 3 },
    holdout: { passed: 0, total: 11 },
  }, challenge);
  assert.equal(score.primaryMetric, 'final-correctness');
  assert.equal(score.visiblePoints, 3);
  assert.equal(score.scorePoints, 3);
  assert.equal(score.trajectory.visiblePoints, 70);
  assert.equal(score.final.visiblePoints, 3);
});

test('V6 archives byte-exact per-turn candidate source and missing-source evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-v6-snapshot-'));
  try {
    const workspace = path.join(root, 'workspace');
    const runDirectory = path.join(root, 'run');
    await Promise.all([mkdir(workspace), mkdir(runDirectory)]);
    const source = path.join(workspace, 'ledger.mjs');
    await writeFile(source, '#!/usr/bin/env node\nconsole.log({ok:true});\n');
    await chmod(source, 0o750);
    const first = await captureTerminalCandidateSnapshot({ sourcePath: source, runDirectory, turn: 1 });
    assert.equal(first.present, true);
    assert.equal(first.executable, true);
    assert.equal(await readFile(path.join(runDirectory, first.path), 'utf8'), await readFile(source, 'utf8'));
    const missing = await captureTerminalCandidateSnapshot({ sourcePath: path.join(workspace, 'absent.mjs'), runDirectory, turn: 2 });
    assert.deepEqual({ present: missing.present, kind: missing.kind, archived: missing.archived }, { present: false, kind: 'missing', archived: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('V6 trace isolation rejects verifier inspection and network-capable tool inputs', () => {
  const clean = assertTerminalTraceIsolation({ trace: [{ type: 'tool_use', name: 'Bash', input: { command: 'node /repo/results/run/workspace/ledger.mjs audit' } }], repositoryRoot: '/repo', workspace: '/repo/results/run/workspace', turn: 1 });
  assert.equal(clean.passed, true);
  assert.throws(() => assertTerminalTraceIsolation({ trace: [{ type: 'tool_use', name: 'Read', input: { file_path: '/repo/benchmark/challenges/mini-ledger-v4/public-verifier.mjs' } }], repositoryRoot: '/repo', turn: 2 }), TerminalTraceIsolationError);
  assert.throws(() => assertTerminalTraceIsolation({ trace: [{ type: 'tool_use', name: 'Bash', input: { command: 'curl https://example.com' } }], repositoryRoot: '/repo', turn: 3 }), /trace-isolation policy/);
  assert.throws(() => assertTerminalTraceIsolation({ trace: [{ tool_call_id: 'atif-1', function_name: 'bash', arguments: { command: 'cat /repo/public-verifier.mjs' } }], repositoryRoot: '/repo', turn: 4 }), TerminalTraceIsolationError);
  assert.throws(() => assertTerminalTraceIsolation({ trace: [{ type: 'tool_use', name: 'Bash', input: { command: 'node -p process.env.AGENTBATTLER_DROID_API_KEY' } }], repositoryRoot: '/repo', turn: 5 }), TerminalTraceIsolationError);
});

test('V6 records normalized stop reasons and seals Droid away from the user home', () => {
  assert.equal(terminalTurnCompletion().stopReason, 'completed');
  assert.equal(terminalTurnCompletion({ iterationLimitReached: true }).stopReason, 'iteration_limit');
  assert.equal(terminalTurnCompletion({ timedOut: true }).stopReason, 'time_limit');
  const profile = createDroidSandboxProfile({ runDirectory: '/Users/test/results/run', binaryPath: '/Users/test/.local/bin/droid', userHome: '/Users/test' });
  assert.match(profile, /deny file-read\* file-write\*/);
  assert.match(profile, /\/Users\/test\/results\/run/);
  assert.match(profile, /\/private\/tmp/);
  const launcher = droidSandboxLauncher({ profilePath: '/Users/test/results/run/droid.sb', droidBinary: '/Users/test/.local/bin/droid' });
  assert.deepEqual(launcher.argsPrefix, ['-f', '/Users/test/results/run/droid.sb', '/Users/test/.local/bin/droid']);
});
