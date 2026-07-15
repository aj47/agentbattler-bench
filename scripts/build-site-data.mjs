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
import { summarizeModelFamilies } from '../src/model-family-summary.mjs';
import { summarizeHarnessComparison } from '../src/harness-summary.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(ROOT, 'web/generated/site-data.json');
const PUBLICATION_OUTPUT = path.join(ROOT, 'web/generated/publication.json');
const SNAPSHOT_PATH = path.join(ROOT, 'snapshots/latest.json');
const SUITES = [
  {
    id: 'codex-cli',
    displayName: 'Codex CLI',
    manifest: 'agents/model-suite/manifest.json',
    suite: 'results/model-suite/generation-suite.json',
    resultRoot: 'results/model-suite/matches',
  },
  {
    id: 'pi-coding-agent',
    displayName: 'Pi',
    manifest: 'agents/pi-model-suite/manifest.json',
    suite: 'results/pi-model-suite/generation-suite.json',
    resultRoot: 'results/pi-model-suite/matches',
  },
];
const CROSS = {
  manifest: 'agents/harness-suite/manifest.json',
  resultRoot: 'results/harness-suite/matches',
};

async function readJson(file) {
  return JSON.parse(await readFile(path.resolve(ROOT, file), 'utf8'));
}
function invariant(condition, message) {
  if (!condition) throw new Error(message);
}
function shortHash(value) {
  return value?.slice(0, 12) ?? null;
}
function scoreFor(game, id) {
  if (game.final.outcome === 'void') return null;
  if (game.final.outcome === '1/2-1/2') return 0.5;
  const wonAsWhite = game.final.outcome === '1-0' && game.agents.w.id === id;
  const wonAsBlack = game.final.outcome === '0-1' && game.agents.b.id === id;
  return wonAsWhite || wonAsBlack ? 1 : 0;
}
function opponentFor(game, id) {
  return game.agents.w.id === id ? game.agents.b : game.agents.w;
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
  invariant(data.schemaVersion === 'agentbattler.site-data.v2', 'Published site data has an unsupported schema');
  invariant(data.matches.length === snapshot.totals.matches, 'Published site data match count disagrees with snapshot');
  invariant(data.agents.length === snapshot.totals.runs, 'Published site data agent count disagrees with snapshot');
  invariant(data.harnesses.length === 2, 'Published site data lacks both harnesses');
  invariant(data.harnessComparison?.models?.length === 3, 'Published site data lacks the controlled harness comparison');
  const traceEvidence = Object.fromEntries(data.agents.map((agent) => {
    const tracePath = `${snapshot.dataset.root}/traces/${agent.harness}/${agent.id}/${agent.generation.sessionId}.jsonl`;
    const sessionPath = `${snapshot.dataset.root}/sessions/${agent.harness}/${agent.id}/${agent.generation.sessionId}.jsonl`;
    const traceArtifact = { path: tracePath, sha256: '0'.repeat(64), sizeBytes: 0 };
    const sessionArtifact = { path: sessionPath, sha256: '0'.repeat(64), sizeBytes: 0 };
    return [agent.id, {
      tracePath,
      sessionPath,
      viewerUrl: `https://huggingface.co/datasets/${snapshot.dataset.repoId}/viewer/${agent.harness === 'pi-coding-agent' ? 'pi_sessions' : 'sessions'}/train`,
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

async function loadTournament(resultRoot, label) {
  const resultPath = path.join(resultRoot, 'result.json');
  const checksumPath = path.join(resultRoot, 'checksums.json');
  const [result, checksums] = await Promise.all([readJson(resultPath), readJson(checksumPath)]);
  const { resultSha256, ...unsignedResult } = result;
  invariant(resultSha256 === canonicalJsonSha256(unsignedResult), `${label} result integrity hash mismatch`);
  const verification = await verifyChecksumManifest(checksums, { root: path.resolve(ROOT, resultRoot) });
  invariant(verification.ok, `${label} bundle checksum mismatch: ${JSON.stringify(verification.mismatches)}`);
  return { result, resultSha256, checksums };
}

function standingFor(result, id) {
  const index = result.summary.standings.findIndex((row) => row.agentId === id);
  const row = result.summary.standings[index];
  invariant(row, `Missing standing for ${id}`);
  return {
    rank: index + 1,
    elo: row.provisionalElo,
    games: row.gamesPlayed,
    wins: row.wins,
    draws: row.draws,
    losses: row.losses,
    points: row.points,
  };
}

function matchSummary(game, id) {
  const opponent = opponentFor(game, id);
  return {
    id: game.gameId,
    opponentId: opponent.id,
    opponentName: opponent.displayName,
    color: game.agents.w.id === id ? 'white' : 'black',
    score: scoreFor(game, id),
    outcome: game.final.outcome,
    reason: game.final.reason,
    positionId: game.position.id,
    seed: game.position.seed,
    plies: game.plies.length,
    scope: game.agents.w.provenance.harness === game.agents.b.provenance.harness ? 'within-harness' : 'cross-harness',
  };
}

function publicMatch(game) {
  return {
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
  };
}

async function main() {
  if (await preparePublishedSnapshot()) return;
  const loadedSuites = await Promise.all(SUITES.map(async (descriptor) => {
    const [manifest, suite, tournament] = await Promise.all([
      readJson(descriptor.manifest),
      readJson(descriptor.suite),
      loadTournament(descriptor.resultRoot, descriptor.displayName),
    ]);
    return { ...descriptor, manifest, suite, ...tournament };
  }));
  const [crossManifest, crossTournament] = await Promise.all([
    readJson(CROSS.manifest),
    loadTournament(CROSS.resultRoot, 'Cross-harness'),
  ]);
  invariant(crossManifest.agents.length === 30, 'Cross-harness roster must contain 30 agents');

  const allGames = [...loadedSuites.flatMap((item) => item.result.games), ...crossTournament.result.games];
  const agents = [];
  const harnesses = [];
  for (const item of loadedSuites) {
    const familyAgents = [];
    for (const entry of item.manifest.agents) {
      const [metadata, source, sourceHash] = await Promise.all([
        readJson(entry.provenance.generationMetadata),
        readFile(path.resolve(ROOT, entry.source), 'utf8'),
        sha256File(path.resolve(ROOT, entry.source)),
      ]);
      invariant(sourceHash === entry.sourceSha256, `Source hash mismatch for ${entry.id}`);
      invariant(metadata.agent.sha256 === entry.sourceSha256, `Generation metadata hash mismatch for ${entry.id}`);
      const games = allGames.filter((game) => game.agents.w.id === entry.id || game.agents.b.id === entry.id);
      const localStanding = standingFor(item.result, entry.id);
      const crossStanding = standingFor(crossTournament.result, entry.id);
      const generation = {
        modelRequested: metadata.run.modelRequested,
        harnessVersion: metadata.run.harnessVersion ?? metadata.run.codexVersion ?? entry.provenance.harnessVersion,
        durationMs: metadata.run.durationMs,
        turns: metadata.telemetry.turnCount,
        toolCalls: metadata.telemetry.toolCallCount,
        toolBreakdown: metadata.telemetry.toolCallBreakdown,
        mcpCalls: metadata.telemetry.mcpCallCount,
        inputTokens: metadata.telemetry.inputTokens,
        cachedInputTokens: metadata.telemetry.cachedInputTokens,
        outputTokens: metadata.telemetry.outputTokens,
        reasoningTokens: metadata.telemetry.reasoningTokens ?? null,
        totalTokens: metadata.telemetry.totalTokens,
        promptPath: metadata.prompt.path,
        promptSha256: metadata.prompt.sha256,
        sessionId: metadata.run.sessionId,
        command: metadata.run.command,
        isolation: metadata.run.isolation,
        probes: metadata.probes,
        probeSummary: metadata.probeSummary,
      };
      const agent = {
        id: entry.id,
        familyId: entry.provenance.modelFamilyId,
        displayName: entry.displayName,
        harness: entry.provenance.harness,
        harnessVersion: entry.provenance.harnessVersion,
        model: entry.provenance.modelRequested,
        reasoningEffort: entry.provenance.reasoningEffort,
        verification: {
          level: 'exploratory',
          label: 'Exploratory local',
          detail: 'Evidence bundle verified locally; independent Harbor reproduction is not yet claimed.',
        },
        standing: crossStanding,
        generation,
        artifact: { sourcePath: entry.source, sourceSha256: entry.sourceSha256, sizeBytes: metadata.agent.sizeBytes, source },
        matches: games.map((game) => matchSummary(game, entry.id)),
        decisiveGames: games.filter((game) => !['1/2-1/2', 'void'].includes(game.final.outcome)).length,
      };
      agents.push(agent);
      familyAgents.push({ ...agent, standing: localStanding });
    }
    const families = summarizeModelFamilies({ families: item.suite.families, agents: familyAgents, games: item.result.games });
    harnesses.push({
      id: item.id,
      displayName: item.displayName,
      harnessVersion: item.manifest.agents[0]?.provenance.harnessVersion ?? 'unknown',
      families,
      totals: {
        agents: item.manifest.agents.length,
        matches: item.result.games.length,
        tokens: item.suite.totals.tokens,
        toolCalls: item.suite.totals.toolCalls,
        mcpCalls: item.suite.totals.mcpCalls,
        durationMs: item.suite.totals.durationMs,
      },
    });
  }

  const matches = allGames.map(publicMatch);
  invariant(new Set(matches.map((match) => match.id)).size === matches.length, 'Combined tournaments contain duplicate game IDs');
  const decisive = matches.filter((match) => !['1/2-1/2', 'void'].includes(match.final.outcome));
  const crossHarnessIds = new Set(crossTournament.result.games.map((game) => game.gameId));
  const crossDecisive = decisive.filter((match) => crossHarnessIds.has(match.id));
  const latestDecisive = crossDecisive.find((match) => match.final.reason === 'checkmate') ?? crossDecisive[0] ?? decisive[0] ?? null;
  const combinedResultSha256 = canonicalJsonSha256({
    codex: loadedSuites[0].resultSha256,
    pi: loadedSuites[1].resultSha256,
    crossHarness: crossTournament.resultSha256,
  });
  const data = {
    schemaVersion: 'agentbattler.site-data.v2',
    benchmark: {
      name: 'AgentBattler Bench',
      version: crossTournament.result.inputs.manifestId,
      description: 'Same models, same prompt, two agent harnesses. Every engine, trace, and chess match is inspectable.',
      status: 'exploratory-local',
      updatedAt: crossTournament.result.execution.completedAt,
      manifestId: crossTournament.result.inputs.manifestId,
      manifestSha256: crossTournament.result.inputs.manifestSha256,
      resultSha256: combinedResultSha256,
      resultSha256Short: shortHash(combinedResultSha256),
      promptSha256: loadedSuites[0].suite.promptSha256,
      globalConfigUnchanged: loadedSuites[0].suite.globalConfigUnchanged,
      globalConfigAdjudication: loadedSuites[0].suite.globalConfigAdjudication ?? null,
      totals: {
        harnesses: harnesses.length,
        agents: agents.length,
        matches: matches.length,
        withinHarnessMatches: loadedSuites.reduce((sum, item) => sum + item.result.games.length, 0),
        crossHarnessMatches: crossTournament.result.games.length,
        controlledHarnessMatches: crossTournament.result.games.filter((game) => game.agents.w.provenance.modelRequested === game.agents.b.provenance.modelRequested).length,
        uniqueScenarios: new Set(matches.map((match) => [match.position.id, match.white.id, match.black.id].join('|'))).size,
        decisive: decisive.length,
        draws: matches.filter((match) => match.final.outcome === '1/2-1/2').length,
        voids: matches.filter((match) => match.final.outcome === 'void').length,
        agentInvocations: loadedSuites.reduce((sum, item) => sum + item.result.summary.agentInvocations, 0) + crossTournament.result.summary.agentInvocations,
        generationTokens: loadedSuites.reduce((sum, item) => sum + item.suite.totals.tokens, 0),
        generationToolCalls: loadedSuites.reduce((sum, item) => sum + item.suite.totals.toolCalls, 0),
        generationMcpCalls: loadedSuites.reduce((sum, item) => sum + item.suite.totals.mcpCalls, 0),
        matchDurationMs: loadedSuites.reduce((sum, item) => sum + item.result.execution.durationMs, 0) + crossTournament.result.execution.durationMs,
      },
      warning: crossTournament.result.summary.warning,
    },
    harnessComparison: summarizeHarnessComparison(crossTournament.result.games),
    harnesses,
    families: harnesses.flatMap((harness) => harness.families.map((family) => ({ ...family, id: `${harness.id}/${family.id}` }))),
    agents,
    matches,
    latestDecisiveId: latestDecisive?.id ?? null,
  };

  await mkdir(path.dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, `${canonicalJson(data, { space: 2 })}\n`);
  await writeFile(PUBLICATION_OUTPUT, `${canonicalJson({ snapshotId: null, snapshotSha256: null, datasetUrl: null, datasetRevision: null, releaseUrl: null, archiveUrl: null, agents: {} }, { space: 2 })}\n`);
  console.log(`Prepared ${agents.length} agents and ${matches.length} matches for ${path.relative(ROOT, OUTPUT)}`);
  console.log(`Verified three result bundles; combined result ${shortHash(combinedResultSha256)}.`);
}

main().catch((error) => {
  console.error(`AgentBattler site data: ${error.message}`);
  process.exitCode = 1;
});
