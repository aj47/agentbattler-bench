#!/usr/bin/env node
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { isLegalUciMove, parseFen } from '../src/chess.mjs';
import {
  pairedGames,
  playGame,
  replayGame,
  runAgentMove,
  validateAgent,
} from '../src/runner.mjs';
import {
  canonicalJson,
  canonicalJsonSha256,
  createChecksumManifest,
  formatChecksumManifest,
  sha256File,
  verifyChecksumManifest,
} from '../src/provenance.mjs';
import { comparisonPairs } from '../src/pairing.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MANIFEST_PATH = path.join(ROOT, 'agents/manifest.json');
const DEFAULT_POSITIONS_PATH = path.join(ROOT, 'benchmark/positions/v1.json');
const DEFAULT_OUTPUT = path.join(ROOT, 'results/latest');

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function repoPath(relative, label) {
  invariant(typeof relative === 'string' && relative.length > 0, `${label} must be a non-empty path`);
  const absolute = path.resolve(ROOT, relative);
  const inside = path.relative(ROOT, absolute);
  invariant(inside && !inside.startsWith(`..${path.sep}`) && !path.isAbsolute(inside), `${label} escapes the repository`);
  return absolute;
}

async function loadAndValidate({
  manifestPath = DEFAULT_MANIFEST_PATH,
  positionsPath = DEFAULT_POSITIONS_PATH,
  pairing = 'reference',
  smoke = true,
} = {}) {
  const manifest = await readJson(manifestPath);
  const suite = await readJson(positionsPath);
  invariant(manifest.schemaVersion === 'agentbattler.agent-manifest.v1', 'Unsupported agent manifest schema');
  invariant(suite.schemaVersion === 'agentbattler.position-suite.v1', 'Unsupported position suite schema');
  invariant(Array.isArray(manifest.agents) && manifest.agents.length >= 2, 'Roster must contain at least two agents');
  invariant(Array.isArray(suite.positions) && suite.positions.length > 0, 'Position suite must not be empty');

  const ids = new Set();
  let references = 0;
  let nonReferences = 0;
  const agents = [];
  for (const entry of manifest.agents) {
    invariant(typeof entry.id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(entry.id), 'Agent has an invalid stable ID');
    invariant(!ids.has(entry.id), `Duplicate agent ID: ${entry.id}`);
    ids.add(entry.id);
    if (entry.role === 'reference') references += 1;
    else nonReferences += 1;
    const sourcePath = repoPath(entry.source, `source for ${entry.id}`);
    const identity = await validateAgent(sourcePath);
    invariant(identity.sourceSha256 === entry.sourceSha256, `Source hash mismatch for ${entry.id}`);
    invariant(entry.provenance && typeof entry.provenance.kind === 'string', `Missing provenance for ${entry.id}`);
    agents.push({ ...entry, path: sourcePath });
  }
  if (pairing === 'reference') {
    invariant(references === 1, 'Reference pairing requires exactly one reference agent');
    invariant(nonReferences >= 1, 'Reference pairing requires at least one non-reference agent');
  } else {
    invariant(['all-pairs', 'cross-model', 'cross-harness', 'cross-harness-all'].includes(pairing), `Unsupported pairing mode: ${pairing}`);
  }

  const positionIds = new Set();
  for (const position of suite.positions) {
    invariant(typeof position.id === 'string' && position.id.length > 0, 'Position is missing a stable ID');
    invariant(!positionIds.has(position.id), `Duplicate position ID: ${position.id}`);
    positionIds.add(position.id);
    parseFen(position.fen);
    invariant(Number.isInteger(position.maxPlies) && position.maxPlies > 0, `Invalid maxPlies for ${position.id}`);
    invariant(Array.isArray(position.seeds) && position.seeds.length > 0 && position.seeds.every(Number.isSafeInteger), `Invalid seeds for ${position.id}`);
    invariant(typeof position.expectedLegalMoveBehavior === 'string', `Missing expected behavior for ${position.id}`);
  }

  if (smoke) {
    for (const agent of agents) {
      for (const position of suite.positions) {
        const attempt = await runAgentMove({ agentPath: agent.path, fen: position.fen });
        invariant(attempt.status === 'ok', `${agent.id} failed ${position.id}: ${attempt.status}`);
        invariant(isLegalUciMove(parseFen(position.fen), attempt.move), `${agent.id} returned illegal ${attempt.move} for ${position.id}`);
      }
    }
  }
  return { manifest, suite, agents };
}

function scoreFor(outcome, color) {
  if (outcome === '1/2-1/2') return 0.5;
  if (outcome === '1-0') return color === 'w' ? 1 : 0;
  if (outcome === '0-1') return color === 'b' ? 1 : 0;
  return null;
}

