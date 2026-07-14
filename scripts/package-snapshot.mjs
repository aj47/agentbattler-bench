#!/usr/bin/env node
import { spawn } from 'node:child_process';
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  canonicalJson,
  canonicalJsonSha256,
  createChecksumManifest,
  formatChecksumManifest,
  sha256File,
  verifyChecksumManifest,
} from '../src/provenance.mjs';
import { fileArtifact, SNAPSHOT_SCHEMA, writeSnapshot } from '../src/snapshot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = path.join(ROOT, 'agents/model-suite/manifest.json');
const SUITE_PATH = path.join(ROOT, 'results/model-suite/generation-suite.json');
const RESULT_ROOT = path.join(ROOT, 'results/model-suite/matches');
const RESULT_PATH = path.join(RESULT_ROOT, 'result.json');
const CHECKSUM_PATH = path.join(RESULT_ROOT, 'checksums.json');
const DEFAULT_OUTPUT_ROOT = path.join(ROOT, '.artifacts/publication');
const SECRET_CONTENT = /(?:(?:access|refresh)[_-]?token|api[_-]?key|authorization)\s*["'=:\s]+(?:bearer\s+)?[A-Za-z0-9_./+\-]{20,}|\bsk-[A-Za-z0-9_-]{20,}/i;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArguments(argv) {
  const options = { outputRoot: DEFAULT_OUTPUT_ROOT, datasetRepo: 'techfren/agentbattler-bench', releaseRepository: 'aj47/agentbattler-bench' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--output') options.outputRoot = path.resolve(argv[++index]);
    else if (value === '--dataset-repo') options.datasetRepo = argv[++index];
    else if (value === '--release-repository') options.releaseRepository = argv[++index];
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

async function writeJsonLines(file, records) {
  await mkdir(path.dirname(file), { recursive: true });
  const content = records.map((record) => canonicalJson(record)).join('\n');
  await writeFile(file, `${content}${content ? '\n' : ''}`);
}

async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, shell: false, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}

async function inspectTextForSecrets(file) {
  const content = await readFile(file, 'utf8');
  invariant(!SECRET_CONTENT.test(content), `Potential credential content found in ${path.relative(ROOT, file)}`);
}

function safeSnapshotId(generatedAt) {
  const date = new Date(generatedAt);
  invariant(!Number.isNaN(date.valueOf()), 'Generation suite has an invalid generatedAt');
  return `model-suite-${date.toISOString().slice(0, 10)}`;
}

function datasetCard(snapshotId) {
  return [
    '---',
    'pretty_name: AgentBattler Bench',
    'tags:',
    '- agent-traces',
    '- benchmark',
    '- chess',
    '- codex',
    'configs:',
    '- config_name: runs',
    '  data_files: data/runs.jsonl',
    '- config_name: matches',
    '  data_files: data/matches.jsonl',
    '- config_name: moves',
    '  data_files: data/moves.jsonl',
    '---',
    '',
    '# AgentBattler Bench',
    '',
    `Public evidence for the ${snapshotId} coding-agent chess benchmark snapshot.`,
    '',
    '- `data/runs.jsonl` contains normalized generation telemetry and immutable evidence paths.',
    '- `data/matches.jsonl` contains one row per recorded game.',
    '- `data/moves.jsonl` contains the move-by-move tournament traces.',
    '- `traces/` preserves the raw Codex CLI event streams.',
    '- `artifacts/` contains the generated JavaScript agents.',
    '- `raw/` and `site/` preserve the complete replay and website inputs.',
    '',
    'Raw traces can contain sensitive information in general. This snapshot is published only after an automated credential scan and manual review. The JSONL files record Codex CLI events, not hidden model chain-of-thought.',
    '',
  ].join('\n');
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [manifest, suite, result, checksums] = await Promise.all([
    readJson(MANIFEST_PATH),
    readJson(SUITE_PATH),
    readJson(RESULT_PATH),
    readJson(CHECKSUM_PATH),
  ]);
  const { resultSha256, ...unsignedResult } = result;
  invariant(resultSha256 === canonicalJsonSha256(unsignedResult), 'Model-suite result integrity hash mismatch');
  const checksumResult = await verifyChecksumManifest(checksums, { root: RESULT_ROOT });
  invariant(checksumResult.ok, `Model-suite checksum mismatch: ${JSON.stringify(checksumResult.mismatches)}`);

  const snapshotId = safeSnapshotId(suite.generatedAt);
  const snapshotRoot = path.join(options.outputRoot, snapshotId);
  const datasetRoot = path.join(snapshotRoot, 'dataset');
  const releaseRoot = path.join(snapshotRoot, 'release');
  const stagingRoot = path.join(datasetRoot, 'snapshots', snapshotId);
  await rm(snapshotRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });

  await run(process.execPath, [path.join(ROOT, 'scripts/build-site-data.mjs')], { cwd: ROOT });
  const siteDataPath = path.join(ROOT, 'web/generated/site-data.json');
  const siteData = await readJson(siteDataPath);
  const runs = [];
  for (const entry of manifest.agents) {
    const metadataPath = path.join(ROOT, entry.provenance.generationMetadata);
    const tracePath = path.join(path.dirname(metadataPath), 'codex.jsonl');
    const stderrPath = path.join(path.dirname(metadataPath), 'codex-stderr.txt');
    const sourcePath = path.join(ROOT, entry.source);
    await inspectTextForSecrets(tracePath);
    await inspectTextForSecrets(stderrPath);
    const metadata = await readJson(metadataPath);
    invariant(await sha256File(sourcePath) === entry.sourceSha256, `Agent source hash mismatch for ${entry.id}`);
    const relativeTrace = `snapshots/${snapshotId}/traces/${entry.id}/${metadata.run.sessionId}.jsonl`;
    const relativeSource = `snapshots/${snapshotId}/artifacts/${entry.id}/agent.js`;
    const relativeMetadata = `snapshots/${snapshotId}/raw/generations/${entry.id}/metadata.json`;
    await copy(tracePath, path.join(datasetRoot, relativeTrace));
    await copy(stderrPath, path.join(datasetRoot, `snapshots/${snapshotId}/raw/generations/${entry.id}/codex-stderr.txt`));
    await copy(metadataPath, path.join(datasetRoot, relativeMetadata));
    await copy(sourcePath, path.join(datasetRoot, relativeSource));
    runs.push({
      snapshotId,
      runId: metadata.run.sessionId,
      agentId: entry.id,
      displayName: entry.displayName,
      harness: entry.provenance.harness,
      harnessVersion: entry.provenance.harnessVersion,
      model: entry.provenance.modelRequested,
      reasoningEffort: entry.provenance.reasoningEffort,
      durationMs: metadata.run.durationMs,
      turns: metadata.telemetry.turnCount,
      toolCalls: metadata.telemetry.toolCallCount,
      mcpCalls: metadata.telemetry.mcpCallCount,
      inputTokens: metadata.telemetry.inputTokens,
      cachedInputTokens: metadata.telemetry.cachedInputTokens,
      outputTokens: metadata.telemetry.outputTokens,
      reasoningTokens: metadata.telemetry.reasoningTokens,
      totalTokens: metadata.telemetry.totalTokens,
      promptSha256: metadata.prompt.sha256,
      artifactSha256: metadata.agent.sha256,
      artifactSizeBytes: metadata.agent.sizeBytes,
      tracePath: relativeTrace,
      metadataPath: relativeMetadata,
      artifactPath: relativeSource,
      probePassed: metadata.probeSummary.passed,
      probeTotal: metadata.probeSummary.total,
    });
  }

  const matches = result.games.map((game) => ({
    snapshotId,
    gameId: game.gameId,
    positionId: game.position.id,
    seed: game.position.seed,
    whiteAgentId: game.agents.w.id,
    blackAgentId: game.agents.b.id,
    outcome: game.final.outcome,
    reason: game.final.reason,
    plies: game.plies.length,
    resultSha256: game.resultSha256,
  }));
  const moves = result.games.flatMap((game) => game.plies.map((ply) => ({
    snapshotId,
    gameId: game.gameId,
    ply: ply.ply,
    color: ply.color,
    agentId: ply.agentId,
    inputFen: ply.input,
    move: ply.move,
    resultingFen: ply.resultingFen,
    runtimeMs: ply.runtimeMs,
    status: ply.status,
  })));
  await writeJsonLines(path.join(datasetRoot, 'data/runs.jsonl'), runs);
  await writeJsonLines(path.join(datasetRoot, 'data/matches.jsonl'), matches);
  await writeJsonLines(path.join(datasetRoot, 'data/moves.jsonl'), moves);
  await writeFile(path.join(datasetRoot, 'README.md'), datasetCard(snapshotId));
  await copy(siteDataPath, path.join(datasetRoot, `snapshots/${snapshotId}/site/site-data.json`));
  await copy(MANIFEST_PATH, path.join(datasetRoot, `snapshots/${snapshotId}/raw/agents/manifest.json`));
  await copy(SUITE_PATH, path.join(datasetRoot, `snapshots/${snapshotId}/raw/generation-suite.json`));
  for (const file of ['result.json', 'checksums.json', 'SHA256SUMS', 'positions.json']) {
    await copy(path.join(RESULT_ROOT, file), path.join(datasetRoot, `snapshots/${snapshotId}/raw/matches/${file}`));
  }

  const manifestRelative = `snapshots/${snapshotId}/manifest.json`;
  const manifestFile = path.join(datasetRoot, manifestRelative);
  const payloadFiles = (await walk(datasetRoot))
    .filter((file) => file !== manifestFile)
    .map((file) => path.relative(datasetRoot, file).split(path.sep).join('/'));
  const datasetManifest = await createChecksumManifest(payloadFiles, { root: datasetRoot });
  await writeFile(manifestFile, `${canonicalJson(datasetManifest, { space: 2 })}\n`);
  await writeFile(path.join(datasetRoot, `snapshots/${snapshotId}/SHA256SUMS`), formatChecksumManifest(datasetManifest));

  await mkdir(releaseRoot, { recursive: true });
  const archiveName = `agentbattler-${snapshotId}.tar.gz`;
  const archivePath = path.join(releaseRoot, archiveName);
  await run('tar', ['-czf', archivePath, '-C', datasetRoot, '.'], { cwd: ROOT, env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const releaseManifestPath = path.join(releaseRoot, 'manifest.json');
  const releaseChecksumsPath = path.join(releaseRoot, 'SHA256SUMS');
  const releaseArtifacts = await createChecksumManifest([archiveName], { root: releaseRoot });
  await writeFile(releaseManifestPath, `${canonicalJson(releaseArtifacts, { space: 2 })}\n`);
  await writeFile(releaseChecksumsPath, formatChecksumManifest(releaseArtifacts));

  const gitCommit = await new Promise((resolve, reject) => {
    const child = spawn('git', ['rev-parse', 'HEAD'], { cwd: ROOT, shell: false, stdio: ['ignore', 'pipe', 'inherit'] });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(Buffer.concat(chunks).toString('utf8').trim()) : reject(new Error(`git exited ${code}`)));
  });
  const snapshot = await writeSnapshot(path.join(snapshotRoot, 'snapshot.unpublished.json'), {
    schemaVersion: SNAPSHOT_SCHEMA,
    snapshotId,
    createdAt: suite.generatedAt,
    source: { gitCommit },
    dataset: {
      repoType: 'dataset',
      repoId: options.datasetRepo,
      revision: null,
      root: `snapshots/${snapshotId}`,
      siteData: await fileArtifact(path.join(datasetRoot, `snapshots/${snapshotId}/site/site-data.json`), `snapshots/${snapshotId}/site/site-data.json`),
      manifest: await fileArtifact(manifestFile, manifestRelative),
    },
    release: {
      repository: options.releaseRepository,
      tag: `snapshot-${snapshotId}`,
      archive: await fileArtifact(archivePath, archiveName),
    },
    totals: {
      runs: runs.length,
      matches: matches.length,
      moves: moves.length,
      tokens: suite.totals.tokens,
      toolCalls: suite.totals.toolCalls,
    },
  });
  await writeFile(path.join(releaseRoot, 'snapshot.unpublished.json'), `${canonicalJson(snapshot, { space: 2 })}\n`);
  console.log(`Packaged ${snapshotId}: ${runs.length} runs, ${matches.length} matches, ${moves.length} moves.`);
  console.log(`Dataset staging: ${datasetRoot}`);
  console.log(`Release staging: ${releaseRoot}`);
}

main().catch((error) => {
  console.error(`Snapshot package: ${error.message}`);
  process.exitCode = 1;
});
