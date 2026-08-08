#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runTerminalV7ScriptedReferences } from '../src/terminal-v7-scripted-references.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function main({ env = process.env, root = ROOT, now = () => new Date().toISOString() } = {}) {
  const revision = env.AGENTBATTLER_TERMINAL_PROTOCOL_REVISION ?? 'r2';
  invariant(/^r[1-9]\d*$/.test(revision), 'V7 scripted-reference revision must look like r1');
  const resultRoot = path.resolve(env.AGENTBATTLER_TERMINAL_RESULT_ROOT
    ?? path.join(root, 'results', `terminal-mini-ledger-v7-calibration-${revision}`));
  const sealsPath = path.resolve(env.AGENTBATTLER_V7_SEALS_PATH
    ?? path.join(root, 'benchmark', 'challenges', 'mini-ledger-v7', 'seals', `${revision}.json`));
  const goldReportPath = path.resolve(env.AGENTBATTLER_V7_GOLD_REPORT_PATH
    ?? path.join(resultRoot, 'gold', 'gold-report.json'));
  const [sealManifest, goldReport] = await Promise.all([
    readJson(sealsPath),
    readJson(goldReportPath),
  ]);
  const result = await runTerminalV7ScriptedReferences({
    root,
    resultRoot,
    revision,
    sealManifest,
    goldReport,
    createdAt: now(),
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    reportSha256: result.report.reportSha256,
    rows: result.report.rows.length,
    maximumAbsoluteTwinDifference: result.report.summary.maximumAbsoluteTwinDifference,
  })}\n`);
  return result;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try { await main(); } catch (error) {
    process.stderr.write(`V7 scripted-reference execution failed closed: ${String(error?.message ?? error).slice(0, 500)}\n`);
    process.exitCode = 1;
  }
}
