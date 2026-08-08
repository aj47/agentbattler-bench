#!/usr/bin/env node
import { lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { V7_REQUIREMENTS } from '../benchmark/challenges/mini-ledger-v7/requirements.mjs';
import { canonicalJson, canonicalJsonSha256, sha256, sha256File } from '../src/provenance.mjs';
import { terminalV7ObservedAttemptCount, terminalV7RunOperationalMetrics } from '../src/terminal-v7-operational-metrics.mjs';
import { MINI_LEDGER_V7_FAMILIES } from '../src/terminal-v7.mjs';
import { verifyTerminalV7Results } from './verify-terminal-v7-results.mjs';

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORBIDDEN_KEY = /(?:prompt|response|message|command|arguments?|authorization|auth|secret|credential|password|session(?:id|identifier)|stdout|stderr|content|thinking)/i;
const FORBIDDEN_VALUE = /(?:Bearer\s+[A-Za-z0-9._~+\/-]{12,}|\bsk-[A-Za-z0-9_-]{12,}|\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|\b(?:API_KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL)=[^\s,;]+|\/(?:Users|home)\/[^/\s]+)/i;
const USAGE_FIELDS = Object.freeze([
  'inputTokens',
  'cachedInputTokens',
  'outputTokens',
  'reasoningTokens',
  'totalTokens',
  'input_tokens',
  'cached_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
  'total_tokens',
]);
const RESOURCE_FIELDS = Object.freeze([
  'samples',
  'sampleIntervalMs',
  'maxMemoryCurrentBytes',
  'maxMemoryPeakBytes',
  'maxProcessCount',
  'oomEvents',
  'oomKillEvents',
  'cpuTimeMs',
  'maxCpuPercent',
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function numericProjection(value, fields) {
  const result = {};
  for (const field of fields) {
    const number = value?.[field];
    if (typeof number === 'number' && Number.isFinite(number) && number >= 0) result[field] = number;
  }
  return result;
}

function phaseAggregate(result, phase) {
  const requirements = result.requirements ?? [];
  const weighted = (group, field) => requirements.reduce((sum, record) => {
    const definition = V7_REQUIREMENTS.find(({ id }) => id === record.id);
    if (definition?.group !== group) return sum;
    return sum + (field === 'points' ? record.points : definition.weight);
  }, 0);
  const weightedClass = (caseClass, field) => requirements.reduce((sum, record) => {
    const definition = V7_REQUIREMENTS.find(({ id }) => id === record.id);
    if (definition?.group !== 'private') return sum;
    return sum + (field === 'points' ? record.classes[caseClass].points : definition.privateClassWeights[caseClass]);
  }, 0);
  return {
    phase,
    public: { passedWeight: weighted('public', 'points'), totalWeight: weighted('public', 'weight') },
    private: { passedWeight: weighted('private', 'points'), totalWeight: weighted('private', 'weight') },
    hiddenAtomic: { passedWeight: weightedClass('atomic', 'points'), totalWeight: weightedClass('atomic', 'weight') },
    hiddenComposed: { passedWeight: weightedClass('composed', 'points'), totalWeight: weightedClass('composed', 'weight') },
    requirementGroupsPassed: requirements.filter(({ passed }) => passed === true).length,
    requirementGroupsTotal: requirements.length,
    infrastructureErrorCount: result.infrastructureErrors.length,
  };
}

function artifactAggregate(artifact) {
  if (!artifact) return { present: false, sizeBytes: 0, sha256: null };
  invariant(typeof artifact.sizeBytes === 'number' && /^[0-9a-f]{64}$/.test(artifact.sha256 ?? ''), 'V7 declared artifact metadata is invalid');
  return { present: true, sizeBytes: artifact.sizeBytes, sha256: artifact.sha256 };
}

function rounded(value) {
  return Number(value.toFixed(6));
}

function projectedCheckSet(value, maxPoints) {
  invariant(Number.isSafeInteger(value?.passed) && Number.isSafeInteger(value?.total) && value.total > 0
    && value.passed >= 0 && value.passed <= value.total, 'V7 trace score input is invalid');
  return { points: rounded((value.passed / value.total) * maxPoints), passed: value.passed, total: value.total };
}

function traceScoreProjection(entry) {
  if (entry.score?.core?.families && entry.score?.adaptability) return entry.score;
  const byId = new Map((entry.run?.evaluation?.families ?? []).map((family) => [family.id, family]));
  invariant(byId.size === MINI_LEDGER_V7_FAMILIES.length && MINI_LEDGER_V7_FAMILIES.every((id) => byId.has(id)), 'V7 reserve trace lacks the five scoring families');
  const families = MINI_LEDGER_V7_FAMILIES.map((id) => {
    const family = byId.get(id);
    const publicScore = projectedCheckSet(family.public, 4);
    const hiddenAtomic = projectedCheckSet(family.hiddenAtomic, 6);
    const hiddenComposed = projectedCheckSet(family.hiddenComposed, 10);
    const hidden = projectedCheckSet(family.hidden, 16);
    return {
      id,
      points: rounded(publicScore.points + hidden.points),
      exact: publicScore.passed === publicScore.total && hiddenAtomic.passed === hiddenAtomic.total && hiddenComposed.passed === hiddenComposed.total,
      public: publicScore,
      hidden,
      hiddenAtomic,
      hiddenComposed,
    };
  });
  const aggregate = (field) => ({
    points: rounded(families.reduce((sum, family) => sum + family[field].points, 0)),
    passed: families.reduce((sum, family) => sum + family[field].passed, 0),
    total: families.reduce((sum, family) => sum + family[field].total, 0),
  });
  const publicScore = aggregate('public');
  const hidden = aggregate('hidden');
  const hiddenAtomic = aggregate('hiddenAtomic');
  const hiddenComposed = aggregate('hiddenComposed');
  const adaptability = projectedCheckSet(entry.run.evaluation.adaptability, 15);
  return {
    core: {
      points: rounded(publicScore.points + hidden.points),
      public: publicScore,
      hidden,
      hiddenAtomic,
      hiddenComposed,
      families,
    },
    exact: families.every(({ exact }) => exact),
    adaptability,
    proxyGap: rounded(((publicScore.points / 20) - (hiddenComposed.points / 50)) * 100),
  };
}

function assertPrivacySafe(value, key = '') {
  invariant(!FORBIDDEN_KEY.test(key), `V7 trace contains forbidden field ${key}`);
  if (typeof value === 'string') {
    invariant(!FORBIDDEN_VALUE.test(value), `V7 trace contains forbidden string data in ${key || 'value'}`);
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) assertPrivacySafe(child, key);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value)) assertPrivacySafe(child, childKey);
  }
}

