#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
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
import { validateNativePiSession } from '../src/pi-harness.mjs';
import { parsePiTraceFile } from '../src/pi-trace.mjs';
import { fileArtifact, SNAPSHOT_SCHEMA, writeSnapshot } from '../src/snapshot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUTPUT_ROOT = path.join(ROOT, '.artifacts/publication');
const SECRET_CONTENT = /(?:(?:access|refresh)[_-]?token|api[_-]?key|authorization)\s*["'=:\s]+(?:bearer\s+)?[A-Za-z0-9_./+\-]{20,}|\bsk-[A-Za-z0-9_-]{20,}/i;
const GENERATION_SUITES = [
  {
    id: 'codex-cli',
    label: 'Codex CLI',
    manifestPath: 'agents/model-suite/manifest.json',
    suitePath: 'results/model-suite/generation-suite.json',
    generationRoot: 'results/model-suite/generations',
    traceName: 'codex.jsonl',
    stderrName: 'codex-stderr.txt',
    parseTrace: parseCodexTrace,
    validateSession: validateNativeCodexSession,
  },
  {
    id: 'pi-coding-agent',
    label: 'Pi',
    manifestPath: 'agents/pi-model-suite/manifest.json',
    suitePath: 'results/pi-model-suite/generation-suite.json',
    generationRoot: 'results/pi-model-suite/generations',
    traceName: 'pi-events.jsonl',
    stderrName: 'pi-stderr.txt',
    parseTraceFile: parsePiTraceFile,
    validateSession: validateNativePiSession,
  },
];
const TOURNAMENTS = [
  { id: 'codex-within-harness', resultRoot: 'results/model-suite/matches' },
  { id: 'pi-within-harness', resultRoot: 'results/pi-model-suite/matches' },
  { id: 'cross-harness-all', resultRoot: 'results/harness-suite/matches' },
];

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
async function readJson(relative) {
  return JSON.parse(await readFile(path.resolve(ROOT, relative), 'utf8'));
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
  let tail = '';
  for await (const chunk of createReadStream(file, { encoding: 'utf8', highWaterMark: 1024 * 1024 })) {
    const content = tail + chunk;
    invariant(!SECRET_CONTENT.test(content), `Potential credential content found in ${path.relative(ROOT, file)}`);
    tail = content.slice(-1024);
  }
}
function safeSnapshotId(generatedAt) {
  const date = new Date(generatedAt);
  invariant(!Number.isNaN(date.valueOf()), 'Generation suite has an invalid generatedAt');
  return `harness-suite-${date.toISOString().toLowerCase().replace(/[:.]/g, '-')}`;
}

function datasetCard(snapshotId, datasetRepo, runs) {
  const datasetUrl = `https://huggingface.co/datasets/${datasetRepo}`;
  const rows = runs.map((run) => `| ${run.displayName} | ${run.harness} | [session](${datasetUrl}/blob/main/${run.sessionPath}) | [events](${datasetUrl}/blob/main/${run.tracePath}) |`);
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
    `    path: snapshots/${snapshotId}/sessions/codex-cli/**/*.jsonl`,
    '- config_name: pi_sessions',
    '  data_files:',
    '  - split: train',
    `    path: snapshots/${snapshotId}/sessions/pi-coding-agent/**/*.jsonl`,
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
    '# AgentBattler Bench: Codex CLI vs Pi',
    '',
    `Public evidence for the ${snapshotId} coding-agent chess benchmark snapshot: 30 generation runs across Codex CLI and Pi, plus within-harness and every-to-every cross-harness games.`,
    '',
    '## Browse the data',
    '',
    `- **[Codex sessions](${datasetUrl}/viewer/sessions/train)** opens native Codex records with prompts, assistant messages, tool calls, and results.`,
    `- **[Pi sessions](${datasetUrl}/viewer/pi_sessions/train)** opens the native Pi session timeline without mixing two different session schemas.`,
    `- **[Normalized events](${datasetUrl}/viewer/events/train)** provides a compact searchable event table; raw streams remain available below.`,
    `- **[Generation runs](${datasetUrl}/viewer/runs/train)** contains harness/model settings, duration, turns, tools, tokens, and evidence paths.`,
    `- **[Chess matches](${datasetUrl}/viewer/matches/train)** contains one row per recorded game with its tournament scope.`,
    `- **[Chess moves](${datasetUrl}/viewer/moves/train)** contains the move-by-move record.`,
    '',
    '## Generation traces',
    '',
    '| Agent | Harness | Native session | Raw event stream |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    `Native session rollouts are preserved under \`snapshots/${snapshotId}/sessions/\`. Original CLI event streams are preserved byte-for-byte under \`snapshots/${snapshotId}/traces/\`; the normalized \`events\` table omits only high-volume Pi streaming deltas while retaining semantic events and exact raw JSON for each included row.`,
    '',
    '- `artifacts/` contains all 30 generated JavaScript agents.',
    '- `raw/` contains both generation suites and all three tournament result bundles.',
    '- `site/` contains the exact revision-pinned website input.',
    '',
    'Agent traces can contain sensitive information in general. This snapshot is published only after an automated credential scan. These records contain visible session and tool events, not hidden model chain-of-thought.',
    '',
  ].join('\n');
}

