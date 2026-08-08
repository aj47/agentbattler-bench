#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildTerminalV7ReserveControl,
  loadTerminalV7CalibrationSealInputs,
} from '../src/terminal-v7-calibration-build.mjs';
import { verifyTerminalV7Results } from './verify-terminal-v7-results.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export async function main({ env = process.env, root = ROOT } = {}) {
  const revision = env.AGENTBATTLER_TERMINAL_PROTOCOL_REVISION ?? 'r2';
  invariant(/^r[1-9]\d*$/.test(revision), 'V7 reserve revision must look like r1');
  const releaseResultRoot = path.resolve(env.AGENTBATTLER_V7_RELEASE_RESULT_ROOT
    ?? path.join(root, 'results', `terminal-mini-ledger-v7-${revision}`));
  const resultRoot = path.resolve(env.AGENTBATTLER_TERMINAL_RESULT_ROOT
    ?? path.join(root, 'results', `terminal-mini-ledger-v7-reserve-${revision}`));
  const seed = Number.parseInt(env.AGENTBATTLER_TERMINAL_SEED ?? '20260808', 10);
  const [{ sealManifest, seedKey }, release] = await Promise.all([
    loadTerminalV7CalibrationSealInputs({
      root,
      revision,
      sealsPath: env.AGENTBATTLER_V7_SEALS_PATH ? path.resolve(env.AGENTBATTLER_V7_SEALS_PATH) : null,
      seedKeyPath: env.AGENTBATTLER_V7_SEED_KEY_FILE ? path.resolve(env.AGENTBATTLER_V7_SEED_KEY_FILE) : null,
    }),
    verifyTerminalV7Results({ root, resultRoot: releaseResultRoot, writeArtifacts: false, includeReserve: false }),
  ]);
  invariant(release.officialMatrixVerified === true
    && release.finalization?.status === 'reserve-required'
    && release.scoredRuns.length === 25,
  'V7 reserve selection requires a strict unresolved 25-job official matrix');
  const result = await buildTerminalV7ReserveControl({
    root,
    resultRoot,
    revision,
    sealManifest,
    seedKey,
    releaseChallenge: release.challenge,
    releaseSchedule: release.schedule,
    releaseResults: release.scoredRuns.map(({ run }) => run),
    revisionControlRoot: env.AGENTBATTLER_V7_REVISION_CONTROL_ROOT ? path.resolve(env.AGENTBATTLER_V7_REVISION_CONTROL_ROOT) : null,
    revisionControlEnv: env,
    seed,
  });
  process.stdout.write(`V7 reserve extension ${result.schedule.scheduleId}: two unresolved leading harnesses x five presealed reserve packs\n`);
  process.stdout.write(`Control root: ${resultRoot}\n`);
  process.stdout.write('No model jobs were launched.\n');
  return result;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try { await main(); } catch (error) {
    process.stderr.write(`V7 reserve control build failed: ${String(error?.message ?? error).slice(0, 500)}\n`);
    process.exitCode = 1;
  }
}