export function createTerminalV7AggregateTraceRecords({ challenge, schedule, entry, pool = 'release' }) {
  const { job, run, trees, attemptCount } = entry;
  invariant(pool === 'release' || pool === 'reserve', 'V7 aggregate trace pool is invalid');
  invariant(Array.isArray(trees) && trees.length === 5, 'V7 aggregate trace requires five strictly verified candidate-tree records');
  const score = traceScoreProjection(entry);
  const operational = terminalV7RunOperationalMetrics(run);
  const declaredArtifacts = Array.isArray(run.declaredArtifacts) ? run.declaredArtifacts : new Array(5).fill(null);
  invariant(declaredArtifacts.length === 5, 'V7 declared-artifact evidence must align with five phases');
  const records = [
    {
      type: 'traceHeader',
      schemaVersion: 'agentbattler.terminal-v7-aggregate-trace.v1',
      pool,
      challengeId: challenge.challengeId,
      challengeSha256: challenge.challengeSha256,
      scheduleId: schedule.scheduleId,
      scheduleSha256: schedule.scheduleSha256,
      runKey: job.runKey,
      harnessId: job.harness.id,
      harnessVersion: job.harness.version,
      modelId: job.model.id,
      reasoningEffort: job.model.reasoningEffort,
      instanceId: job.instanceId,
      instanceSha256: job.instanceSha256,
      instanceVariant: job.instanceVariant,
      round: job.round,
      executionIndex: job.executionIndex,
    },
    {
      type: 'runMetrics',
      status: run.status,
      validity: run.validity,
      durationMs: typeof run.durationMs === 'number' && Number.isFinite(run.durationMs) && run.durationMs >= 0 ? run.durationMs : null,
      turns: run.turns.length,
      sameSessionProof: run.sameSessionProof,
      toolCalls: Number.isSafeInteger(run.toolCalls) && run.toolCalls >= 0 ? run.toolCalls : null,
      usage: numericProjection(run.usage, USAGE_FIELDS),
      resources: numericProjection(run.resources, RESOURCE_FIELDS),
      timeouts: operational.timeouts,
      blockedAttemptCount: terminalV7ObservedAttemptCount(run),
      cost: operational.cost,
      attemptCount: Number.isSafeInteger(attemptCount) && attemptCount > 0 ? attemptCount : null,
    },
  ];
  for (let index = 0; index < 5; index += 1) {
    const turn = run.turns[index];
    const tree = trees[index];
    records.push({
      type: 'phaseAggregate',
      ...phaseAggregate(run.phaseResults[index], index + 1),
      durationMs: typeof turn.durationMs === 'number' && Number.isFinite(turn.durationMs) && turn.durationMs >= 0 ? turn.durationMs : null,
      timedOut: turn.timedOut === true,
      usage: numericProjection(turn.usage, USAGE_FIELDS),
      candidateTree: {
        baseTreeSha256: tree.baseTreeSha256,
        treeSha256: tree.treeSha256,
        fileCount: tree.fileCount,
        totalBytes: tree.totalBytes,
        changedFiles: tree.changedFiles,
        deletions: tree.deletions,
      },
      declaredArtifact: artifactAggregate(declaredArtifacts[index]),
    });
  }
  records.push({
    type: 'finalScore',
    core: score.core.points,
    exact: score.exact,
    adaptability: score.adaptability.points,
    proxyGap: score.proxyGap,
    public: { points: score.core.public.points, passed: score.core.public.passed, total: score.core.public.total },
    hidden: { points: score.core.hidden.points, passed: score.core.hidden.passed, total: score.core.hidden.total },
    hiddenAtomic: { points: score.core.hiddenAtomic.points, passed: score.core.hiddenAtomic.passed, total: score.core.hiddenAtomic.total },
    hiddenComposed: { points: score.core.hiddenComposed.points, passed: score.core.hiddenComposed.passed, total: score.core.hiddenComposed.total },
    families: score.core.families.map((family) => ({
      id: family.id,
      points: family.points,
      exact: family.exact,
      publicPoints: family.public.points,
      hiddenPoints: family.hidden.points,
      hiddenAtomicPoints: family.hiddenAtomic.points,
      hiddenComposedPoints: family.hiddenComposed.points,
    })),
  });
  for (const record of records) assertPrivacySafe(record);
  return records;
}

