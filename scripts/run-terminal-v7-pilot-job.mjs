#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertTerminalV7CalibrationInvocationReady,
  runTerminalV7CalibrationExecutionUnit,
  terminalV7CalibrationUnitForRunKey,
  withTerminalV7CalibrationRunnerLock,
} from '../src/terminal-v7-calibration-runner.mjs';
import { sha256File } from '../src/provenance.mjs';
import { validateTerminalV7BaseGateEvidence } from '../src/terminal-v7-release-evidence.mjs';
import { assertTerminalV7BaseGatesFromFiles } from './assemble-terminal-v7-base-gates.mjs';
import { scoreTerminalV7CalibrationRun } from '../src/terminal-v7-calibration.mjs';
import {
  assertTerminalV7RevisionAcceptsNewWork,
  ensureTerminalV7RevisionSaturationForRun,
  resolveTerminalV7RevisionControlRoot,
} from '../src/terminal-v7-revision-control.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function argument(name, argv) {
  const index = argv.indexOf(`--${name}`);
  return index < 0 ? null : argv[index + 1];
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function main({ env = process.env, argv = process.argv.slice(2), root = ROOT, adapter = null } = {}) {
  const revision = env.AGENTBATTLER_TERMINAL_PROTOCOL_REVISION ?? 'r2';
  invariant(/^r[1-9]\d*$/.test(revision), 'V7 pilot revision must look like r1');
  const resultRoot = path.resolve(env.AGENTBATTLER_TERMINAL_RESULT_ROOT
    ?? path.join(root, 'results', `terminal-mini-ledger-v7-calibration-${revision}`));
  const revisionControlRoot = resolveTerminalV7RevisionControlRoot({ root, revision, env });
  await assertTerminalV7RevisionAcceptsNewWork({ controlRoot: revisionControlRoot, revision });
  const runKey = argument('run-key', argv) ?? env.AGENTBATTLER_TERMINAL_RUN_KEY;
  invariant(typeof runKey === 'string' && /^[0-9a-f]{64}$/.test(runKey), 'Pass exactly one precommitted --run-key');
  const baseEvidencePath = path.resolve(env.AGENTBATTLER_V7_BASE_GATES_PATH ?? path.join(resultRoot, 'release-gates-base.json'));
  const [challenge, schedule, baseEvidence] = await Promise.all([
    readJson(path.join(resultRoot, 'challenge.json')),
    readJson(path.join(resultRoot, 'schedule.json')),
    readJson(baseEvidencePath),
  ]);
  invariant(challenge.protocolRevision === revision, 'V7 pilot challenge revision changed');
  validateTerminalV7BaseGateEvidence(baseEvidence);
  invariant(challenge.execution?.commitments?.baseEvidenceSha256 === baseEvidence.baseEvidenceSha256
    && challenge.execution?.commitments?.reviewedCommit === baseEvidence.reviewedCommit, 'V7 pilot base-gate commitment changed');
  const stateRoot = env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  await assertTerminalV7BaseGatesFromFiles({
    root,
    resultRoot,
    revision,
    sealsPath: path.resolve(env.AGENTBATTLER_V7_SEALS_PATH ?? path.join(root, 'benchmark', 'challenges', 'mini-ledger-v7', 'seals', `${revision}.json`)),
    seedKeyPath: path.resolve(env.AGENTBATTLER_V7_SEED_KEY_FILE ?? path.join(stateRoot, 'automations', 'mini-ledger-v6-scheduled-check', `mini-ledger-v7-${revision}.seed-key`)),
    goldReportPath: path.resolve(env.AGENTBATTLER_V7_GOLD_REPORT_PATH ?? path.join(resultRoot, 'gold', 'gold-report.json')),
    scriptedReferencesPath: path.resolve(env.AGENTBATTLER_V7_SCRIPTED_REFERENCES_PATH ?? path.join(resultRoot, 'control', 'scripted-reference-results.json')),
    qualityEvidencePath: path.resolve(env.AGENTBATTLER_V7_QUALITY_EVIDENCE_PATH ?? path.join(resultRoot, 'quality-gates.json')),
    requirementMapPath: path.resolve(env.AGENTBATTLER_V7_REQUIREMENT_MAP_PATH ?? path.join(root, 'benchmark', 'challenges', 'mini-ledger-v7', 'requirement-map.json')),
    reviewsPath: path.resolve(env.AGENTBATTLER_V7_REVIEWS_PATH ?? path.join(resultRoot, 'control', 'independent-reviews.json')),
    testReportPath: path.resolve(env.AGENTBATTLER_V7_TEST_REPORT_PATH ?? path.join(resultRoot, 'test-preflight-report.json')),
    requirePilotNotStarted: false,
    expectedEvidence: baseEvidence,
  });
  const ownSource = challenge.execution?.adapters?.v7CalibrationRunner;
  invariant(ownSource?.path === 'src/terminal-v7-calibration-runner.mjs'
    && ownSource.sha256 === await sha256File(path.join(root, ownSource.path)), 'V7 calibration runner source does not match its challenge commitment');
  const unit = terminalV7CalibrationUnitForRunKey({ challenge, schedule, runKey });
  const retryInvalid = argv.includes('--retry-invalid');
  process.env.AGENTBATTLER_TERMINAL_CHALLENGE_VERSION = 'v7';
  const runtimeAdapter = adapter ?? await import('./terminal-adapter-all.mjs');
  const result = await withTerminalV7CalibrationRunnerLock({
    resultRoot,
    callback: async () => {
      await assertTerminalV7CalibrationInvocationReady({
        challenge,
        schedule,
        resultRoot,
        runKey,
        retryInvalid,
        scoreRun: scoreTerminalV7CalibrationRun,
        onSaturation: ({ job, run }) => ensureTerminalV7RevisionSaturationForRun({
          controlRoot: revisionControlRoot,
          revision,
          campaign: 'development-pilot',
          resultRoot,
          job,
          run,
          scoreRun: scoreTerminalV7CalibrationRun,
        }),
      });
      await assertTerminalV7RevisionAcceptsNewWork({ controlRoot: revisionControlRoot, revision });
      const outcome = await runTerminalV7CalibrationExecutionUnit({
        challenge,
        schedule,
        unit,
        resultRoot,
        challengeRoot: path.join(root, 'benchmark', 'challenges', 'mini-ledger-v7'),
        runTerminalJob: runtimeAdapter.runTerminalJob,
        retryInvalid,
        onProgress: ({ status }) => process.stdout.write(`[${status}] ${unit.job.harness.id}/${unit.job.instanceId}/${unit.job.instanceVariant}\n`),
        shouldStopBeforeRun: async () => {
          await assertTerminalV7RevisionAcceptsNewWork({ controlRoot: revisionControlRoot, revision });
          return false;
        },
      });
      await ensureTerminalV7RevisionSaturationForRun({
        controlRoot: revisionControlRoot,
        revision,
        campaign: 'development-pilot',
        resultRoot,
        job: unit.job,
        run: outcome.result,
        scoreRun: scoreTerminalV7CalibrationRun,
      });
      return outcome;
    },
  });
  process.stdout.write(`One-unit runner finished with status ${result.status}.\n`);
  return result;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try { await main(); } catch (error) {
    const evidenceCode = String(error?.code ?? 'preflight-or-infrastructure-failure').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
    process.stderr.write(`V7 one-unit runner failed closed (${evidenceCode || 'failure'}).\n`);
    process.exitCode = 1;
  }
}
