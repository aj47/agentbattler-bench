#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildTerminalV7DevelopmentPilotControl } from '../src/terminal-v7-calibration-build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export async function main({ env = process.env, root = ROOT } = {}) {
  const revision = env.AGENTBATTLER_TERMINAL_PROTOCOL_REVISION ?? 'r1';
  invariant(/^r[1-9]\d*$/.test(revision), 'V7 pilot revision must look like r1');
  const resultRoot = path.resolve(env.AGENTBATTLER_TERMINAL_RESULT_ROOT
    ?? path.join(root, 'results', `terminal-mini-ledger-v7-calibration-${revision}`));
  const seed = Number.parseInt(env.AGENTBATTLER_TERMINAL_SEED ?? '20260808', 10);
  const result = await buildTerminalV7DevelopmentPilotControl({
    root,
    resultRoot,
    revision,
    sealsPath: env.AGENTBATTLER_V7_SEALS_PATH ? path.resolve(env.AGENTBATTLER_V7_SEALS_PATH) : null,
    seedKeyPath: env.AGENTBATTLER_V7_SEED_KEY_FILE ? path.resolve(env.AGENTBATTLER_V7_SEED_KEY_FILE) : null,
    baseEvidencePath: env.AGENTBATTLER_V7_BASE_GATES_PATH ? path.resolve(env.AGENTBATTLER_V7_BASE_GATES_PATH) : null,
    revisionControlRoot: env.AGENTBATTLER_V7_REVISION_CONTROL_ROOT ? path.resolve(env.AGENTBATTLER_V7_REVISION_CONTROL_ROOT) : null,
    revisionControlEnv: env,
    seed,
  });
  process.stdout.write(`V7 development pilot ${result.schedule.scheduleId}: 12 Luna/max twin jobs + 3 Codex Luna/high anchors\n`);
  process.stdout.write(`Control root: ${resultRoot}\n`);
  process.stdout.write('No model jobs were launched.\n');
  return result;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try { await main(); } catch (error) {
    process.stderr.write(`V7 pilot control build failed: ${String(error?.message ?? error).slice(0, 500)}\n`);
    process.exitCode = 1;
  }
}
