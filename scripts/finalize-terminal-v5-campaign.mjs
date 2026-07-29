#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson, canonicalJsonSha256 } from '../src/provenance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET_RESULT_ROOT = path.join(ROOT, 'results/terminal-mini-ledger-v5-r4-reliability');
const sources = [
  { id: 'R4', protocolRevision: 'r4', resultTag: 'v5-r4-reliability', resultRoot: TARGET_RESULT_ROOT },
  {
    id: 'R3',
    protocolRevision: 'r3',
    resultTag: 'v5-r3-dotagents-v1-1-9',
    resultRoot: process.env.AGENTBATTLER_V5_R3_RESULT_ROOT
      ?? path.join(homedir(), 'Development/AgentBattlerv2-v5-r3-dotagents/results/terminal-mini-ledger-v5-r3-dotagents-v1-1-9'),
  },
  {
    id: 'R2',
    protocolRevision: 'r2',
    resultTag: 'v5-r2',
    resultRoot: process.env.AGENTBATTLER_V5_R2_RESULT_ROOT
      ?? path.join(homedir(), 'Development/AgentBattlerv2-v5-r2/results/terminal-mini-ledger-v5-r2'),
  },
];

function runNode(script, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, script), ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
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

function verifyHash(value, field, label) {
  const { [field]: actual, ...unsigned } = value;
  if (actual !== canonicalJsonSha256(unsigned)) throw new Error(`${label} integrity hash mismatch`);
  return actual;
}

for (const source of sources) {
  const environment = {
    AGENTBATTLER_TERMINAL_CHALLENGE_VERSION: 'v5',
    AGENTBATTLER_TERMINAL_PROTOCOL_REVISION: source.protocolRevision,
    AGENTBATTLER_TERMINAL_RESULT_TAG: source.resultTag,
    AGENTBATTLER_TERMINAL_RESULT_ROOT: source.resultRoot,
    AGENTBATTLER_TERMINAL_WORK_ROOT: path.join(source.resultRoot, 'work'),
  };
  await runNode('scripts/verify-terminal-results.mjs', ['--allow-incomplete'], environment);
  await runNode('scripts/export-terminal-traces.mjs', ['--allow-incomplete'], environment);
}

const campaign = await readJson(path.join(TARGET_RESULT_ROOT, 'campaign-index.json'));
if (campaign.phase !== 'complete' || campaign.counts.accepted !== campaign.counts.expected) {
  throw new Error(`Campaign is not complete: ${campaign.counts.accepted}/${campaign.counts.expected} accepted`);
}

const artifactsBySource = new Map();
for (const source of sources) {
  const summaryFile = path.join(source.resultRoot, 'summary.json');
  const traceManifestFile = path.join(source.resultRoot, 'trace-manifest.json');
  const [summary, traceManifest] = await Promise.all([readJson(summaryFile), readJson(traceManifestFile)]);
  const summarySha256 = verifyHash(summary, 'summarySha256', `${source.id} summary`);
  const traceManifestSha256 = verifyHash(traceManifest, 'manifestSha256', `${source.id} trace manifest`);
  artifactsBySource.set(source.id, { source, summary, summaryFile, summarySha256, traceManifest, traceManifestFile, traceManifestSha256 });
}

const traces = campaign.accepted.map((entry) => {
  const artifacts = artifactsBySource.get(entry.source.sourceId);
  if (!artifacts) throw new Error(`Unknown accepted source ${entry.source.sourceId}`);
  const trace = artifacts.traceManifest.traces.find((candidate) => candidate.runKey === entry.source.runKey);
  if (!trace) throw new Error(`Missing exported trace for ${entry.logicalKey} from ${entry.source.sourceId}`);
  return {
    logicalKey: entry.logicalKey,
    harness: entry.harness,
    model: entry.model,
    generation: entry.generation,
    sourceId: entry.source.sourceId,
    protocolRevision: entry.source.protocolRevision,
    runKey: entry.source.runKey,
    trace: {
      path: trace.path,
      publishedBytes: trace.publishedBytes,
      publishedSha256: trace.publishedSha256,
    },
  };
});

const documentUnsigned = {
  schemaVersion: 'agentbattler.terminal-v5-campaign-artifacts.v1',
  generatedAt: new Date().toISOString(),
  campaign: {
    index: path.join(TARGET_RESULT_ROOT, 'campaign-index.json'),
    indexSha256: canonicalJsonSha256(campaign),
    accepted: campaign.counts.accepted,
    expected: campaign.counts.expected,
  },
  sources: [...artifactsBySource.values()].map((artifacts) => ({
    id: artifacts.source.id,
    protocolRevision: artifacts.source.protocolRevision,
    resultRoot: artifacts.source.resultRoot,
    summary: { file: artifacts.summaryFile, sha256: artifacts.summarySha256 },
    traceManifest: {
      file: artifacts.traceManifestFile,
      sha256: artifacts.traceManifestSha256,
      exportedRuns: artifacts.traceManifest.totals.runs,
    },
  })),
  totals: {
    logicalRuns: traces.length,
    turns: traces.length * 15,
    publishedBytes: traces.reduce((sum, entry) => sum + entry.trace.publishedBytes, 0),
  },
  traces,
};
const document = { ...documentUnsigned, artifactsSha256: canonicalJsonSha256(documentUnsigned) };
const output = path.join(TARGET_RESULT_ROOT, 'campaign-artifacts.json');
const temporary = `${output}.${process.pid}.tmp`;
await writeFile(temporary, `${canonicalJson(document, { space: 2 })}\n`, { mode: 0o600 });
await rename(temporary, output);
console.log(`V5 campaign artifacts: ${output}`);
