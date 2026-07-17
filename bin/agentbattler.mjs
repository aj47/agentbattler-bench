#!/usr/bin/env node
import { access, cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';

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
  sha256,
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

async function exists(file) { try { await access(file); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; } }
async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporary, `${canonicalJson(value, { space: 2 })}\n`, { flag: 'wx' });
  await rename(temporary, file);
}
async function atomicBytes(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporary, bytes, { flag: 'wx' });
  await rename(temporary, file);
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
  const checkpointTestDelayMs = Number.parseInt(process.env.AGENTBATTLER_CHECKPOINT_TEST_DELAY_MS ?? '0', 10) || 0;
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
          const gameId = `${position.id}-seed-${seed}-${allocation.white.id}-vs-${allocation.black.id}`;
          jobs.push({ allocation, position, seed, gameId });
        }
      }
    }
  }
  const checkpointRoot = `${output}.checkpoints`;
  const metadataPath = path.join(checkpointRoot, 'progress.json');
  const expectedJobIds = jobs.map((job) => job.gameId);
  invariant(new Set(expectedJobIds).size === expectedJobIds.length, 'Deterministic job IDs are not unique');
  const inputs = { manifestId: manifest.manifestId, manifestSha256: await sha256File(manifestPath), suiteId: suite.suiteId, suiteSha256: await sha256File(positionsPath), pairing };
  const fingerprint = sha256(canonicalJson({ inputs, expectedJobIds, runnerSchema: 1 }));
  if (options.fresh) await rm(checkpointRoot, { recursive: true, force: true });
  let progress = null;
  if (await exists(metadataPath)) {
    progress = await readJson(metadataPath);
    invariant(progress.schemaVersion === 'agentbattler.run-checkpoint.v1' && progress.fingerprint === fingerprint, 'Checkpoint inputs/config do not match this run');
  } else {
    progress = { schemaVersion: 'agentbattler.run-checkpoint.v1', fingerprint, inputs, expectedJobIds, expectedCount: jobs.length, startedAt: startedAt.toISOString(), updatedAt: startedAt.toISOString(), finalized: false, completed: 0, remaining: jobs.length };
    await atomicJson(metadataPath, progress);
  }
  invariant(progress.finalized !== true, 'Checkpoint is already finalized; use the published result or --fresh');
  const checkpointGames = path.join(checkpointRoot, 'games');
  const completed = new Map();
  for (const file of await readdir(checkpointGames).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error))) {
    invariant(file.endsWith('.json'), `Unexpected checkpoint entry: ${file}`);
    const game = await readJson(path.join(checkpointGames, file));
    invariant(typeof game.gameId === 'string' && expectedJobIds.includes(game.gameId), 'Checkpoint game ID does not match expected jobs');
    invariant(game.resultSha256 === canonicalJsonSha256(Object.fromEntries(Object.entries(game).filter(([key]) => key !== 'resultSha256'))), `Checkpoint game integrity mismatch: ${game.gameId}`);
    invariant(!completed.has(game.gameId), `Duplicate checkpoint game: ${game.gameId}`);
    invariant(replayGame(game).ok, `Checkpoint game replay failed: ${game.gameId}`);
    completed.set(game.gameId, game);
  }
  const missing = jobs.filter((job) => !completed.has(job.gameId));
  progress = { ...progress, completed: completed.size, remaining: missing.length, updatedAt: new Date().toISOString() };
  await atomicJson(metadataPath, progress);
  const games = await mapConcurrent(missing, concurrency, async ({ allocation, position, seed, gameId }) => {
    const game = await playGame({ ...allocation, seed, runner });
    game.gameId = gameId;
    delete game.resultSha256;
    game.resultSha256 = canonicalJsonSha256(game);
    await atomicJson(path.join(checkpointGames, `${encodeURIComponent(gameId)}.json`), game);
    if (checkpointTestDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, checkpointTestDelayMs));
    completed.set(gameId, game);
    progress = { ...progress, completed: completed.size, remaining: jobs.length - completed.size, updatedAt: new Date().toISOString() };
    await atomicJson(metadataPath, progress);
    console.log(`${game.gameId}: ${game.final.outcome} (${game.final.reason})`);
    return game;
  });

  const orderedGames = expectedJobIds.map((gameId) => completed.get(gameId));
  invariant(orderedGames.every(Boolean), 'Checkpoint is missing expected games after run');

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
    games: orderedGames,
    summary: summarize(orderedGames, manifest.agents),
  };
  result.resultSha256 = canonicalJsonSha256(result);

  invariant(!(await exists(path.join(output, 'result.json'))), 'Refusing to overwrite an existing final result; choose a new output or --fresh after moving it');
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
  progress = { ...progress, completed: orderedGames.length, remaining: 0, finalized: true, finalizedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await atomicJson(metadataPath, progress);
  console.log(`Recorded ${orderedGames.length} games in ${path.join(output, 'result.json')}`);
}

