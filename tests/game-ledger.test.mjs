import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { importRunResult, partitionScheduleJobs, readLedgerGame } from '../src/game-ledger.mjs';
import { gameSpecificationFromRecord, createBattleProtocol } from '../src/league.mjs';
import { canonicalJsonSha256 } from '../src/provenance.mjs';

function seal(value, field) {
  return { ...value, [field]: canonicalJsonSha256(value) };
}

function legacyRun() {
  const game = seal({
    schemaVersion: 1,
    kind: 'agentbattler.chess-game',
    runner: { nodeVersion: 'v26.3.0', runnerCommit: 'fb912489dcb298bb8666b2a6dce78f3a947a8104' },
    position: {
      id: 'stalemate',
      initialFen: 'k7/2Q5/2K5/8/8/8/8/8 b - - 0 1',
      seed: 7,
      maxPlies: 4,
    },
    agents: {
      w: { id: 'white', sourceSha256: '1'.repeat(64) },
      b: { id: 'black', sourceSha256: '2'.repeat(64) },
    },
    plies: [],
    final: { outcome: '1/2-1/2', reason: 'stalemate', failure: null },
    gameId: 'stalemate-seed-7-white-vs-black',
  }, 'resultSha256');
  return seal({
    schemaVersion: 'agentbattler.run-result.v1',
    runner: { nodeVersion: 'v26.3.0', runnerCommit: 'fb912489dcb298bb8666b2a6dce78f3a947a8104' },
    inputs: { suiteId: 'suite-v1' },
    games: [game],
    summary: {},
  }, 'resultSha256');
}

test('legacy import preserves game hashes and is idempotent', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-ledger-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = legacyRun();
  const first = await importRunResult(root, run, { snapshotId: 'legacy-v1' });
  assert.equal(first.imported, 1);
  assert.equal(first.existing, 0);
  const second = await importRunResult(root, run, { snapshotId: 'legacy-v1' });
  assert.equal(second.imported, 0);
  assert.equal(second.existing, 1);

  const protocol = createBattleProtocol({ nodeVersion: 'v26.3.0' });
  const specification = gameSpecificationFromRecord(run.games[0], protocol);
  const stored = await readLedgerGame(root, specification.gameKey);
  assert.equal(stored.recordResultSha256, run.games[0].resultSha256);
  assert.deepEqual(stored.record, run.games[0]);

  const partition = await partitionScheduleJobs(root, [
    { gameKey: specification.gameKey },
    { gameKey: 'f'.repeat(64) },
  ]);
  assert.equal(partition.cached.length, 1);
  assert.equal(partition.missing.length, 1);
});

test('legacy import fails closed without a registered protocol profile', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-ledger-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = legacyRun();
  run.runner.runnerCommit = 'b'.repeat(40);
  const { resultSha256: _old, ...unsigned } = run;
  const resealed = seal(unsigned, 'resultSha256');
  await assert.rejects(importRunResult(root, resealed), /no registered compatibility profile/);
});