function summarize(games, roster) {
  const table = new Map(roster.map((agent) => [agent.id, {
    agentId: agent.id,
    displayName: agent.displayName,
    role: agent.role,
    gamesPlayed: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    points: 0,
    provisionalElo: 1500,
  }]));
  let voidGames = 0;
  for (const game of games) {
    if (game.final.outcome === 'void') {
      voidGames += 1;
      continue;
    }
    const white = table.get(game.agents.w.id);
    const black = table.get(game.agents.b.id);
    const whiteScore = scoreFor(game.final.outcome, 'w');
    const blackScore = 1 - whiteScore;
    for (const [row, score] of [[white, whiteScore], [black, blackScore]]) {
      row.gamesPlayed += 1;
      row.points += score;
      if (score === 1) row.wins += 1;
      else if (score === 0.5) row.draws += 1;
      else row.losses += 1;
    }
    const expectedWhite = 1 / (1 + 10 ** ((black.provisionalElo - white.provisionalElo) / 400));
    white.provisionalElo += 16 * (whiteScore - expectedWhite);
    black.provisionalElo += 16 * (blackScore - (1 - expectedWhite));
  }
  const standings = [...table.values()].map((row) => ({
    ...row,
    points: Math.round(row.points * 2) / 2,
    provisionalElo: Math.round(row.provisionalElo),
  })).sort((a, b) => b.provisionalElo - a.provisionalElo || b.points - a.points || a.agentId.localeCompare(b.agentId));
  const containsFixtures = roster.some((agent) => agent.provenance?.isFixture);
  return {
    provisional: true,
    ratingMethod: 'sequential-elo-k16',
    warning: containsFixtures
      ? 'Fixture proof-loop ratings are not coding-harness comparisons.'
      : 'Exploratory local ratings are provisional, order-dependent, and not yet public benchmark evidence.',
    gamesRecorded: games.length,
    gamesGraded: games.length - voidGames,
    voidGames,
    agentInvocations: games.reduce((sum, game) => sum + game.plies.length, 0),
    totalAgentRuntimeMs: Math.round(games.reduce(
      (sum, game) => sum + game.plies.reduce((gameSum, ply) => gameSum + (ply.runtimeMs ?? 0), 0),
      0,
    ) * 1000) / 1000,
    standings,
  };
}

function workflowUrl() {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  return GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID
    ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
    : null;
}

async function validateCommand(options) {
  const { manifest, suite, agents } = await loadAndValidate(options);
  const pairs = comparisonPairs(agents, options.pairing);
  const scheduledGames = pairs.length * suite.positions.reduce(
    (sum, position) => sum + (position.seeds.length * 2),
    0,
  );
  console.log(`Validated ${agents.length} agents, ${suite.positions.length} positions, and ${agents.length * suite.positions.length} sandboxed contract probes.`);
  console.log(`Pairing ${options.pairing}: ${pairs.length} agent pairs and ${scheduledGames} scheduled games.`);
  console.log(`Manifest: ${manifest.manifestId}; suite: ${suite.suiteId}`);
}

async function mapConcurrent(items, concurrency, work) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

