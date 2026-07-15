#!/usr/bin/env node
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canonicalJson,
  canonicalJsonSha256,
  sha256File,
  verifyChecksumManifest,
} from '../src/provenance.mjs';
import {
  fetchVerified,
  githubReleaseAssetUrl,
  huggingFaceResolveUrl,
  readSnapshot,
  verifyFile,
} from '../src/snapshot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(ROOT, 'web/generated/site-data.json');
const PUBLICATION_OUTPUT = path.join(ROOT, 'web/generated/publication.json');
const SNAPSHOT_PATH = path.join(ROOT, 'snapshots/latest.json');
const MANIFEST_PATH = path.join(ROOT, 'agents/model-suite/manifest.json');
const SUITE_PATH = path.join(ROOT, 'results/model-suite/generation-suite.json');
const RESULT_PATH = path.join(ROOT, 'results/model-suite/matches/result.json');
const CHECKSUM_PATH = path.join(ROOT, 'results/model-suite/matches/checksums.json');

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function scoreFor(game, id) {
  if (game.final.outcome === '1/2-1/2') return 0.5;
  const wonAsWhite = game.final.outcome === '1-0' && game.agents.w.id === id;
  const wonAsBlack = game.final.outcome === '0-1' && game.agents.b.id === id;
  return wonAsWhite || wonAsBlack ? 1 : 0;
}

function opponentFor(game, id) {
  return game.agents.w.id === id ? game.agents.b : game.agents.w;
}

function shortHash(value) {
  return value?.slice(0, 12) ?? null;
}

function huggingFaceBlobUrl(snapshot, artifactPath) {
  const repo = snapshot.dataset.repoId.split('/').map(encodeURIComponent).join('/');
  const objectPath = artifactPath.split('/').map(encodeURIComponent).join('/');
  return `https://huggingface.co/datasets/${repo}/blob/${snapshot.dataset.revision}/${objectPath}`;
}

