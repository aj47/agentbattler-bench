#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  collectTerminalV7ReserveEvidence,
  createTerminalV7ReserveFinalReport,
  writeTerminalV7ReserveFinalReport,
} from '../src/terminal-v7-reserve-report.mjs';
import { sha256File } from '../src/provenance.mjs';
import { verifyTerminalV7Results } from './verify-terminal-v7-results.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export async function main({ env = process.env, root = ROOT } = {}) {
  const revision = env.AGENTBATTLER_TERMINAL_PROTOCOL_REVISION ?? 'r2';
  invariant(/^r[1-9]\d*$/.test(revision), 'V7 reserve report revision must look like r1');
  const releaseResultRoot = path.resolve(env.AGENTBATTLER_V7_RELEASE_RESULT_ROOT
    ?? path.join(root, 'results', `terminal-mini-ledger-v7-${revision}`));
  const resultRoot = path.resolve(env.AGENTBATTLER_TERMINAL_RESULT_ROOT
    ?? path.join(root, 'results', `terminal-mini-ledger-v7-reserve-${revision}`));
  const stateRoot = env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const seedKeyPath = path.resolve(env.AGENTBATTLER_V7_SEED_KEY_FILE
    ?? path.join(stateRoot, 'automations', 'mini-ledger-v6-scheduled-check', `mini-ledger-v7-${revision}.seed-key`));
  const seedKey = (await readFile(seedKeyPath, 'utf8')).trim();
  invariant(seedKey.length >= 16, 'V7 reserve report evaluator seed key is invalid');
  const [releaseVerification, reserveEvidence] = await Promise.all([
    verifyTerminalV7Results({ root, resultRoot: releaseResultRoot, writeArtifacts: false, includeReserve: false }),
    collectTerminalV7ReserveEvidence({ resultRoot, seedKey }),
  ]);
  for (const [name, expectedPath] of Object.entries({
    v7ReserveReport: 'src/terminal-v7-reserve-report.mjs',
    v7ReserveReportCli: 'scripts/report-terminal-v7-reserve.mjs',
  })) {
    const source = reserveEvidence.challenge.execution?.adapters?.[name];
    invariant(source?.path === expectedPath && source.sha256 === await sha256File(path.join(root, expectedPath)), `V7 reserve report source commitment changed: ${name}`);
  }
  const report = createTerminalV7ReserveFinalReport({
    releaseVerification,
    reserveEvidence,
    createdAt: new Date().toISOString(),
  });
  await writeTerminalV7ReserveFinalReport({ resultRoot, report });
  const comparison = report.comparison;
  process.stdout.write(`V7 reserve final report: ${report.decision}; combined matched Core difference ${comparison.meanDifference}, 95% CI [${comparison.confidenceInterval95.low}, ${comparison.confidenceInterval95.high}].\n`);
  process.stdout.write(`Report: ${path.join(resultRoot, 'final-report.json')}\n`);
  return report;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try { await main(); } catch (error) {
    process.stderr.write(`V7 reserve final report failed closed: ${String(error?.message ?? error).slice(0, 500)}\n`);
    process.exitCode = 1;
  }
}