async function atomicWrite(file, bytes) {
  const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporary, bytes, { mode: 0o600 });
  await rename(temporary, file);
}

export async function exportTerminalV7Traces({
  root = MODULE_ROOT,
  resultRoot,
  outputRoot = path.join(resultRoot, 'traces'),
} = {}) {
  invariant(path.isAbsolute(root) && path.isAbsolute(resultRoot) && path.isAbsolute(outputRoot), 'V7 trace paths must be absolute');
  const verified = await verifyTerminalV7Results({ root, resultRoot, writeArtifacts: false });
  invariant(verified.terminalVerified, 'V7 trace export requires a clean terminal verification');
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const pools = [
    ...verified.scoredRuns.map((entry) => ({ pool: 'release', challenge: verified.challenge, schedule: verified.schedule, entry })),
    ...(verified.reserveEvidence?.scoredRuns ?? []).map((entry) => ({ pool: 'reserve', challenge: verified.reserveEvidence.challenge, schedule: verified.reserveEvidence.schedule, entry })),
  ];
  invariant(pools.length === (verified.finalization.reserveRequired ? 35 : 25), 'V7 terminal trace pool coverage does not match the finalization state');
  const expectedNames = new Set(pools.map(({ pool, entry }) => `${pool}-${entry.job.runKey}.aggregate.jsonl.gz`));
  const existing = await readdir(outputRoot, { withFileTypes: true });
  const unexpected = existing.filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl.gz') && !expectedNames.has(entry.name));
  invariant(unexpected.length === 0, 'V7 trace directory contains files outside the sealed schedule');

  const traceFiles = [];
  for (const item of pools) {
    const { pool, challenge, schedule, entry } = item;
    const records = createTerminalV7AggregateTraceRecords({ challenge, schedule, entry, pool });
    const text = `${records.map((record) => canonicalJson(record)).join('\n')}\n`;
    invariant(!FORBIDDEN_VALUE.test(text), 'V7 aggregate trace failed its content privacy audit');
    const compressed = gzipSync(Buffer.from(text, 'utf8'), { level: 9, mtime: 0 });
    const name = `${pool}-${entry.job.runKey}.aggregate.jsonl.gz`;
    const file = path.join(outputRoot, name);
    await atomicWrite(file, compressed);
    const stat = await lstat(file);
    invariant(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, `V7 trace output is unsafe: ${name}`);
    traceFiles.push({
      runKey: entry.job.runKey,
      pool,
      harnessId: entry.job.harness.id,
      instanceId: entry.job.instanceId,
      file: name,
      bytes: stat.size,
      records: records.length,
      sha256: await sha256File(file),
      uncompressedSha256: sha256(text),
    });
  }
  traceFiles.sort((left, right) => left.pool.localeCompare(right.pool) || left.runKey.localeCompare(right.runKey));
  const manifestUnsigned = {
    schemaVersion: 'agentbattler.terminal-v7-trace-manifest.v2',
    finalization: {
      status: verified.finalization.status,
      officialEvidenceSha256: verified.officialEvidenceSha256,
      reserveReportSha256: verified.reserveReport?.reportSha256 ?? null,
    },
    campaigns: [
      {
        pool: 'release',
        challenge: { id: verified.challenge.challengeId, sha256: verified.challenge.challengeSha256 },
        schedule: { id: verified.schedule.scheduleId, sha256: verified.schedule.scheduleSha256 },
        runs: 25,
      },
      ...(verified.reserveEvidence ? [{
        pool: 'reserve',
        challenge: { id: verified.reserveEvidence.challenge.challengeId, sha256: verified.reserveEvidence.challenge.challengeSha256 },
        schedule: { id: verified.reserveEvidence.schedule.scheduleId, sha256: verified.reserveEvidence.schedule.scheduleSha256 },
        runs: 10,
      }] : []),
    ],
    operational: verified.summary.operationalPools,
    privacyPolicy: {
      representation: 'aggregate-only',
      retainedClasses: ['identity-commitments', 'aggregate-usage', 'aggregate-resources', 'aggregate-phase-outcomes', 'tree-hashes'],
      omittedClasses: ['candidate-source', 'candidate-paths', 'agent-input', 'agent-output', 'tool-invocations', 'security-material', 'native-session-identifiers'],
    },
    runs: traceFiles,
  };
  assertPrivacySafe(manifestUnsigned);
  const manifest = { ...manifestUnsigned, manifestSha256: canonicalJsonSha256(manifestUnsigned) };
  await atomicWrite(path.join(outputRoot, 'manifest.json'), Buffer.from(`${canonicalJson(manifest, { space: 2 })}\n`, 'utf8'));
  return manifest;
}