async function loadTournament(descriptor) {
  const result = await readJson(path.join(descriptor.resultRoot, 'result.json'));
  const checksums = await readJson(path.join(descriptor.resultRoot, 'checksums.json'));
  const { resultSha256, ...unsigned } = result;
  invariant(resultSha256 === canonicalJsonSha256(unsigned), `${descriptor.id} result integrity hash mismatch`);
  const verification = await verifyChecksumManifest(checksums, { root: path.resolve(ROOT, descriptor.resultRoot) });
  invariant(verification.ok, `${descriptor.id} checksum mismatch: ${JSON.stringify(verification.mismatches)}`);
  return { ...descriptor, result, checksums };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const prompt = await readFile(path.join(ROOT, 'benchmark/challenges/chess-agent-v1.md'), 'utf8');
  const generationSuites = await Promise.all(GENERATION_SUITES.map(async (descriptor) => ({
    ...descriptor,
    manifest: await readJson(descriptor.manifestPath),
    suite: await readJson(descriptor.suitePath),
  })));
  const tournaments = await Promise.all(TOURNAMENTS.map(loadTournament));
  const latestGeneratedAt = generationSuites.map((item) => item.suite.generatedAt).sort().at(-1);
  const snapshotId = options.snapshotId ?? safeSnapshotId(latestGeneratedAt);
  invariant(/^[a-z0-9][a-z0-9.-]*$/.test(snapshotId), 'Invalid snapshot ID');

  const snapshotRoot = path.join(options.outputRoot, snapshotId);
  const datasetRoot = path.join(snapshotRoot, 'dataset');
  const releaseRoot = path.join(snapshotRoot, 'release');
  const stagingRoot = path.join(datasetRoot, 'snapshots', snapshotId);
  await rm(snapshotRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });
  await run(process.execPath, [path.join(ROOT, 'scripts/build-site-data.mjs'), '--local'], { cwd: ROOT });
  const siteDataPath = path.join(ROOT, 'web/generated/site-data.json');

  const runs = [];
  const events = [];
  for (const generationSuite of generationSuites) {
    for (const entry of generationSuite.manifest.agents) {
      const generationDir = path.dirname(path.resolve(ROOT, entry.provenance.generationMetadata));
      const metadataPath = path.join(generationDir, 'metadata.json');
      const tracePath = path.join(generationDir, generationSuite.traceName);
      const stderrPath = path.join(generationDir, generationSuite.stderrName);
      const sessionPath = path.join(generationDir, 'session.jsonl');
      const sourcePath = path.resolve(ROOT, entry.source);
      for (const file of [tracePath, stderrPath, sessionPath]) await inspectTextForSecrets(file);
      const metadata = await readJson(metadataPath);
      const sessionContent = await readFile(sessionPath, 'utf8');
      invariant(await sha256File(sourcePath) === entry.sourceSha256, `Agent source hash mismatch for ${entry.id}`);
      invariant(metadata.authentication?.method === 'chatgpt', `${entry.id} was not generated with ChatGPT authentication`);
      invariant(metadata.authentication?.subscriptionAccess === true, `${entry.id} is not marked as subscription access`);
      invariant(metadata.authentication?.apiKeyEnvironmentRemoved === true, `${entry.id} did not remove API-key environment variables`);
      if (generationSuite.id === 'codex-cli') {
        invariant(metadata.run?.isolation?.hostHomeInherited === false, `${entry.id} inherited the host home directory`);
        invariant(metadata.run?.isolation?.allSystemSkillsDisabled === true, `${entry.id} did not disable all system skills`);
        invariant(metadata.run?.isolation?.availableSkillCatalogPresent === false, `${entry.id} contains a skill catalog`);
      } else {
        invariant(metadata.run?.isolation?.hostHomeMounted === false, `${entry.id} mounted the host home directory`);
        invariant(metadata.run?.isolation?.skillsEnabled === false, `${entry.id} enabled Pi skills`);
        invariant(metadata.run?.isolation?.extensionsEnabled === false, `${entry.id} enabled Pi extensions`);
        invariant(metadata.run?.isolation?.configuredMcpServers === 0, `${entry.id} configured MCP servers`);
      }
      invariant(metadata.nativeSession?.sha256 === await sha256File(sessionPath), `Native session hash mismatch for ${entry.id}`);
      invariant(metadata.nativeSession?.sizeBytes === (await stat(sessionPath)).size, `Native session size mismatch for ${entry.id}`);
      const validated = generationSuite.validateSession(sessionContent, {
        sessionId: metadata.run.sessionId,
        model: entry.provenance.modelRequested,
        prompt,
        forbiddenText: [os.homedir(), os.userInfo().username],
      });
      invariant(validated.toolCallCount === metadata.telemetry.toolCallCount, `Native tool-call count mismatch for ${entry.id}`);

      const relativeTrace = `snapshots/${snapshotId}/traces/${entry.provenance.harness}/${entry.id}/${metadata.run.sessionId}.jsonl`;
      const relativeSource = `snapshots/${snapshotId}/artifacts/${entry.id}/agent.js`;
      const relativeMetadata = `snapshots/${snapshotId}/raw/generations/${entry.id}/metadata.json`;
      const relativeSession = `snapshots/${snapshotId}/sessions/${entry.provenance.harness}/${entry.id}/${metadata.run.sessionId}.jsonl`;
      await copy(tracePath, path.join(datasetRoot, relativeTrace));
      await copy(stderrPath, path.join(datasetRoot, `snapshots/${snapshotId}/raw/generations/${entry.id}/stderr.txt`));
      await copy(metadataPath, path.join(datasetRoot, relativeMetadata));
      await copy(sessionPath, path.join(datasetRoot, relativeSession));
      await copy(sourcePath, path.join(datasetRoot, relativeSource));
      const run = {
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
        reasoningTokens: metadata.telemetry.reasoningTokens ?? null,
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
      };
      runs.push(run);
      if (generationSuite.parseTraceFile) events.push(...await generationSuite.parseTraceFile(tracePath, run));
      else events.push(...generationSuite.parseTrace(await readFile(tracePath, 'utf8'), run));
    }
  }

  const matches = tournaments.flatMap((tournament) => tournament.result.games.map((game) => ({
    snapshotId,
    tournament: tournament.id,
    gameId: game.gameId,
    positionId: game.position.id,
    seed: game.position.seed,
    whiteAgentId: game.agents.w.id,
    blackAgentId: game.agents.b.id,
    whiteHarness: game.agents.w.provenance.harness,
    blackHarness: game.agents.b.provenance.harness,
    whiteModel: game.agents.w.provenance.modelRequested,
    blackModel: game.agents.b.provenance.modelRequested,
    outcome: game.final.outcome,
    reason: game.final.reason,
    plies: game.plies.length,
    resultSha256: game.resultSha256,
  })));
  const moves = tournaments.flatMap((tournament) => tournament.result.games.flatMap((game) => game.plies.map((ply) => ({
    snapshotId,
    tournament: tournament.id,
    gameId: game.gameId,
    ply: ply.ply,
    color: ply.color,
    agentId: ply.agentId,
    inputFen: ply.input,
    move: ply.move,
    resultingFen: ply.resultingFen,
    runtimeMs: ply.runtimeMs,
    status: ply.status,
  }))));
  invariant(new Set(matches.map((match) => match.gameId)).size === matches.length, 'Tournament bundles contain duplicate game IDs');
  await writeJsonLines(path.join(datasetRoot, 'data/runs.jsonl'), runs);
  await writeJsonLines(path.join(datasetRoot, 'data/matches.jsonl'), matches);
  await writeJsonLines(path.join(datasetRoot, 'data/moves.jsonl'), moves);
  await writeJsonLines(path.join(datasetRoot, 'data/events.jsonl'), events);
  await writeFile(path.join(datasetRoot, 'README.md'), datasetCard(snapshotId, options.datasetRepo, runs));
  await copy(siteDataPath, path.join(datasetRoot, `snapshots/${snapshotId}/site/site-data.json`));

  for (const generationSuite of generationSuites) {
    await copy(path.resolve(ROOT, generationSuite.manifestPath), path.join(datasetRoot, `snapshots/${snapshotId}/raw/manifests/${generationSuite.id}.json`));
    await copy(path.resolve(ROOT, generationSuite.suitePath), path.join(datasetRoot, `snapshots/${snapshotId}/raw/generation-suites/${generationSuite.id}.json`));
  }
  await copy(path.join(ROOT, 'agents/harness-suite/manifest.json'), path.join(datasetRoot, `snapshots/${snapshotId}/raw/manifests/harness-suite.json`));
  for (const tournament of tournaments) {
    for (const file of await walk(path.resolve(ROOT, tournament.resultRoot))) {
      await copy(file, path.join(datasetRoot, `snapshots/${snapshotId}/raw/tournaments/${tournament.id}`, path.relative(path.resolve(ROOT, tournament.resultRoot), file)));
    }
  }

  const manifestRelative = `snapshots/${snapshotId}/manifest.json`;
  const manifestFile = path.join(datasetRoot, manifestRelative);
  const payloadFiles = (await walk(datasetRoot)).filter((file) => file !== manifestFile).map((file) => path.relative(datasetRoot, file).split(path.sep).join('/'));
  const datasetManifest = await createChecksumManifest(payloadFiles, { root: datasetRoot });
  await writeFile(manifestFile, `${canonicalJson(datasetManifest, { space: 2 })}\n`);
  await writeFile(path.join(datasetRoot, `snapshots/${snapshotId}/SHA256SUMS`), formatChecksumManifest(datasetManifest));

  await mkdir(releaseRoot, { recursive: true });
  const archiveName = `agentbattler-${snapshotId}.tar.gz`;
  const archivePath = path.join(releaseRoot, archiveName);
  await run('tar', ['-czf', archivePath, '-C', datasetRoot, '.'], { cwd: ROOT, env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const releaseArtifacts = await createChecksumManifest([archiveName], { root: releaseRoot });
  await writeFile(path.join(releaseRoot, 'manifest.json'), `${canonicalJson(releaseArtifacts, { space: 2 })}\n`);
  await writeFile(path.join(releaseRoot, 'SHA256SUMS'), formatChecksumManifest(releaseArtifacts));

  const gitCommit = await new Promise((resolve, reject) => {
    const child = spawn('git', ['rev-parse', 'HEAD'], { cwd: ROOT, shell: false, stdio: ['ignore', 'pipe', 'inherit'] });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(Buffer.concat(chunks).toString('utf8').trim()) : reject(new Error(`git exited ${code}`)));
  });
  const createdAt = tournaments.find((item) => item.id === 'cross-harness-all').result.execution.completedAt;
  const snapshot = await writeSnapshot(path.join(snapshotRoot, 'snapshot.unpublished.json'), {
    schemaVersion: SNAPSHOT_SCHEMA,
    snapshotId,
    createdAt,
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
      tokens: generationSuites.reduce((sum, item) => sum + item.suite.totals.tokens, 0),
      toolCalls: generationSuites.reduce((sum, item) => sum + item.suite.totals.toolCalls, 0),
    },
  });
  await writeFile(path.join(releaseRoot, 'snapshot.unpublished.json'), `${canonicalJson(snapshot, { space: 2 })}\n`);
  await writeFile(path.join(options.outputRoot, 'latest.json'), `${canonicalJson({ snapshotRoot }, { space: 2 })}\n`);
  console.log(`Packaged ${snapshotId}: ${runs.length} runs, ${matches.length} matches, ${moves.length} moves, ${events.length} normalized events.`);
  console.log(`Dataset staging: ${datasetRoot}`);
  console.log(`Release staging: ${releaseRoot}`);
}

main().catch((error) => {
  console.error(`Snapshot package: ${error.message}`);
  process.exitCode = 1;
});