async function runCommand(options) {
  const startedAt = new Date();
  const startedMs = performance.now();
  const { manifestPath, positionsPath, output, pairing } = options;
  const { manifest, suite, agents } = await loadAndValidate(options);
  const pairs = comparisonPairs(agents, pairing);
  const concurrency = Math.max(1, Number.parseInt(process.env.AGENTBATTLER_CONCURRENCY ?? '6', 10) || 1);
  const jobs = [];
  const runner = {
    nodeVersion: process.version,
    runnerCommit: process.env.GITHUB_SHA ?? 'unavailable-not-a-git-checkout',
    benchmarkCommit: process.env.GITHUB_SHA ?? 'unavailable-not-a-git-checkout',
    workflowUrl: workflowUrl(),
    concurrency,
  };
  for (const [agentA, agentB] of pairs) {
    for (const position of suite.positions) {
      for (const seed of position.seeds) {
        for (const allocation of pairedGames(agentA, agentB, position)) {
          jobs.push({ allocation, position, seed });
        }
      }
    }
  }
  const games = await mapConcurrent(jobs, concurrency, async ({ allocation, position, seed }) => {
    const game = await playGame({ ...allocation, seed, runner });
    game.gameId = `${position.id}-seed-${seed}-${allocation.white.id}-vs-${allocation.black.id}`;
    delete game.resultSha256;
    game.resultSha256 = canonicalJsonSha256(game);
    console.log(`${game.gameId}: ${game.final.outcome} (${game.final.reason})`);
    return game;
  });

  const result = {
    schemaVersion: 'agentbattler.run-result.v1',
    kind: 'agentbattler.chess-benchmark',
    createdAt: startedAt.toISOString(),
    execution: {
      completedAt: new Date().toISOString(),
      durationMs: Math.round((performance.now() - startedMs) * 1000) / 1000,
      runCount: 1,
      scheduledGames: jobs.length,
      concurrency,
    },
    runner,
    inputs: {
      manifestId: manifest.manifestId,
      manifestSha256: await sha256File(manifestPath),
      suiteId: suite.suiteId,
      suiteSha256: await sha256File(positionsPath),
      pairing,
    },
    roster: manifest.agents,
    games,
    summary: summarize(games, manifest.agents),
  };
  result.resultSha256 = canonicalJsonSha256(result);

  await rm(output, { recursive: true, force: true });
  await mkdir(path.join(output, 'agents'), { recursive: true });
  await writeFile(path.join(output, 'result.json'), `${canonicalJson(result, { space: 2 })}\n`);
  await cp(manifestPath, path.join(output, 'agents/manifest.json'));
  for (const agent of manifest.agents) await cp(repoPath(agent.source, `source for ${agent.id}`), path.join(output, 'agents', path.basename(agent.source)));
  await cp(positionsPath, path.join(output, 'positions.json'));
  const relativeFiles = [
    'result.json',
    'positions.json',
    'agents/manifest.json',
    ...manifest.agents.map((agent) => `agents/${path.basename(agent.source)}`),
  ];
  const checksums = await createChecksumManifest(relativeFiles, { root: output });
  await writeFile(path.join(output, 'checksums.json'), `${canonicalJson(checksums, { space: 2 })}\n`);
  await writeFile(path.join(output, 'SHA256SUMS'), formatChecksumManifest(checksums));
  console.log(`Recorded ${games.length} games in ${path.join(output, 'result.json')}`);
}

async function replayCommand(input) {
  invariant(input, 'Usage: npm run replay -- <result.json>');
  const resultPath = path.resolve(process.cwd(), input);
  const result = await readJson(resultPath);
  invariant(result.schemaVersion === 'agentbattler.run-result.v1', 'Unsupported result schema');
  const { resultSha256, ...unsigned } = result;
  invariant(resultSha256 === canonicalJsonSha256(unsigned), 'Top-level result integrity hash mismatch');
  const failures = result.games.flatMap((game) => {
    const replay = replayGame(game);
    return replay.ok ? [] : [{ gameId: game.gameId, ...replay }];
  });
  invariant(failures.length === 0, `Replay mismatches:\n${JSON.stringify(failures, null, 2)}`);
  const recomputed = summarize(result.games, result.roster);
  invariant(canonicalJson(recomputed) === canonicalJson(result.summary), 'Recorded summary does not match replayed grades');
  const checksumPath = path.join(path.dirname(resultPath), 'checksums.json');
  const checksums = await readJson(checksumPath);
  const checksumResult = await verifyChecksumManifest(checksums, { root: path.dirname(resultPath) });
  invariant(checksumResult.ok, `Bundle checksum mismatch:\n${JSON.stringify(checksumResult.mismatches, null, 2)}`);
  console.log(`Replay verified ${result.games.length} games, all grades, the summary, and ${checksums.entries.length} bundle checksums.`);
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  let input = null;
  const options = {
    manifestPath: DEFAULT_MANIFEST_PATH,
    positionsPath: DEFAULT_POSITIONS_PATH,
    output: DEFAULT_OUTPUT,
    pairing: 'reference',
    smoke: true,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === '--manifest') options.manifestPath = repoPath(rest[++index], 'manifest');
    else if (value === '--positions') options.positionsPath = repoPath(rest[++index], 'positions');
    else if (value === '--output') options.output = repoPath(rest[++index], 'output');
    else if (value === '--pairing') options.pairing = rest[++index];
    else if (value === '--no-smoke') options.smoke = false;
    else if (!input) input = value;
    else throw new Error(`Unexpected argument: ${value}`);
  }
  invariant(['reference', 'all-pairs', 'cross-model', 'cross-harness', 'cross-harness-all'].includes(options.pairing), 'Pairing must be reference, all-pairs, cross-model, cross-harness, or cross-harness-all');
  return { command, input, options };
}

async function main() {
  const { command, input, options } = parseArguments(process.argv.slice(2));
  if (command === 'validate') return validateCommand(options);
  if (command === 'run') return runCommand(options);
  if (command === 'replay') return replayCommand(input);
  throw new Error('Usage: agentbattler <validate|run|replay> [result.json] [--manifest path] [--positions path] [--output dir] [--pairing reference|all-pairs|cross-model|cross-harness|cross-harness-all] [--no-smoke]');
}

main().catch((error) => {
  console.error(`AgentBattler: ${error.message}`);
  process.exitCode = 1;
});
