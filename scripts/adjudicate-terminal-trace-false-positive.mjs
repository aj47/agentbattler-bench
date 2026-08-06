#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { importHarborResult } from './terminal-adapter-harbor.mjs';
import { canonicalJson } from '../src/provenance.mjs';
import { normalizeCompletedRun, validateTerminalJobIdentity } from '../src/terminal-runner.mjs';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function atomicWriteJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${canonicalJson(value, { space: 2 })}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

const resultRootArgument = argument('--result-root');
invariant(typeof resultRootArgument === 'string' && path.isAbsolute(resultRootArgument), '--result-root must be an absolute path');
const resultRoot = path.resolve(resultRootArgument);
const runKey = argument('--run-key');
invariant(typeof runKey === 'string' && /^[0-9a-f]{64}$/.test(runKey), '--run-key must be a SHA-256 run key');

const [challenge, schedule, invalid] = await Promise.all([
  readFile(path.join(resultRoot, 'challenge.json'), 'utf8').then(JSON.parse),
  readFile(path.join(resultRoot, 'schedule.json'), 'utf8').then(JSON.parse),
  readFile(path.join(resultRoot, 'runs', `${runKey}.json`), 'utf8').then(JSON.parse),
]);
const job = schedule.jobs.find((candidate) => candidate.runKey === runKey);
invariant(job, `Run ${runKey} is absent from the sealed schedule`);
validateTerminalJobIdentity(job, invalid);
invariant(invalid.status === 'protocol-invalid' && invalid.stopReason === 'trace_isolation_violation', 'Only a trace-isolation-invalid run can be adjudicated');
const violations = invalid.protocolViolation?.violations;
invariant(Array.isArray(violations) && violations.length > 0, 'The invalid result has no trace-isolation evidence');
invariant(violations.every((violation) => violation.marker === '<environment-enumeration>'), 'The invalid result contains a non-environment isolation violation');

const coverage = schedule.coverage.find((entry) => entry.combo.comboId === job.comboId);
invariant(coverage, `Run ${runKey} has no schedule coverage entry`);
const adapterJob = {
  ...job,
  harness: coverage.combo.harness.id,
  harnessVersion: coverage.combo.harness.version,
  model: coverage.combo.model.id,
  modelFamilyId: coverage.combo.model.familyId,
  reasoningEffort: coverage.combo.model.reasoningEffort,
  generationSettings: coverage.combo.generationSettings ?? {},
  maxWallTimeMs: challenge.protocol.maxWallTimeMs,
  executionConcurrency: 1,
};
const runDirectory = path.join(resultRoot, 'work', runKey);
const trialName = `agentbattler-${runKey.slice(0, 16)}`;
const trialRoot = path.join(runDirectory, 'harbor-trials', trialName);
const raw = JSON.parse(await readFile(path.join(trialRoot, 'result.json'), 'utf8'));

// Re-importing with the corrected policy rechecks every native tool payload;
// it is the acceptance proof, not a blind status rewrite.
const imported = await importHarborResult({
  raw,
  trialRoot,
  challenge,
  job: adapterJob,
  harnessVersion: coverage.combo.harness.version,
  runDirectory,
});
try {
  imported.resources = JSON.parse(await readFile(path.join(runDirectory, 'harbor-resource-summary.json'), 'utf8'));
} catch { /* Older preserved runs may predate resource summaries. */ }

const adjudicatedAt = new Date().toISOString();
const attemptId = `${adjudicatedAt.replace(/[:.]/g, '-')}-policy-correction`;
const completed = normalizeCompletedRun(job, {
  ...imported,
  attemptId,
  adjudication: {
    schemaVersion: 'agentbattler.terminal-adjudication.v1',
    kind: 'false-positive-trace-policy-correction',
    adjudicatedAt,
    sourceAttemptId: invalid.attemptId,
    sourceResultSha256: invalid.resultSha256,
    originalViolation: invalid.protocolViolation,
    decision: 'accepted-after-complete-native-trace-recheck',
    rule: 'static non-sensitive task-local environment variables are allowed; enumeration and sensitive names remain forbidden',
  },
});
await atomicWriteJson(path.join(resultRoot, 'attempts', runKey, `${attemptId}.json`), completed);
await atomicWriteJson(path.join(resultRoot, 'runs', `${runKey}.json`), completed);
console.log(JSON.stringify({ runKey, status: completed.status, validity: completed.validity, attemptId, adjudication: completed.adjudication.decision }));