async function preparePublishedSnapshot() {
  if (process.argv.includes('--local')) return false;
  let snapshot;
  try {
    snapshot = await readSnapshot(SNAPSHOT_PATH);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  const artifact = snapshot.dataset.siteData;
  const cache = path.join(ROOT, '.artifacts/cache', snapshot.snapshotId, artifact.sha256, path.basename(artifact.path));
  try {
    await verifyFile(cache, artifact);
  } catch {
    const url = huggingFaceResolveUrl(snapshot, artifact);
    await fetchVerified([url, url, url], cache, artifact);
  }
  const data = await readJson(cache);
  invariant(data.schemaVersion === 'agentbattler.site-data.v1', 'Published site data has an unsupported schema');
  invariant(data.matches.length === snapshot.totals.matches, 'Published site data match count disagrees with snapshot');
  invariant(data.agents.length === snapshot.totals.runs, 'Published site data agent count disagrees with snapshot');
  const traceEvidence = Object.fromEntries(data.agents.map((agent) => {
    const tracePath = `${snapshot.dataset.root}/traces/${agent.id}/${agent.generation.sessionId}.jsonl`;
    const sessionPath = `${snapshot.dataset.root}/sessions/${agent.id}/${agent.generation.sessionId}.jsonl`;
    const traceArtifact = { path: tracePath, sha256: '0'.repeat(64), sizeBytes: 0 };
    const sessionArtifact = { path: sessionPath, sha256: '0'.repeat(64), sizeBytes: 0 };
    return [agent.id, {
      tracePath,
      sessionPath,
      viewerUrl: `https://huggingface.co/datasets/${snapshot.dataset.repoId}/viewer/sessions/train`,
      sessionUrl: huggingFaceBlobUrl(snapshot, sessionPath),
      sessionDownloadUrl: huggingFaceResolveUrl(snapshot, sessionArtifact),
      cliEventsUrl: huggingFaceBlobUrl(snapshot, tracePath),
      cliEventsDownloadUrl: huggingFaceResolveUrl(snapshot, traceArtifact),
    }];
  }));
  await mkdir(path.dirname(OUTPUT), { recursive: true });
  await copyFile(cache, OUTPUT);
  await writeFile(PUBLICATION_OUTPUT, `${canonicalJson({
    snapshotId: snapshot.snapshotId,
    snapshotSha256: snapshot.snapshotSha256,
    datasetUrl: `https://huggingface.co/datasets/${snapshot.dataset.repoId}/tree/${snapshot.dataset.revision}`,
    datasetRevision: snapshot.dataset.revision,
    releaseUrl: `https://github.com/${snapshot.release.repository}/releases/tag/${snapshot.release.tag}`,
    archiveUrl: githubReleaseAssetUrl(snapshot),
    agents: traceEvidence,
  }, { space: 2 })}\n`);
  console.log(`Prepared pinned website data from ${snapshot.dataset.repoId}@${shortHash(snapshot.dataset.revision)}.`);
  return true;
}

async function main() {
  if (await preparePublishedSnapshot()) return;
  const [manifest, suite, result, checksums] = await Promise.all([
    readJson(MANIFEST_PATH),
    readJson(SUITE_PATH),
    readJson(RESULT_PATH),
    readJson(CHECKSUM_PATH),
  ]);

  const { resultSha256, ...unsignedResult } = result;
  invariant(resultSha256 === canonicalJsonSha256(unsignedResult), 'Model-suite result integrity hash mismatch');
  const checksumResult = await verifyChecksumManifest(checksums, {
    root: path.dirname(RESULT_PATH),
  });
  invariant(checksumResult.ok, `Model-suite bundle checksum mismatch: ${JSON.stringify(checksumResult.mismatches)}`);

  const standings = new Map(result.summary.standings.map((row) => [row.agentId, row]));
  const agents = [];
  for (const entry of manifest.agents) {
    const metadataPath = path.join(ROOT, entry.provenance.generationMetadata);
    const [metadata, source, sourceHash] = await Promise.all([
      readJson(metadataPath),
      readFile(path.join(ROOT, entry.source), 'utf8'),
      sha256File(path.join(ROOT, entry.source)),
    ]);
    invariant(sourceHash === entry.sourceSha256, `Source hash mismatch for ${entry.id}`);
    invariant(metadata.agent.sha256 === entry.sourceSha256, `Generation metadata hash mismatch for ${entry.id}`);
    const standing = standings.get(entry.id);
    invariant(standing, `Missing standing for ${entry.id}`);
    const games = result.games.filter((game) => game.agents.w.id === entry.id || game.agents.b.id === entry.id);
    const decisive = games.filter((game) => game.final.outcome !== '1/2-1/2' && game.final.outcome !== 'void');
    agents.push({
      id: entry.id,
      displayName: entry.displayName,
      harness: entry.provenance.harness,
      harnessVersion: entry.provenance.harnessVersion,
      model: entry.provenance.modelRequested,
      reasoningEffort: entry.provenance.reasoningEffort,
      verification: {
        level: 'exploratory',
        label: 'Exploratory local',
        detail: 'Predates the canonical Harbor submission flow and has not been independently reproduced.',
      },
      standing: {
        rank: result.summary.standings.findIndex((row) => row.agentId === entry.id) + 1,
        elo: standing.provisionalElo,
        games: standing.gamesPlayed,
        wins: standing.wins,
        draws: standing.draws,
        losses: standing.losses,
        points: standing.points,
      },
      generation: {
        modelRequested: metadata.run.modelRequested,
        codexVersion: metadata.run.codexVersion,
        durationMs: metadata.run.durationMs,
        turns: metadata.telemetry.turnCount,
        toolCalls: metadata.telemetry.toolCallCount,
        toolBreakdown: metadata.telemetry.toolCallBreakdown,
        mcpCalls: metadata.telemetry.mcpCallCount,
        inputTokens: metadata.telemetry.inputTokens,
        cachedInputTokens: metadata.telemetry.cachedInputTokens,
        outputTokens: metadata.telemetry.outputTokens,
        reasoningTokens: metadata.telemetry.reasoningTokens,
        totalTokens: metadata.telemetry.totalTokens,
        promptPath: metadata.prompt.path,
        promptSha256: metadata.prompt.sha256,
        sessionId: metadata.run.sessionId,
        command: metadata.run.command,
        isolation: metadata.run.isolation,
        probes: metadata.probes,
        probeSummary: metadata.probeSummary,
      },
      artifact: {
        sourcePath: entry.source,
        sourceSha256: entry.sourceSha256,
        sizeBytes: metadata.agent.sizeBytes,
        source,
      },
      matches: games.map((game) => ({
        id: game.gameId,
        opponentId: opponentFor(game, entry.id).id,
        opponentName: opponentFor(game, entry.id).displayName,
        color: game.agents.w.id === entry.id ? 'white' : 'black',
        score: scoreFor(game, entry.id),
        outcome: game.final.outcome,
        reason: game.final.reason,
        positionId: game.position.id,
        seed: game.position.seed,
        plies: game.plies.length,
      })),
      decisiveGames: decisive.length,
    });
  }

  const matches = result.games.map((game) => ({
    id: game.gameId,
    white: {
      id: game.agents.w.id,
      name: game.agents.w.displayName,
      harness: game.agents.w.provenance.harness,
      model: game.agents.w.provenance.modelRequested,
      sourceSha256: game.agents.w.sourceSha256,
    },
    black: {
      id: game.agents.b.id,
      name: game.agents.b.displayName,
      harness: game.agents.b.provenance.harness,
      model: game.agents.b.provenance.modelRequested,
      sourceSha256: game.agents.b.sourceSha256,
    },
    position: game.position,
    final: game.final,
    plies: game.plies.map((ply) => ({
      ply: ply.ply,
      color: ply.color,
      agentId: ply.agentId,
      input: ply.input,
      move: ply.move,
      resultingFen: ply.resultingFen,
      runtimeMs: ply.runtimeMs,
      status: ply.status,
    })),
    resultSha256: game.resultSha256,
  }));

  const uniqueScenarios = new Set(matches.map((match) => [
    match.position.id,
    match.white.id,
    match.black.id,
  ].join('|'))).size;
  const decisive = matches.filter((match) => !['1/2-1/2', 'void'].includes(match.final.outcome));
  const latestDecisive = decisive.find((match) => match.final.reason === 'checkmate') ?? decisive[0] ?? null;
  const data = {
    schemaVersion: 'agentbattler.site-data.v1',
    benchmark: {
      name: 'AgentBattler Bench',
      version: result.inputs.suiteId,
      description: 'Generated chess agents. Verified harnesses. Every run, source file, and match is inspectable.',
      status: 'exploratory-local',
      updatedAt: result.execution.completedAt,
      manifestId: result.inputs.manifestId,
      manifestSha256: result.inputs.manifestSha256,
      resultSha256,
      resultSha256Short: shortHash(resultSha256),
      promptSha256: suite.promptSha256,
      globalConfigUnchanged: suite.globalConfigUnchanged,
      totals: {
        agents: agents.length,
        matches: matches.length,
        uniqueScenarios,
        decisive: decisive.length,
        draws: matches.filter((match) => match.final.outcome === '1/2-1/2').length,
        voids: matches.filter((match) => match.final.outcome === 'void').length,
        agentInvocations: result.summary.agentInvocations,
        generationTokens: suite.totals.tokens,
        generationToolCalls: suite.totals.toolCalls,
        generationMcpCalls: suite.totals.mcpCalls,
        matchDurationMs: result.execution.durationMs,
      },
      warning: result.summary.warning,
    },
    agents,
    matches,
    latestDecisiveId: latestDecisive?.id ?? null,
  };

  await mkdir(path.dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, `${canonicalJson(data, { space: 2 })}\n`);
  await writeFile(PUBLICATION_OUTPUT, `${canonicalJson({
    snapshotId: null,
    snapshotSha256: null,
    datasetUrl: null,
    datasetRevision: null,
    releaseUrl: null,
    archiveUrl: null,
    agents: {},
  }, { space: 2 })}\n`);
  console.log(`Prepared ${agents.length} agents and ${matches.length} matches for ${path.relative(ROOT, OUTPUT)}`);
  console.log(`Verified result ${shortHash(resultSha256)} and ${checksums.entries.length} bundle checksums.`);
}

main().catch((error) => {
  console.error(`AgentBattler site data: ${error.message}`);
  process.exitCode = 1;
});
