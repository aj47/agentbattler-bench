#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';

import {
  canonicalJson,
  canonicalJsonSha256,
  createChecksumManifest,
  formatChecksumManifest,
  sha256File,
} from '../src/provenance.mjs';
import { fileArtifact, SNAPSHOT_SCHEMA, writeSnapshot } from '../src/snapshot.mjs';
import {
  buildTerminalCampaignSiteData,
  materializeTerminalSnapshotPaths,
} from '../src/terminal-publication.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CAMPAIGN_ROOT = path.join(ROOT, 'results/terminal-mini-ledger-v5-r4-reliability');
const DEFAULT_OUTPUT_ROOT = path.join(ROOT, '.artifacts/terminal-publication');
const SECRET_CONTENT = /(?:(?:access|refresh)[_-]?token|api[_-]?key|authorization|password|oauth|credential|secret)\s*["'=:\s]+(?:bearer\s+)?[A-Za-z0-9_./+\-]{20,}|\bsk-[A-Za-z0-9_-]{20,}/i;
const HOST_PATH = /\/(?:Users|home)\/[A-Za-z0-9._-]+\//;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArguments(argv) {
  const options = {
    campaignRoot: DEFAULT_CAMPAIGN_ROOT,
    outputRoot: DEFAULT_OUTPUT_ROOT,
    datasetRepo: 'techfren/agentbattler-bench',
    releaseRepository: 'aj47/agentbattler-bench',
    snapshotId: null,
    allowIncomplete: false,
    sourceRoots: {},
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--campaign-root') options.campaignRoot = path.resolve(argv[++index]);
    else if (value === '--output') options.outputRoot = path.resolve(argv[++index]);
    else if (value === '--dataset-repo') options.datasetRepo = argv[++index];
    else if (value === '--release-repository') options.releaseRepository = argv[++index];
    else if (value === '--snapshot-id') options.snapshotId = argv[++index];
    else if (value === '--source-r2') options.sourceRoots.R2 = path.resolve(argv[++index]);
    else if (value === '--source-r3') options.sourceRoots.R3 = path.resolve(argv[++index]);
    else if (value === '--source-r4') options.sourceRoots.R4 = path.resolve(argv[++index]);
    else if (value === '--allow-incomplete') options.allowIncomplete = true;
    else throw new Error(`Unexpected argument: ${value}`);
  }
  return options;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function walk(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(absolute));
    else if (entry.isFile()) result.push(absolute);
  }
  return result;
}

