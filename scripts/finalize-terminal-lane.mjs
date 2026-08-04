#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson, canonicalJsonSha256 } from '../src/provenance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = process.env.AGENTBATTLER_TERMINAL_CHALLENGE_VERSION ?? 'v5';
const protocolRevision = process.env.AGENTBATTLER_TERMINAL_PROTOCOL_REVISION;
const resultTag = process.env.AGENTBATTLER_TERMINAL_RESULT_TAG ?? (protocolRevision ? `${version}-${protocolRevision}` : version);
const resultRoot = path.resolve(process.env.AGENTBATTLER_TERMINAL_RESULT_ROOT
  ?? path.join(ROOT, `results/terminal-mini-ledger-${resultTag}`));
const sourceId = (process.env.AGENTBATTLER_TERMINAL_SOURCE_ID ?? protocolRevision ?? 'standalone').toUpperCase();

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function runNode(script, args, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, script), ...args], {
      cwd: ROOT,
      env: { ...process.env, ...environment },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} exited ${code ?? signal}`));
    });
  });
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${canonicalJson(value, { space: 2 })}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

function verifiedHash(value, field, label) {
  const { [field]: actual, ...unsigned } = value;
  invariant(actual === canonicalJsonSha256(unsigned), `${label} integrity hash mismatch`);
  return actual;
}

invariant(/^v\d+$/.test(version), 'Challenge version must look like v5');
invariant(/^r\d+$/.test(protocolRevision ?? ''), 'AGENTBATTLER_TERMINAL_PROTOCOL_REVISION must look like r5');
invariant(/^[A-Z0-9_-]+$/.test(sourceId), 'Terminal source ID is invalid');

const environment = {
  AGENTBATTLER_TERMINAL_CHALLENGE_VERSION: version,
  AGENTBATTLER_TERMINAL_PROTOCOL_REVISION: protocolRevision,
  AGENTBATTLER_TERMINAL_RESULT_TAG: resultTag,
  AGENTBATTLER_TERMINAL_RESULT_ROOT: resultRoot,
  AGENTBATTLER_TERMINAL_WORK_ROOT: path.join(resultRoot, 'work'),
};
await runNode('scripts/verify-terminal-results.mjs', [], environment);
await runNode('scripts/export-terminal-traces.mjs', [], environment);

const [challenge, schedule, summary, traceManifest] = await Promise.all([
  readJson(path.join(resultRoot, 'challenge.json')),
  readJson(path.join(resultRoot, 'schedule.json')),
  readJson(path.join(resultRoot, 'summary.json')),
  readJson(path.join(resultRoot, 'trace-manifest.json')),
]);
const summarySha256 = verifiedHash(summary, 'summarySha256', 'Terminal summary');
const traceManifestSha256 = verifiedHash(traceManifest, 'manifestSha256', 'Terminal trace manifest');
const runFiles = (await readdir(path.join(resultRoot, 'runs'))).filter((file) => file.endsWith('.json')).sort();
const runs = await Promise.all(runFiles.map((file) => readJson(path.join(resultRoot, 'runs', file))));
invariant(runs.length === schedule.jobs.length, `Expected ${schedule.jobs.length} completed runs, found ${runs.length}`);
invariant(runs.every((run) => run.status === 'completed' && run.validity === 'valid'), 'Standalone publication requires only valid completed runs');
invariant(traceManifest.traces.length === runs.length, 'Trace coverage does not match completed runs');

const jobs = new Map(schedule.jobs.map((job) => [job.runKey, job]));
const accepted = runs.map((run) => {
  const job = jobs.get(run.runKey);
  invariant(job, `Run ${run.runKey} is absent from the sealed schedule`);
  invariant(job.artifactId === run.artifactId, `Run artifact identity mismatch for ${run.runKey}`);
  invariant(traceManifest.traces.some((trace) => trace.runKey === run.runKey), `Missing trace for ${run.runKey}`);
  return {
    logicalKey: `${run.harness}|${run.model}|${run.generationIndex}|${run.repeat}|${run.seed}`,
    harness: run.harness,
    model: run.model,
    generation: run.generationIndex,
    source: {
      sourceId,
      protocolRevision,
      runKey: run.runKey,
    },
  };
}).sort((left, right) => left.logicalKey.localeCompare(right.logicalKey));
invariant(new Set(accepted.map((entry) => entry.logicalKey)).size === accepted.length, 'Standalone logical run identities must be unique');

const generatedAt = runs.map((run) => run.endedAt).filter(Boolean).sort().at(-1) ?? new Date().toISOString();
const campaign = {
  schemaVersion: 'agentbattler.terminal-v5-campaign.v1',
  phase: 'complete',
  generatedAt,
  counts: {
    expected: schedule.jobs.length,
    accepted: accepted.length,
    outstanding: 0,
    infrastructureInvalid: 0,
  },
  policy: {
    kind: 'single-sealed-source-lane',
    sourceId,
    protocolRevision,
    challengeId: challenge.challengeId,
    scheduleId: schedule.scheduleId,
    completeScheduleRequired: true,
  },
  sources: [{ id: sourceId, protocolRevision, resultTag, resultRoot }],
  accepted,
  outstanding: [],
};
await writeJsonAtomic(path.join(resultRoot, 'campaign-index.json'), campaign);

const traces = accepted.map((entry) => {
  const trace = traceManifest.traces.find((candidate) => candidate.runKey === entry.source.runKey);
  return {
    logicalKey: entry.logicalKey,
    harness: entry.harness,
    model: entry.model,
    generation: entry.generation,
    sourceId,
    protocolRevision,
    runKey: entry.source.runKey,
    trace: {
      path: trace.path,
      publishedBytes: trace.publishedBytes,
      publishedSha256: trace.publishedSha256,
    },
  };
});
const traceIndexUnsigned = {
  schemaVersion: 'agentbattler.terminal-v5-campaign-traces.v1',
  generatedAt,
  totals: {
    logicalRuns: traces.length,
    turns: traces.length * challenge.protocol.turns,
    publishedBytes: traces.reduce((sum, entry) => sum + entry.trace.publishedBytes, 0),
  },
  traces,
};
const traceIndex = { ...traceIndexUnsigned, traceIndexSha256: canonicalJsonSha256(traceIndexUnsigned) };
const traceIndexFile = path.join(resultRoot, 'campaign-trace-index.json');
await writeJsonAtomic(traceIndexFile, traceIndex);

const artifactsUnsigned = {
  schemaVersion: 'agentbattler.terminal-v5-campaign-artifacts.v1',
  generatedAt,
  campaign: {
    index: path.join(resultRoot, 'campaign-index.json'),
    indexSha256: canonicalJsonSha256(campaign),
    accepted: accepted.length,
    expected: schedule.jobs.length,
  },
  sources: [{
    id: sourceId,
    protocolRevision,
    resultRoot,
    summary: { file: path.join(resultRoot, 'summary.json'), sha256: summarySha256 },
    traceManifest: {
      file: path.join(resultRoot, 'trace-manifest.json'),
      sha256: traceManifestSha256,
      exportedRuns: traceManifest.totals.runs,
    },
  }],
  totals: traceIndex.totals,
  traceIndex: { file: traceIndexFile, sha256: traceIndex.traceIndexSha256 },
};
const artifacts = { ...artifactsUnsigned, artifactsSha256: canonicalJsonSha256(artifactsUnsigned) };
await writeJsonAtomic(path.join(resultRoot, 'campaign-artifacts.json'), artifacts);

console.log(`Finalized standalone ${sourceId} lane: ${accepted.length}/${schedule.jobs.length} runs and ${traces.length} traces`);
console.log(`Campaign index: ${path.join(resultRoot, 'campaign-index.json')}`);
