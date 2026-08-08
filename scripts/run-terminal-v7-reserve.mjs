#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { withTerminalV7CalibrationRunnerLock } from '../src/terminal-v7-calibration-runner.mjs';
import { runTerminalV7ReserveSchedule } from '../src/terminal-v7-reserve-runner.mjs';
import { sha256File } from '../src/provenance.mjs';
import { resolveTerminalV7RevisionControlRoot } from '../src/terminal-v7-revision-control.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function main({ env = process.env, argv = process.argv.slice(2), root = ROOT, adapter = null } = {}) {
  const revision = env.AGENTBATTLER_TERMINAL_PROTOCOL_REVISION ?? 'r1';
  invariant(/^r[1-9]\d*$/.test(revision), 'V7 reserve revision must look like r1');
  const resultRoot = path.resolve(env.AGENTBATTLER_TERMINAL_RESULT_ROOT
    ?? path.join(root, 'results', `terminal-mini-ledger-v7-reserve-${revision}`));
  const revisionControlRoot = resolveTerminalV7RevisionControlRoot({ root, revision, env });
  const [challenge, schedule] = await Promise.all([
    readJson(path.join(resultRoot, 'challenge.json')),
    readJson(path.join(resultRoot, 'schedule.json')),
  ]);
  invariant(challenge.protocolRevision === revision && schedule.campaign === 'reserve-extension', 'V7 reserve runner campaign identity changed');
  for (const [name, expectedPath] of Object.entries({
    v7CalibrationRunner: 'src/terminal-v7-calibration-runner.mjs',
    v7ReserveRunner: 'src/terminal-v7-reserve-runner.mjs',
    v7ReserveRunnerCli: 'scripts/run-terminal-v7-reserve.mjs',
    v7RevisionControl: 'src/terminal-v7-revision-control.mjs',
  })) {
    const source = challenge.execution?.adapters?.[name];
    invariant(source?.path === expectedPath && source.sha256 === await sha256File(path.join(root, expectedPath)), `V7 reserve runner source commitment changed: ${name}`);
  }
  process.env.AGENTBATTLER_TERMINAL_CHALLENGE_VERSION = 'v7';
  const runtimeAdapter = adapter ?? await import('./terminal-adapter-all.mjs');
  const result = await withTerminalV7CalibrationRunnerLock({
    resultRoot,
    callback: () => runTerminalV7ReserveSchedule({
      challenge,
      schedule,
      resultRoot,
      challengeRoot: path.join(root, 'benchmark', 'challenges', 'mini-ledger-v7'),
      runTerminalJob: runtimeAdapter.runTerminalJob,
      revisionControlRoot,
      retryInvalid: argv.includes('--retry-invalid'),
      onProgress: ({ status, runKey }) => process.stdout.write(`[${status}] ${String(runKey).slice(0, 12)}\n`),
    }),
  });
  process.stdout.write(result.status === 'retirement-paused'
    ? 'V7 reserve runner refused new work because this revision is retired.\n'
    : result.status === 'saturation-paused'
      ? 'V7 reserve runner paused before the next job for a Core-100 saturation audit.\n'
      : 'V7 reserve runner reached the end of its sealed schedule.\n');
  return result;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try { await main(); } catch (error) {
    process.stderr.write(`V7 reserve runner failed closed: ${String(error?.message ?? error).slice(0, 500)}\n`);
    process.exitCode = 1;
  }
}