async function copy(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

async function run(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    const child = spawn(command, args, {
      cwd: options.cwd ?? ROOT,
      env: options.env ?? process.env,
      shell: false,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    if (options.capture) {
      child.stdout.on('data', (chunk) => chunks.push(chunk));
      child.stderr.on('data', (chunk) => chunks.push(chunk));
    }
    child.once('error', reject);
    child.once('close', (code) => {
      const output = Buffer.concat(chunks).toString('utf8').trim();
      if (code === 0) resolve(output);
      else reject(new Error(`${command} exited ${code}${output ? `: ${output}` : ''}`));
    });
  });
}

async function inspectText(file, { allowHostPaths = false } = {}) {
  let tail = '';
  const stream = file.endsWith('.gz')
    ? createReadStream(file, { highWaterMark: 1024 * 1024 }).pipe(createGunzip()).setEncoding('utf8')
    : createReadStream(file, { encoding: 'utf8', highWaterMark: 1024 * 1024 });
  for await (const chunk of stream) {
    const content = tail + chunk;
    invariant(!SECRET_CONTENT.test(content), `Potential credential content in ${file}`);
    if (!allowHostPaths) invariant(!HOST_PATH.test(content), `Host path found in publication artifact ${file}`);
    tail = content.slice(-2048);
  }
}

function safeSnapshotId(updatedAt) {
  const date = new Date(updatedAt);
  invariant(!Number.isNaN(date.valueOf()), 'Terminal campaign has an invalid updatedAt');
  return `mini-ledger-v5-${date.toISOString().toLowerCase().replace(/[:.]/g, '-')}`;
}

function sourceRoot(campaignSource, overrides) {
  return path.resolve(overrides[campaignSource.id] ?? campaignSource.resultRoot);
}

function sanitizedCampaign(campaign) {
  return {
    schemaVersion: campaign.schemaVersion,
    phase: campaign.phase,
    generatedAt: campaign.generatedAt,
    counts: campaign.counts,
    policy: campaign.policy,
    sources: campaign.sources.map(({ id, protocolRevision }) => ({ id, protocolRevision })),
    accepted: campaign.accepted.map((entry) => ({
      logicalKey: entry.logicalKey,
      harness: entry.harness,
      model: entry.model,
      generation: entry.generation,
      source: {
        sourceId: entry.source.sourceId,
        protocolRevision: entry.source.protocolRevision,
        runKey: entry.source.runKey,
      },
    })),
    outstanding: campaign.outstanding.map((entry) => ({
      logicalKey: entry.logicalKey,
      harness: entry.harness,
      model: entry.model,
      generation: entry.generation,
      attemptCount: entry.attemptCount,
      status: entry.status,
      latestSource: entry.latestSource ? {
        sourceId: entry.latestSource.sourceId,
        protocolRevision: entry.latestSource.protocolRevision,
        runKey: entry.latestSource.runKey,
        status: entry.latestSource.status,
        error: entry.latestSource.error,
      } : null,
    })),
  };
}

function readme(snapshotId, lane, datasetRepo) {
  const failed = lane.totals.failedAttempts;
  return [
    '---',
    'pretty_name: AgentBattler Mini Ledger V5',
    'tags:',
    '- agent-traces',
    '- benchmark',
    '- coding-agents',
    '- long-horizon',
    'configs:',
    '- config_name: terminal_runs',
    '  data_files: data/runs.jsonl',
    '---',
    '',
    '# AgentBattler Mini Ledger V5',
    '',
    `Immutable evidence for ${lane.campaign.acceptedRuns}/${lane.campaign.expectedRuns} accepted Mini Ledger V5 runs across 12 harness × model conditions.`,
    '',
    '## What is here',
    '',
    `- \`snapshots/${snapshotId}/site/terminal-campaign.json\`: compact website and analysis input.`,
    `- \`snapshots/${snapshotId}/campaign.json\`: source-revision-preserving campaign index with host paths removed.`,
    `- \`snapshots/${snapshotId}/runs/\`: full accepted run records.`,
    `- \`snapshots/${snapshotId}/traces/\`: credential-redacted semantic traces containing visible messages, tool calls, results, usage events, and stderr; no hidden chain-of-thought.`,
    `- \`snapshots/${snapshotId}/attempts/\`: compact records for ${failed} infrastructure-invalid attempts retained for reliability analysis.`,
    `- \`snapshots/${snapshotId}/sources/\`: the exact R2, R3, and R4 challenge, schedule, summary, and trace manifests.`,
    '',
    '## Interpretation',
    '',
    'V5 is a compatibility-audited campaign assembled from preserved R2, R3, and R4 evidence. Every normalized run records its source revision and hashes. Revisions changed harness reliability or telemetry—not the 15-turn task, scoring contract, 30-minute per-turn budget, model, or requested high reasoning setting. Scores use 70 visible stage points plus 30 points spread evenly across 11 holdout checks.',
    '',
    'Token and cache fields are the values reported by each harness. Cache-read rate is cached-input divided by input tokens. It is published for inspection and is not used for ranking because harness reporting semantics differ.',
    '',
    `Dataset: https://huggingface.co/datasets/${datasetRepo}`,
    '',
  ].join('\n');
}

async function resolveTrace(source, trace) {
  const candidates = [
    path.isAbsolute(trace.path) ? trace.path : null,
    path.join(source.root, 'traces', path.basename(trace.path)),
    path.resolve(source.root, trace.path),
    path.resolve(ROOT, trace.path),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      // Try the next declared location.
    }
  }
  throw new Error(`Cannot resolve ${source.id} trace ${trace.path}`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const lane = await buildTerminalCampaignSiteData({
    campaignRoot: options.campaignRoot,
    sourceRoots: options.sourceRoots,
    allowIncomplete: options.allowIncomplete,
  });
  const snapshotId = options.snapshotId ?? safeSnapshotId(lane.updatedAt);
  invariant(/^[a-z0-9][a-z0-9.-]*$/.test(snapshotId), 'Invalid snapshot ID');
  const snapshotRoot = path.join(options.outputRoot, snapshotId);
  const datasetRoot = path.join(snapshotRoot, 'dataset');
  const releaseRoot = path.join(snapshotRoot, 'release');
  const stagingRoot = path.join(datasetRoot, 'snapshots', snapshotId);
  await rm(snapshotRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });

  const campaign = await readJson(path.join(options.campaignRoot, 'campaign-index.json'));
  let finalization = null;
  if (!options.allowIncomplete) {
    const [artifacts, traceIndex] = await Promise.all([
      readJson(path.join(options.campaignRoot, 'campaign-artifacts.json')),
      readJson(path.join(options.campaignRoot, 'campaign-trace-index.json')),
    ]);
    const { artifactsSha256, ...artifactsUnsigned } = artifacts;
    const { traceIndexSha256, ...traceIndexUnsigned } = traceIndex;
    invariant(artifactsSha256 === canonicalJsonSha256(artifactsUnsigned), 'Campaign artifacts integrity hash mismatch');
    invariant(traceIndexSha256 === canonicalJsonSha256(traceIndexUnsigned), 'Campaign trace index integrity hash mismatch');
    invariant(artifacts.campaign.indexSha256 === canonicalJsonSha256(campaign), 'Finalized campaign index hash mismatch');
    invariant(traceIndex.totals.logicalRuns === campaign.counts.accepted, 'Finalized trace coverage disagrees with accepted campaign runs');
    finalization = { artifactsSha256, traceIndexSha256 };
  }
  const sources = new Map();
  for (const descriptor of campaign.sources) {
    const root = sourceRoot(descriptor, options.sourceRoots);
    const traceManifest = await readJson(path.join(root, 'trace-manifest.json'));
    sources.set(descriptor.id, { ...descriptor, root, traceManifest });
    const target = path.join(stagingRoot, 'sources', descriptor.id);
    for (const name of ['challenge.json', 'schedule.json', 'summary.json', 'trace-manifest.json']) {
      await copy(path.join(root, name), path.join(target, name));
    }
  }

  const safeCampaign = { ...sanitizedCampaign(campaign), finalization };
  await writeFile(path.join(stagingRoot, 'campaign.json'), `${canonicalJson(safeCampaign, { space: 2 })}\n`);
  const normalizedRuns = [];
  for (const combo of lane.combos) {
    for (const runRecord of combo.runs) {
      const accepted = campaign.accepted.find((entry) => entry.logicalKey === runRecord.logicalKey);
      const source = sources.get(accepted.source.sourceId);
      const runSource = path.join(source.root, 'runs', `${accepted.source.runKey}.json`);
      const runTarget = path.join(stagingRoot, 'runs', `${runRecord.slug}.json`);
      await copy(runSource, runTarget);
      await inspectText(runTarget);
      const trace = source.traceManifest.traces.find((entry) => entry.runKey === accepted.source.runKey);
      invariant(trace, `Missing trace for ${runRecord.logicalKey}`);
      const traceSource = await resolveTrace(source, trace);
      invariant(await sha256File(traceSource) === trace.publishedSha256, `Trace hash mismatch for ${runRecord.logicalKey}`);
      const traceTarget = path.join(stagingRoot, 'traces', `${runRecord.slug}.jsonl.gz`);
      await copy(traceSource, traceTarget);
      await inspectText(traceTarget);
      const attemptsTarget = path.join(stagingRoot, 'attempts', `${runRecord.slug}.json`);
      await mkdir(path.dirname(attemptsTarget), { recursive: true });
      await writeFile(attemptsTarget, `${canonicalJson({ logicalKey: runRecord.logicalKey, attempts: runRecord.attempts }, { space: 2 })}\n`);
      normalizedRuns.push({
        logicalKey: runRecord.logicalKey,
        slug: runRecord.slug,
        harness: runRecord.harness,
        harnessVersion: runRecord.harnessVersion,
        model: runRecord.model,
        generation: runRecord.generationIndex,
        scorePct: runRecord.scorePct,
        durationMs: runRecord.durationMs,
        inputTokens: runRecord.usage.inputTokens,
        cachedInputTokens: runRecord.usage.cachedInputTokens,
        outputTokens: runRecord.usage.outputTokens,
        reasoningTokens: runRecord.usage.reasoningTokens,
        sourceId: runRecord.source.id,
        protocolRevision: runRecord.source.protocolRevision,
        resultPath: `snapshots/${snapshotId}/runs/${runRecord.slug}.json`,
        tracePath: `snapshots/${snapshotId}/traces/${runRecord.slug}.jsonl.gz`,
      });
    }
  }

  const materializedLane = materializeTerminalSnapshotPaths(lane, snapshotId);
  const siteDataFile = path.join(stagingRoot, 'site', 'terminal-campaign.json');
  await mkdir(path.dirname(siteDataFile), { recursive: true });
  await writeFile(siteDataFile, `${canonicalJson(materializedLane, { space: 2 })}\n`);
  const runsJsonl = path.join(datasetRoot, 'data', 'runs.jsonl');
  await mkdir(path.dirname(runsJsonl), { recursive: true });
  await writeFile(runsJsonl, `${normalizedRuns.map((run) => canonicalJson(run)).join('\n')}\n`);
  await writeFile(path.join(datasetRoot, 'README.md'), readme(snapshotId, materializedLane, options.datasetRepo));

  for (const file of await walk(datasetRoot)) await inspectText(file);
  const manifestPath = path.join(stagingRoot, 'manifest.json');
  const payload = (await walk(datasetRoot))
    .filter((file) => file !== manifestPath)
    .map((file) => path.relative(datasetRoot, file).split(path.sep).join('/'));
  const manifest = await createChecksumManifest(payload, { root: datasetRoot });
  await writeFile(manifestPath, `${canonicalJson(manifest, { space: 2 })}\n`);
  await writeFile(path.join(stagingRoot, 'SHA256SUMS'), formatChecksumManifest(manifest));

  await mkdir(releaseRoot, { recursive: true });
  const archiveName = `agentbattler-${snapshotId}.tar.gz`;
  const archivePath = path.join(releaseRoot, archiveName);
  await run('tar', ['-czf', archivePath, '-C', datasetRoot, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const releaseManifest = await createChecksumManifest([archiveName], { root: releaseRoot });
  await writeFile(path.join(releaseRoot, 'manifest.json'), `${canonicalJson(releaseManifest, { space: 2 })}\n`);
  await writeFile(path.join(releaseRoot, 'SHA256SUMS'), formatChecksumManifest(releaseManifest));
  const gitCommit = await run('git', ['rev-parse', 'HEAD'], { capture: true });
  const snapshot = await writeSnapshot(path.join(snapshotRoot, 'snapshot.unpublished.json'), {
    schemaVersion: SNAPSHOT_SCHEMA,
    snapshotId,
    createdAt: materializedLane.updatedAt,
    source: { gitCommit },
    dataset: {
      repoType: 'dataset',
      repoId: options.datasetRepo,
      revision: null,
      root: `snapshots/${snapshotId}`,
      siteData: await fileArtifact(siteDataFile, `snapshots/${snapshotId}/site/terminal-campaign.json`),
      manifest: await fileArtifact(manifestPath, `snapshots/${snapshotId}/manifest.json`),
    },
    release: {
      repository: options.releaseRepository,
      tag: `snapshot-${snapshotId}`,
      archive: await fileArtifact(archivePath, archiveName),
    },
    publication: {
      title: `AgentBattler Mini Ledger V5 · ${materializedLane.campaign.acceptedRuns} runs`,
      description: 'Immutable Mini Ledger V5 campaign evidence: full accepted results, semantic traces, source revisions, retry records, checksums, and website analysis data.',
    },
    totals: {
      runs: materializedLane.campaign.acceptedRuns,
      turns: materializedLane.campaign.acceptedRuns * materializedLane.protocol.turns,
      tokens: materializedLane.totals.totalTokens,
      toolCalls: materializedLane.totals.toolCalls,
      failedAttempts: materializedLane.totals.failedAttempts,
    },
  });
  await writeFile(path.join(releaseRoot, 'snapshot.unpublished.json'), `${canonicalJson(snapshot, { space: 2 })}\n`);
  await writeFile(path.join(releaseRoot, 'release-notes.md'), [
    `# ${snapshot.publication.title}`,
    '',
    snapshot.publication.description,
    '',
    `Source benchmark commit: \`${gitCommit}\``,
    '',
    'The archive is checksum-sealed and byte-equivalent to the revision-pinned Hugging Face dataset tree.',
    '',
  ].join('\n'));
  await mkdir(options.outputRoot, { recursive: true });
  await writeFile(path.join(options.outputRoot, 'latest.json'), `${canonicalJson({ snapshotRoot }, { space: 2 })}\n`);
  console.log(`Packaged ${snapshotId}: ${normalizedRuns.length} accepted runs and ${materializedLane.totals.failedAttempts} retained invalid attempts.`);
  console.log(`Dataset staging: ${datasetRoot}`);
  console.log(`Release staging: ${releaseRoot}`);
}

main().catch((error) => {
  console.error(`Terminal publication package: ${error.message}`);
  process.exitCode = 1;
});
