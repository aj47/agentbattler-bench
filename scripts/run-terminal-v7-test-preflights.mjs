#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runTerminalV7TestPreflights } from '../src/terminal-v7-preflights.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}
export async function main({ env = process.env, root = ROOT } = {}) {
  invariant(process.platform === 'darwin' && process.arch === 'arm64', 'V7 test/preflight evidence must run on the M4 Pro execution host');
  const revision = env.AGENTBATTLER_TERMINAL_PROTOCOL_REVISION ?? 'r1';
  const reviewedCommit = env.AGENTBATTLER_V7_REVIEWED_COMMIT;
  invariant(/^[0-9a-f]{40}$/.test(reviewedCommit ?? ''), 'AGENTBATTLER_V7_REVIEWED_COMMIT is required');
  const evidenceRoot = path.resolve(env.AGENTBATTLER_V7_PREFLIGHT_EVIDENCE_ROOT
    ?? path.join(root, 'results', `terminal-mini-ledger-v7-calibration-${revision}`));
  invariant(typeof env.AGENTBATTLER_V7_PREFLIGHT_TASK_ROOT === 'string'
    && env.AGENTBATTLER_V7_PREFLIGHT_TASK_ROOT.length > 0, 'AGENTBATTLER_V7_PREFLIGHT_TASK_ROOT is required');
  const taskRoot = path.resolve(env.AGENTBATTLER_V7_PREFLIGHT_TASK_ROOT);
  const outputPath = path.resolve(env.AGENTBATTLER_V7_TEST_REPORT_PATH
    ?? path.join(evidenceRoot, 'test-preflight-report.json'));
  const report = await runTerminalV7TestPreflights({
    root: path.resolve(root),
    evidenceRoot,
    taskRoot,
    revision,
    reviewedCommit,
    outputPath,
  });
  process.stdout.write(`V7 M4 tests and five sandbox preflights passed; report ${report.reportSha256}\n`);
  return report;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    await main();
  } catch (error) {
    const message = String(error?.message ?? error)
      .split(os.homedir()).join('<home>')
      .slice(0, 800);
    process.stderr.write(`V7 test/preflight gate failed closed: ${message}\n`);
    process.exitCode = 1;
  }
}