async function main() {
  const revision = process.env.AGENTBATTLER_TERMINAL_PROTOCOL_REVISION ?? 'r2';
  const resultTag = process.env.AGENTBATTLER_TERMINAL_RESULT_TAG ?? `v7-${revision}`;
  invariant(/^r[1-9]\d*$/.test(revision), 'V7 protocol revision must look like r1');
  invariant(/^v7-r[1-9]\d*$/.test(resultTag), 'V7 result tag must look like v7-r1');
  invariant(!process.argv.includes('--allow-incomplete'), 'Strict V7 trace export does not allow incomplete results');
  const resultRoot = path.resolve(process.env.AGENTBATTLER_TERMINAL_RESULT_ROOT
    ?? path.join(MODULE_ROOT, `results/terminal-mini-ledger-${resultTag}`));
  const manifest = await exportTerminalV7Traces({ root: MODULE_ROOT, resultRoot });
  console.log(`Mini Ledger V7 aggregate traces: ${manifest.runs.length}/${manifest.runs.length} exported across ${manifest.campaigns.length} pool(s)`);
  console.log(`Privacy policy: aggregate metrics and tree hashes only; prompts, responses, commands, source, and authentication omitted`);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main().catch((error) => {
  console.error(`Mini Ledger V7 trace export failed: ${error.message}`);
  process.exitCode = 1;
});
