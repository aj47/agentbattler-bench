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
import { validateNativeCodexSession } from '../src/codex-session.mjs';
import { parseCodexTrace } from '../src/codex-trace.mjs';
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
  const options = { outputRoot: DEFAULT_OUTPUT_ROOT, datasetRepo: 'techfren/agentbattler-bench', releaseRepository: 'aj47/agentbattler-bench', snapshotId: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--output') options.outputRoot = path.resolve(argv[++index]);
    else if (value === '--dataset-repo') options.datasetRepo = argv[++index];
    else if (value === '--release-repository') options.releaseRepository = argv[++index];
    else if (value === '--snapshot-id') options.snapshotId = argv[++index];
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
  return `model-suite-${date.toISOString().toLowerCase().replace(/[:.]/g, '-')}`;
}

function datasetCard(snapshotId, datasetRepo, runs) {
  const traceRoot = `snapshots/${snapshotId}/traces`;
  const sessionRoot = `snapshots/${snapshotId}/sessions`;
  const datasetUrl = `https://huggingface.co/datasets/${datasetRepo}`;
  const traceRows = runs.map((run) => `| ${run.displayName} | [Native session](${datasetUrl}/blob/main/${run.sessionPath}) | [CLI events](${datasetUrl}/blob/main/${run.tracePath}) |`);
  return [
    '---',
    'pretty_name: AgentBattler Bench',
    'tags:',
    '- agent-traces',
    '- benchmark',
    '- chess',
    '- codex',
    '- format:agent-traces',
    'configs:',
    '- config_name: sessions',
    '  default: true',
    '  data_files:',
    '  - split: train',
    `    path: snapshots/${snapshotId}/sessions/**/*.jsonl`,
    '- config_name: runs',
    '  data_files: data/runs.jsonl',
    '- config_name: matches',
    '  data_files: data/matches.jsonl',
    '- config_name: moves',
    '  data_files: data/moves.jsonl',
    '- config_name: events',
    '  data_files: data/events.jsonl',
    '---',
    '',
    '# AgentBattler Bench',
    '',
    `Public evidence for the ${snapshotId} coding-agent chess benchmark snapshot.`,
    '',
    '## Browse the data',
    '',
    `- **[Codex sessions](${datasetUrl}/viewer/sessions/train)** opens the native session timeline with prompts, assistant messages, tool calls, and results.`,
    `- **[Codex events](${datasetUrl}/viewer/events/train)** renders the CLI event stream as a searchable analytical table.`,
    `- **[Generation runs](${datasetUrl}/viewer/runs/train)** contains model settings, duration, turns, tool calls, token usage, and immutable evidence paths.`,
    `- **[Chess matches](${datasetUrl}/viewer/matches/train)** contains one row per recorded game.`,
    `- **[Chess moves](${datasetUrl}/viewer/moves/train)** contains the move-by-move tournament record.`,
    '',
    '## Codex traces',
    '',
    '| Agent | Agent Trace session | Analytical event stream |',
    '| --- | --- | --- |',
    ...traceRows,
    '',
    `Native, non-ephemeral Codex session rollouts are preserved under \`${sessionRoot}/\` for the Hugging Face Agent Trace viewer. Original \`codex exec --json\` streams are preserved under \`${traceRoot}/\`; the normalized \`events\` table adds stable run and model context while retaining each exact source event in \`rawEvent\`.`,
    '',
    '- `artifacts/` contains the generated JavaScript agents.',
    '- `raw/` and `site/` preserve the complete replay and website inputs.',
    '',
    'Agent traces can contain sensitive information in general. This snapshot is published only after an automated credential scan and manual review. The JSONL files contain recorded session and CLI events, not hidden model chain-of-thought.',
    '',
  ].join('\n');
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [manifest, suite, result, checksums, prompt] = await Promise.all([
    readJson(MANIFEST_PATH),
    readJson(SUITE_PATH),
    readJson(RESULT_PATH),
    readJson(CHECKSUM_PATH),
    readFile(path.join(ROOT, 'benchmark/challenges/chess-agent-v1.md'), 'utf8'),
  ]);
  const { resultSha256, ...unsignedResult } = result;
  invariant(resultSha256 === canonicalJsonSha256(unsignedResult), 'Model-suite result integrity hash mismatch');
  const checksumResult = await verifyChecksumManifest(checksums, { root: RESULT_ROOT });
  invariant(checksumResult.ok, `Model-suite checksum mismatch: ${JSON.stringify(checksumResult.mismatches)}`);

  const snapshotId = options.snapshotId ?? safeSnapshotId(suite.generatedAt);
  invariant(/^[a-z0-9][a-z0-9.-]*$/.test(snapshotId), 'Invalid snapshot ID');
  const snapshotRoot = path.join(options.outputRoot, snapshotId);
  const datasetRoot = path.join(snapshotRoot, 'dataset');
  const releaseRoot = path.join(snapshotRoot, 'release');
  const stagingRoot = path.join(datasetRoot, 'snapshots', snapshotId);
  await rm(snapshotRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });

  await run(process.execPath, [path.join(ROOT, 'scripts/build-site-data.mjs'), '--local'], { cwd: ROOT });
  const siteDataPath = path.join(ROOT, 'web/generated/site-data.json');
  const siteData = await readJson(siteDataPath);
  const runs = [];
  const events = [];
  for (const entry of manifest.agents) {
    const metadataPath = path.join(ROOT, entry.provenance.generationMetadata);
    const tracePath = path.join(path.dirname(metadataPath), 'codex.jsonl');
    const stderrPath = path.join(path.dirname(metadataPath), 'codex-stderr.txt');
    const sessionPath = path.join(path.dirname(metadataPath), 'session.jsonl');
    const sourcePath = path.join(ROOT, entry.source);
    await inspectTextForSecrets(tracePath);
    await inspectTextForSecrets(stderrPath);
    await inspectTextForSecrets(sessionPath);
    const metadata = await readJson(metadataPath);
    const sessionContent = await readFile(sessionPath, 'utf8');
    invariant(await sha256File(sourcePath) === entry.sourceSha256, `Agent source hash mismatch for ${entry.id}`);
    invariant(metadata.authentication?.method === 'chatgpt', `${entry.id} was not generated with ChatGPT authentication`);
    invariant(metadata.authentication?.subscriptionAccess === true, `${entry.id} is not marked as subscription access`);
    invariant(metadata.authentication?.apiKeyEnvironmentRemoved === true, `${entry.id} did not remove API-key environment variables`);
    invariant(metadata.nativeSession?.sha256 === await sha256File(sessionPath), `Native session hash mismatch for ${entry.id}`);
    invariant(metadata.nativeSession?.sizeBytes === (await stat(sessionPath)).size, `Native session size mismatch for ${entry.id}`);
    validateNativeCodexSession(sessionContent, {
      sessionId: metadata.run.sessionId,
      model: entry.provenance.modelRequested,
      prompt,
    });
    const relativeTrace = `snapshots/${snapshotId}/traces/${entry.id}/${metadata.run.sessionId}.jsonl`;
    const relativeSource = `snapshots/${snapshotId}/artifacts/${entry.id}/agent.js`;
    const relativeMetadata = `snapshots/${snapshotId}/raw/generations/${entry.id}/metadata.json`;
    const relativeSession = `snapshots/${snapshotId}/sessions/${entry.id}/${metadata.run.sessionId}.jsonl`;
    await copy(tracePath, path.join(datasetRoot, relativeTrace));
    await copy(stderrPath, path.join(datasetRoot, `snapshots/${snapshotId}/raw/generations/${entry.id}/codex-stderr.txt`));
    await copy(metadataPath, path.join(datasetRoot, relativeMetadata));
    await copy(sessionPath, path.join(datasetRoot, relativeSession));
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
      sessionPath: relativeSession,
      metadataPath: relativeMetadata,
      artifactPath: relativeSource,
      probePassed: metadata.probeSummary.passed,
      probeTotal: metadata.probeSummary.total,
    });
    events.push(...parseCodexTrace(await readFile(tracePath, 'utf8'), {
      snapshotId,
      runId: metadata.run.sessionId,
      agentId: entry.id,
      displayName: entry.displayName,
      model: entry.provenance.modelRequested,
      reasoningEffort: entry.provenance.reasoningEffort,
    }));
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
  await writeJsonLines(path.join(datasetRoot, 'data/events.jsonl'), events);
  await writeFile(path.join(datasetRoot, 'README.md'), datasetCard(snapshotId, options.datasetRepo, runs));
  await copy(siteDataPath, path.join(datasetRoot, `snapshots/${snapshotId}/site/site-data.json`));
  await copy(MANIFEST_PATH, path.join(datasetRoot, `snapshots/${snapshotId}/raw/agents/manifest.json`));
  await copy(SUITE_PATH, path.join(datasetRoot, `snapshots/${snapshotId}/raw/generation-suite.json`));
  for (const file of await walk(RESULT_ROOT)) {
    const relative = path.relative(RESULT_ROOT, file);
    await copy(file, path.join(datasetRoot, `snapshots/${snapshotId}/raw/matches`, relative));
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
  await writeFile(path.join(options.outputRoot, 'latest.json'), `${canonicalJson({ snapshotRoot }, { space: 2 })}\n`);
  console.log(`Packaged ${snapshotId}: ${runs.length} runs, ${matches.length} matches, ${moves.length} moves.`);
  console.log(`Dataset staging: ${datasetRoot}`);
  console.log(`Release staging: ${releaseRoot}`);
}

main().catch((error) => {
  console.error(`Snapshot package: ${error.message}`);
  process.exitCode = 1;
});