async function statusCommand(options) {
  const progress = await readJson(`${options.output}.checkpoints/progress.json`);
  console.log(canonicalJson(progress, { space: 2 }));
}

async function readReplayInput(resultPath) {
  if (!resultPath.endsWith('.gz')) {
    const bytes = await readFile(resultPath);
    return { result: JSON.parse(bytes.toString('utf8')), resultBytes: bytes, compressed: false };
  }
  const compressedBytes = await readFile(resultPath);
  const publication = await readJson(`${resultPath}.manifest.json`);
  invariant(publication.schemaVersion === 'agentbattler.compressed-result.v1', 'Unsupported compressed result manifest');
  invariant(publication.compressed?.path === path.basename(resultPath), 'Compressed result manifest path mismatch');
  invariant(publication.compressed?.sha256 === sha256(compressedBytes), 'Compressed result integrity hash mismatch');
  invariant(publication.compressed?.sizeBytes === compressedBytes.length, 'Compressed result size mismatch');
  let resultBytes;
  try {
    resultBytes = gunzipSync(compressedBytes);
  } catch (error) {
    throw new Error(`Cannot decompress result: ${error.message}`);
  }
  invariant(publication.canonical?.path === (resultPath.endsWith('.json.gz') ? 'result.json' : null), 'Compressed result canonical path mismatch');
  invariant(publication.canonical?.sha256 === sha256(resultBytes), 'Canonical result integrity hash mismatch');
  invariant(publication.canonical?.sizeBytes === resultBytes.length, 'Canonical result size mismatch');
  const result = JSON.parse(resultBytes.toString('utf8'));
  invariant(publication.canonical?.resultSha256 === result.resultSha256, 'Canonical result semantic hash mismatch');
  return { result, resultBytes, compressed: true };
}

async function packCommand(input) {
  invariant(input, 'Usage: agentbattler pack <result.json>');
  const resultPath = path.resolve(process.cwd(), input);
  invariant(resultPath.endsWith('.json'), 'Pack input must be an uncompressed result.json');
  const resultBytes = await readFile(resultPath);
  const result = JSON.parse(resultBytes.toString('utf8'));
  invariant(result.schemaVersion === 'agentbattler.run-result.v1', 'Unsupported result schema');
  const compressedBytes = gzipSync(resultBytes, { level: 9, mtime: 0 });
  const compressedPath = `${resultPath}.gz`;
  const publication = {
    schemaVersion: 'agentbattler.compressed-result.v1',
    canonical: {
      path: path.basename(resultPath),
      sha256: sha256(resultBytes),
      sizeBytes: resultBytes.length,
      resultSha256: result.resultSha256,
    },
    compressed: {
      path: path.basename(compressedPath),
      sha256: sha256(compressedBytes),
      sizeBytes: compressedBytes.length,
      algorithm: 'gzip',
      level: 9,
      mtime: 0,
    },
  };
  await atomicBytes(compressedPath, compressedBytes);
  await atomicJson(`${compressedPath}.manifest.json`, publication);
  console.log(`Packed ${publication.canonical.sizeBytes} canonical bytes as ${publication.compressed.sizeBytes} deterministic gzip bytes.`);
}

async function replayCommand(input) {
  invariant(input, 'Usage: npm run replay -- <result.json>');
  const resultPath = path.resolve(process.cwd(), input);
  const { result, resultBytes, compressed } = await readReplayInput(resultPath);
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
  const virtualResultEntry = checksums.entries.find((entry) => entry.path === 'result.json');
  invariant(virtualResultEntry, 'Bundle checksum manifest is missing result.json');
  invariant(virtualResultEntry.sha256 === sha256(resultBytes) && virtualResultEntry.sizeBytes === resultBytes.length, 'Canonical result does not match bundle checksum');
  const checksumsToVerify = compressed
    ? { ...checksums, entries: checksums.entries.filter((entry) => entry.path !== 'result.json') }
    : checksums;
  const checksumResult = await verifyChecksumManifest(checksumsToVerify, { root: path.dirname(resultPath) });
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
    fresh: false,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === '--manifest') options.manifestPath = repoPath(rest[++index], 'manifest');
    else if (value === '--positions') options.positionsPath = repoPath(rest[++index], 'positions');
    else if (value === '--output') options.output = repoPath(rest[++index], 'output');
    else if (value === '--pairing') options.pairing = rest[++index];
    else if (value === '--no-smoke') options.smoke = false;
    else if (value === '--fresh') options.fresh = true;
    else if (value === '--resume') options.fresh = false;
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
  if (command === 'status') return statusCommand(options);
  if (command === 'pack') return packCommand(input);
  throw new Error('Usage: agentbattler <validate|run|replay|status|pack> [result.json] [--manifest path] [--positions path] [--output dir] [--pairing reference|all-pairs|cross-model|cross-harness|cross-harness-all] [--no-smoke] [--fresh|--resume]');
}

main().catch((error) => {
  console.error(`AgentBattler: ${error.message}`);
  process.exitCode = 1;
});
