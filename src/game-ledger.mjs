import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { gameSpecificationFromRecord, createBattleProtocol } from './league.mjs';
import { canonicalJson, canonicalJsonSha256 } from './provenance.mjs';
import { replayGame } from './runner.mjs';

export const LEDGER_ENTRY_SCHEMA = 'agentbattler.game-ledger-entry.v1';
const REGISTERED_LEGACY_RESULTS = new Set([
  // Internal integrity hashes for the two immutable runs referenced by
  // snapshots/latest-results.json. The snapshot separately verifies their
  // compressed and canonical artifact hashes before this compatibility
  // profile is used.
  '60f3dc202c4f7fcd4af618ac8c1416b992866fd46cf08bde9e6a50e5c61787f8',
  '212306d29980bdc50775137cfee11ff20afd547b52eabc4aec14e9604c6c25a4',
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function entryPath(root, gameKey) {
  invariant(/^[0-9a-f]{64}$/.test(gameKey ?? ''), 'Invalid ledger game key');
  return path.join(root, 'objects', gameKey.slice(0, 2), `${gameKey}.json`);
}

function validateGameRecord(record) {
  invariant(record?.kind === 'agentbattler.chess-game', 'Ledger record is not a chess game');
  const { resultSha256, ...unsigned } = record;
  invariant(resultSha256 === canonicalJsonSha256(unsigned), 'Ledger game result hash mismatch');
  return record;
}

function validateEntry(entry) {
  invariant(entry?.schemaVersion === LEDGER_ENTRY_SCHEMA, 'Unsupported ledger entry schema');
  const { entrySha256, ...unsigned } = entry;
  invariant(entrySha256 === canonicalJsonSha256(unsigned), 'Ledger entry hash mismatch');
  validateGameRecord(entry.record);
  invariant(entry.recordResultSha256 === entry.record.resultSha256, 'Ledger record reference mismatch');
  const { gameKey, ...spec } = entry.specification;
  invariant(gameKey === entry.gameKey, 'Ledger specification key mismatch');
  invariant(gameKey === canonicalJsonSha256(spec), 'Ledger game key mismatch');
  const expected = gameSpecificationFromRecord(entry.record, entry.source.protocol);
  invariant(expected.gameKey === gameKey, 'Ledger record does not match its game specification');
  return entry;
}

export async function readLedgerGame(root, gameKey) {
  try {
    return validateEntry(JSON.parse(await readFile(entryPath(root, gameKey), 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function putLedgerGame(root, { specification, record, source }) {
  validateGameRecord(record);
  invariant(record.final?.outcome !== 'void', 'Void games are retryable and cannot complete a ledger entry');
  const expected = gameSpecificationFromRecord(record, source.protocol);
  invariant(expected.gameKey === specification.gameKey, 'Game record does not match its scheduled specification');
  const unsigned = {
    schemaVersion: LEDGER_ENTRY_SCHEMA,
    kind: 'agentbattler.immutable-game-evidence',
    gameKey: specification.gameKey,
    specification,
    recordResultSha256: record.resultSha256,
    record,
    source: {
      kind: source.kind,
      protocol: source.protocol,
      resultSha256: source.resultSha256 ?? null,
      snapshotId: source.snapshotId ?? null,
      runnerCommit: source.runnerCommit ?? record.runner?.runnerCommit ?? null,
    },
  };
  const entry = { ...unsigned, entrySha256: canonicalJsonSha256(unsigned) };
  const destination = entryPath(root, specification.gameKey);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.partial-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${canonicalJson(entry, { space: 2 })}\n`, { flag: 'wx' });
    await link(temporary, destination);
    return { status: 'written', entry, path: destination };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = await readLedgerGame(root, specification.gameKey);
    invariant(existing.recordResultSha256 === record.resultSha256, `Conflicting immutable result for ${specification.gameKey}`);
    return { status: 'existing', entry: existing, path: destination };
  } finally {
    await rm(temporary, { force: true });
  }
}

export function legacyProtocolForResult(result) {
  if (result.battleProtocol) return result.battleProtocol;
  invariant(
    result.runner?.runnerCommit === 'fb912489dcb298bb8666b2a6dce78f3a947a8104'
      || REGISTERED_LEGACY_RESULTS.has(result.resultSha256),
    'Legacy result does not declare a battle protocol and its runner commit has no registered compatibility profile',
  );
  return createBattleProtocol({
    nodeVersion: result.runner?.nodeVersion,
    timeoutMs: 1_000,
    maxOutputBytes: 64 * 1024,
    permissionModel: 'node-permission-no-network',
    adjudication: 'agentbattler-chess-v1',
  });
}

export async function importRunResult(root, result, { snapshotId = null } = {}) {
  invariant(result?.schemaVersion === 'agentbattler.run-result.v1', 'Unsupported legacy run-result schema');
  const { resultSha256, ...unsigned } = result;
  invariant(resultSha256 === canonicalJsonSha256(unsigned), 'Run-result integrity hash mismatch');
  const protocol = legacyProtocolForResult(result);
  const summary = { total: result.games.length, imported: 0, existing: 0, skippedVoid: 0, protocol };
  for (const game of result.games) {
    validateGameRecord(game);
    const replay = replayGame(game);
    invariant(replay.ok, `Cannot import replay-invalid game ${game.gameId}: ${JSON.stringify(replay.mismatches)}`);
    if (game.final.outcome === 'void') {
      summary.skippedVoid += 1;
      continue;
    }
    const specification = gameSpecificationFromRecord(game, protocol);
    const stored = await putLedgerGame(root, {
      specification,
      record: game,
      source: {
        kind: 'imported-run-result',
        protocol,
        resultSha256,
        snapshotId,
        runnerCommit: result.runner?.runnerCommit,
      },
    });
    if (stored.status === 'written') summary.imported += 1;
    else summary.existing += 1;
  }
  return summary;
}

export async function partitionScheduleJobs(root, jobs) {
  const cached = [];
  const missing = [];
  for (const job of jobs) {
    const entry = await readLedgerGame(root, job.gameKey);
    if (entry) cached.push({ job, entry });
    else missing.push(job);
  }
  return { cached, missing };
}
