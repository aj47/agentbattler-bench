#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';

import {
  canonicalJson,
  canonicalJsonSha256,
  sha256File,
  verifyChecksumManifest,
} from '../src/provenance.mjs';
import {
  fetchVerified,
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
const RESULTS_SNAPSHOT_PATH = path.join(ROOT, 'snapshots/latest-results.json');
const gunzipAsync = promisify(gunzip);
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

function sha256Buffer(value) {
  return createHash('sha256').update(value).digest('hex');
}

function publishedArtifactUrl(snapshot, artifact) {
  const repo = snapshot.dataset.repoId.split('/').map(encodeURIComponent).join('/');
  const objectPath = artifact.path.split('/').map(encodeURIComponent).join('/');
  return `https://huggingface.co/datasets/${repo}/resolve/${snapshot.dataset.revision}/${objectPath}`;
}

async function fetchPublishedArtifact(snapshot, artifact) {
  const cache = path.join(ROOT, '.artifacts/cache', snapshot.snapshotId, artifact.sha256, path.basename(artifact.path));
  try {
    await verifyFile(cache, artifact);
  } catch {
    const url = publishedArtifactUrl(snapshot, artifact);
    await fetchVerified([url, url, url], cache, artifact);
  }
  return readFile(cache);
}

async function readPublishedJson(snapshot, artifact) {
  return JSON.parse((await fetchPublishedArtifact(snapshot, artifact)).toString('utf8'));
}

async function readPublishedResult(snapshot, artifact, label) {
  const compressed = await fetchPublishedArtifact(snapshot, artifact);
  const canonical = await gunzipAsync(compressed);
  invariant(sha256Buffer(canonical) === artifact.canonicalSha256, `${label} canonical result hash mismatch`);
  const result = JSON.parse(canonical.toString('utf8'));
  const { resultSha256, ...unsignedResult } = result;
  invariant(resultSha256 === canonicalJsonSha256(unsignedResult), `${label} result integrity hash mismatch`);
  invariant(result.games.length === artifact.games, `${label} game count mismatch`);
  return result;
}

function standingMap(result) {
  return new Map(result.summary.standings.map((row, index) => [row.agentId, {
    rank: index + 1,
    elo: row.provisionalElo,
    games: row.gamesPlayed,
    wins: row.wins,
    draws: row.draws,
    losses: row.losses,
    points: row.points,
  }]));
}

function isWithinHarnessMatch(match) {
  return match.white.harness === match.black.harness;
}

function runtimeForMatches(matches) {
  return matches.reduce((total, match) => total + match.plies.reduce((sum, ply) => sum + (ply.runtimeMs ?? 0), 0), 0);
}

const HARNESS_NAMES = {
  'claude-code': 'Claude Code',
  'codex-cli': 'Codex CLI',
  'dotagents-mono': 'DotAgents',
  'pi-coding-agent': 'Pi',
};

function placementScore(game) {
  const dotAgentsColor = game.agents.w.provenance.harness === 'dotagents-mono' ? 'w' : 'b';
  if (game.final.outcome === 'void') return null;
  if (game.final.outcome === '1/2-1/2') return 0.5;
  return (game.final.outcome === '1-0' && dotAgentsColor === 'w')
    || (game.final.outcome === '0-1' && dotAgentsColor === 'b') ? 1 : 0;
}

function summarizePlacementGames(games) {
  const scores = games.map(placementScore).filter((score) => score !== null);
  const wins = scores.filter((score) => score === 1).length;
  const draws = scores.filter((score) => score === 0.5).length;
  const losses = scores.filter((score) => score === 0).length;
  const points = wins + (draws * 0.5);
  return {
    games: scores.length,
    wins,
    draws,
    losses,
    points,
    scorePct: scores.length ? Math.round((points / scores.length) * 10_000) / 100 : 0,
  };
}

function placementOpponent(game) {
  return game.agents.w.provenance.harness === 'dotagents-mono' ? game.agents.b.provenance.harness : game.agents.w.provenance.harness;
}

function summarizeDotAgentsPlacement(results) {
  const games = results.flatMap((item) => item.result.games);
  const opponents = [...new Set(games.map(placementOpponent))].map((id) => ({
    id,
    displayName: HARNESS_NAMES[id] ?? id,
    ...summarizePlacementGames(games.filter((game) => placementOpponent(game) === id)),
  })).sort((left, right) => right.scorePct - left.scorePct || left.id.localeCompare(right.id));
  const models = results.map(({ id, result }) => {
    const modelGames = result.games;
    const opponentRecords = [...new Set(modelGames.map(placementOpponent))].map((opponentId) => ({
      id: opponentId,
      displayName: HARNESS_NAMES[opponentId] ?? opponentId,
      ...summarizePlacementGames(modelGames.filter((game) => placementOpponent(game) === opponentId)),
    })).sort((left, right) => right.scorePct - left.scorePct || left.id.localeCompare(right.id));
    const provenance = modelGames.find((game) => game.agents.w.provenance.harness === 'dotagents-mono')?.agents.w.provenance
      ?? modelGames.find((game) => game.agents.b.provenance.harness === 'dotagents-mono')?.agents.b.provenance;
    return {
      id,
      displayName: id[0].toUpperCase() + id.slice(1),
      model: provenance?.modelRequested ?? `gpt-5.6-${id}`,
      ...summarizePlacementGames(modelGames),
      matchupWins: opponentRecords.filter((record) => record.scorePct > 50).length,
      matchupLosses: opponentRecords.filter((record) => record.scorePct < 50).length,
      opponents: opponentRecords,
      featuredMatchId: modelGames.find((game) => !['1/2-1/2', 'void'].includes(game.final.outcome))?.gameId ?? null,
    };
  }).sort((left, right) => right.scorePct - left.scorePct);
  const timeoutGames = games.filter((game) => game.final.failure?.status === 'timeout');
  const withoutTimeouts = games.filter((game) => game.final.failure?.status !== 'timeout');
  const benefited = timeoutGames.filter((game) => {
    const failed = game.final.failure.color === 'w' ? game.agents.w : game.agents.b;
    return failed.provenance.harness !== 'dotagents-mono';
  }).length;
  const resultSha256 = canonicalJsonSha256(Object.fromEntries(results.map(({ id, result }) => [id, result.resultSha256])));
  return {
    harness: 'dotagents-mono',
    displayName: 'DotAgents',
    ...summarizePlacementGames(games),
    resultSha256,
    resultSha256Short: shortHash(resultSha256),
    updatedAt: results.map(({ result }) => result.execution.completedAt).sort().at(-1),
    warning: 'Targeted same-model placement games only. The three anchor harnesses did not replay their existing head-to-head schedule in this placement batch, so this is not a four-way ordinal leaderboard.',
    featuredMatchId: models.find((model) => model.featuredMatchId)?.featuredMatchId ?? null,
    timeoutDecisions: {
      total: timeoutGames.length,
      benefited,
      incurred: timeoutGames.length - benefited,
      scoreWithoutTimeouts: summarizePlacementGames(withoutTimeouts).scorePct,
    },
    opponents,
    models,
  };
}

function dotAgentsStanding(result, id, familyId) {
  const rows = result.summary.standings.filter((row) => row.agentId.startsWith(`dotagents-${familyId}-`) && row.gamesPlayed > 0);
  const index = rows.findIndex((row) => row.agentId === id);
  const row = rows[index];
  invariant(row, `Missing DotAgents placement standing for ${id}`);
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

async function composeDotAgentsPlacementSiteData({ data, results, resultsSnapshot }) {
  const manifest = await readJson('agents/dotagents-model-suite/manifest.json');
  const resultByFamily = new Map(results.map((item) => [item.id, item.result]));
  const placementGames = results.flatMap((item) => item.result.games);
  const placement = summarizeDotAgentsPlacement(results);
  const dotAgents = [];
  for (const entry of manifest.agents) {
    const familyId = entry.provenance.modelFamilyId;
    const result = resultByFamily.get(familyId);
    invariant(result, `Missing DotAgents placement result for ${familyId}`);
    const source = await readFile(path.resolve(ROOT, entry.source), 'utf8');
    invariant(sha256Buffer(source) === entry.sourceSha256, `DotAgents source hash mismatch for ${entry.id}`);
    const games = placementGames.filter((game) => game.agents.w.id === entry.id || game.agents.b.id === entry.id);
    dotAgents.push({
      id: entry.id,
      familyId,
      displayName: entry.displayName,
      harness: entry.provenance.harness,
      harnessVersion: entry.provenance.harnessVersion,
      model: entry.provenance.modelRequested,
      reasoningEffort: entry.provenance.reasoningEffort,
      verification: {
        level: 'exploratory',
        label: 'Published placement bundle',
        detail: 'Generated source, sanitized provenance, checksums, and all targeted placement replays are published. Raw generation telemetry is intentionally excluded.',
      },
      standing: dotAgentsStanding(result, entry.id, familyId),
      generation: {
        telemetryPublished: false,
        modelRequested: entry.provenance.modelRequested,
        harnessVersion: entry.provenance.harnessVersion,
        durationMs: null,
        turns: null,
        toolCalls: null,
        toolBreakdown: {},
        mcpCalls: null,
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        totalTokens: null,
        promptPath: entry.provenance.prompt,
        promptSha256: entry.provenance.promptSha256,
        sessionId: '',
        command: [],
        isolation: entry.provenance.generationSettings ?? {},
        probes: [],
        probeSummary: { allPassed: true, passed: 0, total: 0 },
      },
      artifact: {
        sourcePath: entry.source,
        sourceSha256: entry.sourceSha256,
        sizeBytes: Buffer.byteLength(source),
        source,
      },
      matches: games.map((game) => matchSummary(game, entry.id)),
      decisiveGames: games.filter((game) => !['1/2-1/2', 'void'].includes(game.final.outcome)).length,
    });
  }
  const matches = [...data.matches, ...placementGames.map(publicMatch)];
  invariant(new Set(matches.map((match) => match.id)).size === matches.length, 'DotAgents placement contains duplicate game IDs');
  const harnesses = [...data.harnesses, {
    id: 'dotagents-mono',
    displayName: 'DotAgents',
    harnessVersion: manifest.agents[0]?.provenance.harnessVersion ?? 'unknown',
    families: [],
    totals: { agents: dotAgents.length, matches: placementGames.length, tokens: 0, toolCalls: 0, mcpCalls: 0, durationMs: 0 },
  }];
  const combinedResultSha256 = canonicalJsonSha256({ publishedLeague: data.benchmark.resultSha256, dotAgentsPlacement: placement.resultSha256 });
  const composed = {
    ...data,
    schemaVersion: 'agentbattler.site-data.v4',
    benchmark: {
      ...data.benchmark,
      description: 'Same models and prompt across four agent harnesses, with DotAgents entering through targeted same-model placement games.',
      updatedAt: placement.updatedAt,
      resultSha256: combinedResultSha256,
      resultSha256Short: shortHash(combinedResultSha256),
      totals: {
        ...data.benchmark.totals,
        harnesses: harnesses.length,
        agents: data.agents.length + dotAgents.length,
        matches: matches.length,
        crossHarnessMatches: data.benchmark.totals.crossHarnessMatches + placementGames.length,
        controlledHarnessMatches: data.benchmark.totals.controlledHarnessMatches + placementGames.length,
        uniqueScenarios: new Set(matches.map((match) => [match.position.id, match.white.id, match.black.id].join('|'))).size,
        decisive: data.benchmark.totals.decisive + placementGames.filter((game) => !['1/2-1/2', 'void'].includes(game.final.outcome)).length,
        draws: data.benchmark.totals.draws + placementGames.filter((game) => game.final.outcome === '1/2-1/2').length,
        voids: data.benchmark.totals.voids + placementGames.filter((game) => game.final.outcome === 'void').length,
        agentInvocations: data.benchmark.totals.agentInvocations + placementGames.reduce((sum, game) => sum + game.plies.length, 0),
        matchDurationMs: data.benchmark.totals.matchDurationMs + runtimeForMatches(placementGames),
      },
    },
    harnesses,
    agents: [...data.agents, ...dotAgents],
    matches,
    latestDecisiveId: placement.featuredMatchId ?? data.latestDecisiveId,
    dotAgentsPlacement: placement,
  };
  invariant(composed.agents.length === resultsSnapshot.totals.agents, 'DotAgents site agent count disagrees with results snapshot');
  invariant(composed.matches.length === resultsSnapshot.totals.matches, 'DotAgents site match count disagrees with results snapshot');
  return composed;
}

async function composeThreeHarnessSiteData({ baseData, baseSnapshot, resultsSnapshot, claudeResult, crossResult, claudeSuite }) {
  const claudeManifest = await readJson('agents/claude-code-model-suite/manifest.json');
  const crossStandings = standingMap(crossResult);
  const claudeStandings = standingMap(claudeResult);
  const baseAgents = new Map(baseData.agents.map((agent) => [agent.id, agent]));
  const rawPublishedGames = [...claudeResult.games, ...crossResult.games];
  const baseWithinMatches = baseData.matches.filter(isWithinHarnessMatch);
  const publishedMatches = rawPublishedGames.map(publicMatch);
  const matches = [...baseWithinMatches, ...publishedMatches];
  invariant(new Set(matches.map((match) => match.id)).size === matches.length, 'Composed website data contains duplicate game IDs');

  const agents = [];
  for (const entry of crossResult.roster) {
    const standing = crossStandings.get(entry.id);
    invariant(standing, `Missing three-harness standing for ${entry.id}`);
    const baseAgent = baseAgents.get(entry.id);
    const publishedAgentMatches = rawPublishedGames
      .filter((game) => game.agents.w.id === entry.id || game.agents.b.id === entry.id)
      .map((game) => matchSummary(game, entry.id));
    if (baseAgent) {
      const agentMatches = [
        ...baseAgent.matches.filter((match) => match.scope === 'within-harness'),
        ...publishedAgentMatches,
      ];
      agents.push({
        ...baseAgent,
        standing,
        matches: agentMatches,
        decisiveGames: agentMatches.filter((match) => !['1/2-1/2', 'void'].includes(match.outcome)).length,
      });
      continue;
    }

    const manifestEntry = claudeManifest.agents.find((candidate) => candidate.id === entry.id);
    invariant(manifestEntry, `Missing Claude Code manifest entry for ${entry.id}`);
    const source = await readFile(path.resolve(ROOT, manifestEntry.source), 'utf8');
    invariant(sha256Buffer(source) === manifestEntry.sourceSha256, `Claude Code source hash mismatch for ${entry.id}`);
    agents.push({
      id: entry.id,
      familyId: entry.provenance.modelFamilyId,
      displayName: entry.displayName,
      harness: entry.provenance.harness,
      harnessVersion: entry.provenance.harnessVersion,
      model: entry.provenance.modelRequested,
      reasoningEffort: entry.provenance.reasoningEffort,
      verification: {
        level: 'exploratory',
        label: 'Published replay bundle',
        detail: 'Agent source, sanitized provenance, checksums, and every replay are published. Per-run raw generation telemetry was intentionally excluded from the public package.',
      },
      standing,
      generation: {
        telemetryPublished: false,
        modelRequested: entry.provenance.modelRequested,
        harnessVersion: entry.provenance.harnessVersion,
        durationMs: null,
        turns: null,
        toolCalls: null,
        toolBreakdown: {},
        mcpCalls: null,
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        totalTokens: null,
        promptPath: entry.provenance.prompt,
        promptSha256: entry.provenance.promptSha256,
        sessionId: '',
        command: [],
        isolation: claudeSuite.isolation,
        probes: [],
        probeSummary: { allPassed: true, passed: 0, total: 0 },
      },
      artifact: {
        sourcePath: manifestEntry.source,
        sourceSha256: manifestEntry.sourceSha256,
        sizeBytes: Buffer.byteLength(source),
        source,
      },
      matches: publishedAgentMatches,
      decisiveGames: publishedAgentMatches.filter((match) => !['1/2-1/2', 'void'].includes(match.outcome)).length,
    });
  }

  const claudeAgentsForSummary = agents
    .filter((agent) => agent.harness === 'claude-code')
    .map((agent) => ({
      ...agent,
      standing: claudeStandings.get(agent.id),
      generation: { ...agent.generation, totalTokens: 0, durationMs: 0, toolCalls: 0 },
    }));
  const claudeHarness = {
    id: 'claude-code',
    displayName: 'Claude Code',
    harnessVersion: claudeSuite.harness.version,
    families: summarizeModelFamilies({
      families: claudeSuite.families,
      agents: claudeAgentsForSummary,
      games: claudeResult.games,
    }).map((family) => ({
      ...family,
      generation: {
        telemetryPublished: false,
        totalTokens: null,
        medianTokens: null,
        totalDurationMs: null,
        medianDurationMs: null,
        toolCalls: null,
      },
    })),
    totals: {
      agents: claudeManifest.agents.length,
      matches: claudeResult.games.length,
      tokens: claudeSuite.totals.tokens,
      toolCalls: claudeSuite.totals.toolCalls,
      mcpCalls: 0,
      durationMs: claudeSuite.totals.durationMs,
    },
  };
  const harnesses = [...baseData.harnesses, claudeHarness];
  const decisive = matches.filter((match) => !['1/2-1/2', 'void'].includes(match.final.outcome));
  const controlledHarnessMatches = crossResult.games.filter((game) => (
    game.agents.w.provenance.modelRequested === game.agents.b.provenance.modelRequested
  )).length;
  const combinedResultSha256 = canonicalJsonSha256({
    baseSnapshot: baseSnapshot.snapshotSha256,
    claudeWithinHarness: claudeResult.resultSha256,
    threeHarness: crossResult.resultSha256,
  });
  const latestDecisive = publishedMatches.find((match) => match.final.reason === 'checkmate') ?? decisive[0] ?? null;
  const data = {
    ...baseData,
    schemaVersion: 'agentbattler.site-data.v3',
    benchmark: {
      ...baseData.benchmark,
      version: crossResult.inputs.manifestId,
      description: 'Same models, same prompt, three agent harnesses. Every engine, checksum, and chess match is inspectable.',
      updatedAt: crossResult.execution.completedAt,
      manifestId: crossResult.inputs.manifestId,
      manifestSha256: crossResult.inputs.manifestSha256,
      resultSha256: combinedResultSha256,
      resultSha256Short: shortHash(combinedResultSha256),
      totals: {
        harnesses: harnesses.length,
        agents: agents.length,
        matches: matches.length,
        withinHarnessMatches: baseWithinMatches.length + claudeResult.games.length,
        crossHarnessMatches: crossResult.games.length,
        controlledHarnessMatches,
        uniqueScenarios: new Set(matches.map((match) => [match.position.id, match.white.id, match.black.id].join('|'))).size,
        decisive: decisive.length,
        draws: matches.filter((match) => match.final.outcome === '1/2-1/2').length,
        voids: matches.filter((match) => match.final.outcome === 'void').length,
        agentInvocations: matches.reduce((sum, match) => sum + match.plies.length, 0),
        generationTokens: baseData.benchmark.totals.generationTokens + claudeSuite.totals.tokens,
        generationToolCalls: baseData.benchmark.totals.generationToolCalls + claudeSuite.totals.toolCalls,
        generationMcpCalls: baseData.benchmark.totals.generationMcpCalls,
        matchDurationMs: runtimeForMatches(matches),
      },
      warning: crossResult.summary.warning,
    },
    harnessComparison: summarizeHarnessComparison(crossResult.games),
    harnesses,
    families: harnesses.flatMap((harness) => harness.families.map((family) => ({ ...family, id: `${harness.id}/${family.id}` }))),
    agents,
    matches,
    latestDecisiveId: latestDecisive?.id ?? null,
  };
  if (!resultsSnapshot.artifacts.dotagentsPlacementResults && process.env.AGENTBATTLER_LOCAL_DOTAGENTS !== '1') {
    invariant(data.agents.length === resultsSnapshot.totals.agents, 'Composed site agent count disagrees with results snapshot');
    invariant(data.matches.length === resultsSnapshot.totals.matches, 'Composed site match count disagrees with results snapshot');
  }
  invariant(data.benchmark.totals.voids === 0, 'Composed site data contains void games');
  return data;
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
  let data = await readJson(cache);
  const terminalChallenge = await loadTerminalChallengeLane();
  if (terminalChallenge) data = { ...data, terminalChallenge };
  invariant(data.schemaVersion === 'agentbattler.site-data.v2', 'Published site data has an unsupported schema');
  invariant(data.matches.length === snapshot.totals.matches, 'Published site data match count disagrees with snapshot');
  invariant(data.agents.length === snapshot.totals.runs, 'Published site data agent count disagrees with snapshot');
  invariant(data.harnesses.length === 2, 'Published site data lacks both harnesses');
  invariant(data.harnessComparison?.models?.length === 3, 'Published site data lacks the controlled harness comparison');
  let publicationDataset = snapshot.dataset;
  let publicationSnapshotId = snapshot.snapshotId;
  let publicationSnapshotSha256 = snapshot.snapshotSha256;
  try {
    const resultsSnapshot = await readJson(path.relative(ROOT, RESULTS_SNAPSHOT_PATH));
    const [claudeResult, crossResult, claudeSuite] = await Promise.all([
      readPublishedResult(resultsSnapshot, resultsSnapshot.artifacts.claudeResult, 'Claude Code'),
      readPublishedResult(resultsSnapshot, resultsSnapshot.artifacts.threeHarnessResult, 'Three-harness'),
      readPublishedJson(resultsSnapshot, resultsSnapshot.artifacts.claudeGenerationSuite),
    ]);
    data = await composeThreeHarnessSiteData({
      baseData: data,
      baseSnapshot: snapshot,
      resultsSnapshot,
      claudeResult,
      crossResult,
      claudeSuite,
    });
    if (resultsSnapshot.artifacts.dotagentsPlacementResults || process.env.AGENTBATTLER_LOCAL_DOTAGENTS === '1') {
      const dotAgentsResults = resultsSnapshot.artifacts.dotagentsPlacementResults
        ? await Promise.all(resultsSnapshot.artifacts.dotagentsPlacementResults.map(async (artifact) => ({
          id: artifact.model,
          result: await readPublishedResult(resultsSnapshot, artifact, `DotAgents ${artifact.model}`),
        })))
        : await Promise.all(['luna', 'sol', 'terra'].map(async (id) => ({
          id,
          result: await readJson(`results/league/dotagents-placement/matches/${id}/result.json`),
        })));
      const expectedSnapshot = resultsSnapshot.artifacts.dotagentsPlacementResults ? resultsSnapshot : {
        ...resultsSnapshot,
        totals: { ...resultsSnapshot.totals, agents: data.agents.length + 15, matches: data.matches.length + 540 },
      };
      data = await composeDotAgentsPlacementSiteData({ data, results: dotAgentsResults, resultsSnapshot: expectedSnapshot });
    }
    publicationDataset = resultsSnapshot.dataset;
    publicationSnapshotId = resultsSnapshot.snapshotId;
    publicationSnapshotSha256 = resultsSnapshot.snapshotSha256;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const traceEvidence = Object.fromEntries(data.agents.filter((agent) => agent.generation.sessionId).map((agent) => {
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
  await writeFile(OUTPUT, `${canonicalJson(data, { space: 2 })}\n`);
  await writeFile(PUBLICATION_OUTPUT, `${canonicalJson({
    snapshotId: publicationSnapshotId,
    snapshotSha256: publicationSnapshotSha256,
    datasetUrl: `https://huggingface.co/datasets/${publicationDataset.repoId}/tree/${publicationDataset.revision}/${publicationDataset.root}`,
    datasetRevision: publicationDataset.revision,
    releaseUrl: null,
    archiveUrl: null,
    agents: traceEvidence,
  }, { space: 2 })}\n`);
  console.log(`Prepared pinned website data from ${publicationDataset.repoId}@${shortHash(publicationDataset.revision)}.`);
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

async function loadTerminalChallengeLane() {
  const root = 'results/terminal-mini-ledger-v4';
  try {
    const [challenge, schedule, summary, traceManifest] = await Promise.all([
      readJson(`${root}/challenge.json`),
      readJson(`${root}/schedule.json`),
      readJson(`${root}/summary.json`),
      readJson(`${root}/trace-manifest.json`).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error)),
    ]);
    const scores = new Map(summary.scores.map((entry) => [entry.runKey, entry.score]));
    const traces = new Map((traceManifest?.traces ?? []).map((entry) => [entry.runKey, entry]));
    const runs = await Promise.all(schedule.jobs.map(async (job) => {
      const run = await readJson(`${root}/runs/${job.runKey}.json`);
      const score = scores.get(job.runKey);
      invariant(score, `Missing terminal score for ${job.runKey}`);
      const trace = traces.get(job.runKey);
      return {
        runKey: run.runKey,
        artifactId: run.artifactId,
        comboId: run.comboId,
        generationIndex: run.generationIndex,
        harness: run.harness,
        harnessVersion: run.harnessVersion,
        model: run.model,
        modelFamilyId: run.modelFamilyId,
        durationMs: run.durationMs,
        endedAt: run.endedAt,
        scorePct: score.scorePct,
        visiblePoints: score.visiblePoints,
        holdoutPoints: score.holdoutPoints,
        passedStages: score.passedStages,
        totalStages: score.totalStages,
        holdoutPassed: score.holdoutPassed,
        holdoutTotal: score.holdoutTotal,
        usage: run.usage,
        stages: run.stages.map((stage) => ({ id: stage.id ?? stage.stageId, passed: stage.passed === true })),
        trace: trace ? {
          path: trace.path,
          bytes: trace.publishedBytes,
          sha256: trace.publishedSha256,
          sourceBytes: trace.sourceBytes,
        } : null,
      };
    }));
    const groups = new Map();
    for (const run of runs) {
      const group = groups.get(run.comboId) ?? [];
      group.push(run);
      groups.set(run.comboId, group);
    }
    const round = (value) => Math.round(value * 100) / 100;
    const combos = [...groups.entries()].map(([comboId, comboRuns]) => {
      const ordered = comboRuns.sort((left, right) => left.generationIndex - right.generationIndex);
      const scores = ordered.map((run) => run.scorePct).sort((left, right) => left - right);
      const midpoint = Math.floor(scores.length / 2);
      const medianScore = scores.length % 2 ? scores[midpoint] : (scores[midpoint - 1] + scores[midpoint]) / 2;
      return {
        comboId,
        harness: ordered[0].harness,
        harnessDisplayName: HARNESS_NAMES[ordered[0].harness] ?? ordered[0].harness,
        harnessVersion: ordered[0].harnessVersion,
        model: ordered[0].model,
        modelFamilyId: ordered[0].modelFamilyId,
        averageScore: round(ordered.reduce((sum, run) => sum + run.scorePct, 0) / ordered.length),
        medianScore: round(medianScore),
        minimumScore: Math.min(...scores),
        maximumScore: Math.max(...scores),
        averageDurationMs: Math.round(ordered.reduce((sum, run) => sum + run.durationMs, 0) / ordered.length),
        totalDurationMs: ordered.reduce((sum, run) => sum + run.durationMs, 0),
        stagePassRates: challenge.stages.map((stage) => ({
          id: stage.id,
          title: stage.title,
          passed: ordered.filter((run) => run.stages.find((entry) => entry.id === stage.id)?.passed).length,
          total: ordered.length,
        })),
        runs: ordered,
      };
    }).sort((left, right) => right.averageScore - left.averageScore || left.comboId.localeCompare(right.comboId));
    return {
      id: challenge.id,
      title: challenge.title,
      updatedAt: runs.map((run) => run.endedAt).sort().at(-1),
      challengeId: challenge.challengeId,
      challengeSha256: challenge.challengeSha256,
      scheduleId: schedule.scheduleId,
      scheduleSha256: schedule.scheduleSha256,
      matrix: schedule.matrix,
      coverage: schedule.coverage.map((entry) => ({
        comboId: entry.combo.comboId,
        harness: entry.combo.harness.id,
        harnessVersion: entry.combo.harness.version,
        model: entry.combo.model.id,
        generations: entry.artifacts.length,
      })),
      expectedRuns: summary.expectedRuns,
      completedRuns: summary.completedRuns,
      missingRuns: summary.missingRuns.length,
      invalidRuns: summary.invalidRuns.length,
      scoring: challenge.scoring,
      protocol: challenge.protocol,
      stages: challenge.stages,
      combos,
      tracePublication: traceManifest ? {
        manifestSha256: traceManifest.manifestSha256,
        runs: traceManifest.totals.runs,
        turns: traceManifest.totals.turns,
        sourceBytes: traceManifest.totals.sourceBytes,
        publishedBytes: traceManifest.totals.publishedBytes,
        omittedStreamingEvents: traceManifest.totals.omittedStreamingEvents,
        redactions: traceManifest.totals.redactions,
      } : null,
      standings: summary.elo?.standings ?? [],
      // The original V4 native runs could see repository verifier source. Keep
      // the evidence available, but never present its scores as a leaderboard.
      status: 'withdrawn',
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function main() {
  if (await preparePublishedSnapshot()) return;
  const terminalChallenge = await loadTerminalChallengeLane();
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
    terminalChallenge,
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
