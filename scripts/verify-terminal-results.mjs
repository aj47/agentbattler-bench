#!/usr/bin/env node
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  computeTerminalElo,
  scoreTerminalRun,
  validateMiniLedgerChallenge,
  validateTerminalSchedule,
} from '../src/terminal-challenge.mjs';
import { canonicalJson, canonicalJsonSha256 } from '../src/provenance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const challengeVersion = process.env.AGENTBATTLER_TERMINAL_CHALLENGE_VERSION ?? 'v2';
if (!/^v\d+$/.test(challengeVersion)) throw new Error('AGENTBATTLER_TERMINAL_CHALLENGE_VERSION must look like v2');
const resultTag = process.env.AGENTBATTLER_TERMINAL_RESULT_TAG ?? challengeVersion;
if (!/^v\d+(?:-[a-z0-9-]+)?$/.test(resultTag)) throw new Error('AGENTBATTLER_TERMINAL_RESULT_TAG must look like v4-harbor');
const resultRoot = path.join(ROOT, `results/terminal-mini-ledger-${resultTag}`);
const allowIncomplete = process.argv.includes('--allow-incomplete');

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}
async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}
async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

const [challenge, schedule] = await Promise.all([
  readJson(path.join(resultRoot, 'challenge.json')),
  readJson(path.join(resultRoot, 'schedule.json')),
]);
validateMiniLedgerChallenge(challenge);
validateTerminalSchedule(schedule, challenge);

const runs = [];
const missing = [];
const invalid = [];
for (const job of schedule.jobs) {
  const file = path.join(resultRoot, 'runs', `${job.runKey}.json`);
  if (!await exists(file)) {
    missing.push({ runKey: job.runKey, comboId: job.comboId, artifactId: job.artifactId, file: path.relative(ROOT, file) });
    continue;
  }
  try {
    const run = await readJson(file);
    invariant(run.runKey === job.runKey, 'runKey does not match schedule');
    invariant(run.comboId === job.comboId && run.artifactId === job.artifactId, 'run identity does not match schedule');
    if (run.status === 'infrastructure-invalid') {
      invalid.push({ runKey: job.runKey, file: path.relative(ROOT, file), error: run.error ?? 'infrastructure-invalid', status: run.status });
      continue;
    }
    const score = scoreTerminalRun(run, challenge);
    runs.push({ ...run, score });
  } catch (error) {
    invalid.push({ runKey: job.runKey, file: path.relative(ROOT, file), error: error.message });
  }
}

const elo = runs.length > 0 ? computeTerminalElo(runs) : null;
const summaryUnsigned = {
  schemaVersion: 'agentbattler.terminal-results-summary.v1',
  challenge: { id: challenge.challengeId, sha256: challenge.challengeSha256 },
  schedule: { id: schedule.scheduleId, sha256: schedule.scheduleSha256 },
  expectedRuns: schedule.jobs.length,
  completedRuns: runs.length,
  missingRuns: missing,
  invalidRuns: invalid,
  scores: runs.map((run) => ({ runKey: run.runKey, comboId: run.comboId, artifactId: run.artifactId, score: run.score })),
  elo,
};
const summary = { ...summaryUnsigned, summarySha256: canonicalJsonSha256(summaryUnsigned) };
await mkdir(resultRoot, { recursive: true });
await writeFile(path.join(resultRoot, 'summary.json'), `${canonicalJson(summary, { space: 2 })}\n`);
console.log(`Terminal results: ${runs.length}/${schedule.jobs.length} completed, ${invalid.length} invalid, ${missing.length} missing`);
if (elo) console.log(`Terminal Elo comparisons: ${elo.comparisons.length}; standings: ${elo.standings.length}`);
console.log(`Summary: ${path.join(resultRoot, 'summary.json')}`);
if (!allowIncomplete && (missing.length > 0 || invalid.length > 0)) process.exitCode = 1;
